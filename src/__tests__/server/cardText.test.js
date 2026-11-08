/**
 * @jest-environment node
 */

// The app's card-text path needs exactly one key, GEMINI_API_KEY: without it
// nothing is generated and the person is told which key and where to get it;
// with it (and no OpenAI key at all) the generator subprocess runs. The
// subprocess is faked at node:child_process, the boundary cardText.js
// crosses, so no test here starts a generator or reaches Gemini.

const runs = [];

jest.mock('node:child_process', () => {
  const execFile = () => {
    throw new Error('cardText.js must call execFile through promisify');
  };
  execFile[require('node:util').promisify.custom] = (file, args) => {
    runs.push(args);
    return Promise.resolve({ stdout: '{"front_text":"date","back_text":"날짜","spoken_reading":""}\n', stderr: '' });
  };
  return { execFile };
});

import { generateCardTextOnly } from '../../server/anki/cardText';

const KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY'];
const saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  runs.length = 0;
  for (const name of KEYS) delete process.env[name];
});

afterAll(() => {
  for (const name of KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const REQUEST = { userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' };

test('without GEMINI_API_KEY no generator runs, and the error names the key and where to get one', async () => {
  process.env.OPENAI_API_KEY = 'sk-old';
  await expect(generateCardTextOnly(REQUEST)).rejects.toThrow(
    /^GEMINI_API_KEY is not set, so nothing was generated: get a key at https:\/\/aistudio\.google\.com\/apikey/,
  );
  expect(runs).toHaveLength(0);
});

test('GEMINI_API_KEY alone is enough to generate a card', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const card = await generateCardTextOnly(REQUEST);
  expect(card).toEqual({ front_text: 'date', back_text: '날짜', spoken_reading: '' });
  expect(runs).toHaveLength(1);
  expect(runs[0][0]).toMatch(/generate-card-text\.js$/);
});
