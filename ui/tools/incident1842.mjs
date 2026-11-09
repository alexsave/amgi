// Incident 18:42, end to end: the page loaded twice while Anki holds the collection after its own
// backup dropped its lock, as it happened to Alex's collection.anki2 at 18:42 (all pages zero but
// two, header gone). The server and the Anki stand-in run with a temp HOME, on a copy of the
// schema18 fixture in it; Chrome keeps the real HOME (a temp one has no keychain, and macOS asks
// for one), with a profile of its own (cdom/tools/cdp.mjs):
//
//   1. <HOME>/Anki2/User 1/collection.anki2, a copy, with amgi's add-ons installed and its note type
//      not yet in the collection (ui/tools/fixture-install.mjs --addons-only), so every page load's
//      template check finds the collection behind and, when the server says Anki is closed,
//      POSTs /api/anki/install on its own (ui/src/template.c), a write into the collection;
//   2. server/build/anki_standin plays Anki: exclusive WAL, its backup's lock drop, a whole-file
//      transaction in the -wal, then it waits ("held");
//   3. the C server, on a free port, and headless Chrome loading /decks twice in that window;
//   4. the stand-in's last transaction and close;
//   5. the file: SQLite's header, no zero page, integrity_check ok, notes and cards as before, and,
//      with ANKI_PYTHON_BIN, the anki library opens it and Check Database passes.
// And during the window the page said "Anki locked" and sent no POST /api/anki/install.
//
// Red before the fix (02df77a: the server opens the collection, its auto-install writes, and Anki's
// close writes the hole as zeros), green with it (dbf48a1: a -wal or -shm beside the collection is
// "locked", never opened).
//
//   node ui/tools/incident1842.mjs <empty temp dir>      (ui/tools/incident1842.sh does it all)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';
import { startServer } from '../../test/parity/servers.mjs';
import { sandboxEnv } from '../../test/sandbox-home.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cdom = process.env.CDOM || path.join(root, 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');

const home = path.resolve(process.argv[2] || '');
// Never the real HOME: the server's default Anki folder is under it. An empty folder under the
// temp folder only.
const real = fs.realpathSync(os.userInfo().homedir);
const tmp = fs.realpathSync(os.tmpdir());
if (!process.argv[2] || !fs.existsSync(home) || fs.realpathSync(home) === real ||
    !fs.realpathSync(home).startsWith(tmp + path.sep) || fs.readdirSync(home).length) {
  console.log(`FAIL refusing to run: the argument must be an empty folder under ${tmp}, not the real HOME (${real})`);
  process.exit(2);
}
// The folder holds the collection; the server, the installer and the Anki stand-in each run with a
// fresh temp HOME of their own besides (test/sandbox-home.cjs), and Chrome keeps the real one.

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const base = path.join(home, 'Anki2');
const profile = path.join(base, 'User 1');
const col = path.join(profile, 'collection.anki2');
fs.mkdirSync(profile, { recursive: true });
fs.copyFileSync(path.join(root, 'test', 'parity', 'fixtures', 'schema18', 'collection.anki2'), col);
execFileSync(process.execPath, [path.join(here, 'fixture-install.mjs'), base, '--addons-only'], { stdio: 'ignore', env: sandboxEnv() });
// One add-on file from an older amgi, so the page's template check finds the files behind and,
// when the server says Anki is closed, reinstalls on its own (the files, then the note type into
// the collection: the page load's write).
const addons = path.join(base, 'addons21');
const older = fs.readdirSync(addons).map((d) => path.join(addons, d, '__init__.py')).find((f) => fs.existsSync(f));
const shipped = fs.readFileSync(older);
const makeOlder = () => fs.writeFileSync(older, Buffer.concat([shipped, Buffer.from('\n# an older amgi\n')]));

// Counts and integrity through Python's own sqlite3, with Anki closed: read write, so its close
// takes away the -wal and -shm it made (a read-only one leaves them, and they would read as an Anki).
const py = (code) => execFileSync('python3', ['-I', '-c', code, col], { env: sandboxEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const counts = () => py(`import sqlite3,sys
d=sqlite3.connect(sys.argv[1])
d.create_collation('unicase',lambda a,b:(a.casefold()>b.casefold())-(a.casefold()<b.casefold()))
print(d.execute('pragma integrity_check').fetchone()[0], d.execute('select count(*) from notes').fetchone()[0], d.execute('select count(*) from cards').fetchone()[0])
d.close()`);
const before = counts().split(' ');
check(!fs.readdirSync(profile).some((f) => f.startsWith('collection.anki2-')), 'the copy has nothing beside it before Anki opens it');

// The file, raw: pages, zero pages, the header.
function shape() {
  const b = fs.readFileSync(col);
  let zero = 0;
  const pages = Math.floor(b.length / 4096);
  for (let i = 0; i < pages; i++) if (b.subarray(i * 4096, (i + 1) * 4096).every((v) => v === 0)) zero++;
  return { pages, zero, header: b.subarray(0, 16).toString('latin1') === 'SQLite format 3\0' };
}

const procs = [];
let server, b, anki;
const watchdog = setTimeout(() => { console.log('FAIL the drive took more than 2 minutes'); cleanup().then(() => process.exit(1)); }, 120000);
async function cleanup() {
  if (b) await b.close();
  if (server) await server.stop();
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
}
try {
  // 2. Anki, open and unlocked by its own backup, with a full -wal.
  anki = spawn(path.join(root, 'server', 'build', 'anki_standin'), [col], { stdio: ['pipe', 'pipe', 'inherit'], env: sandboxEnv() });
  procs.push(anki);
  let said = '';
  anki.stdout.setEncoding('utf8');
  anki.stdout.on('data', (c) => { said += c; });
  for (let i = 0; i < 100 && !said.includes('held'); i++) await sleep(50);
  check(said.includes('held'), 'the Anki stand-in holds the collection, its lock dropped by its backup');
  const beside = fs.readdirSync(profile).filter((f) => f.startsWith('collection.anki2-'));
  check(beside.includes('collection.anki2-wal') && !beside.includes('collection.anki2-shm'),
    `beside it, a -wal and no -shm, Anki's exclusive mode (${beside.join(' ') || 'nothing'})`);

  // 3. The server and the page, twice.
  server = await startServer({ key: '' });
  b = await launchChrome();
  await b.send('Network.enable');
  const requests = [];
  const pending = new Set();
  b.onEvent = (d) => {
    if (d.method === 'Network.requestWillBeSent') {
      requests.push(`${d.params.request.method} ${new URL(d.params.request.url).pathname}`);
      pending.add(d.params.requestId);
    }
    if (d.method === 'Network.loadingFinished' || d.method === 'Network.loadingFailed') pending.delete(d.params.requestId);
  };
  await seed(b, server.url, { baseDir: base, collection: col, profile: 'User 1' });
  const badge = `document.querySelector('nav.navbar span[title]')?.textContent || ''`;
  const badges = [];
  for (const load of [1, 2]) {
    makeOlder(); // each load meets files behind, so each one's check would reinstall
    const from = requests.length;
    await b.send('Page.navigate', { url: `${server.url}/decks` });
    // settled: the template check answered (GET /api/anki/install, and its POST and recheck if any)
    // and nothing in flight for a second
    let quiet = 0;
    for (let i = 0; i < 100 && quiet < 10; i++) {
      await sleep(100);
      const seen = requests.slice(from);
      const checked = seen.includes('GET /api/anki/install');
      quiet = checked && pending.size === 0 ? quiet + 1 : 0;
    }
    const seen = requests.slice(from);
    badges.push(await b.evaluate(badge));
    console.log(`load ${load}: ${seen.filter((r) => r.includes('/api/')).join(', ')}; badge "${badges.at(-1)}"`);
    check(seen.includes('GET /api/anki/install'), `load ${load}: the page ran its template check`);
    check(!seen.includes('POST /api/anki/install'), `load ${load}: no automatic install while Anki holds the file`);
    check(badges.at(-1) === 'Anki locked', `load ${load}: the page says Anki locked (it says "${badges.at(-1)}")`);
  }
  check(fs.existsSync(`${col}-wal`) && fs.statSync(`${col}-wal`).size > 0, 'Anki\'s -wal is still whole after the loads (nobody reset it)');

  // 4. Anki's last transaction and close.
  anki.stdin.end('close\n');
  const code = await new Promise((resolve) => (anki.exitCode !== null ? resolve(anki.exitCode) : anki.once('exit', resolve)));
  check(code === 0 && said.includes('closed'), `the Anki stand-in closed cleanly (exit ${code})`);

  // 5. The file.
  const s = shape();
  check(s.header, `collection.anki2 starts with SQLite's header (${s.pages} pages, ${s.zero} zero)`);
  check(s.zero === 0, `collection.anki2 has no zero page (${s.zero} of ${s.pages})`);
  let after = ['(does not open)'];
  try { after = counts().split(' '); } catch { /* not a database: after stays '(does not open)' */ }
  check(after[0] === 'ok', `integrity_check: ${after[0]}`);
  check(after[1] === before[1] && after[2] === before[2],
    `notes and cards as before (${before[1]} and ${before[2]}; now ${after[1]} and ${after[2]})`);
  if (process.env.ANKI_PYTHON_BIN) {
    let out = '';
    try {
      out = execFileSync(process.env.ANKI_PYTHON_BIN, ['-I', '-c', `import sys
from anki.collection import Collection
c=Collection(sys.argv[1])
problems,ok=c.fix_integrity()
print('checked' if ok else 'failed', c.note_count(), c.card_count(), '|', problems.replace(chr(10),' / '))
c.close()`, col], { env: sandboxEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) { out = `failed: ${String(e.stderr || e.message).split('\n').filter(Boolean).at(-1)}`; }
    check(out.startsWith('checked'), `the anki library opens it and Check Database passes: ${out}`);
  } else {
    console.log('note: ANKI_PYTHON_BIN unset, so the anki library check is skipped');
  }
} catch (e) {
  check(false, `the drive threw: ${e.stack || e}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log(`incident1842: ${failures.length ? `${failures.length} failed` : 'all ok'}`);
process.exit(failures.length ? 1 : 0);
