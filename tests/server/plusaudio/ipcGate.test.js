'use strict';

// How a generator subprocess reaches the rate gate its parent owns
// (lib/ipcGate.js): the parent holds all the state, the child only asks and
// reports, and a parent that does not answer fails the request open after a
// short fixed pause rather than hanging the card.

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { sandboxEnv } = require('../../repo/sandbox-home.cjs');
const { test } = require('node:test');

const { FAIL_OPEN_WAIT_MS, FORK_IPC_OPTIONS, createIpcGate, serveGate } = require('../../../plusaudio/lib/ipcGate');
const { createRateGate } = require('../../../plusaudio/lib/rateGate');
const { createRandom } = require('../../../plusaudio/lib/random');

const M = 'gemini-3.8-flash-tts';

/** Two ends of an in-memory IPC channel, shaped like a process and a ChildProcess. */
function channelPair() {
  const parentEnd = new EventEmitter();
  const childEnd = new EventEmitter();
  childEnd.connected = true;
  childEnd.send = (message, done) => {
    setImmediate(() => parentEnd.emit('message', message));
    if (done) done(null);
    return true;
  };
  parentEnd.send = (message, done) => {
    setImmediate(() => childEnd.emit('message', message));
    if (done) done(null);
    return true;
  };
  return { parentEnd, childEnd };
}

function fakeGate() {
  const clock = { t: 1_000_000 };
  return { clock, gate: createRateGate({ now: () => clock.t, random: createRandom(5) }) };
}

test("a child's acquire is answered from the parent's gate, and its records change the parent's state", async () => {
  const { parentEnd, childEnd } = channelPair();
  const { gate } = fakeGate();
  serveGate(parentEnd, gate);
  const child = createIpcGate(childEnd);

  assert.equal(await child.acquire(M), 0);
  assert.equal(gate.inspect(M).inWindow, 1, 'the start was counted in the parent');

  child.record(M, 'rateLimited', 30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(gate.inspect(M).blockedUntil > 0, 'the 429 reached the parent');
  const wait = await child.acquire(M);
  assert.ok(wait >= 30_000, `the child now waits for the parent's block, got ${wait}`);
});

test('a parent that never answers fails the request open after a short fixed pause, not a hang', async () => {
  const silent = new EventEmitter();
  silent.connected = true;
  silent.send = () => true; // swallowed
  let armed = null;
  const child = createIpcGate(silent, { timeoutMs: 2000, setTimer: (fn, ms) => { armed = ms; fn(); return 1; }, clearTimer: () => {} });

  assert.equal(await child.acquire(M), FAIL_OPEN_WAIT_MS);
  assert.equal(armed, 2000, 'it waited for a reply only as long as the timeout');
  assert.ok(FAIL_OPEN_WAIT_MS <= 2000, 'and the pause it fails open with is short');
});

test('a closed channel fails open at once, and a record is simply dropped', async () => {
  const closed = new EventEmitter();
  closed.connected = false;
  closed.send = () => { throw new Error('channel closed'); };
  const child = createIpcGate(closed);

  assert.equal(await child.acquire(M), FAIL_OPEN_WAIT_MS);
  assert.doesNotThrow(() => child.record(M, 'ok'));
});

test('a send that errors fails open instead of rejecting', async () => {
  const broken = new EventEmitter();
  broken.connected = true;
  broken.send = (message, done) => { done(new Error('EPIPE')); return false; };
  // A timer that never fires: the send error alone must end the wait.
  const gate = createIpcGate(broken, { setTimer: () => 0, clearTimer: () => {} });
  assert.equal(await gate.acquire(M), FAIL_OPEN_WAIT_MS);
});

test('two real forked children share one gate in the parent: the second sees the block the first one\'s 429 set', async () => {
  const { gate } = fakeGate();
  const script = path.join(__dirname, 'helpers', 'gate-child.js');
  const run = (...args) => new Promise((resolve, reject) => {
    const child = fork(script, args, { env: sandboxEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'], ...FORK_IPC_OPTIONS });
    serveGate(child, gate);
    child.on('message', (message) => { if (message && message.result !== undefined) resolve(message); });
    child.on('error', reject);
  });

  const first = await run('acquire-then-429');
  assert.equal(first.result, 0, 'the first child went at once, then was refused');
  const second = await run('acquire');
  assert.ok(second.result >= 45_000, `the second child is told to wait for the first one's block, got ${second.result}`);
  // The gate's messages cross as V8's binary clone, not as Node's default JSON.
  assert.ok(first.probe instanceof Map && first.probe.get('format') === 'advanced', 'a Map came through whole');
});
