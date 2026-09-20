import { runPool } from '../../utils/concurrency';

// A promise a test can finish when it chooses, which is the only way to see
// what the pool is doing while items are still in flight - a worker that
// resolves on its own is over before an assertion can look at it.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('runPool', () => {
  test('keeps the limit filled and runs every item exactly once', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const done = [];
    let inFlight = 0;
    let peak = 0;

    await runPool(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      done.push(item);
    });

    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  test('never starts more lanes than there are items', async () => {
    let peak = 0;
    let inFlight = 0;
    await runPool(['one', 'two'], 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });

  test('an empty list is not an error and calls nobody', async () => {
    const worker = jest.fn();
    await runPool([], 4, worker);
    expect(worker).not.toHaveBeenCalled();
  });

  test('a lane that finishes early takes the next item rather than waiting', async () => {
    // The reason the cursor is shared rather than each lane being handed a
    // fixed block: with blocks, 'quick-3' would sit behind the slow item in
    // lane 0's own block and the whole run would be as long as its slowest
    // lane.
    const slow = deferred();
    const started = [];
    const finished = [];

    const run = runPool(['slow', 'quick-1', 'quick-2', 'quick-3'], 2, async (item) => {
      started.push(item);
      if (item === 'slow') await slow.promise;
      finished.push(item);
    });

    await tick();
    expect(started).toEqual(['slow', 'quick-1', 'quick-2', 'quick-3']);
    expect(finished).toEqual(['quick-1', 'quick-2', 'quick-3']);

    slow.resolve();
    await run;
    expect(finished).toEqual(['quick-1', 'quick-2', 'quick-3', 'slow']);
  });

  test('stops claiming work once the run has been superseded', async () => {
    const handled = [];
    let superseded = false;

    await runPool([0, 1, 2, 3, 4], 2, async (item) => {
      handled.push(item);
      if (item === 1) superseded = true;
    }, () => superseded);

    // 0 and 1 were claimed before the flag flipped; nothing after it was.
    expect(handled).toEqual([0, 1]);
  });

  test('waits for every lane before surfacing a failure', async () => {
    // Promise.all would hand the caller the error while the other lane was
    // still running, and a caller that tears down state on a rejection would
    // be doing it underneath live work.
    const slow = deferred();
    const finished = [];
    let outcome = null;

    const run = runPool(['boom', 'slow'], 2, async (item) => {
      if (item === 'boom') throw new Error('boom');
      await slow.promise;
      finished.push(item);
    });
    const watched = run.then(() => 'resolved', (error) => error.message).then((value) => {
      outcome = value;
      return value;
    });

    await tick();
    expect(outcome).toBeNull();
    expect(finished).toEqual([]);

    slow.resolve();
    await expect(watched).resolves.toBe('boom');
    expect(finished).toEqual(['slow']);
  });
});
