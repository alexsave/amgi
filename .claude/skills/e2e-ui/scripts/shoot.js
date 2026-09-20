'use strict';

// Screenshots amgi's own screens against a fixture Anki collection - there
// is no login and no seeded Supabase project any more, so this walks: the
// deck list, a deck's notes, creating a new deck, and adding a note to it
// (audio generation included). With no OPENAI_API_KEY set, that last step
// exercises the mocked-stub-clip path every first-run user without a key
// also hits - see src/server/anki/audio.js.
//
//   node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture
//   npx next dev --webpack -p 3111 &
//   ANKI_COLLECTION=.e2e/fixture/collection.anki2 node .claude/skills/e2e-ui/scripts/shoot.js
//
// Prints every console error, failed request and 4xx/5xx it saw, which is
// usually where the real bugs turn up.

const path = require('path');
const fs = require('fs');
const { launch, watch, sleep } = require('./lib');
const ankiSettingsScript = require('./ankiSettings');
const { directSettings } = ankiSettingsScript;

const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = process.env.OUT || path.join(process.cwd(), '.e2e', 'shots');
const COLLECTION = process.env.ANKI_COLLECTION;

/** Clicks the first element matching `selector` whose exact text content is `text`. */
async function clickButtonByText(page, selector, text) {
  const clicked = await page.evaluate((sel, label) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === label);
    if (!el) return false;
    el.click();
    return true;
  }, selector, text);
  if (!clicked) throw new Error(`no element matching ${selector} with text "${text}"`);
}

/**
 * The selects after the note type picker, in the JSX order CardForm.js
 * renders them. `cueAudio` ("Write known-language audio into") always
 * renders, even for a note type with no such field guessed - its default
 * option is "(none)" - so this index is stable across note types.
 */
async function fieldSelects(page) {
  const handles = await page.$$('form.card-form select');
  return {
    notetype: handles[0],
    known: handles[1],
    text: handles[2],
    audio: handles[3],
    cueAudio: handles[4],
    knownLanguage: handles[5],
    learningLanguage: handles[6],
  };
}

(async () => {
  if (!COLLECTION) {
    console.error('usage: ANKI_COLLECTION=<path to a fixture collection.anki2> node shoot.js');
    console.error('build one with: node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  const logs = [];
  watch(page, logs);
  await page.evaluateOnNewDocument(ankiSettingsScript(directSettings(COLLECTION)));

  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

  // 1. The deck list.
  await page.goto(`${BASE}/decks`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.deck-item', { timeout: 20000 });
  await shot('01-deck-list');
  const deckCount = await page.$$eval('.deck-item', (els) => els.length);
  console.log(`deck list shows ${deckCount} deck(s)`);

  // 2. A deck's notes - the deck with the most notes, so the screenshot
  // actually shows something rather than whichever deck happens to sort
  // first (often an empty "Default").
  const deckItems = await page.$$('.deck-item');
  const noteCounts = await page.$$eval('.deck-item', (els) =>
    els.map((el) => parseInt(el.querySelector('small')?.textContent || '0', 10)),
  );
  await deckItems[noteCounts.indexOf(Math.max(...noteCounts))].click();
  await page.waitForSelector('.deck-cards', { timeout: 20000 });
  await page.waitForFunction(
    () => !document.querySelector('.deck-cards-list p')?.textContent?.includes('Loading notes'),
    { timeout: 20000 },
  );
  // The app's own layout is a fixed-height shell with an inner scrolling
  // region (see App.css: `height: 100vh; overflow: hidden` on the shell,
  // `overflow-y: auto` inside it), so Puppeteer's `fullPage` screenshot
  // option does nothing useful here - it measures the outer document, which
  // never grows. Scroll the heading into view instead.
  await page.evaluate(() => document.querySelector('.deck-cards-list h3')?.scrollIntoView({ block: 'start' }));
  await sleep(150);
  await shot('02-deck-notes');
  const noteCount = await page.$$eval('.card-item', (els) => els.length);
  console.log(`deck page shows ${noteCount} note(s) on the first page`);

  // 3. Creating a deck. CreateDeckModal navigates to the new deck on success,
  // so this and step 4 (adding a note) land on the same page.
  await page.goto(`${BASE}/decks`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.deck-item', { timeout: 20000 });
  await page.click('.deck-actions .action-btn');
  await page.waitForSelector('#deckName', { timeout: 5000 });
  const deckName = `e2e-ui ${Date.now()}`;
  await page.type('#deckName', deckName);
  await shot('03-create-deck-modal');
  await page.click('.modal-content button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 10000 });
  await page.waitForFunction((name) => document.querySelector('h1')?.textContent === name, { timeout: 10000 }, deckName);
  await shot('04-new-deck-empty');

  // 4. Adding a note, with generated audio.
  await page.waitForSelector('form.card-form', { timeout: 20000 });
  const selects = await fieldSelects(page);
  const fieldCount = await page.evaluate((el) => el.options.length, selects.text);
  const textIdx = 0;
  const audioIdx = fieldCount > 1 ? 1 : 0;
  await selects.text.select(String(textIdx));
  await selects.audio.select(String(audioIdx));
  await page.type(`#ankiField-${textIdx}`, 'hello from the e2e-ui skill');
  await shot('05-note-form-filled');

  // Several buttons now share the .generate-button class ("Generate text +
  // audio" above the field textareas, "Generate Audio" and "Add Note" below
  // them) - click by its exact label rather than DOM order, which the
  // "Generate text + audio" button broke as soon as it was added earlier in
  // the form.
  await clickButtonByText(page, '.generate-button', 'Generate Audio');
  await page.waitForFunction(
    () => /Audio generated/.test(document.querySelector('.error-message')?.textContent || ''),
    { timeout: 15000 },
  );
  const audioResultText = await page.$eval('.error-message', (el) => el.textContent);
  console.log(`audio result: ${audioResultText}`);
  await shot('06-audio-generated');

  const notesBefore = await page.$$eval('.card-item', (els) => els.length);
  await page.click('form.card-form button[type="submit"]'); // "Add Note"
  await page.waitForFunction(
    (before) => document.querySelectorAll('.card-item').length > before,
    { timeout: 15000 },
    notesBefore,
  );
  await page.evaluate(() => document.querySelector('.deck-cards-list h3')?.scrollIntoView({ block: 'start' }));
  await sleep(150);
  await shot('07-note-added');
  console.log('note added; deck now shows', await page.$$eval('.card-item', (els) => els.length), 'note(s)');

  const problems = logs.filter((l) => /pageerror|requestfailed|console\.error|\[http [45]/.test(l));
  console.log(problems.length ? `\nproblems:\n${problems.join('\n')}` : '\nno console errors or failed requests');
  await sleep(200);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
