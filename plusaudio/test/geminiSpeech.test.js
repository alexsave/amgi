'use strict';

// The Gemini TTS client, against a fake fetch. No test here reaches Google:
// the free tier allows 10 requests per day per model, and a test suite that
// spent them would also be a test suite that fails tomorrow for no reason.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  SpeechUnavailableError,
  WAV_HEADER_BYTES,
  createGeminiSpeech,
  dailyQuotaMessage,
  isWav,
  pcmToWav,
} = require('../lib/cardGeneration/geminiSpeech.ts');
const { createRandom } = require('../lib/random');

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
  const speech = createGeminiSpeech({
    apiKey: 'test-key',
    model: MODEL,
    voices: VOICES,
    random: createRandom(7),
    fetch: scripted.fetch,
    baseUrl: 'http://fake.invalid',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { speech, calls: scripted.calls, sleeps };
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

  assert.ok(error instanceof SpeechUnavailableError);
  assert.equal(error.fatal, true);
  assert.equal(error.message, dailyQuotaMessage(MODEL));
  assert.match(error.message, /10 speech requests per day per model/);
  assert.match(error.message, /Enable billing/);
  assert.match(error.message, /https:\/\/aistudio\.google\.com\/apikey/);
  assert.ok(!error.message.includes('\n'), 'one line, because the CLI boundary keeps only the last line');
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a per-minute limit is waited out for as long as Gemini asks, then retried with the same request', async () => {
  const wav = wavBytes();
  const { speech, calls, sleeps } = speechWith([
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '2.5s'),
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '3s'),
    audioResponse('audio/wav', wav),
  ]);

  const audio = Buffer.from(await speech.synthesize(REQUEST));

  assert.deepEqual(audio, wav);
  assert.deepEqual(sleeps, [2500, 3000]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, calls[0].body);
});

test('a per-minute limit that would wait past the cap fails with a message instead of sleeping', async () => {
  const { speech, sleeps, calls } = speechWith([
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '20s'),
    quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '20s'),
  ]);

  const error = await speech.synthesize(REQUEST).then(() => null, (e) => e);

  assert.ok(error instanceof SpeechUnavailableError);
  assert.match(error.message, /per minute.*wait 20s/);
  assert.deepEqual(sleeps, [20000], 'the first wait fits in 30 s, the second would not');
  assert.equal(calls.length, 2);
});

test('a 429 with no details is treated as a short rate limit', async () => {
  const { speech, sleeps } = speechWith([{ status: 429, body: 'Too many requests' }, audioResponse('audio/wav', wavBytes())]);
  await speech.synthesize(REQUEST);
  assert.deepEqual(sleeps, [5000]);
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
  assert.ok(error instanceof SpeechUnavailableError);
  assert.match(error.message, /refused to read this text aloud \(SAFETY\)/);
});

test('a refused key is fatal and says what Gemini said; a server error is retryable', async () => {
  const refused = speechWith([{ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } } }]);
  const keyError = await refused.speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.ok(keyError instanceof SpeechUnavailableError);
  assert.equal(keyError.message, 'Gemini speech request failed (HTTP 400): API key not valid. Please pass a valid API key.');

  const down = speechWith([{ status: 503, body: { error: { code: 503, message: 'The model is overloaded.' } } }]);
  const serverError = await down.speech.synthesize(REQUEST).then(() => null, (e) => e);
  assert.notEqual(serverError.fatal, true);
  assert.match(serverError.message, /HTTP 503/);
});

test('no key means no synthesiser, with a message that says which key', () => {
  assert.throws(
    () => createGeminiSpeech({ apiKey: '', model: MODEL, voices: VOICES, random: createRandom(1) }),
    (error) => error instanceof SpeechUnavailableError && /GEMINI_API_KEY is not set/.test(error.message),
  );
});

test('the steering hook is off by default, and when given goes to systemInstruction, never into the text', async () => {
  const off = speechWith([audioResponse('audio/wav', wavBytes())]);
  await off.speech.synthesize(REQUEST);
  assert.equal('systemInstruction' in off.calls[0].body, false);

  const on = speechWith([audioResponse('audio/wav', wavBytes())], { steering: (language) => `steer ${language}` });
  await on.speech.synthesize(REQUEST);
  assert.deepEqual(on.calls[0].body.systemInstruction, { parts: [{ text: 'steer ko' }] });
  assert.deepEqual(on.calls[0].body.contents, [{ parts: [{ text: '역이 어디예요?' }] }]);
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
