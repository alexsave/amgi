// Drives one amgi UI in headless Chrome (cdom's tools/cdp.mjs: one Chrome, killed by its own PID)
// against a fixture collection, and screenshots the same screens for either app:
//   01-decks       the deck list, settled ("Anki connected", every deck drawn)
//   02-settings    Settings, reached with the navbar's button, its profile scan done
//   03-back        the browser's back button from Settings (the history entry before)
//   04-deck        a deck row clicked: /deck/<id>
//   05-back-again  back from there
// and checks the address and the screen at each step. Then it times first paint over fresh loads.
//
//   node ui/tools/shoot.mjs <base url> <name> <collection.anki2> [out dir]
//   APP=react seeds the React app's localStorage; otherwise the C app's store gets the header block.
//   LOADS (default 7) first-paint loads; 0 skips timing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { launch, sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));

const [base, name, collection, outArg] = process.argv.slice(2);
if (!base || !name || !collection) {
  console.error('usage: node ui/tools/shoot.mjs <base url> <name> <collection.anki2> [out dir]');
  process.exit(2);
}
const out = outArg || path.join(here, '..', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const fixtureDir = path.dirname(path.resolve(collection));
const react = process.env.APP === 'react';
const LOADS = Number(process.env.LOADS ?? 7);

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// Until fn (an expression) is truthy, at most tries x 100 ms; returns its last value.
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

// The settings, as each app keeps them: React's localStorage JSON, or the C app's cdom_store entry
// (the header block the server reads, percent-encoded).
async function seed(b) {
  await goto(b, `${base}/__seed__`); // a 404 on the same origin: no app runs here
  if (react) {
    const settings = { baseDirOverride: fixtureDir, collectionPath: path.resolve(collection), profileName: '',
      bridge: { baseUrl: 'http://127.0.0.1:8798', token: '' } };
    await b.evaluate(`localStorage.setItem('amgi:anki-settings', ${JSON.stringify(JSON.stringify(settings))})`);
    return;
  }
  const block = [
    ['X-Amgi-Base-Dir', fixtureDir], ['X-Amgi-Collection', path.resolve(collection)], ['X-Amgi-Profile', ''],
    ['X-Amgi-Bridge-Url', 'http://127.0.0.1:8798'], ['X-Amgi-Bridge-Token', ''],
  ].map(([k, v]) => `${k}: ${encodeURIComponent(v)}\n`).join('');
  await b.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('cdom', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(new TextEncoder().encode(${JSON.stringify(block)}), 'amgi:anki-settings:1');
      tx.oncomplete = () => { open.result.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  })`);
}

const shot = async (b, file) => {
  const { result } = await b.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}-${file}.png`), Buffer.from(result.data, 'base64'));
};
// A real click: the pointer pressed and released at the element's centre.
async function click(b, selector) {
  const box = await b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!box) throw new Error(`nothing to click at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}
async function back(b) {
  const { result } = await b.send('Page.getNavigationHistory');
  await b.send('Page.navigateToHistoryEntry', { entryId: result.entries[result.currentIndex - 1].id });
}
const settled = `document.querySelectorAll('.deck-item').length > 0 && document.querySelector('nav.navbar span[title]')?.textContent === 'Anki connected' ? document.querySelectorAll('.deck-item').length : 0`;

const b = await launch(['--hide-scrollbars']);
const pageErrors = [];
b.onEvent = (d) => {
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await b.send('Network.enable');
  await seed(b);

  await goto(b, `${base}/decks`);
  const decks = await until(b, settled);
  check(decks === 6, `deck list shows 6 decks (saw ${decks})`);
  const names = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].map(h => h.textContent).join(' | ')`);
  check(names.includes('한국어::일상 표현'), `Korean deck names arrive intact: ${names}`);
  await sleep(400);
  await shot(b, '01-decks');

  await click(b, 'button[title="Settings"]');
  const scanned = await until(b, `location.pathname === '/settings' && !!document.querySelector('.settings-page .message.error') && [...document.querySelectorAll('.save-button')].some(x => x.textContent === 'Scan for profiles')`);
  check(scanned, `Settings shows at /settings with the profile scan done (at ${await b.evaluate('location.pathname')})`);
  await sleep(400);
  await shot(b, '02-settings');

  await back(b);
  const backed = await until(b, `location.pathname === '/decks' && (${settled}) === 6 && !document.querySelector('.settings-page')`);
  check(backed, 'the back button returns to /decks and its list');
  await sleep(400);
  await shot(b, '03-back');

  const deckId = await b.evaluate(`fetch('/api/anki/decks', { headers: { 'x-amgi-anki-settings': ${JSON.stringify(JSON.stringify({ collectionPath: path.resolve(collection) }))} } }).then(r => r.json()).then(j => String(j.decks.find(d => d.name === '한국어').id))`);
  await click(b, '.deck-item:nth-child(5)');
  const atDeck = await until(b, `location.pathname === '/deck/${deckId}'`);
  check(atDeck, `a deck row goes to /deck/${deckId}`);
  await sleep(600);
  await shot(b, '04-deck');
  await back(b);
  check(await until(b, `location.pathname === '/decks' && (${settled}) === 6`), 'back again lands on the list');
  await sleep(400);
  await shot(b, '05-back-again');

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);

  // First paint: fresh loads with the browser's cache cleared each time.
  if (LOADS) {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      new MutationObserver((_, o) => {
        if (document.querySelector('.deck-item') && !window.__decksAt) {
          window.__decksAt = performance.now();
          requestAnimationFrame(() => setTimeout(() => { window.__decksPainted = performance.now(); }, 0));
          o.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });` });
    const rows = [];
    for (let i = 0; i < LOADS; i++) {
      await b.send('Network.clearBrowserCache');
      await goto(b, `${base}/decks`);
      await until(b, `window.__decksPainted`);
      await sleep(300);
      rows.push(await b.evaluate(`(() => {
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
        const res = performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation'));
        return { fcp, decks: window.__decksPainted, requests: res.length,
          bytes: res.reduce((n, r) => n + (r.transferSize || 0), 0), decoded: res.reduce((n, r) => n + (r.decodedBodySize || 0), 0) };
      })()`));
    }
    const med = (k) => rows.map((r) => r[k]).sort((x, y) => x - y)[rows.length >> 1];
    console.log(`first paint over ${LOADS} cold loads (median ms): FCP ${med('fcp').toFixed(1)}, deck list painted ${med('decks').toFixed(1)}; ` +
      `${med('requests')} requests, ${med('bytes')} bytes transferred, ${med('decoded')} decoded`);
    console.log(`  every load: ${rows.map((r) => `${r.fcp.toFixed(0)}/${r.decks.toFixed(0)}`).join(' ')}`);
  }
} finally {
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
