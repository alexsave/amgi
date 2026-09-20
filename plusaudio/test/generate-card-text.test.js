'use strict';

// The Node side of generate-card-text.js's own documented contract: known
// language, learning language and an input in; one line of JSON with both
// card sides and the reading out; a clean exit code. Mirrors
// generate-clip.test.js's shape for the audio side of the same boundary.
//
// `run()` is exercised here with a stubbed generator, never a real OpenAI
// client - there is no live call in this file.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { main, parseArgs, run } = require('../generate-card-text');
const { withEnvHidden } = require('./helpers/hide-env');

test('parseArgs collects a fresh-generation request', () => {
  const options = parseArgs(['--known', 'en', '--learning', 'ko', '--input', '날짜']);
  assert.deepEqual(options, { known: 'en', learning: 'ko', input: '날짜' });
});

test('parseArgs collects a regeneration request', () => {
  const options = parseArgs([
    '--known', 'en', '--learning', 'ja',
    '--current-front', 'went', '--current-back', '行った', '--current-reading', 'いった',
    '--regenerate', 'back_text',
  ]);
  assert.deepEqual(options, {
    known: 'en',
    learning: 'ja',
    'current-front': 'went',
    'current-back': '行った',
    'current-reading': 'いった',
    regenerate: 'back_text',
  });
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown option --bogus/);
});

test('run() prints the generated card as one line of JSON and returns exit code 0', async () => {
  const calls = [];
  const generate = async (request) => {
    calls.push(request);
    return { front_text: 'date', back_text: '날짜', spoken_reading: '' };
  };
  const writes = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { writes.push(chunk); return true; };
  let code;
  try {
    code = await run({ known: 'en', learning: 'ko', input: 'date' }, generate);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    userInput: 'date',
    knownLanguage: 'en',
    learningLanguage: 'ko',
    // Absent when the caller did not pass --input-language, which is what
    // tells generateCardText to work the direction out by reading.
    inputLanguage: undefined,
    currentCard: null,
    regenerateParts: [],
  }]);
  assert.deepEqual(JSON.parse(writes.join('')), { front_text: 'date', back_text: '날짜', spoken_reading: '' });
});

test('run() builds a currentCard and regenerateParts from the regeneration flags', async () => {
  const calls = [];
  const generate = async (request) => {
    calls.push(request);
    return { front_text: 'went', back_text: '行った', spoken_reading: 'いった' };
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await run(
      {
        known: 'en',
        learning: 'ja',
        'current-front': 'went',
        'current-back': '行きました',
        'current-reading': 'いきました',
        regenerate: 'back_text',
      },
      generate,
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.deepEqual(calls[0].currentCard, { front_text: 'went', back_text: '行きました', spoken_reading: 'いきました' });
  assert.deepEqual(calls[0].regenerateParts, ['back_text']);
});

test('run() writes nothing and returns exit code 1 when generation fails', async () => {
  const generate = async () => {
    throw new Error('boom');
  };
  const code = await run({ known: 'en', learning: 'ko', input: 'x' }, generate);
  assert.equal(code, 1);
});

test('main() returns exit code 2 when a required flag is missing', async () => {
  const code = await main(['--known', 'en']); // no --learning
  assert.equal(code, 2);
});

test('main() returns exit code 2 when neither --input nor a current card is given', async () => {
  const code = await main(['--known', 'en', '--learning', 'ko']);
  assert.equal(code, 2);
});

test('main() returns exit code 1 with an actionable message when OPENAI_API_KEY is unset', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Same reasoning as generate-clip.test.js's own version of this test: hide
  // any real plusaudio/.env for the duration, since main() falls back to it -
  // see helpers/hide-env.js for why this has to be lock-guarded.
  try {
    await withEnvHidden(async () => {
      const code = await main(['--known', 'en', '--learning', 'ko', '--input', 'date']);
      assert.equal(code, 1);
    });
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test('main() prints usage and exits 0 on --help without requiring an API key', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const code = await main(['--help']);
    assert.equal(code, 0);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test('run() passes --input-language through, and only when it is one of the two valid values', async () => {
  // The caller can settle which language the input is in - script answers it
  // outright for a language that has one - and saying so is what stops the
  // model deciding wrong on input that mixes two languages.
  const seen = [];
  const generate = async (request) => {
    seen.push(request.inputLanguage);
    return { front_text: 'a', back_text: 'b', spoken_reading: '' };
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await run({ known: 'en', learning: 'zh_cn', input: '你好', 'input-language': 'learning' }, generate);
    await run({ known: 'en', learning: 'zh_cn', input: 'hello', 'input-language': 'known' }, generate);
    // Anything else is ignored rather than forwarded: a junk value must not
    // turn into an instruction the prompt states as fact.
    await run({ known: 'en', learning: 'zh_cn', input: 'hello', 'input-language': 'sideways' }, generate);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(seen, ['learning', 'known', undefined]);
});
