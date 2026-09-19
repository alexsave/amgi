// The Anki half of the review loop: everything above this line in the
// generated file is amgi's own code, copied verbatim by tools/build-loop.js.
//
// What this adds is the host: Anki's `pycmd` bridge, HTML5 <audio> elements
// pointing straight at the collection's media folder, and a keyboard.
//
// Two facts about Anki shape most of the awkward parts.
// First, the reviewer re-executes a template's <script> tags on every render
// (ts/reviewer/index.ts, setInnerHTML), and on the desktop client the question
// and the answer are two renders inside one long-lived document, while on
// AnkiDroid each side is a fresh page load. So this file must be safe to run
// many times, and anything that has to survive a render is parked on
// globalThis rather than held in a closure.
// Second, the answer text must not exist in the DOM while the learner is
// speaking. That is why it lives only in the back template: no CSS rule, no
// class toggle and no script has to run correctly for the card to keep its
// promise.

var AMGI_CONFIG = globalThis.amgiLoopConfig || {};

// Anki's own limits are generous; these only exist so a missing or stalled
// media file cannot hold a review session hostage.
var CLIP_START_TIMEOUT_MS = 8000;
var CLIP_MAX_MS = 60000;

var AUDIO_FILENAME = /\.(mp3|m4a|mp4|aac|oga|ogg|opus|wav|flac|webm)$/i;

// Survives a render on clients that keep one document for the whole session.
var store = globalThis.__amgi || (globalThis.__amgi = {});

function attr(root, name) {
  return root ? root.querySelector('[' + name + ']') : null;
}

function action(root, name) {
  return root ? root.querySelector('[data-amgi-action="' + name + '"]') : null;
}

function show(el, visible) {
  if (el) el.hidden = !visible;
}

function setText(el, text) {
  if (el) el.textContent = text;
}

/**
 * Anki's bridge. `pycmd` is whitelisted to a fixed set of commands in
 * qt/aqt/reviewer.py (_linkHandler): ans, ease1-4, edit, more, play:, and a
 * few internals. Anything else is ignored with a console message, so a client
 * that does not implement the bridge simply leaves us to fall back.
 */
function bridge(command) {
  var send = globalThis.pycmd || globalThis.bridgeCommand;
  if (typeof send !== 'function') return false;
  try {
    send(command);
    return true;
  } catch (error) {
    return false;
  }
}

/** Pulls a playable filename out of whatever the note's audio field holds. */
function resolveAudio(slot) {
  if (!slot) return null;

  // The recommended field content is an HTML media reference, because that is
  // the form Anki's media tracker understands (rslib/src/text.rs,
  // HTML_MEDIA_TAGS covers img|audio|video|object|source with src or data).
  var existing = slot.querySelector('audio[src]');
  if (existing) {
    existing.preload = 'auto';
    return existing;
  }

  var tagged = slot.querySelector('[src]');
  var name = tagged ? tagged.getAttribute('src') : filenameFromText(slot.textContent);
  if (!name) return null;

  // A relative name resolves against the page's base URL, which Anki points at
  // the collection media folder: <base href="http://127.0.0.1:PORT/"> on
  // desktop (qt/aqt/main.py, baseHTML) and the media server's base URL on
  // AnkiDroid (CardViewerFragment.kt, loadDataWithBaseURL).
  var audio = new Audio(name);
  audio.preload = 'auto';
  return audio;
}

function filenameFromText(text) {
  var trimmed = (text || '').replace(/\s+/g, ' ').trim();
  // Anki strips [sound:...] out of a rendered card before we ever see it, so
  // this only fires in a plain browser preview of the same HTML.
  var sound = trimmed.match(/^\[sound:(.+)\]$/);
  if (sound) trimmed = sound[1].trim();
  return AUDIO_FILENAME.test(trimmed) ? trimmed : null;
}

/**
 * Plays one clip and resolves when it is over, whatever "over" turns out to
 * mean: finished, failed, skipped by the learner, or never started because the
 * client refused to autoplay.
 */
function playClip(element, ui) {
  return new Promise(function (resolve) {
    if (!element) return resolve('missing');

    var settled = false;
    var timer = null;

    function done(how) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      element.removeEventListener('ended', onEnded);
      element.removeEventListener('error', onError);
      element.removeEventListener('playing', onPlaying);
      ui.offerPlay(null);
      store.clip = null;
      resolve(how);
    }

    function onEnded() {
      done('ended');
    }
    function onError() {
      done('error');
    }
    function onPlaying() {
      // Once it is actually playing, the only cap that matters is the clip's
      // own length.
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        done('too-long');
      }, CLIP_MAX_MS);
    }

    element.addEventListener('ended', onEnded);
    element.addEventListener('error', onError);
    element.addEventListener('playing', onPlaying);

    // Lets a keypress cut the clip short.
    store.clip = function () {
      try {
        element.pause();
      } catch (error) {
        // Pausing an element that never started is not worth reporting.
      }
      done('skipped');
    };

    try {
      element.currentTime = 0;
    } catch (error) {
      // Seeking before metadata has loaded throws in some engines; harmless.
    }

    timer = setTimeout(function () {
      done('no-start');
    }, CLIP_START_TIMEOUT_MS);

    var started;
    try {
      started = element.play();
    } catch (error) {
      return done('error');
    }

    if (started && typeof started.catch === 'function') {
      started.catch(function () {
        // Autoplay was refused: AnkiWeb in a browser, or a mobile client
        // before the first tap. Waiting on the learner instead of timing out
        // is the whole difference between a card that looks broken and one
        // that asks for a tap.
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = null;
        ui.offerPlay(function () {
          var retry = element.play();
          if (retry && typeof retry.catch === 'function') retry.catch(function () {
            done('blocked');
          });
        });
      });
    }
  });
}

/** The microphone, if this client has one to give. */
function microphone() {
  var media = globalThis.navigator && navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') {
    return Promise.reject(new Error('this Anki client does not expose a microphone to cards'));
  }
  return media.getUserMedia({ audio: true }).then(function (stream) {
    var Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach(function (track) {
        track.stop();
      });
      throw new Error('no Web Audio in this client');
    }
    var context = store.audioContext;
    if (!context || context.state === 'closed') {
      context = store.audioContext = new Ctx();
    }
    if (context.state === 'suspended' && context.resume) context.resume();
    store.stream = stream;
    store.recorder = startRecorder(stream);
    return { audioContext: context, stream: stream };
  });
}

/** Recording is a bonus: the "You" replay button. Never let it break the loop. */
function startRecorder(stream) {
  if (AMGI_CONFIG.record === false) return null;
  if (typeof globalThis.MediaRecorder !== 'function') return null;
  try {
    var recorder = new MediaRecorder(stream);
    var chunks = [];
    recorder.addEventListener('dataavailable', function (event) {
      if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.chunks = chunks;
    recorder.start();
    return recorder;
  } catch (error) {
    return null;
  }
}

function stopMicrophone() {
  var stream = store.stream;
  store.stream = null;
  var recorder = store.recorder;
  store.recorder = null;

  return new Promise(function (resolve) {
    function finish(blob) {
      if (stream) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
      }
      resolve(blob || null);
    }

    if (!recorder || recorder.state === 'inactive') return finish(null);
    recorder.addEventListener('stop', function () {
      try {
        finish(new Blob(recorder.chunks, { type: recorder.mimeType || 'audio/webm' }));
      } catch (error) {
        finish(null);
      }
    });
    try {
      recorder.stop();
    } catch (error) {
      finish(null);
    }
  });
}

function rememberRecording(blob) {
  forgetRecording();
  if (!blob || !globalThis.URL || !URL.createObjectURL) return;
  try {
    store.recordingUrl = URL.createObjectURL(blob);
  } catch (error) {
    store.recordingUrl = null;
  }
}

function forgetRecording() {
  if (!store.recordingUrl) return;
  try {
    URL.revokeObjectURL(store.recordingUrl);
  } catch (error) {
    // Already gone.
  }
  store.recordingUrl = null;
}

/** The bits of the card the loop talks to, all optional so a trimmed-down
 * template degrades into a plainer card rather than an exception. */
function makeUi(root) {
  var status = attr(root, 'data-amgi-status');
  var note = attr(root, 'data-amgi-note');
  var playButton = action(root, 'play');
  var playHandler = null;

  if (playButton) {
    playButton.addEventListener('click', function () {
      if (playHandler) playHandler();
    });
  }

  return {
    root: root,
    phase: function (phase) {
      root.setAttribute('data-amgi-phase', phase);
      setText(status, AMGI_STATUS[phase] || '');
    },
    note: function (text) {
      setText(note, text || '');
      show(note, !!text);
    },
    offerPlay: function (handler) {
      playHandler = handler;
      show(playButton, !!handler);
    },
  };
}

var AMGI_STATUS = {
  prompt: 'Listen',
  listening: 'Speak your answer',
  waiting: 'Ready when you are',
  answer: 'How did you do?',
  idle: '',
};

function bootFront(root) {
  var ui = makeUi(root);
  // A new card: whatever the learner said to the last one is no longer
  // interesting, and holding the blob URL open would leak it.
  forgetRecording();

  var prompt = resolveAudio(attr(root, 'data-amgi-prompt-audio'));
  if (!prompt) ui.note('This note has no prompt audio.');

  var loop = createReviewLoop({
    vadOptions: AMGI_CONFIG.vad,
    playPrompt: function () {
      return playClip(prompt, ui);
    },
    openMic: microphone,
    closeMic: stopMicrophone,
    onMicUnavailable: function () {
      // Said once, plainly, and then the card carries on without it. The
      // desktop client denies this unless the companion add-on is installed.
      ui.note('No microphone here - press space when you have answered out loud.');
    },
    reveal: function (result) {
      rememberRecording(result.recording);
      if (!bridge('ans')) {
        ui.note('Press your client’s "Show Answer" button to continue.');
      }
    },
    onPhase: function (phase) {
      ui.phase(phase);
    },
  });

  store.loop = loop;
  bindKeys(root, function (event) {
    if (event.key === ' ' || event.key === 'Enter' || event.key === 'Spacebar') {
      // One key does the only thing that ever makes sense here: move on.
      // While the prompt plays that means skip it, while the microphone is
      // open it means "I have finished speaking", and with no microphone it
      // means "show me". Once the answer is on its way there is nothing left
      // to do, and the key is left for the client to handle.
      if (loop.phase === PHASE.PROMPT && store.clip) {
        store.clip();
        return true;
      }
      return loop.endTurn('manual');
    }
    return false;
  });

  var revealButton = action(root, 'reveal');
  if (revealButton) {
    revealButton.addEventListener('click', function () {
      if (loop.phase === PHASE.PROMPT && store.clip) store.clip();
      else loop.endTurn('manual');
    });
  }

  loop.start();
}

function bootBack(root) {
  var ui = makeUi(root);
  var native = resolveAudio(attr(root, 'data-amgi-answer-audio'));
  var prompt = resolveAudio(attr(root, 'data-amgi-prompt-audio'));

  wireReplay(root, 'replay-prompt', prompt);
  wireReplay(root, 'replay-native', native);
  wireYou(root);

  function grade(ease) {
    // One grade per rendered answer. Anki ignores an ease sent while the
    // question is still up (reviewer.py, _answerCard returns unless
    // state == "answer"), but a double send would grade the *next* card.
    if (root.getAttribute('data-amgi-graded')) return;
    root.setAttribute('data-amgi-graded', '1');
    forgetRecording();
    if (!bridge('ease' + ease)) {
      root.removeAttribute('data-amgi-graded');
      ui.note('Grade this card with your client’s own buttons.');
    }
  }

  var again = action(root, 'again');
  var good = action(root, 'good');
  if (again) again.addEventListener('click', function () {
    grade(1);
  });
  if (good) good.addEventListener('click', function () {
    grade(3);
  });

  bindKeys(root, function (event) {
    if (event.key === ' ' || event.key === 'Enter' || event.key === 'Spacebar' || event.key === '3') {
      grade(3);
      return true;
    }
    if (event.key === '1') {
      grade(1);
      return true;
    }
    return false;
  });

  var loop = createReviewLoop({
    playNative: function () {
      return playClip(native, ui);
    },
    onPhase: function (phase) {
      ui.phase(phase);
    },
  });
  store.loop = loop;
  if (!native) ui.note('This note has no native audio.');
  loop.resumeAtAnswer({ recording: store.recordingUrl || null });
}

function wireReplay(root, name, element) {
  var button = action(root, name);
  if (!button) return;
  if (!element) return show(button, false);
  button.addEventListener('click', function () {
    try {
      element.currentTime = 0;
    } catch (error) {
      // See playClip: seeking early is allowed to fail.
    }
    var played = element.play();
    if (played && typeof played.catch === 'function') played.catch(function () {});
  });
}

function wireYou(root) {
  var button = action(root, 'replay-you');
  if (!button) return;
  // The recording only exists on clients that keep one document across the
  // reveal. Elsewhere the button simply is not offered.
  if (!store.recordingUrl) return show(button, false);
  show(button, true);
  var element = new Audio(store.recordingUrl);
  button.addEventListener('click', function () {
    var played = element.play();
    if (played && typeof played.catch === 'function') played.catch(function () {});
  });
}

function bindKeys(root, handler) {
  if (AMGI_CONFIG.keys === false) return;
  if (store.keyHandler) {
    document.removeEventListener('keydown', store.keyHandler, true);
    store.keyHandler = null;
  }
  var listener = function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    // A render that has been replaced must not keep answering keys.
    if (!root.isConnected) {
      document.removeEventListener('keydown', listener, true);
      return;
    }
    if (handler(event)) event.preventDefault();
  };
  store.keyHandler = listener;
  document.addEventListener('keydown', listener, true);
}

function boot() {
  // The last one wins: a back template that starts with {{FrontSide}} renders
  // the question's markup above its own, and the answer is the live one.
  var roots = document.querySelectorAll('[data-amgi-card]:not([data-amgi-booted])');
  var root = roots[roots.length - 1];
  if (!root) return;
  root.setAttribute('data-amgi-booted', '1');

  // The previous side or card may still be listening in this same document.
  if (store.loop) store.loop.cancel();
  if (store.stream) stopMicrophone();

  try {
    if (root.getAttribute('data-amgi-side') === 'back') bootBack(root);
    else bootFront(root);
  } catch (error) {
    // A card that throws is a review session that stops. Say so on the card
    // and leave the client's own buttons working.
    var note = attr(root, 'data-amgi-note');
    setText(note, 'amgi loop error: ' + (error && error.message));
    show(note, true);
  }
}

// Exposed for the browser harness, which drives the phases without Anki.
globalThis.amgiLoop = {
  boot: boot,
  createReviewLoop: createReviewLoop,
  detectSpeechEnd: detectSpeechEnd,
  PHASE: PHASE,
  store: store,
};

boot();
