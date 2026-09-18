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
    disconnect: jest.fn()
  };

  const source = { connect: jest.fn(), disconnect: jest.fn() };

  return {
    audioContext: {
      createMediaStreamSource: jest.fn(() => source),
      createAnalyser: jest.fn(() => analyser)
    },
    stream: { id: 'fake-stream' },
    analyser,
    source,
    setLevel: (next) => {
      level = next;
    }
  };
};

const QUIET = 0.001;
const LOUD = 0.3;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('detectSpeechEnd', () => {
  test('speech followed by silence ends the turn with "speech"', () => {
    const onEnd = jest.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    // Quiet room through calibration
    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.calibrationMs);
    expect(onEnd).not.toHaveBeenCalled();

    // Speaking: has to hold above the threshold past the onset window
    mic.setLevel(LOUD);
    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.speechOnsetMs + SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).not.toHaveBeenCalled();

    // Going quiet only counts once the silence window has fully elapsed
    mic.setLevel(QUIET);
    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.silenceMs - SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2 * SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('speech');
  });

  test('a silent room ends with "no-speech" once the timeout expires', () => {
    const onEnd = jest.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.noSpeechTimeoutMs - SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2 * SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('no-speech');
  });

  test('speech that never stops ends with "max-duration"', () => {
    const onEnd = jest.fn();
    const mic = fakeAudio(QUIET);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.calibrationMs);
    mic.setLevel(LOUD);

    // Well past noSpeechTimeoutMs, so this also pins down that a talker is not
    // cut off by the silent-room timeout
    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.maxUtteranceMs - SPEECH_END_DEFAULTS.calibrationMs - SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2 * SPEECH_END_DEFAULTS.pollMs);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('max-duration');
  });

  test('an answer that starts during calibration is still heard', () => {
    const onEnd = jest.fn();
    // Loud from the very first sample: the reviewer answered instantly, so
    // calibration only ever sees their voice. The threshold cap is what keeps
    // that voice from becoming the noise floor and swallowing the answer.
    const mic = fakeAudio(LOUD);

    detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    jest.advanceTimersByTime(
      SPEECH_END_DEFAULTS.calibrationMs + SPEECH_END_DEFAULTS.speechOnsetMs + SPEECH_END_DEFAULTS.pollMs
    );
    expect(onEnd).not.toHaveBeenCalled();

    mic.setLevel(QUIET);
    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.silenceMs + SPEECH_END_DEFAULTS.pollMs);

    // Not 'no-speech': the loud opening was recognised as an answer
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('speech');
  });

  test('stopping tears down the analyser and suppresses the callback', () => {
    const onEnd = jest.fn();
    const mic = fakeAudio(QUIET);

    const stop = detectSpeechEnd({ audioContext: mic.audioContext, stream: mic.stream, onEnd });

    stop();
    stop(); // Safe to call twice

    expect(mic.source.disconnect).toHaveBeenCalled();
    expect(mic.analyser.disconnect).toHaveBeenCalled();

    jest.advanceTimersByTime(2 * SPEECH_END_DEFAULTS.maxUtteranceMs);
    expect(onEnd).not.toHaveBeenCalled();
  });

  test('without a stream it falls back to the no-speech timeout', () => {
    const onEnd = jest.fn();

    detectSpeechEnd({ audioContext: null, stream: null, onEnd });

    jest.advanceTimersByTime(SPEECH_END_DEFAULTS.noSpeechTimeoutMs - 1);
    expect(onEnd).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onEnd).toHaveBeenCalledWith('no-speech');
  });
});
