'use strict';

// How a generator subprocess reaches the rate gate its parent owns.
//
// The app makes Gemini calls from per-card subprocesses (generate-card-text.js,
// generate-clip.js), started by the Next server with child_process.fork
// (src/server/anki/plusaudioCli.js), which gives each one Node's built-in
// IPC channel to the parent. The gate's state - blockedUntil, the window,
// the learned cap, the 429 streak - lives only in the parent (rateGate.js's
// one per-process instance). A subprocess holds none of it: before every
// Gemini request it asks the parent "how long must I wait?" (acquire), and
// after every answer it reports what happened (record). Messages are plain
// objects tagged `amgiGate`; nothing else on the channel is touched.
//
// IF THE PARENT DOES NOT ANSWER - the channel closed, or no reply within
// REPLY_TIMEOUT_MS - the request fails OPEN: acquire resolves to
// FAIL_OPEN_WAIT_MS, a short fixed pause, and the request goes ahead. A gate
// that hung the card would be worse than no gate, and the Gemini client's own
// 429 handling still catches whatever the missing pacing lets through.
// record() never waits for anything.
//
// gateForThisProcess() is what a Gemini client should use: the parent's gate
// when this process was forked with an IPC channel, otherwise this process's
// own (rateGate.js's sharedGate) - a script run directly, such as the starter
// re-record or the Anki add-on's subprocess, is the top of its own tree.

const { sharedGate } = require('./rateGate');

// The channel's format: Node's IPC channel serializes every message as JSON
// unless the parent forks with serialization 'advanced' (V8's structured
// clone, binary), and the child takes the parent's choice. Every fork of a
// script that asks a gate spreads FORK_IPC_OPTIONS into its options, so a
// gate message never travels as JSON (test/no-json.test.mjs flags a fork
// without it).
const FORK_IPC_OPTIONS = Object.freeze({ serialization: 'advanced' });

const REPLY_TIMEOUT_MS = 2000;
const FAIL_OPEN_WAIT_MS = 1000;
const TAG = 'amgiGate';

/** The child's side: a gate whose acquire/record are answered by the parent over `channel` (a process). */
function createIpcGate(channel = process, { timeoutMs = REPLY_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let nextId = 1;
  const pending = new Map();

  // The channel must not keep a finished script alive, but must keep it
  // alive while a question is waiting for its answer.
  const holdOpen = () => channel.channel?.ref?.();
  const letGo = () => { if (pending.size === 0) channel.channel?.unref?.(); };
  const settle = (id, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimer(entry.timer);
    letGo();
    entry.resolve(value);
  };

  channel.on('message', (message) => {
    if (message && message[TAG] === 'reply') settle(message.id, Number(message.value) || 0);
  });
  letGo();

  const failOpen = () => FAIL_OPEN_WAIT_MS;

  return {
    acquire(model) {
      if (!channel.connected) return Promise.resolve(failOpen());
      const id = nextId;
      nextId += 1;
      return new Promise((resolve) => {
        pending.set(id, { resolve, timer: null });
        holdOpen();
        pending.get(id).timer = setTimer(() => settle(id, failOpen()), timeoutMs);
        try {
          channel.send({ [TAG]: 'acquire', id, model }, (error) => {
            if (error) settle(id, failOpen());
          });
        } catch {
          settle(id, failOpen());
        }
      });
    },
    record(model, outcome, retryDelayMs) {
      if (!channel.connected) return;
      try {
        channel.send({ [TAG]: 'record', model, outcome, retryDelayMs }, () => {});
      } catch {
        // The parent is gone; there is no one left to tell.
      }
    },
  };
}

/** The parent's side: answer a forked child's gate messages from `gate`. */
function serveGate(child, gate = sharedGate()) {
  child.on('message', (message) => {
    if (!message || typeof message[TAG] !== 'string') return;
    if (message[TAG] === 'acquire') {
      const value = gate.acquire(message.model);
      try {
        child.send({ [TAG]: 'reply', id: message.id, value }, () => {});
      } catch {
        // The child has exited; its question no longer matters.
      }
    } else if (message[TAG] === 'record') {
      gate.record(message.model, message.outcome, message.retryDelayMs);
    }
  });
}

/** The gate a Gemini client in this process should use (see above). */
function gateForThisProcess() {
  return typeof process.send === 'function' && process.connected ? createIpcGate(process) : sharedGate();
}

module.exports = { FAIL_OPEN_WAIT_MS, FORK_IPC_OPTIONS, createIpcGate, gateForThisProcess, serveGate };
