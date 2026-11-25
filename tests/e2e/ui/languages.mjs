// A deck's languages, end to end: they are the deck's own (GET /decks has them), never a guess of the page's. Against the project's
// fake Gemini (its answer to "what languages is this deck" switched through POST /control) and a fresh copy of the UI fixture
// (tests/e2e/ui/flows.sh, amgi installed):
//   - a deck with a stored pair shows it at once, asks nothing, and Change rewrites it (checked in the file with Anki's own library),
//     refusing the same code on both sides, and saying the server's sentence when the write fails (a real lock);
//   - the deck the command line filled with zh_cn notes and no pair (the bug: it showed English -> 한국어) is worked out once, held
//     in flight to see the wait, and shows Chinese as the one learnt;
//   - a deck the server cannot decide opens its picker, nothing chosen (form off) or with the guess chosen, and Save stores it.
// Every state is shot at 1280 and at phone width.
//
//   node tests/e2e/ui/languages.mjs <base url> <fake gemini url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const { holdCollectionOpen, withAnkiLibrary } = createRequire(import.meta.url)('../../server/plusaudio/collection/helpers/anki-python.js');
const { controlFake } = createRequire(import.meta.url)('../../server/plusaudio/helpers/fake-gemini.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome, shotter } = await import('./chrome.mjs');
const [base, gemini, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', '..', '..', 'ui', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
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
const shoot = shotter(out, name);
async function click(b, selector) {
  const box = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!box) throw new Error(`nothing to click at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}
const control = (q) => controlFake(gemini, q);
// The deck's stored pair as Anki's own library reads it from the file, or ''.
const stored = (deck) => withAnkiLibrary(collection, `print(col.decks.by_name(${JSON.stringify(deck)}).get("amgiLanguages", ""))`).trim();

const sub = `document.querySelector('.deck-cards-sub')?.textContent`;
const placeholder = `document.querySelector('#amgiCardInput')?.placeholder`;
const formOff = `document.querySelector('#amgiCardInput')?.disabled`;
const selects = `[...document.querySelectorAll('.deck-langs select')].map(s => s.value).join(' ')`;
const saveOff = `[...document.querySelectorAll('.deck-langs button')].find(x => x.textContent === 'Save')?.disabled`;
const noScroll = `document.documentElement.scrollWidth <= innerWidth`;

const b = await launchChrome();
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 4 minutes');
  await b.close();
  process.exit(1);
}, 240000);
const pageErrors = [];
const paused = [];
let detects = 0; // POST .../languages/detect calls the page made
b.onEvent = (d) => {
  if (d.method === 'Fetch.requestPaused') paused.push(d.params.requestId);
  if (d.method === 'Network.requestWillBeSent' && d.params.request.url.endsWith('/languages/detect')) detects++;
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
// A shot at 1280 and at phone width, the page not wider than the window at either.
async function both(file, what) {
  for (const [m, tag] of [[DESKTOP, ''], [PHONE, '-phone']]) {
    await b.send('Emulation.setDeviceMetricsOverride', m);
    await sleep(300);
    check(await b.evaluate(noScroll), `${what}: no horizontal scroll at ${m.width}`);
    await shoot(b, file + tag);
  }
  await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
}
async function openDeck(deckName) {
  await goto(b, `${base}/decks`);
  await until(b, `document.querySelectorAll('.deck-item').length > 0`, 150);
  const i = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === ${JSON.stringify(deckName)})`);
  if (i < 0) throw new Error(`no deck row ${deckName}`);
  await click(b, `.deck-item:nth-child(${i + 1})`);
  await until(b, `document.querySelector('.deck-name-button')?.textContent === ${JSON.stringify(deckName)}`, 150);
}
async function pick(side, code) {
  await b.evaluate(`(() => { const s = document.querySelectorAll('.deck-langs select')[${side}]; s.value = ${JSON.stringify(code)};
    s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
}
try {
  await control('perMinute=1000&daily=0');
  await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await b.send('Network.enable');
  await seed(b, base, { baseDir: ankiDir, collection, profile: 'User 1' });

  // 1. A deck with a stored pair: drawn at once, nothing asked.
  await openDeck('한국어');
  check(await until(b, `${sub}?.includes('English → 한국어')`), `a stored pair is shown (${await b.evaluate(sub)})`);
  check(detects === 0, `nothing was asked for it (${detects} detect requests)`);
  check(!(await b.evaluate(formOff)) && (await b.evaluate(placeholder)).startsWith('Type or paste in English or 한국어'), 'the form is on, in that pair');
  await both('50-stored', 'a stored pair');

  // 2. Change: the two selects and Save; the same code on both sides refused; Save writes the file.
  await click(b, '.deck-langs button');
  check(await until(b, `${selects} === 'en ko' && ${saveOff} === false`), 'Change opens the selects on the pair, Save on');
  await both('51-change', 'Change open');
  await pick(1, 'en');
  check((await b.evaluate(selects)) === 'en ko', `the learning side refuses the known side's code (${await b.evaluate(selects)})`);
  await pick(0, 'ko');
  check((await b.evaluate(selects)) === 'en ko', `and the known side the learning side's (${await b.evaluate(selects)})`);
  await pick(1, 'ja');
  check((await b.evaluate(selects)) === 'en ja', 'the learning side takes another language');
  check(stored('한국어') === 'en ko', 'nothing is written until Save');
  // a write that fails: Anki holds the file; the server's sentence under the line, the selects as chosen
  const holder = holdCollectionOpen(collection);
  await holder.held;
  try {
    await until(b, `document.querySelector('nav.navbar span[title]')?.textContent === 'Anki locked'`, 150);
    await click(b, '.deck-langs button');
    const err = await until(b, `document.querySelector('.deck-cards-title .deck-name-error')?.textContent`, 100);
    check(!!err && (await b.evaluate(selects)) === 'en ja' && !(await b.evaluate(`document.querySelector('.deck-langs select').disabled`)),
      `a failed save says why under the line and keeps the choice (${err} / ${await b.evaluate(selects)})`);
    await both('52-save-failed', 'a failed save');
  } finally {
    await holder.release();
  }
  await until(b, `document.querySelector('nav.navbar span[title]')?.textContent === 'Anki connected'`, 150);
  await sleep(500);
  await click(b, '.deck-langs button'); // Save
  check(await until(b, `${sub}?.includes('English → 日本語')`), `Save shows the new pair (${await b.evaluate(sub)})`);
  check(!(await b.evaluate(`!!document.querySelector('.deck-name-error')`)), 'the failure is gone');
  check(stored('한국어') === 'en ja', `and Anki's library reads it from the file: ${stored('한국어')}`);
  check((await b.evaluate(placeholder)).startsWith('Type or paste in English or 日本語'), 'the form follows');
  await click(b, '.deck-langs button');
  await click(b, '.deck-langs button:last-child');
  check(await until(b, `${sub}?.includes('English → 日本語') && !document.querySelector('.deck-langs select')`), 'Cancel closes the selects, the pair as it was');

  // 3. The deck the command line filled with zh_cn notes and no pair (the bug): worked out once, held in flight.
  await control('languages=zh_cn,en,high');
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/languages/detect', requestStage: 'Request' }] });
  detects = 0;
  await openDeck('Chinese');
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(100);
  check(paused.length === 1 && (await b.evaluate(sub)).includes("Finding this deck's languages…") && !(await b.evaluate(`!!document.querySelector('.deck-langs button')`)),
    `while it is asked the line says so (${await b.evaluate(sub)})`);
  await until(b, `!!document.querySelector('#amgiCardInput')`);
  check((await b.evaluate(formOff)) === true && (await b.evaluate(placeholder)) === "Finding this deck's languages…", `and the form is off (${await b.evaluate(formOff)} / ${await b.evaluate(placeholder)})`);
  await both('53-finding', 'finding');
  for (const id of paused.splice(0)) await b.send('Fetch.continueRequest', { requestId: id });
  await b.send('Fetch.disable');
  check(await until(b, `${sub}?.includes('English → 中文')`), `answered and stored: English to Chinese, never 한국어 (${await b.evaluate(sub)})`);
  check(!(await b.evaluate(`${sub}.includes('한국어')`)) && !(await b.evaluate(formOff)), 'the form is on');
  check(stored('Chinese') === 'en zh_cn', `Anki's library reads it from the file: ${stored('Chinese')}`);
  await both('54-found', 'found and stored');
  await openDeck('Chinese');
  check(await b.evaluate(`${sub}.includes('English → 中文')`) && detects === 1, `opened again it is drawn at once and asked for no more (${detects} requests)`);

  // 4. A deck the server cannot decide: nothing chosen, the form off; then the guess chosen, Save stores it.
  await control('languages=fail');
  detects = 0;
  await openDeck('Showcase source');
  check(await until(b, `${selects} === ' '`) && (await b.evaluate(saveOff)) === true, `no guess: the picker opens with nothing chosen, Save off (${await b.evaluate(selects)})`);
  check((await b.evaluate(`[...document.querySelectorAll('.deck-langs select')].map(s => s.selectedOptions[0].textContent).join('|')`)) === 'Choose…|Choose…', 'both say Choose…');
  check((await b.evaluate(formOff)) === true && (await b.evaluate(placeholder)) === "Choose this deck's languages first", 'the form is off and says why');
  await both('55-picker-empty', 'the empty picker');
  await pick(0, 'en');
  check((await b.evaluate(saveOff)) === true, 'one side chosen: Save still off');
  await control('languages=ko,en,low');
  await openDeck('Showcase source');
  check(await until(b, `${selects} === 'en ko'`) && (await b.evaluate(saveOff)) === false, `a guess is chosen for the person (${await b.evaluate(selects)}), Save on`);
  check((await b.evaluate(formOff)) === true, 'the form stays off until it is saved');
  check(stored('Showcase source') === '', 'nothing is stored by a guess');
  await both('56-picker-guess', 'the picker with a guess');
  await click(b, '.deck-langs button');
  check(await until(b, `${sub}?.includes('English → 한국어') && !${formOff}`), `Save stores it and the form comes on (${await b.evaluate(sub)})`);
  check(stored('Showcase source') === 'en ko', `Anki's library reads it from the file: ${stored('Showcase source')}`);
  await goto(b, `${base}/decks`);
  await until(b, `document.querySelectorAll('.deck-item').length > 0`, 150);

  await control('languages=ko,en,high'); // the fake as the next drive expects it
  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
