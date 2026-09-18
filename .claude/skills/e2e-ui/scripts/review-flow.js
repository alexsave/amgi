// Drives one full card through the hands-free review loop and prints the
// phase transitions with timestamps, so the voice-activity timing can be
// checked against the clock rather than by eye.
//
//   node .claude/skills/e2e-ui/scripts/review-flow.js
//
// Expected shape: "Listen…" while the prompt plays, "Speak your answer" when
// the mic opens, then "How did you do?" about (leadMs + speechMs + 1200ms)
// later - 1200ms being the silence the detector waits for.
const path = require('path');
const fs = require('fs');
const { launch, watch, sleep } = require('./lib');
const fakeVoiceScript = require('./fakevoice');

const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = process.env.OUT || path.join(process.cwd(), '.e2e', 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  const logs = [];
  watch(page, logs);
  await page.evaluateOnNewDocument(fakeVoiceScript({ leadMs: 500, speechMs: 1500 }));

  const stamp = () => new Date().toISOString().slice(14, 23);
  const shot = async (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
  const phase = () => page.evaluate(() => document.querySelector('.review-phase')?.innerText || '');

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.click('.test-account-button');
  await page.waitForSelector('.deck-item', { timeout: 20000 });
  await page.click('.deck-item');
  await page.waitForSelector('.review-gate', { timeout: 20000 });
  await shot('review-gate');

  await page.click('.review-gate .primary-btn');
  console.log(`${stamp()} started`);

  let last = null;
  for (let i = 0; i < 120; i++) {
    const p = await phase();
    if (p && p !== last) {
      console.log(`${stamp()} phase -> ${p}`);
      last = p;
    }
    if (p === 'Speak your answer' && !fs.existsSync(path.join(OUT, 'review-listening.png'))) {
      await shot('review-listening');
    }
    if (p === 'How did you do?') {
      await shot('review-answer');
      break;
    }
    await sleep(250);
  }

  console.log('card:', JSON.stringify(await page.evaluate(() => ({
    front: document.querySelector('.flashcard-text.front')?.innerText,
    back: document.querySelector('.flashcard-text.back')?.innerText,
  }))));

  // Grade it the way a user would: space is Good, 1 is Again.
  await page.keyboard.press('Space');
  await sleep(1500);
  console.log(`${stamp()} after space -> ${await phase()}`);
  console.log('counts:', await page.evaluate(() => document.querySelector('.review-counts')?.innerText.replace(/\n/g, ' ')));

  const problems = logs.filter((l) => /pageerror|requestfailed|\[http [45]/.test(l));
  console.log(problems.length ? `\nproblems:\n${problems.join('\n')}` : '\nno page errors');
  await browser.close();
})();
