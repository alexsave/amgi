// Running one of plusaudio's command-line scripts (generate-clip.js,
// generate-card-text.js) from this app's server. See audio.js's module
// comment for why these are subprocesses rather than in-process requires.
//
// Both scripts write their failure message as the last thing on stderr
// before a non-zero exit, after any warnings cardGeneration.ts logged along
// the way and after anything Node itself printed at startup. So the last
// line is the one a person should read, and it is the only one put on the
// thrown error. The first line is not: it was once a Node module-type warning,
// which is how a failed clip was recorded with a reason that said nothing
// about why it failed. Everything stderr said still goes to the server log,
// because the last line is a summary, not the whole story.
//
// THE RATE GATE. Every script is started with child_process.fork, which
// gives it Node's IPC channel back to this server, and this server answers
// its rate gate questions from the one gate it owns (plusaudio's ipcGate.js
// and rateGate.js; plusaudio is a server-external package, so Node's module
// cache makes that one instance per server process, shared by every route).
// That is what lets a 429 one card gets slow down every other card, though
// each card runs in a subprocess of its own.
//
// TYPED FAILURES. Two exit codes are not "a failure" but news a caller acts
// on (plusaudio/lib/cliExit.js): a rate limit (exit 3, with the gate's wait
// on stdout) becomes a RateLimitedError carrying retryAfterMs, and a spent
// daily cap (exit 4) a DailyCapError. The routes turn both into HTTP 429.

import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAILY_CAP_EXIT, RATE_LIMITED_EXIT, parseRetryAfter } from 'plusaudio/lib/cliExit';
import { FORK_IPC_OPTIONS, serveGate } from 'plusaudio/lib/ipcGate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUSAUDIO_DIR = path.join(HERE, '..', '..', '..', 'plusaudio');

/** Gemini's per-minute allowance said to wait; try the same work again after retryAfterMs. */
export class RateLimitedError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitedError';
    this.rateLimited = true;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A daily cap is spent: nothing will succeed until it resets. */
export class DailyCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyCapError';
    this.dailyCap = true;
  }
}

/** The line of a failed run's stderr that says why it failed. */
function failureMessage(stderr, fallback) {
  const lines = (stderr || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || fallback;
}

/** fork(), collected: resolves to {code, stdout, stderr} once the script exits. */
function forkScript(script, args) {
  return new Promise((resolve, reject) => {
    // Not blocking: spawnSync, which the callers once used, froze every other
    // request for the whole life of the subprocess, and the bulk-add screen
    // asks for five cards at a time (see BulkRun.js's CONCURRENCY).
    const child = fork(path.join(PLUSAUDIO_DIR, script), args, {
      cwd: PLUSAUDIO_DIR,
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      ...FORK_IPC_OPTIONS,
    });
    serveGate(child);
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

/**
 * Run `plusaudio/<script>` with `args` and resolve to its stdout. A non-zero
 * exit, or a subprocess that never started, rejects with an Error whose
 * message is the script's own failure message - a RateLimitedError or a
 * DailyCapError when the script said which (see TYPED FAILURES above).
 */
export async function runPlusaudio(script, args, fallback) {
  let result;
  try {
    result = await forkScript(script, args);
  } catch (error) {
    throw new Error(error.message || fallback);
  }
  const { code, stdout, stderr } = result;
  if (code === 0) return stdout;

  if (stderr) console.error(`plusaudio/${script} failed:\n${stderr.trimEnd()}`);
  const message = failureMessage(stderr, fallback);
  if (code === RATE_LIMITED_EXIT) {
    const retryAfterMs = parseRetryAfter(stdout);
    if (retryAfterMs !== null) throw new RateLimitedError(message, retryAfterMs);
  }
  if (code === DAILY_CAP_EXIT) throw new DailyCapError(message);
  throw new Error(message);
}
