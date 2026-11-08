'use strict';

// The e2e fake (helpers/fake-gemini.js run on its own, or e2eScript): a run of cards meets the limits
// a person's key meets, switched through POST /control, as the real client sees them over gRPC.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { GeminiDailyCapError, GeminiRateLimitError, createGeminiClient } = require('../lib/cardGeneration/gemini.ts');
const { JITTER, createRateGate } = require('../lib/rateGate');
const { createRandom } = require('../lib/random');
const { controlFake, e2eScript, fakeGemini } = require('./helpers/fake-gemini');

const speech = (text) => ({ generationConfig: { responseModalities: ['AUDIO'] }, contents: [{ role: 'user', parts: [{ text }] }] });
const cardText = (input) => ({
  generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { known_text: { type: 'string' }, learning_text: { type: 'string' } } } },
  contents: [{ role: 'user', parts: [{ text: `Make a card.\nTheir input: "${input}"` }] }],
});

const clientOf = (fake) => createGeminiClient({
    apiKey: 'test-key',
    baseUrl: fake.baseUrl,
    gate: createRateGate({ random: createRandom(1) }),
    maxRateLimitWaitMs: 0, // a refusal comes straight back, typed, instead of being slept through
    sleep: async () => {},
  });
async function setup() {
  const script = e2eScript();
  const fake = await fakeGemini(script, { control: script.control });
  return { fake, client: clientOf(fake) };
}

test('card text is made from the line typed', async () => {
  const { fake, client } = await setup();
  try {
    const answer = await client.generateContent('gemini-text', cardText('banana 12'));
    const fields = JSON.parse(answer.candidates[0].content.parts[0].text);
    assert.equal(fields.known_text, 'banana 12');
    assert.equal(fields.learning_text, '12번 문장이에요.');
  } finally {
    await fake.close();
  }
});

test('speech is refused per minute past the limit /control sets, with a RetryInfo inside the minute', async () => {
  const { fake, client } = await setup();
  try {
    await controlFake(fake.baseUrl, 'perMinute=2');
    await client.generateContent('gemini-tts', speech('one'));
    await client.generateContent('gemini-tts', speech('two'));
    const error = await client.generateContent('gemini-tts', speech('three')).then(() => null, (e) => e);
    assert.ok(error instanceof GeminiRateLimitError, `${error}`);
    assert.ok(error.retryAfterMs > 50_000 && error.retryAfterMs <= 60_000 * (1 + JITTER), `${error.retryAfterMs}: the minute's rest, jittered by the gate`);
    await controlFake(fake.baseUrl, 'perMinute=1000');
    // a client of its own: this one's gate rightly remembers the refusal
    await clientOf(fake).generateContent('gemini-tts', speech('four'));
  } finally {
    await fake.close();
  }
});

test('daily=1 refuses every text call for the day; daily=0 lifts it', async () => {
  const { fake, client } = await setup();
  try {
    await controlFake(fake.baseUrl, 'daily=1');
    const error = await client.generateContent('gemini-text', cardText('apple')).then(() => null, (e) => e);
    assert.ok(error instanceof GeminiDailyCapError, `${error}`);
    await controlFake(fake.baseUrl, 'daily=0');
    const answer = await client.generateContent('gemini-text2', cardText('apple'));
    assert.match(answer.candidates[0].content.parts[0].text, /5번 문장이에요/);
  } finally {
    await fake.close();
  }
});

test('a clip is heard back as the text it was made from', async () => {
  const { fake, client } = await setup();
  try {
    const clip = await client.generateContent('gemini-tts', speech('역이 어디예요?'));
    const audio = clip.candidates[0].content.parts[0].inlineData;
    const back = await client.generateContent('gemini-asr', { contents: [{ role: 'user', parts: [{ inlineData: audio }, { text: 'transcribe' }] }] });
    assert.equal(back.candidates[0].content.parts[0].text, '역이 어디예요?');
  } finally {
    await fake.close();
  }
});
