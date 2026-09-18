const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launch(opts = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: opts.headless === undefined ? 'new' : opts.headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      '--hide-scrollbars',
      ...(opts.audioFile ? [`--use-file-for-fake-audio-capture=${opts.audioFile}`] : []),
      ...(opts.args || []),
    ],
    defaultViewport: { width: opts.width || 1280, height: opts.height || 900, deviceScaleFactor: 2 },
  });
  return browser;
}

function watch(page, sink) {
  page.on('console', (m) => sink.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => sink.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => sink.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) sink.push(`[http ${r.status()}] ${r.url()}`); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { launch, watch, sleep, CHROME };
