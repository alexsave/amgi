import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { detectSpeechEnd, SPEECH_END_DEFAULTS } from '../../utils/voiceActivity';

// A stand-in for the Web Audio graph. `getFloatTimeDomainData` fills the whole
// buffer with one value, so the RMS the detector computes is exactly that
// value and a test can dial the room's loudness directly.
const fakeAudio = (initialLevel = 0) => {
  let level = initialLevel;

  const analyser = {
    fftSize: 1024,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData: (samples) => samples.fill(level),
    disconnect: mock.fn()
  };

  const source = { connect: mock.fn(), disconnect: mock.fn() };

  return {
    audioContext: {
      createMediaStreamSource: mock.fn(() => source),
      createAnalyser: mock.fn(() => analyser)
    },
    stream: { id: 'fake-stream' },
    analyser,
    source,
    setLevel: (next) => {
      level = next;
    }
  };
};

// jest's advanceTimersByTime ran each timer at its own time; node:test's tick runs what is due and
// moves the clock to the end at once. One millisecond at a time is the clock the detector expects.
const advance = (ms) => {
  for (let t = 0; t < ms; t += 1) mock.timers.tick(1);
};

const QUIET = 0.001;
const LOUD = 0.3;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  mock.timers.setTime(new Date('2024-01-01T12:00:00Z').getTime());
});

afterEach(() => {
  mock.timers.reset();
});

describe('detectSpeechEnd', () => {
  test('speech followed by silence ends the turn with "speech"', () => {
    const onEnd = mock.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    // Quiet room through calibration
    advance(SPEECH_END_DEFAULTS.calibrationMs);
    assert.equal((onEnd).mock.callCount(), 0);

    // Speaking: has to hold above the threshold past the onset window
    mic.setLevel(LOUD);
    advance(SPEECH_END_DEFAULTS.speechOnsetMs + SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 0);

    // Going quiet only counts once the silence window has fully elapsed
    mic.setLevel(QUIET);
    advance(SPEECH_END_DEFAULTS.silenceMs - SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 0);

    advance(2 * SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 1);
    assert.ok((onEnd).mock.calls.some((call) => isDeepStrictEqual(call.arguments, ['speech'])));
  });

  test('a silent room ends with "no-speech" once the timeout expires', () => {
    const onEnd = mock.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    advance(SPEECH_END_DEFAULTS.noSpeechTimeoutMs - SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 0);

    advance(2 * SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 1);
    assert.ok((onEnd).mock.calls.some((call) => isDeepStrictEqual(call.arguments, ['no-speech'])));
  });

  test('speech that never stops ends with "max-duration"', () => {
    const onEnd = mock.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    advance(SPEECH_END_DEFAULTS.calibrationMs);
    mic.setLevel(LOUD);

    // Well past noSpeechTimeoutMs, so this also pins down that a talker is not
    // cut off by the silent-room timeout
    advance(SPEECH_END_DEFAULTS.maxUtteranceMs - SPEECH_END_DEFAULTS.calibrationMs - SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 0);

    advance(2 * SPEECH_END_DEFAULTS.pollMs);
    assert.equal((onEnd).mock.callCount(), 1);
    assert.ok((onEnd).mock.calls.some((call) => isDeepStrictEqual(call.arguments, ['max-duration'])));
  });

  test('an answer that starts during calibration is still heard', () => {
    const onEnd = mock.fn();
    // Loud from the very first sample: the reviewer answered instantly, so
    // calibration only ever sees their voice. The threshold cap is what keeps
    // that voice from becoming the noise floor and swallowing the answer.
    const mic = fakeAudio(LOUD);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    advance(
      SPEECH_END_DEFAULTS.calibrationMs + SPEECH_END_DEFAULTS.speechOnsetMs + SPEECH_END_DEFAULTS.pollMs
    );
    assert.equal((onEnd).mock.callCount(), 0);

    mic.setLevel(QUIET);
    advance(SPEECH_END_DEFAULTS.silenceMs + SPEECH_END_DEFAULTS.pollMs);

    // Not 'no-speech': the loud opening was recognised as an answer
    assert.equal((onEnd).mock.callCount(), 1);
    assert.ok((onEnd).mock.calls.some((call) => isDeepStrictEqual(call.arguments, ['speech'])));
  });

  test('stopping tears down the analyser and suppresses the callback', () => {
    const onEnd = mock.fn();
    const mic = fakeAudio(QUIET);

    const stop = detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    stop();
    stop(); // Safe to call twice

    assert.notEqual((mic.source.disconnect).mock.callCount(), 0);
    assert.notEqual((mic.analyser.disconnect).mock.callCount(), 0);

    advance(2 * SPEECH_END_DEFAULTS.maxUtteranceMs);
    assert.equal((onEnd).mock.callCount(), 0);
  });

  test('without a stream it falls back to the no-speech timeout', () => {
    const onEnd = mock.fn();

    detectSpeechEnd({ audioContext: null, stream: null, onEnd });

    advance(SPEECH_END_DEFAULTS.noSpeechTimeoutMs - 1);
    assert.equal((onEnd).mock.callCount(), 0);

    advance(1);
    assert.ok((onEnd).mock.calls.some((call) => isDeepStrictEqual(call.arguments, ['no-speech'])));
  });
});
