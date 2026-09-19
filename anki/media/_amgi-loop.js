// GENERATED FILE - do not edit.
//
// Built by anki/tools/build-loop.js from:
//   src/utils/voiceActivity.js
//   src/utils/reviewLoop.js
//   anki/src/anki-loop.js
//
// Run `node anki/tools/build-loop.js` after changing any of them.
// The leading underscore is deliberate: Anki never reports a media file
// whose name starts with one as unused (rslib/src/media/check.rs), and the
// quoted "_amgi-loop.js" in the card template is what makes the exporter
// carry it into an .apkg (rslib/src/text.rs, UNDERSCORED_REFERENCES).

(function () {
'use strict';

// ---- src/utils/voiceActivity.js --------------------------------------------

// Voice activity detection for the review loop.
//
// The reviewer speaks their answer without pressing anything, so the app has
// to decide when they are done. We watch the microphone's short-term loudness:
// calibrate the room's noise floor, wait for speech to rise above it, then end
// the turn once the level stays down for a beat. Everything is bounded by
// timeouts so a silent or noisy room still moves the session along.

const SPEECH_END_DEFAULTS = {
  // How long we listen to the room before deciding what "quiet" sounds like.
  calibrationMs: 350,
  // Speech has to be this much louder than the noise floor to count.
  thresholdMultiplier: 2.5,
  // ...and at least this loud in absolute terms (RMS of a -34 dBFS signal),
  // so a dead-silent room doesn't make every rustle look like speech.
  minThreshold: 0.02,
  // ...but never so loud that normal speech can't clear the bar. Reviewers
  // who answer the instant the prompt ends are talking *during* calibration,
  // and this cap is what keeps that from deafening the detector.
  maxThreshold: 0.06,
  // Speech must hold above the threshold this long before we believe it.
  speechOnsetMs: 150,
  // Once speaking, this much quiet ends the turn.
  silenceMs: 1200,
  // If the reviewer never says anything, give up and reveal the answer.
  noSpeechTimeoutMs: 8000,
  // Absolute ceiling on a single answer.
  maxUtteranceMs: 20000,
  // How often we sample the level.
  pollMs: 50,
};

/**
 * Watches a microphone stream and calls `onEnd(reason)` once the speaker has
 * finished. Reasons: 'speech' (spoke, then went quiet), 'no-speech' (never
 * started) or 'max-duration' (ran long).
 *
 * @returns {() => void} stop - tears down the analyser; safe to call twice.
 */
function detectSpeechEnd({ audioContext, stream, onEnd, options = {} }) {
  const opts = { ...SPEECH_END_DEFAULTS, ...options };

  if (!audioContext || !stream) {
    // Without a live stream we can't hear anything; fall back to the
    // no-speech timeout so the caller still gets an answer.
    const timer = setTimeout(() => onEnd('no-speech'), opts.noSpeechTimeoutMs);
    return () => clearTimeout(timer);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();

  let stopped = false;
  let timer = null;
  let noiseFloor = Infinity;
  let threshold = opts.minThreshold;
  let speaking = false;
  let aboveSince = null;
  let belowSince = null;

  const finish = (reason) => {
    if (stopped) return;
    stop();
    onEnd(reason);
  };

  const tick = () => {
    if (stopped) return;

    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / samples.length);

    const elapsed = Date.now() - startedAt;
    const now = Date.now();

    if (elapsed < opts.calibrationMs) {
      // The quietest moment in the window is the best estimate of the room;
      // taking the loudest would hand a fast answerer their own voice as the
      // noise floor.
      noiseFloor = Math.min(noiseFloor, rms);
      threshold = Math.min(
        Math.max(noiseFloor * opts.thresholdMultiplier, opts.minThreshold),
        opts.maxThreshold
      );
    } else if (!speaking) {
      if (rms >= threshold) {
        aboveSince = aboveSince ?? now;
        if (now - aboveSince >= opts.speechOnsetMs) {
          speaking = true;
          belowSince = null;
        }
      } else {
        aboveSince = null;
        if (elapsed >= opts.noSpeechTimeoutMs) return finish('no-speech');
      }
    } else {
      // Hysteresis: it takes a bit less level to stay "speaking" than to start.
      if (rms >= threshold * 0.8) {
        belowSince = null;
      } else {
        belowSince = belowSince ?? now;
        if (now - belowSince >= opts.silenceMs) return finish('speech');
      }
    }

    if (elapsed >= opts.maxUtteranceMs) return finish('max-duration');

    timer = setTimeout(tick, opts.pollMs);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      // Node was already torn down with its context; nothing to clean up.
    }
  }

  timer = setTimeout(tick, opts.pollMs);
  return stop;
}

// ---- src/utils/reviewLoop.js -----------------------------------------------

// The review loop's sequencing, with no dependency on the app it runs in.
//
// amgi's web reviewer and the Anki card template drive the same three beats:
// the prompt audio plays, the microphone opens by itself and closes when the
// learner stops speaking, then the answer is revealed with the native audio.
// Only the effects differ between the two - one calls React state setters and
// Supabase-backed audio, the other calls `pycmd` and HTML5 <audio> elements -
// so the order, the cancellation rules and the fallbacks live here and each
// host passes in the effects.
//
// Constraints that keep this file portable: no imports other than the voice
// detector, no browser globals, and no host callback is ever allowed to throw
// into the machine. A card template that throws mid-review leaves the learner
// staring at a dead card, so every call out is wrapped.


const PHASE = {
  IDLE: 'idle',
  // The prompt audio is playing.
  PROMPT: 'prompt',
  // The microphone is open and voice activity decides when the turn ends.
  LISTENING: 'listening',
  // No microphone: the learner ends the turn themselves. The host decides how
  // long to sit here - amgi ends it immediately, the Anki template waits for a
  // key or a tap.
  WAITING: 'waiting',
  // Revealed: native audio and self-grading.
  ANSWER: 'answer',
};

const noop = () => {};

const safe = (fn) => {
  try {
    return fn();
  } catch {
    // A host callback failing must not strand the loop mid-card.
    return undefined;
  }
};

const safeAsync = async (fn) => {
  try {
    return await fn();
  } catch {
    return undefined;
  }
};

/**
 * @param {object} host
 * @param {() => Promise<void>} [host.playPrompt]   resolves when the prompt audio has finished
 * @param {() => Promise<{audioContext: any, stream: any}>} [host.openMic]
 *        resolves with a live stream, or rejects if the microphone is unavailable
 * @param {() => Promise<any>} [host.closeMic]      resolves with a recording, or null
 * @param {(result) => void|Promise<void>} [host.reveal]        show the answer
 * @param {() => Promise<void>} [host.playNative]   resolves when the native audio has finished
 * @param {(phase, info) => void} [host.onPhase]
 * @param {(error) => void} [host.onMicUnavailable]
 * @param {(result) => void|Promise<void>} [host.onAnswerReady] after the native audio
 * @param {function} [host.detect]                  swapped out in tests
 * @param {object} [host.vadOptions]                passed through to the detector
 */
function createReviewLoop(host = {}) {
  const {
    playPrompt = noop,
    openMic = null,
    closeMic = noop,
    reveal = noop,
    playNative = noop,
    onPhase = noop,
    onMicUnavailable = noop,
    onAnswerReady = noop,
    detect = detectSpeechEnd,
    vadOptions,
  } = host;

  // Bumped whenever a run is cancelled, so async steps from the previous card
  // bail out instead of fighting the new one.
  let runId = 0;
  let phase = PHASE.IDLE;
  let stopVad = null;
  let endCurrentTurn = null;
  // Once the microphone has been refused there is no point asking again on
  // every card: the prompt would fire per card and the answer will not change.
  let micUnavailable = false;

  const stale = (id) => id !== runId;

  const setPhase = (next, info) => {
    phase = next;
    safe(() => onPhase(next, info));
  };

  const releaseVad = () => {
    if (!stopVad) return;
    const stop = stopVad;
    stopVad = null;
    safe(stop);
  };

  /**
   * Abandons the current card. Safe to call at any time, including twice.
   * The phase is not announced: a cancel is always followed by the host doing
   * something else, and a flash of "idle" in between only causes flicker.
   */
  function cancel() {
    runId += 1;
    releaseVad();
    // A turn left unresolved would keep start()'s promise pending forever, so
    // the cancelled run is woken up and sees a stale id.
    const resolve = endCurrentTurn;
    endCurrentTurn = null;
    phase = PHASE.IDLE;
    if (resolve) resolve('cancelled');
    return runId;
  }

  /**
   * Ends the listening (or waiting) turn now, as "space" does.
   * @returns {boolean} whether there was a turn to end.
   */
  function endTurn(reason = 'manual') {
    if (!endCurrentTurn) return false;
    const resolve = endCurrentTurn;
    endCurrentTurn = null;
    releaseVad();
    resolve(reason);
    return true;
  }

  // The resolver is installed before the phase is announced, so a host that
  // ends the turn synchronously from onPhase (amgi does, when it has no
  // microphone) is not racing us.
  const awaitTurn = (id, enter) =>
    new Promise((resolve) => {
      endCurrentTurn = resolve;
      enter(id);
    });

  const listen = (id, mic) =>
    awaitTurn(id, () => {
      setPhase(PHASE.LISTENING);
      stopVad = detect({
        audioContext: mic && mic.audioContext,
        stream: mic && mic.stream,
        options: vadOptions,
        onEnd: (reason) => {
          if (stale(id)) return;
          endTurn(reason);
        },
      });
    });

  const waitForLearner = (id) => awaitTurn(id, () => setPhase(PHASE.WAITING, { reason: 'no-mic' }));

  async function answerBeat(id, result) {
    setPhase(PHASE.ANSWER, result);
    await safeAsync(() => reveal(result));
    if (stale(id)) return;
    await safeAsync(() => playNative(result));
    if (stale(id)) return;
    await safeAsync(() => onAnswerReady(result));
  }

  /** Runs one card from the top. Cancels any card already in flight. */
  async function start() {
    const id = cancel();
    setPhase(PHASE.PROMPT);
    await safeAsync(() => playPrompt());
    if (stale(id)) return;

    let mic = null;
    if (openMic && !micUnavailable) {
      try {
        mic = await openMic();
      } catch (error) {
        micUnavailable = true;
        safe(() => onMicUnavailable(error));
      }
      if (stale(id)) {
        await safeAsync(() => closeMic());
        return;
      }
    }

    const reason = mic ? await listen(id, mic) : await waitForLearner(id);
    if (stale(id)) return;

    let recording = null;
    if (mic) recording = (await safeAsync(() => closeMic())) || null;
    if (stale(id)) return;

    // A turn that ended because nobody spoke has nothing worth replaying.
    await answerBeat(id, { reason, recording: reason === 'no-speech' ? null : recording });
  }

  /**
   * Picks the loop up at the answer, for hosts where revealing reloads the
   * page and the listening half has already happened. The Anki template's back
   * side is exactly this case.
   */
  async function resumeAtAnswer(result = {}) {
    const id = cancel();
    const info = { reason: 'revealed', recording: null, ...result };
    setPhase(PHASE.ANSWER, info);
    await safeAsync(() => playNative(info));
    if (stale(id)) return;
    await safeAsync(() => onAnswerReady(info));
  }

  return {
    start,
    endTurn,
    cancel,
    resumeAtAnswer,
    get phase() {
      return phase;
    },
    get micUnavailable() {
      return micUnavailable;
    },
    /** Lets a host that already knows the microphone is gone skip the prompt. */
    disableMic() {
      micUnavailable = true;
    },
  };
}

// ---- anki/src/anki-loop.js -------------------------------------------------

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

})();
