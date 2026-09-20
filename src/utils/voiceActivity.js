// Voice activity detection for the review loop.
//
// The reviewer speaks their answer without pressing anything, so the app has
// to decide when they are done. We watch the microphone's short-term loudness:
// calibrate the room's noise floor, wait for speech to rise above it, then end
// the turn once the level stays down for a beat. Everything is bounded by
// timeouts so a silent or noisy room still moves the session along.

export const SPEECH_END_DEFAULTS = {
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
export function detectSpeechEnd({ audioContext, stream, onEnd, options = {} }) {
  const opts = { ...SPEECH_END_DEFAULTS, ...options };

  if (!audioContext || !stream) {
    // Without a live stream we can't hear anything; fall back to the
    // no-speech timeout so the caller still gets an answer.
    const timer = setTimeout(() => onEnd('no-speech'), opts.noSpeechTimeoutMs);
    return () => clearTimeout(timer);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
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
