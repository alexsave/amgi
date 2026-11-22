// Making cards, end to end, against the project's fake Gemini (node tests/server/plusaudio/helpers/fake-gemini.js,
// its limits switched through POST /control) and a fresh copy of the UI fixture (tests/e2e/ui/flows.sh, amgi installed): one line by
// Enter; a paste of several, a section marker dropped and a line the deck already has skipped; a
// per-minute limit waited out with its countdown; a failed line and its Retry; the day's cap ending
// every line still to go. And the steps: each row names the step its card is at, seen in a real run
// (slowed, one clip misheard), then every label the page has, forced one at a time at two widths.
//
//   node tests/e2e/ui/bulk.mjs <base url> <fake gemini url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome, shotter } = await import('./chrome.mjs');
const [base, gemini, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', '..', '..', 'ui', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false };
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
const shot = shotter(out, name);
async function click(b, selector) {
  const box = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!box) throw new Error(`nothing to click at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}
const { controlFake } = createRequire(import.meta.url)('../../server/plusaudio/helpers/fake-gemini.js');
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

const b = await launchChrome();
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 9 minutes');
  await b.close();
  process.exit(1);
}, 540000);
const pageErrors = [];
let writes = 0; // POST /api/anki/notes/bulk calls the page made
let paused = null; // while requests are intercepted: what is done with each
b.onEvent = (d) => {
  if (d.method === 'Fetch.requestPaused') paused?.(d.params);
  if (d.method === 'Network.requestWillBeSent' && d.params.request.url.endsWith('/api/anki/notes/bulk')) writes++;
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
try {
  await control('perMinute=1000&daily=0');
  await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
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

  // 2b. The steps, in a real run: seven lines for five slots, the fake slowed, the first clip misheard.
  await control('delay=350&mishear=1');
  await b.evaluate(`(() => {
    window.__steps = [];
    const note = (e) => {
      if (e.nodeType !== 1) return;
      const rows = e.matches('.bulk-run-row') ? [e] : e.querySelectorAll('.bulk-run-row');
      for (const r of rows) window.__steps.push([r.querySelector('.bulk-run-state').firstChild.textContent,
        r.querySelector('.bulk-run-take')?.textContent ?? '', r.querySelector('.bulk-run-text').textContent]);
    };
    window.__stepWatch = new MutationObserver((all) => { for (const m of all) for (const e of m.addedNodes) note(e); });
    window.__stepWatch.observe(document.body, { childList: true, subtree: true });
  })()`);
  await typeInto(b, [21, 22, 23, 24, 25, 26, 27].map((n) => `step ${n}`).join('\n'));
  await click(b, '.card-form-go');
  check(await until(b, `${head} === 'Done: 7 added'`, 400), `seven slowed lines are made: ${await b.evaluate(head)}`);
  const seen = await b.evaluate('(window.__stepWatch.disconnect(), window.__steps)');
  const labels = new Set(seen.map(([label]) => label));
  for (const want of ['checking for duplicates', 'waiting for slot', 'writing both sides', 'recording target', 'transcribing target',
    'judging target', 'recording cue', 'transcribing cue', 'waiting for batch', 'writing to Anki', 'in the deck']) {
    check(labels.has(want), `a real run says "${want}"`);
  }
  check(seen.some(([label, take]) => label === 'recording target' && take === 'take 2 of 3'), 'a misheard clip goes back to recording target, take 2 of 3');
  check(seen.some(([label, , text]) => label === 'recording target' && /문장/.test(text)), 'the written side is shown while it is being recorded');
  await control('delay=0&mishear=0');

  // 2c. Every label, forced: the card's request is held here and GET /progress answered by the drive.
  let card = null;
  let reported = [];
  paused = async ({ requestId, request }) => {
    if (request.url.endsWith('/card-text')) {
      const body = Buffer.concat((request.postDataEntries || []).map((e) => Buffer.from(e.bytes, 'base64')));
      card = { requestId, id: decode('q_card_text', body).progressId };
      return;
    }
    await b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: WIRE_MIME }],
      body: Buffer.from(encode('progress', { cards: reported })).toString('base64') });
  };
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/anki/card-text' }, { urlPattern: '*/api/anki/progress' }] });
  await typeInto(b, 'labels 31');
  await click(b, '.card-form-go');
  for (let i = 0; i < 100 && !card; i++) await sleep(50);
  check(card?.id > 0, 'the page names its request');
  const row = `(() => { const r = document.querySelector('.bulk-run-row'); const s = r?.querySelector('.bulk-run-state');
    if (!s) return null;
    const label = document.createRange(); label.selectNodeContents(s.firstChild);
    const t = r.querySelector('.bulk-run-text').getBoundingClientRect();
    return { label: s.firstChild.textContent, take: s.querySelector('.bulk-run-take')?.textContent ?? '',
      note: r.querySelector('.bulk-run-cue').textContent, lines: label.getClientRects().length,
      height: r.getBoundingClientRect().height, textWidth: t.width, cut: s.scrollWidth > s.clientWidth,
      wide: document.documentElement.scrollWidth > innerWidth || r.scrollWidth > r.clientWidth + 1 }; })()`;
  const STEPS = ['writing both sides', 'checking target reuse', 'recording target', 'transcribing target', 'judging target', 'storing target',
    'checking cue reuse', 'recording cue', 'transcribing cue', 'judging cue', 'storing cue'];
  for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true]]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const heights = new Set();
    for (const [k, label] of STEPS.entries()) {
      for (const take of /reuse|storing|writing/.test(label) ? [0] : [1, 3]) {
        reported = [{ id: card.id, step: k + 1, take, takes: take ? 3 : 0, waitMs: 0, frontText: k ? 'labels 31' : '', backText: k ? '31번 문장이에요.' : '' }];
        const want = take > 1 ? `take ${take} of 3` : '';
        check(await until(b, `(${row})?.label === ${JSON.stringify(label)} && (${row}).take === ${JSON.stringify(want)}`, 50), `${width}px: "${label}" ${want}`);
        const at = await b.evaluate(row);
        check(at.lines === 1 && !at.cut && !at.wide, `${width}px: "${label}" ${want} fits on its line (${JSON.stringify(at)})`);
        check(at.textWidth >= 60, `${width}px: "${label}" leaves the card's text room (${at.textWidth}px)`);
        heights.add(Math.round(at.height));
      }
    }
    if (mobile) {
      const list = await b.evaluate(`[...document.querySelectorAll('.note-row')].map(r => Math.round(r.querySelector('.note-row-target').getBoundingClientRect().width))`);
      check(list.length > 0 && Math.min(...list) >= 250, `${width}px: every card in the deck's list has room for its text (${Math.min(...list)}px)`);
    }
    if (mobile) check((await b.evaluate(row)).textWidth >= 250, `${width}px: the card's text has a line of its own`);
    check(heights.size === 1, `${width}px: the row never changes height as its step changes (${[...heights]})`);
    await sleep(300);
    reported = [{ id: card.id, step: 4, take: 2, takes: 3, waitMs: 0, frontText: 'labels 31', backText: '31번 문장이에요.' }];
    await until(b, `(${row})?.take === 'take 2 of 3'`, 50);
    await shot(b, `35-step-${width}`);
    reported = [{ id: card.id, step: 3, take: 1, takes: 3, waitMs: 12000, frontText: 'labels 31', backText: '31번 문장이에요.' }];
    check(await until(b, `(${row})?.label === 'waiting for rate limit' && (${row}).note === 'continuing in 12s…'`, 50), `${width}px: a wait inside a step says so`);
    const waitingRow = await b.evaluate(row);
    check(waitingRow.lines === 1 && !waitingRow.wide, `${width}px: "waiting for rate limit" fits (${JSON.stringify(waitingRow)})`);
    await shot(b, `36-step-wait-${width}`);
    reported = [{ id: card.id, step: 3, take: 1, takes: 3, waitMs: 0, frontText: 'labels 31', backText: '31번 문장이에요.' }];
    check(await until(b, `(${row})?.label === 'recording target'`, 50), `${width}px: the wait over, the step is back`);
  }
  await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  // The two refusals before a card starts are told apart.
  const refuse = async (error, label) => {
    const { requestId } = card;
    card = null;
    reported = [];
    await b.send('Fetch.fulfillRequest', { requestId, responseCode: 429, responseHeaders: [{ name: 'Content-Type', value: WIRE_MIME }],
      body: Buffer.from(encode('error', { error, notStarted: true, retryAfterMs: 1500, maxWaitMs: 180000 })).toString('base64') });
    check(await until(b, `(${row})?.label === ${JSON.stringify(label)} && /retrying in/.test((${row}).note)`, 30), `a refusal says "${label}"`);
    for (let i = 0; i < 100 && !card; i++) await sleep(50);
    check(!!card, 'and the line is asked again');
  };
  const noSlot = /#define WIRE_NO_SLOT_ERROR "([^"]+)"/.exec(fs.readFileSync(path.join(here, '..', '..', '..', 'ui', 'wire', 'wire.h'), 'utf8'))[1];
  await refuse(noSlot, 'waiting for slot');
  await refuse("Gemini's per-minute limit is reached; this card waits 2s before starting.", 'waiting for rate limit');
  await b.send('Fetch.continueRequest', { requestId: card.requestId });
  await b.send('Fetch.disable');
  paused = null;
  check(await until(b, `${head} === 'Done: 1 added'`, 300), `and is then made: ${await b.evaluate(head)}`);

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
  check(await b.evaluate(`[...document.querySelectorAll('.bulk-run-state')].some(s => s.textContent === 'waiting for rate limit')`), 'a limited line says it waits for the rate limit');
  await shot(b, '32-rate-limited');
  // 3b. A run put away while its countdown ticks leaves no tick behind: a new run, rate limited at once, counts down
  // at one second a second, not at the pace of the old run's tick and its own together.
  const countdown = `Number([...document.querySelectorAll('.bulk-run-cue')].map(c => c.textContent).map(t => t.match(/retrying in (\\d+)s…/)?.[1]).find(Boolean))`;
  const justTicked = await b.evaluate(countdown);
  await until(b, `${countdown} !== ${justTicked}`, 30); // the old run's tick has just fired: the next is a second away
  await b.evaluate(`(() => { const box = document.querySelector('#amgiCardInput'); box.value = 'honeydew 8\\nnectarine 10';
    box.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.card-form-go').click(); })()`);
  check(await until(b, `${countdown} > 0`, 100), 'a new run, put straight after the old one was put away, counts down too');
  const m1 = await b.evaluate(countdown);
  await sleep(4200);
  const m2 = await b.evaluate(countdown);
  check(m1 - m2 >= 3 && m1 - m2 <= 5, `at one second a second, with no tick of the old run (${m1} then ${m2} in 4.2 s)`);
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

  // 6. A clip recorded again in an open editor: its chip is built again in its place, outside any build, and
  // the editor owns it. Twice, so the second replaces a chip the first made.
  const clips = `[...document.querySelectorAll('.card-panel-clips > *')].map(e => e.className.trim()).join(' | ')`;
  await click(b, '.note-rows .note-row-edit:not(.note-row-edit-off)');
  check(await until(b, `!!document.querySelector('.card-panel')`), 'a card opens in its row');
  const before = await b.evaluate(clips);
  for (const time of ['once', 'twice']) {
    await b.evaluate(`document.querySelectorAll('.card-panel .audio-chip-target').forEach((e) => { e.dataset.old = '1'; })`);
    await click(b, '.card-panel-redo');
    check(await until(b, `!!document.querySelector('.card-panel .audio-chip-target:not([data-old])') && !document.querySelector('.card-panel-redo').disabled`, 300),
      `Redo ${time}: the target's chip is built again`);
    check((await b.evaluate(clips)) === before, `Redo ${time}: the chips and buttons are where they were (${await b.evaluate(clips)})`);
  }
  await click(b, '.card-panel .audio-chip-target');
  check(await until(b, `!!document.querySelector('.card-panel .audio-chip-target.is-playing')`, 100), 'the chip made last plays its new clip');
  await click(b, '.note-rows .note-row-edit:not(.note-row-edit-off)');
  check(await until(b, `!document.querySelector('.card-panel')`), 'closing the card takes the panel, the chips it made and its voice');

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
