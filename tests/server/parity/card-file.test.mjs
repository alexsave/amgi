// `amgi card add --file PATH` (server/cli/amgi.c make_cards) against a real server and the tests' fake Gemini
// (tests/helpers/fake-gemini.js, in process, which keeps a log of every request that reached it):
//   - one card per line, in order, and the bulk line last;
//   - a repeat inside the file and a line the deck already has are skipped, Gemini is not asked, and a second run adds nothing;
//   - [section] lines and blank lines are passed over;
//   - Gemini's per-minute limit is waited out and the line asked again; the day's cap stops the run with the rest left;
//   - the deck's pair decides the languages: a deck with none refuses (exit 4), --from and --to store one, and a line in a third language
//     is made in the pair;
//   - stdin, a missing file, a file too long for one run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode } from '../../../ui/wire/wire.mjs';
import { ROOT } from './servers.mjs';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';

const require = createRequire(import.meta.url);
const { fakeGemini, e2eScript, dailyQuotaExhausted, quotaExhausted } = require('../../helpers/fake-gemini.js');

const AMGI = path.join(ROOT, 'server', 'build', 'amgi');
const FIXTURE = path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18');
const LINES_MAX_BYTES = 65536;

const stops = [];
after(async () => {
    for (const stop of stops.reverse()) await stop();
});

/** Runs the binary with `env` (and `input` on its stdin); resolves with its exit code and both streams. Async, so the fake keeps answering. */
function amgi(env, args, input = '') {
    return new Promise((resolve, reject) => {
        const child = spawn(AMGI, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

/** What the run said, a line a record: [kind, ...fields]. */
const records = (out) => out.trimEnd().split('\n').filter(Boolean).map((l) => l.split('\t'));
const kinds = (out) => records(out).map((r) => r[0]);

const textOf = (body) => (body.contents || []).flatMap((c) => c.parts || []).map((p) => p.text || '').join('\n');

/** One amgi up on a fake Gemini; control.text, when set, answers a text call first (a function of the call and its index; undefined passes it to the fake's own). */
async function rig() {
    const script = e2eScript();
    const own = script.text;
    const control = { text: null };
    script.text = (body, index, model) => control.text?.(body, index) ?? own(body, index, model);
    const fake = await fakeGemini(script, { control: script.control });
    stops.push(fake.close);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-card-file-'));
    const env = sandboxEnv({ AMGI_STATE_DIR: state, GEMINI_API_KEY: 'test-key', GEMINI_API_BASE: fake.baseUrl });
    const profile = path.join(env.HOME, 'Library', 'Application Support', 'Anki2', 'User 1');
    fs.cpSync(FIXTURE, profile, { recursive: true });
    const up = await amgi(env, ['up', '--port', '0']);
    assert.equal(up.code, 0, up.stderr);
    stops.push(async () => {
        await amgi(env, ['down']);
        fs.rmSync(state, { recursive: true, force: true });
    });
    const run = (...args) => amgi(env, args);
    assert.equal((await run('install')).code, 0);
    const files = fs.mkdtempSync(path.join(state, 'files-'));
    const write = (name, text) => {
        const file = path.join(files, name);
        fs.writeFileSync(file, text);
        return file;
    };
    const texts = () => fake.of('text').map((q) => textOf(q.body));
    /** The Language field of every note of a deck, read from the server as a page would. */
    const languages = async (deck) => {
        const status = records((await run('status')).stdout)[0];
        const headers = { 'x-amgi-collection': encodeURIComponent(status[6]), 'x-amgi-profile': encodeURIComponent(status[5]) };
        const get = async (route, kind) => decode(kind, new Uint8Array(await (await fetch(`http://127.0.0.1:${status[4]}/api/anki/${route}`, { headers })).arrayBuffer()));
        const id = (await get('decks', 'decks')).decks.find((d) => d.name === deck).id;
        const types = (await get('notetypes', 'notetypes')).notetypes.find((t) => t.name === 'amgi Listening');
        const at = types.fieldNames.indexOf('Language');
        return (await get(`decks/${id}/notes`, 'notes')).notes.map((n) => n.fields[at]);
    };
    return { fake, control, run, write, texts, env, languages };
}

/** The notes of a deck as card list prints them: [id, front, back]. */
async function notesOf(r, deck) {
    const listed = await r.run('card', 'list', '--deck', deck);
    assert.equal(listed.code, 0, listed.stderr);
    return records(listed.stdout).map((x) => [x[1], x[2], x[3]]);
}

test('one card per line, in order; [section] and blank lines are passed over; a repeat is skipped, asked of nobody; the bulk line is last', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Lines', '--from', 'en', '--to', 'ko')).code, 0);
    const file = r.write('lines.txt', 'Phrase 1\n\n[Verse 1]\n  Phrase 2  \r\nPhrase 3\nPhrase 1!\nPhrase 4\n');
    const before = r.fake.of('text').length;
    const done = await r.run('card', 'add', '--deck', 'Lines', '--file', file, '--no-audio');
    assert.equal(done.code, 0, done.stderr);
    const rec = records(done.stdout);
    assert.deepEqual(rec.map((x) => x[0]), ['note', 'note', 'note', 'skip', 'note', 'bulk']);
    assert.deepEqual(rec[3], ['skip', 'repeat', 'Phrase 1!']);
    assert.deepEqual(rec[5], ['bulk', '4', '1', '0', '0']);
    assert.deepEqual(rec.filter((x) => x[0] === 'note').map((x) => x[2]), ['Phrase 1', 'Phrase 2', 'Phrase 3', 'Phrase 4'], 'in the file\'s order');
    assert.equal(r.fake.of('text').length - before, 4, 'the repeat was not asked of Gemini');
    const notes = await notesOf(r, 'Lines');
    assert.equal(notes.length, 4);
    assert.deepEqual(notes.map((n) => n[1]).sort(), ['Phrase 1', 'Phrase 2', 'Phrase 3', 'Phrase 4']);
});

test('a line the deck already has is skipped, and a second run of the same file adds nothing and asks Gemini nothing', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Again', '--from', 'en', '--to', 'ko')).code, 0);
    assert.equal((await r.run('card', 'add', '--deck', 'Again', '--front', 'Already here', '--back', '이미 있어요')).code, 0);
    const file = r.write('again.txt', 'Already here.\nNew one 1\nNew one 2\n이미 있어요\n');
    const first = await r.run('card', 'add', '--deck', 'Again', '--file', file, '--no-audio');
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(kinds(first.stdout), ['skip', 'note', 'note', 'skip', 'bulk']);
    assert.deepEqual(records(first.stdout)[0], ['skip', 'in-deck', 'Already here.']);
    assert.deepEqual(records(first.stdout)[3], ['skip', 'in-deck', '이미 있어요']);
    assert.deepEqual(records(first.stdout)[4], ['bulk', '2', '2', '0', '0']);
    assert.equal((await notesOf(r, 'Again')).length, 3);
    const asked = r.fake.requests.length;
    const second = await r.run('card', 'add', '--deck', 'Again', '--file', file, '--no-audio');
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(kinds(second.stdout), ['skip', 'skip', 'skip', 'skip', 'bulk']);
    assert.ok(records(second.stdout).slice(0, 4).every((x) => x[1] === 'in-deck'));
    assert.deepEqual(records(second.stdout)[4], ['bulk', '0', '4', '0', '0']);
    assert.equal(r.fake.requests.length, asked, 'nothing was asked of Gemini');
    assert.equal((await notesOf(r, 'Again')).length, 3);
});

test('the rate limit is waited out and the line asked again: both runs add every line', async () => {
    // One run's card is refused (Gemini's 429 with a retry delay), which blocks the model in the server's one gate; the second run's first
    // card then meets the gate's own refusal before it starts (notStarted), waits as asked and goes on.
    const r = await rig();
    for (const name of ['Blocked', 'Waiting']) assert.equal((await r.run('deck', 'add', name, '--from', 'en', '--to', 'ko')).code, 0);
    let refused = 0;
    r.control.text = (body, index) => {
        if (refused || !/Their input: "Blocker/.test(textOf(body))) return undefined;
        refused += 1;
        return new Promise((resolve) => setTimeout(resolve, 400, quotaExhausted({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }, 3)));
    };
    const first = r.run('card', 'add', '--deck', 'Blocked', '--file', r.write('blocked.txt', 'Blocker 1\nBlocker 2\n'), '--no-audio');
    while (!r.fake.of('text').length) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 900)); // the refusal is in the gate by now
    const before = Date.now();
    const second = await r.run('card', 'add', '--deck', 'Waiting', '--file', r.write('waiting.txt', 'Wait 1\nWait 2\n'), '--no-audio');
    const waited = Date.now() - before;
    const firstDone = await first;
    r.control.text = null;
    assert.equal(refused, 1, 'Gemini refused once');
    for (const [done, name] of [[firstDone, 'Blocked'], [second, 'Waiting']]) {
        assert.equal(done.code, 0, done.stderr);
        assert.deepEqual(kinds(done.stdout), ['note', 'note', 'bulk'], name);
        assert.deepEqual(records(done.stdout)[2], ['bulk', '2', '0', '0', '0']);
        assert.equal((await notesOf(r, name)).length, 2);
    }
    assert.match(second.stderr, /rate limit \(notStarted\): waiting \d+ms, then asking again: Wait 1/);
    assert.ok(waited >= 1000, `it waited (${waited} ms)`);
});

test('the day\'s cap mid-file stops the run cleanly: the cards before it stay, the rest are left dailyCap, exit 5', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Capped', '--from', 'en', '--to', 'ko')).code, 0);
    const base = r.fake.of('text').length;
    r.control.text = (body, index) => (index >= base + 2 ? dailyQuotaExhausted() : undefined);
    const done = await r.run('card', 'add', '--deck', 'Capped', '--file', r.write('capped.txt', 'Cap 1\nCap 2\nCap 3\nCap 4\nCap 3\n'), '--no-audio');
    r.control.text = null;
    assert.equal(done.code, 5, done.stderr);
    assert.deepEqual(kinds(done.stdout).slice(0, 2), ['note', 'note']);
    assert.deepEqual(records(done.stdout).slice(2), [
        ['left', 'dailyCap', 'Cap 3'],
        ['left', 'dailyCap', 'Cap 4'],
        ['skip', 'repeat', 'Cap 3'],
        ['bulk', '2', '1', '0', '2'],
    ]);
    assert.match(done.stderr, /the day's quota is spent/);
    assert.deepEqual((await notesOf(r, 'Capped')).map((n) => n[1]).sort(), ['Cap 1', 'Cap 2']);
    assert.equal(r.fake.of('text').length - base, 3, 'the run stopped asking after the cap');
});

test('a deck without a pair: exit 4 and nothing added; --from and --to on such a deck store the pair and make the cards', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Bare')).code, 0);
    r.fake.requests.length = 0;
    const file = r.write('bare.txt', 'Bare 1\nBare 2\n');
    const refused = await r.run('card', 'add', '--deck', 'Bare', '--file', file, '--no-audio');
    assert.equal(refused.code, 4);
    assert.equal(refused.stdout, '', 'no phrase was made or reported');
    assert.match(refused.stderr, /the deck has no languages yet: pass --from and --to/);
    assert.equal((await notesOf(r, 'Bare')).length, 0);
    assert.deepEqual(r.fake.of('text'), [], 'no card was asked of Gemini');
    const given = await r.run('card', 'add', '--deck', 'Bare', '--file', file, '--from', 'en', '--to', 'ko', '--no-audio');
    assert.equal(given.code, 0, given.stderr);
    assert.deepEqual(records(given.stdout).at(-1), ['bulk', '2', '0', '0', '0']);
    const deck = records((await r.run('deck', 'list')).stdout).find((x) => x[3] === 'Bare');
    assert.deepEqual([deck[4], deck[5]], ['en', 'ko'], 'the pair is stored');
    // a pair that is not the deck's own is refused, and nothing is added
    const other = await r.run('card', 'add', '--deck', 'Bare', '--file', r.write('other.txt', 'Other 1\n'), '--from', 'ko', '--to', 'en', '--no-audio');
    assert.equal(other.code, 4);
    assert.equal((await notesOf(r, 'Bare')).length, 2);
});

test('a line in a third language is made in the deck\'s pair', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Pair', '--from', 'en', '--to', 'ko')).code, 0);
    const base = r.fake.of('text').length;
    const done = await r.run('card', 'add', '--deck', 'Pair', '--file', r.write('third.txt', 'Où est la gare ?\n'), '--no-audio');
    assert.equal(done.code, 0, done.stderr);
    const asked = r.texts().slice(base);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /The learner speaks English and is learning Korean\./);
    assert.match(asked[0], /Their input: "Où est la gare \?"/);
    assert.deepEqual(await r.languages('Pair'), ['ko'], 'the note\'s Language field is the deck\'s learning language');
    const reversed = await r.run('deck', 'add', 'Pair back', '--from', 'ko', '--to', 'en');
    assert.equal(reversed.code, 0);
    const base2 = r.fake.of('text').length;
    assert.equal((await r.run('card', 'add', '--deck', 'Pair back', '--file', r.write('third2.txt', 'Où est la gare ?\n'), '--no-audio')).code, 0);
    assert.match(r.texts()[base2], /The learner speaks Korean and is learning English\./);
    assert.deepEqual(await r.languages('Pair back'), ['en']);
});

test('--file - reads standard input; a missing file and a file too long for one run are usage errors, and nothing is added', async () => {
    const r = await rig();
    assert.equal((await r.run('deck', 'add', 'Piped', '--from', 'en', '--to', 'ko')).code, 0);
    const piped = await amgi(r.env, ['card', 'add', '--deck', 'Piped', '--file', '-', '--no-audio'], 'Pipe 1\nPipe 2\n');
    assert.equal(piped.code, 0, piped.stderr);
    assert.deepEqual(kinds(piped.stdout), ['note', 'note', 'bulk']);
    assert.deepEqual(records(piped.stdout)[2], ['bulk', '2', '0', '0', '0']);
    const asked = r.fake.requests.length;
    const missing = await r.run('card', 'add', '--deck', 'Piped', '--file', '/nonexistent/phrases.txt');
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /--file \/nonexistent\/phrases\.txt: No such file/);
    const long = r.write('long.txt', `${'a long line of words\n'.repeat(Math.ceil(LINES_MAX_BYTES / 21) + 1)}`);
    assert.ok(fs.statSync(long).size > LINES_MAX_BYTES);
    const refused = await r.run('card', 'add', '--deck', 'Piped', '--file', long, '--no-audio');
    assert.equal(refused.code, 4);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /longer than 65536 bytes/);
    const tooLongStdin = await amgi(r.env, ['card', 'add', '--deck', 'Piped', '--file', '-', '--no-audio'], 'x\n'.repeat(LINES_MAX_BYTES));
    assert.equal(tooLongStdin.code, 4);
    assert.equal(r.fake.requests.length, asked, 'none of them asked Gemini');
    assert.equal((await notesOf(r, 'Piped')).length, 2);
    // --text and --file are two ways, not both
    assert.equal((await r.run('card', 'add', '--deck', 'Piped', '--file', long, '--text', 'x')).code, 4);
});
