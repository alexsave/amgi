// The bridge protocol end to end: the server's bridge client (src/server/anki/bridgeClient.js)
// against the add-on's real HTTP server (bridge_server.py) and its real operations (bridge_ops.py)
// on a real Anki collection, every route of it, in amgi's wire format both ways. The one stand-in is
// the dispatcher: .claude/skills/e2e-ui/scripts/bridge_server_entry.py calls bridge_ops directly,
// where inside Anki bridge_dispatch.py runs the same calls through Anki's operation queue (aqt is
// not installed here; test_bridge_dispatch.py covers that hop with a stand-in for aqt).
//
// Then the version check: an add-on in another protocol, and one old enough to speak JSON, are both
// the bridge-outdated mode, with its "press Install into Anki again" message.
//
// Needs the anki library (ANKI_PYTHON_BIN, as the other collection tests); skipped without it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BridgeError, PROTOCOL_HEADER, probeBridge } from '../../server/anki/bridgeClient';
import { resolveTransport } from '../../server/anki/transport';
import { notReadyResponse } from '../../server/anki/respond';
import { ANSWER } from '../../server/anki/answer';
import { BRIDGE_PROTOCOL, WIRE_MIME, decode, encode } from '../../../ui/server/wire.mjs';

const require = createRequire(import.meta.url);
const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('../../../plusaudio/test/collection/helpers/anki-python');

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ENTRY = path.join(ROOT, '.claude', 'skills', 'e2e-ui', 'scripts', 'bridge_server_entry.py');
const TOKEN = 'live-bridge-token';
const maybe = anki ? describe : describe.skip;

/** The add-on's server on a free port over `collectionPath`; resolves to its URL and a stop(). */
function startBridge(collectionPath) {
  const child = spawn(anki.bin, [ENTRY, collectionPath, TOKEN, '', '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
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

maybe('the bridge protocol against the real add-on server and a real collection', () => {
  let dir;
  let collectionPath;
  let bridge;
  let base;
  let ops;

  before(async () => {
    dir = tempDir('amgi-bridge-live-');
    collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    bridge = startBridge(collectionPath);
    base = await bridge.ready;
    const probed = await probeBridge(base, TOKEN);
    assert.ok(probed?.ops, 'the bridge answers in this protocol');
    ops = probed.ops;
    assert.equal(probed.status.collectionOpen, true);
    assert.equal(probed.status.profileName, 'e2e-fixture');
    assert.equal(typeof probed.status.schemaVersion, 'number');
  });

  after(async () => {
    await bridge?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every route, read and written through the wire both ways', async () => {
    const decks = await ops.listDecks();
    const existing = decks.find((d) => d.name === 'Existing');
    assert.ok(existing && decks.some((d) => d.name === 'Existing::Child'), decks.map((d) => d.name).join(', '));

    const basic = (await ops.listNotetypes()).find((n) => n.name === 'Basic');
    assert.deepEqual(basic.fieldNames, ['Front', 'Back']);
    assert.equal(basic.kind, 'normal');
    assert.equal(basic.sortFieldIndex, 0);
    assert.match(basic.templates[0].questionFormat, /\{\{Front\}\}/);
    assert.match(basic.templates[0].answerFormat, /\{\{Back\}\}/);

    const made = await ops.createDeck('한국어::여행');
    assert.equal(made.created, true);
    assert.equal(made.deck.name, '한국어::여행');
    assert.ok(made.deck.id > 2 ** 32, 'an Anki id past 2^32 survives');
    assert.deepEqual(await ops.createDeck('한국어::여행'), { ...made, created: false }, 'finding it again creates nothing');

    const one = await ops.addNote({ deckId: made.deck.id, notetypeId: basic.id, fields: ['역이 어디예요?', 'Where is the station?\nline two'], tags: ['amgi'] });
    assert.ok(one.noteId > 0);
    assert.equal('warning' in one, false, 'no warning is no key');
    const bulk = await ops.addNotesBulk([
      { deckId: made.deck.id, notetypeId: basic.id, fields: ['감사합니다', 'Thank you'], tags: [] },
      { deckId: made.deck.id, notetypeId: 999, fields: ['x', 'y'], tags: [] },
      { deckId: made.deck.id, notetypeId: basic.id, fields: ['안녕하세요', 'Hello'], tags: [], language: 'ko', learningFieldIndex: 0 },
    ]);
    assert.deepEqual(bulk.map((r) => r.ok), [true, false, true], 'one bad note never aborts the rest');
    assert.match(bulk[1].error, /999|note ?type/i);

    const page = await ops.listNotesInDeck(made.deck.id, { offset: 0, limit: 2 });
    assert.equal(page.total, 3);
    assert.deepEqual([page.offset, page.limit, page.notes.length], [0, 2, 2]);
    assert.deepEqual(page.notes[0].fields, ['역이 어디예요?', 'Where is the station?\nline two']);
    assert.deepEqual(page.notes[0].tags, ['amgi']);
    assert.equal(await ops.countNotesInDeck(made.deck.id), 3);
    assert.deepEqual((await ops.existingFieldValues(made.deck.id, basic.id, 0)).sort(), ['감사합니다', '안녕하세요', '역이 어디예요?']);

    const changed = await ops.updateNote(one.noteId, ['yeogi eodiyeyo', 'Where?'], 'ko', 0);
    assert.equal(changed.noteId, one.noteId);
    assert.match(changed.warning, /romanised/, 'the romanisation guard still answers through the wire');

    const clip = Buffer.from([0, 1, 2, 255, 0x0a, 0x22, 0x7b, 0, 128]);
    assert.equal(await ops.hasMedia('live-clip.wav'), false);
    const stored = await ops.addMedia('live-clip.wav', clip);
    assert.equal(await ops.hasMedia(stored), true);
    assert.deepEqual(await ops.readMedia(stored), clip, 'a clip comes back byte for byte');
    assert.equal(await ops.readMedia('not-there.wav'), null);

    assert.deepEqual(await ops.renameDeck(made.deck.id, '한국어::여행 2'), { id: made.deck.id, name: '한국어::여행 2' });

    const removed = await ops.removeNote(bulk[0].noteId);
    assert.deepEqual(removed, { noteId: bulk[0].noteId, cardsRemoved: 1 });

    const summary = await ops.deckRemovalSummary(existing.id);
    assert.deepEqual(summary, { id: existing.id, name: 'Existing', subdecks: 1, cards: 1, notes: 1 });
    const gone = await ops.removeDeck(existing.id);
    assert.deepEqual(gone, { id: existing.id, name: 'Existing', decks: 2, cards: 1, notes: 1 });
    await assert.rejects(ops.deckRemovalSummary(existing.id), (error) => error instanceof BridgeError && error.status === 404);
    await assert.rejects(ops.addNote({ deckId: made.deck.id, notetypeId: basic.id, fields: ['only one'], tags: [] }),
      (error) => error instanceof BridgeError && error.status === 400);
  });

  test('what the bridge wrote is in the collection, as Anki reads it', async () => {
    await bridge.stop();
    bridge = null;
    const out = withAnkiLibrary(collectionPath, `
names = sorted(d.name for d in col.decks.all_names_and_ids())
print("|".join(names))
print(col.media.have("live-clip.wav"))
print(len(col.find_notes("")))
`);
    const [names, media, notes] = out.trim().split('\n');
    assert.equal(names, 'Default|한국어|한국어::여행 2');
    assert.equal(media, 'True');
    assert.equal(notes, '2', 'the three added, less the one removed; the Existing note went with its deck');
    bridge = startBridge(collectionPath);
    base = await bridge.ready;
  });

  test('a request in another protocol is refused with the message to install again', async () => {
    const response = await fetch(`${base}/status`, { headers: { 'X-Amgi-Bridge-Token': TOKEN, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL + 1) } });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get(PROTOCOL_HEADER), String(BRIDGE_PROTOCOL));
    assert.equal(response.headers.get('content-type'), WIRE_MIME);
    const error = decode('b_error', new Uint8Array(await response.arrayBuffer()));
    assert.match(error.error, /press Install into Anki again/);
    const none = await fetch(`${base}/status`, { headers: { 'X-Amgi-Bridge-Token': TOKEN } });
    assert.equal(none.status, 409, 'and so is one that names none');
  });

  test('a body that is not a whole message of its kind is a 400, and JSON is not one', async () => {
    const headers = { 'X-Amgi-Bridge-Token': TOKEN, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL), 'Content-Type': WIRE_MIME };
    const cut = encode('q_deck_name', { name: 'Cut short' }).subarray(0, 9);
    assert.equal((await fetch(`${base}/decks`, { method: 'POST', headers, body: cut })).status, 400);
    const json = await fetch(`${base}/decks`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(json.status, 400);
    assert.match(decode('b_error', new Uint8Array(await json.arrayBuffer())).error, /application\/x-amgi-wire/);
  });
});

describe('an add-on in another protocol', () => {
  /** A stand-in add-on that answers every request with `status`, `headers` and `body`. */
  async function fakeAddon(status, headers, body) {
    const server = http.createServer((req, res) => {
      res.writeHead(status, headers);
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const settings = (url) => ({ baseDirOverride: '', collectionPath: '', profileName: '', bridge: { baseUrl: url, token: TOKEN } });

  test('one old enough to speak JSON is the bridge-outdated mode, with the message to install again', async () => {
    const old = await fakeAddon(200, { 'Content-Type': 'application/json' }, '{"collectionOpen":true}');
    try {
      assert.ok((await probeBridge(old.url, TOKEN)).outdated);
      const result = await resolveTransport(settings(old.url));
      assert.equal(result.mode, 'bridge-outdated');
      assert.match(notReadyResponse(result.mode)[ANSWER].error, /Install into Anki again/);
    } finally {
      await old.close();
    }
  });

  test('a newer one that refuses this server\'s protocol is the same mode', async () => {
    const newer = await fakeAddon(409, { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL + 1) },
      encode('b_error', { error: 'this amgi add-on speaks bridge protocol 2' }));
    try {
      assert.equal((await resolveTransport(settings(newer.url))).mode, 'bridge-outdated');
    } finally {
      await newer.close();
    }
  });

  test('an old add-on that refuses the token is not called outdated: nothing is known of its version', async () => {
    const refusing = await fakeAddon(401, { 'Content-Type': 'application/json' }, '{"error":"bad token"}');
    try {
      assert.equal(await probeBridge(refusing.url, TOKEN), null);
    } finally {
      await refusing.close();
    }
  });
});
