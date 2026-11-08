'use strict';

// The one rate gate every Gemini request passes, per model.
//
// WHY. One API key is one allowance per model per minute, shared by every
// card being made at once. A 429 one card gets is news every other card
// needs: without a shared gate, five bulk lanes each find the limit for
// themselves, and their retries all come back at the same instant and find
// it again. With it, the first 429 teaches the gate roughly what the limit
// is, and from then on requests are paced under it instead of refused.
//
// WHERE IT LIVES. One instance per process (sharedGate below). The app's
// server has its own port of this gate in C (server/amgi/gate.c), shared by
// every card in it. A script run on its own (generate-clip.js, the starter
// re-record, add-audio.js, the Anki add-on's subprocess) has only itself to
// coordinate, and uses its own instance; ipcGate.js lets a parent process
// share one with scripts it forks.
//
// WHAT IT KNOWS, per model:
//   blockedUntil    no request before this moment (after a 429)
//   starts          when each recent request was admitted (last 60 s)
//   cap             requests per minute it believes the limit allows;
//                   unknown (Infinity) until the first 429 teaches it
//   consecutive429  429s since the last success, for the doubling
//
// THE RULES.
//   acquire(model)  -> ms to wait before this request may go: the time
//                   until blockedUntil, or, when the window already holds
//                   `cap` requests, until the oldest one ages out. 0 means
//                   go now, and the request is counted as started. Any
//                   non-zero wait is stretched by up to JITTER (25%) so
//                   waiters released by the same event come back apart.
//   record(model, 'rateLimited', retryDelayMs) on a per-minute 429:
//                   block for max(retryDelay, min(BASE * 2^(n-1),
//                   MAX_BLOCK)) - Google's retryDelay is the floor, and the
//                   doubling (2 s, 4 s, ... up to MAX_BLOCK, 180 s) only
//                   matters when we came back too early or Google gave
//                   no RetryInfo; and learn the cap as 80% of the requests
//                   admitted in the minute before (AIMD's multiplicative
//                   decrease), when there were at least MIN_EVIDENCE (3)
//                   of them to learn from.
//   record(model, 'ok') on success: the 429 streak ends, and after each
//                   full clean minute the cap grows by one (the additive
//                   increase), so a raised limit gets used.
//   admissionWait() -> how long until NEW work may start: the longest wait
//                   any known model would give (jittered), 0 when none is
//                   blocked or full. A card about to begin asks this first.
//   A daily cap never reaches the gate: it is fatal and immediate
//   (cardGeneration/gemini.ts), and waiting a minute would not help.
//
// RANDOMNESS. The jitter draws from plusaudio/lib/random.js, the one
// seedable source, through an injectable `random`, exactly one draw per
// acquire whatever the wait is - so the number of draws depends on how many
// requests asked, never on timing, and a fixed seed replays exactly.
//
// CLOCK. `now` is injected; the default reads the wall clock here and
// nowhere else in this module.

const { random: defaultRandom } = require('./random');
const { MAX_WAIT_MS } = require('./rateLimits');

const WINDOW_MS = 60_000;
const BASE_BLOCK_MS = 2_000;
// The longest the doubling may block a model: the one value the bulk add
// screen's per-row budget shares (rateLimits.js). Google's own retryDelay,
// when it asks for longer, still wins.
const MAX_BLOCK_MS = MAX_WAIT_MS;
const JITTER = 0.25;
const DECREASE = 0.8;
const MIN_EVIDENCE = 3;

function createRateGate({ now = () => Date.now(), random = defaultRandom } = {}) {
  const models = new Map();

  function stateOf(model) {
    let state = models.get(model);
    if (!state) {
      state = { blockedUntil: 0, starts: [], cap: Infinity, consecutive429: 0, cleanSince: null };
      models.set(model, state);
    }
    return state;
  }

  function prune(state, at) {
    while (state.starts.length > 0 && at - state.starts[0] >= WINDOW_MS) state.starts.shift();
  }

  /** The un-jittered wait before `model` may take another request. */
  function waitFor(state, at) {
    prune(state, at);
    let wait = Math.max(0, state.blockedUntil - at);
    if (state.starts.length >= state.cap) wait = Math.max(wait, state.starts[0] + WINDOW_MS - at);
    return wait;
  }

  return {
    acquire(model) {
      const state = stateOf(model);
      const at = now();
      const wait = waitFor(state, at);
      // One draw per acquire, used or not (see RANDOMNESS above).
      const u = random.int(1_000_000) / 1_000_000;
      if (wait === 0) {
        state.starts.push(at);
        return 0;
      }
      return Math.ceil(wait * (1 + u * JITTER));
    },

    record(model, outcome, retryDelayMs) {
      const state = stateOf(model);
      const at = now();
      if (outcome === 'rateLimited') {
        state.consecutive429 += 1;
        state.cleanSince = null;
        prune(state, at);
        // The requests admitted in the minute up to this refusal (not
        // counting the refused one) are the best evidence of the limit
        // there is; aim a margin below it. Too few of them is evidence of
        // traffic this gate never saw - another process, the same key used
        // elsewhere - not of the limit, and learning "1 a minute" from it
        // would throttle everything for nothing; then only the block applies.
        // A refused request used none of the allowance, so it leaves the
        // window. With several requests refused at once - five bulk lanes in
        // flight together - each one's 429 takes its own start out, and the
        // cap (a minimum over every 429) settles on the true count once all
        // of them are in, instead of on the inflated count the first one saw.
        state.starts.pop();
        const admitted = state.starts.length;
        if (admitted >= MIN_EVIDENCE) state.cap = Math.min(state.cap, Math.floor(admitted * DECREASE));
        const doubled = BASE_BLOCK_MS * 2 ** (state.consecutive429 - 1);
        const block = Math.max(retryDelayMs || 0, Math.min(MAX_BLOCK_MS, doubled));
        state.blockedUntil = Math.max(state.blockedUntil, at + block);
        return;
      }
      state.consecutive429 = 0;
      if (state.cleanSince === null) {
        state.cleanSince = at;
      } else if (at - state.cleanSince >= WINDOW_MS) {
        if (Number.isFinite(state.cap)) state.cap += 1;
        state.cleanSince = at;
      }
    },

    /**
     * How long until new work may start: the longest jittered wait any
     * model this gate knows would give, or 0 when none is blocked or full.
     * Asked before a new card starts (the app's server does the same in
     * server/amgi/gen.c), so a card that would only be refused is never begun
     * and its text call never spent. Records no start; one draw per call,
     * like acquire.
     */
    admissionWait() {
      const at = now();
      let longest = 0;
      for (const state of models.values()) longest = Math.max(longest, waitFor(state, at));
      const u = random.int(1_000_000) / 1_000_000;
      return longest === 0 ? 0 : Math.ceil(longest * (1 + u * JITTER));
    },

    /** What the gate believes about `model`, for tests and logs. */
    inspect(model) {
      const state = stateOf(model);
      prune(state, now());
      return { blockedUntil: state.blockedUntil, cap: state.cap, inWindow: state.starts.length, consecutive429: state.consecutive429 };
    },
  };
}

// Anchored on globalThis, not a module variable: Next's dev server can load
// this module more than once in the same process (it re-requires server code
// as routes compile), and every copy must find the same gate, or a reload
// would forget every 429 the server had learned from.
const SHARED_KEY = Symbol.for('amgi.rateGate');

/** The one gate this process shares between every Gemini client in it. */
function sharedGate() {
  if (!globalThis[SHARED_KEY]) globalThis[SHARED_KEY] = createRateGate();
  return globalThis[SHARED_KEY];
}

module.exports = { BASE_BLOCK_MS, JITTER, MAX_BLOCK_MS, WINDOW_MS, createRateGate, sharedGate };
