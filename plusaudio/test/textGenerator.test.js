'use strict';

// The CLI's half of the text-generation bridge - the sibling of
// generator.test.js, but for card text rather than audio. What is worth
// testing HERE is that plain Node can load cardGeneration.ts through this
// adapter with no build step, that the request on the wire is Gemini
// structured output at the pinned thinking level, and that the log wiring
// matches the audio adapter's own (the app's local generation path and the
// plusaudio CLI have to produce the same card either way).

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createTextGenerator } = require('../lib/textGenerator');
const { CARD_MODELS, GEMINI_THINKING_LEVEL, GEMINI_TEXT_MODEL } = require('../lib/cardGeneration/models.ts');
const { GENERATED_CARD_FORMAT } = require('../lib/cardGeneration/cardGeneration.ts');
const { fakeGemini } = require('./helpers/fake-gemini');

function generatorWith(gemini, log) {
  return createTextGenerator({ apiKey: 'test-key', baseUrl: 'http://fake.invalid', fetch: gemini.fetch, log });
}

const DATE = { known_text: 'date', learning_text: '날짜', sense_tag: '', register: 'polite', spoken_reading: '' };

test('generates a card through the shared policy, as Gemini structured output', async () => {
  const gemini = fakeGemini({ text: DATE });

  const card = await generatorWith(gemini)({ userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.equal(card.front_text, 'date');
  assert.equal(card.back_text, '날짜');
  const [request] = gemini.of('text');
  assert.equal(request.model, CARD_MODELS.text);
  assert.equal(request.model, GEMINI_TEXT_MODEL);
  const config = request.body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseJsonSchema, GENERATED_CARD_FORMAT.schema);
  assert.match(request.body.systemInstruction.parts[0].text, /flashcard/i);
  assert.match(request.body.contents[0].parts[0].text, /date/);
  assert.equal(request.body.contents[0].role, 'user');
});

test('every text call is pinned to the lowest thinking level gemini-3.8-flash accepts', async () => {
  // Thinking tokens bill as output, and filling a short template does not need
  // them; the model's own default is "medium". See models.ts's
  // GEMINI_THINKING_LEVEL for why "low" and not "minimal" (HTTP 400 on 3.8).
  const gemini = fakeGemini({ text: DATE });

  await generatorWith(gemini)({ userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.deepEqual(gemini.of('text')[0].body.generationConfig.thinkingConfig, { thinkingLevel: GEMINI_THINKING_LEVEL });
  // Pinned literally, so a change to the constant is a visible diff here too.
  assert.equal(GEMINI_THINKING_LEVEL, 'low');
});

test('the card schema is the draft-07 JSON Schema Gemini takes as is', () => {
  const { schema } = GENERATED_CARD_FORMAT;
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['known_text', 'learning_text', 'sense_tag', 'register', 'spoken_reading']);
  assert.deepEqual(schema.properties.register.enum, ['casual', 'polite', 'formal']);
});

test('a Japanese card carries its kana reading through untouched', async () => {
  const gemini = fakeGemini({ text: { known_text: 'went', learning_text: '行った', sense_tag: '', register: 'casual', spoken_reading: 'いった' } });

  const card = await generatorWith(gemini)({ userInput: '行った', knownLanguage: 'en', learningLanguage: 'ja' });

  assert.equal(card.back_text, '行った');
  assert.equal(card.spoken_reading, 'いった');
});

test('an answer that is not JSON fails with the format named, not a parse trace', async () => {
  const gemini = fakeGemini({ text: { raw: true, status: 200, body: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] } } });

  await assert.rejects(
    generatorWith(gemini)({ userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' }),
    /Failed to parse flashcard_generation from model response/,
  );
});

test('thought parts are not mistaken for the answer', async () => {
  const gemini = fakeGemini({ text: { raw: true, status: 200, body: { candidates: [{ content: { parts: [
    { text: 'Let me think about register...', thought: true },
    { text: JSON.stringify(DATE) },
  ] } }] } } });

  const card = await generatorWith(gemini)({ userInput: 'date', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.equal(card.back_text, '날짜');
});

test("warnings from the policy go through the injected log, prefixed like the audio adapter's", async () => {
  // Two attempts: the first breaks the speakable rule (a parenthesized
  // gloss), which should log a warning through this adapter's `log` option
  // before the corrective retry on the second attempt succeeds.
  const gemini = fakeGemini({ text: [
    { known_text: 'hungry', learning_text: '배고파요 (지금)', sense_tag: '', register: 'polite', spoken_reading: '' },
    { known_text: 'hungry', learning_text: '배고파요', sense_tag: '', register: 'polite', spoken_reading: '' },
  ] });
  const lines = [];

  const card = await generatorWith(gemini, (line) => lines.push(line))({ userInput: 'hungry', knownLanguage: 'en', learningLanguage: 'ko' });

  assert.equal(card.back_text, '배고파요');
  assert.ok(lines.some((line) => line.startsWith('  ') && line.includes('Unspeakable')));
  assert.equal(gemini.of('text').length, 2);
});

test('without a key the generator cannot be built, and says which key', () => {
  assert.throws(() => createTextGenerator({}), /GEMINI_API_KEY is not set/);
});
