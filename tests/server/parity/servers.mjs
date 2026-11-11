// Starting what the suites talk to, each on a free port, stopped by PID: the amgi server
// (server/build/amgi serve, on cbase; make -C server builds it), from the repo root, asked for a free
// port with CBASE_LISTEN=127.0.0.1:0, and ready once cbase's startup line names it
// (`cbase: listening 127.0.0.1:<port>`); and the tests' fake Gemini.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { sandboxEnv } from '../../../test/sandbox-home.cjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const SERVER = path.join(ROOT, 'server', 'build', 'amgi');

/** Start `cmd` and resolve with its child and the first match of `pattern` on its stdout. */
function startAndRead(cmd, args, env, pattern, what) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not start in 20 s:\n${out}${err}`)), 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = pattern.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, match: m[1], stop: () => stop(child) });
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} exited ${code} before it was ready:\n${out}${err}`));
    });
  });
}

/** cbase's startup line, which names where the server listens. */
export const LISTENING = /cbase: listening (127\.0\.0\.1:\d+)/;

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

/**
 * The app server under test, with the Gemini environment `gemini` ({key, base}): any key (the
 * screens), none (key: ''), or pointed at a fake. Nothing else of the caller's environment that
 * changes the server's answers is passed on.
 */
export async function startServer({ key = 'offline-dummy', base = 'http://127.0.0.1:9' } = {}) {
  const env = sandboxEnv({ CBASE_LISTEN: '127.0.0.1:0', GEMINI_API_KEY: key, GEMINI_API_BASE: base || undefined });
  const s = await startAndRead(SERVER, ['serve'], env, LISTENING, 'the amgi server');
  return { url: `http://${s.match}`, stop: s.stop, pid: s.child.pid };
}

/** The tests' fake Gemini (tests/server/plusaudio/helpers/fake-gemini.js), standalone, on its own free port. */
export async function startFakeGemini() {
  const s = await startAndRead(process.execPath, ['tests/server/plusaudio/helpers/fake-gemini.js', '0'],
    sandboxEnv(), /GEMINI_API_BASE=(\S+)/, 'the fake Gemini');
  return { url: s.match, stop: s.stop };
}
