// Making cards, end to end, against the project's fake Gemini (node plusaudio/test/helpers/fake-gemini.js,
// its limits switched through POST /control) and a fresh copy of the UI fixture (ui/tools/flows.sh, amgi installed): one line by
// Enter; a paste of several, a section marker dropped and a line the deck already has skipped; a
// per-minute limit waited out with its countdown; a failed line and its Retry; the day's cap ending
// every line still to go.
//
//   node ui/tools/bulk.mjs <base url> <fake gemini url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { launch, sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const [base, gemini, name, ankiDir, outArg] = process.argv.slice(2);
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
const { controlFake } = createRequire(import.meta.url)('../../plusaudio/test/helpers/fake-gemini.js');
const control = (q) => controlFake(gemini, q);
const enter = async (b) => {
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const head = `document.querySelector('.bulk-run-head')?.textContent`;
const states = `[...document.querySelectorAll('.bulk-run-row')].map(r => r.className.replace('bulk-run-row is-', '') + ':' + r.querySelector('.bulk-run-text').textContent).join(' | ')`;
const typeInto = async (b, text) => {
  await click(b, '#amgiCardInput');
  await b.send('Input.insertText', { text });
};

const b = await launch(['--hide-scrollbars']);
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 9 minutes');
  await b.close();
  process.exit(1);
}, 540000);
const pageErrors = [];
let writes = 0; // POST /api/anki/notes/bulk calls the page made
b.onEvent = (d) => {
  if (d.method === 'Network.requestWillBeSent' && d.params.request.url.endsWith('/api/anki/notes/bulk')) writes++;
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
try {
  await control('perMinute=1000&daily=0');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await b.send('Network.enable');
  await seed(b, base, { baseDir: ankiDir, collection, profile: 'User 1' });
  await goto(b, `${base}/decks`);
  await until(b, `document.querySelectorAll('.deck-item').length === 7`, 150);
  const i = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === 'Showcase source')`);
  await click(b, `.deck-item:nth-child(${i + 1})`);
  check(await until(b, `!!document.querySelector('#amgiCardInput') && document.querySelectorAll('.note-rows > li').length === 3`, 150), 'the deck page and its form');

  // 1. One line, Enter.
  await typeInto(b, 'apple');
  check(await b.evaluate(`!document.querySelector('.card-form-go').disabled && document.querySelector('.card-form-go').textContent === 'Make the card'`), 'typing enables Make the card');
  await enter(b);
  check(await until(b, `${head} === 'Done: 1 added'`, 300), `one card made (${await b.evaluate(head)})`);
  check(await until(b, `document.querySelectorAll('.note-rows > li').length === 4 && document.querySelector('#amgiCardInput').value === ''`, 150), 'the list has it and the box is empty');
  check(await b.evaluate(`document.querySelectorAll('.bulk-run-row.is-done .audio-chip').length === 2`), 'its row carries both clips');
  await sleep(300);
  await shot(b, '30-one-card');

  // 2. A paste: the marker dropped, a repeated line made once, the deck's own lines skipped on
  // either side whatever their trailing punctuation ("apple!" is the cue "apple"; "5번 문장이에요" is
  // apple's target), a line whose two sides come back the same flagged, the rows in the paste's
  // order, and the finished cards written in one call.
  await typeInto(b, '[Chorus]\napple!\nbanana 1\n5번 문장이에요\ncherry 2\nbanana 1\n9번 문장이에요.');
  check(await until(b, `!document.querySelector('.bulk-run') && document.querySelector('.card-form-go').textContent === 'Make 5 cards' && document.querySelector('#amgiCardInput').rows === 8`),
    `a paste says how many cards, and the box grows (${await b.evaluate(`document.querySelector('.card-form-go').textContent + ' ' + document.querySelector('#amgiCardInput').rows`)})`);
  writes = 0;
  await click(b, '.card-form-go');
  check(await until(b, `${head} === 'Done: 3 added, 2 already in the deck'`, 300), `the run: ${await b.evaluate(head)}`);
  const order = await b.evaluate(states);
  check(order === 'skipped:apple! | done:1번 문장이에요. | skipped:5번 문장이에요 | done:2번 문장이에요. | done:9번 문장이에요.', `skips on both sides, in the paste's order: ${order}`);
  check(await b.evaluate(`[...document.querySelectorAll('.bulk-run-cue')].at(-1).textContent`) === 'both sides came back the same - open it and fix the wording', 'a card the same on both sides is flagged');
  check(writes === 1, `cards that finish together are written in one call (${writes})`);
  await sleep(300);
  await shot(b, '31-paste');

  // 3. Gemini's per-minute limit: the line waits it out, counting down, then is made.
  await control('perMinute=2');
  await typeInto(b, 'date 3\nelder 4');
  await click(b, '.card-form-go');
  const waiting = await until(b, `[...document.querySelectorAll('.bulk-run-cue')].map(c => c.textContent).find(t => /retrying in \\d+s…/.test(t))`, 300);
  check(!!waiting, `a limited line counts down: ${waiting}`);
  const n1 = Number((waiting || '').match(/(\d+)s…/)?.[1]);
  await sleep(2200);
  const later = await b.evaluate(`[...document.querySelectorAll('.bulk-run-cue')].map(c => c.textContent).find(t => /retrying in \\d+s…/.test(t))`);
  const n2 = Number((later || '').match(/(\d+)s…/)?.[1]);
  check(n2 < n1, `the countdown goes down (${n1} then ${n2})`);
  check(/waiting for the rate limit/.test(await b.evaluate(head)), `the head says so: ${await b.evaluate(head)}`);
  await shot(b, '32-rate-limited');
  check(await until(b, `${head} === 'Done: 2 added'`, 2000), `after the wait, both made (${await b.evaluate(head)})`);
  await control('perMinute=1000');

  // 4. A line that fails, and its Retry.
  await typeInto(b, 'broken line');
  await enter(b);
  check(await until(b, `/failed/.test(${head}) && !!document.querySelector('.bulk-run-retry')`, 300), `a failed line offers Retry: ${await b.evaluate(states)}`);
  await shot(b, '33-failed');
  await click(b, '.bulk-run-retry');
  check(await until(b, `!!document.querySelector('.bulk-run-row.is-done') && !document.querySelector('.bulk-run-retry')`, 300), 'Retry makes it');

  // 5. The day's cap: every line still to go ends with it.
  await control('daily=1');
  await typeInto(b, 'fig 5\ngrape 6\nkiwi 7');
  await click(b, '.card-form-go');
  check(await until(b, `${head} === 'Done: 0 added, 3 failed'`, 300), `the cap ends the run: ${await b.evaluate(head)}`);
  const capNote = await b.evaluate(`document.querySelector('.bulk-run-row.is-error .bulk-run-cue')?.textContent`);
  check(/per day|daily|10 requests|billing/i.test(capNote || ''), `it says why: ${capNote}`);
  await shot(b, '34-daily-cap');
  await control('daily=0');

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
