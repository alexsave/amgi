'use strict';

// How plusaudio's command-line scripts (generate-clip.js, generate-card-text.js)
// say "rate limited, try again in N ms" across the process boundary, so the
// caller on the other side (src/server/anki/plusaudioCli.js) gets the same
// typed answer the Gemini client gave, not a line of text to guess from.
//
// The protocol, documented in each script's own contract:
//   rate limited: exit code RATE_LIMITED_EXIT, and one stdout line
//                 `retry-after-ms=<n>` (the rate gate's own jittered wait);
//   daily cap:    exit code DAILY_CAP_EXIT (fatal; the day's quota is spent);
//   stderr's last line is still the human message, as for any failure.
// Plain JavaScript so the app's server code can use it too.

const RATE_LIMITED_EXIT = 3;
const DAILY_CAP_EXIT = 4;

/** The stdout line a rate-limited run ends with. */
function retryAfterLine(retryAfterMs) {
  return `retry-after-ms=${Math.max(0, Math.round(retryAfterMs))}\n`;
}

/** The wait a rate-limited run reported on stdout, or null when it did not say. */
function parseRetryAfter(stdout) {
  const match = /^retry-after-ms=(\d+)$/m.exec(stdout || '');
  return match ? Number(match[1]) : null;
}

/**
 * How a script ends on `error`: writes the human message (and, for a rate
 * limit, the retry line) and returns the exit code. One place, so the two
 * scripts cannot drift apart on the protocol.
 */
function exitForError(error, { stdout = process.stdout, stderr = process.stderr } = {}) {
  stderr.write(`${error.message}\n`);
  if (error && error.rateLimited === true) {
    stdout.write(retryAfterLine(error.retryAfterMs));
    return RATE_LIMITED_EXIT;
  }
  if (error && error.dailyCap === true) return DAILY_CAP_EXIT;
  return 1;
}

module.exports = { DAILY_CAP_EXIT, RATE_LIMITED_EXIT, exitForError, parseRetryAfter };
