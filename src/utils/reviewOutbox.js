// A serialized, retrying outbox for review saves.
//
// Grading a card must never make the learner wait on the network: the loop is
// hands-free and the next card has to appear the instant they answer. But a
// dropped request used to lose the answer outright, and with it the
// `review_logs` row - the only history a scheduler could ever be retrained on.
// So the save is still off the critical path, and this is what stands behind
// it instead of a bare `.catch(console.error)`.
//
// Three properties, in the order they matter:
//
//   1. ORDER. Exactly one send is in flight at a time and the queue is FIFO,
//      so two rapid grades of the same card cannot land out of order and
//      leave the older schedule as the stored one. A parallel drain would be
//      faster and would occasionally corrupt a card's state; this does not.
//   2. RETRY. A failure is retried with capped exponential backoff rather
//      than logged and forgotten. Most failures are a flaky connection and
//      resolve on their own within a few seconds.
//   3. VISIBILITY. An entry that keeps failing is parked in `failed` instead
//      of blocking everything behind it, and the caller is told. Silence
//      after a failure is the bug being fixed here, so the state is pushed
//      out on every change for the UI to render.
//
// Deliberately NOT persisted across reloads. Replaying a queued schedule in a
// later session would overwrite whatever happened to the card in between -
// on another device, or in a session that ran after this one - and last write
// wins, so the stale entry would silently win. A visible warning plus the
// unload guard in ReviewContext keeps the learner informed without inventing
// a conflict-resolution problem the app has no answer to.

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {(entry) => Promise<any>} options.send      performs one save; rejects to trigger a retry
 * @param {(state) => void} [options.onChange]        `{ pending, failed, lastError }` on every change
 * @param {number[]} [options.backoff]                delay before each retry; its length caps the attempts
 * @param {(ms) => Promise<void>} [options.sleep]     swapped out in tests
 */
export function createReviewOutbox({
  send,
  onChange = () => {},
  backoff = DEFAULT_BACKOFF_MS,
  sleep = defaultSleep,
} = {}) {
  const queue = [];
  const failed = [];
  let draining = null;
  let attempt = 0;
  let lastError = null;

  const report = () => {
    try {
      onChange({ pending: queue.length, failed: failed.length, lastError });
    } catch {
      // A subscriber that throws must not take the outbox down with it.
    }
  };

  async function drain() {
    while (queue.length > 0) {
      const entry = queue[0];
      try {
        await send(entry);
        queue.shift();
        attempt = 0;
        lastError = null;
        report();
      } catch (error) {
        attempt += 1;
        lastError = error;
        if (attempt > backoff.length) {
          // Head-of-line blocking is worse than parking one entry: a card
          // that can never be saved (deleted, or rejected by the server)
          // would otherwise hold back every answer behind it.
          failed.push(queue.shift());
          attempt = 0;
          report();
          continue;
        }
        report();
        await sleep(backoff[attempt - 1]);
      }
    }
  }

  const kick = () => {
    if (!draining) {
      draining = drain().finally(() => {
        draining = null;
      });
    }
    return draining;
  };

  return {
    /** Queues one save and starts draining. Never throws, never blocks. */
    enqueue(entry) {
      queue.push(entry);
      report();
      kick();
    },

    /** Puts every parked entry back at the end of the queue, oldest first. */
    retryFailed() {
      if (failed.length === 0) return;
      queue.push(...failed.splice(0, failed.length));
      attempt = 0;
      lastError = null;
      report();
      kick();
    },

    /** Resolves when the queue is empty or everything left is parked. */
    async settled() {
      while (draining) {
        await draining;
      }
    },

    /** Whether anything at all is still unsaved - queued or parked. */
    hasUnsaved() {
      return queue.length + failed.length > 0;
    },

    get pending() {
      return queue.length;
    },

    get failed() {
      return failed.length;
    },
  };
}
