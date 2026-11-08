'use strict';

// The one number the rate gate and the bulk add screen must agree on, kept
// here, with no dependencies, so the browser can import it as well as Node.
//
// MAX_WAIT_MS is both the longest the gate's doubling backoff may block a
// model (rateGate.js) and the most a single bulk row will wait in total
// before giving up (src/components/Card/BulkRun.js): a row can then never
// give up on a wait the gate still means, nor wait out a block the gate
// would have ended. Google's own retryDelay, when it asks for longer, is
// still obeyed by the gate; the row simply stops there and offers Retry.
const MAX_WAIT_MS = 180_000;

module.exports = { MAX_WAIT_MS };
