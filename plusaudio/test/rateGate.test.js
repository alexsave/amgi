'use strict';

// The shared rate gate (lib/rateGate.js), on a fake clock and a seeded random:
// no real waits, and every number below is exact.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { BASE_BLOCK_MS, JITTER, MAX_BLOCK_MS, WINDOW_MS, createRateGate } = require('../lib/rateGate');
const { createRandom } = require('../lib/random');

const M = 'gemini-3.8-flash-tts';

function gateAt(start = 1_000_000, seed = 1) {
  const clock = { t: start };
  const gate = createRateGate({ now: () => clock.t, random: createRandom(seed) });
  return { gate, clock };
}

/** Admit `n` requests one second apart; returns how many went through without a wait. */
function admit(gate, clock, n) {
  let admitted = 0;
  for (let i = 0; i < n; i += 1) {
    if (gate.acquire(M) === 0) admitted += 1;
    clock.t += 1000;
  }
  return admitted;
}

test('an unknown limit admits everything until the first 429', () => {
  const { gate, clock } = gateAt();
  assert.equal(admit(gate, clock, 50), 50);
  assert.equal(gate.inspect(M).cap, Infinity);
});

test('after a 429 the window caps requests per minute at the learned limit, a margin below what got through', () => {
  const { gate, clock } = gateAt();
  admit(gate, clock, 10); // the limit was 10 a minute: these got through...
  gate.acquire(M); // ...and the eleventh was admitted and refused
  gate.record(M, 'rateLimited', 5000);
  assert.equal(gate.inspect(M).cap, Math.floor(10 * 0.8), '80% of the ten that got through');

  // Past the block, the gate now holds the window at 8 by itself.
  clock.t += WINDOW_MS;
  let admitted = 0;
  for (let i = 0; i < 20; i += 1) if (gate.acquire(M) === 0) admitted += 1;
  assert.equal(admitted, 8, 'no ninth request in the same minute');
  const wait = gate.acquire(M);
  assert.ok(wait >= WINDOW_MS && wait < WINDOW_MS * (1 + JITTER), `waits for the oldest to age out, got ${wait}`);
});

test("Google's retryDelay is the floor of the block, even above the doubling's cap", () => {
  const long = gateAt();
  long.gate.record(M, 'rateLimited', 200_000);
  assert.equal(long.gate.inspect(M).blockedUntil, 1_000_000 + 200_000);

  const { gate } = gateAt();
  gate.record(M, 'rateLimited', 49_000);
  const wait = gate.acquire(M);
  assert.ok(wait >= 49_000 && wait <= 49_000 * (1 + JITTER), `got ${wait}`);
  assert.equal(gate.inspect(M).blockedUntil, 1_000_000 + 49_000);
});

test('repeated 429s with no success between double the block, up to the maximum', () => {
  const { gate, clock } = gateAt();
  const blocks = [];
  for (let n = 1; n <= 9; n += 1) {
    clock.t = gate.inspect(M).blockedUntil; // came back exactly when told, and was refused again
    const at = clock.t;
    gate.record(M, 'rateLimited', 0);
    blocks.push(gate.inspect(M).blockedUntil - at);
  }
  assert.deepEqual(blocks, [2000, 4000, 8000, 16000, 32000, 64000, 128000, MAX_BLOCK_MS, MAX_BLOCK_MS]);
  assert.equal(MAX_BLOCK_MS, 180_000);
  assert.equal(BASE_BLOCK_MS, 2000);

  // A success ends the streak: the next 429 starts from the base again.
  gate.record(M, 'ok');
  clock.t = gate.inspect(M).blockedUntil;
  const at = clock.t;
  gate.record(M, 'rateLimited', 0);
  assert.equal(gate.inspect(M).blockedUntil - at, BASE_BLOCK_MS);
});

test('the learned cap grows back by one per full clean minute', () => {
  const { gate, clock } = gateAt();
  admit(gate, clock, 10);
  gate.record(M, 'rateLimited', 1000);
  const learned = gate.inspect(M).cap;

  clock.t += 2000;
  gate.record(M, 'ok'); // the clean stretch starts
  clock.t += WINDOW_MS / 2;
  gate.record(M, 'ok');
  assert.equal(gate.inspect(M).cap, learned, 'half a clean minute is not enough');
  clock.t += WINDOW_MS / 2;
  gate.record(M, 'ok');
  assert.equal(gate.inspect(M).cap, learned + 1);
  clock.t += WINDOW_MS;
  gate.record(M, 'ok');
  assert.equal(gate.inspect(M).cap, learned + 2);
});

test('jitter spreads waiters released by the same 429 over distinct times, and a fixed seed replays them', () => {
  const waits = (seed) => {
    const { gate } = gateAt(1_000_000, seed);
    gate.record(M, 'rateLimited', 40_000);
    return Array.from({ length: 8 }, () => gate.acquire(M));
  };
  const first = waits(7);
  assert.equal(new Set(first).size, first.length, `all distinct: ${first}`);
  for (const wait of first) assert.ok(wait >= 40_000 && wait < 40_000 * (1 + JITTER));
  assert.deepEqual(waits(7), first, 'same seed, same sequence');
  assert.notDeepEqual(waits(8), first);
});

test('one draw per acquire, whether or not it waits, so timing never changes the draw sequence', () => {
  let draws = 0;
  const clock = { t: 0 };
  const gate = createRateGate({ now: () => clock.t, random: { int: (n) => { draws += 1; return n - 1; } } });
  gate.acquire(M);
  gate.record(M, 'rateLimited', 10_000);
  gate.acquire(M);
  gate.acquire(M);
  assert.equal(draws, 3);
});

test('a 429 with too few requests seen to learn from blocks, but learns no cap', () => {
  const { gate, clock } = gateAt();
  admit(gate, clock, 2);
  gate.acquire(M);
  gate.record(M, 'rateLimited', 5000);
  assert.equal(gate.inspect(M).cap, Infinity, 'two admitted requests say nothing about a per-minute limit');
  assert.ok(gate.acquire(M) > 0, 'but the block still holds');

  const more = gateAt();
  admit(more.gate, more.clock, 3);
  more.gate.acquire(M);
  more.gate.record(M, 'rateLimited', 5000);
  assert.equal(more.gate.inspect(M).cap, Math.floor(3 * 0.8), 'three is enough to learn from');
});

test('models are gated separately: a busy speech model does not hold back text', () => {
  const { gate } = gateAt();
  gate.record(M, 'rateLimited', 50_000);
  assert.ok(gate.acquire(M) > 0);
  assert.equal(gate.acquire('gemini-3.8-flash'), 0);
});
