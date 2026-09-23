'use strict';

// Screenshots amgi's own screens against a fixture Anki collection - there
// is no login and no seeded Supabase project any more, so this walks: the
// deck list, a deck's notes, creating a new deck, and adding a note to it
// (card text and audio generation included). With no OPENAI_API_KEY, that
// last step has to end in the form's own "OPENAI_API_KEY is not set" error
// and no new note - a card is never made from placeholder text or audio
// (see src/server/anki/cardText.js and audio.js). With a key it makes one
// real card, which is a real, paid OpenAI call.
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
  // Rows, or the empty-deck message - whichever CardList.js settles on - rather
  // than the absence of a loading string whose wording has changed before.
  await page.waitForSelector('.note-row-wrap, .empty-deck', { timeout: 20000 });
  // The app's own layout is a fixed-height shell with an inner scrolling
  // region (see App.css: `height: 100vh; overflow: hidden` on the shell,
  // `overflow-y: auto` inside it), so Puppeteer's `fullPage` screenshot
  // option does nothing useful here - it measures the outer document, which
  // never grows. Scroll the heading into view instead.
  await page.evaluate(() => document.querySelector('.deck-cards-listhead')?.scrollIntoView({ block: 'start' }));
  await sleep(150);
  await shot('02-deck-notes');
  const noteCount = await page.$$eval('.note-row-wrap', (els) => els.length);
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

  // 4. Making a card: one line of text, "Make the card", and the card goes
  // straight into the deck (see CardForm.js). Without a key the form has to
  // say so and add nothing.
  await page.waitForSelector('.card-form-input', { timeout: 20000 });
  await page.type('.card-form-input', 'hello from the e2e-ui skill');
  await shot('05-card-form-filled');
  const rowsBefore = await page.$$eval('.note-row-wrap', (els) => els.length);
  await page.click('.card-form-go');
  await page.waitForFunction(
    () => document.querySelector('.card-form-error') || /Added to the deck/.test(document.body.textContent),
    { timeout: 180000 },
  );
  const formError = await page.$eval('.card-form-error', (el) => el.textContent).catch(() => '');
  await sleep(500);
  const rowsAfter = await page.$$eval('.note-row-wrap', (els) => els.length);
  await shot('06-card-made');
  if (formError) {
    console.log(`card not made: ${formError}`);
    if (rowsAfter !== rowsBefore) throw new Error(`a failed card still added ${rowsAfter - rowsBefore} row(s)`);
  } else {
    console.log(`card made; deck now shows ${rowsAfter} note(s), was ${rowsBefore}`);
  }

  const problems = logs.filter((l) => /pageerror|requestfailed|console\.error|\[http [45]/.test(l));
  console.log(problems.length ? `\nproblems:\n${problems.join('\n')}` : '\nno console errors or failed requests');
  await sleep(200);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
