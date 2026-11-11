// The contract of build/amgi-clip (server/cli/clip.c's header comment), proven against the tests'
// fake Gemini (plusaudio/test/helpers/fake-gemini.js, in process): every exit code, what stdout and
// stderr carry, where the key comes from, and the rate gate's wait range. The binary is run as a
// child with a sandboxed environment; every spawn is async, so the fake keeps answering while
// the child waits on it. The add-on's side of the same contract is
// anki/addon/amgi_bridge/test/test_generator.py.
//
// Needs make -C server build/amgi-clip first (the test says so when it is missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './servers.mjs';
import { sandboxEnv } from '../sandbox-home.cjs';

const require = createRequire(import.meta.url);
const { fakeGemini, WAV, dailyQuotaExhausted, grpcError, quotaExhausted } = require('../../plusaudio/test/helpers/fake-gemini.js');

const CLIP = path.join(ROOT, 'server', 'build', 'amgi-clip');
const UNAVAILABLE = 14;
const USAGE = 'Usage: amgi-clip --text <text> --language <code> --out <path.wav> [--reading <text>]';
const MISSING_KEY = 'GEMINI_API_KEY is not set, so nothing was generated: get a key at https://aistudio.google.com/apikey, add it to .env.local and restart amgi.';

/** A scratch directory of this test's own, and the path of its clip. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-clip-'));
  return { dir, out: path.join(dir, 'clip.wav'), envFile: path.join(dir, 'no-such.env') };
}

/** Runs the binary with `args` in `cwd`; resolves with its exit code and both streams. */
function runClip(args, env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLIP, args, { cwd, env: sandboxEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The environment for one run: a sandbox, the fake's endpoint, and a key unless `key` says none. */
function clipEnv(fake, paths, options = {}) {
  // A key given as undefined means unset; sandboxEnv drops undefined values.
  const key = 'key' in options ? options.key : 'test-key';
  return sandboxEnv({
    GEMINI_API_BASE: fake.baseUrl,
    AMGI_CLIP_ENV_FILE: paths.envFile,
    GEMINI_API_KEY: key,
    ...Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'key')),
  });
}

/** The arguments of a full request for `text`, in `language`, written to `out`. */
function request(out, text = '안녕', language = 'ko', extra = []) {
  return ['--text', text, '--language', language, '--out', out, ...extra];
}

/** The last non-empty line of stderr: what a caller shows a person. */
function lastLine(stderr) {
  return stderr.trimEnd().split('\n').at(-1);
}

test('a good clip is written to --out, exit 0, nothing on stdout or stderr', async () => {
  const paths = scratch();
  const fake = await fakeGemini({ transcribe: '안녕' });
  try {
    const { code, stdout, stderr } = await runClip(request(paths.out), clipEnv(fake, paths));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.deepEqual(fs.readFileSync(paths.out), WAV);
    assert.equal(fake.of('speech')[0].headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(fs.readdirSync(paths.dir), ['clip.wav'], 'no temporary file left beside the clip');
  } finally {
    await fake.close();
  }
});

test('usage errors exit 2 and touch nothing; --help exits 0 with the usage on stdout', async () => {
  const paths = scratch();
  const fake = await fakeGemini({});
  try {
    const env = clipEnv(fake, paths);
    fs.writeFileSync(paths.out, 'stale');

    const none = await runClip([], env);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /^missing required option\(s\): --text, --language, --out\n/);
    assert.ok(none.stderr.includes(USAGE));

    const unknown = await runClip([...request(paths.out), '--bogus', 'x'], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^unknown option --bogus\n/);

    const valueless = await runClip(['--text', 'hello', '--language', 'ko', '--out'], env);
    assert.equal(valueless.code, 2);
    assert.match(valueless.stderr, /^--out needs a value\n/);

    assert.equal(fs.readFileSync(paths.out, 'utf8'), 'stale', 'a usage error leaves --out as it was');
    assert.equal(fake.requests.length, 0, 'a usage error makes no call');

    const help = await runClip(['--help'], env);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, `${USAGE}\n`);
  } finally {
    await fake.close();
  }
});

test('a rate-limited answer exits 3, says the wait on stdout, and writes nothing', async () => {
  const paths = scratch();
  // A per-minute refusal with a 60 s RetryInfo: longer than the 30 s the client sits through.
  const fake = await fakeGemini({ speech: quotaExhausted({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }, 60) });
  try {
    fs.writeFileSync(paths.out, 'stale');
    const { code, stdout, stderr } = await runClip(request(paths.out), clipEnv(fake, paths));
    assert.equal(code, 3, stderr);
    const match = /^retry-after-ms=(\d+)\n$/.exec(stdout);
    assert.ok(match, `stdout is one retry-after-ms line, got ${JSON.stringify(stdout)}`);
    // The 60 s the answer asked for, jittered up to 25% by the rate gate's one draw.
    const waitMs = Number(match[1]);
    assert.ok(waitMs >= 55000 && waitMs <= 75000, `wait ${waitMs} ms is the 60 s retryDelay, jittered`);
    assert.match(stderr, /limiting how many requests/);
    assert.equal(fs.existsSync(paths.out), false, 'a failed run leaves no clip, and the stale one is gone');
  } finally {
    await fake.close();
  }
});

test('a spent daily cap exits 4 with nothing on stdout and no clip', async () => {
  const paths = scratch();
  const fake = await fakeGemini({ speech: dailyQuotaExhausted() });
  try {
    fs.writeFileSync(paths.out, 'stale');
    const { code, stdout, stderr } = await runClip(request(paths.out), clipEnv(fake, paths));
    assert.equal(code, 4, stderr);
    assert.equal(stdout, '');
    assert.match(lastLine(stderr), /used up/);
    assert.equal(fs.existsSync(paths.out), false);
  } finally {
    await fake.close();
  }
});

test('a generation failure exits 1 with its message as the last stderr line and no clip', async () => {
  const paths = scratch();
  const fake = await fakeGemini({ speech: grpcError(UNAVAILABLE, 'unscripted (fake outage)') });
  try {
    fs.writeFileSync(paths.out, 'stale');
    const { code, stdout, stderr } = await runClip(request(paths.out), clipEnv(fake, paths));
    assert.equal(code, 1, stderr);
    assert.equal(stdout, '');
    assert.match(lastLine(stderr), /^Failed to generate valid audio for "안녕" after 3 attempts/);
    assert.equal(fs.existsSync(paths.out), false, 'no clip, and the stale one is removed');
  } finally {
    await fake.close();
  }
});

test('no key anywhere exits 1 with the one-line message and makes no call', async () => {
  const paths = scratch();
  const fake = await fakeGemini({});
  try {
    const env = clipEnv(fake, paths, { key: undefined });
    const { code, stderr } = await runClip(request(paths.out), env);
    assert.equal(code, 1);
    assert.equal(stderr, `${MISSING_KEY}\n`);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('the key comes from the env file when the environment does not set it', async () => {
  const paths = scratch();
  fs.writeFileSync(paths.envFile, 'GEMINI_API_KEY=from-file\n');
  const fake = await fakeGemini({ transcribe: '안녕' });
  try {
    const env = clipEnv(fake, paths, { key: undefined });
    const { code, stderr } = await runClip(request(paths.out), env);
    assert.equal(code, 0, stderr);
    assert.equal(fake.of('speech')[0].headers['x-goog-api-key'], 'from-file');
  } finally {
    await fake.close();
  }
});

test('with no AMGI_CLIP_ENV_FILE the key comes from .env.local in the working directory', async () => {
  const paths = scratch();
  fs.writeFileSync(path.join(paths.dir, '.env.local'), 'GEMINI_API_KEY=from-env-local\n');
  const fake = await fakeGemini({ transcribe: '안녕' });
  try {
    const env = clipEnv(fake, paths, { key: undefined, AMGI_CLIP_ENV_FILE: undefined });
    const { code, stderr } = await runClip(request(paths.out), env, paths.dir);
    assert.equal(code, 0, stderr);
    assert.equal(fake.of('speech')[0].headers['x-goog-api-key'], 'from-env-local');
  } finally {
    await fake.close();
  }
});

test('the environment wins over the env file', async () => {
  const paths = scratch();
  fs.writeFileSync(paths.envFile, 'GEMINI_API_KEY=from-file\n');
  const fake = await fakeGemini({ transcribe: '안녕' });
  try {
    const { code, stderr } = await runClip(request(paths.out), clipEnv(fake, paths, { key: 'from-env' }));
    assert.equal(code, 0, stderr);
    assert.equal(fake.of('speech')[0].headers['x-goog-api-key'], 'from-env');
  } finally {
    await fake.close();
  }
});

test('--reading reaches the audio judge and never the synthesiser', async () => {
  const paths = scratch();
  // Japanese with a reading: the transcript alone cannot say which reading was spoken, so the judge hears it.
  const fake = await fakeGemini({
    transcribe: '行った',
    judge: { heard: '行った', matches: true, reason: 'fake' },
  });
  try {
    const { code, stderr } = await runClip(request(paths.out, '行った', 'ja', ['--reading', 'いった']), clipEnv(fake, paths));
    assert.equal(code, 0, stderr);
    assert.equal(fake.of('judge').length, 1, 'the judge hears the clip, because the reading is in question');
    assert.ok(JSON.stringify(fake.of('judge')[0].body).includes('いった'), 'the judge is given the reading');
    assert.ok(!JSON.stringify(fake.of('speech')[0].body).includes('いった'), 'the synthesiser is not');
  } finally {
    await fake.close();
  }
});
