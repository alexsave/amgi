'use strict';

// geminiContext.js turns a key into the context every generator runs in. The
// speech model is the runtime one unless a dev script names another
// (scripts/build-starter-audio.js --model), and when it does, the request and
// the context's own model list must agree - the starter manifest records the
// model from the context.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createGeminiContext } = require('../lib/geminiContext');
const { GEMINI_TTS_LITE_MODEL, GEMINI_TTS_MODEL } = require('../lib/cardGeneration/models.ts');
const { createRandom } = require('../lib/random');
const { fakeGemini } = require('./helpers/fake-gemini');

const synthesizeWith = async (options) => {
  const gemini = fakeGemini();
  const context = createGeminiContext({ apiKey: 'k', baseUrl: 'http://fake.invalid', fetch: gemini.fetch, random: createRandom(1), ...options });
  await context.speech.synthesize({ text: '안녕하세요', language: 'ko', voice: 'Kore' });
  return { context, request: gemini.of('speech')[0] };
};

test('speech uses the runtime TTS model by default', async () => {
  const { context, request } = await synthesizeWith({});
  assert.equal(request.model, GEMINI_TTS_MODEL);
  assert.equal(context.models.tts, GEMINI_TTS_MODEL);
});

test('a named TTS model reaches both the request and the context, and nothing else changes', async () => {
  const { context, request } = await synthesizeWith({ ttsModel: GEMINI_TTS_LITE_MODEL });
  assert.equal(request.model, GEMINI_TTS_LITE_MODEL);
  assert.equal(context.models.tts, GEMINI_TTS_LITE_MODEL);
  const { context: runtime } = await synthesizeWith({});
  assert.deepEqual({ ...context.models, tts: null }, { ...runtime.models, tts: null }, 'transcription and the judge keep their models');
});
