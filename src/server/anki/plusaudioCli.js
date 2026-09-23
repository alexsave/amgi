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

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// spawnSync, which the callers used to use, blocks the Node event loop for
// the whole life of the subprocess - and a clip or a card's text is several
// seconds of talking to OpenAI. That made this server incapable of having
// two requests in flight at once no matter what a caller did: the bulk-add
// screen asking for five cards at a time (see BulkRun.js's CONCURRENCY)
// would have had its five requests served strictly one after another. It
// also froze every unrelated request - a status poll, a deck page - for the
// duration.
const execFileAsync = promisify(execFile);

// Not named __dirname, for the reason starterDeck.js gives: jest compiles
// this to CommonJS, where that name is already taken.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUSAUDIO_DIR = path.join(HERE, '..', '..', '..', 'plusaudio');

/** The line of a failed run's stderr that says why it failed. */
function failureMessage(stderr, fallback) {
  const lines = (stderr || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || fallback;
}

/**
 * Run `plusaudio/<script>` with `args` and resolve to its stdout. A non-zero
 * exit, or a subprocess that never started, rejects with an Error whose
 * message is the script's own failure message.
 */
export async function runPlusaudio(script, args, fallback) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(PLUSAUDIO_DIR, script), ...args], {
      cwd: PLUSAUDIO_DIR,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (error.stderr) console.error(`plusaudio/${script} failed:\n${error.stderr.trimEnd()}`);
    throw new Error(failureMessage(error.stderr, error.message || fallback));
  }
}
