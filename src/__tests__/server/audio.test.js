/**
 * @jest-environment node
 */

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

import fs from 'node:fs';

const runs = [];
let nextRun;

jest.mock('node:child_process', () => {
  const execFile = () => {
    throw new Error('audio.js must call execFile through promisify');
  };
  execFile[require('node:util').promisify.custom] = (file, args) => {
    runs.push(args);
    return nextRun(args);
  };
  return { execFile };
});

import { generateAndStoreClip } from '../../server/anki/audio';

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
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  for (const name of KEYS) {
    if (originalKeys[name] === undefined) delete process.env[name];
    else process.env[name] = originalKeys[name];
  }
});

test('a failed generation stores nothing and says why, not what Node warned about', async () => {
  nextRun = failWith(`${NODE_WARNING}\ngenerated audio did not match the text after 3 attempts\n`);
  const ops = fakeOps();

  await expect(generateAndStoreClip({ ...CLIP, ops })).rejects.toThrow(
    /^generated audio did not match the text after 3 attempts$/,
  );
  expect(ops.media.size).toBe(0);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('MODULE_TYPELESS_PACKAGE_JSON'));
});

test('with no Gemini key, nothing is generated, and the error says where to get one', async () => {
  delete process.env.GEMINI_API_KEY;
  nextRun = succeedWith(WAV('should never be asked for'));
  const ops = fakeOps();

  await expect(generateAndStoreClip({ ...CLIP, ops })).rejects.toThrow(
    /^GEMINI_API_KEY is not set, so nothing was generated: get a key at https:\/\/aistudio\.google\.com\/apikey/,
  );
  expect(runs).toHaveLength(0);
  expect(ops.media.size).toBe(0);
});

test('the daily quota message from the CLI is what the caller gets, word for word', async () => {
  const quota = "Gemini's free tier allows 10 requests per day per model, and today's are used up for gemini-3.8-flash-tts. Enable billing for your Gemini API key's project in Google AI Studio (https://aistudio.google.com/apikey) to lift the limit, or try again tomorrow.";
  nextRun = failWith(`${NODE_WARNING}\n${quota}\n`);
  const ops = fakeOps();

  await expect(generateAndStoreClip({ ...CLIP, ops })).rejects.toThrow(quota);
  expect(ops.media.size).toBe(0);
});

test('a successful generation stores the clip under its content-hashed .wav name', async () => {
  const bytes = WAV('real audio');
  nextRun = succeedWith(bytes);
  const ops = fakeOps();

  const clip = await generateAndStoreClip({ ...CLIP, ops });

  expect(clip.filename).toMatch(/^plusaudio-[0-9a-f]{20}\.wav$/);
  expect(runs[0][runs[0].indexOf('--out') + 1]).toMatch(/\.wav$/);
  expect(clip.reference).toBe(`<audio src="${clip.filename}"></audio>`);
  expect(ops.media.get(clip.filename)).toEqual(bytes);
});

test('an mp3 of the same text from before Gemini is left alone, and the new card gets a wav take', async () => {
  nextRun = succeedWith(WAV('a Gemini take'));
  const first = await generateAndStoreClip({ ...CLIP, ops: fakeOps() });
  const legacyMp3 = first.filename.replace(/\.wav$/, '.mp3');
  const ops = fakeOps([legacyMp3]);

  const clip = await generateAndStoreClip({ ...CLIP, ops });

  expect(clip.reused).toBeUndefined();
  expect(clip.filename).toBe(first.filename);
  expect(ops.media.get(legacyMp3)).toEqual(Buffer.from('an earlier take'));
  expect(ops.media.get(clip.filename)).toEqual(WAV('a Gemini take'));
});

test('an existing clip is reused, but a re-record makes a new take', async () => {
  nextRun = succeedWith(WAV('a new take'));
  const first = await generateAndStoreClip({ ...CLIP, ops: fakeOps() });
  const ops = fakeOps([first.filename]);

  const reused = await generateAndStoreClip({ ...CLIP, ops });
  expect(reused).toMatchObject({ filename: first.filename, reused: true });
  expect(runs).toHaveLength(1);

  const retake = await generateAndStoreClip({ ...CLIP, fresh: true, ops });
  expect(runs).toHaveLength(2);
  expect(retake.filename).not.toBe(first.filename);
  expect(ops.media.get(retake.filename)).toEqual(WAV('a new take'));
});
