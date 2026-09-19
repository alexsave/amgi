'use strict';

// Proves the locked-collection path against a REAL Anki-shaped lock - the
// same one plusaudio/test/collection/open-lock.test.js proves the Node
// reader against - not a simulation of SQLITE_BUSY: opens the fixture with
// the real `anki` Python library and holds it open while the UI is checked,
// the way a running Anki desktop client actually would (see
// plusaudio/lib/collection/open.js's own module comment for exactly what
// that lock is). Then releases it and checks the UI notices that too.
//
//   node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture
//   npx next dev --webpack -p 3111 &
//   ANKI_COLLECTION=.e2e/fixture/collection.anki2 \
//   node .claude/skills/e2e-ui/scripts/prove-locked.js

const path = require('path');
const fs = require('fs');
const { launch, watch, sleep } = require('./lib');
const ankiSettingsScript = require('./ankiSettings');
const { directSettings } = ankiSettingsScript;
const { anki, holdCollectionOpen } = require('./fixture');

const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = process.env.OUT || path.join(process.cwd(), '.e2e', 'shots');
const COLLECTION = process.env.ANKI_COLLECTION;

// DeckContext polls /api/anki/status every 4000ms (src/contexts/DeckContext.js);
// wait more than two cycles so a poll landing right after we act is not missed.
const POLL_SETTLE_MS = 9000;

async function readBadge(page) {
  return page.evaluate(() => {
    const el = document.querySelector('nav.navbar span[title]');
    return el ? { label: el.textContent.trim(), title: el.title } : null;
  });
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  if (!COLLECTION) {
    console.error('usage: ANKI_COLLECTION=<path to a fixture collection.anki2> node prove-locked.js');
    console.error('build one with: node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture');
    process.exit(1);
  }
  if (!anki) {
    console.error('no python with the `anki` library on PATH; see fixture.js\'s own top comment');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  watch(page, []);
  await page.evaluateOnNewDocument(ankiSettingsScript(directSettings(COLLECTION)));

  await page.goto(`${BASE}/decks`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('nav.navbar span[title]'), { timeout: 20000 });

  const before = await readBadge(page);
  console.log('before locking:', before);
  await page.screenshot({ path: path.join(OUT, '08-locked-before.png') });
  must(/closed/i.test(before.label), `expected the direct/closed mode before locking anything, got: ${JSON.stringify(before)}`);

  console.log('opening the fixture with the real anki library and holding it open...');
  const holder = holdCollectionOpen(COLLECTION);
  await holder.held;
  console.log('lock is held; waiting for the UI to notice');
  await sleep(POLL_SETTLE_MS);

  const locked = await readBadge(page);
  console.log('while locked:', locked);
  await page.screenshot({ path: path.join(OUT, '09-locked-during.png') });
  must(/locked/i.test(locked.label), `expected the locked mode while the fixture is held open, got: ${JSON.stringify(locked)}`);
  must(
    /bridge is not reachable/i.test(locked.title) && /Close Anki/i.test(locked.title),
    `the locked badge did not explain itself the way src/utils/ankiModeText.js promises: ${locked.title}`,
  );

  console.log('releasing the lock...');
  await holder.release();
  await sleep(POLL_SETTLE_MS);

  const after = await readBadge(page);
  console.log('after releasing:', after);
  await page.screenshot({ path: path.join(OUT, '10-locked-after.png') });
  must(/closed/i.test(after.label), `expected the mode to flip back after releasing the lock, got: ${JSON.stringify(after)}`);

  console.log('\nOK: the locked path is proven end to end - reported, explained, and reversible.');
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
