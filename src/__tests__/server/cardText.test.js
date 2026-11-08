// The app's card-text path needs exactly one key, GEMINI_API_KEY: without it
// nothing is generated and the person is told which key and where to get it;
// with it (and no OpenAI key at all) the generator subprocess runs. The
// subprocess is faked at node:child_process, the boundary cardText.js
// crosses, so no test here starts a generator or reaches Gemini.

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runs = [];

// The subprocess boundary, faked (run with --experimental-test-module-mocks).
mock.module('node:child_process', {
  namedExports: {
    fork: (file, args) => {
      runs.push([file, ...args]);
      return require('../../test-helpers/fakeFork').fakeFork(args, () => ({
        stdout: require('plusaudio/lib/cardTextLayout').writeCardText({ front_text: 'date', back_text: '날짜', spoken_reading: '' }).toString('utf8'),
      }));
    },
  },
});
const { generateCardTextOnly } = await import('../../server/anki/cardText');

const KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY'];
const saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  runs.length = 0;
  for (const name of KEYS) delete process.env[name];
});

after(() => {
  for (const name of KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const REQUEST = { userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' };

test('without GEMINI_API_KEY no generator runs, and the error names the key and where to get one', async () => {
  process.env.OPENAI_API_KEY = 'sk-old';
  await assert.rejects(generateCardTextOnly(REQUEST), 
    { message: /^GEMINI_API_KEY is not set, so nothing was generated: get a key at https:\/\/aistudio\.google\.com\/apikey/ });
  assert.equal((runs).length, 0);
});

test('GEMINI_API_KEY alone is enough to generate a card', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const card = await generateCardTextOnly(REQUEST);
  assert.deepEqual(card, { front_text: 'date', back_text: '날짜', spoken_reading: '' });
  assert.equal((runs).length, 1);
  assert.match(runs[0][0], /generate-card-text\.js$/);
});
