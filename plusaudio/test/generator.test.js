'use strict';

// The CLI's half of the shared generator.
//
// What is worth testing HERE is that plain Node can load the TypeScript policy
// at all - no jest, no bundler, no build step - and that the whole loop runs
// through it: Gemini speaks, transcribes and judges, all through one client
// over a fake fetch (helpers/fake-gemini.js), and what comes back out is a
// Buffer holding a WAV file, because that is the contract augmentPackage and
// generate-clip.js rely on. No test here reaches the network.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createGenerator } = require('../lib/generator');
const { CARD_MODELS, GEMINI_TTS_VOICES } = require('../lib/cardGeneration/models.ts');
const { dailyQuotaMessage } = require('../lib/cardGeneration/gemini.ts');
const { createRandom } = require('../lib/random');
const { WAV, dailyQuota429, fakeGemini } = require('./helpers/fake-gemini');

const voiceOf = (request) => request.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;

function generatorWith(gemini, { seed = 1, log } = {}) {
  return createGenerator({
    apiKey: 'test-key',
    baseUrl: 'http://fake.invalid',
    fetch: gemini.fetch,
    random: createRandom(seed),
    sleep: async () => {},
    log,
  });
}

test('generates a WAV clip through the shared policy and hands back a Buffer', async () => {
  const gemini = fakeGemini({ transcribe: '배고파요?' });

  const audio = await generatorWith(gemini)({ text: '배고파요?', language: 'ko' });

  assert.ok(Buffer.isBuffer(audio));
  assert.deepEqual(audio, WAV);
  const [speech] = gemini.of('speech');
  assert.equal(gemini.of('speech').length, 1);
  assert.equal(speech.model, CARD_MODELS.tts);
  assert.equal(speech.url, `http://fake.invalid/v1beta/models/${CARD_MODELS.tts}:generateContent`);
  assert.equal(speech.headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(speech.body.contents, [{ parts: [{ text: '배고파요?' }] }]);
  assert.ok(GEMINI_TTS_VOICES.includes(voiceOf(speech)));

  // The transcriber is Gemini too: the WAV as inlineData, at the low thinking level.
  const [transcribe] = gemini.of('transcribe');
  assert.equal(transcribe.model, CARD_MODELS.transcribe);
  const audioPart = transcribe.body.contents[0].parts.find((part) => part.inlineData);
  assert.equal(audioPart.inlineData.mimeType, 'audio/wav');
  assert.deepEqual(Buffer.from(audioPart.inlineData.data, 'base64'), WAV);
  assert.match(transcribe.body.contents[0].parts[0].text, /Transcribe this Korean audio exactly as spoken/);
  assert.deepEqual(transcribe.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('a Japanese reading reaches the judge, as WAV with a structured verdict, and never the synthesiser', async () => {
  const gemini = fakeGemini({ transcribe: '行った', judge: { heard: 'いった', matches: true, reason: 'ok' } });

  await generatorWith(gemini)({ text: '行った', language: 'ja', reading: 'いった' });

  assert.deepEqual(gemini.of('speech')[0].body.contents, [{ parts: [{ text: '行った' }] }]);
  assert.ok(!JSON.stringify(gemini.of('speech')[0].body).includes('いった'));
  const [judge] = gemini.of('judge');
  assert.equal(judge.model, CARD_MODELS.speechEvaluation);
  const parts = judge.body.contents[0].parts;
  assert.match(parts[0].text, /read aloud as: いった/);
  assert.match(parts[0].text, /language: Japanese/);
  assert.equal(parts[1].inlineData.mimeType, 'audio/wav');
  assert.equal(judge.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(Object.keys(judge.body.generationConfig.responseJsonSchema.properties), ['heard', 'matches', 'reason']);
  assert.deepEqual(judge.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.match(judge.body.systemInstruction.parts[0].text, /strict quality judge/);
});

test('refuses a clip that does not say what the note says, with a different voice on every retry', async () => {
  // The audio judge is unreachable in this script, and so is the transcript
  // judge behind it, so every attempt fails and nothing is returned.
  const gemini = fakeGemini({ transcribe: 'something else entirely' });
  const lines = [];

  await assert.rejects(
    generatorWith(gemini, { log: (line) => lines.push(line) })({ text: '배고파요?', language: 'ko' }),
    /Failed to generate valid audio for "배고파요\?" after 3 attempts/,
  );
  assert.equal(gemini.of('speech').length, 3);
  assert.ok(lines.some((line) => line.includes('Audio judge failed')));

  const voices = gemini.of('speech').map(voiceOf);
  assert.notEqual(voices[1], voices[0]);
  assert.notEqual(voices[2], voices[1]);
});

test('when the judge is down, the transcript fallback decides, through the text model', async () => {
  const gemini = fakeGemini({ transcribe: '배고파', transcriptJudge: { matches: true } });

  const accepted = await generatorWith(gemini)({ text: '배고파요?', language: 'ko' });

  assert.deepEqual(accepted, WAV);
  assert.equal(gemini.of('judge').length, 1, 'the audio judge was asked first');
  assert.equal(gemini.of('transcriptJudge').length, 1);
  assert.equal(gemini.of('transcriptJudge')[0].model, CARD_MODELS.text);
});

test('the same seed reads a failing card in the same voices every time', async () => {
  const run = async (seed) => {
    const gemini = fakeGemini({ transcribe: 'nope' });
    await generatorWith(gemini, { seed })({ text: '배고파요?', language: 'ko' }).catch(() => {});
    return gemini.of('speech').map(voiceOf);
  };
  const first = await run(1234);
  assert.equal(first.length, 3);
  assert.deepEqual(await run(1234), first);
});

test('a spent daily quota stops the clip at once with the quota message, spending no retries', async () => {
  const gemini = fakeGemini({ speech: dailyQuota429() });

  await assert.rejects(
    generatorWith(gemini)({ text: '배고파요?', language: 'ko' }),
    (error) => error.message === dailyQuotaMessage(CARD_MODELS.tts),
  );
  assert.equal(gemini.requests.length, 1);
});

test('a spent daily quota on the judge stops the clip too, instead of falling back', async () => {
  const gemini = fakeGemini({ transcribe: 'nope', judge: dailyQuota429() });

  await assert.rejects(
    generatorWith(gemini)({ text: '배고파요?', language: 'ko' }),
    (error) => error.message === dailyQuotaMessage(CARD_MODELS.speechEvaluation),
  );
  assert.equal(gemini.of('speech').length, 1);
  assert.equal(gemini.of('transcriptJudge').length, 0);
});

test('without a key nothing is attempted, and the error names the key', () => {
  assert.throws(() => createGenerator({}), /GEMINI_API_KEY is not set/);
});

test('Korean liaison: 역이 transcribed as its homophone 여기 is accepted without asking the judge', async () => {
  const gemini = fakeGemini({ transcribe: '여기 어디예요?' });

  const audio = await generatorWith(gemini)({ text: '역이 어디예요?', language: 'ko' });

  assert.deepEqual(audio, WAV);
  assert.equal(gemini.of('speech').length, 1);
  assert.equal(gemini.of('judge').length, 0, 'the judge was not needed');
});

test('a real Korean mismatch still goes to the judge', async () => {
  const gemini = fakeGemini({ transcribe: '약이 어디예요?', judge: { heard: '약이 어디예요', matches: false, reason: 'different word' } });

  await assert.rejects(generatorWith(gemini)({ text: '역이 어디예요?', language: 'ko' }), /after 3 attempts/);
  assert.equal(gemini.of('judge').length, 3);
});
