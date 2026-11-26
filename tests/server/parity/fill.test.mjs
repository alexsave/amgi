// Fill missing audio (server/amgi/fill.c): POST /decks/:id/audio-plan and POST /notes/:id/audio-fill, and `amgi audio fill`, against the
// tests' fake Gemini (tests/helpers/fake-gemini.js, in process, which keeps a log of every request that reached it).
// The recording of http.txt shows each answer; this file shows what an answer cannot: what was asked of Gemini, and what a note
// holds afterwards.
//   - the plan counts: notes that need a clip, notes that have it, notes that cannot (another note type, no text once its markup is gone);
//   - a fill writes only amgi's own reference, in the form asked, and an image stays where it was, and a note with someone else's audio is not filled at all;
//   - a note that has its clip is not touched (the collection file is not written) and Gemini is not asked;
//   - a second plan after the fills finds nothing to do (idempotent), and changing the form converts a note without a new recording;
//   - a deck with no stored pair refuses both routes, and the language of a clip is the deck's learning or known one;
//   - the Listening note type's two sides at once, and the starter deck's mp3 clips counting as the clips of their text;
//   - Gemini's limits leave a note as it was, and a clip made before the limit is reused by the retry;
//   - the same on the bridge's transport (the add-on's real server), and the command line over all of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';
import { ROOT, startServer } from './servers.mjs';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';

const require = createRequire(import.meta.url);
const { fakeGemini, e2eScript, dailyQuotaExhausted } = require('../../helpers/fake-gemini.js');
const { anki, buildFixtureCollection, tempDir } = require('../../helpers/anki-python.js');

const AMGI = path.join(ROOT, 'server', 'build', 'amgi');
const ENTRY = path.join(ROOT, '.claude', 'skills', 'e2e-ui', 'scripts', 'bridge_server_entry.py');
const FIXTURE = path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18');
const NO_PAIR = /^This deck has no languages yet: choose them first/;

const stops = [];
after(async () => {
    for (const stop of stops.reverse()) await stop();
});

/** The clip's name for a text in a language, worked out here on its own: "amgi-" + the first 20 hex of sha1("v1\n" + language + "\n" + text). */
const clipName = (text, language, extension = 'wav') => `amgi-${crypto.createHash('sha1').update(`v1\n${language}\n${text}`).digest('hex').slice(0, 20)}.${extension}`;

/** A server on a fake Gemini that answers as `script` says, and a copy of the fixture collection it reads, with the note type installed. */
async function rig(script = e2eScript()) {
    const fake = await fakeGemini(script, { control: script.control });
    const app = await startServer({ key: 'fake', base: fake.baseUrl });
    stops.push(app.stop, fake.close);
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-fill-'));
    const base = path.join(top, 'Anki2');
    fs.cpSync(FIXTURE, path.join(base, 'User 1'), { recursive: true });
    fs.mkdirSync(path.join(base, 'addons21'), { recursive: true });
    const collection = path.join(base, 'User 1', 'collection.anki2');
    const headers = {
        'x-amgi-base-dir': encodeURIComponent(base),
        'x-amgi-collection': encodeURIComponent(collection),
        'x-amgi-profile': encodeURIComponent('User 1'),
    };
    const r = { fake, app, base, collection, headers, ask: asker(app.url, headers) };
    assert.equal((await r.ask('POST', 'install', 'installed', ['q_install', {}])).status, 200);
    await finish(r);
    return r;
}

/** ask(method, route, answerKind, [requestKind, body]): { status, body, headers }, the body decoded as answerKind, or as an error when the status is one. */
function asker(url, headers) {
    return async (method, route, answer, body) => {
        const res = await fetch(new URL(`/api/anki/${route}`, url), {
            method,
            headers: { ...headers, ...(body ? { 'content-type': WIRE_MIME } : {}) },
            body: body ? encode(...body) : undefined,
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, body: answer === null ? bytes : decode(res.ok ? answer : 'error', bytes), headers: res.headers };
    };
}

/** The ids and note types a test works with: decks by name, the note types by name and their field index by lower-case name. */
async function finish(r) {
    r.decks = async () => Object.fromEntries((await r.ask('GET', 'decks', 'decks')).body.decks.map((d) => [d.name, d]));
    const types = (await r.ask('GET', 'notetypes', 'notetypes')).body.notetypes;
    r.types = Object.fromEntries(types.map((t) => [t.name, { id: t.id, at: Object.fromEntries(t.fieldNames.map((n, i) => [n.toLowerCase(), i])), width: t.fieldNames.length }]));
    r.deck = async (name, known = 'en', learning = 'ko') => {
        const made = await r.ask('POST', 'decks', 'deck_created', ['q_deck_name', { name }]);
        assert.equal(made.status, 200);
        const id = made.body['deck.id'];
        if (known) assert.equal((await r.ask('PUT', `decks/${id}/languages`, 'deck_languages', ['q_deck_languages', { known, learning }])).status, 200);
        return id;
    };
    r.add = async (deckId, type, fields) => {
        const t = r.types[type];
        const filled = Array.from({ length: t.width }, (_, i) => fields[i] ?? '');
        const added = await r.ask('POST', 'notes', 'note_added', ['q_note', { deckId, notetypeId: t.id, fields: filled }]);
        assert.equal(added.status, 200, JSON.stringify(added.body));
        return added.body.noteId;
    };
    r.note = async (id) => {
        const { body } = await r.ask('GET', `notes/${id}`, 'note');
        return { id: body.id, notetypeId: body.notetypeId, fields: body.fields, tags: body.tags };
    };
    r.plan = (deckId, q) => r.ask('POST', `decks/${deckId}/audio-plan`, 'fill_plan', ['q_fill', q]);
    r.fill = (noteId, q) => r.ask('POST', `notes/${noteId}/audio-fill`, 'note_changed', ['q_fill', q]);
    return r;
}

const ids = (plan) => plan.toFill.map((n) => n.id);
const BASIC = (deckId, r, over = {}) => ({ deckId, notetypeId: r.types.Basic.id, textField: 0, audioField: 1, side: 'learning', form: 'sound', ...over });
const LISTENING = (deckId, r) => ({ deckId, notetypeId: r.types['amgi Listening'].id, side: 'both' });

test('a deck with no stored pair refuses the plan and the fill, and asks Gemini nothing', async () => {
    const r = await rig();
    const deck = await r.deck('No pair', '', '');
    // the fixture's Existing deck has a note and no pair, as collections have been; the routes will not add one to a deck like that
    const decks = await r.decks();
    const note = { deck: decks.Existing.id, id: (await r.ask('GET', `decks/${decks.Existing.id}/notes`, 'notes')).body.notes[0].id };
    for (const deckId of [deck, note.deck]) {
        const plan = await r.plan(deckId, BASIC(deckId, r));
        assert.equal(plan.status, 409);
        assert.match(plan.body.error, NO_PAIR);
    }
    const fill = await r.fill(note.id, BASIC(note.deck, r));
    assert.equal(fill.status, 409);
    assert.match(fill.body.error, NO_PAIR);
    assert.equal(r.fake.requests.length, 0);
    assert.equal((await r.plan(987654321, BASIC(987654321, r))).status, 404, 'a deck that is not there');
});

test('the plan, the fill, and the plan again: only amgi\'s own reference is written, in the form asked, and nothing twice', async () => {
    const r = await rig();
    const deck = await r.deck('Fill');
    const a = await r.add(deck, 'Basic', ['안녕하세요', '']);
    const b = await r.add(deck, 'Basic', ['감사합니다', '[sound:keep-me.mp3]']);
    const empty = await r.add(deck, 'Basic', ['<div> </div>&nbsp;', '']);
    // a clip already in the media folder (made by /audio) is the clip of its text: the fill adds the reference and records nothing
    const made = await r.ask('POST', 'audio', 'clip', ['q_audio', { text: '다음', language: 'ko' }]);
    assert.equal(made.status, 200);
    const reuse = await r.add(deck, 'Basic', ['다음', '']);
    // a reference to amgi's clip of its text, but the file is gone (Check Media took it, a sync lost it): a gap, filled again under the same name
    const lost = await r.add(deck, 'Basic', ['내일 봐요', `[sound:${clipName('내일 봐요', 'ko')}]`]);
    // two clips of amgi's in one field, the clip of the text and the clip of an older one, both there: one is wanted, and the other goes
    assert.equal((await r.ask('POST', 'audio', 'clip', ['q_audio', { text: '좋은 아침', language: 'ko' }])).status, 200);
    const twice = await r.add(deck, 'Basic', ['좋은 아침', `[sound:${clipName('옛날 글', 'ko')}]x[sound:${clipName('좋은 아침', 'ko')}]`]);
    const asked = r.fake.requests.length;
    const d = await r.add(deck, 'Basic', ['<b>잘 가요</b>&nbsp;', '<img src="x.jpg">']);
    const listening = await r.add(deck, 'amgi Listening', { [r.types['amgi Listening'].at.cue]: 'hello', [r.types['amgi Listening'].at.target]: '안녕' });
    const q = BASIC(deck, r);

    const plan = await r.plan(deck, q);
    assert.equal(plan.status, 200);
    assert.deepEqual([ids(plan.body), plan.body.upToDate, plan.body.skipped], [[a, d, reuse, lost, twice].sort((x, y) => x - y), 1, 2], 'someone else\'s audio is audio (up to date), the empty one and the other note type are skipped');
    assert.equal(r.fake.requests.length, asked, 'a plan asks Gemini nothing');
    assert.equal(plan.body.mode, 'direct');

    // sound form: the reference is added after what is there; an image stays, and a note with another add-on's recording is not filled at all
    assert.equal((await r.fill(a, q)).status, 200);
    assert.deepEqual((await r.note(a)).fields, ['안녕하세요', `[sound:${clipName('안녕하세요', 'ko')}]`]);
    assert.equal((await r.fill(b, q)).status, 200);
    assert.deepEqual((await r.note(b)).fields, ['감사합니다', '[sound:keep-me.mp3]'], 'someone else\'s audio: answered as done, untouched');
    assert.equal(r.fake.of('speech').length, 3, 'the two clips made above, and a\'s; b asked nothing');
    assert.equal((await r.fill(reuse, q)).status, 200);
    assert.deepEqual((await r.note(reuse)).fields, ['다음', `[sound:${clipName('다음', 'ko')}]`]);
    assert.equal(r.fake.of('speech').length, 3, 'its clip was there: reused');
    assert.equal((await r.fill(lost, q)).status, 200);
    assert.deepEqual((await r.note(lost)).fields, ['내일 봐요', `[sound:${clipName('내일 봐요', 'ko')}]`]);
    assert.equal(r.fake.of('speech').length, 4, 'the file was gone: recorded again');
    assert.equal((await r.fill(twice, q)).status, 200);
    assert.deepEqual((await r.note(twice)).fields, ['좋은 아침', `[sound:${clipName('좋은 아침', 'ko')}]x`], 'the clip of the older text went, and the one that is wanted took its place; the text between stays');
    assert.equal(r.fake.of('speech').length, 4, 'its clip was there: reused');
    // html form on a note with an image
    const html = { ...q, form: 'html' };
    assert.equal((await r.fill(d, html)).status, 200);
    assert.deepEqual((await r.note(d)).fields, ['<b>잘 가요</b>&nbsp;', `<img src="x.jpg"><audio src="${clipName('잘 가요', 'ko')}"></audio>`]);
    assert.equal((await r.ask('GET', `media/${clipName('안녕하세요', 'ko')}`, null)).status, 200, 'the clip is in the media folder');
    assert.deepEqual((await r.note(empty)).fields, ['<div> </div>&nbsp;', ''], 'a note with nothing to say is not touched');
    assert.deepEqual((await r.note(listening)).fields.filter(Boolean), ['hello', '안녕', 'ko'], 'neither is a note of another type');

    // after the fills: sound asks nothing of d but its form; html asks a and b for theirs
    const sound = await r.plan(deck, q);
    assert.deepEqual([ids(sound.body), sound.body.upToDate, sound.body.skipped], [[d], 5, 2]);
    const htmlPlan = await r.plan(deck, html);
    assert.deepEqual([ids(htmlPlan.body), htmlPlan.body.upToDate], [[a, reuse, lost, twice].sort((x, y) => x - y), 2], 'b has someone else\'s audio in either form');

    // converting is no new recording: the clip is a hash of the text, so only the reference changes
    const calls = r.fake.requests.length;
    assert.equal((await r.fill(d, q)).status, 200);
    assert.deepEqual((await r.note(d)).fields, ['<b>잘 가요</b>&nbsp;', `<img src="x.jpg">[sound:${clipName('잘 가요', 'ko')}]`]);
    assert.equal(r.fake.requests.length, calls, 'the form changed, the clip did not');

    // a note that has its clip is answered as done, left alone (the collection file is not written), and Gemini is not asked
    const before = { note: await r.note(a), file: fs.statSync(r.collection).mtimeMs };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await r.fill(a, q);
    assert.deepEqual([again.status, again.body.noteId], [200, a]);
    assert.deepEqual(await r.note(a), before.note);
    assert.equal(fs.statSync(r.collection).mtimeMs, before.file, 'nothing was written');
    assert.equal(r.fake.requests.length, calls);
    const settled = await r.plan(deck, q);
    assert.deepEqual([ids(settled.body), settled.body.upToDate, settled.body.skipped], [[], 6, 2], 'nothing is left to fill');

    // the text changed: the note needs another clip, and the old one is replaced, not kept beside it
    const front = (await r.note(a)).fields[0];
    assert.equal((await r.ask('PATCH', `notes/${a}`, 'note_changed', ['q_note_update', { fields: [`${front}!`, (await r.note(a)).fields[1]], language: 'ko' }])).status, 200);
    assert.deepEqual(ids((await r.plan(deck, q)).body), [a]);
    assert.equal((await r.fill(a, q)).status, 200);
    assert.deepEqual((await r.note(a)).fields, ['안녕하세요!', `[sound:${clipName('안녕하세요!', 'ko')}]`]);
});

test('the language of a clip is the deck\'s learning or known one, and a request that does not fit is refused before Gemini', async () => {
    const r = await rig();
    const deck = await r.deck('Sides', 'en', 'ko');
    const a = await r.add(deck, 'Basic', ['Good morning', '']);
    const known = BASIC(deck, r, { side: 'known' });
    assert.equal((await r.fill(a, known)).status, 200);
    assert.deepEqual((await r.note(a)).fields, ['Good morning', `[sound:${clipName('Good morning', 'en')}]`], 'a known-side clip is in the known language');
    assert.deepEqual(r.fake.of('speech').length, 1);
    // the same text read as the learning language is another clip (the language is in the hash), so the plan wants it
    assert.deepEqual(ids((await r.plan(deck, BASIC(deck, r))).body), [a]);

    const calls = r.fake.requests.length;
    const refused = [
        [BASIC(deck, r, { side: 'middle' }), 400, /side must be/],
        [BASIC(deck, r, { form: 'mp3' }), 400, /form must be/],
        [BASIC(deck, r, { audioField: 0 }), 400, /must be different/],
        [BASIC(deck, r, { audioField: 9 }), 400, /must be fields of the note type/],
        [BASIC(deck, r, { textField: -1 }), 400, /must be fields of the note type/],
        [BASIC(deck, r, { side: 'both' }), 400, /side both is for the "amgi Listening" note type/],
        [BASIC(deck, r, { notetypeId: 12345 }), 404, /note type no longer exists/],
        [BASIC(deck, r, { notetypeId: r.types['amgi Listening'].id }), 400, /not of the note type/],
    ];
    for (const [q, status, why] of refused) {
        const fill = await r.fill(a, q);
        assert.deepEqual([fill.status, why.test(fill.body.error)], [status, true], `${JSON.stringify(q)}: ${fill.body.error}`);
        if (!/not of the note type/.test(why.source)) {
            const plan = await r.plan(deck, q);
            assert.equal(plan.status, status, `the plan too: ${plan.body.error}`);
        }
    }
    assert.equal((await r.fill(987654321, BASIC(deck, r))).status, 404, 'a note that is not there');
    assert.equal((await r.fill(a, BASIC(987654321, r))).status, 404, 'a deck that is not there');
    assert.equal(r.fake.requests.length, calls, 'none of them reached Gemini');
});

test('amgi Listening notes: both sides at once, as <audio> elements, and the starter deck\'s own clips are already its text\'s clips', async () => {
    const r = await rig();
    const deck = await r.deck('Listen');
    const t = r.types['amgi Listening'];
    const note = await r.add(deck, 'amgi Listening', { [t.at.cue]: 'hello there', [t.at.target]: '안녕 친구' });
    const only = await r.add(deck, 'amgi Listening', { [t.at.cue]: '', [t.at.target]: '고맙습니다' });
    const q = LISTENING(deck, r);
    const plan = await r.plan(deck, q);
    assert.deepEqual([ids(plan.body), plan.body.upToDate, plan.body.skipped], [[note, only].sort((x, y) => x - y), 0, 0]);
    assert.equal((await r.fill(note, q)).status, 200);
    const fields = (await r.note(note)).fields;
    assert.equal(fields[t.at.targetaudio], `<audio src="${clipName('안녕 친구', 'ko')}"></audio>`, 'Target in the learning language');
    assert.equal(fields[t.at.cueaudio], `<audio src="${clipName('hello there', 'en')}"></audio>`, 'Cue in the known language');
    assert.equal(r.fake.of('speech').length, 2);
    // a note with no Cue has only its Target read
    assert.equal((await r.fill(only, q)).status, 200);
    const one = (await r.note(only)).fields;
    assert.deepEqual([one[t.at.targetaudio], one[t.at.cueaudio]], [`<audio src="${clipName('고맙습니다', 'ko')}"></audio>`, '']);
    assert.equal(r.fake.of('speech').length, 3);
    const settled = await r.plan(deck, q);
    assert.deepEqual([ids(settled.body), settled.body.upToDate], [[], 2], 'a side with no text is not a gap');
    // the card's reference form is <audio> whatever the request says
    assert.equal((await r.plan(deck, { ...q, form: 'sound' })).body.upToDate, 2);

    // the starter deck's clips are mp3, recorded once and shipped: the same text in the same language, so no new recording
    const built = await r.ask('POST', 'starter', 'starter_built', ['q_starter', { known: 'en', learning: 'ko', name: 'Starter' }]);
    assert.equal(built.status, 200, JSON.stringify(built.body));
    const calls = r.fake.requests.length;
    const starter = await r.plan(built.body.deckId, LISTENING(built.body.deckId, r));
    assert.deepEqual([starter.status, ids(starter.body), starter.body.upToDate, starter.body.skipped], [200, [], 10, 0], JSON.stringify(starter.body));
    const listed = await r.ask('GET', `decks/${built.body.deckId}/notes`, 'notes');
    assert.match(listed.body.notes[0].fields[t.at.targetaudio], /^<audio src="amgi-[0-9a-f]{20}\.mp3"><\/audio>$/);
    assert.equal(r.fake.requests.length, calls);
    // a clip the starter note lost is a gap again
    const first = listed.body.notes[0];
    const fields0 = first.fields.slice();
    fields0[t.at.cueaudio] = '';
    assert.equal((await r.ask('PATCH', `notes/${first.id}`, 'note_changed', ['q_note_update', { fields: fields0, language: 'ko' }])).status, 200);
    const gap = await r.plan(built.body.deckId, LISTENING(built.body.deckId, r));
    assert.deepEqual([ids(gap.body), gap.body.upToDate], [[first.id], 9]);
    assert.equal((await r.fill(first.id, LISTENING(built.body.deckId, r))).status, 200);
    assert.equal(r.fake.of('speech').length, 4, 'the lost clip is recorded, as a wav, beside the mp3 that shipped');
    assert.match((await r.note(first.id)).fields[t.at.cueaudio], /^<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>$/);
});

test('a note with someone else\'s audio is not filled at all, per side for the Listening type, and amgi\'s own clips beside it do not change that', async () => {
    const r = await rig();
    const deck = await r.deck('Foreign');
    const basic = BASIC(deck, r);
    const soundTag = await r.add(deck, 'Basic', ['하나', '[sound:theirs.mp3]']);
    const element = await r.add(deck, 'Basic', ['둘', '<audio src="theirs.wav"></audio>']);
    const both = await r.add(deck, 'Basic', ['셋', `[sound:${clipName('옛날 글', 'ko')}][sound:theirs.mp3]`]);
    const plan = await r.plan(deck, basic);
    assert.deepEqual([ids(plan.body), plan.body.upToDate], [[], 3], 'none is offered; each counts as up to date');
    for (const id of [soundTag, element, both]) {
        const before = await r.note(id);
        assert.equal((await r.fill(id, basic)).status, 200);
        assert.deepEqual(await r.note(id), before, 'untouched');
    }
    assert.equal(r.fake.requests.length, 0, 'Gemini was not asked');

    // the Listening type decides per side: their clip on the Cue side leaves the Cue alone, and the Target still gets amgi's
    const t = r.types['amgi Listening'];
    const note = await r.add(deck, 'amgi Listening', { [t.at.cue]: 'hello', [t.at.target]: '안녕', [t.at.cueaudio]: '[sound:theirs.mp3]' });
    const q = LISTENING(deck, r);
    assert.deepEqual(ids((await r.plan(deck, q)).body), [note]);
    assert.equal((await r.fill(note, q)).status, 200);
    const fields = (await r.note(note)).fields;
    assert.deepEqual([fields[t.at.cueaudio], fields[t.at.targetaudio]], ['[sound:theirs.mp3]', `<audio src="${clipName('안녕', 'ko')}"></audio>`]);
    assert.equal(r.fake.of('speech').length, 1, 'only the Target was recorded');
    assert.deepEqual(ids((await r.plan(deck, q)).body), [], 'then nothing is left');
});

test('Gemini\'s limits leave the note as it was: a limit after the first clip, a limit before starting, the day\'s quota', async () => {
    const script = e2eScript();
    const r = await rig(script);
    const deck = await r.deck('Limits');
    const t = r.types['amgi Listening'];
    const first = await r.add(deck, 'amgi Listening', { [t.at.cue]: 'one', [t.at.target]: '하나' });
    const second = await r.add(deck, 'amgi Listening', { [t.at.cue]: 'two', [t.at.target]: '둘' });
    const q = LISTENING(deck, r);
    const { controlFake } = require('../../helpers/fake-gemini.js');
    await controlFake(r.fake.baseUrl, 'perMinute=1');
    // One speech call is allowed this minute: the Target's clip is made, the Cue's is refused with about a minute to wait, which is
    // longer than the run sits through, so the fill answers 429 at once with the note unchanged
    const limited = await r.fill(first, q);
    assert.deepEqual([limited.status, limited.body.notStarted, limited.body.dailyCap], [429, false, false]);
    assert.ok(limited.body.retryAfterMs >= 40000 && limited.body.retryAfterMs <= 76000, `retryAfterMs ${limited.body.retryAfterMs}`);
    assert.ok(Number(limited.headers.get('retry-after')) >= 40, 'Retry-After says so too');
    assert.deepEqual((await r.note(first)).fields.filter((_, i) => i === t.at.cueaudio || i === t.at.targetaudio), ['', ''], 'the note was not changed');
    // the gate now knows the limit: the next fill is refused before anything starts
    const refused = await r.fill(second, q);
    assert.deepEqual([refused.status, refused.body.notStarted], [429, true]);
    assert.equal(r.fake.of('speech').length, 2, 'refused before starting: not a request more');
    // the clip that was made before the limit is in the media folder, for the retry to reuse
    assert.equal((await r.ask('GET', `media/${clipName('하나', 'ko')}`, null)).status, 200);

    const capped = await rig({ ...e2eScript(), speech: dailyQuotaExhausted() });
    const cdeck = await capped.deck('Capped');
    const note = await capped.add(cdeck, 'Basic', ['안녕', '']);
    const day = await capped.fill(note, BASIC(cdeck, capped));
    assert.deepEqual([day.status, day.body.dailyCap], [429, true]);
    assert.deepEqual((await capped.note(note)).fields, ['안녕', '']);
});

test('without a key nothing is generated, and the plan still answers', async () => {
    const keyless = await startServer({ key: '', base: null });
    stops.push(keyless.stop);
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-fill-keyless-'));
    const base = path.join(top, 'Anki2');
    fs.cpSync(FIXTURE, path.join(base, 'User 1'), { recursive: true });
    fs.mkdirSync(path.join(base, 'addons21'), { recursive: true });
    const headers = {
        'x-amgi-base-dir': encodeURIComponent(base),
        'x-amgi-collection': encodeURIComponent(path.join(base, 'User 1', 'collection.anki2')),
        'x-amgi-profile': encodeURIComponent('User 1'),
    };
    const r = await finish({ ask: asker(keyless.url, headers) });
    const deck = await r.deck('Keyless');
    const note = await r.add(deck, 'Basic', ['안녕', '']);
    assert.deepEqual(ids((await r.plan(deck, BASIC(deck, r))).body), [note]);
    const fill = await r.fill(note, BASIC(deck, r));
    assert.deepEqual([fill.status, /^GEMINI_API_KEY is not set/.test(fill.body.error)], [500, true]);
    assert.deepEqual((await r.note(note)).fields, ['안녕', '']);
});

/** The add-on's real server on a free port over a collection (the bridge's test stand-in for Anki), and a stop(). */
function startBridge(collectionPath, token) {
    const child = spawn(anki.bin, [ENTRY, collectionPath, token, '', '0'], { env: sandboxEnv(), stdio: ['pipe', 'pipe', 'inherit'] });
    const ready = new Promise((resolve, reject) => {
        child.stdout.once('data', (chunk) => {
            const match = /^LISTENING (\d+)/.exec(chunk.toString());
            if (match) resolve(`http://127.0.0.1:${match[1]}`);
            else reject(new Error(`unexpected output starting the bridge: ${chunk}`));
        });
        child.once('error', reject);
    });
    const stop = () => new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end('\n');
    });
    return { ready, stop };
}

test('on the bridge\'s transport, through the add-on\'s real server: the same plan, the same fill, the same bytes', { skip: !anki && 'needs the Anki library' }, async () => {
    const dir = tempDir('amgi-fill-bridge-');
    const collection = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collection);
    const token = 'fill-bridge-token';
    const bridge = startBridge(collection, token);
    stops.push(bridge.stop);
    const url = await bridge.ready;
    const fake = await fakeGemini(e2eScript());
    const app = await startServer({ key: 'fake', base: fake.baseUrl });
    stops.push(app.stop, fake.close);
    const r = await finish({ ask: asker(app.url, { 'x-amgi-bridge-url': encodeURIComponent(url), 'x-amgi-bridge-token': token }) });
    const deck = await r.deck('Bridged');
    const a = await r.add(deck, 'Basic', ['안녕하세요', '']);
    const b = await r.add(deck, 'Basic', ['감사합니다', '<img src="x.jpg">']);
    const q = BASIC(deck, r);
    const plan = await r.plan(deck, q);
    assert.deepEqual([plan.status, plan.body.mode, ids(plan.body), plan.body.upToDate, plan.body.skipped], [200, 'bridge', [a, b].sort((x, y) => x - y), 0, 0]);
    assert.equal(fake.requests.length, 0);
    const done = await r.fill(a, q);
    assert.deepEqual([done.status, done.body.mode, done.body.noteId], [200, 'bridge', a]);
    assert.deepEqual((await r.note(a)).fields, ['안녕하세요', `[sound:${clipName('안녕하세요', 'ko')}]`]);
    assert.equal((await r.fill(b, { ...q, form: 'html' })).status, 200);
    assert.deepEqual((await r.note(b)).fields, ['감사합니다', `<img src="x.jpg"><audio src="${clipName('감사합니다', 'ko')}"></audio>`]);
    assert.equal((await r.ask('GET', `media/${clipName('안녕하세요', 'ko')}`, null)).status, 200, 'the clip is in the add-on\'s media folder');
    const calls = fake.requests.length;
    assert.equal((await r.fill(a, q)).status, 200);
    assert.equal(fake.requests.length, calls, 'a note that has its clip asks Gemini nothing');
    const settled = await r.plan(deck, q);
    assert.deepEqual([ids(settled.body), settled.body.upToDate], [[b], 1], 'b has its clip, but as <audio>, where this plan asks for [sound:]');
    assert.deepEqual([ids((await r.plan(deck, { ...q, form: 'html' })).body), (await r.plan(deck, { ...q, form: 'html' })).body.upToDate], [[a], 1]);
    assert.equal((await r.plan(987654321, BASIC(987654321, r))).status, 404);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the command line ----

/** Runs the binary with `env`; resolves with its exit code and both streams. Async, so the fake keeps answering. */
function amgi(env, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(AMGI, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('amgi audio fill: the Listening notes, then another note type\'s fields, idempotent, and the stops', async () => {
    let capped = false;
    const script = e2eScript();
    const speech = script.speech;
    script.speech = (body, index, model) => {
        if (capped) return dailyQuotaExhausted();
        return speech(body, index, model);
    };
    const fake = await fakeGemini(script, { control: script.control });
    stops.push(fake.close);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-fill-cli-'));
    const env = sandboxEnv({ AMGI_STATE_DIR: state, GEMINI_API_KEY: 'test-key', GEMINI_API_BASE: fake.baseUrl });
    const profile = path.join(env.HOME, 'Library', 'Application Support', 'Anki2', 'User 1');
    fs.cpSync(FIXTURE, profile, { recursive: true });
    const up = await amgi(env, ['up', '--port', '0']);
    assert.equal(up.code, 0, up.stderr);
    stops.push(async () => { await amgi(env, ['down']); });
    const port = Number(/port=(\d+)/.exec(up.stdout)[1]);
    const headers = { 'x-amgi-collection': encodeURIComponent(path.join(profile, 'collection.anki2')), 'x-amgi-profile': encodeURIComponent('User 1') };
    const r = await finish({ ask: asker(`http://127.0.0.1:${port}`, headers) });
    const run = (...args) => amgi(env, args);
    assert.equal((await run('install')).code, 0);
    await finish(r);

    // no pair: a usage error, naming the sentence, and nothing asked
    assert.equal((await run('deck', 'add', 'Bare')).code, 0);
    const bare = await run('audio', 'fill', '--deck', 'Bare');
    assert.equal(bare.code, 4);
    assert.match(bare.stderr, /This deck has no languages yet/);
    assert.equal((await run('audio', 'fill', '--deck', 'Nope')).code, 3);
    assert.equal((await run('audio', 'fill')).code, 4);
    assert.equal((await run('audio', 'fill', '--deck', 'Bare', '--notetype', 'Basic')).code, 4, 'the fields come together');
    assert.equal((await run('audio', 'fill', '--deck', 'Bare', '--side', 'known')).code, 4);

    // amgi notes need no options
    assert.equal((await run('deck', 'add', 'Fill', '--from', 'en', '--to', 'ko')).code, 0);
    assert.equal((await run('card', 'add', '--deck', 'Fill', '--front', 'hello', '--back', '안녕')).code, 0);
    assert.equal((await run('card', 'add', '--deck', 'Fill', '--front', 'thanks', '--back', '고마워')).code, 0);
    const first = await run('audio', 'fill', '--deck', 'Fill');
    assert.equal(first.code, 0, first.stderr);
    const lines = first.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.split('\t')[0]), ['filled', 'filled', 'audio-fill']);
    assert.equal(lines[2], 'audio-fill\t2\t0\t0\t0');
    const listed = await run('card', 'list', '--deck', 'Fill');
    for (const row of listed.stdout.trimEnd().split('\n')) {
        const [, , , , cueAudio, targetAudio] = row.split('\t');
        assert.match(cueAudio, /^<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>$/);
        assert.match(targetAudio, /^<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>$/);
    }
    assert.equal(fake.of('speech').length, 4);
    // a second run fills nothing, and asks Gemini nothing
    const second = await run('audio', 'fill', '--deck', 'Fill');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, 'audio-fill\t0\t2\t0\t0\n');
    assert.equal(fake.of('speech').length, 4);

    // another note type: its fields by name
    const basic = await r.deck('Basic words');
    const a = await r.add(basic, 'Basic', ['안녕하세요', '']);
    const withFields = await run('audio', 'fill', '--deck', 'Basic words', '--notetype', 'Basic', '--text-field', 'Front', '--audio-field', 'Back', '--form', 'sound');
    assert.equal(withFields.code, 0, withFields.stderr);
    assert.equal(withFields.stdout, `filled\t${a}\naudio-fill\t1\t0\t0\t0\n`);
    assert.deepEqual((await r.note(a)).fields, ['안녕하세요', `[sound:${clipName('안녕하세요', 'ko')}]`]);
    const noField = await run('audio', 'fill', '--deck', 'Basic words', '--notetype', 'Basic', '--text-field', 'Front', '--audio-field', 'Nope');
    assert.equal(noField.code, 3);
    assert.match(noField.stderr, /has no field named "Nope"; its fields are: Front Back/);
    // the known side: the same fields, the deck's other language
    const english = await r.deck('English words');
    const known = await r.add(english, 'Basic', ['Good morning', '']);
    const knownRun = await run('audio', 'fill', '--deck', 'English words', '--notetype', 'Basic', '--text-field', 'Front', '--audio-field', 'Back', '--side', 'known');
    assert.equal(knownRun.code, 0, knownRun.stderr);
    assert.equal(knownRun.stdout, `filled\t${known}\naudio-fill\t1\t0\t0\t0\n`);
    assert.deepEqual((await r.note(known)).fields, ['Good morning', `[sound:${clipName('Good morning', 'en')}]`]);

    // the day's quota stops the run, with the exit Gemini's failures have, and the notes done stay done
    capped = true;
    const more = await r.add(basic, 'Basic', ['잘 자요', '']);
    const stopped = await run('audio', 'fill', '--deck', 'Basic words', '--notetype', 'Basic', '--text-field', 'Front', '--audio-field', 'Back', '--side', 'learning');
    assert.equal(stopped.code, 5);
    assert.match(stopped.stderr, /the day's quota is spent/);
    assert.deepEqual((await r.note(more)).fields, ['잘 자요', '']);
    assert.equal((await amgi(env, ['down'])).code, 0);
    fs.rmSync(state, { recursive: true, force: true });
});

/** A stand-in for the server that answers the routes `amgi audio fill` calls as `script` says: { fills: noteId -> [answers in order] }, an answer being [status, kind, body]. */
async function standIn(script) {
    const http = await import('node:http');
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const send = (status, kind, value, headers = {}) => {
            res.writeHead(status, { 'content-type': WIRE_MIME, ...headers });
            res.end(Buffer.from(encode(kind, value)));
        };
        const url = req.url;
        if (url === '/api/anki/decks') return send(200, 'decks', { mode: 'direct', decks: [{ id: 7, name: 'Stub', noteCount: 3, known: 'en', learning: 'ko' }] });
        if (url === '/api/anki/notetypes') {
            return send(200, 'notetypes', { mode: 'direct', notetypes: [{ id: 5, name: 'amgi Listening', fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'], sortFieldIndex: 0 }] });
        }
        if (url === '/api/anki/decks/7/audio-plan') {
            seen.push({ url, q: decode('q_fill', body) });
            return send(200, 'fill_plan', { mode: 'direct', toFill: script.toFill.map((id) => ({ id })), upToDate: 4, skipped: 1 });
        }
        const fill = /^\/api\/anki\/notes\/(\d+)\/audio-fill$/.exec(url);
        if (fill) {
            const id = Number(fill[1]);
            seen.push({ url, at: Date.now(), q: decode('q_fill', body) });
            const next = script.fills[id]?.shift();
            if (!next) return send(500, 'error', { error: `no answer scripted for note ${id}` }); // asked more often than the test expects
            const [status, kind, value, headers] = next;
            return send(status, kind, value, headers);
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stops.push(() => new Promise((resolve) => server.close(resolve)));
    return { port: server.address().port, seen };
}

test('amgi audio fill waits as the server asks, goes on past a note that failed, and stops on the day\'s quota', async () => {
    // a real server for the pid file's process (the CLI checks it is amgi), and the stand-in on the port the pid file names
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-fill-standin-'));
    const env = sandboxEnv({ AMGI_STATE_DIR: state });
    const profile = path.join(env.HOME, 'Library', 'Application Support', 'Anki2', 'User 1');
    fs.cpSync(FIXTURE, profile, { recursive: true });
    const up = await amgi(env, ['up', '--port', '0']);
    assert.equal(up.code, 0, up.stderr);
    stops.push(async () => { await amgi(env, ['down']); });
    const ok = [200, 'note_changed', { mode: 'direct', noteId: 0 }];
    const gone = [500, 'error', { error: 'audio generation failed' }];
    const wait = [429, 'error', { error: 'Gemini is limiting how many requests it takes per minute', retryAfterMs: 300, maxWaitMs: 180000 }, { 'retry-after': '1' }];
    const cap = [429, 'error', { error: 'the day is spent', dailyCap: true, retryAfterMs: 300 }]; // the quota is the day's: a wait is no answer to it
    const pointAt = (port) => {
        const file = path.join(state, 'amgi.pid');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^port\t\d+$/m, `port\t${port}`));
    };

    const stub = await standIn({ toFill: [11, 12, 13], fills: { 11: [ok], 12: [wait, ok], 13: [gone] } });
    pointAt(stub.port);
    const run = await amgi(env, ['audio', 'fill', '--deck', 'Stub']);
    assert.deepEqual(run.stdout.trimEnd().split('\n'), ['filled\t11', 'filled\t12', 'failed\t13\taudio generation failed', 'audio-fill\t2\t4\t1\t1']);
    assert.equal(run.code, 5, 'a note Gemini could not make a clip for: the exit Gemini\'s failures have');
    assert.match(run.stderr, /waiting 300ms as Gemini's rate gate asks, then trying again/);
    const twelve = stub.seen.filter((s) => s.url.endsWith('/12/audio-fill'));
    assert.equal(twelve.length, 2, 'the same note was asked again');
    assert.ok(twelve[1].at - twelve[0].at >= 290, `after the wait: ${twelve[1].at - twelve[0].at} ms`);
    for (const s of stub.seen) assert.deepEqual(s.q, { deckId: 7, notetypeId: 5, side: 'both', form: 'html' }, 'the Listening notes, both sides, as <audio>');

    const capped = await standIn({ toFill: [21, 22, 23], fills: { 21: [ok], 22: [cap], 23: [ok] } });
    pointAt(capped.port);
    const stopped = await amgi(env, ['audio', 'fill', '--deck', 'Stub']);
    assert.equal(stopped.code, 5);
    assert.equal(stopped.stdout, 'filled\t21\n', 'the note done stays done, and the summary is not printed for a run that did not finish');
    assert.match(stopped.stderr, /the day's quota is spent \(dailyCap\)/);
    assert.deepEqual(capped.seen.filter((s) => s.url.includes('/audio-fill')).map((s) => s.url.match(/notes\/(\d+)/)[1]), ['21', '22'], 'the third note was never asked');
    assert.equal((await amgi(env, ['down'])).code, 0);
    fs.rmSync(state, { recursive: true, force: true });
});
