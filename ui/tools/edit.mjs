// Editing on the deck page, against a copy of the UI fixture that each run builds fresh
// (ui/tools/flows.sh): a card opened in its row and a field changed (saved when the field is left),
// Redo with Gemini unreachable (the error shown, nothing written), a row deleted after the
// page's own confirmation (Cancel first, then Delete), and the deck renamed in place (Escape
// abandons, Enter saves)..
//
//   node ui/tools/edit.mjs <base url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { seed } from './seed.mjs';

const { holdCollectionOpen } = createRequire(import.meta.url)('../../tests/server/plusaudio/collection/helpers/anki-python.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');
const [base, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
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

const b = await launchChrome();
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 4 minutes');
  await b.close();
  process.exit(1);
}, 240000);
const pageErrors = [];
b.onEvent = (d) => {
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await seed(b, base, { baseDir: ankiDir, collection, profile: 'User 1' });
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
  await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
  check(await until(b, `!!document.querySelector('dialog.confirm-dialog[open]') && document.activeElement?.classList.contains('submit-btn')`), 'the page asks, in a modal dialog, the action focused');
  const asked = await b.evaluate(`document.querySelector('dialog.confirm-dialog p')?.textContent`);
  check(asked === '역이 어디예요?', `it names the card: ${asked}`);
  await sleep(300);
  await shot(b, '22-confirm');
  await click(b, 'dialog.confirm-dialog .cancel-btn');
  check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Cancel closes it');
  await sleep(500);
  check((await b.evaluate(rows)).startsWith('역이 어디예요?'), 'and the card is still there');
  await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
  await until(b, `!!document.querySelector('dialog.confirm-dialog[open]')`);
  await key(b, 'Escape', 'Escape', 27);
  check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Escape closes it too');
  await click(b, '.note-rows > li:nth-child(1) .note-row-delete');
  await until(b, `!!document.querySelector('dialog.confirm-dialog[open]')`);
  await click(b, 'dialog.confirm-dialog .submit-btn');
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

  // 5. Anki takes the file while a card is open with unsaved typing, then lets it go: the page's
  // status poll (every 4 s) sees both mode changes and reloads the deck under the editor, which must
  // stay open with its text, its caret and its focus. A real lock, held by the anki library.
  await click(b, '.deck-item:nth-child(' + (1 + await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === '한국어 연습')`)) + ')');
  await until(b, `document.querySelectorAll('.note-rows > li').length === 3`, 150);
  await click(b, '.note-rows > li:nth-child(2) .note-row-edit');
  await until(b, `!!document.querySelector('.card-panel-value-big')`);
  await click(b, '.card-panel-value-big');
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, commands: ['moveToEndOfLine'] });
  await b.send('Input.insertText', { text: ' 아직' });
  const typed = await b.evaluate(`document.querySelector('.card-panel-value-big').value`);
  const kept = `!!document.querySelector('.note-rows > li.is-open .card-panel') && document.querySelector('.card-panel-value-big')?.value === ${JSON.stringify(typed)} && document.activeElement === document.querySelector('.card-panel-value-big')`;
  const badge = `document.querySelector('nav.navbar span[title]')?.textContent`;
  const holder = holdCollectionOpen(collection);
  await holder.held;
  try {
    check(await until(b, `${badge} === 'Anki locked'`, 150), 'the lock is seen: the badge says so');
    await sleep(500); // the reload that follows the mode change has answered
    check(await b.evaluate(kept), `under the lock the editor stays open, its typing and focus with it (${typed})`);
  } finally {
    await holder.release();
  }
  check(await until(b, `${badge} === 'Anki connected'`, 150), 'the lock let go: connected again');
  await sleep(500);
  check(await b.evaluate(kept), 'and the editor is still open with the typing, the caret where it was');
  await b.send('Input.insertText', { text: '!' });
  check(await b.evaluate(`document.querySelector('.card-panel-value-big').value === ${JSON.stringify(typed + '!')}`), 'typing goes on where it stopped');

  // 6. The same for a rename half typed: the name stays an input with what was typed in it.
  await key(b, 'Escape', 'Escape', 27);
  await click(b, '.deck-name-button');
  await until(b, `document.activeElement?.classList.contains('deck-name-input')`);
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, commands: ['moveToEndOfLine'] });
  await b.send('Input.insertText', { text: ' 반' });
  const naming = `document.activeElement?.classList.contains('deck-name-input') && document.activeElement.value === '한국어 연습 반'`;
  const holder2 = holdCollectionOpen(collection);
  await holder2.held;
  try {
    check(await until(b, `${badge} === 'Anki locked'`, 150), 'locked again');
    await sleep(500);
    check(await b.evaluate(naming), 'under the lock the rename keeps its typing and focus');
  } finally {
    await holder2.release();
  }
  check(await until(b, `${badge} === 'Anki connected'`, 150), 'and let go again');
  await sleep(500);
  check(await b.evaluate(naming), 'the rename is still being typed');
  await key(b, 'Escape', 'Escape', 27);

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
