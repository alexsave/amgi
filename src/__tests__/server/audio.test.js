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
// crosses, so no test here starts a generator or reaches OpenAI.

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
      const stored = media.has(name) ? name.replace(/\.mp3$/, '-2.mp3') : name;
      media.set(stored, data);
      return stored;
    },
  };
}

const CLIP = { text: '화이팅', language: 'ko' };
const originalKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  runs.length = 0;
  process.env.OPENAI_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
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

test('with no key, nothing is generated and nothing is stored', async () => {
  delete process.env.OPENAI_API_KEY;
  nextRun = succeedWith(Buffer.from('should never be asked for'));
  const ops = fakeOps();

  await expect(generateAndStoreClip({ ...CLIP, ops })).rejects.toThrow(/OPENAI_API_KEY is not set/);
  expect(runs).toHaveLength(0);
  expect(ops.media.size).toBe(0);
});

test('a successful generation stores the clip under its content-hashed name', async () => {
  const bytes = Buffer.from('ID3 real audio');
  nextRun = succeedWith(bytes);
  const ops = fakeOps();

  const clip = await generateAndStoreClip({ ...CLIP, ops });

  expect(clip.filename).toMatch(/^plusaudio-[0-9a-f]+\.mp3$/);
  expect(clip.reference).toBe(`<audio src="${clip.filename}"></audio>`);
  expect(ops.media.get(clip.filename)).toEqual(bytes);
});

test('an existing clip is reused, but a re-record makes a new take', async () => {
  nextRun = succeedWith(Buffer.from('ID3 a new take'));
  const first = await generateAndStoreClip({ ...CLIP, ops: fakeOps() });
  const ops = fakeOps([first.filename]);

  const reused = await generateAndStoreClip({ ...CLIP, ops });
  expect(reused).toMatchObject({ filename: first.filename, reused: true });
  expect(runs).toHaveLength(1);

  const retake = await generateAndStoreClip({ ...CLIP, fresh: true, ops });
  expect(runs).toHaveLength(2);
  expect(retake.filename).not.toBe(first.filename);
  expect(ops.media.get(retake.filename)).toEqual(Buffer.from('ID3 a new take'));
});
