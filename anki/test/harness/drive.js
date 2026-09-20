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
    Cue: 'the shop closes at six',
    CueAudio: '<audio src="prompt-1.wav"></audio>',
    Target: '가게는 여섯 시에 문을 닫아요',
    TargetAudio: '<audio src="native-1.wav"></audio>',
    Notes: '',
  },
  {
    Cue: 'see you tomorrow',
    CueAudio: '<audio src="prompt-2.wav"></audio>',
    Target: '내일 봐요',
    TargetAudio: '<audio src="native-2.wav"></audio>',
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
  // The note type's OWN stylesheet, which Anki applies to every card and this
  // harness used not to load at all. That gap was not academic: styling.css is
  // where the card's background, its type and its margin live, so without it
  // every check here ran against a white page in the browser's default font -
  // the two things most likely to be wrong after a visual change, and the two
  // things nothing could catch.
  fs.copyFileSync(path.join(ROOT, 'anki', 'notetype', 'styling.css'), path.join(dir, 'styling.css'));
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

/**
 * The average colour of whatever the visualizer canvas currently has drawn on
 * it (transparent pixels excluded), or null if it is blank. Sampling the
 * actual rendered pixels - not just checking the canvas got sized - is what
 * proves each audio source really gets its own colour rather than all three
 * sharing whatever the last one drew.
 */
async function dominantColor(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-amgi-visualizer]');
    if (!canvas || !canvas.width) return null;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 10) continue; // skip transparent (undrawn) pixels
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    return n ? { r: r / n, g: g / n, b: b / n, n } : null;
  });
}

async function waitForColor(page, matches, { timeout = 4000, label = 'a colour' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const color = await dominantColor(page);
    if (color && matches(color)) return color;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}, last saw ${JSON.stringify(color)}`);
    }
    await sleep(50);
  }
}

const isAmberDominant = (c) => c.r > c.g + 15 && c.r > c.b + 15;
const isGreenDominant = (c) => c.g > c.r + 10 && c.g >= c.b;
const isBlueDominant = (c) => c.b > c.r + 10 && c.b > c.g + 10;

async function startReview(page, port) {
  const front = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'front.html'), 'utf8');
  const back = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'back.html'), 'utf8');
  await page.goto(`http://127.0.0.1:${port}/reviewer.html`, { waitUntil: 'load' });
  await page.evaluate((config) => window.harness.start(config), { front, back, cards: CARDS });
}

/**
 * What .amgi-status is for role="status"/aria-live="polite"): its own
 * subtree mutating is what makes assistive tech (re)announce it, and the
 * recording callout leaning on that - rather than a second live region of
 * its own - only actually reaches a screen reader if toggling it really is
 * such a mutation. Rather than trust that, this attaches a MutationObserver
 * scoped to .amgi-status and records every mutation whose target sits inside
 * the recording callout, the same signal a screen reader's own accessibility
 * tree listener reacts to.
 */
async function watchRecordingAnnouncements(page) {
  await page.evaluate(() => {
    window.__amgiRecordingMutations = [];
    const region = document.querySelector('[data-amgi-status]');
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (node && node.closest('[data-amgi-status-recording]')) {
          window.__amgiRecordingMutations.push({ type: record.type, attributeName: record.attributeName || null });
        }
      }
    });
    observer.observe(region, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

async function recordingIndicator(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-amgi-status-recording]');
    const dot = document.querySelector('.amgi-status-dot');
    return {
      present: !!el,
      visible: !!el && !el.hidden,
      text: el ? el.textContent.trim() : '',
      hasDot: !!dot,
    };
  });
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

  check(
    'the visualizer canvas is present on the front template',
    await page.evaluate(() => !!document.querySelector('[data-amgi-visualizer]'))
  );

  // Told before the mic opens, not after: the owner's fix for a first-time
  // learner's real question ("is my mic about to turn on?"). The clip
  // actually playing at this phase is CueAudio, the gloss/translation clip
  // (see anki/README.md's field table), so "the translation" is accurate
  // here - and the recording callout must not exist yet, since the mic isn't
  // open yet either.
  await waitFor(page, () => window.phaseIs('prompt'), { label: 'the prompt phase' });
  const duringPrompt = await recordingIndicator(page);
  check(
    'the prompt-phase status tells the learner the mic is coming, before it opens',
    await page.evaluate(() => document.querySelector('[data-amgi-status-text]').textContent.includes('translation')),
    await page.evaluate(() => document.querySelector('[data-amgi-status-text]').textContent)
  );
  check('no recording is claimed before the microphone actually opens', !duringPrompt.visible, JSON.stringify(duringPrompt));

  await watchRecordingAnnouncements(page);

  await waitFor(page, () => window.phaseIs('listening'), { label: 'the microphone to open' });
  const openedAt = Date.now();
  check('the microphone opens by itself after the prompt', true);

  // The callout is honest by construction (reviewLoop.js's listen() only
  // ever runs after openMic() has resolved with a live stream), not just by
  // convention - see anki-loop.js's AMGI_STATUS. This is what proves it
  // actually renders that way, and that a screen reader would actually hear
  // about it (see watchRecordingAnnouncements above), not just that the DOM
  // node exists.
  const whileListening = await recordingIndicator(page);
  check('a red-dot recording indicator appears the instant the mic is live', whileListening.visible, JSON.stringify(whileListening));
  check('it has an actual dot element, not just coloured text', whileListening.hasDot);
  check(
    'it says so in words too, in the owner\'s own wording',
    whileListening.text === 'Now recording your voice.',
    whileListening.text
  );
  check(
    'the existing "stop talking" guidance is still there alongside it',
    await page.evaluate(() => /stop talking/i.test(document.querySelector('[data-amgi-status-text]').textContent))
  );
  const announcedWhileOpening = await page.evaluate(() => window.__amgiRecordingMutations.length);
  check(
    'the callout appearing is a real mutation inside the aria-live status region, not a silent one',
    announcedWhileOpening > 0,
    `${announcedWhileOpening} mutations touched the recording callout`
  );

  // The canvas keeps its browser-default backing size (300x150) until
  // anki-loop.js's visualizer actually sizes and draws on it, which only
  // happens once a real AnalyserNode is feeding it - so a size change here is
  // proof the mic's own analyser (see voiceActivity.js) is reaching the
  // drawing code, not a second graph built for the visualizer alone.
  await waitFor(
    page,
    () => {
      const canvas = document.querySelector('[data-amgi-visualizer]');
      return !!canvas && canvas.width > 0 && canvas.width !== 300;
    },
    { label: 'the visualizer to size and draw while the microphone is open' }
  );
  check('the visualizer reacts while the microphone is open', true);

  // The mic is always the learner's own voice - drawn in the "you" colour
  // whether it is live (here) or a later "You" replay - and the fake stream's
  // 180Hz tone during its "speech" window is real enough signal to prove it.
  const micColor = await waitForColor(page, isAmberDominant, {
    label: 'the visualizer to draw the microphone in the orange "you" colour',
  });
  check('the microphone draws in the "you" colour, not the prompt or native colour', true, JSON.stringify(micColor));

  const duringListening = await page.evaluate(() => ({
    text: document.body.textContent,
    commands: window.harness.commands.map((entry) => entry.command),
  }));
  check(
    'the answer text is nowhere in the DOM while the learner speaks',
    !duringListening.text.includes(CARDS[0].Target),
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

  // Gone the instant the mic is not live any more, not lingering into the
  // answer: reviewLoop.js sets PHASE.ANSWER only after closeMic() has
  // actually stopped the tracks (see anki-loop.js's stopMicrophone), and
  // ui.phase('answer') hides the callout in that same synchronous step,
  // before the back side even renders.
  const afterListening = await recordingIndicator(page);
  check('the recording indicator is gone once the turn ends', !afterListening.visible, JSON.stringify(afterListening));
  const announcedByAnswer = await page.evaluate(() => window.__amgiRecordingMutations.length);
  check(
    'the callout disappearing is also a real mutation inside the live region, not left stale',
    announcedByAnswer > announcedWhileOpening,
    `${announcedWhileOpening} -> ${announcedByAnswer}`
  );

  const revealed = await page.evaluate(() => ({
    commands: window.harness.commands.map((entry) => entry.command),
    renders: window.harness.renders.map((entry) => entry.side),
    text: document.body.textContent,
  }));
  check('the reveal went through pycmd("ans")', revealed.commands[0] === 'ans', JSON.stringify(revealed.commands));
  check('the back side rendered', revealed.renders.join(',') === 'front,back', revealed.renders.join(','));
  check('the answer text is on the page now', revealed.text.includes(CARDS[0].Target));

  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-amgi-target-audio] audio');
      return !!el && el.played && el.played.length > 0;
    },
    { label: 'the native audio to play' }
  );
  check('the native audio played on reveal', true);
  check(
    'the visualizer canvas is present on the back template',
    await page.evaluate(() => !!document.querySelector('[data-amgi-visualizer]'))
  );
  await waitFor(
    page,
    () => {
      const canvas = document.querySelector('[data-amgi-visualizer]');
      return !!canvas && canvas.width > 0 && canvas.width !== 300;
    },
    { label: 'the visualizer to size and draw for the automatic native playback' }
  );
  check('the visualizer reacts to the native audio on reveal', true);

  const nativeColor = await waitForColor(page, isGreenDominant, {
    label: 'the visualizer to draw the native audio in the green "native" colour',
  });
  check('the native audio draws in its own colour, not the "you" colour', true, JSON.stringify(nativeColor));

  const you = await page.evaluate(() => {
    const button = document.querySelector('[data-amgi-action="replay-you"]');
    return { present: !!button, offered: button ? !button.hidden : false };
  });
  check('the learner\'s own recording is offered for replay', you.offered, JSON.stringify(you));

  // Replaying the prompt from the answer side has to be its own colour too -
  // the source, not the phase, is what the colour is keyed to (see
  // _amgi-loop.css), so "answer phase, prompt clip" must still draw blue.
  await page.click('[data-amgi-action="replay-cue"]');
  const promptColor = await waitForColor(page, isBlueDominant, {
    label: 'replaying the prompt on the answer side to draw in the blue "prompt" colour',
  });
  check(
    'replaying the prompt from the answer side draws in the prompt colour, not the native one',
    true,
    JSON.stringify(promptColor)
  );

  // The template draws no grading row of its own any more (see item 11 in
  // the design critique this fixed, and anki-loop.js's bootBack): grading is
  // entirely Anki's own Again/Hard/Good/Easy bar's job, on every client. This
  // harness has no such bar (reviewer.html is a stand-in for the reviewer,
  // not for Anki's own chrome around it - see anki/README.md), so a real
  // grading keypress is simulated the way Anki's own native QShortcut would
  // actually reach the card: a direct pycmd("easeN") that never goes through
  // the template at all. Space and 1 are also confirmed to do nothing to the
  // template itself, since it no longer has a keydown handler on this side.
  check(
    'the card draws no grading buttons of its own any more',
    await page.evaluate(
      () => !document.querySelector('[data-amgi-action="good"]') && !document.querySelector('[data-amgi-action="again"]')
    )
  );
  const commandsBeforeKeys = await page.evaluate(() => window.harness.commands.length);
  await page.keyboard.press('Space');
  await page.keyboard.press('Digit1');
  await sleep(200);
  check(
    'space and 1 do nothing on the answer side - there is nothing left for the template to react to',
    await page.evaluate((from) => window.harness.commands.length === from, commandsBeforeKeys)
  );

  await page.evaluate(() => window.pycmd('ease3'));
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading through pycmd("ease3"), as Anki\'s own native shortcut would, advances the card',
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
  await page.evaluate(() => window.pycmd('ease1'));
  await waitFor(page, () => !!document.getElementById('congrats'), { label: 'the session to finish' });
  check(
    'grading through pycmd("ease1") also advances the card',
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
  check('the answer text is still nowhere in the DOM', !waiting.text.includes(CARDS[0].Target));
  check('the learner is told what to do', waiting.noteShown && /space/i.test(waiting.note), waiting.note);
  // Honesty in the other direction: no microphone, no claim of one.
  const noMicIndicator = await recordingIndicator(page);
  check(
    'the recording indicator never claims a microphone that was never opened',
    !noMicIndicator.visible,
    JSON.stringify(noMicIndicator)
  );

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
    await page.evaluate((answer) => document.body.textContent.includes(answer), CARDS[0].Target)
  );

  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-amgi-target-audio] audio');
      return !!el && el.played && el.played.length > 0;
    },
    { label: 'the native audio to play' }
  );
  check('the native audio still plays', true);

  const you = await page.evaluate(() => document.querySelector('[data-amgi-action="replay-you"]').hidden);
  check('no recording is offered, because there was none', you === true);

  // The card draws no grading buttons of its own (see withMicrophone above
  // for why); a direct pycmd stands in for Anki's own grading bar, which
  // this harness does not model.
  await page.evaluate(() => window.pycmd('ease3'));
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
  check(
    'the wait for the microphone is its own visible phase, not left looking like "Listen" hung',
    await page.evaluate(() => window.harness.phases.some((entry) => entry.phase === 'requesting-mic'))
  );

  const waiting = await page.evaluate(() => ({
    text: document.body.textContent,
    note: document.querySelector('[data-amgi-note]').textContent,
    noteShown: !document.querySelector('[data-amgi-note]').hidden,
    commands: window.harness.commands.length,
  }));
  check('the card does not reveal itself once it falls back', waiting.commands === 0);
  check('the answer text is still nowhere in the DOM', !waiting.text.includes(CARDS[0].Target));
  check('the learner is told what to do', waiting.noteShown && /space/i.test(waiting.note), waiting.note);

  await page.keyboard.press('Space');
  await waitFor(page, () => window.phaseIs('answer'), { label: 'space to reveal after the fallback' });
  check('space still reveals the card after the timeout fallback', true);
  check(
    'the reveal went through pycmd("ans")',
    await page.evaluate(() => window.harness.commands[0].command === 'ans')
  );

  // Grading is Anki's own native bar's job (see the scenarios above); a
  // direct pycmd stands in for it, since this harness draws no such bar.
  await page.evaluate(() => window.pycmd('ease3'));
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading still works after a microphone request that never settled',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease3'))
  );

  // A refusal is remembered on `store`, which survives across cards on the
  // desktop client (see anki-loop.js's onMicUnavailable/disableMic): the
  // second card must skip straight to "waiting" and never re-race the
  // timeout, and must not repeat the "no microphone" note either.
  const phasesBeforeSecondCard = await page.evaluate(() => window.harness.phases.length);
  await waitFor(page, () => window.phaseIs('waiting'), {
    label: 'the second card to skip straight to the fallback with no mic request',
  });
  const secondCardPhases = await page.evaluate(
    (from) => window.harness.phases.slice(from).map((entry) => entry.phase),
    phasesBeforeSecondCard
  );
  check(
    'a remembered mic refusal skips the "asking for the microphone" phase on the next card',
    !secondCardPhases.includes('requesting-mic'),
    JSON.stringify(secondCardPhases)
  );
  const secondNote = await page.evaluate(() => document.querySelector('[data-amgi-note]').textContent.trim());
  check('the "no microphone" note is said once, not on every card', secondNote === '', secondNote);

  const leaks = await page.evaluate(() => window.harness.leaks);
  check('the answer never appeared early', leaks.length === 0, JSON.stringify(leaks));
  await page.close();
}

async function withoutCueAudio(browser, port, logs) {
  process.stdout.write('\na card with no cue audio at all\n');
  const page = await browser.newPage();
  watch(page, logs);
  // A microphone that would otherwise work fine - the point is that a note
  // missing its own prompt must never open it, because there is nothing to
  // answer (see anki-loop.js's bootFront, hasCueAudio).
  await page.evaluateOnNewDocument(fakeVoiceScript({ leadMs: 200, speechMs: 1000 }));
  await page.evaluateOnNewDocument(`
    window.__micRequests = 0;
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      window.__micRequests += 1;
      return realGetUserMedia(constraints);
    };
  `);
  const front = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'front.html'), 'utf8');
  const back = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', 'back.html'), 'utf8');
  await page.goto(`http://127.0.0.1:${port}/reviewer.html`, { waitUntil: 'load' });
  const cards = [{ ...CARDS[0], CueAudio: '' }, CARDS[1]];
  await page.evaluate((config) => window.harness.start(config), { front, back, cards });

  await waitFor(page, () => window.phaseIs('waiting'), {
    label: 'a card with no cue audio to skip straight to the fallback',
  });
  check(
    'a card with no cue audio never asks for the microphone at all',
    await page.evaluate(() => window.__micRequests === 0)
  );
  const note = await page.evaluate(() => document.querySelector('[data-amgi-note]').textContent);
  check('the learner is told the card has no audio yet, not a generic mic error', /no audio yet/i.test(note), note);

  await page.keyboard.press('Space');
  await waitFor(page, () => window.phaseIs('answer'), { label: 'space to reveal a card with no cue audio' });
  check('space still reveals the card', true);

  await page.evaluate(() => window.pycmd('ease3'));
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading still works',
    await page.evaluate(() => window.harness.commands.some((entry) => entry.command === 'ease3'))
  );

  const leaks = await page.evaluate(() => window.harness.leaks);
  check('the answer never appeared early', leaks.length === 0, JSON.stringify(leaks));
  await page.close();
}

async function withoutAudioContext(browser, port, logs) {
  process.stdout.write('\nthe fallback path, with no Web Audio at all (no AudioContext)\n');
  const page = await browser.newPage();
  watch(page, logs);
  // A client with no Web Audio implementation is a real, not hypothetical,
  // case (see anki/README.md's client survey) and a stricter one than "the
  // permission prompt was denied": microphone() already needs an AudioContext
  // for VAD, before the visualizer existed, and the visualizer's own
  // ensureAudioContext() must degrade the exact same way - a blank visualizer
  // and a working card, never a stuck phase or a thrown error.
  await page.evaluateOnNewDocument(`
    delete window.AudioContext;
    delete window.webkitAudioContext;
  `);
  await startReview(page, port);

  check(
    'the visualizer canvas is present even with no Web Audio in the client',
    await page.evaluate(() => !!document.querySelector('[data-amgi-visualizer]'))
  );

  await waitFor(page, () => window.phaseIs('waiting'), { label: 'the no-microphone phase (no AudioContext at all)' });
  check(
    'no microphone is offered without Web Audio, and the card asks the learner to press space',
    await page.evaluate(() => /space/i.test(document.querySelector('[data-amgi-note]').textContent))
  );

  await page.keyboard.press('Space');
  await waitFor(page, () => window.phaseIs('answer'), { label: 'space to reveal with no Web Audio' });
  check('space still reveals the card with no Web Audio in the client', true);

  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-amgi-target-audio] audio');
      return !!el && el.played && el.played.length > 0;
    },
    { label: 'the native audio to still play with no Web Audio' }
  );
  check('the native audio still plays with no AudioContext to route it through - never silent', true);

  // The canvas keeps its untouched browser-default backing size (300x150):
  // proof the visualizer's own sizing/drawing code never ran at all, rather
  // than running and happening to draw nothing.
  const untouched = await page.evaluate(() => {
    const canvas = document.querySelector('[data-amgi-visualizer]');
    return canvas.width === 300 && canvas.height === 150;
  });
  check('the visualizer canvas is never sized or drawn on - the card area stays blank, not broken', untouched);

  await page.click('[data-amgi-action="replay-native"]');
  await sleep(200);
  const stillUntouched = await page.evaluate(() => {
    const canvas = document.querySelector('[data-amgi-visualizer]');
    return canvas.width === 300 && canvas.height === 150;
  });
  check('replaying a clip by hand does not draw either, with no Web Audio available', stillUntouched);

  await page.evaluate(() => window.pycmd('ease3'));
  await waitFor(page, () => window.harness.cardIndex === 1, { label: 'the next card' });
  check(
    'grading still works with no Web Audio in the client',
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
    for (const run of [
      withMicrophone,
      withoutMicrophone,
      withHangingMicrophone,
      withoutCueAudio,
      withoutAudioContext,
    ]) {
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
