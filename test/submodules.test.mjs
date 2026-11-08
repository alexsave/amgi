// server/tools/submodules.sh, which npm start, dev, build, test and e2e run first: an existing clone
// that pulls the commit adding a submodule (cbase), or a clone made without --recurse-submodules,
// has the submodule's folder empty, and the script checks it out itself with one line saying so.
//
// Real git, never the real repo: each case builds a throwaway superproject in a temp folder, with
// cdom and cbase as submodules of local stand-in repos, holding a copy of the script at its real
// path (server/tools/), and clones it the way a user's clone would be.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'server', 'tools', 'submodules.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-submodules-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The local stand-ins are file:// remotes, which git refuses for submodules unless allowed; the
// author and committer are fixed so no global git config is needed.
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: ENV, stdio: 'pipe' }).toString();

function repoWith(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text, { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', name);
  return dir;
}

/** A superproject with cdom and cbase as submodules and the script at server/tools/submodules.sh. */
function superproject(name) {
  const cdom = repoWith(`${name}-cdom`, { 'src/cdom.c': '' });
  const cbase = repoWith(`${name}-cbase`, { 'cbase.mk': '' });
  const top = repoWith(name, { 'server/tools/submodules.sh': fs.readFileSync(SCRIPT, 'utf8') });
  git(top, 'submodule', 'add', '-q', cdom, 'cdom');
  git(top, 'submodule', 'add', '-q', cbase, 'cbase');
  git(top, 'commit', '-qm', 'submodules');
  return top;
}

function run(dir) {
  const r = spawnSync(path.join(dir, 'server/tools/submodules.sh'), { cwd: dir, env: ENV, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

test('a clone without its submodules: the script checks them out and says so in one line', () => {
  const top = superproject('plain');
  const clone = path.join(tmp, 'plain-clone');
  git(tmp, 'clone', '-q', top, clone);
  assert.equal(fs.existsSync(path.join(clone, 'cbase/cbase.mk')), false, 'the clone starts without cbase');
  const r = run(clone);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(clone, 'cbase/cbase.mk')), 'cbase is checked out');
  assert.ok(fs.existsSync(path.join(clone, 'cdom/src/cdom.c')), 'cdom is checked out');
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^amgi: checking out the submodules .*git submodule update --init --recursive$/);
});

test('an existing clone that pulls the commit adding cbase: only the missing cbase.mk triggers it', () => {
  const top = superproject('pull');
  const clone = path.join(tmp, 'pull-clone');
  git(tmp, 'clone', '-q', top, clone);
  git(clone, 'submodule', 'update', '-q', '--init', 'cdom');
  assert.ok(fs.existsSync(path.join(clone, 'cdom/src')), 'cdom was already there');
  assert.equal(fs.existsSync(path.join(clone, 'cbase/cbase.mk')), false);
  const r = run(clone);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(clone, 'cbase/cbase.mk')), 'cbase is checked out');
  assert.match(r.stderr, /^amgi: checking out the submodules/);
});

test('a clone with both checked out: the script is silent and touches nothing', () => {
  const top = superproject('full');
  const clone = path.join(tmp, 'full-clone');
  git(tmp, 'clone', '-q', '--recurse-submodules', top, clone);
  const r = run(clone);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('not a git checkout (a tarball): a clear error, not a bare make failure', () => {
  const top = superproject('tarball');
  const copy = path.join(tmp, 'tarball-copy');
  fs.mkdirSync(path.join(copy, 'server/tools'), { recursive: true });
  fs.copyFileSync(path.join(top, 'server/tools/submodules.sh'), path.join(copy, 'server/tools/submodules.sh'));
  fs.chmodSync(path.join(copy, 'server/tools/submodules.sh'), 0o755);
  const r = run(copy);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git checkout: clone with --recurse-submodules/);
});

test('a submodule left at another commit than the repo records: named, not changed', () => {
  const top = superproject('moved');
  const clone = path.join(tmp, 'moved-clone');
  git(tmp, 'clone', '-q', '--recurse-submodules', top, clone);
  git(path.join(clone, 'cbase'), 'commit', '-q', '--allow-empty', '-m', 'local');
  const head = git(path.join(clone, 'cbase'), 'rev-parse', 'HEAD');
  const r = run(clone);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^amgi: the submodule\(s\) cbase are checked out at another commit/);
  assert.equal(git(path.join(clone, 'cbase'), 'rev-parse', 'HEAD'), head, 'the local commit is left alone');
});
