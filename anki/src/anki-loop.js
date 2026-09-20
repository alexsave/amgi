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
function playClip(element, ui, kind) {
  return new Promise(function (resolve) {
    if (!element) return resolve('missing');

    // Fire-and-forget: it manages its own start and its own end (the
    // element's own events), so playClip never needs to hold or await it.
    beginVisualizing(element, kind);

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

/**
 * The one AudioContext this card ever opens. The microphone analyser and the
 * playback visualizer both call this instead of constructing their own, so
 * there is exactly one audio graph per render no matter how many things want
 * to look at it.
 */
function ensureAudioContext() {
  var Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  var context = store.audioContext;
  if (context && context.state === 'closed') context = null;
  if (!context) {
    try {
      context = new Ctx();
    } catch (error) {
      return null;
    }
    store.audioContext = context;
  }
  return context;
}

/** The microphone, if this client has one to give. */
function microphone() {
  var media = globalThis.navigator && navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') {
    return Promise.reject(new Error('this Anki client does not expose a microphone to cards'));
  }
  return media.getUserMedia({ audio: true }).then(function (stream) {
    var context = ensureAudioContext();
    if (!context) {
      stream.getTracks().forEach(function (track) {
        track.stop();
      });
      throw new Error('no Web Audio in this client');
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

// ---- the visualizer -------------------------------------------------------
//
// A canvas sitting directly on the card, drawing a single ring whose radius,
// stroke width and opacity follow the source's real loudness (time-domain
// RMS), coloured by whichever audio SOURCE is currently playing - not by the
// card's phase - so the same three colours mean the same three things
// whether a clip is autoplaying or the learner tapped a replay button.
//
// This replaces an earlier "one line per frequency bin" ray design that
// looked right in the drawing code but never could at this size: fftSize=256
// gives 128 bins, spread linearly around a circle at ~190Hz per bin at
// 48kHz, so all speech energy landed in the first fifth of the circle -
// always the same wedge, in the same place, regardless of what the learner
// did. A bigger canvas would only have drawn a bigger wedge. Reading real
// loudness off the time domain instead of a frequency bin's position sidesteps
// that entirely: there is only one number, and it drives one honest shape.
// The colours - and the overall opacity - live in _amgi-loop.css as custom
// properties; this file only knows their names.
//
// Every failure mode below - no canvas, no 2D context, no AudioContext, a
// context stuck suspended, a client that refuses createMediaElementSource -
// falls back to leaving the canvas empty: a blank patch of card, never a
// broken one. None of it may ever touch whether a clip plays or how loud it
// is.

var VISUALIZER_FALLBACK_COLORS = {
  cue: 'hsl(212, 88%, 62%)',
  you: 'hsl(38, 75%, 58%)',
  native: 'hsl(158, 50%, 50%)',
  neutral: 'hsl(215, 12%, 60%)',
};

function readColor(root, name, fallback) {
  try {
    var value = globalThis.getComputedStyle(root).getPropertyValue(name);
    return value && value.trim() ? value.trim() : fallback;
  } catch (error) {
    return fallback;
  }
}

function readNumber(root, name, fallback) {
  try {
    var value = parseFloat(globalThis.getComputedStyle(root).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

function sourceColors(root) {
  return {
    cue: readColor(root, '--amgi-color-cue', VISUALIZER_FALLBACK_COLORS.cue),
    you: readColor(root, '--amgi-color-you', VISUALIZER_FALLBACK_COLORS.you),
    native: readColor(root, '--amgi-color-native', VISUALIZER_FALLBACK_COLORS.native),
    neutral: readColor(root, '--amgi-color-neutral', VISUALIZER_FALLBACK_COLORS.neutral),
  };
}

function reducedMotionPreferred() {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

// The rays this replaced (see git history) drew `dataArray.length * 0.5` = 64
// bars, indexed LINEARLY into a 128-bin FFT (fftSize 256). At a 48kHz sample
// rate that is ~190Hz per bin, so ordinary speech - which lives mostly under
// 1-2kHz - lit up only the first fifth or so of the bars, always the same
// wedge of the circle, and at a 96px canvas the bars were closer together
// than their own line width and merged into a fill. Both are fixed here, not
// worked around: BAR_COUNT is few enough and thick enough to read as
// individual spokes (see .amgi-visual's 9rem in _amgi-loop.css), and
// barLevels below samples log-spaced frequencies, mirrored across the
// vertical axis, so the same voice spreads around the whole circle instead
// of crowding one side of it.
var BAR_COUNT = 28;
var UNIQUE_BARS = Math.ceil(BAR_COUNT / 2);
var MIN_HZ = 90; // just above a typical adult voice's fundamental
var MAX_HZ = 4000; // the top of speech's useful, intelligibility-carrying energy

/**
 * Builds the controller anki-loop.js drives during playback and while the mic
 * is open. Every method is a no-op when the card can't support this - no
 * canvas in the template, no 2D context, no requestAnimationFrame - so a
 * caller never needs to check first.
 */
function createVisualizer(root) {
  var noop = { draw: function () {}, stop: function () {} };
  if (typeof globalThis.requestAnimationFrame !== 'function') return noop;

  var canvas = attr(root, 'data-amgi-visualizer');
  if (!canvas || typeof canvas.getContext !== 'function') return noop;

  var ctx;
  try {
    ctx = canvas.getContext('2d');
  } catch (error) {
    ctx = null;
  }
  if (!ctx) return noop;

  var colors = sourceColors(root);
  // A multiplier on the alpha below, not a replacement for it - lets the
  // whole card be retuned lighter or heavier from CSS alone.
  var opacityScale = readNumber(root, '--amgi-visualizer-opacity', 1);
  var rafId = null;
  var timeBuffer = null;
  var freqBuffer = null;
  var barState = null;

  function sizeFor() {
    var dpr = globalThis.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var width = rect.width || canvas.clientWidth || 0;
    var height = rect.height || canvas.clientHeight || 0;
    var pixelWidth = Math.round(width * dpr);
    var pixelHeight = Math.round(height * dpr);
    if (width && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width: width, height: height };
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    var size = sizeFor();
    ctx.clearRect(0, 0, size.width || canvas.width, size.height || canvas.height);
  }

  /**
   * One frame's worth of time-domain RMS, 0..1. Works the same whether
   * `analyser` is the mic's own (voiceActivity.js, fftSize 1024) or a clip's
   * (attachVisualizerSource below, fftSize 1024 to match) - the ring never
   * needs to know which.
   */
  function levelNow(analyser) {
    if (!timeBuffer || timeBuffer.length !== analyser.fftSize) {
      timeBuffer = new Float32Array(analyser.fftSize);
    }
    try {
      analyser.getFloatTimeDomainData(timeBuffer);
    } catch (error) {
      return null;
    }
    var sumSquares = 0;
    for (var i = 0; i < timeBuffer.length; i++) sumSquares += timeBuffer[i] * timeBuffer[i];
    var rms = Math.sqrt(sumSquares / timeBuffer.length);
    // Ordinary speech sits well under 0.3 RMS; this gain is tuned so a normal
    // answer swings the ring noticeably without pinning it to full size on
    // every syllable.
    return Math.min(1, rms * 5);
  }

  /**
   * UNIQUE_BARS magnitudes (0..1), one per log-spaced frequency between
   * MIN_HZ and MAX_HZ, read off the same analyser levelNow uses. Log spacing
   * (not linear) is what actually spreads a voice around the circle: speech
   * energy falls off fast above a couple kHz, so a linear sweep from 0Hz to
   * the Nyquist frequency still spends almost every bar above where a voice
   * has anything left to show. draw() below mirrors these across the
   * vertical axis into BAR_COUNT positions, so the figure comes out
   * symmetric rather than a one-sided sweep from low to high.
   */
  function barLevels(analyser) {
    var bins = analyser.frequencyBinCount;
    if (!freqBuffer || freqBuffer.length !== bins) freqBuffer = new Uint8Array(bins);
    try {
      analyser.getByteFrequencyData(freqBuffer);
    } catch (error) {
      return null;
    }
    var sampleRate = (analyser.context && analyser.context.sampleRate) || 48000;
    var hzPerBin = sampleRate / analyser.fftSize;
    var levels = new Array(UNIQUE_BARS);
    for (var k = 0; k < UNIQUE_BARS; k++) {
      var frac = UNIQUE_BARS === 1 ? 0 : k / (UNIQUE_BARS - 1);
      var hz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, frac);
      var bin = Math.min(bins - 1, Math.max(1, Math.round(hz / hzPerBin)));
      levels[k] = freqBuffer[bin] / 255;
    }
    return levels;
  }

  function paint(size, color, level, breathe, bars) {
    var cx = size.width / 2;
    var cy = size.height / 2;
    // Kept well under half the canvas even at every maximum at once (loudest
    // ring plus every spoke fully extended) so nothing clips against
    // .amgi-visual's own bounds - see _amgi-loop.css.
    var base = Math.min(size.width, size.height) * 0.2;
    var ringRadius = base + level * base * 0.25 + breathe;
    var alpha = Math.max(0, Math.min(1, (0.35 + level * 0.65) * opacityScale));

    ctx.clearRect(0, 0, size.width, size.height);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';

    // The core ring: same honest "something is listening" floor as before -
    // even silence still reads as a ring, not ghosted or gone.
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0, ringRadius), 0, Math.PI * 2);
    ctx.stroke();

    // The spokes. Fewer and thicker than the rays this replaces (28, not 64)
    // is what keeps them reading as individual lines instead of merging into
    // a fill at this size - see the BAR_COUNT comment above.
    var barWidth = Math.max(2, ((2 * Math.PI * ringRadius) / BAR_COUNT) * 0.55);
    ctx.lineWidth = barWidth;
    var innerR = ringRadius + 2;
    for (var i = 0; i < BAR_COUNT; i++) {
      var mag = bars ? bars[i < UNIQUE_BARS ? i : BAR_COUNT - 1 - i] : 0;
      var angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
      var outerR = innerR + 3 + mag * base * 0.85;
      var cos = Math.cos(angle);
      var sin = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cx + cos * innerR, cy + sin * innerR);
      ctx.lineTo(cx + cos * outerR, cy + sin * outerR);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** @param {AnalyserNode|null} analyser @param {'cue'|'you'|'native'} kind */
  function draw(analyser, kind) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') {
      stop();
      return;
    }
    // An audio source this file doesn't recognise still gets drawn, just in
    // the neutral colour - a cosmetic feature is never a reason to throw.
    var color = colors[kind] || colors.neutral;

    if (reducedMotionPreferred()) {
      // A static ring instead of nothing: reduced motion should mean no
      // animation, not no indicator that a microphone is open or a clip is
      // playing. Bars stay at their resting length (mag 0 - see paint's
      // `bars ? ... : 0`), not driven by real audio, so this is a single
      // still frame, not motion with the animation loop removed.
      var still = sizeFor();
      if (still.width && still.height) paint(still, color, 0.12, 0, null);
      return;
    }

    var level = 0;
    barState = new Array(UNIQUE_BARS).fill(0);

    function frame(now) {
      var size = sizeFor();
      if (!size.width || !size.height) {
        rafId = requestAnimationFrame(frame);
        return;
      }
      var raw = levelNow(analyser);
      if (raw === null) {
        stop();
        return;
      }
      // Fast attack, slow release: the ring should jump to a loud syllable
      // at once but ease back down between words, not flicker on every dip.
      level += (raw - level) * (raw > level ? 0.6 : 0.15);

      var rawBars = barLevels(analyser);
      if (rawBars) {
        for (var i = 0; i < UNIQUE_BARS; i++) {
          var b = rawBars[i];
          barState[i] += (b - barState[i]) * (b > barState[i] ? 0.6 : 0.2);
        }
      }

      // A slow, signal-independent breathing motion so a perfectly silent
      // room still reads as "alive" rather than "frozen" while the ring is
      // otherwise at its floor - this is the front's idle listening
      // indicator, not a separate element.
      var breathe = Math.sin((now || 0) / 900) * (Math.min(size.width, size.height) * 0.015);
      paint(size, color, level, breathe, barState);
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  return { draw: draw, stop: stop };
}

/**
 * Routes one `<audio>` element through the shared AudioContext so the
 * visualizer can read its frequency data, and returns the analyser (or null
 * if this client won't allow it). `createMediaElementSource` can only be
 * called once per element - the result is cached on the element itself so a
 * clip replayed several times (the "Hear it again"/"Hear the answer" buttons) reuses the same
 * routing instead of throwing on the second attempt.
 */
function attachVisualizerSource(context, element) {
  if (!context || !element || typeof context.createMediaElementSource !== 'function') return null;
  if (element.__amgiAnalyser !== undefined) return element.__amgiAnalyser;
  var source;
  try {
    source = context.createMediaElementSource(element);
  } catch (error) {
    // Already routed into a different graph, or this client refuses it
    // outright. Leaving the element alone means it keeps playing normally.
    element.__amgiAnalyser = null;
    return null;
  }
  try {
    var analyser = context.createAnalyser();
    // Matches voiceActivity.js's own analyser so the ring reads the same way
    // whether it is fed by the microphone or by a clip.
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(context.destination);
    element.__amgiAnalyser = analyser;
    return analyser;
  } catch (error) {
    // createMediaElementSource already redirected this element's output away
    // from its default destination the instant it was called, above - so it
    // MUST still reach the speakers somehow, or the clip goes silent. A
    // silent card is a far worse bug than a missing visualizer.
    try {
      source.connect(context.destination);
    } catch (fallbackError) {
      // The client is refusing the graph outright; nothing more to do.
    }
    element.__amgiAnalyser = null;
    return null;
  }
}

/**
 * Wires one playing `<audio>` element to the shared visualizer, and returns a
 * function that detaches it early. Safe to call on every play, including
 * clips this client can't route through Web Audio at all: it just never
 * calls back, and playback is untouched either way.
 */
function beginVisualizing(element, kind) {
  if (!element) return function () {};
  var context = ensureAudioContext();
  if (!context || !store.visualizer) return function () {};

  var stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    element.removeEventListener('ended', stop);
    element.removeEventListener('error', stop);
    element.removeEventListener('pause', stop);
    store.visualizer.stop();
  }
  // Listening from the start, not only once the graph is attached below,
  // is what stops a short clip that ends before a slow-to-resume context
  // ever gets there from leaving the visualizer spinning on nothing.
  element.addEventListener('ended', stop);
  element.addEventListener('error', stop);
  element.addEventListener('pause', stop);

  // Chromium suspends a freshly created AudioContext until a user gesture
  // resumes it. Waiting for that to actually resolve to "running" before
  // wiring the element into the graph means a still-suspended context just
  // leaves the clip on its ordinary, un-routed output - never a silenced one.
  var ready =
    context.state === 'running'
      ? Promise.resolve()
      : context.resume
      ? context.resume()
      : Promise.reject(new Error('AudioContext cannot resume'));
  Promise.resolve(ready).then(
    function () {
      if (stopped || context.state !== 'running') return;
      var analyser = attachVisualizerSource(context, element);
      if (!analyser) return;
      store.visualizer.draw(analyser, kind);
    },
    function () {
      // No visualizer for this clip; it plays through its normal output.
    }
  );

  return stop;
}

// Three small glyphs, one per family of phase, so the status line carries an
// icon as well as text - the biggest visual event on the card is now the
// phase changing, not a flicker in the corner. currentColor means each just
// follows the status text's own colour; aria-hidden because the text next to
// them already says the same thing to a screen reader.
var AMGI_STATUS_ICON = {
  speaker:
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  mic:
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
  tick:
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4 10-10"/></svg>',
};

// The prompt-phase line is the fix for a first-time learner's real question
// ("wait, is my mic about to turn on?"): it says so before the mic opens,
// while the audio actually playing at that moment is CueAudio - the
// gloss/translation clip (see anki/README.md's field table) - not the target
// phrase, so "the translation" in the owner's own wording is accurate here.
// `recording`, where set, is both the flag and the text .amgi-status-recording
// shows (see makeUi below) - it is only ever true for PHASE.LISTENING, which
// reviewLoop.js only reaches once openMic() has resolved with a live stream,
// so the callout it drives is never lying about the mic being open.
var AMGI_STATUS = {
  prompt: { text: "Listen to the translation, then we'll record your voice.", icon: 'speaker' },
  'requesting-mic': { text: 'Asking for the microphone...', icon: 'mic' },
  listening: { text: "Stop talking when you're done.", icon: 'mic', recording: 'Now recording your voice.' },
  waiting: { text: "Press space when you're done.", icon: 'tick' },
  answer: { text: 'How did you do?', icon: 'tick' },
  idle: { text: '', icon: null },
};

// What the "Done speaking" / "Skip" button says and does changes with the
// phase (see bootFront's revealButton wiring below); this is its label half.
var AMGI_REVEAL_LABEL = {
  prompt: 'Skip',
  'requesting-mic': 'One moment...',
  listening: 'Done speaking',
  waiting: 'Show answer',
  idle: 'Skip',
};

/** The bits of the card the loop talks to, all optional so a trimmed-down
 * template degrades into a plainer card rather than an exception. */
function makeUi(root) {
  var status = attr(root, 'data-amgi-status');
  var statusIcon = attr(root, 'data-amgi-status-icon');
  var statusText = attr(root, 'data-amgi-status-text');
  var statusRecording = attr(root, 'data-amgi-status-recording');
  var statusRecordingText = attr(root, 'data-amgi-status-recording-text');
  var note = attr(root, 'data-amgi-note');
  var playButton = action(root, 'play');
  var playHandler = null;
  var revealLabel = attr(root, 'data-amgi-reveal-label');
  var revealButton = action(root, 'reveal');

  if (playButton) {
    playButton.addEventListener('click', function () {
      if (playHandler) playHandler();
    });
  }

  return {
    root: root,
    phase: function (phase) {
      root.setAttribute('data-amgi-phase', phase);
      var info = AMGI_STATUS[phase] || AMGI_STATUS.idle;
      // status/statusText fall back to the same element when a trimmed-down
      // template has no separate icon/text spans (see front.html/back.html).
      setText(statusText || status, info.text);
      if (statusIcon) statusIcon.innerHTML = (info.icon && AMGI_STATUS_ICON[info.icon]) || '';
      // The dot is aria-hidden (decorative); this text is what actually
      // reaches a screen reader, and both live inside .amgi-status's own
      // role="status"/aria-live region, so hiding/showing this element is
      // enough to be announced - no separate live region needed for it.
      if (statusRecordingText) setText(statusRecordingText, info.recording || '');
      if (statusRecording) show(statusRecording, !!info.recording);
      if (revealLabel) setText(revealLabel, AMGI_REVEAL_LABEL[phase] || AMGI_REVEAL_LABEL.idle);
      if (revealButton) revealButton.disabled = phase === 'requesting-mic';
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

function bootFront(root) {
  var ui = makeUi(root);
  store.visualizer = createVisualizer(root);
  // A new card: whatever the learner said to the last one is no longer
  // interesting, and holding the blob URL open would leak it.
  forgetRecording();

  var cueAudio = resolveAudio(attr(root, 'data-amgi-cue-audio'));
  var hasCueAudio = !!cueAudio;
  if (!hasCueAudio) {
    // Opening the microphone to answer a card with nothing to answer is
    // worse than not opening it: skip straight to the same "press space"
    // fallback a client with no microphone at all reaches, rather than
    // listening for an answer to a question that was never asked.
    ui.note('This card has no audio yet - press space to see it, or use amgi bridge’s "Fill missing audio..." to add it.');
  }

  var loop = createReviewLoop({
    vadOptions: AMGI_CONFIG.vad,
    micTimeoutMs: AMGI_CONFIG.micTimeoutMs,
    playPrompt: function () {
      return playClip(cueAudio, ui, 'cue');
    },
    // No point opening a microphone to answer a card that asked nothing.
    openMic: hasCueAudio ? microphone : null,
    closeMic: stopMicrophone,
    // detectSpeechEnd (voiceActivity.js) already builds the one AnalyserNode
    // this mic gets; wrapping it here - rather than reviewLoop.js opening a
    // second one - is what "reuse the existing analyser" means in practice.
    // The colour is 'you': the mic is always the learner's own voice, same as
    // the "You" replay button below.
    detect: function (args) {
      var stop = detectSpeechEnd(args);
      if (stop.analyser && store.visualizer) store.visualizer.draw(stop.analyser, 'you');
      return function () {
        if (store.visualizer) store.visualizer.stop();
        stop();
      };
    },
    onMicUnavailable: function () {
      // Persisted on `store`, which survives a fresh createReviewLoop() on
      // every card (see the loop.disableMic() call below): without this, a
      // stock desktop client without the companion add-on re-races the same
      // micTimeoutMs wait on every single card, thirty times in a row,
      // instead of once per session.
      store.micUnavailable = true;
      // Said once, plainly, and then the card carries on without it - not
      // repeated on every subsequent card, which used to make a single
      // known fact look like a fresh error each time.
      if (!store.micNoteShown) {
        store.micNoteShown = true;
        ui.note('No microphone here - press space when you have answered out loud.');
      }
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
  // A refusal from an earlier card this session: skip the request outright
  // rather than racing micTimeoutMs again for no reason (see onMicUnavailable
  // above).
  if (store.micUnavailable) loop.disableMic();

  bindKeys(root, function (event) {
    if (event.key === ' ' || event.key === 'Enter' || event.key === 'Spacebar') {
      // One key does the only thing that ever makes sense here: move on.
      // While the prompt plays that means skip it, while the microphone is
      // open it means "I have finished speaking", and with no microphone it
      // means "show me". Once the answer is on its way there is nothing left
      // to do, and the key is left for the client to handle. While the
      // microphone request itself is still pending there is nothing to do
      // either - the button is disabled for the same reason (see makeUi).
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
  store.visualizer = createVisualizer(root);
  var native = resolveAudio(attr(root, 'data-amgi-target-audio'));
  var cueAudio = resolveAudio(attr(root, 'data-amgi-cue-audio'));

  wireReplay(root, 'replay-cue', cueAudio, 'cue');
  wireReplay(root, 'replay-native', native, 'native');
  wireYou(root);

  // No grading row of its own, and no keydown handler either. Real Anki
  // (26.09.2, Qt 6.11), verified live: space/1 are bound twice at once on
  // desktop - once by this template's own keydown handler, once as Anki's
  // native QShortcut on the main window - and which one wins the race varies
  // from keypress to keypress. Grading is the one place on this card where a
  // double-fire is not idempotent: a second pycmd("easeN") would grade the
  // *next* card, corrupting its schedule silently. A second, card-drawn
  // Again/Good row right above Anki's own Again/Hard/Good/Easy bar was also
  // its own problem independent of the key race: two controls with the same
  // words in different colours 100px apart, offering two grades where Anki's
  // own bar offers four, reads as a duplicate or a bug rather than a design.
  // Anki's bar already grades correctly on every client this README lists,
  // so the card leaves grading to it entirely and limits itself to "How did
  // you do?" as a label sitting directly above it (see back.html).
  var loop = createReviewLoop({
    playNative: function () {
      return playClip(native, ui, 'native');
    },
    onPhase: function (phase) {
      ui.phase(phase);
    },
  });
  store.loop = loop;
  if (!native) ui.note('This note has no native audio.');
  loop.resumeAtAnswer({ recording: store.recordingUrl || null });
}

function wireReplay(root, name, element, kind) {
  var button = action(root, name);
  if (!button) return;
  if (!element) return show(button, false);
  button.addEventListener('click', function () {
    try {
      element.currentTime = 0;
    } catch (error) {
      // See playClip: seeking early is allowed to fail.
    }
    beginVisualizing(element, kind);
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
    // The learner's own voice, same colour whether it is live on the mic
    // (bootFront) or replayed here.
    beginVisualizing(element, 'you');
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
  // Likewise its visualizer: otherwise a stray requestAnimationFrame loop
  // from a render this one replaces keeps drawing into a detached canvas
  // forever, since nothing else would ever call its stop().
  if (store.visualizer) {
    store.visualizer.stop();
    store.visualizer = null;
  }

  // A stale keydown listener from the render this one replaces would
  // otherwise keep firing (harmlessly, since it self-removes on noticing its
  // own root is disconnected - see bindKeys) until the next keypress happens
  // to trigger that cleanup. Clearing it here up front, on every render
  // rather than only inside bootFront's own bindKeys call, is what makes the
  // back side provably free of amgi's own keydown handling the instant it
  // renders: verified live in real Anki (26.09.2) that without this, a stale
  // front-side listener remains registered on `document` for a bootBack
  // render (bootBack never calls bindKeys itself, by design - see "Keys" in
  // anki/README.md).
  if (store.keyHandler) {
    document.removeEventListener('keydown', store.keyHandler, true);
    store.keyHandler = null;
  }

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
