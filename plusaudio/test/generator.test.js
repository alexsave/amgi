'use strict';

// The CLI's half of the shared generator.
//
// What is worth testing HERE is that plain Node can load the TypeScript policy
// at all - no jest, no bundler, no build step - and that the whole loop runs
// through it: Gemini speaks (a fake fetch), OpenAI transcribes and judges (a
// scripted client), and what comes back out is a Buffer holding a WAV file,
// because that is the contract augmentPackage and generate-clip.js rely on.
// No test here reaches Google or OpenAI.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createGenerator } = require('../lib/generator');
const { CARD_MODELS, GEMINI_TTS_VOICES } = require('../lib/cardGeneration/models.ts');
const { dailyQuotaMessage, pcmToWav } = require('../lib/cardGeneration/geminiSpeech.ts');
const { createRandom } = require('../lib/random');

const WAV = Buffer.from(pcmToWav(new Uint8Array(8), 24000, 1));

/** OpenAI for transcription and the judge; it has no speech endpoint any more. */
function scriptedOpenAI({ transcript, judge = null }) {
  const calls = { transcription: [], chat: [] };
  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.chat.push(body);
          if (!judge) throw new Error('no chat response scripted');
          return {
            choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'judge_audio', arguments: JSON.stringify(judge) } }] } }],
          };
        },
      },
    },
    audio: {
      transcriptions: {
        create: async (body) => {
          calls.transcription.push(body);
          return { text: transcript };
        },
      },
    },
  };
}

function wavAnswer() {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV.toString('base64') } }] } }] };
}

/** Gemini: answers request i with responses[i] (the last one repeats). */
function fakeGemini(responses = [{ status: 200, body: wavAnswer() }]) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return { ok: next.status === 200, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { fetch, requests };
}

const voiceOf = (request) => request.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;

function generatorWith({ openai, gemini, seed = 1, log }) {
  return createGenerator(openai, {
    geminiApiKey: 'test-key',
    geminiApiBase: 'http://fake.invalid',
    fetch: gemini.fetch,
    random: createRandom(seed),
    sleep: async () => {},
    log,
  });
}

test('generates a WAV clip through the shared policy and hands back a Buffer', async () => {
  const openai = scriptedOpenAI({ transcript: '배고파요?' });
  const gemini = fakeGemini();

  const audio = await generatorWith({ openai, gemini })({ text: '배고파요?', language: 'ko' });

  assert.ok(Buffer.isBuffer(audio));
  assert.deepEqual(audio, WAV);
  assert.equal(gemini.requests.length, 1);
  assert.match(gemini.requests[0].url, new RegExp(`^http://fake\\.invalid/v1beta/models/${CARD_MODELS.tts}:generateContent$`));
  assert.deepEqual(gemini.requests[0].body.contents, [{ parts: [{ text: '배고파요?' }] }]);
  assert.ok(GEMINI_TTS_VOICES.includes(voiceOf(gemini.requests[0])));

  // The transcriber is handed a WAV file, by name and by type.
  const file = openai.calls.transcription[0].file;
  assert.equal(openai.calls.transcription[0].model, CARD_MODELS.transcribe);
  assert.equal(file.name, 'audio.wav');
  assert.equal(file.type, 'audio/wav');
});

test('a Japanese reading reaches the judge, as WAV, and never the synthesiser', async () => {
  const openai = scriptedOpenAI({ transcript: '行った', judge: { heard: 'いった', matches: true, reason: 'ok' } });
  const gemini = fakeGemini();

  await generatorWith({ openai, gemini })({ text: '行った', language: 'ja', reading: 'いった' });

  assert.deepEqual(gemini.requests[0].body.contents, [{ parts: [{ text: '行った' }] }]);
  assert.ok(!JSON.stringify(gemini.requests[0].body).includes('いった'));
  const judgeContent = openai.calls.chat[0].messages[1].content;
  assert.match(judgeContent[0].text, /read aloud as: いった/);
  assert.equal(judgeContent[1].input_audio.format, 'wav');
  assert.equal(openai.calls.chat[0].model, CARD_MODELS.speechEvaluation);
});

test('refuses a clip that does not say what the note says, with a different voice on every retry', async () => {
  const openai = scriptedOpenAI({ transcript: 'something else entirely' });
  const gemini = fakeGemini();
  const lines = [];

  // The audio judge is unreachable in this stub, and so is the transcript
  // judge behind it, so every attempt fails and nothing is returned.
  await assert.rejects(
    generatorWith({ openai, gemini, log: (line) => lines.push(line) })({ text: '배고파요?', language: 'ko' }),
    /Failed to generate valid audio for "배고파요\?" after 3 attempts/,
  );
  assert.equal(gemini.requests.length, 3);
  assert.ok(lines.some((line) => line.includes('Audio judge failed')));

  const voices = gemini.requests.map(voiceOf);
  assert.notEqual(voices[1], voices[0]);
  assert.notEqual(voices[2], voices[1]);
});

test('the same seed reads a failing card in the same voices every time', async () => {
  const run = async (seed) => {
    const gemini = fakeGemini();
    await generatorWith({ openai: scriptedOpenAI({ transcript: 'nope' }), gemini, seed })({ text: '배고파요?', language: 'ko' }).catch(() => {});
    return gemini.requests.map(voiceOf);
  };
  const first = await run(1234);
  assert.equal(first.length, 3);
  assert.deepEqual(await run(1234), first);
});

test('a spent daily quota stops the clip at once with the quota message, spending no retries', async () => {
  const openai = scriptedOpenAI({ transcript: '배고파요?' });
  const gemini = fakeGemini([{
    status: 429,
    body: { error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } },
  }]);

  await assert.rejects(
    generatorWith({ openai, gemini })({ text: '배고파요?', language: 'ko' }),
    (error) => error.message === dailyQuotaMessage(CARD_MODELS.tts),
  );
  assert.equal(gemini.requests.length, 1);
  assert.equal(openai.calls.transcription.length, 0);
});

test('without a Gemini key nothing is attempted, and the error names the key', async () => {
  const openai = scriptedOpenAI({ transcript: '배고파요?' });
  const generate = createGenerator(openai, {});
  await assert.rejects(generate({ text: '배고파요?', language: 'ko' }), /GEMINI_API_KEY is not set/);
  assert.equal(openai.calls.transcription.length, 0);
});

test('Korean liaison: 역이 transcribed as its homophone 여기 is accepted without asking the judge', async () => {
  const openai = scriptedOpenAI({ transcript: '여기 어디예요?' });
  const gemini = fakeGemini();

  const audio = await generatorWith({ openai, gemini })({ text: '역이 어디예요?', language: 'ko' });

  assert.deepEqual(audio, WAV);
  assert.equal(gemini.requests.length, 1);
  assert.equal(openai.calls.chat.length, 0, 'the judge was not needed');
});

test('a real Korean mismatch still goes to the judge', async () => {
  const openai = scriptedOpenAI({ transcript: '약이 어디예요?', judge: { heard: '약이 어디예요', matches: false, reason: 'different word' } });
  const gemini = fakeGemini();

  await assert.rejects(generatorWith({ openai, gemini })({ text: '역이 어디예요?', language: 'ko' }), /after 3 attempts/);
  assert.equal(openai.calls.chat.length, 3);
});
