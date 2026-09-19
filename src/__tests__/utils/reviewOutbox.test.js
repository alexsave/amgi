import { createReviewOutbox } from '../../utils/reviewOutbox';

// A controllable sleep: the outbox never really waits, but the test decides
// when each backoff is over.
const makeClock = () => {
  const waiting = [];
  return {
    sleep: () => new Promise((resolve) => waiting.push(resolve)),
    async tick() {
      const pending = waiting.splice(0, waiting.length);
      pending.forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
    },
    get waiting() {
      return waiting.length;
    }
  };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the review outbox', () => {
  test('sends entries one at a time, in the order they were graded', async () => {
    const started = [];
    const finished = [];
    const resolvers = [];

    const outbox = createReviewOutbox({
      send: (entry) => {
        started.push(entry.id);
        return new Promise((resolve) => {
          resolvers.push(() => {
            finished.push(entry.id);
            resolve();
          });
        });
      }
    });

    outbox.enqueue({ id: 'a' });
    outbox.enqueue({ id: 'b' });
    outbox.enqueue({ id: 'c' });
    await flush();

    // Two rapid grades of the same card must not race: only one is in flight.
    expect(started).toEqual(['a']);

    resolvers[0]();
    await flush();
    expect(started).toEqual(['a', 'b']);

    resolvers[1]();
    await flush();
    resolvers[2]();
    await flush();

    expect(finished).toEqual(['a', 'b', 'c']);
    expect(outbox.hasUnsaved()).toBe(false);
  });

  test('retries a failed send instead of dropping the answer', async () => {
    const clock = makeClock();
    const attempts = [];
    const send = jest.fn((entry) => {
      attempts.push(entry.id);
      return attempts.length < 3 ? Promise.reject(new Error('offline')) : Promise.resolve();
    });

    const states = [];
    const outbox = createReviewOutbox({
      send,
      onChange: (state) => states.push(state),
      sleep: clock.sleep,
      backoff: [1, 2, 3]
    });

    outbox.enqueue({ id: 'a' });
    await flush();
    expect(outbox.pending).toBe(1);
    expect(states.at(-1).lastError.message).toBe('offline');

    await clock.tick();
    await flush();
    await clock.tick();
    await flush();

    expect(attempts).toEqual(['a', 'a', 'a']);
    expect(outbox.pending).toBe(0);
    expect(outbox.failed).toBe(0);
    expect(states.at(-1)).toEqual({ pending: 0, failed: 0, lastError: null });
  });

  test('a later answer is not sent before an earlier one has landed', async () => {
    const clock = makeClock();
    const attempts = [];
    const outbox = createReviewOutbox({
      send: (entry) => {
        attempts.push(entry.id);
        return entry.id === 'a' && attempts.filter((id) => id === 'a').length === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve();
      },
      sleep: clock.sleep,
      backoff: [1, 2]
    });

    outbox.enqueue({ id: 'a' });
    outbox.enqueue({ id: 'b' });
    await flush();

    // 'b' must wait: replaying it first would let an older schedule overwrite
    // a newer one when both are for the same card.
    expect(attempts).toEqual(['a']);

    await clock.tick();
    await flush();
    expect(attempts).toEqual(['a', 'a', 'b']);
  });

  test('parks an answer that keeps failing, and does not block the rest behind it', async () => {
    const clock = makeClock();
    const outbox = createReviewOutbox({
      send: (entry) => (entry.id === 'poison' ? Promise.reject(new Error('rejected')) : Promise.resolve()),
      sleep: clock.sleep,
      backoff: [1, 2]
    });

    outbox.enqueue({ id: 'poison' });
    outbox.enqueue({ id: 'good' });
    await flush();

    await clock.tick();
    await flush();
    await clock.tick();
    await flush();

    expect(outbox.failed).toBe(1);
    expect(outbox.pending).toBe(0);
    expect(outbox.hasUnsaved()).toBe(true);
  });

  test('retryFailed puts parked answers back on the queue', async () => {
    const clock = makeClock();
    let online = false;
    const outbox = createReviewOutbox({
      send: () => (online ? Promise.resolve() : Promise.reject(new Error('offline'))),
      sleep: clock.sleep,
      backoff: [1]
    });

    outbox.enqueue({ id: 'a' });
    await flush();
    await clock.tick();
    await flush();
    expect(outbox.failed).toBe(1);

    online = true;
    outbox.retryFailed();
    await flush();

    expect(outbox.failed).toBe(0);
    expect(outbox.hasUnsaved()).toBe(false);
  });

  test('a subscriber that throws does not take the outbox down', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const outbox = createReviewOutbox({
      send,
      onChange: () => {
        throw new Error('render exploded');
      }
    });

    outbox.enqueue({ id: 'a' });
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.hasUnsaved()).toBe(false);
  });
});
