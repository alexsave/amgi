// Screenshots a list of routes as the signed-in test user.
//
//   node .claude/skills/e2e-ui/scripts/shoot.js /decks /settings
//   VIEWPORT=390x844 OUT=.e2e/shots-mobile node .../shoot.js /decks
//
// Prints every console error, failed request and 4xx/5xx it saw, which is
// usually where the real bugs turn up.
const path = require('path');
const fs = require('fs');
const { launch, watch, sleep } = require('./lib');

const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = process.env.OUT || path.join(process.cwd(), '.e2e', 'shots');
const [width, height] = (process.env.VIEWPORT || '1280x900').split('x').map(Number);

(async () => {
  const routes = process.argv.slice(2);
  if (!routes.length) {
    console.error('usage: shoot.js <route> [route...]');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch({ width, height });
  const page = await browser.newPage();
  const logs = [];
  watch(page, logs);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  const testAccount = await page.$('.test-account-button');
  if (testAccount) {
    await testAccount.click();
    await page.waitForSelector('.deck-item, .empty-deck-state', { timeout: 20000 }).catch(() => {});
  }

  for (const route of routes) {
    const name = route.replace(/[^a-z0-9]+/gi, '_') || 'root';
    await page.goto(BASE + route, { waitUntil: 'networkidle2' }).catch((e) => logs.push(`[goto ${route}] ${e.message}`));
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`${route} -> ${path.join(OUT, name)}.png (landed on ${page.url()})`);
  }

  const problems = logs.filter((l) => /pageerror|requestfailed|console\.error|\[http [45]/.test(l));
  console.log(problems.length ? `\nproblems:\n${problems.join('\n')}` : '\nno console errors or failed requests');
  await browser.close();
})();
