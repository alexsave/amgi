import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createReviewLoop, PHASE } from '../../utils/reviewLoop.js';

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
    onMicUnavailable: mock.fn(),
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

    assert.deepEqual(host.phases, [PHASE.PROMPT, PHASE.REQUESTING_MIC, PHASE.LISTENING]);
    assert.equal(loop.phase, PHASE.LISTENING);

    host.endDetection('speech');
    await run;

    assert.deepEqual(host.calls, [
      'playPrompt',
      'openMic',
      'detect',
      'stopDetect',
      'closeMic',
      'reveal',
      'playNative',
      'onAnswerReady',
    ]);
    assert.ok((host.phases).includes(PHASE.ANSWER));
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

    assert.deepEqual(seen, [
      { reason: 'speech', recording: 'recording-blob' },
      { reason: 'no-speech', recording: null },
    ]);
  });

  test('space ends the turn early and tears the detector down', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    const run = loop.start();
    await settle();

    assert.equal(loop.endTurn('manual'), true);
    await run;

    assert.ok((host.calls).includes('stopDetect'));
    assert.ok((host.calls.indexOf('stopDetect')) < host.calls.indexOf('closeMic'));
    // Nothing left to end once the answer is up.
    assert.equal(loop.endTurn('manual'), false);
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

    assert.ok((host.onMicUnavailable).mock.calls.some((call) => isDeepStrictEqual(call.arguments, [failure])));
    assert.deepEqual(host.phases, [PHASE.PROMPT, PHASE.REQUESTING_MIC, PHASE.WAITING, PHASE.ANSWER]);
    // No stream was opened, so there is nothing to close and nothing to replay.
    assert.deepEqual(host.calls, ['playPrompt', 'reveal', 'playNative', 'onAnswerReady']);

    // A refusal is remembered: the second card does not ask again, and never
    // shows the "asking for the microphone" phase at all - there is nothing
    // to ask for.
    const phasesBeforeSecondCard = host.phases.length;
    await loop.start();
    assert.equal((host.onMicUnavailable).mock.callCount(), 1);
    assert.equal(loop.micUnavailable, true);
    assert.ok(!(host.phases.slice(phasesBeforeSecondCard)).includes(PHASE.REQUESTING_MIC));
  });

  test('a microphone request that never settles falls back once micTimeoutMs elapses', async () => {
    // Real Anki desktop (Qt 6.11, no permission-handling add-on) leaves an
    // unanswered getUserMedia() pending forever - it never rejects. This is
    // the case the "without a microphone" test above (an immediate rejection)
    // does not cover.
    const host = makeHost({
      openMic: () => new Promise(() => {}),
      micTimeoutMs: 20,
      onPhase: (phase, info, self) => {
        if (phase === PHASE.WAITING) self.loop.endTurn('no-mic');
      },
    });
    const loop = createReviewLoop(host);
    host.loop = loop;

    await loop.start();

    assert.equal((host.onMicUnavailable).mock.callCount(), 1);
    assert.deepEqual(host.phases, [PHASE.PROMPT, PHASE.REQUESTING_MIC, PHASE.WAITING, PHASE.ANSWER]);
    // No stream was ever opened, so there is nothing to close and nothing to replay.
    assert.deepEqual(host.calls, ['playPrompt', 'reveal', 'playNative', 'onAnswerReady']);
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

    assert.ok(!(host.calls).includes('reveal'));
    assert.equal(loop.phase, PHASE.IDLE);
  });

  test('resumeAtAnswer picks up where a page reload left off', async () => {
    const host = makeHost();
    const loop = createReviewLoop(host);

    await loop.resumeAtAnswer({ recording: null });

    assert.deepEqual(host.calls, ['playNative', 'onAnswerReady']);
    assert.equal(loop.phase, PHASE.ANSWER);
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

    assert.ok((host.calls).includes('onAnswerReady'));
    assert.equal(loop.phase, PHASE.ANSWER);
  });
});
