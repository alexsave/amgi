#!/usr/bin/env node
'use strict';

// Drives the card template in headless Chrome, through a stand-in for Anki's
// reviewer (reviewer.html). Anki itself is not installed here, so this proves
// everything that is ordinary web behaviour - sequencing, the microphone, when
// the answer text appears, which pycmd each key sends - and nothing about
// Anki's own bridge, media server or keyboard. anki/README.md lists what that
// leaves unverified.
//
//   node anki/test/harness/drive.js            # both paths, headless
//   HEADLESS=false node anki/test/harness/drive.js
//
// Exits non-zero on the first failed check.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL = path.join(ROOT, '.claude', 'skills', 'e2e-ui', 'scripts');
const fakeVoiceScript = require(path.join(SKILL, 'fakevoice.js'));
const { launch, watch } = require(path.join(SKILL, 'lib.js'));
const { build, OUTPUT } = require(path.join(ROOT, 'anki', 'tools', 'build-loop.js'));

const CARDS = [
  {
    Prompt: 'the shop closes at six',
    PromptAudio: '<audio src="prompt-1.wav"></audio>',
    Answer: '가게는 여섯 시에 문을 닫아요',
    AnswerAudio: '<audio src="native-1.wav"></audio>',
    Notes: '',
  },
  {
    Prompt: 'see you tomorrow',
    PromptAudio: '<audio src="prompt-2.wav"></audio>',
    Answer: '내일 봐요',
    AnswerAudio: '<audio src="native-2.wav"></audio>',
    Notes: '',
  },
];

// --- a media folder, the way Anki serves one -------------------------------

/** A plain 16-bit mono WAV of a quiet tone, so nothing external is needed. */
function wav(seconds, hz) {
  const rate = 8000;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mediaFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-anki-'));
  fs.writeFileSync(OUTPUT, build());
  fs.copyFileSync(OUTPUT, path.join(dir, '_amgi-loop.js'));
  fs.copyFileSync(path.join(ROOT, 'anki', 'media', '_amgi-loop.css'), path.join(dir, '_amgi-loop.css'));
  fs.copyFileSync(path.join(__dirname, 'reviewer.html'), path.join(dir, 'reviewer.html'));
  fs.writeFileSync(path.join(dir, 'prompt-1.wav'), wav(0.8, 320));
  fs.writeFileSync(path.join(dir, 'prompt-2.wav'), wav(0.8, 380));
  fs.writeFileSync(path.join(dir, 'native-1.wav'), wav(0.6, 440));
  fs.writeFileSync(path.join(dir, 'native-2.wav'), wav(0.6, 500));
  return dir;
}

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.wav': 'audio/wav' };

function serve(dir) {
  const server = http.createServer((request, response) => {
    const name = path.basename(decodeURIComponent(request.url.split('?')[0]));
    if (name === 'favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      if (process.env.HARNESS_DEBUG) process.stderr.write(`404 ${request.url}\n`);
      response.writeHead(404).end('no such file');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --- checks ----------------------------------------------------------------

const results = [];

function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  process.stdout.write(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` - ${detail}` : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(page, predicate, { timeout = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(predicate)) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

async function startReview(page, port) {
  const front = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'front.html'), 'utf8');
  const back = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'back.html'), 'utf8');
  await page.goto(`http://127.0.0.1:${port}/reviewer.html`, { waitUntil: 'load' });
  await page.evaluate((config) => window.harness.start(config), { front, back, cards: CARDS });
}

// --- the two paths ---------------------------------------------------------

async function withMicrophone(browser, port, logs) {
  process.stdout.write('\nthe hands-free path, with a microphone\n');
  const page = await browser.newPage();
  watch(page, logs);
  // 500ms of room tone, 1500ms of "speech", then silence: the detector should
  // end the turn 1200ms into the silence.
  await page.evaluateOnNewDocument(fakeVoiceScript({ leadMs: 500, speechMs: 1500 }));
  await startReview(page, port);

  await waitFor(page, () => window.phaseIs('listening'), { label: 'the microphone to open' });
  const openedAt = Date.now();
  check('the microphone opens by itself after the prompt', true);

  const duringListening = await page.evaluate(() => ({
    text: document.body.textContent,
    commands: window.harness.commands.map((entry) => entry.command),
  }));
  check(
    'the answer text is nowhere in the DOM while the learner speaks',
    !duringListening.text.includes(CARDS[0].Answer),
    `listening-phase DOM has ${duringListening.text.trim().length} characters of text`
  );
  check(
    'nothing has been revealed or graded yet',
    duringListening.commands.length === 0,
    `commands: ${JSON.stringify(duringListening.commands)}`
  );

  await waitFor(page, () => window.phaseIs('answer'), { label: 'the turn to end on silence' });
  const turnMs = Date.now() - openedAt;
  check(
    'voice activity ends the turn on silence, not on a timeout',
    turnMs > 2500 && turnMs < 5000,
    `turn lasted ${turnMs}ms (speech ends at ~2000ms, silence window is 1200ms, the no-speech timeout is 8000ms)`
  );

  const revealed = await page.evaluate(() => ({
    commands: window.harness.commands.map((entry) => entry.command),
    renders: window.harness.renders.map((entry) => entry.side),
    text: document.body.textContent,
  }));
  check('the reveal went through pycmd("ans")', revealed.commands[0] === 'ans', JSON.stringify(revealed.commands));
  check('the back side rendered', revealed.renders.join(',') === 'front,back', revealed.renders.join(','));
  check('the answer text is on the page now', revealed.text.includes(CARDS[0].Answer));

  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-amgi-answer-audio] audio');
      return !!el && el.played && el.played.length > 0;
    },
    { label: 'the native audio to play' }
  );
  check('the native audio played on reveal', true);

  const you = await page.evaluate(() => {
    const button = document.querySelector('[data-amgi-action="replay-you"]');
    return { present: !!button, offered: button ? !button.hidden : false };
  });
  check('the learner\'s own recording is offered for replay', you.offered, JSON.stringify(you));

  // Space and 1 are deliberately NOT handled by the template on the answer
  // side any more (see anki/README.md, "Keys"): real Anki's own native
  // shortcuts and the webview's own keydown handler used to both fire on
  // these keys, racing unpredictably, and a double pycmd("easeN") corrupts
  // the *next* card's schedule silently. Grading here goes through the
  // on-screen buttons instead, exactly as a learner clicking them would, and
  // this check proves the template no longer reacts to the key at all.
  await page.keyboard.press('Space');
  await sleep(200);
  check(
    'space no longer grades the card itself - that is Anki\'s own shortcut\'s job now',
    await page.evaluate(() => !window.harness.commands.some((entry) => entry.command.startsWith('ease')))
  );

  await page.click('[data-amgi-action="good"]');
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'the Good button grades the card, as pycmd("ease3")',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease3')),
    await page.evaluate(() => JSON.stringify(window.harness.commands.map((c) => c.command)))
  );

  // Second card, graded Again this time. Waiting on the render count rather
  // than on the phase: the card just graded still reads "answer" until its
  // markup is replaced.
  await waitFor(page, () => window.harness.renders.length === 4, {
    timeout: 20000,
    label: 'the second card to reveal',
  });
  await waitFor(page, () => window.phaseIs('answer'), { timeout: 20000, label: 'the second answer' });
  await page.keyboard.press('Digit1');
  await sleep(200);
  check(
    '1 no longer grades the card itself either',
    await page.evaluate(() => !window.harness.commands.some((entry) => entry.command === 'ease1'))
  );
  await page.click('[data-amgi-action="again"]');
  await waitFor(page, () => !!document.getElementById('congrats'), { label: 'the session to finish' });
  check(
    'the Again button grades the card, as pycmd("ease1")',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease1'))
  );

  const leaks = await page.evaluate(() => window.harness.leaks);
  check('the answer never appeared early, at any point in the session', leaks.length === 0, JSON.stringify(leaks));

  const order = await page.evaluate(() => window.harness.phases.map((entry) => entry.phase).join(' '));
  process.stdout.write(`  phases: ${order}\n`);
  await page.close();
}

async function withoutMicrophone(browser, port, logs) {
  process.stdout.write('\nthe fallback path, with no microphone at all\n');
  const page = await browser.newPage();
  watch(page, logs);
  // What Anki desktop does without the add-on: the request is refused.
  await page.evaluateOnNewDocument(`
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  `);
  await startReview(page, port);

  await waitFor(page, () => window.phaseIs('waiting'), { label: 'the no-microphone phase' });
  const waiting = await page.evaluate(() => ({
    text: document.body.textContent,
    note: document.querySelector('[data-amgi-note]').textContent,
    noteShown: !document.querySelector('[data-amgi-note]').hidden,
    commands: window.harness.commands.length,
  }));
  check('the card does not reveal itself without a microphone', waiting.commands === 0);
  check('the answer text is still nowhere in the DOM', !waiting.text.includes(CARDS[0].Answer));
  check('the learner is told what to do', waiting.noteShown && /space/i.test(waiting.note), waiting.note);

  await sleep(1200);
  check(
    'and it stays that way until a key is pressed',
    await page.evaluate(() => window.phaseIs('waiting') && window.harness.commands.length === 0)
  );

  await page.keyboard.press('Space');
  await waitFor(page, () => window.phaseIs('answer'), { label: 'space to reveal' });
  check('space reveals the card', true);
  check(
    'the reveal went through pycmd("ans")',
    await page.evaluate(() => window.harness.commands[0].command === 'ans')
  );
  check(
    'the answer text is on the page now',
    await page.evaluate((answer) => document.body.textContent.includes(answer), CARDS[0].Answer)
  );

  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-amgi-answer-audio] audio');
      return !!el && el.played && el.played.length > 0;
    },
    { label: 'the native audio to play' }
  );
  check('the native audio still plays', true);

  const you = await page.evaluate(() => document.querySelector('[data-amgi-action="replay-you"]').hidden);
  check('no recording is offered, because there was none', you === true);

  // As above: grading is Anki's own native shortcut's job now, not the
  // template's keydown handler, so the button is what actually grades here.
  await page.click('[data-amgi-action="good"]');
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading still works',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease3'))
  );

  const leaks = await page.evaluate(() => window.harness.leaks);
  check('the answer never appeared early', leaks.length === 0, JSON.stringify(leaks));
  await page.close();
}

async function withHangingMicrophone(browser, port, logs) {
  process.stdout.write('\nthe fallback path, with a microphone permission that never settles\n');
  const page = await browser.newPage();
  watch(page, logs);
  // What real Anki desktop does (Qt 6.11, no permission-handling add-on
  // installed): getUserMedia() is left in "ask" state forever - it neither
  // resolves nor rejects. The plain-rejection scenario above does not cover
  // this; confirmed against real Anki, see anki/README.md.
  await page.evaluateOnNewDocument(`
    window.amgiLoopConfig = { micTimeoutMs: 400 };
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  `);
  await startReview(page, port);

  const startedAt = Date.now();
  await waitFor(page, () => window.phaseIs('waiting'), {
    timeout: 5000,
    label: 'the timeout fallback to kick in',
  });
  const elapsedMs = Date.now() - startedAt;
  check(
    'a microphone request that never settles still reaches the fallback, on the configured timeout',
    elapsedMs < 5000,
    `reached "waiting" after ${elapsedMs}ms`
  );

  const waiting = await page.evaluate(() => ({
    text: document.body.textContent,
    note: document.querySelector('[data-amgi-note]').textContent,
    noteShown: !document.querySelector('[data-amgi-note]').hidden,
    commands: window.harness.commands.length,
  }));
  check('the card does not reveal itself once it falls back', waiting.commands === 0);
  check('the answer text is still nowhere in the DOM', !waiting.text.includes(CARDS[0].Answer));
  check('the learner is told what to do', waiting.noteShown && /space/i.test(waiting.note), waiting.note);

  await page.keyboard.press('Space');
  await waitFor(page, () => window.phaseIs('answer'), { label: 'space to reveal after the fallback' });
  check('space still reveals the card after the timeout fallback', true);
  check(
    'the reveal went through pycmd("ans")',
    await page.evaluate(() => window.harness.commands[0].command === 'ans')
  );

  // Grading is Anki's own native shortcut's job now (see the two scenarios
  // above), so the button is what actually grades here, not the key.
  await page.click('[data-amgi-action="good"]');
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading still works after a microphone request that never settled',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease3'))
  );

  const leaks = await page.evaluate(() => window.harness.leaks);
  check('the answer never appeared early', leaks.length === 0, JSON.stringify(leaks));
  await page.close();
}

async function main() {
  const dir = mediaFolder();
  const { server, port } = await serve(dir);
  const logs = [];
  const browser = await launch({
    headless: process.env.HEADLESS === 'false' ? false : 'new',
    width: 900,
    height: 760,
  });

  try {
    for (const run of [withMicrophone, withoutMicrophone, withHangingMicrophone]) {
      await run(browser, port, logs);
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const noise = logs.filter((line) => !line.includes('favicon'));
  if (noise.length) {
    process.stdout.write(`\nbrowser log\n${noise.map((line) => `  ${line}`).join('\n')}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
