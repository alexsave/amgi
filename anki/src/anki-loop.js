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
function stopCurrentPlayback(except) {
  if (!store.playing || store.playing === except) return;
  try {
    store.playing.pause();
    store.playing.currentTime = 0;
  } catch (error) {
    // A source torn down with its context; nothing left to stop.
  }
}

function playClip(element, ui, kind) {
  return new Promise(function (resolve) {
    if (!element) return resolve('missing');

    // Fire-and-forget: it manages its own start and its own end (the
    // element's own events), so playClip never needs to hold or await it.
    //
    // It registers as the card's current playback for the same reason the
    // replay buttons do: the answer's own audio starts by itself on reveal,
    // and pressing a replay while it is still going would otherwise leave
    // two voices talking over each other with the visualizer following only
    // one of them. Whichever of the two starts last wins.
    stopCurrentPlayback(element);
    store.playing = element;
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

// The ring this replaced (see git history) drew 28 wedge bars around a fixed
// hollow circle in the middle of the card. It was dropped for a reason that
// has nothing to do with how it looked on its own: a shape in the centre of
// the card is competing with the sentence for the same space, and every
// version of it ended up either behind the text or crowding it. The owner
// settled the question by picking a treatment that lives in a band of its
// own at the foot of the card, where it cannot collide with a word no matter
// how loud the room gets - and the band is RESERVED in the layout
// (_amgi-loop.css gives .amgi a padding-bottom the size of .amgi-visual),
// not clipped after the fact, so "never overlaps the text" is a property of
// the box model here rather than something this file has to keep proving.
//
// The shape itself is "ridge fine", chosen from a set of about forty over
// several rounds: a bar per frequency band, drawn touching with no gutter,
// so the
// body reads as one silhouette rather than as a count of bars, with a cap
// per band that jumps to that band's loudest moment and falls back on its
// own. Two things about it were settled by measurement rather than taste and
// should not be quietly changed back:
//
//   1. Log-spaced frequencies, as before. This is the one property the old
//      ring had that was worth keeping: speech energy dies off fast above a
//      couple of kHz, so a linear sweep spends most of its bars above where
//      a voice has anything left to show and piles every syllable into the
//      left edge.
//   2. MAX_HZ is 6000, not the ring's 4000. Checked against a real generated
//      clip (a 1024-point transform of amgi's own gpt-4o-mini-tts output,
//      binned exactly this way): Korean and English consonant bursts put
//      real, visible energy between 4 and 6kHz, and cutting at 4000 threw
//      away the part of the signal that makes the ridge move in time with
//      the syllables rather than just swell on the vowels.
//   3. The band COUNT is derived from the card's width, not fixed. The
//      mockup this was chosen from was 900 CSS px wide with 72 bands, so a
//      band was 12.5px, and that width is what "fine" meant - it is the
//      thing being looked at. Shipping the count instead of the width made
//      the shape a function of the window: on a 2000px card the same 72
//      bands are 28px each, four times the intended width and half the
//      intended height, and the ridge flattens into a slab with no visible
//      striping. Holding the band width fixed and letting the count follow
//      keeps the card looking the same on a laptop and on a large monitor.
var BAND_PX = 12.5;
// Floors and ceilings for absurd widths, not tuning knobs: below about
// forty bands there is not enough of a spectrum left to read, and above two
// hundred and forty the bands are narrower than the seams between them.
var MIN_BANDS = 40;
var MAX_BANDS = 240;
var MIN_HZ = 90; // just above a typical adult voice's fundamental
var MAX_HZ = 6000; // the top of the consonant energy that gives the ridge its timing

/** How many bands fit across a canvas this wide, at the intended band width. */
function bandsFor(width) {
  return Math.max(MIN_BANDS, Math.min(MAX_BANDS, Math.round(width / BAND_PX) || MIN_BANDS));
}

// How much of its full height a cap sheds each frame. The owner chose this
// speed ("fast") against a synthetic test signal and then confirmed it
// against two real clips, which is worth recording because the two signals
// disagree: a smooth synthetic swell never separates the cap from the body,
// while real speech collapses the body to the floor between words and leaves
// the cap visibly hanging above nothing for a moment. That gap is the
// intended behaviour at this speed, not a bug to tune away - it is what
// makes a pause in the sentence legible. At 60fps this empties a full-height
// cap in about half a second.
var CAP_FALL = 0.032;

// The cap's own thickness, and the height the body keeps when a band is
// completely silent, both in CSS pixels. The baseline is what stops the card
// looking dead in a quiet room - the old ring's fixed circle did that job,
// and something has to, or a silent card has nothing on it at all.
var CAP_THICKNESS = 1.5;
var BASELINE_HEIGHT = 2;


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
  var peakState = null;
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
    // Once a real source has genuinely drawn here, leave the resting
    // baseline on screen in that source's own colour rather than clearing it
    // - see the file header comment for why this is a deliberate choice, not
    // a fallback.
    // Before that has ever happened, size.width/height come back 0 (the
    // canvas is still at its untouched default), so this falls through to
    // the plain clear below exactly as it always has.
    if (lastColor && size.width && size.height) {
      paint(size, lastColor, 0, null, null);
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
   * `count` magnitudes (0..1), one per log-spaced frequency between MIN_HZ
   * and MAX_HZ, read off the same analyser levelNow uses. Log spacing (not
   * linear) is what keeps a voice spread across the whole strip: speech
   * energy falls off fast above a couple of kHz, so a linear sweep from 0Hz
   * to the Nyquist frequency spends almost every band above where a voice
   * has anything left to show, and the ridge becomes one lump against the
   * left edge.
   *
   * Unlike the ring this replaced, nothing is mirrored: the ridge is a plain
   * low-to-high sweep from left to right. The mirror existed only so a
   * circle would come out symmetric rather than one-sided, and a strip has
   * no such problem to solve - it just costs half the resolution to do it.
   */
  function barLevels(analyser, count) {
    var bins = analyser.frequencyBinCount;
    if (!freqBuffer || freqBuffer.length !== bins) freqBuffer = new Uint8Array(bins);
    try {
      analyser.getByteFrequencyData(freqBuffer);
    } catch (error) {
      return null;
    }
    var sampleRate = (analyser.context && analyser.context.sampleRate) || 48000;
    var hzPerBin = sampleRate / analyser.fftSize;
    var levels = new Array(count);
    for (var k = 0; k < count; k++) {
      var lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, k / count);
      var hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (k + 1) / count);
      levels[k] = spectrumBetween(bins, lo / hzPerBin, hi / hzPerBin) / 255;
    }
    return levels;
  }

  /**
   * The spectrum's average value between two bin positions, which are
   * fractional on purpose.
   *
   * Rounding each band to whole bins is what produced the stair-steps this
   * replaced. Log spacing makes the low bands much narrower than the high
   * ones - at the bottom of the range a band can be a few Hz wide against a
   * bin tens of Hz wide - so several neighbouring bands rounded to the SAME
   * single bin and drew the identical height. The result was a run of wide
   * flat plateaus across the loud left-hand half of the strip, exactly where
   * a voice has the most to show, and it got worse the more bands there
   * were: a finer strip is a strictly worse picture if the extra bands are
   * copies.
   *
   * Reading the spectrum as a piecewise-linear curve and integrating it
   * across the band's real edges removes that entirely. Two bands narrower
   * than one bin still differ, because they sample that bin's slope at
   * different places, so the strip ramps where the spectrum ramps instead of
   * stepping where the arithmetic happened to round.
   */
  function spectrumBetween(bins, from, to) {
    var lo = Math.max(0, Math.min(bins - 1, from));
    var hi = Math.max(lo, Math.min(bins - 1, to));
    // A band wider than a bin is sampled once per bin it covers, a narrower
    // one at both its edges - enough either way, since the curve being
    // integrated is itself only linear between bins.
    var steps = Math.max(2, Math.ceil(hi - lo) + 1);
    var sum = 0;
    for (var i = 0; i < steps; i++) {
      sum += binAt(bins, lo + ((hi - lo) * i) / (steps - 1));
    }
    return sum / steps;
  }

  /** The spectrum at a fractional bin position, interpolated between its neighbours. */
  function binAt(bins, position) {
    var floor = Math.floor(position);
    var next = Math.min(bins - 1, floor + 1);
    var fraction = position - floor;
    return freqBuffer[floor] * (1 - fraction) + freqBuffer[next] * fraction;
  }

  /**
   * One frame of the ridge, across the whole canvas.
   *
   * `bars` are this frame's band magnitudes and `peaks` the falling caps;
   * either may be null, which draws the resting state - a baseline rule the
   * width of the card in the source's own colour. That resting state is
   * load-bearing: it is what stop() leaves behind and what a silent room
   * shows, and it replaces the job the old ring's fixed circle did.
   *
   * `level` drives the body's opacity only. The caps are drawn at a flat
   * alpha on purpose: they are the part that has to stay legible when the
   * body has collapsed, which is exactly when `level` is near zero.
   */
  function paint(size, color, level, bars, peaks) {
    // The count comes from the data when there is data, and from the width
    // when there is not (the resting baseline), so paint never has to be
    // told separately what the rest of the frame already knows.
    var count = bars ? bars.length : bandsFor(size.width);
    var cell = size.width / count;
    var room = size.height;
    var floor = size.height;

    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = color;

    // The body, one fillRect per band, each at its own band's alpha.
    //
    // Per-bar alpha is the point of the whole drawing: a band carrying real
    // energy is brighter than a band that is nearly silent, so the strip
    // carries volume twice over, in height and in weight. This was briefly a
    // single path filled once, to kill the lighter line where two bars
    // overlapped - which threw away the per-band alpha as collateral and lit
    // the whole strip uniformly no matter which part of the spectrum was
    // actually loud.
    var heights = [];
    var alphas = [];
    for (var i = 0; i < count; i++) {
      var mag = bars ? bars[i] : 0;
      heights.push(BASELINE_HEIGHT + mag * (room - BASELINE_HEIGHT));
      alphas.push(Math.max(0, Math.min(1, (0.14 + 0.52 * mag) * opacityScale * (0.55 + 0.45 * level))));
      ctx.globalAlpha = alphas[i];
      ctx.fillRect(i * cell, floor - heights[i], cell, heights[i]);
    }

    // The seam between one band and the next, drawn on purpose rather than
    // left to happen.
    //
    // Those lines are what makes the strip read as seventy-two separate
    // measurements instead of one shape, so they are too important to be an
    // antialiasing side effect of bars overlapping by half a pixel - that
    // only shows up at all at certain widths and pixel ratios, and its
    // strength is whatever the compositor happens to produce.
    //
    // A seam stops at the SHORTER of the two bars it divides. Run to the
    // taller one instead and every seam beside a tall neighbour sticks up
    // into empty space, and the strip grows a row of comb teeth along its
    // skyline.
    for (var j = 1; j < count; j++) {
      var shared = Math.min(heights[j - 1], heights[j]);
      ctx.globalAlpha = Math.max(0, Math.min(1, Math.max(alphas[j - 1], alphas[j]) * 1.9));
      ctx.fillRect(j * cell - 0.5, floor - shared, 1, shared);
    }

    // The caps: one per band, drawn half a pixel wider on each side than the
    // bar they sit on, so a cap reads as a lid across its band rather than
    // as a slightly narrower line floating on it. Flat alpha, unlike the
    // body - a cap has to stay legible exactly when its band has gone quiet,
    // which is when a level-driven alpha would fade it out.
    ctx.globalAlpha = Math.max(0, Math.min(1, 0.9 * opacityScale));
    for (var k = 0; k < count; k++) {
      var peak = peaks ? peaks[k] : 0;
      var capY = floor - CAP_THICKNESS - peak * (room - BASELINE_HEIGHT);
      ctx.fillRect(k * cell - 0.5, capY, cell + 1, CAP_THICKNESS);
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
    // Recorded so stop() can leave the baseline in this colour instead of
    // clearing it once this source ends - see the file header comment.
    lastColor = color;

    if (reducedMotionPreferred()) {
      // The resting baseline instead of nothing: reduced motion should mean
      // no animation, not no indicator that a microphone is open or a clip
      // is playing. Bars and caps stay at rest (paint's `bars ? ... : 0`),
      // so this is a single still frame rather than motion with the loop
      // taken out - and since the baseline is the same thing a silent room
      // shows anyway, this still frame is not a degraded version of the
      // normal one, it is one real state of it.
      var still = sizeFor();
      if (still.width && still.height) paint(still, color, 0.12, null, null);
      return;
    }

    var level = 0;
    barState = null;
    peakState = null;

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

      // Recomputed every frame rather than once, because the card is
      // resizable: Anki's window can be dragged wider mid-review, and a
      // strip that kept the old count would either stretch its bands or
      // leave a gap at the edge. A change in count restarts the smoothing
      // from silence, which is correct - the old values described bands
      // that no longer exist.
      var count = bandsFor(size.width);
      if (!barState || barState.length !== count) {
        barState = new Array(count).fill(0);
        peakState = new Array(count).fill(0);
      }

      var rawBars = barLevels(analyser, count);
      if (rawBars) {
        for (var i = 0; i < count; i++) {
          var b = rawBars[i];
          // The body is smoothed both ways; the cap is not smoothed at all
          // on the way up. A cap exists to record the loudest instant the
          // band actually reached, so easing it upward would make it record
          // something quieter than what happened, which is the one thing it
          // is for. Downward it ignores the body's release entirely and
          // sheds CAP_FALL a frame - see CAP_FALL for why that speed.
          barState[i] += (b - barState[i]) * (b > barState[i] ? 0.6 : 0.2);
          peakState[i] = Math.max(barState[i], peakState[i] - CAP_FALL);
        }
      }

      paint(size, color, level, barState, peakState);
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  return { draw: draw, stop: stop };
}

/**
 * The decibel window getByteFrequencyData maps onto 0..255.
 *
 * The defaults are -100 to -30, and -30 is far too low a ceiling for this.
 * amgi's own clips come back from the synthesiser normalised loud, so a
 * vowel's low harmonics sit above -30dB and every one of them reports 255 -
 * the bars pin to the top of the strip and stay there for the whole voiced
 * part of the syllable. That is what turned the ridge into a slab with a
 * flat roof across its loud half: not a drawing problem, a measurement that
 * had run out of headroom before it was ever drawn.
 *
 * -90 to -10 puts ordinary speech in the middle of the range with room above
 * it, so a loud syllable has somewhere to go and the shape of the spectrum
 * survives all the way up.
 */
function tuneRange(analyser) {
  try {
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
  } catch (error) {
    // A client that refuses the range keeps the defaults; a slightly
    // clipped visualizer is not worth failing a review over.
  }
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
    //
    // 2048 rather than 1024: at 48kHz a 1024-point transform is 47Hz per
    // bin, and the whole 90Hz-6kHz range the strip draws fits in about 126
    // of them. Interpolation keeps that from stepping, but it cannot invent
    // detail that was never measured, and the bottom of the range - where a
    // voice does most of its work - had the least. Doubling it halves the
    // hertz per bin without pushing the analysis window (43ms at this size)
    // past the length of the consonant bursts that give the ridge its
    // timing; 4096 would, which is why it is not that.
    analyser.fftSize = 2048;
    tuneRange(analyser);
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
      if (stop.analyser && store.visualizer) {
        // The mic's analyser belongs to detectSpeechEnd, which reads it in
        // the time domain and does not care what window the frequency data
        // is mapped onto. The visualizer does, and it is the only thing here
        // that does, so it sets the window on the way past rather than
        // pushing a display concern down into speech detection.
        tuneRange(stop.analyser);
        store.visualizer.draw(stop.analyser, 'you');
      }
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

function bootBack(root, harvested) {
  var ui = makeUi(root);
  store.visualizer = createVisualizer(root);
  var native = resolveAudio(attr(root, 'data-amgi-target-audio'));
  var cueAudio = resolveAudio(attr(root, 'data-amgi-cue-audio'));

  wireReplay(root, 'replay-cue', cueAudio, 'cue');
  wireReplay(root, 'replay-native', native, 'native');
  wireYou(root);

  // A take still being collected when this side rendered (see boot()) lands
  // after wireYou has already decided there was nothing to offer, so the
  // button is wired a second time once it arrives. Re-running wireYou rather
  // than reaching into the DOM here keeps one place deciding what the button
  // does and whether it is shown at all.
  if (harvested && typeof harvested.then === 'function') {
    harvested.then(function (blob) {
      if (!blob || !blob.size || !root.isConnected) return;
      rememberRecording(blob);
      wireYou(root);
    });
  }

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
  // No replay keys, and this is a finding rather than an omission.
  //
  // R, A and V were bound here and none of them ever fired in real Anki.
  // aqt/reviewer.py registers r (replay audio) and v (replay recorded voice)
  // through mw.setStateShortcuts(), which makes them Qt shortcuts on the MAIN
  // WINDOW, and a reaches the main window's Add action the same way. Qt
  // resolves those before the key is offered to the webview at all, so no
  // amount of preventDefault in here can win: the page is never asked.
  //
  // Moving them to other letters was rejected on purpose. Every unclaimed
  // letter is one an add-on or a future Anki version may claim, and a card
  // that quietly takes a key someone has relied on for years is a worse bug
  // than a card with no shortcuts.
  //
  // There IS a supported way, and it is not here: gui_hooks
  // .state_shortcuts_will_change hands an add-on the reviewer's own shortcut
  // list to edit, so amgi_mic could wrap r and v to keep their existing
  // meanings on every other card and additionally drive this one - Anki's own
  // r does nothing on an amgi card anyway, because it acts on the [sound:]
  // tags this note type deliberately does not use. See anki/README.md.

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

/**
 * Play one clip and stop whatever else this card was playing.
 *
 * Three replay buttons that all start playback without stopping each other
 * produce two voices at once, which is both unintelligible and confusing
 * about which button did what - and the visualizer, which follows one source
 * at a time, ends up drawing one clip while you hear two.
 *
 * Pressing the button of the clip already playing restarts it from the
 * beginning, which is what "hear it again" means when you have stopped
 * listening halfway through.
 */
function playExclusively(element, kind) {
  stopCurrentPlayback(element);
  store.playing = element;
  try {
    element.currentTime = 0;
  } catch (error) {
    // See playClip: seeking before metadata is allowed to fail.
  }
  beginVisualizing(element, kind);
  var played = element.play();
  if (played && typeof played.catch === 'function') played.catch(function () {});
}

function wireReplay(root, name, element, kind) {
  var button = action(root, name);
  if (!button) return;
  if (!element) return show(button, false);
  button.addEventListener('click', function () {
    playExclusively(element, kind);
  });
}

function wireYou(root) {
  var button = action(root, 'replay-you');
  if (!button) return;

  // Callable more than once for the same render, and it has to be: a take
  // collected after this side rendered (see boot()) arrives once the button
  // has already been told there is nothing to play. Any handler from an
  // earlier call goes first, so a second call replaces the recording this
  // button reaches rather than stacking another one behind it - two
  // listeners would play the new take over a revoked URL from the old one.
  if (button.__amgiPlay) {
    button.removeEventListener('click', button.__amgiPlay);
    button.__amgiPlay = null;
  }

  // The recording only exists on clients that keep one document across the
  // reveal. Elsewhere the button simply is not offered.
  if (!store.recordingUrl) return show(button, false);
  show(button, true);
  var element = new Audio(store.recordingUrl);
  button.__amgiPlay = function () {
    // The learner's own voice, same colour whether it is live on the mic
    // (bootFront) or replayed here.
    playExclusively(element, 'you');
  };
  button.addEventListener('click', button.__amgiPlay);
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
  // A microphone still open when this side renders means the turn never
  // ended through the loop - which on desktop Anki is the ordinary case, not
  // an edge one. Space is bound twice at once there (this card's own handler
  // and Anki's native QShortcut on the main window, see bootBack) and which
  // wins varies from keypress to keypress. When Anki's wins, it reveals the
  // answer directly: endTurn never runs, closeMic never runs, and this is
  // where the microphone actually gets shut off.
  //
  // So the recording has to be collected HERE too, not only on the path
  // through the loop. stopMicrophone() already resolves with everything
  // captured up to the moment it stopped; this used to throw that promise
  // away, which is exactly how pressing space mid-sentence lost the take and
  // left the answer side with no "Hear yourself" button at all. What the
  // learner said is not less worth replaying because Anki's shortcut got to
  // the keypress first.
  var harvested = store.stream ? stopMicrophone() : null;
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
    if (root.getAttribute('data-amgi-side') === 'back') bootBack(root, harvested);
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
