import { createReviewLoop, PHASE } from '../../utils/reviewLoop';

// The loop's own timing comes entirely from the host's promises and from the
// detector, so both are stubbed and the tests drive them by hand.
const makeHost = (overrides = {}) => {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push(name);
      if (typeof result === 'function') return result(...args);
      return result;
    };

  let endDetection = null;

  const host = {
    calls,
    phases: [],
    endDetection: (reason) => endDetection(reason),
    playPrompt: record('playPrompt'),
    openMic: record('openMic', () => ({ audioContext: {}, stream: {} })),
    closeMic: record('closeMic', () => 'recording-blob'),
    reveal: record('reveal'),
    playNative: record('playNative'),
    onAnswerReady: record('onAnswerReady'),
    onMicUnavailable: jest.fn(),
    detect: ({ onEnd }) => {
      calls.push('detect');
      endDetection = onEnd;
      return () => calls.push('stopDetect');
    },
    ...overrides,
  };

  host.onPhase = (phase, info) => {
    host.phases.push(phase);
    if (overrides.onPhase) overrides.onPhase(phase, info, host);
  };

  return host;
};

// Lets the loop's awaited host callbacks settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createReviewLoop', () => {
  test('runs prompt, microphone, reveal, native audio in that order', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    const run = loop.start();
    await settle();

    expect(host.phases).toEqual([PHASE.PROMPT, PHASE.LISTENING]);
    expect(loop.phase).toBe(PHASE.LISTENING);

    host.endDetection('speech');
    await run;

    expect(host.calls).toEqual([
      'playPrompt',
      'openMic',
      'detect',
      'stopDetect',
      'closeMic',
      'reveal',
      'playNative',
      'onAnswerReady',
    ]);
    expect(host.phases).toContain(PHASE.ANSWER);
  });

  test('the recording reaches the answer, except when nobody spoke', async () => {
    const seen = [];
    const host = makeHost({ reveal: (result) => seen.push(result) });
    const loop = createReviewLoop(host);

    const first = loop.start();
    await settle();
    host.endDetection('speech');
    await first;

    const second = loop.start();
    await settle();
    host.endDetection('no-speech');
    await second;

    expect(seen).toEqual([
      { reason: 'speech', recording: 'recording-blob' },
      { reason: 'no-speech', recording: null },
    ]);
  });

  test('space ends the turn early and tears the detector down', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    const run = loop.start();
    await settle();

    expect(loop.endTurn('manual')).toBe(true);
    await run;

    expect(host.calls).toContain('stopDetect');
    expect(host.calls.indexOf('stopDetect')).toBeLessThan(host.calls.indexOf('closeMic'));
    // Nothing left to end once the answer is up.
    expect(loop.endTurn('manual')).toBe(false);
  });

  test('without a microphone it waits for the host instead of listening', async () => {
    const failure = new Error('denied');
    const host = makeHost({
      openMic: async () => {
        throw failure;
      },
      onPhase: (phase, info, self) => {
        if (phase === PHASE.WAITING) self.loop.endTurn('no-mic');
      },
    });
    const loop = createReviewLoop(host);
    host.loop = loop;

    await loop.start();

    expect(host.onMicUnavailable).toHaveBeenCalledWith(failure);
    expect(host.phases).toEqual([PHASE.PROMPT, PHASE.WAITING, PHASE.ANSWER]);
    // No stream was opened, so there is nothing to close and nothing to replay.
    expect(host.calls).toEqual(['playPrompt', 'reveal', 'playNative', 'onAnswerReady']);

    // A refusal is remembered: the second card does not ask again.
    await loop.start();
    expect(host.onMicUnavailable).toHaveBeenCalledTimes(1);
    expect(loop.micUnavailable).toBe(true);
  });

  test('a cancelled card does not reveal anything', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    const run = loop.start();
    await settle();
    loop.cancel();
    host.endDetection('speech');
    await run;
    await settle();

    expect(host.calls).not.toContain('reveal');
    expect(loop.phase).toBe(PHASE.IDLE);
  });

  test('resumeAtAnswer picks up where a page reload left off', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    await loop.resumeAtAnswer({ recording: null });

    expect(host.calls).toEqual(['playNative', 'onAnswerReady']);
    expect(loop.phase).toBe(PHASE.ANSWER);
  });

  test('a host callback that throws does not strand the card', async () => {
    const host = makeHost({
      playPrompt: () => {
        throw new Error('audio element exploded');
      },
      reveal: () => {
        throw new Error('reveal exploded');
      },
    });
    const loop = createReviewLoop(host);

    const run = loop.start();
    await settle();
    host.endDetection('speech');
    await run;

    expect(host.calls).toContain('onAnswerReady');
    expect(loop.phase).toBe(PHASE.ANSWER);
  });
});
