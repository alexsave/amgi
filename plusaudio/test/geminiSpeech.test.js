'use strict';

// Gemini speech, and the shared client under it (cardGeneration/gemini.ts:
// the request, quotas, rate limits and error messages every model call
// shares), against a fake fetch. No test here reaches Google: the free tier
// allows 10 requests per day per model, and a test suite that spent them
// would also be a test suite that fails tomorrow for no reason.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WAV_HEADER_BYTES,
  createGeminiSpeech,
  isWav,
  pcmToWav,
  spokenInput,
} = require('../lib/cardGeneration/geminiSpeech.ts');
const { GeminiRateLimitError, GeminiUnavailableError, createGeminiClient, dailyQuotaMessage, isRateLimited } = require('../lib/cardGeneration/gemini.ts');
const { createRandom } = require('../lib/random');
const { JITTER, createRateGate } = require('../lib/rateGate');

const MODEL = 'gemini-3.8-flash-tts';
const VOICES = ['Kore', 'Aoede', 'Charon'];

/** A minimal but real WAV file: 24 kHz mono 16-bit, `samples` samples of silence. */
function wavBytes(samples = 4) {
  return Buffer.from(pcmToWav(new Uint8Array(samples * 2), 24000, 1));
}

function audioResponse(mimeType, bytes) {
  return {
    status: 200,
    body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } }] } }] },
  };
}

function quota429(quotaId, retryDelay) {
  const details = [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests', quotaId }] },
  ];
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  return { status: 429, body: { error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED', details } } };
}

/** A fetch that answers each call with the next scripted response and records the requests. */
function scriptedFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('no response scripted');
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => text };
  };
  return { fetch, calls };
}

function speechWith(responses, overrides = {}) {
  const scripted = scriptedFetch(responses);
  const sleeps = [];
  // One fake clock for both the client's sleep and the rate gate, so a
  // sleep moves the gate's time on exactly as a real wait would.
  const clock = { t: 1_000_000 };
  const gate = createRateGate({ now: () => clock.t, random: createRandom(3) });
  const client = createGeminiClient({
    apiKey: 'test-key',
    fetch: scripted.fetch,
    baseUrl: 'http://fake.invalid',
    gate,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  const speech = createGeminiSpeech({
    client,
    model: MODEL,
    voices: VOICES,
    random: createRandom(7),
    ...overrides,
  });
  return { speech, calls: scripted.calls, sleeps, gate, clock };
}

const REQUEST = { text: '역이 어디예요?', language: 'ko', voice: 'Kore' };

test('a WAV answer is passed through byte for byte, from a request that carries only the text', async () => {
  const wav = wavBytes();
  const { speech, calls } = speechWith([audioResponse('audio/wav', wav)]);

  const audio = Buffer.from(await speech.synthesize(REQUEST));

  assert.deepEqual(audio, wav);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://fake.invalid/v1beta/models/${MODEL}:generateContent`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  // Verbatim text and nothing else: anything added here is read aloud.
  assert.deepEqual(calls[0].body, {
    contents: [{ parts: [{ text: '역이 어디예요?' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  });
});

test('raw L16 PCM is wrapped in a WAV header with the rate and channels from its mime type', async () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const { speech } = speechWith([audioResponse('audio/L16;codec=pcm;rate=16000; channels=2', pcm)]);

  const audio = Buffer.from(await speech.synthesize(REQUEST));

  assert.ok(isWav(audio));
  assert.equal(audio.length, WAV_HEADER_BYTES + pcm.length);
  assert.equal(audio.readUInt16LE(20), 1, 'PCM');
  assert.equal(audio.readUInt16LE(22), 2, 'channels');
  assert.equal(audio.readUInt32LE(24), 16000, 'sample rate');
  assert.equal(audio.readUInt32LE(28), 16000 * 4, 'byte rate');
  assert.equal(audio.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(audio.readUInt32LE(40), pcm.length, 'data size');
  assert.equal(audio.readUInt32LE(4), 36 + pcm.length, 'RIFF size');
  assert.deepEqual(audio.subarray(WAV_HEADER_BYTES), pcm);
});

test('the gemini-3.1 shape (rate=24000; channels=1) and a bare audio/l16 both become 24 kHz mono', async () => {
  for (const mime of ['audio/l16; rate=24000; channels=1', 'audio/l16']) {
    const { speech } = speechWith([audioResponse(mime, Buffer.alloc(6))]);
    const audio = Buffer.from(await speech.synthesize(REQUEST));
    assert.equal(audio.readUInt32LE(24), 24000, mime);
    assert.equal(audio.readUInt16LE(22), 1, mime);
  }
});

test('a "wav" answer with no RIFF header is refused rather than stored under a .wav name', async () => {
  const { speech } = speechWith([audioResponse('audio/wav', Buffer.from('not a wav file'))]);
  await assert.rejects(speech.synthesize(REQUEST), /no RIFF\/WAVE header/);
});

test('mp3 or any other format is refused', async () => {
  const { speech } = speechWith([audioResponse('audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0]))]);
  await assert.rejects(speech.synthesize(REQUEST), /unexpected format: audio\/mpeg/);
});

test('a spent daily quota fails at once, once, with the message the add-card row shows', async () => {
  const { speech, calls, sleeps } = speechWith([quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '21600s')]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof GeminiUnavailableError);
  assert.equal(error.fatal, true);
  assert.equal(error.message, dailyQuotaMessage(MODEL));
  assert.match(error.message, /10 requests per day per model/);
  assert.match(error.message, /Enable billing/);
  assert.match(error.message, /https:\/\/aistudio\.google\.com\/apikey/);
  assert.ok(!error.message.includes('\n'), 'one line, because the CLI boundary keeps only the last line');
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a billed project's daily cap says what it is, and does not tell a paying user to enable billing", async () => {
  // The body Gemini sent live on 2026-11-08, from a billed (Tier 1) project.
  const tier1 = {
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota...', details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
        description: 'Generate content requests per day limit exceeded on Tier 1.',
        quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_day',
        quotaId: 'GenerateRequestsPerDayPerProjectPerModel',
        quotaDimensions: { location: 'global', model: MODEL },
        quotaValue: '100',
      }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20556s' },
    ] } },
  };
  const { speech, calls, sleeps } = speechWith([tier1]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof GeminiUnavailableError);
  assert.equal(error.message, `Your Gemini project's daily limit of 100 requests for ${MODEL} is used up. It resets in about 6 hour(s). A higher usage tier raises it (Google AI Studio, https://aistudio.google.com/apikey).`);
  assert.doesNotMatch(error.message, /free tier|Enable billing/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a free-tier daily cap names the limit Google reports', async () => {
  const freeTier = quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  freeTier.body.error.details[0].violations[0].quotaValue = '10';
  const { speech } = speechWith([freeTier]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.equal(error.message, dailyQuotaMessage(MODEL, { freeTier: true, limit: 10 }));
  assert.match(error.message, /free tier allows 10 requests per day per model/);
  assert.match(error.message, /Enable billing/);
});

test("a per-minute limit is waited out through the gate: Google's delay as the floor, doubling on a second refusal", async () => {
  const wav = wavBytes();
  const { speech, calls, sleeps } = speechWith([
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '2.5s'),
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '3s'),
    audioResponse('audio/wav', wav),
  ]);

  const audio = Buffer.from(await speech.synthesize(REQUEST));

  assert.deepEqual(audio, wav);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 2500 && sleeps[0] < 2500 * (1 + JITTER), `first wait ${sleeps[0]}: retryDelay 2.5 s, jittered`);
  assert.ok(sleeps[1] >= 4000 && sleeps[1] < 4000 * (1 + JITTER), `second wait ${sleeps[1]}: doubled past the 3 s retryDelay`);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, calls[0].body);
});

test("a per-minute limit that would wait past the cap is handed back typed, with the gate's own wait", async () => {
  const { speech, sleeps, calls } = speechWith([
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '20s'),
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '20s'),
  ]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof GeminiRateLimitError);
  assert.ok(!(error instanceof GeminiUnavailableError), 'not fatal: it passes');
  assert.notEqual(error.fatal, true);
  assert.equal(error.rateLimited, true);
  assert.ok(isRateLimited(error));
  assert.ok(error.retryAfterMs >= 20000 && error.retryAfterMs < 20000 * (1 + JITTER), `${error.retryAfterMs}`);
  assert.equal(error.message, `Gemini is limiting how many requests ${MODEL} takes per minute and asked to wait ${Math.ceil(error.retryAfterMs / 1000)}s.`);
  assert.equal(sleeps.length, 1, 'the first wait fits in 30 s, the second would not');
  assert.equal(calls.length, 2);
});

test('a single long per-minute wait (49 s, as the TTS model asked live) is handed back at once, not slept through', async () => {
  const { speech, sleeps, calls } = speechWith([quota429('GenerateRequestsPerMinutePerProjectPerModel', '49.2s')]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof GeminiRateLimitError);
  assert.ok(error.retryAfterMs >= 49200 && error.retryAfterMs < 49200 * (1 + JITTER), `${error.retryAfterMs}`);
  assert.deepEqual(sleeps, []);
  assert.equal(calls.length, 1);
});

test('the daily cap is still fatal and immediate, never a rate limit to wait out', async () => {
  const { speech, sleeps } = speechWith([quota429('GenerateRequestsPerDayPerProjectPerModel', '20000s')]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof GeminiUnavailableError);
  assert.equal(error.fatal, true);
  assert.equal(isRateLimited(error), false);
  assert.equal(error.dailyCap, true, 'marked so a bulk run can stop its whole queue');
  assert.match(error.message, /daily limit/);
  assert.deepEqual(sleeps, []);
});

test("a 429 with no details blocks for the gate's base wait", async () => {
  const { speech, sleeps } = speechWith([{ status: 429, body: 'Too many requests' }, audioResponse('audio/wav', wavBytes())]);
  await speech.synthesize(REQUEST);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] < 2000 * (1 + JITTER), `${sleeps[0]}`);
});

test('an answer with no inlineData is an ordinary, retryable failure', async () => {
  const { speech } = speechWith([{ status: 200, body: { candidates: [{ finishReason: 'OTHER', content: { parts: [{ text: 'hm' }] } }] } }]);
  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.match(error.message, /Gemini returned no audio \(finishReason: OTHER\)/);
  assert.notEqual(error.fatal, true);
});

test('a blocked prompt is fatal: the same text would be blocked again', async () => {
  const { speech } = speechWith([{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.ok(error instanceof GeminiUnavailableError);
  assert.equal(error.message, 'Gemini refused this request (SAFETY).');
});

test('a refused key is fatal and says what Gemini said; a server error is retryable', async () => {
  const refused = speechWith([{ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } } }]);
  const keyError = await refused.speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.ok(keyError instanceof GeminiUnavailableError);
  assert.equal(keyError.message, `Gemini request to ${MODEL} failed (HTTP 400): API key not valid. Please pass a valid API key.`);

  const down = speechWith([{ status: 503, body: { error: { code: 503, message: 'The model is overloaded.' } } }]);
  const serverError = await down.speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.notEqual(serverError.fatal, true);
  assert.match(serverError.message, /HTTP 503/);
});

test('no key means no client, with a message that says which key and where to get one', () => {
  assert.throws(
    () => createGeminiClient({ apiKey: '' }),
    (error) => error instanceof GeminiUnavailableError && /^GEMINI_API_KEY is not set/.test(error.message) && /aistudio\.google\.com\/apikey/.test(error.message),
  );
});

test('by default the request carries the verbatim text only: no tag, no systemInstruction', async () => {
  const plain = speechWith([audioResponse('audio/wav', wavBytes())]);
  await plain.speech.synthesize(REQUEST);
  assert.deepEqual(plain.calls[0].body.contents, [{ parts: [{ text: '역이 어디예요?' }] }]);
  assert.equal('systemInstruction' in plain.calls[0].body, false);

  // An empty tag from a wired hook is the same as no hook.
  const empty = speechWith([audioResponse('audio/wav', wavBytes())], { steering: () => '  ' });
  await empty.speech.synthesize(REQUEST);
  assert.deepEqual(empty.calls[0].body.contents, [{ parts: [{ text: '역이 어디예요?' }] }]);
});

test('the steering hook, when given a tag, sends it as a bracketed prefix and never as systemInstruction', async () => {
  // systemInstruction is refused by gemini-3.8-flash-tts (HTTP 400), and a
  // bracketed tag is the form that was verified not to be read aloud.
  const on = speechWith([audioResponse('audio/wav', wavBytes())], { steering: (language) => `native ${language} speaker` });
  await on.speech.synthesize(REQUEST);
  assert.deepEqual(on.calls[0].body.contents, [{ parts: [{ text: '[native ko speaker] 역이 어디예요?' }] }]);
  assert.equal('systemInstruction' in on.calls[0].body, false);
  assert.equal(spokenInput('駅はどこですか。', '[native Tokyo speaker]'), '[native Tokyo speaker] 駅はどこですか。', 'a tag cannot nest brackets');
});

test('a voice is drawn from the pool, never twice in a row, and the same seed draws the same voices', () => {
  const draw = (seed) => {
    const { speech } = speechWith([], { random: createRandom(seed) });
    const voices = [];
    let previous = null;
    for (let i = 0; i < 40; i += 1) {
      previous = speech.pickVoice(previous);
      voices.push(previous);
    }
    return voices;
  };

  const first = draw(42);
  assert.deepEqual(draw(42), first, 'same seed, same sequence');
  assert.notDeepEqual(draw(43), first, 'another seed, another sequence');
  for (const voice of first) assert.ok(VOICES.includes(voice));
  for (let i = 1; i < first.length; i += 1) assert.notEqual(first[i], first[i - 1], `draw ${i} repeated the previous voice`);
  assert.deepEqual(new Set(first), new Set(VOICES), 'every voice in the pool gets used');
});

test('a pick costs exactly one draw from the random source, whatever came before', () => {
  let draws = 0;
  const counting = { int: (n) => { draws += 1; return n - 1; } };
  const { speech } = speechWith([], { random: counting });
  speech.pickVoice(null);
  speech.pickVoice('Kore');
  speech.pickVoice('Charon');
  assert.equal(draws, 3);
});
