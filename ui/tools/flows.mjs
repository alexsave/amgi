// The setup flows, against an Anki folder of their own that each run builds fresh (ui/tools/flows.sh):
// the first run (a profile found and picked, amgi installed), a new deck by the modal, the card
// design notice (files behind, then the collection behind), Settings' Install button, and the
// starter deck on a server with no Gemini key.
//
//   node ui/tools/flows.mjs <base url> <no-key base url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');
const [base, keyless, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
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
const type = (b, text) => b.send('Input.insertText', { text });
const decksShown = `document.querySelectorAll('.deck-item').length`;

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
  // Only the Anki folder: the profile is the app's to find.
  await seed(b, base, { baseDir: ankiDir });

  // 1. The first run: the one profile found and picked for you, amgi not yet installed here.
  await goto(b, `${base}/decks`);
  const steps = `[...document.querySelectorAll('.first-run-step-text')].map(s => s.textContent).join(' | ')`;
  await until(b, `/Found Anki: profile “User 1”, picked for you/.test(${steps})`);
  const found = await b.evaluate(steps);
  check(/Found Anki: profile “User 1”, picked for you/.test(found || ''), `the first run finds and picks the profile: ${found}`);
  check(await until(b, `document.querySelector('nav.navbar span[title]')?.textContent === 'Anki: not set up yet'`), 'the badge says not set up');
  await sleep(400);
  await shot(b, '10-firstrun');
  await click(b, '.first-run-cta');
  check(await until(b, `${decksShown} === 7 && document.querySelector('nav.navbar span[title]')?.textContent === 'Anki connected'`, 150),
    'Install into Anki installs, and the deck list follows');
  check(fs.existsSync(path.join(ankiDir, 'addons21', 'amgi_bridge')), 'the add-ons are in the folder');
  await sleep(400);
  await shot(b, '11-after-install');

  // 2. A new deck, by the modal: an empty name is refused, a nested one is made and opened.
  await click(b, '.deck-actions .action-btn');
  check(await until(b, `!!document.querySelector('.modal-overlay #deckName') && document.activeElement?.id === 'deckName'`), 'New Deck opens the modal, the name focused');
  await sleep(300);
  await shot(b, '12-modal');
  await click(b, '.modal-content .primary-btn');
  check(await until(b, `document.querySelector('.modal-content .error-message')?.textContent === 'Enter a deck name'`), 'an empty name is refused');
  await click(b, '#deckName');
  await type(b, 'Fresh::새 덱');
  await click(b, '.modal-content .primary-btn');
  check(await until(b, `/^\\/deck\\/\\d+$/.test(location.pathname) && document.querySelector('.deck-name-button')?.textContent === 'Fresh::새 덱'`, 150),
    'the deck is made and opened');
  check(await until(b, `document.querySelector('.empty-deck p')?.textContent === 'No notes in this deck yet.'`), 'it is empty');
  await sleep(300);
  await shot(b, '13-new-deck');

  // 3. The card design notice. Files behind (one add-on file changed): with Anki closed amgi puts
  // them back itself, and says nothing once they are. Then the collection behind (a template media
  // file changed): only Anki can fix it, so the notice says to restart Anki.
  const addonFile = path.join(ankiDir, 'addons21', 'amgi_mic', '__init__.py');
  const shipped = fs.readFileSync(addonFile);
  fs.writeFileSync(addonFile, Buffer.concat([shipped, Buffer.from('\n# stale\n')]));
  await goto(b, `${base}/decks`);
  check(await until(b, `${decksShown} === 9`, 150), 'the list, the new deck and its parent in it');
  await until(b, `!document.querySelector('.template-update')`, 100);
  check(Buffer.compare(fs.readFileSync(addonFile), shipped) === 0, 'stale add-on files are put back with Anki closed');
  const media = path.join(ankiDir, 'User 1', 'collection.media', '_amgi-loop.js');
  fs.appendFileSync(media, '\n// changed\n');
  await goto(b, `${base}/decks`);
  check(await until(b, `document.querySelector('.template-update.is-behind strong')?.textContent === 'restart Anki'`, 150), 'a collection behind: restart Anki');
  await sleep(300);
  await shot(b, '14-behind');
  await click(b, '.template-update-dismiss[aria-label]');
  check(await until(b, `!document.querySelector('.template-update')`), 'Dismiss takes the notice away');

  // 4. Settings: Install into Anki again, its message under the button.
  await click(b, 'button[title="Settings"]');
  await until(b, `!!document.querySelector('.install-block .save-button')`);
  await click(b, '.install-block .save-button');
  const msg = await until(b, `document.querySelector('.install-block .message.success')?.textContent`, 150);
  check(msg && msg.endsWith(`(${path.join(ankiDir, 'addons21')})`), `Settings' install says where it went: ${msg}`);
  await sleep(300);
  await shot(b, '15-settings-installed');
  // The card's pixels: the profile radio in the theme's red (not the browser's blue) and on the
  // labels' left edge, and the "Installs into" path broken only after a slash, never inside a name.
  const looks = await b.evaluate(`(() => {
    const radio = document.querySelector('.settings-page input[type=radio]');
    const profile = [...document.querySelectorAll('.preference-item > label')].find(l => l.textContent === 'Profile');
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'var(--flame-orange)';
    const red = getComputedStyle(probe).color;
    probe.remove();
    const code = document.querySelector('.install-block code');
    const text = code.textContent, breaks = [];
    let walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), top = null, prev = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < n.length; i++) {
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
        const t = Math.round(r.getBoundingClientRect().top);
        if (top !== null && t > top) breaks.push(prev);
        top = t; prev = n.data[i];
      }
    }
    return { accent: getComputedStyle(radio).accentColor, red, radio: radio.getBoundingClientRect().left, label: profile.getBoundingClientRect().left, text, breaks };
  })()`);
  check(looks.accent === looks.red, `the profile radio is the theme's red (${looks.accent}, the theme ${looks.red})`);
  check(Math.abs(looks.radio - looks.label) < 0.5, `the profile radio starts on the labels' left edge (${looks.radio} vs ${looks.label})`);
  check(looks.breaks.every((c) => c === '/'), `the folder path breaks only after a slash (${looks.breaks.length} breaks, after ${JSON.stringify(looks.breaks.join(''))}: ${looks.text})`);

  // 5. The starter deck, on a server with no key: offered below the list, built, opened.
  if (keyless) {
    await seed(b, keyless, { baseDir: ankiDir, collection: path.join(ankiDir, 'User 1', 'collection.anki2') });
    await goto(b, `${keyless}/decks`);
    await until(b, `${decksShown} > 0`, 150);
    const offered = await until(b, `document.querySelector('.starter-deck-title')?.textContent`, 150);
    check(offered === 'Try it without a Gemini key', 'with no key the starter deck is offered');
    const pair = await b.evaluate(`[...document.querySelectorAll('.starter-deck select')].map(s => s.value).join(' ')`);
    check(pair === 'en zh_cn', `pre-picked: English, and the first other language in LANGUAGES order (${pair})`);
    await sleep(300);
    await shot(b, '16-starter');
    await click(b, '.starter-deck-cta');
    check(await until(b, `/^\\/deck\\/\\d+$/.test(location.pathname) && document.querySelector('.deck-name-button')?.textContent === 'amgi starter - 中文' && document.querySelectorAll('.note-rows > li').length === 10`, 300),
      'Make me a starter deck builds it and opens it, ten cards');
    check((await b.evaluate(`document.querySelector('.deck-langs')?.textContent`) || '').startsWith('English → 中文'), 'the deck remembers its pair');
    await sleep(300);
    await shot(b, '17-starter-deck');
  }
  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
