'use strict';

// Every process a test or a drive starts (the amgi server, collection_cli, the anki library's
// Python, the add-on's bridge, the fake Gemini) runs with a fresh, empty temp HOME of its own and
// no XDG_DATA_HOME, so nothing it does can reach a real Anki profile
// (~/Library/Application Support/Anki2) or a real amgi config. Incident 18:42
// (~/Dev/foolish-reports/incident-1842.md): a server a person's tools started opened a real
// collection while Anki had it open, and Anki's close then zeroed it. test/sandbox-home.test.mjs
// holds every spawn in the test code to this module.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];
process.once('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** The person's real home, whatever HOME says. */
function realHome() {
  return fs.realpathSync(os.userInfo().homedir);
}

/** Whether `a` is `b` or inside it. */
function within(a, b) {
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throws unless `env` is a sandbox: a HOME that is not the real one, under no Anki2, no XDG_DATA_HOME. */
function assertSandboxed(env) {
  if (!env || !env.HOME) throw new Error('sandbox: no HOME in the child environment');
  if ('XDG_DATA_HOME' in env) throw new Error('sandbox: XDG_DATA_HOME is set in the child environment');
  const home = fs.realpathSync(env.HOME);
  const real = realHome();
  if (within(home, real) || within(real, home)) {
    throw new Error(`sandbox: refusing to start a child with HOME=${env.HOME}, the real home or inside it`);
  }
  if (fs.existsSync(path.join(home, 'Library', 'Application Support', 'Anki2'))) {
    throw new Error(`sandbox: HOME=${env.HOME} holds an Anki2 profile folder`);
  }
  return env;
}

/**
 * The environment for one child: PATH and TMPDIR from this process, a fresh empty HOME made for
 * this child alone (removed when this process exits), and `extra`. Nothing else of the caller's
 * environment is passed on.
 */
function sandboxEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-home-'));
  made.push(home);
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return assertSandboxed(env);
}

module.exports = { assertSandboxed, sandboxEnv };
