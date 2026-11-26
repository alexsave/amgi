// `amgi starter-audio` (server/amgi/starter_audio.c), run as the binary against the tests' fake Gemini
// (tests/server/plusaudio/helpers/fake-gemini.js, in process) and a fake ffmpeg on PATH that copies its input to
// its output, so no real Gemini call and no real ffmpeg is needed. Each recording goes to a temp starter folder
// and a temp cache (--dir, --cache); the repository's own anki/starter is only ever read.
//
// The oracle for the voices is firstVoice below, an independent working-out of the draw (checked once against the
// shipped anki/starter/voices.tsv, which the Node script this command replaces drew).
//
// Needs make -C server build/amgi first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './servers.mjs';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';

const require = createRequire(import.meta.url);
const { fakeGemini, e2eScript, dailyQuotaExhausted, grpcError } = require('../plusaudio/helpers/fake-gemini.js');

const AMGI = path.join(ROOT, 'server', 'build', 'amgi');
const LITE = 'gemini-3.8-flash-lite-tts';
const SHIPPED = path.join(ROOT, 'anki', 'starter');
const UNAVAILABLE = 14;
const STARTER_SEED = 20261108;
const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel',
    'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
    'Zubenelgenubi'];

/**
 * The first voice a clip is drawn, worked out here on its own: sfc32 seeded from STARTER_SEED xor the first four bytes (little-endian)
 * of sha1(name), its state spread by splitmix32 and warmed up twelve draws, one draw scaled onto the 26-voice pool. This is
 * random.js's generator and pickVoice, which drew the shipped voices (all but six of the 178 one-attempt rows in voices.tsv are
 * this draw under the names they were recorded under; the six are the second, after a per-minute wait redrew them).
 */
function firstVoice(name) {
    const seed = (STARTER_SEED ^ crypto.createHash('sha1').update(name).digest().readUInt32LE(0)) >>> 0;
    let state = seed;
    const splitmix = () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
    let a = splitmix(), b = splitmix(), c = splitmix(), d = splitmix();
    const next = () => {
        const t = (a + b + d) >>> 0;
        d = (d + 1) >>> 0;
        a = (b ^ (b >>> 9)) >>> 0;
        b = (c + (c << 3)) >>> 0;
        c = ((c << 21) | (c >>> 11)) >>> 0;
        c = (c + t) >>> 0;
        return t;
    };
    for (let i = 0; i < 12; i += 1) next();
    return VOICES[Math.floor((next() / 4294967296) * VOICES.length)];
}

/** The shipped manifest: rows of {file, language, model, voice, attempts, text}. */
function shippedRows() {
    const [header, ...lines] = fs.readFileSync(path.join(SHIPPED, 'voices.tsv'), 'utf8').trimEnd().split('\n');
    const names = header.split('\t');
    return lines.map((line) => Object.fromEntries(line.split('\t').map((cell, i) => [names[i], cell])));
}

/** A scratch directory: a starter folder, a cache, and a bin with a fake ffmpeg (copies the -i file to the last argument). */
function scratch({ ffmpeg = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-starter-audio-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    if (ffmpeg) {
        fs.writeFileSync(path.join(bin, 'ffmpeg'), [
            '#!/bin/sh',
            'in=""; out=""',
            'while [ $# -gt 0 ]; do',
            '  if [ "$1" = "-i" ]; then in="$2"; fi',
            '  out="$1"; shift',
            'done',
            'cp "$in" "$out"',
            '',
        ].join('\n'), { mode: 0o755 });
    }
    return { dir, bin, starter: path.join(dir, 'starter'), cache: path.join(dir, 'cache') };
}

/** Runs the binary; resolves with its exit code and both streams. Async, so the fake keeps answering. */
function run(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(AMGI, ['starter-audio', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** The environment: the fake's endpoint and a key, and PATH led by the scratch bin (which has no real ffmpeg beside it). */
function envFor(paths, fake, extra = {}) {
    return sandboxEnv({ GEMINI_API_BASE: fake.baseUrl, GEMINI_API_KEY: 'test-key', PATH: `${paths.bin}:/usr/bin:/bin`, ...extra });
}

/** The starter folder's rows written by a run, as {file, language, model, voice, attempts, text}. */
function manifestOf(paths) {
    const [header, ...lines] = fs.readFileSync(path.join(paths.starter, 'voices.tsv'), 'utf8').trimEnd().split('\n');
    const names = header.split('\t');
    return lines.map((line) => Object.fromEntries(line.split('\t').map((cell, i) => [names[i], cell])));
}

const row_attempts = (rows) => rows.map((row) => row.attempts).join(',');
const dirArgs = (paths, ...more) => ['--dir', paths.starter, '--cache', paths.cache, ...more];

test('--check on the repository: every clip shipped, exit 0, and not one Gemini call', async () => {
    const paths = scratch();
    const fake = await fakeGemini({});
    try {
        const { code, stdout, stderr } = await run(['--check'], envFor(paths, fake));
        assert.equal(code, 0, stderr);
        assert.match(stdout, /^en: 10 shipped\n/);
        assert.match(stdout, /\n180 of 180 clips shipped; 0 missing\n$/);
        assert.doesNotMatch(stdout, /another model/);
        assert.equal(fake.requests.length, 0);
    } finally {
        await fake.close();
    }
});

test('--check names a missing clip and exits 1; a clip made with another model is counted', async () => {
    const paths = scratch();
    const fake = await fakeGemini({});
    try {
        const rows = shippedRows().filter((row) => row.language === 'ja' || row.language === 'ko');
        fs.mkdirSync(path.join(paths.starter, 'media'), { recursive: true });
        for (const row of rows) fs.copyFileSync(path.join(SHIPPED, 'media', row.file), path.join(paths.starter, 'media', row.file));
        const gone = rows.find((row) => row.language === 'ja' && row.text.startsWith('こんにちは'));
        fs.rmSync(path.join(paths.starter, 'media', gone.file));
        const manifest = fs.readFileSync(path.join(SHIPPED, 'voices.tsv'), 'utf8');
        const other = rows.find((row) => row.language === 'ko');
        fs.writeFileSync(path.join(paths.starter, 'voices.tsv'), manifest.replace(`${other.file}\t${other.language}\t${LITE}`, `${other.file}\t${other.language}\tsome-other-tts`));

        const { code, stdout, stderr } = await run(dirArgs(paths, '--check', '--only', 'ja,ko'), envFor(paths, fake));
        assert.equal(code, 1, stderr);
        assert.match(stdout, /^ja: 9 shipped, 1 missing\n/);
        assert.match(stdout, /\nko: 10 shipped, 1 recorded with another model than gemini-3.8-flash-lite-tts\n/);
        assert.ok(stdout.includes(`missing\tja\t${gone.file}\t${gone.text}\n`), stdout);
        assert.match(stdout, /\n19 of 20 clips shipped; 1 missing\n$/);
        assert.equal(fake.requests.length, 0, '--check makes no call');
        assert.deepEqual(fs.readdirSync(paths.starter).sort(), ['media', 'voices.tsv'], 'and writes nothing');
    } finally {
        await fake.close();
    }
});

test('a recording run writes each clip and its voices.tsv row, with the voice its seed draws', async () => {
    const paths = scratch();
    const fake = await fakeGemini(e2eScript());
    try {
        const { code, stdout, stderr } = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake));
        assert.equal(code, 0, stderr);
        assert.match(stdout, /^0 of 10 clips shipped; 10 to record with gemini-3.8-flash-lite-tts\n/);
        const want = shippedRows().filter((row) => row.language === 'ko');
        const got = manifestOf(paths);
        assert.deepEqual(got.map((row) => [row.file, row.language, row.text]), want.map((row) => [row.file, row.language, row.text]));
        for (const row of got) {
            assert.equal(row.model, LITE);
            const file = path.join(paths.starter, 'media', row.file);
            assert.ok(fs.statSync(file).size > 44, `${row.file} is a clip`);
        }
        // The seeding's oracle: each clip's voice is the first draw of the generator seeded from the seed and the clip's name.
        for (const row of got) assert.equal(row.voice, firstVoice(row.file), `${row.text}: ${row.voice}`);
        assert.equal(row_attempts(got), '1,1,1,1,1,1,1,1,1,1');
        assert.equal(fake.of('speech').length, 10);
        assert.ok(fake.of('speech').every((request) => request.model === LITE), 'speech runs on the model asked for');
        assert.ok(fake.requests.every((request) => request.headers['x-goog-api-key'] === 'test-key'));
        assert.deepEqual(fs.readdirSync(path.join(paths.starter, 'media')).filter((f) => f.includes('.tmp')), [], 'no temporary file left');

        // A second run has nothing to do: it asks nothing of Gemini and changes nothing.
        const before = fs.readFileSync(path.join(paths.starter, 'voices.tsv'), 'utf8');
        const calls = fake.requests.length;
        const again = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake));
        assert.equal(again.code, 0, again.stderr);
        assert.match(again.stdout, /^10 of 10 clips shipped; 0 to record/);
        assert.equal(fake.requests.length, calls);
        assert.equal(fs.readFileSync(path.join(paths.starter, 'voices.tsv'), 'utf8'), before);
    } finally {
        await fake.close();
    }
});

test('the same seed gives the same voice per clip: two cold runs write the same voices.tsv', async () => {
    const first = scratch();
    const second = scratch();
    const fake = await fakeGemini(e2eScript());
    try {
        for (const paths of [first, second]) {
            const { code, stderr } = await run(dirArgs(paths, '--only', 'ja,ar'), envFor(paths, fake));
            assert.equal(code, 0, stderr);
        }
        const a = fs.readFileSync(path.join(first.starter, 'voices.tsv'), 'utf8');
        assert.equal(fs.readFileSync(path.join(second.starter, 'voices.tsv'), 'utf8'), a);
        assert.equal(a.trimEnd().split('\n').length, 21);
        const voices = new Set(manifestOf(first).map((row) => row.voice));
        assert.ok(voices.size > 3, 'the voices differ from clip to clip');
    } finally {
        await fake.close();
    }
});

test('a run that records some languages keeps the other rows of voices.tsv as they were', async () => {
    const paths = scratch();
    const fake = await fakeGemini(e2eScript());
    try {
        fs.cpSync(SHIPPED, paths.starter, { recursive: true });
        const ja = shippedRows().filter((row) => row.language === 'ja');
        for (const row of ja.slice(0, 2)) fs.rmSync(path.join(paths.starter, 'media', row.file));
        const { code, stderr } = await run(dirArgs(paths, '--only', 'ja'), envFor(paths, fake));
        assert.equal(code, 0, stderr);
        assert.equal(fake.of('speech').length, 2, 'only the two missing clips are recorded');
        const was = shippedRows();
        const now = manifestOf(paths);
        assert.equal(now.length, 180);
        for (const row of was.filter((r) => !ja.slice(0, 2).some((j) => j.file === r.file))) {
            assert.deepEqual(now.find((r) => r.file === row.file), row);
        }
    } finally {
        await fake.close();
    }
});

test('a daily cap stops the run at once and ships nothing', async () => {
    const paths = scratch();
    const fake = await fakeGemini({ speech: dailyQuotaExhausted() });
    try {
        const { code, stderr } = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake));
        assert.equal(code, 5, stderr);
        assert.match(stderr, /Stopped at a daily cap: /);
        assert.match(stderr, /0 of 10 clips are validated and cached; 10 remain\. Nothing under .* was changed/);
        assert.equal(fake.of('speech').length, 1, 'the other clips would only be refused too');
        assert.equal(fs.existsSync(path.join(paths.starter, 'media')), false);
        assert.equal(fs.existsSync(path.join(paths.starter, 'voices.tsv')), false);
    } finally {
        await fake.close();
    }
});

test('a clip that does not validate is listed, the run exits 5, and nothing is shipped', async () => {
    const paths = scratch();
    const fake = await fakeGemini({ speech: grpcError(UNAVAILABLE, 'unscripted (fake outage)') });
    try {
        const { code, stdout, stderr } = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake));
        assert.equal(code, 5, stderr);
        assert.match(stdout, /FAILED after 3 attempt\(s\): Failed to generate valid audio for "안녕하세요\." after 3 attempts/);
        assert.match(stderr, /10 clip\(s\) did not validate; nothing under .* was changed:\n {2}ko "안녕하세요\."/);
        assert.equal(fs.existsSync(path.join(paths.starter, 'media')), false);
        assert.equal(fs.existsSync(path.join(paths.starter, 'voices.tsv')), false);
    } finally {
        await fake.close();
    }
});

test('a missing ffmpeg is said before any Gemini call', async () => {
    const paths = scratch({ ffmpeg: false });
    const fake = await fakeGemini(e2eScript());
    try {
        const { code, stderr } = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake, { PATH: `${paths.bin}:/usr/bin:/bin` }));
        assert.equal(code, 1, stderr);
        assert.match(stderr, /ffmpeg is not on PATH/);
        assert.equal(fake.requests.length, 0);
    } finally {
        await fake.close();
    }
});

test('no key anywhere: exit 5 with the one-line message and no call; the key may come from the server\'s env file', async () => {
    const paths = scratch();
    const fake = await fakeGemini(e2eScript());
    try {
        const none = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake, { GEMINI_API_KEY: undefined, CBASE_ENV_FILE: path.join(paths.dir, 'no-such.env') }));
        assert.equal(none.code, 5);
        assert.match(none.stderr, /^GEMINI_API_KEY is not set, so nothing was generated/);
        assert.equal(fake.requests.length, 0);

        const file = path.join(paths.dir, 'keys.env');
        fs.writeFileSync(file, 'GEMINI_API_KEY=from-file\n');
        const some = await run(dirArgs(paths, '--only', 'ko'), envFor(paths, fake, { GEMINI_API_KEY: undefined, CBASE_ENV_FILE: file }));
        assert.equal(some.code, 0, some.stderr);
        assert.equal(fake.of('speech')[0].headers['x-goog-api-key'], 'from-file');
    } finally {
        await fake.close();
    }
});

test('usage errors exit 4 and make no call', async () => {
    const paths = scratch();
    const fake = await fakeGemini({});
    try {
        for (const args of [['--bogus'], ['--only', 'xx'], ['--model', 'gemini-nope'], ['--model']]) {
            const { code, stderr } = await run(args, envFor(paths, fake));
            assert.equal(code, 4, `${args}: ${stderr}`);
            assert.match(stderr, /usage: amgi starter-audio/);
        }
        assert.equal(fake.requests.length, 0);
    } finally {
        await fake.close();
    }
});
