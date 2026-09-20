'use strict';

// The CLI's half of the text-generation bridge - the sibling of
// generator.test.js, but for card text rather than audio. What is worth
// testing HERE is that plain Node can load cardGeneration.ts through this
// adapter with no build step, and that the models/log wiring matches the
// audio adapter's own (see generator.js and its own test for why that
// parity matters: the app's local generation path and the plusaudio CLI have
// to produce the same card either way).

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createTextGenerator } = require('../lib/textGenerator');
const { CARD_MODELS } = require('../lib/cardGeneration/models.ts');

function scriptedClient(fields) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.push(body);
          return { choices: [{ message: { content: JSON.stringify(fields) } }] };
        },
      },
    },
    audio: {
      speech: { create: async () => { throw new Error('not used by text generation'); } },
      transcriptions: { create: async () => { throw new Error('not used by text generation'); } },
    },
  };
}

test('generates a card through the shared policy', async () => {
  const openai = scriptedClient({
    known_text: 'date',
    learning_text: '날짜',
    sense_tag: '',
    register: 'polite',
    spoken_reading: '',
  });

  const generate = createTextGenerator(openai);
  const card = await generate({ userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.equal(card.front_text, 'date');
  assert.equal(card.back_text, '날짜');
  assert.equal(openai.calls[0].model, CARD_MODELS.text);
});

test('a Japanese card carries its kana reading through untouched', async () => {
  const openai = scriptedClient({
    known_text: 'went',
    learning_text: '行った',
    sense_tag: '',
    register: 'casual',
    spoken_reading: 'いった',
  });

  const generate = createTextGenerator(openai);
  const card = await generate({ userInput: '行った', knownLanguage: 'en', learningLanguage: 'ja' });

  assert.equal(card.back_text, '行った');
  assert.equal(card.spoken_reading, 'いった');
});

test('warnings from the policy go through the injected log, prefixed like the audio adapter\'s', async () => {
  // Two attempts: the first breaks the speakable rule (a parenthesized
  // gloss), which should log a warning through this adapter's `log` option
  // before the corrective retry on the second attempt succeeds.
  const responses = [
    { known_text: 'hungry', learning_text: '배고파요 (지금)', sense_tag: '', register: 'polite', spoken_reading: '' },
    { known_text: 'hungry', learning_text: '배고파요', sense_tag: '', register: 'polite', spoken_reading: '' },
  ];
  let call = 0;
  const openai = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(responses[call++]) } }] }) } },
    audio: { speech: { create: async () => { throw new Error('unused'); } }, transcriptions: { create: async () => { throw new Error('unused'); } } },
  };
  const lines = [];
  const generate = createTextGenerator(openai, { log: (line) => lines.push(line) });

  const card = await generate({ userInput: 'hungry', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.equal(card.back_text, '배고파요');
  assert.ok(lines.some((line) => line.includes('Unspeakable')));
});
