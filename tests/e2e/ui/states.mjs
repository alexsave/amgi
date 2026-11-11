// What the decks screen shows in each state amgi's setup can be in, against folders of their own
// (each built fresh here):
//   ready, no profile picked yet: the profile is picked, and the list shows at /decks, no setup
//   installed, the card type not in the collection: the list, the notice to restart Anki, and on a
//     deck the form's hint that Anki adds the card type at its next start
//   Anki locked (a real lock, held by the anki library): the list's place says why, the badge too
//   an Anki folder with no profile: the setup screen, "Could not find an Anki profile"
//   no Anki folder: the setup screen says so, and Install is off
//   an Anki add-on from an older amgi: the badge and the list's place say to install again
//   a damaged collection (zero pages, as Anki's close left Alex's at 18:42): the badge and the
//     list's place say amgi did not open it, and the file is byte for byte as it was
// Needs ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG (the e2e-ui skill).
//   node tests/e2e/ui/states.mjs <base url> <name> <work dir> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv } from '../../../test/sandbox-home.cjs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const cdom = process.env.CDOM || path.join(root, 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');
const { holdCollectionOpen } = createRequire(import.meta.url)('../../server/plusaudio/collection/helpers/anki-python.js');
const [base, name, work, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', '..', '..', 'ui', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, env: sandboxEnv({ ANKI_PYTHON_BIN: process.env.ANKI_PYTHON_BIN, ANKI_FIXTURE_APKG: process.env.ANKI_FIXTURE_APKG }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// A folder as one profile, "User 1", from the UI fixture; installed fully, add-ons only, or not at all.
function folder(dirName, install) {
  const dir = sh(path.join(here, 'flows.sh'), [path.join(root, '.e2e', 'fixture'), path.join(work, dirName)]);
  if (install) sh(process.execPath, ['tests/e2e/ui/fixture-install.mjs', dir, ...(install === 'addons' ? ['--addons-only'] : [])]);
  return dir;
}
// The base fixture, before amgi touched it: no card type in the collection.
function bareFolder(dirName) {
  const dir = path.join(work, dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'User 1'), { recursive: true });
  sh(process.execPath, ['.claude/skills/e2e-ui/scripts/fixture.js', path.join(dir, 'User 1')]);
  return dir;
}

async function until(b, expr, tries = 100) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await b.evaluate(expr);
    if (v) return v;
    await sleep(100);
  }
  return v;
}
async function goto(b, url) {
  await b.send('Page.navigate', { url });
  await until(b, `document.readyState === 'complete'`);
}
// A new browser profile for each state: nothing remembered but what is seeded.
async function open(settings) {
  const b = await launchChrome();
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await seed(b, base, { baseDir: settings.base, collection: settings.collection || '', ...settings.bridge });
  return b;
}
const shot = async (b, file) => {
  const { result } = await b.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}-${file}.png`), Buffer.from(result.data, 'base64'));
};
const badge = `document.querySelector('nav.navbar span[title]')?.textContent`;
const steps = `[...document.querySelectorAll('.first-run-step-text')].map(s => s.textContent).join(' | ')`;

const watchdog = setTimeout(() => {
  console.log('FAIL the drive took more than 5 minutes');
  process.exit(1);
}, 300000);
let b;
try {
  // 1. Ready, no profile picked yet: picked, and straight to the list.
  const ready = folder('state-ready', 'all');
  b = await open({ base: ready });
  await goto(b, `${base}/`);
  check(await until(b, `document.querySelectorAll('.deck-item').length === 7 && !document.querySelector('.first-run') && location.pathname === '/decks'`, 150),
    `ready: the profile is picked and the list shows at /decks (${await b.evaluate('location.pathname')}, ${await b.evaluate(steps)})`);
  check(await b.evaluate(badge) === 'Anki connected', 'ready: the badge says connected');
  await sleep(300);
  await shot(b, '40-ready');
  await b.close();
  b = null;

  // 2. Installed, the card type not in the collection yet.
  const behind = bareFolder('state-behind');
  sh(process.execPath, ['tests/e2e/ui/fixture-install.mjs', behind, '--addons-only']);
  b = await open({ base: behind, collection: path.join(behind, 'User 1', 'collection.anki2') });
  await goto(b, `${base}/decks`);
  check(await until(b, `document.querySelectorAll('.deck-item').length > 0 && document.querySelector('.template-update.is-behind strong')?.textContent === 'restart Anki'`, 150),
    'card type missing: the list, and the notice to restart Anki');
  await sleep(300);
  await shot(b, '41-card-type-missing');
  const i = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === 'Existing')`);
  await b.evaluate(`document.querySelectorAll('.deck-item')[${i}].click()`);
  await until(b, `/Restart Anki once/.test(document.querySelector('.card-form-hint')?.textContent || '')`, 150);
  const hint = await b.evaluate(`document.querySelector('.card-form-hint')?.textContent`);
  check(/Restart Anki once and it will add the “amgi Listening” card type/.test(hint || ''), `card type missing: the deck's form says Anki adds it (${hint})`);
  await b.close();
  b = null;

  // 3. Anki locked: a real lock on the collection.
  const locked = folder('state-locked', 'all');
  const collection = path.join(locked, 'User 1', 'collection.anki2');
  const holder = holdCollectionOpen(collection);
  let released = false;
  await holder.held;
  try {
    b = await open({ base: locked, collection });
    await goto(b, `${base}/decks`);
    check(await until(b, `${badge} === 'Anki locked'`, 150), 'locked: the badge says so');
    const why = await until(b, `document.querySelector('.empty-deck-state p')?.textContent`, 100);
    check(/Anki is open and the bridge is not reachable/.test(why || ''), `locked: the list's place says why (${why})`);
    await sleep(300);
    await shot(b, '42-locked');
    // Anki quits: the next status poll (every 4 s) finds the file free again.
    await holder.release();
    released = true;
    check(await until(b, `${badge} === 'Anki connected'`, 150), 'locked: once Anki lets go, the badge says connected again');
    check(await until(b, `document.querySelectorAll('.deck-item').length > 0`, 100), 'locked: and the list comes back');
    await b.close();
    b = null;
  } finally {
    if (!released) await holder.release();
  }

  // 4. An Anki folder with no profile in it.
  const empty = path.join(work, 'state-empty');
  fs.rmSync(empty, { recursive: true, force: true });
  fs.mkdirSync(empty, { recursive: true });
  b = await open({ base: empty });
  await goto(b, `${base}/decks`);
  check(await until(b, `/Could not find an Anki profile/.test(${steps})`, 150), 'no profile: the setup screen says it found none');
  check(await b.evaluate(`!document.querySelector('.first-run-cta').disabled`), 'no profile: Install is still on');
  await sleep(300);
  await shot(b, '43-no-profile');
  await b.close();
  b = null;

  // 5. No Anki folder at all.
  b = await open({ base: path.join(work, 'state-nowhere') });
  fs.rmSync(path.join(work, 'state-nowhere'), { recursive: true, force: true });
  await goto(b, `${base}/decks`);
  check(await until(b, `/No Anki data folder on this machine/.test(document.querySelector('.first-run-error')?.textContent || '')`, 150), 'no folder: the setup screen says so');
  check(await b.evaluate(`document.querySelector('.first-run-cta').disabled`), 'no folder: Install is off');
  await sleep(300);
  await shot(b, '44-no-folder');
  await b.close();
  b = null;

  // 6. Anki open with an amgi add-on from an older amgi: one that still speaks JSON, as every
  // add-on before the binary bridge did (a stand-in on a free port, answering as it would).
  const old = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"profileOpen":true,"collectionOpen":true}');
  });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  try {
    const held = folder('state-outdated', 'all');
    const heldCollection = path.join(held, 'User 1', 'collection.anki2');
    b = await open({ base: held, collection: heldCollection,
      bridge: { bridgeUrl: `http://127.0.0.1:${old.address().port}`, bridgeToken: 'old-token' } });
    await goto(b, `${base}/decks`);
    check(await until(b, `${badge} === 'Anki: update amgi'`, 150), 'outdated add-on: the badge says to update');
    const how = await until(b, `document.querySelector('.empty-deck-state p')?.textContent`, 100);
    check(/Press Install into Anki again \(Settings\), then restart Anki/.test(how || ''), `outdated add-on: the list's place says how (${how})`);
    await sleep(300);
    await shot(b, '45-addon-outdated');
    await b.close();
    b = null;
  } finally {
    await new Promise((resolve) => old.close(resolve));
  }

  // 7. A damaged collection: zero pages where SQLite's header should be (incident 18:42).
  const damaged = folder('state-damaged', 'all');
  const zeroed = path.join(damaged, 'User 1', 'collection.anki2');
  fs.writeFileSync(zeroed, Buffer.alloc(4096 * 58));
  const zeroes = fs.readFileSync(zeroed);
  b = await open({ base: damaged, collection: zeroed });
  await goto(b, `${base}/decks`);
  check(await until(b, `${badge} === 'Anki: damaged'`, 150), 'damaged: the badge says so');
  const said = await until(b, `document.querySelector('.empty-deck-state p')?.textContent`, 100);
  check(/The collection file is damaged; amgi did not open it/.test(said || ''), `damaged: the list's place says why (${said})`);
  await sleep(300);
  await shot(b, '46-damaged');
  await b.close();
  b = null;
  check(fs.readFileSync(zeroed).equals(zeroes), 'damaged: the file is byte for byte as it was');
  check(['collection.anki2-wal', 'collection.anki2-shm', 'collection.anki2-journal']
    .every((f) => !fs.existsSync(path.join(damaged, 'User 1', f))), 'damaged: nothing made beside it');
} catch (error) {
  failures.push(`the drive stopped: ${error.stack || error}`);
  console.log(`FAIL the drive stopped: ${error.stack || error}`);
} finally {
  clearTimeout(watchdog);
  if (b) await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
