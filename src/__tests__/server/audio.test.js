// What a clip generation leaves in the collection when it fails: nothing.
//
// It used to leave a few lines of text saying "not playable audio" under the
// clip's real, content-hashed name. That name is what generateAndStoreClip
// takes as "this clip already exists", so the placeholder was permanent: a
// real Korean card played nothing, its bulk row said it had succeeded, and
// every later attempt at the same text reused the placeholder. The failure
// itself was a transient one, and its recorded reason was the first line of
// stderr, which was a Node module-type warning rather than the error.
//
// The subprocess is faked at node:child_process, the boundary audio.js
// crosses, so no test here starts a generator or reaches Gemini.

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import fs from 'node:fs';

const runs = [];
let nextRun;

// The subprocess boundary, faked (run with --experimental-test-module-mocks).
mock.module('node:child_process', {
  namedExports: {
    fork: (file, args) => {
      runs.push(args);
      return require('../../test-helpers/fakeFork').fakeFork(args, nextRun);
    },
  },
});
const { generateAndStoreClip } = await import('../../server/anki/audio');
const { DailyCapError, RateLimitedError } = await import('../../server/anki/plusaudioCli');

const NODE_WARNING = [
  '(node:21698) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///plusaudio/lib/cardGeneration/cardText.ts is not specified and it doesn\'t parse as CommonJS.',
  'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.',
].join('\n');

function failWith(stderr) {
  return () => Promise.reject(Object.assign(new Error('Command failed'), { code: 1, stderr }));
}

/** Writes `bytes` to the --out path, the way generate-clip.js does on success. */
function succeedWith(bytes) {
  return (args) => {
    fs.writeFileSync(args[args.indexOf('--out') + 1], bytes);
    return Promise.resolve({ stdout: '', stderr: NODE_WARNING });
  };
}

function fakeOps(existing = []) {
  const media = new Map(existing.map((name) => [name, Buffer.from('an earlier take')]));
  return {
    media,
    hasMedia: async (name) => media.has(name),
    addMedia: async (name, data) => {
      const stored = media.has(name) ? name.replace(/\.(mp3|wav)$/, '-2.$1') : name;
      media.set(stored, data);
      return stored;
    },
  };
}

const CLIP = { text: '화이팅', language: 'ko' };
// The first bytes of a WAV file, which is all a Gemini clip ever is.
const WAV = (tail) => Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVE'), Buffer.from(tail)]);
const KEYS = ['GEMINI_API_KEY'];
const originalKeys = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  runs.length = 0;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  console.error.mock.restore();
  for (const name of KEYS) {
    if (originalKeys[name] === undefined) delete process.env[name];
    else process.env[name] = originalKeys[name];
  }
});

test('a failed generation stores nothing and says why, not what Node warned about', async () => {
  nextRun = failWith(`${NODE_WARNING}\ngenerated audio did not match the text after 3 attempts\n`);
  const ops = fakeOps();

  await assert.rejects(generateAndStoreClip({ ...CLIP, ops }), { message: /^generated audio did not match the text after 3 attempts$/ });
  assert.equal(ops.media.size, 0);
  assert.ok(console.error.mock.calls.some((call) => String(call.arguments[0]).includes('MODULE_TYPELESS_PACKAGE_JSON')));
});

test('with no Gemini key, nothing is generated, and the error says where to get one', async () => {
  delete process.env.GEMINI_API_KEY;
  nextRun = succeedWith(WAV('should never be asked for'));
  const ops = fakeOps();

  await assert.rejects(generateAndStoreClip({ ...CLIP, ops }), 
    { message: /^GEMINI_API_KEY is not set, so nothing was generated: get a key at https:\/\/aistudio\.google\.com\/apikey/ });
  assert.equal((runs).length, 0);
  assert.equal(ops.media.size, 0);
});

test('the daily quota message from the CLI is what the caller gets, word for word', async () => {
  const quota = "Gemini's free tier allows 10 requests per day per model, and today's are used up for gemini-3.8-flash-tts. Enable billing for your Gemini API key's project in Google AI Studio (https://aistudio.google.com/apikey) to lift the limit, or try again tomorrow.";
  nextRun = failWith(`${NODE_WARNING}\n${quota}\n`);
  const ops = fakeOps();

  await assert.rejects(generateAndStoreClip({ ...CLIP, ops }), { message: quota });
  assert.equal(ops.media.size, 0);
});

test('a rate-limited run (exit 3) comes back typed, with the wait the gate gave it, and stores nothing', async () => {
  nextRun = () => ({ code: 3, stdout: 'retry-after-ms=51234\n', stderr: `${NODE_WARNING}\nGemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.\n` });
  const ops = fakeOps();

  const error = await generateAndStoreClip({ ...CLIP, ops }).then(() => null, (e) => e);

  assert.ok(((error) instanceof RateLimitedError));
  assert.equal(error.rateLimited, true);
  assert.equal(error.retryAfterMs, 51234);
  assert.equal(error.message, 'Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute and asked to wait 52s.');
  assert.equal(ops.media.size, 0);
});

test('a spent daily cap (exit 4) comes back typed as one', async () => {
  nextRun = () => ({ code: 4, stderr: "Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up.\n" });

  const error = await generateAndStoreClip({ ...CLIP, ops: fakeOps() }).then(() => null, (e) => e);

  assert.ok(((error) instanceof DailyCapError));
  assert.equal(error.dailyCap, true);
});

test('a successful generation stores the clip under its content-hashed .wav name', async () => {
  const bytes = WAV('real audio');
  nextRun = succeedWith(bytes);
  const ops = fakeOps();

  const clip = await generateAndStoreClip({ ...CLIP, ops });

  assert.match(clip.filename, /^plusaudio-[0-9a-f]{20}\.wav$/);
  assert.match(runs[0][runs[0].indexOf('--out') + 1], /\.wav$/);
  assert.equal(clip.reference, `<audio src="${clip.filename}"></audio>`);
  assert.deepEqual(ops.media.get(clip.filename), bytes);
});

test('an mp3 of the same text from before Gemini is left alone, and the new card gets a wav take', async () => {
  nextRun = succeedWith(WAV('a Gemini take'));
  const first = await generateAndStoreClip({ ...CLIP, ops: fakeOps() });
  const legacyMp3 = first.filename.replace(/\.wav$/, '.mp3');
  const ops = fakeOps([legacyMp3]);

  const clip = await generateAndStoreClip({ ...CLIP, ops });

  assert.equal(clip.reused, undefined);
  assert.equal(clip.filename, first.filename);
  assert.deepEqual(ops.media.get(legacyMp3), Buffer.from('an earlier take'));
  assert.deepEqual(ops.media.get(clip.filename), WAV('a Gemini take'));
});

test('an existing clip is reused, but a re-record makes a new take', async () => {
  nextRun = succeedWith(WAV('a new take'));
  const first = await generateAndStoreClip({ ...CLIP, ops: fakeOps() });
  const ops = fakeOps([first.filename]);

  const reused = await generateAndStoreClip({ ...CLIP, ops });
  assert.partialDeepStrictEqual(reused, { filename: first.filename, reused: true });
  assert.equal((runs).length, 1);

  const retake = await generateAndStoreClip({ ...CLIP, fresh: true, ops });
  assert.equal((runs).length, 2);
  assert.notEqual(retake.filename, first.filename);
  assert.deepEqual(ops.media.get(retake.filename), WAV('a new take'));
});
