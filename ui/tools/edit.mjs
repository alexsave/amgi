// Editing on the deck page, against a copy of the UI fixture that each run builds fresh
// (ui/tools/flows.sh): a card opened in its row and a field changed (saved when the field is left),
// Redo with Gemini unreachable (the error shown, nothing written), a row deleted after the
// page's own confirmation (Cancel first, then Delete), and the deck renamed in place (Escape
// abandons, Enter saves). Either app: APP=react seeds React's localStorage and answers
// window.confirm through CDP's dialog event.
//
//   node ui/tools/edit.mjs <base url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { launch, sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const [base, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const react = process.env.APP === 'react';
const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
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
async function seed(b) {
  await goto(b, `${base}/__seed__`);
  if (react) {
    const s = { baseDirOverride: ankiDir, collectionPath: collection, profileName: 'User 1', bridge: { baseUrl: 'http://127.0.0.1:8798', token: '' } };
    await b.evaluate(`localStorage.setItem('amgi:anki-settings', ${JSON.stringify(JSON.stringify(s))})`);
    return;
  }
  const block = [['X-Amgi-Base-Dir', ankiDir], ['X-Amgi-Collection', collection], ['X-Amgi-Profile', 'User 1'],
    ['X-Amgi-Bridge-Url', 'http://127.0.0.1:8798'], ['X-Amgi-Bridge-Token', '']].map(([k, v]) => `${k}: ${encodeURIComponent(v)}\n`).join('');
  await b.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('cdom', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(new TextEncoder().encode(${JSON.stringify(block)}), 'amgi:anki-settings:1');
      tx.oncomplete = () => { open.result.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
}
const shot = async (b, file) => {
  const { result } = await b.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}-${file}.png`), Buffer.from(result.data, 'base64'));
};
async function click(b, selector) {
  const box = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!box) throw new Error(`nothing to click at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}
const key = async (b, k, code, keyCode) => {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
};
const selectAll = (b) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
const rows = `[...document.querySelectorAll('.note-row-target')].map(e => e.textContent).join(' | ')`;

const b = await launch(['--hide-scrollbars']);
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 4 minutes');
  await b.close();
  process.exit(1);
}, 240000);
const pageErrors = [];
let dialogs = []; // React's window.confirm, answered by the next value in this list
b.onEvent = (d) => {
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Page.javascriptDialogOpening') b.send('Page.handleJavaScriptDialog', { accept: dialogs.shift() ?? false });
};
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await seed(b);
  await goto(b, `${base}/decks`);
  await until(b, `document.querySelectorAll('.deck-item').length === 7`, 150);
  const i = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === '한국어')`);
  await click(b, `.deck-item:nth-child(${i + 1})`);
  check(await until(b, `document.querySelectorAll('.note-rows > li').length === 4`, 150), 'the deck page, four notes');

  // 1. A card opened in its row; Target changed; saved when the field is left (Enter).
  await click(b, '.note-rows > li:nth-child(3) .note-row-edit');
  check(await until(b, `!!document.querySelector('.note-rows > li.is-open .card-panel') && document.querySelector('.note-rows > li:nth-child(3) .note-row-edit').textContent === 'Close'`), 'Edit opens the card, the button says Close');
  const labels = await b.evaluate(`[...document.querySelectorAll('.card-panel-label')].map(l => l.textContent).join('|')`);
  check(labels === '한국어|English|Notes optional', `the fields are named by language: ${labels}`);
  const redo = await b.evaluate(`[...document.querySelectorAll('.card-panel-redo')].map(l => l.textContent).join('|')`);
  check(redo === 'Redo 한국어|Redo English', `the redo buttons: ${redo}`);
  await sleep(300);
  await shot(b, '20-panel');
  await click(b, '.card-panel-value-big');
  await selectAll(b);
  await b.send('Input.insertText', { text: '안녕하세요!' });
  await key(b, 'Enter', 'Enter', 13);
  await sleep(1500);
  await click(b, '.note-rows > li:nth-child(3) .note-row-edit'); // Close
  await goto(b, `${base}${await b.evaluate('location.pathname')}`);
  await until(b, `document.querySelectorAll('.note-rows > li').length === 4`, 150);
  check(/안녕하세요!/.test(await b.evaluate(rows)), `the change is in Anki: ${await b.evaluate(rows)}`);

  // 2. Redo with Gemini unreachable: the error, under the clips.
  await click(b, '.note-rows > li:nth-child(3) .note-row-edit');
  await until(b, `!!document.querySelector('.card-panel')`);
  await click(b, '.card-panel-redo');
  const err = await until(b, `document.querySelector('.card-panel-error')?.textContent`, 300);
  check(/Failed to generate valid audio/.test(err || ''), `Redo says why it failed: ${err}`);
  check(await until(b, `[...document.querySelectorAll('.card-panel-redo')].every(b => !b.disabled)`), 'and the buttons come back');
  await sleep(300);
  await shot(b, '21-redo-failed');
  await click(b, '.note-rows > li:nth-child(3) .note-row-edit');

  // 3. A row deleted: Cancel keeps it, Delete takes it.
  if (react) dialogs = [false];
  await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
  if (!react) {
    check(await until(b, `!!document.querySelector('dialog.confirm-dialog[open]') && document.activeElement?.classList.contains('submit-btn')`), 'the page asks, in a modal dialog, the action focused');
    const asked = await b.evaluate(`document.querySelector('dialog.confirm-dialog p')?.textContent`);
    check(asked === '역이 어디예요?', `it names the card: ${asked}`);
    await sleep(300);
    await shot(b, '22-confirm');
    await click(b, 'dialog.confirm-dialog .cancel-btn');
    check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Cancel closes it');
  }
  await sleep(500);
  check((await b.evaluate(rows)).startsWith('역이 어디예요?'), 'and the card is still there');
  if (react) dialogs = [true];
  await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
  if (!react) {
    await until(b, `!!document.querySelector('dialog.confirm-dialog[open]')`);
    await key(b, 'Escape', 'Escape', 27);
    check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Escape closes it too');
    await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
    await until(b, `!!document.querySelector('dialog.confirm-dialog[open]')`);
    await click(b, 'dialog.confirm-dialog .submit-btn');
  }
  check(await until(b, `document.querySelectorAll('.note-rows > li').length === 3 && !${rows}.includes('역이 어디예요?')`, 150), 'Delete takes the card');
  check(await until(b, `document.querySelector('.deck-cards-listhead span')?.textContent === '3'`, 100), 'and the count follows');

  // 4. The deck renamed in place: Escape abandons, Enter saves.
  await click(b, '.deck-name-button');
  check(await until(b, `document.activeElement?.classList.contains('deck-name-input')`), 'the name becomes a focused input');
  await b.send('Input.insertText', { text: ' 2' });
  await key(b, 'Escape', 'Escape', 27);
  check(await until(b, `document.querySelector('.deck-name-button')?.textContent === '한국어'`),
    `Escape leaves the name as it was (${await b.evaluate("document.querySelector('.deck-cards-title h1')?.outerHTML")}; ${pageErrors.join(' / ')})`);
  await click(b, '.deck-name-button');
  await until(b, `document.activeElement?.classList.contains('deck-name-input')`);
  // the caret starts where focus() puts it, at the start: to the end first, as a person would
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, commands: ['moveToEndOfLine'] });
  await b.send('Input.insertText', { text: ' 연습' });
  await key(b, 'Enter', 'Enter', 13);
  check(await until(b, `document.querySelector('.deck-name-button')?.textContent === '한국어 연습'`, 150),
    `Enter saves the new name (${await b.evaluate("document.querySelector('.deck-cards-title')?.innerHTML")})`);
  await sleep(300);
  await shot(b, '23-renamed');
  await goto(b, `${base}/decks`);
  check(await until(b, `[...document.querySelectorAll('.deck-item h3')].map(h => h.textContent).includes('한국어 연습::일상 표현')`, 150), 'the subdeck moved with it');

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
