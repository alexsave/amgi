// The Anki bridge add-on's Python side of the wire format (anki/addon/amgi_bridge/bridge_wire.py)
// against the server's (ui/server/wire.mjs, over wire.wasm): one schema, two walkers, the same bytes.
//   - the add-on's wire_schema.py is exactly what ui/wire/wire_py.c writes from wire.c, so the
//     Python never holds a layout of its own;
//   - every message the server writes, the add-on reads and writes back byte for byte, for every
//     kind the bridge carries, and the other way round.
// Run ui/build.sh first (it builds ui/out/wire_py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KIND, decode, encode } from '../wire/wire.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ADDON = path.join(ROOT, 'anki', 'addon', 'amgi_bridge');

test('the add-on\'s wire_schema.py is what wire_py.c writes from wire.c', () => {
  const generated = execFileSync(path.join(ROOT, 'ui', 'out', 'wire_py'), { encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(ADDON, 'wire_schema.py'), 'utf8'), generated,
    'run ui/build.sh and commit anki/addon/amgi_bridge/wire_schema.py');
});

// Python reads each (kind, message) and writes it again: records of u8 name length, name, u32 length,
// bytes in; u32 length, bytes out (or 0xffffffff when it refused the message).
const ROUND_TRIP = `
import struct, sys
sys.path.insert(0, sys.argv[1])
import bridge_wire
data, at, out = sys.stdin.buffer.read(), 0, bytearray()
while at < len(data):
    n = data[at]; name = data[at + 1:at + 1 + n].decode(); at += 1 + n
    (m,) = struct.unpack_from("<I", data, at); body = data[at + 4:at + 4 + m]; at += 4 + m
    try:
        again = bridge_wire.encode(name, bridge_wire.decode(name, body))
        out += struct.pack("<I", len(again)) + again
    except bridge_wire.WireError:
        out += struct.pack("<I", 0xFFFFFFFF)
sys.stdout.buffer.write(bytes(out))
`;
function throughPython(messages) {
  const input = Buffer.concat(messages.flatMap(([kind, bytes]) => {
    const head = Buffer.alloc(5 + kind.length);
    head.writeUInt8(kind.length, 0);
    head.write(kind, 1, 'latin1');
    head.writeUInt32LE(bytes.length, 1 + kind.length);
    return [head, bytes];
  }));
  const out = execFileSync('python3', ['-I', '-c', ROUND_TRIP, ADDON], { input });
  const answers = [];
  for (let at = 0; at < out.length;) {
    const n = out.readUInt32LE(at);
    if (n === 0xffffffff) { answers.push(null); at += 4; continue; }
    answers.push(out.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return answers;
}

const SAMPLES = {
  b_error: { error: 'this amgi add-on speaks bridge protocol 2: press Install into Anki again' },
  b_status: { profileOpen: true, profileName: '사용자 1', collectionOpen: true, schemaVersion: 18, ankiVersion: '25.09.2', qtVersion: '6.9' },
  b_decks: { decks: [{ id: 1, name: 'Default' }, { id: 1794149693370, name: '한국어::일상 표현' }] },
  b_notetypes: { notetypes: [{ id: 1794095498266, name: 'amgi Listening', kind: 'normal', sortFieldIndex: 2, fieldNames: ['Cue', 'CueAudio', ''],
    templates: [{ ord: 0, name: 'Listen', questionFormat: '{{CueAudio}}\n<script>"x"</script>', answerFormat: '' }] }] },
  b_notes: { notes: [{ id: 1794095498270, notetypeId: 1794095498266, fields: ['역이 어디예요?', '<audio src="a.wav"></audio>'], tags: ['amgi'] }],
    total: 26, offset: 20, limit: 20 },
  b_values: { values: ['a', '', '😀'] },
  b_deck_created: { deck: { id: 1794163006799, name: 'Korean::Travel' }, created: true },
  b_deck: { id: 7, name: 'Renamed' },
  b_note: { noteId: 1794163006800, warning: 'looks fully romanised' },
  b_notes_added: { results: [{ ok: true, noteId: 9 }, { ok: false, error: 'unknown note type 999' }] },
  b_note_removed: { noteId: 9, cardsRemoved: 2 },
  b_deck_summary: { id: 9, name: 'Korean', subdecks: 1, cards: 6, notes: 4 },
  b_deck_removed: { id: 9, name: 'Korean', decks: 2, cards: 6, notes: 4 },
  b_media_exists: { exists: true },
  b_media_data: { found: true, data: Buffer.from([0, 1, 2, 255, 10, 34, 123, 0]) },
  b_media_added: { filename: 'plusaudio-1.wav' },
  b_q_media: { filename: 'clip.wav', data: Buffer.alloc(70000, 7) },
  q_deck_name: { name: '한국어::여행' },
  q_note: { deckId: 1794163006799, notetypeId: 1794095498266, fields: ['a', 'b'], tags: [], language: 'ko', learningFieldIndex: 2 },
  q_notes: { notes: [{ deckId: 1, notetypeId: 2, fields: ['x'], tags: ['t'] }, { deckId: 1, notetypeId: 2, fields: [], tags: [], learningFieldIndex: 0 }] },
  q_note_update: { fields: ['x', 'y'], language: '' },
};

test('every bridge kind the server writes, the add-on reads and writes back byte for byte', () => {
  const bridgeKinds = Object.keys(KIND).filter((k) => k.startsWith('b_'));
  for (const kind of bridgeKinds) assert.ok(kind in SAMPLES, `a sample of ${kind}`);
  const messages = Object.entries(SAMPLES).map(([kind, object]) => [kind, encode(kind, object)]);
  const back = throughPython(messages);
  messages.forEach(([kind, bytes], i) => assert.deepEqual(back[i], bytes, kind));
  // And what the add-on writes, the server reads as the object it meant.
  assert.deepEqual(decode('b_media_data', back[Object.keys(SAMPLES).indexOf('b_media_data')]),
    { found: true, data: SAMPLES.b_media_data.data });
  assert.deepEqual(decode('q_note', back[Object.keys(SAMPLES).indexOf('q_note')]), SAMPLES.q_note);
});

// Messages the add-on writes from its own Python values (as bridge_ops.py builds them), each as
// u32 length and bytes, in this order.
const FROM_PYTHON = `
import struct, sys
sys.path.insert(0, sys.argv[1])
import bridge_wire
out = bytearray()
for kind, value in (
    ("b_deck", {"id": 1794163006799, "name": "한국어"}),
    ("b_status", {"profileOpen": True, "profileName": None, "collectionOpen": False, "schemaVersion": None,
                  "ankiVersion": "25.09.2", "qtVersion": "6.9"}),
    ("b_note_removed", {"noteId": 2 ** 40 + 5, "cardsRemoved": 3}),
    ("b_media_data", {"found": True, "data": bytes([0, 255, 10])}),
    ("b_deck_created", {"deck": {"id": 42, "name": "Korean::Verbs"}, "created": True}),
):
    body = bridge_wire.encode(kind, value)
    out += struct.pack("<I", len(body)) + body
sys.stdout.buffer.write(bytes(out))
`;

test('what the add-on writes from its own values, the server reads as those values', () => {
  const out = execFileSync('python3', ['-I', '-c', FROM_PYTHON, ADDON]);
  const bodies = [];
  for (let at = 0; at < out.length; at += 4 + out.readUInt32LE(at)) bodies.push(out.subarray(at + 4, at + 4 + out.readUInt32LE(at)));
  assert.deepEqual(decode('b_deck', bodies[0]), { id: 1794163006799, name: '한국어' });
  assert.deepEqual(decode('b_status', bodies[1]),
    { profileOpen: true, profileName: '', collectionOpen: false, ankiVersion: '25.09.2', qtVersion: '6.9' }, 'None is "" or absent');
  assert.deepEqual(decode('b_note_removed', bodies[2]), { noteId: 2 ** 40 + 5, cardsRemoved: 3 });
  assert.deepEqual(decode('b_media_data', bodies[3]), { found: true, data: Buffer.from([0, 255, 10]) });
  assert.deepEqual(decode('b_deck_created', bodies[4]), { 'deck.id': 42, 'deck.name': 'Korean::Verbs', created: true });
});

test('the add-on refuses what the server would: short, long, another kind, a list that lies', () => {
  const whole = encode('b_notes', SAMPLES.b_notes);
  const lying = Buffer.from(encode('b_values', { values: [] }));
  lying.writeUInt32LE(0x7fffffff, 5);
  const cases = [
    ['b_notes', whole.subarray(0, whole.length - 1)],
    ['b_notes', Buffer.concat([whole, Buffer.from([0])])],
    ['b_decks', whole],
    ['b_values', lying],
    ['b_values', Buffer.from('{"values":[]}')],
  ];
  for (let n = 0; n < whole.length; n += 7) cases.push(['b_notes', whole.subarray(0, n)]);
  assert.deepEqual(throughPython(cases), cases.map(() => null));
  for (const [kind, bytes] of cases) assert.equal(decode(kind, bytes), null, 'and so does the server');
});
