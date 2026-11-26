// amgi's wire format end to end, through every walker over wire.c's one schema:
//   the server's writer (ui/wire/wire.mjs encode, over ui/out/wire.wasm)
//   -> the app's reader (wire_decode, built natively as ui/out/wire_dump), field for field
//   -> the app's writer (wire_encode), which must give back the same bytes
//   -> the server's reader (decode), which must give back the object.
// And no cut-short or overlong message reads as a whole one. Run ui/build.sh first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { sandboxEnv } from '../repo/sandbox-home.cjs';
import { fileURLToPath } from 'node:url';
import { KIND, decode, encode } from '../../ui/wire/wire.mjs';

const dump = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'out', 'wire_dump');
const read = (bytes) => execFileSync(dump, { env: sandboxEnv(), input: bytes }).toString();

function refusesCutShort(bytes) {
    for (let n = 0; n < bytes.length; n++) {
        assert.equal(spawnSync(dump, { env: sandboxEnv(), input: bytes.subarray(0, n) }).stdout.toString(), 'bad\n', `prefix of ${n} bytes`);
    }
    assert.equal(spawnSync(dump, { env: sandboxEnv(), input: Buffer.concat([bytes, Buffer.from([0])]) }).stdout.toString(), 'bad\n', 'one byte too many');
}

test('every kind in the schema is one the server can name', () => {
    assert.deepEqual(Object.keys(KIND).slice(0, 3), ['error', 'status', 'decks']);
    assert.equal(Object.keys(KIND).length, 52);
    assert.equal(KIND.b_q_media, 44, 'the kinds that were there keep their numbers');
    assert.equal(KIND.progress, 45, 'a new one goes at the end');
    assert.deepEqual([KIND.note, KIND.b_note_read, KIND.q_deck_languages, KIND.deck_languages, KIND.b_deck_languages], [46, 47, 48, 49, 50]);
    assert.equal(KIND.deck_languages_found, 51, 'a new one goes at the end');
});

test('bytes (the bridge\'s media): any octets, as the app reads them, and back the same', () => {
    const bytes = encode('b_media_data', { found: true, data: Buffer.from([0, 1, 255, 10, 0x22]) });
    assert.equal(read(bytes), 'kind=b_media_data\nfound=1\ndata=0x0001ff0a22\nrewritten=same\n');
    assert.deepEqual(decode('b_media_data', bytes), { found: true, data: Buffer.from([0, 1, 255, 10, 0x22]) });
    assert.match(read(encode('b_media_data', { found: false })), /^kind=b_media_data\nfound=0\ndata=0x\n/, 'missing bytes are none');
    refusesCutShort(bytes);
});

test('decks: ids past 2^32, UTF-8 names, counts, each deck\'s language pair; the app writes back the same bytes', () => {
    const bytes = encode('decks', { mode: 'direct', decks: [
      { id: 1, name: 'Default', noteCount: 0 },
      { id: 1794149693370, name: '한국어::일상 표현', noteCount: 2, known: 'en', learning: 'ko' },
    ] });
    assert.equal(read(bytes), 'kind=decks\nmode=direct\ndecks=2\ndecks.0.id=1\ndecks.0.name=Default\ndecks.0.noteCount=0\ndecks.0.known=\ndecks.0.learning=\n'
      + 'decks.1.id=1794149693370\ndecks.1.name=한국어::일상 표현\ndecks.1.noteCount=2\ndecks.1.known=en\ndecks.1.learning=ko\nrewritten=same\n');
    refusesCutShort(bytes);
});

test('a deck\'s languages: the request, and the answer that says what is stored', () => {
    const q = encode('q_deck_languages', { known: 'en', learning: 'zh_cn' });
    assert.equal(read(q), 'kind=q_deck_languages\nknown=en\nlearning=zh_cn\nrewritten=same\n');
    refusesCutShort(q);
    const f = encode('deck_languages_found', { mode: 'direct', id: 1794149693370, stored: true, known: 'en', learning: 'ko', foundBy: 'notes' });
    assert.equal(read(f), 'kind=deck_languages_found\nmode=direct\nid=1794149693370\nstored=1\nknown=en\nlearning=ko\nfoundBy=notes\nrewritten=same\n');
    assert.deepEqual(decode('deck_languages_found', encode('deck_languages_found', { mode: 'direct', id: 7 })),
      { mode: 'direct', id: 7, stored: false, known: '', learning: '', foundBy: '' }, 'a guess with nothing to guess from');
    const a = encode('deck_languages', { mode: 'bridge', id: 1794149693370, known: 'ko', learning: 'en' });
    assert.equal(read(a), 'kind=deck_languages\nmode=bridge\nid=1794149693370\nknown=ko\nlearning=en\nrewritten=same\n');
    refusesCutShort(a);
});

test('notes: lists of strings inside a list', () => {
    const bytes = encode('notes', { mode: 'bridge', notes: [{ id: 1794095498270, notetypeId: 1794095498266,
      fields: ['역이 어디예요?', '<audio src="a.wav"></audio>', ''], tags: [] }], offset: 20, limit: 20, hasMore: true });
    assert.equal(read(bytes), 'kind=notes\nmode=bridge\nnotes=1\nnotes.0.id=1794095498270\nnotes.0.notetypeId=1794095498266\n'
      + 'notes.0.fields=[역이 어디예요?|<audio src="a.wav"></audio>|]\nnotes.0.tags=[]\noffset=20\nlimit=20\nhasMore=1\nrewritten=same\n');
    refusesCutShort(bytes);
});

test('error: the 429 shape, and a mode the table does not know', () => {
    const bytes = encode('error', { error: 'Gemini is rate limited', retryAfterMs: 41500.4, notStarted: true, maxWaitMs: 180000 });
    assert.equal(read(bytes), 'kind=error\nmode=\nerror=Gemini is rate limited\nretryAfterMs=41500\nnotStarted=1\ndailyCap=0\nmaxWaitMs=180000\nrewritten=same\n');
    assert.match(read(encode('error', { mode: 'locked', error: 'e', dailyCap: true })), /mode=locked\nerror=e\nretryAfterMs=4294967295\nnotStarted=0\ndailyCap=1\n/);
    assert.match(read(encode('status', { mode: 'from-the-future' })), /^kind=status\nmode=\n/);
    refusesCutShort(bytes);
});

test('a list that claims more items than its bytes could hold is refused at once', () => {
    const head = Buffer.alloc(9);
    head.writeUInt32LE(0x32574d41, 0); // the magic
    head.writeUInt8(KIND.field_values, 4);
    head.writeUInt8(0, 5); // mode
    // values: 2^31 strings in 3 bytes; walking them would take minutes
    const bytes = Buffer.concat([head.subarray(0, 6), Buffer.from([0, 0, 0, 0x80]), Buffer.from('abc')]);
    const r = spawnSync(dump, { env: sandboxEnv(), input: bytes, timeout: 5000 });
    assert.equal(r.stdout.toString(), 'bad\n');
    assert.equal(decode('q_note_update', Buffer.concat([Buffer.from([0x41, 0x4d, 0x57, 0x32, KIND.q_note_update, 0xff, 0xff, 0xff, 0x7f])])), null);
});

test('deck summary and deck removed: what deleting a deck takes, and what it took', () => {
    const summary = encode('deck_summary', { mode: 'bridge', id: 1794149693370, name: '한국어', subdecks: 1, cards: 6, notes: 4 });
    assert.equal(read(summary), 'kind=deck_summary\nmode=bridge\nid=1794149693370\nname=한국어\nsubdecks=1\ncards=6\nnotes=4\nrewritten=same\n');
    refusesCutShort(summary);
    const removed = encode('deck_removed', { mode: 'direct', id: 1794149693370, name: '한국어', decks: 2, cards: 6, notes: 4 });
    assert.equal(read(removed), 'kind=deck_removed\nmode=direct\nid=1794149693370\nname=한국어\ndecks=2\ncards=6\nnotes=4\nrewritten=same\n');
    refusesCutShort(removed);
    const one = encode('note', { mode: 'direct', id: 1794149693370, notetypeId: 1794095498266, fields: ['역이 어디예요?', 'b'], tags: ['amgi'] });
    assert.equal(read(one), 'kind=note\nmode=direct\nid=1794149693370\nnotetypeId=1794095498266\nfields=[역이 어디예요?|b]\ntags=[amgi]\nrewritten=same\n');
    refusesCutShort(one);
});

test('card text: nested keys (audio.reference)', () => {
    const bytes = encode('card_text', { mode: 'direct', front_text: 'Where is the station?', back_text: '역이 어디예요?',
      audio: { filename: 't.wav', reference: '<audio src="t.wav"></audio>' }, cueAudio: { filename: 'c.wav', reference: 'r' } });
    assert.match(read(bytes), /audio\.filename=t\.wav\naudio\.reference=<audio src="t\.wav"><\/audio>\ncueAudio\.filename=c\.wav\ncueAudio\.reference=r\n/);
});

test('progress: a list of cards, each with its step, its take, its wait and its sides', () => {
    const bytes = encode('progress', { cards: [{ id: 4294967295, step: 11, take: 3, takes: 3, waitMs: 1200, frontText: 'apple', backText: '사과' }] });
    assert.deepEqual(decode('progress', bytes), { cards: [{ id: 4294967295, step: 11, take: 3, takes: 3, waitMs: 1200, frontText: 'apple', backText: '사과' }] });
    assert.match(read(bytes), /^kind=progress\n[\s\S]*사과[\s\S]*rewritten=same\n$/);
    refusesCutShort(bytes);
});

test('install state: a null upToDate stays unknown', () => {
    assert.match(read(encode('install_state', { installed: true, upToDate: null, collectionChecked: true, collectionStale: ['a', 'b'] })),
      /installed=1\nupToDate=2\ncollectionChecked=1\ncollectionStale=\[a\|b\]\nready=0\n/);
});

test('requests: the server reads back what was written, absent fields left out', () => {
    const note = { deckId: 1794149693370, notetypeId: 1794149714776, fields: ['a', '', '역', ''], tags: ['x'], language: 'ko', learningFieldIndex: 2 };
    assert.deepEqual(decode('q_note', encode('q_note', note)), note);
    const bare = { deckId: 1, notetypeId: 2, fields: [], tags: [], language: '' };
    assert.deepEqual(decode('q_note', encode('q_note', bare)), bare); // no learningFieldIndex: none comes back
    const bulk = { notes: [note, { ...note, fields: ['b'] }] };
    assert.deepEqual(decode('q_notes', encode('q_notes', bulk)), bulk);
    assert.deepEqual(decode('q_card_text', encode('q_card_text', { userInput: '안녕', deckId: 1794149693370, includeCueAudio: true })),
      { userInput: '안녕', deckId: 1794149693370, includeCueAudio: true, progressId: 0 }, 'no progressId is 0: a card nobody watches');
    const bytes = encode('q_notes', bulk);
    assert.equal(decode('q_notes', bytes.subarray(0, bytes.length - 1)), null);
    assert.equal(decode('q_note', bytes), null); // the wrong kind
    assert.equal(read(bytes).split('\n').at(-2), 'rewritten=same');
});
