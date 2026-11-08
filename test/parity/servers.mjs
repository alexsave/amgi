// Starting what the parity suites talk to, each on a free port, stopped by PID.
//
// The server under test is chosen by environment variable, so the same suite (and the browser
// drives, ui/tools/e2e.sh) runs against the Node server today and the C server later:
//   AMGI_SERVER unset           node ui/server/serve.mjs (removed at L4)
//   AMGI_SERVER=c               the C server: server/build/amgi serve (make -C server build/amgi)
//   AMGI_SERVER=<executable>    that program, run from the repo root with no arguments
// Either way it is asked for a free port (PORT=0 for the Node server, CBASE_LISTEN=127.0.0.1:0 for the
// C server on cbase serve) and must say where it listens on stdout: `amgi on http://127.0.0.1:<port>`
// (Node) or cbase's startup line, `cbase: listening 127.0.0.1:<port>`.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SERVER = process.env.AMGI_SERVER;

export const C_SERVER = path.join(ROOT, 'server', 'build', 'amgi');

function serverCommand() {
  if (SERVER === 'c') return [C_SERVER, ['serve']];
  return SERVER ? [SERVER, []] : [process.execPath, ['ui/server/serve.mjs']];
}

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
        resolve({ child, match: m.slice(1).find(Boolean), stop: () => stop(child) });
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} exited ${code} before it was ready:\n${out}${err}`));
    });
  });
}

/** Where the server says it listens: Node's line, or cbase's startup line (a URL either way). */
export const LISTENING = /amgi on (http:\/\/127\.0\.0\.1:\d+)|cbase: listening (127\.0\.0\.1:\d+)/;
const asUrl = (where) => (where.startsWith('http') ? where : `http://${where}`);

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
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: '0', CBASE_LISTEN: '127.0.0.1:0', GEMINI_API_KEY: key,
  };
  if (base) env.GEMINI_API_BASE = base;
  const [cmd, args] = serverCommand();
  const s = await startAndRead(cmd, args, env, LISTENING, 'the server under test');
  return { url: asUrl(s.match), stop: s.stop, pid: s.child.pid };
}

/** The tests' fake Gemini (plusaudio/test/helpers/fake-gemini.js), standalone, on its own free port. */
export async function startFakeGemini() {
  const s = await startAndRead(process.execPath, ['plusaudio/test/helpers/fake-gemini.js', '0'],
    { PATH: process.env.PATH, HOME: process.env.HOME }, /GEMINI_API_BASE=(\S+)/, 'the fake Gemini');
  return { url: s.match, stop: s.stop };
}
