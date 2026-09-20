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
 *   The AnalyserNode this creates over the microphone is also attached as
 *   `stop.analyser` (absent when there was no stream to analyse). A host that
 *   wants to draw something reactive - the Anki card's visualizer does - reads
 *   levels off this node instead of opening a second one: one AudioContext,
 *   one analyser, one mic stream, always.
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
  stop.analyser = analyser;
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
  // openMic() has been called and hasn't settled yet. Worth a phase of its
  // own, not folded into PROMPT: a real permission prompt on a stock desktop
  // client can sit here for seconds (see micTimeoutMs), and a host that
  // leaves the previous phase's status on screen through that wait makes a
  // slow-but-normal permission dialog look like a hung card.
  REQUESTING_MIC: 'requesting-mic',
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

// A permission prompt is not guaranteed to ever settle. Real Anki desktop
// (Qt 6.11/WebEngine, no permission-handling add-on installed) leaves an
// unanswered getUserMedia() request in "ask" state forever: it neither
// resolves nor rejects. openMic() is host code this file does not control,
// so it is raced against a timer instead of trusted to always settle - the
// same shape the host already applies to clip playback (CLIP_START_TIMEOUT_MS
// in anki-loop.js), just for the one host promise that has no such guard.
const DEFAULT_MIC_TIMEOUT_MS = 15000;

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`microphone request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * @param {object} host
 * @param {() => Promise<void>} [host.playPrompt]   resolves when the prompt audio has finished
 * @param {() => Promise<{audioContext: any, stream: any}>} [host.openMic]
 *        resolves with a live stream, or rejects if the microphone is unavailable.
 *        May also simply never settle (a real risk - see micTimeoutMs), so it is
 *        always raced against a timeout rather than awaited bare.
 * @param {() => Promise<any>} [host.closeMic]      resolves with a recording, or null
 * @param {number} [host.micTimeoutMs] how long to wait for openMic() before treating
 *        it as unavailable, same as a rejection. Defaults to 15s: long enough for a
 *        first-time permission prompt a learner has to notice and click.
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
    micTimeoutMs = DEFAULT_MIC_TIMEOUT_MS,
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
      setPhase(PHASE.REQUESTING_MIC);
      try {
        mic = await withTimeout(openMic(), micTimeoutMs);
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
// A canvas sitting directly on the card: a fixed, hollow ring with 28 radial
// bars growing outward from its edge, coloured by whichever audio SOURCE is
// currently playing, not by the card's phase, so the same three colours mean
// the same three things whether a clip is autoplaying or the learner tapped
// a replay button.
//
// This went through three shapes before landing here, each one the owner's
// own call after seeing the previous one live:
//   1. A filled ring whose radius followed real loudness (time-domain RMS),
//      with per-frequency rays hanging off its edge.
//   2. The owner asked for the ring gone - bars only, radiating from a
//      shared hub. That hub then had to solve a problem the ring never had:
//      28 shapes converging on (or near) one point without fusing into a
//      blob, and with zero gap between them once "no space between bars"
//      followed. RMS moved from the (now-gone) ring's radius to the bars'
//      shared opacity instead, so a loud syllable still reads as "more".
//   3. The owner then asked for a circle back, but the opposite of the
//      first one: hollow (stroked, not filled), fixed (no reaction to audio
//      at all, not even loudness), with the bars living entirely outside it
//      rather than hanging off or converging on it. That removes the hub
//      problem at its root rather than solving it: with nothing converging
//      on a centre, there is no blob to protect against and no reason to
//      taper a bar to a point. It also removes the "quiet room reads as
//      dead" problem from a different direction than breathing did - the
//      fixed ring is a permanent, unconditional anchor, so the bars
//      themselves are now allowed to fall to nothing in silence (see
//      paint()'s `outerR`) without the card ever looking broken or frozen.
//   4. The owner then asked for the ring itself to carry the source colour,
//      "same colour as the bars" - it already did, technically (paint()
//      passes one `color` argument to both ctx.strokeStyle and
//      ctx.fillStyle, always has), but at a flat 0.6 alpha against #0b0d10
//      that hue reads as a dim, faded echo next to bars that reach full
//      alpha on a loud syllable, so a glance at a quiet moment - which is
//      most of the card's on-screen time, since a bar's own alpha floor is
//      0.35 and its length collapses to nothing at rest (see `outerR`) -
//      read as "a different, washed-out colour" even though the underlying
//      value was identical. Raised to 0.85 (paint()'s `ringAlpha`) so the
//      ring reads as unmistakably the same saturated hue the bars flare up
//      to, not a paler relative of it, while staying comfortably short of
//      the bars' own peak so a loud bar still visibly outranks the anchor
//      it grows from.
//
//      What the ring does with NO source engaged at all - not quiet, but
//      nothing has drawn here yet, or the last thing that did has fully
//      ended - is a separate decision from the colour-matching above, and
//      deliberately not "the existing --amgi-color-neutral" nor a countdown
//      back to nothing: stop() now repaints the ring in whichever source's
//      colour last drew it (see `lastColor`), rather than clearing to a
//      blank patch, once a real source has genuinely engaged this canvas at
//      least once - so "the cue clip just ended, the mic hasn't opened yet"
//      or "the native audio finished, the card is just sitting there
//      answered" keep the same anchor on screen instead of flashing it away
//      and back for every gap between sources. Neutral grey is not the
//      right colour for that gap: this file always knows exactly which
//      source last spoke, so dropping that back to "unidentified" would
//      throw away information the ring already has, not add honesty to it -
//      --amgi-color-neutral stays reserved for `colors[kind] || neutral`'s
//      genuine fallback (an audio kind this file does not recognise) a few
//      lines below, which is the only place "we don't know whose voice this
//      is" is actually true. Before any source has ever engaged the canvas,
//      though, it stays untouched (default backing size, nothing drawn) on
//      purpose: drive.js's own harness proves the mic is really driving the
//      visualizer by checking the canvas's pixel size changes away from its
//      browser default ONLY once a real AnalyserNode feeds it, and a
//      pre-emptive "idle ring" painted before that would need to size the
//      canvas to do it, which would quietly defeat that proof rather than
//      add a cosmetic. The status line already says "nothing is happening
//      yet" in words for that one gap; the ring does not need to say it too.
//
// What that leaves RMS driving is still the bars' shared opacity (see
// paint()'s `alpha`) - a separate signal from the per-frequency length each
// bar gets from barLevels, and the one thing that never became unused across
// all three shapes.
//
// The whole radial-bar idea replaces an earlier "one line per frequency bin"
// ray design that looked right in the drawing code but never could at this
// size: fftSize=256 gives 128 bins, spread linearly around a circle at
// ~190Hz per bin at 48kHz, so all speech energy landed in the first fifth of
// the circle - always the same wedge, in the same place, regardless of what
// the learner did. A bigger canvas would only have drawn a bigger wedge.
// barLevels below samples log-spaced frequencies instead, which is what
// actually spreads a voice around the whole shape.
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
// Half the angular width of one bar, as a fraction of its own slice of the
// circle (2*PI/BAR_COUNT). The owner asked twice for zero space between
// bars, and two different things were producing visible seams, fixed in
// order:
//   1. The first attempt widened this to a full slice but kept the old
//      apex-at-centre wedge shape, which still showed dark notches live: a
//      wedge that narrows to a point at innerR has a *flat* outer cap, so
//      two neighbours whose magnitudes differ leave an uncovered triangular
//      gap between their outer corners even when their angular math is
//      exact (confirmed by hand: with bar i at magnitude 1 and bar i+1 near
//      0, the point directly on their shared boundary angle, halfway out,
//      falls outside both triangles). Fixed by paint() below: every bar is
//      now a trapezoid whose LEFT and RIGHT edges are full radial segments
//      from innerR to that bar's own outerR, so neighbour i+1's left edge
//      sits on the exact same line as neighbour i's right edge for the
//      entire length the shorter of the two reaches, and the taller one
//      simply continues past it - a step in height, never a gap, regardless
//      of how different their magnitudes are.
//   2. Even with that shape and this exactly equal to half the pitch (so
//      neighbours share an edge line precisely), a hairline of background
//      was still visible live - because paint() drew each bar with its own
//      beginPath()/fill(), and two independently-rasterized shapes whose
//      edges sit on the same mathematical line can still leave a
//      sub-pixel-wide antialiasing seam between them; widening this angle
//      as a fudge factor only hid it at some sizes. Fixed at the root
//      instead: paint() now traces all 28 bars as ONE path and calls
//      fill() once, so there is no boundary between separately-drawn
//      shapes for antialiasing to leak through - the browser only
//      antialiases the single path's true outer silhouette (the "gear
//      tooth" steps between differing bar lengths, which are supposed to
//      be visible). That is also why this is exactly half the pitch again,
//      not a fudged multiple of it: a single path has no seam left to pad
//      against.
// A later pass moved the bars off a shared hub entirely - they now start on
// the edge of a fixed circle instead of converging near the centre (see
// paint()) - which raised the question of whether they still need to be
// angular wedges at all, since the hub-crowding problem this shape was
// built to solve no longer exists once nothing converges on a point. They
// stayed wedges anyway, for a reason that has nothing to do with the hub: a
// bar with a *constant pixel width* traces a rectangle, and a rectangle's
// width does not grow with radius the way the gap between neighbouring
// spokes does - two such bars could touch where they start, on the circle,
// and still visibly gap apart by the time a loud one reaches its full
// length. A wedge's width is a constant fraction of the circle at every
// radius, so it keeps touching its neighbour the whole way out regardless of
// how long it grows - which is exactly what "no gap" now has to mean at
// every bar length, not just at rest.
var RAY_HALF_ANGLE = Math.PI / BAR_COUNT;

/**
 * Maps a bar's position (0..BAR_COUNT-1, bar 0 at the top - see paint()'s
 * `angle`) to an index into the UNIQUE_BARS-length array barLevels()
 * returns, so the low-to-high frequency sweep mirrors left/right around a
 * true vertical axis instead of a rotated one.
 *
 * Confirmed live in real Anki: the previous version of this,
 * `i < UNIQUE_BARS ? i : BAR_COUNT - 1 - i`, looks like a mirror but pairs
 * index i with BAR_COUNT-1-i, which is symmetric about the midpoint
 * (BAR_COUNT-1)/2 = 13.5 - half a bar's width short of the real axis
 * through bar 0 (top) and bar BAR_COUNT/2 (bottom). The whole figure still
 * came out as a mirror, just of itself rotated by half of RAY_HALF_ANGLE's
 * own pitch, which reads as "slightly rotated" rather than as broken
 * symmetry, and is easy to miss on a short, quiet frame where it is only a
 * few degrees. Pairing i with BAR_COUNT-i (not BAR_COUNT-1-i) instead is
 * symmetric about exactly 0 and BAR_COUNT/2, which is where the top and
 * bottom bars actually sit; clamping to UNIQUE_BARS-1 is what lets the
 * bottom bar (index BAR_COUNT/2, which has no distinct sample of its own -
 * there are only UNIQUE_BARS unique values for BAR_COUNT/2+1 axis
 * positions) fall back to sharing the highest-frequency sample with its two
 * neighbours rather than reading undefined past the end of the array.
 */
function mirroredBarIndex(i) {
  return Math.min(i, BAR_COUNT - i, UNIQUE_BARS - 1);
}

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
  // The colour the last real draw() call used, so stop() can leave the ring
  // in that colour instead of clearing it - see the file header comment for
  // why this is deliberately not --amgi-color-neutral. Stays null until a
  // genuine source has engaged the canvas at least once.
  var lastColor = null;

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
    // Once a real source has genuinely drawn here, leave the ring on screen
    // in that source's own colour rather than clearing it - see the file
    // header comment for why this is a deliberate choice, not a fallback.
    // Before that has ever happened, size.width/height come back 0 (the
    // canvas is still at its untouched default), so this falls through to
    // the plain clear below exactly as it always has.
    if (lastColor && size.width && size.height) {
      paint(size, lastColor, 0, null);
      return;
    }
    ctx.clearRect(0, 0, size.width || canvas.width, size.height || canvas.height);
  }

  /**
   * One frame's worth of time-domain RMS, 0..1. Works the same whether
   * `analyser` is the mic's own (voiceActivity.js, fftSize 1024) or a clip's
   * (attachVisualizerSource below, fftSize 1024 to match) - the caller never
   * needs to know which. Drives the bars' shared opacity (paint()'s
   * `alpha`) - the fixed circle never reads this at all, on purpose, see
   * paint()'s own comment.
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
    // answer swings the visualizer's opacity noticeably without pinning it to
    // full strength on every syllable.
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

  function paint(size, color, level, bars) {
    var cx = size.width / 2;
    var cy = size.height / 2;
    // Kept well under half the canvas even with every bar fully extended so
    // nothing clips against .amgi-visual's own bounds - see _amgi-loop.css.
    var base = Math.min(size.width, size.height) * 0.2;

    ctx.clearRect(0, 0, size.width, size.height);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';

    // The anchor: a hollow, fixed circle - stroked, never filled, and never
    // touched by `level` or `bars`. Every earlier shape this visualizer had
    // (see the file header) reacted to audio in some way, right down to a
    // breathing idle wobble meant to keep a silent card from looking dead;
    // this one doesn't react at all, on purpose - it is what keeps the card
    // from looking dead now, simply by always being there, so the bars
    // outside it are free to fall to nothing in real silence (see `outerR`
    // below) without the whole visualizer vanishing. Its own opacity still
    // respects --amgi-visualizer-opacity (the one thing every shape here has
    // always respected), just not `level` - a fixed anchor should not
    // flicker with loudness.
    var circleR = base;
    var circleLineWidth = 2;
    // 0.85, not the bars' own up-to-1.0 peak: close enough that the ring
    // reads as the same saturated hue the bars flare up to (see the file
    // header comment - this used to sit at 0.6, which read as a washed-out
    // relative of the bar colour rather than the same one), while staying
    // just under the bars' own ceiling so a loud bar still visibly outranks
    // the anchor it grows from. Still a flat constant, not driven by
    // `level`: the ring is not supposed to flicker with loudness.
    var ringAlpha = 0.85;
    ctx.globalAlpha = ringAlpha * opacityScale;
    ctx.lineWidth = circleLineWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
    ctx.stroke();

    // Confirmed live in real Anki: bars whose inner edge sat exactly on
    // circleR - the stroke's own centreline - visually ate the outer half
    // of the ring's stroke width, so a loud bar looked like it grew out of
    // partway through the ring rather than starting cleanly at its edge.
    // Anchoring bars here instead, at the ring's own OUTER edge, means the
    // full stroke stays visible underneath every bar and the join reads as
    // "the bar continues where the ring ends", not "the bar overlaps the
    // ring".
    var barBaseR = circleR + circleLineWidth / 2;

    // The bars: still driven by `level` for their shared opacity (the one
    // signal that has survived every shape change here - see levelNow's
    // comment) - but now that nothing converges on a centre, a quiet room
    // can just show the plain circle above with no bars at all, rather than
    // needing a resting length or a breathing wobble to avoid looking dead.
    // That is a deliberate simplification, not an oversight: the fixed
    // circle is now the "still alive" signal, so the bars are free to mean
    // only one thing - real magnitude - with nothing cosmetic layered on top
    // of them to fake activity that is not there.
    var alpha = Math.max(0, Math.min(1, (0.35 + level * 0.65) * opacityScale));
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (var i = 0; i < BAR_COUNT; i++) {
      var mag = bars ? bars[mirroredBarIndex(i)] : 0;
      var angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
      // Bars are wedges (RAY_HALF_ANGLE is a constant fraction of the
      // circle, not a constant pixel width) so two neighbours keep touching
      // the whole way out even when one is at rest (outerR === barBaseR,
      // zero-length) and the other is at full volume - see RAY_HALF_ANGLE's
      // own comment for why a constant-width bar could not promise that.
      var outerR = barBaseR + mag * base * 1.3;
      var leftA = angle - RAY_HALF_ANGLE;
      var rightA = angle + RAY_HALF_ANGLE;
      var lx = cx + Math.cos(leftA) * barBaseR;
      var ly = cy + Math.sin(leftA) * barBaseR;
      // One path for all 28 bars, not 28 separate beginPath()/fill() calls -
      // see RAY_HALF_ANGLE's comment for why: two independently-rasterized
      // shapes can leave a hairline antialiasing seam even where their edges
      // sit on the exact same mathematical line, and no amount of angular
      // overlap fixed that live. i===0's moveTo starts the path; every later
      // bar's own left-inner corner coincides with the previous bar's
      // right-inner corner (both sit at (rightA of i-1) === (leftA of i), on
      // barBaseR itself), so lineTo-ing there instead of moveTo-ing keeps
      // the whole ring of bars as one unbroken outline. No vertex in this
      // whole loop is ever at a radius smaller than barBaseR - every corner
      // is either exactly barBaseR or further out - so nothing this path
      // touches can reach inside the circle, by construction, not by
      // clipping after the fact.
      if (i === 0) {
        ctx.moveTo(lx, ly);
      } else {
        ctx.lineTo(lx, ly);
      }
      ctx.lineTo(cx + Math.cos(leftA) * outerR, cy + Math.sin(leftA) * outerR);
      ctx.lineTo(cx + Math.cos(rightA) * outerR, cy + Math.sin(rightA) * outerR);
      ctx.lineTo(cx + Math.cos(rightA) * barBaseR, cy + Math.sin(rightA) * barBaseR);
    }
    ctx.closePath();
    // Confirmed live in real Anki: without this second subpath, the loop
    // above still fills the circle's *interior* solid, even though no
    // vertex in it is ever closer than barBaseR to the centre. The reason is
    // winding, not geometry: at rest, every bar's outerR collapses to
    // barBaseR, so the whole path degenerates to one simple loop running
    // once around that radius - and canvas's fill rule treats any simple
    // closed loop as enclosing everything inside it, all the way to the
    // centre, the same way a plain circle() path fills as a disc rather
    // than a ring. The petals don't change that when magnitude is nonzero
    // either, since the path is still one simple (non-self-crossing) loop,
    // just a lumpier one. A single path can only have a hole where two
    // loops overlap with opposite winding and cancel out, so this traces
    // barBaseR a second time, deliberately the opposite direction
    // (anticlockwise=true here, against the outer loop's increasing-angle
    // direction), purely to cut that hole - it draws nothing on its own,
    // it only removes. That is what makes the circle's interior provably
    // empty at every magnitude, including silence, rather than empty by
    // coincidence of the petal shapes never quite reaching the centre.
    ctx.moveTo(cx + barBaseR, cy);
    ctx.arc(cx, cy, barBaseR, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fill();
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
    // Recorded so stop() can leave the ring in this colour instead of
    // clearing it once this source ends - see the file header comment.
    lastColor = color;

    if (reducedMotionPreferred()) {
      // A static circle instead of nothing: reduced motion should mean no
      // animation, not no indicator that a microphone is open or a clip is
      // playing. Bars stay at zero length (mag 0 - see paint's
      // `bars ? ... : 0`), not driven by real audio, so this is a single
      // still frame, not motion with the animation loop removed - and since
      // the circle itself never animates even outside reduced motion, this
      // still frame is not a degraded version of the normal one, it is
      // almost the whole normal one.
      var still = sizeFor();
      if (still.width && still.height) paint(still, color, 0.12, null);
      return;
    }

    var level = 0;
    barState = new Array(UNIQUE_BARS).fill(0);

    function frame() {
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
      // Fast attack, slow release: the visualizer's opacity should jump to a
      // loud syllable at once but ease back down between words, not flicker
      // on every dip.
      level += (raw - level) * (raw > level ? 0.6 : 0.15);

      var rawBars = barLevels(analyser);
      if (rawBars) {
        for (var i = 0; i < UNIQUE_BARS; i++) {
          var b = rawBars[i];
          barState[i] += (b - barState[i]) * (b > barState[i] ? 0.6 : 0.2);
        }
      }

      paint(size, color, level, barState);
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
    // Matches voiceActivity.js's own analyser so the visualizer reads the
    // same way whether it is fed by the microphone or by a clip.
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

})();
