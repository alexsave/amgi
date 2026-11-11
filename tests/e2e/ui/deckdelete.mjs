// Deleting a deck from the bottom of its page, against a copy of the UI fixture that each run builds
// fresh (tests/e2e/ui/flows.sh): not offered for Default; a deck with a subdeck and cards (the
// confirmation names both, Cancel and Escape keep it, Delete takes it, the list follows, and Back
// does not return to it); a long deck; an empty one; Anki holding the file (the failure shown under
// the button, nothing deleted, then deleted once Anki lets go); a deck deleted underneath the page
// (it says the deck no longer exists); and a deck page for a deck that is gone. After each delete the
// collection is read with Anki itself: the decks are gone, graves were left, and it is whole.
//
//   node tests/e2e/ui/deckdelete.mjs <base url> <name> <anki folder> [out dir]
// Needs ANKI_PYTHON_BIN (the e2e-ui skill).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');
const anki = createRequire(import.meta.url)('../../server/plusaudio/collection/helpers/anki-python.js');
const { holdCollectionOpen } = anki;
// The server opens the file for a moment on every request (the status poll among them), and Anki's
// own open does not wait: a read here that meets one is tried again.
function withAnkiLibrary(file, body) {
  for (let i = 0; ; i++) {
    try {
      return anki.withAnkiLibrary(file, body);
    } catch (error) {
      if (i >= 20 || !/locked|already open/i.test(error.message)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
const [base, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', '..', '..', 'ui', 'out', 'shots');
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
const deckNames = `[...document.querySelectorAll('.deck-item h3')].map(h => h.textContent)`;
const dialogOpen = `!!document.querySelector('dialog.confirm-dialog[open]')`;
const dialogText = `[...document.querySelectorAll('dialog.confirm-dialog h3, dialog.confirm-dialog p')].map(e => e.textContent).join(' | ')`;
const ids = Object.fromEntries(
  withAnkiLibrary(collection, 'for d in col.decks.all_names_and_ids(): print("%d\\t%s" % (d.id, d.name))')
    .trim().split('\n').map((l) => l.split('\t')).map(([id, n]) => [n, Number(id)]),
);
// What Anki itself says about the file: the decks it has, the deck graves, and the integrity check.
const inAnki = () => withAnkiLibrary(collection, `
print("DECKS:", "|".join(sorted(d.name for d in col.decks.all_names_and_ids())))
print("DECK-GRAVES:", col.db.scalar("select count() from graves where type = 2"))
print("INTEGRITY:", col.db.scalar("pragma integrity_check"))
`);

// A change made beside the page, as Anki or another device would make it, through the app's own API
// (one request at a time on the server's side, so it never races the page's polls for the file).
async function api(method, route, kind, body) {
  const headers = { 'X-Amgi-Collection': encodeURIComponent(collection), 'X-Amgi-Base-Dir': encodeURIComponent(ankiDir) };
  if (kind) headers['Content-Type'] = WIRE_MIME;
  const r = await fetch(`${base}/api/anki${route}`, { method, headers, body: kind ? encode(kind, body) : undefined });
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status}`);
  return r;
}

// A deck page is drawn before it is whole: the card form says "Loading…" until the note types
// come, and the list says "Loading notes…" until its notes do. Each answer grows the page above
// the delete section and moves it down, so a click measured before both are in is pressed where
// the button used to be (on a note row, or on nothing). Settled is both in.
const settled = `(() => {
  const form = document.querySelector('.card-form-container');
  return !!document.querySelector('.deck-danger-btn') && !!form?.firstElementChild && form.textContent !== 'Loading…'
    && (!!document.querySelector('.note-rows') || document.querySelector('.empty-deck')?.textContent === 'No notes in this deck yet.');
})()`;

async function openDeck(b, deck) {
  await goto(b, `${base}/decks`);
  await until(b, `${deckNames}.includes(${JSON.stringify(deck)})`, 150);
  const i = await b.evaluate(`${deckNames}.indexOf(${JSON.stringify(deck)})`);
  await click(b, `.deck-item:nth-child(${i + 1})`);
  return until(b, `${settled} && document.querySelector('.deck-name-button')?.textContent === ${JSON.stringify(deck)}`, 150);
}
async function ask(b) {
  await click(b, '.deck-danger-btn');
  const open = await until(b, `${dialogOpen} && document.activeElement?.classList.contains('submit-btn')`, 100);
  if (!open) throw new Error('Delete deck did not open the confirmation');
  return open;
}

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

  // 1. Default: Anki never removes it, so the page does not offer it.
  await goto(b, `${base}/deck/1`);
  check(await until(b, `document.querySelector('.deck-name-button')?.textContent === 'Default'`, 150), 'the Default deck page opens');
  await sleep(300);
  check(!(await b.evaluate(`!!document.querySelector('.deck-danger')`)), 'and offers no delete');

  // 2. A deck with a subdeck and cards: the section, then the confirmation naming what goes.
  check(await openDeck(b, '한국어'), 'the 한국어 page has the delete section');
  const section = await b.evaluate(`(() => { const s = document.querySelector('.deck-danger'), l = document.querySelector('.deck-cards-list');
    return { last: s?.parentElement?.lastElementChild === s, below: s && l ? s.getBoundingClientRect().top >= l.getBoundingClientRect().bottom : false,
      text: s?.textContent }; })()`);
  check(section.last && section.below, `the section is the last thing on the page, below the cards (${JSON.stringify(section)})`);
  await b.evaluate(`document.querySelector('.deck-danger').scrollIntoView({ block: 'end', behavior: 'instant' })`);
  await sleep(300);
  await shot(b, '60-deck-delete-section');
  check(await ask(b), 'Delete deck asks, in a modal dialog, the action focused');
  const asked = await b.evaluate(dialogText);
  check(asked === 'Delete “한국어”? | This deletes “한국어” and its subdeck, with the 6 cards in them and the 4 notes they belong to. | '
    + 'Their review history goes too, on every device you sync with.', `it names the deck, its subdeck and the counts: ${asked}`);
  await sleep(300);
  await shot(b, '61-deck-delete-confirm');
  await click(b, 'dialog.confirm-dialog .cancel-btn');
  check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Cancel closes it');
  check(await until(b, `document.querySelector('.deck-danger-btn')?.textContent === 'Delete deck' && !document.querySelector('.deck-danger-btn').disabled`), 'and the button is back');
  check(/\|한국어\|한국어::일상 표현\|/.test(`|${inAnki().match(/DECKS: (.*)/)[1]}|`), 'and the deck is still in Anki');
  await ask(b);
  await key(b, 'Escape', 'Escape', 27);
  check(await until(b, `!document.querySelector('dialog.confirm-dialog')`), 'Escape closes it too');
  await ask(b);
  await click(b, 'dialog.confirm-dialog .submit-btn');
  check(await until(b, `location.pathname === '/decks' && document.querySelectorAll('.deck-item').length === 5`, 150),
    `Delete takes it, back on the list: ${await b.evaluate(deckNames)}`);
  check(!(await b.evaluate(`${deckNames}.some(n => n.startsWith('한국어'))`)), 'the deck and its subdeck are off the list');
  let anki = inAnki();
  check(!/한국어/.test(anki) && /DECK-GRAVES: 2\n/.test(anki) && /INTEGRITY: ok/.test(anki), `Anki agrees: gone, two deck graves, the file whole (${anki.trim().replaceAll('\n', '; ')})`);
  await b.evaluate('history.back()');
  await sleep(800);
  check(await b.evaluate(`location.pathname === '/decks' && !document.querySelector('.deck-gone')`), `Back does not return to the deleted deck (${await b.evaluate('location.pathname')})`);

  // 3. A long deck: every card counted.
  check(await openDeck(b, 'Long'), 'the Long page');
  await ask(b);
  const long = await b.evaluate(dialogText);
  check(long.includes('This deletes “Long”, with the 26 cards in it and the 26 notes they belong to.'), `the long deck's counts: ${long}`);
  await click(b, 'dialog.confirm-dialog .submit-btn');
  check(await until(b, `location.pathname === '/decks' && !${deckNames}.includes('Long')`, 150), 'Long is deleted');

  // 4. An empty subdeck.
  check(await openDeck(b, 'Existing::Child'), 'the empty subdeck page');
  await ask(b);
  const empty = await b.evaluate(dialogText);
  check(empty === 'Delete “Existing::Child”? | This deletes “Existing::Child”. There are no cards in it. | It goes on every device you sync with.', `an empty deck says so: ${empty}`);
  await click(b, 'dialog.confirm-dialog .submit-btn');
  check(await until(b, `location.pathname === '/decks' && !${deckNames}.includes('Existing::Child') && ${deckNames}.includes('Existing')`, 150), 'the subdeck goes, its parent stays');

  // 5. Anki holding the file: the failure under the button, nothing deleted; then it works.
  check(await openDeck(b, 'Showcase source'), 'the Showcase source page');
  await ask(b);
  const holder = holdCollectionOpen(collection);
  await holder.held;
  try {
    // The page's status poll sees Anki take the file while the confirmation is open: the mode
    // changes and the page refetches under the dialog, which must stay as it was, focus and all.
    check(await until(b, `document.querySelector('nav.navbar span[title]')?.textContent === 'Anki locked'`, 150), 'locked: the badge changes while the confirmation is open');
    await sleep(300);
    check(await b.evaluate(`${dialogOpen} && document.activeElement?.classList.contains('submit-btn')`), 'and the confirmation stays open, its action focused');
    await click(b, 'dialog.confirm-dialog .submit-btn');
    const err = await until(b, `document.querySelector('.deck-danger-error')?.textContent`, 150);
    check(/Anki is open on this collection/.test(err || ''), `locked: the page says why, under the button (${err})`);
    check(await b.evaluate(`location.pathname.startsWith('/deck/') && document.querySelector('.deck-danger-btn')?.textContent === 'Delete deck'`), 'and stays on the deck, the button ready again');
    await b.evaluate(`document.querySelector('.deck-danger').scrollIntoView({ block: 'end', behavior: 'instant' })`);
    await sleep(300);
    await shot(b, '62-deck-delete-locked');
  } finally {
    await holder.release();
  }
  check(/Showcase source/.test(inAnki()), 'locked: nothing was deleted');
  await ask(b);
  check(!(await b.evaluate(`!!document.querySelector('.deck-danger-error')`)), 'asking again clears the old failure');
  await click(b, 'dialog.confirm-dialog .submit-btn');
  check(await until(b, `location.pathname === '/decks' && !${deckNames}.includes('Showcase source')`, 150), 'once Anki lets go, it is deleted');

  // 6. Deleted underneath the page before Delete deck is pressed: the check before the confirmation
  // finds it gone, and the page says so without asking.
  const made = await api('POST', '/decks', 'q_deck_name', { name: 'Spare' });
  const spare = decode('deck_created', new Uint8Array(await made.arrayBuffer()))['deck.id'];
  check(await openDeck(b, 'Spare'), 'the Spare page');
  await api('DELETE', `/decks/${spare}`);
  await click(b, '.deck-danger-btn');
  check(await until(b, `document.querySelector('.deck-gone h1')?.textContent === 'This deck no longer exists'`, 150), 'gone before asking: the page says it no longer exists');
  check(!(await b.evaluate(dialogOpen)), 'and asks nothing');

  // 7. Deleted underneath the page (in Anki, say), while the confirmation was open: Delete answers
  // that it is gone, and the page says so.
  check(await openDeck(b, 'Existing'), 'the Existing page');
  await ask(b);
  await api('DELETE', `/decks/${ids.Existing}`);
  await click(b, 'dialog.confirm-dialog .submit-btn');
  check(await until(b, `document.querySelector('.deck-gone h1')?.textContent === 'This deck no longer exists'`, 150), 'a deck deleted elsewhere: the page says it no longer exists');
  check(!(await b.evaluate(dialogOpen)) && !(await b.evaluate(`!!document.querySelector('.deck-danger-error')`)), 'and shows no error or dialog');
  await sleep(300);
  await shot(b, '63-deck-gone');
  await click(b, '.deck-gone .back-btn');
  check(await until(b, `location.pathname === '/decks' && document.querySelectorAll('.deck-item').length === 1`, 150), 'its button goes back to the list (Default alone now)');

  // 8. The page of a deck that is gone, opened directly.
  await goto(b, `${base}/deck/${ids['Long']}`);
  check(await until(b, `document.querySelector('.deck-gone h1')?.textContent === 'This deck no longer exists'`, 150), 'a gone deck\'s address says it no longer exists');
  anki = inAnki();
  check(/DECKS: Default\n/.test(anki) && /INTEGRITY: ok/.test(anki), `Anki: only Default is left, the file whole (${anki.trim().replaceAll('\n', '; ')})`);

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
