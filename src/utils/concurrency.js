// Running a list of slow, independent jobs a few at a time.
//
// Every job this is used for is network-bound and several seconds long (see
// BulkRun.js, where one job is a card's text plus two clip pipelines), so
// the point of the pool is not throughput of CPU work - it is that a lane
// waiting on OpenAI is a lane doing nothing, and there is no reason for the
// next line to wait for it.

/**
 * Call `worker(item, index)` for every entry of `items`, with at most
 * `limit` calls outstanding at once, and resolve once they have all
 * finished.
 *
 * `limit` lanes each take the next unclaimed item off a shared cursor.
 * Splitting the list into `limit` fixed blocks up front - lane 0 gets the
 * first n/limit items, lane 1 the next - would be less code and the wrong
 * shape for this work: the jobs differ wildly in length (a cache hit on an
 * existing clip returns instantly, a retried generation takes ten seconds),
 * so a lane that drew the short ones would sit finished while another still
 * had half its block to go. A shared cursor means whichever lane frees up
 * first takes the next item there is.
 *
 * The cursor needs no lock despite being shared. Reading it and moving it on
 * happen in one synchronous step with no await between them, and JavaScript
 * runs that step to completion before any other lane can resume, so two
 * lanes cannot come away holding the same index - which is the whole of what
 * a mutex would have bought here.
 *
 * `shouldStop` is asked before each item is claimed, never mid-item: it is
 * for a run that has been superseded and whose remaining work is pointless,
 * not for cancelling something already in flight. Work already started is
 * always allowed to finish, because the caller that started it (a card
 * halfway to being written into a deck) usually wants the result either way.
 *
 * A worker that throws does not cancel the other lanes - they are already
 * running, and nothing here can call them back. Every lane is awaited before
 * the first failure is re-thrown, so a caller that tears down state on a
 * rejection is never doing it underneath a lane that is still going. Callers
 * that want one bad item not to end the run catch inside the worker instead.
 */
export async function runPool(items, limit, worker, shouldStop = () => false) {
  const laneCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const lane = async () => {
    while (cursor < items.length) {
      if (shouldStop()) return;
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  };

  const outcomes = await Promise.allSettled(Array.from({ length: laneCount }, lane));
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
}
