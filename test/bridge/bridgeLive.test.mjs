// The bridge protocol end to end: the server's bridge client (server/collection/bridge.c)
// against the add-on's real HTTP server (bridge_server.py) and its real operations (bridge_ops.py)
// on a real Anki collection, every route of it, in amgi's wire format both ways. The one stand-in is
// the dispatcher: .claude/skills/e2e-ui/scripts/bridge_server_entry.py calls bridge_ops directly,
// where inside Anki bridge_dispatch.py runs the same calls through Anki's operation queue (aqt is
// not installed here; test_bridge_dispatch.py covers that hop with a stand-in for aqt).
//
// Then the version check: an add-on in another protocol, and one old enough to speak JSON, are both
// the bridge-outdated mode, with its "press Install into Anki again" message.
//
// Needs the anki library (ANKI_PYTHON_BIN, as the other collection tests); skipped without it. The
// client is driven through server/build/collection_cli (test/parity/bridge-under-test.mjs).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  BridgeError, PROTOCOL_HEADER, closeBridgesUnderTest, probeBridgeUnderTest as probeBridge, resolveTransportUnderTest as resolveTransport,
} from '../parity/bridge-under-test.mjs';
import { BRIDGE_PROTOCOL, WIRE_MIME, decode, encode } from '../../ui/wire/wire.mjs';

const require = createRequire(import.meta.url);
const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('../../plusaudio/test/collection/helpers/anki-python');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
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

after(closeBridgesUnderTest);

maybe(`the bridge protocol against the real add-on server and a real collection`, () => {
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
    // KNOWN QUIRK, reported to amgi (2026-11-08): the client escapes a media name in the path
    // (encodeURIComponent) and the add-on does not decode it, so a stored name that needs escaping
    // (a space, Korean, '#', '%') reads as not there. Pinned so both clients escape the same way;
    // when the add-on is fixed, these two assertions flip.
    const named = await ops.addMedia('클립 #1 & 100%.wav', Buffer.from('escaped'));
    assert.equal(named, '클립 #1 & 100%.wav');
    assert.equal(await ops.hasMedia(named), false, 'known quirk: the add-on reads the escaped name as it is');
    assert.equal(await ops.readMedia(named), null, 'known quirk: the same for its bytes');
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
    // A refusal carries the add-on's own sentence (its b_error), not just its status.
    const said = (status) => (error) => error instanceof BridgeError && error.status === status
      && error.message.length > 0 && error.message !== `bridge responded ${status}`;
    await assert.rejects(ops.deckRemovalSummary(existing.id), said(404));
    await assert.rejects(ops.addNote({ deckId: made.deck.id, notetypeId: basic.id, fields: ['only one'], tags: [] }), said(400));
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

describe(`an add-on in another protocol`, () => {
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

  test('one old enough to speak JSON is the bridge-outdated mode (whose message, to install again, the HTTP contract holds)', async () => {
    const old = await fakeAddon(200, { 'Content-Type': 'application/json' }, '{"collectionOpen":true}');
    try {
      assert.ok((await probeBridge(old.url, TOKEN)).outdated);
      const result = await resolveTransport(settings(old.url));
      assert.equal(result.mode, 'bridge-outdated');
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

  test('one with no profile open is bridge-no-collection, with its status', async () => {
    const none = await fakeAddon(200, { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL) },
      encode('b_status', { profileOpen: false, profileName: '', collectionOpen: false, ankiVersion: '26.09.4', qtVersion: '6.9' }));
    try {
      const result = await resolveTransport(settings(none.url));
      assert.equal(result.mode, 'bridge-no-collection');
      assert.equal(result.detail.collectionOpen, false);
      assert.equal(result.detail.ankiVersion, '26.09.4');
      assert.equal('schemaVersion' in result.detail, false, 'no schema with no collection');
    } finally {
      await none.close();
    }
  });

  test('an answer that is not a whole message of its kind is a 502', async () => {
    const status = encode('b_status', { profileOpen: true, profileName: 'p', collectionOpen: true, schemaVersion: 18, ankiVersion: 'a', qtVersion: 'q' });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL) });
      res.end(req.url === '/status' ? status : status.subarray(0, 7));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const probed = await probeBridge(`http://127.0.0.1:${server.address().port}`, TOKEN);
      await assert.rejects(probed.ops.listDecks(), (error) => error instanceof BridgeError && error.status === 502
        && error.message === "the bridge's answer is not a whole b_decks message");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a bridge that went away: the ops say fetch failed, and the transport falls back to the file', async () => {
    const gone = await fakeAddon(200, { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL) },
      encode('b_status', { profileOpen: true, profileName: 'p', collectionOpen: true, schemaVersion: 18, ankiVersion: 'a', qtVersion: 'q' }));
    const probed = await probeBridge(gone.url, TOKEN);
    await gone.close();
    await assert.rejects(probed.ops.listDecks(), (error) => !(error instanceof BridgeError) && error.message === 'fetch failed');
    assert.equal((await resolveTransport(settings(gone.url))).mode, 'unconfigured');
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

describe(`a slow add-on: reads wait 1500 ms, writes the add-on's 30000`, () => {
  test('a read that takes 2 s is aborted, a write that takes 2 s lands', async () => {
    const headers = { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL) };
    const server = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, headers);
        res.end(encode('b_status', { profileOpen: true, profileName: 'slow', collectionOpen: true, schemaVersion: 18, ankiVersion: 'x', qtVersion: 'y' }));
        return;
      }
      req.resume();
      setTimeout(() => {
        res.writeHead(200, headers);
        res.end(req.url === '/decks' && req.method === 'POST'
          ? encode('b_deck_created', { deck: { id: 1794169279580, name: 'Slow' }, created: true })
          : encode('b_decks', { decks: [] }));
      }, 2000);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const probed = await probeBridge(`http://127.0.0.1:${server.address().port}`, TOKEN);
      assert.ok(probed?.ops, 'the status answers at once');
      const started = Date.now();
      await assert.rejects(probed.ops.listDecks(), (error) => error.message === 'This operation was aborted');
      const waited = Date.now() - started;
      assert.ok(waited >= 1400 && waited < 1950, `the read gave up at 1500 ms (${waited})`);
      assert.deepEqual(await probed.ops.createDeck('Slow'), { deck: { id: 1794169279580, name: 'Slow' }, created: true }, 'the write waited');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe(`the token on the wire, as fetch sends it (${BRIDGE_IMPL})`, () => {
  /** A stand-in add-on that answers only the token `wanted`, and remembers every token it got. */
  async function tokenAddon(wanted) {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['x-amgi-bridge-token']);
      const ok = req.headers['x-amgi-bridge-token'] === wanted;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': WIRE_MIME, [PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL) });
      res.end(ok ? encode('b_status', { profileOpen: true, profileName: 'p', collectionOpen: true, schemaVersion: 18, ankiVersion: 'a', qtVersion: 'q' })
        : encode('b_error', { error: 'invalid token' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  test('a token with CR, LF or NUL, or past U+00FF, is refused before anything is sent: no header is injected', async () => {
    const addon = await tokenAddon('tok');
    try {
      for (const token of ['tok\r\nX-Evil: 1', 'a\nb', 'a\0b', 'ㄱ', 'tokㄱ']) {
        assert.equal(await probeBridge(addon.url, token), null, JSON.stringify(token));
      }
      assert.deepEqual(addon.seen, [], 'the add-on saw no request at all');
    } finally {
      await addon.close();
    }
  });

  test('a URL loses its tabs and line breaks before it is used, as the URL parser drops them', async () => {
    const addon = await tokenAddon('tok');
    try {
      const url = addon.url.replace('127.0.0.1', '127.0.\r\n0.1');
      assert.ok((await probeBridge(`${url}/\t`, 'tok'))?.ops, 'the cleaned URL answers');
      assert.deepEqual(addon.seen, ['tok'], 'one request, nothing injected');
    } finally {
      await addon.close();
    }
  });

  test('a token is trimmed of HTTP whitespace and sent as Latin-1 bytes', async () => {
    const plain = await tokenAddon('tok');
    const latin = await tokenAddon('é');
    try {
      assert.ok((await probeBridge(plain.url, ' \ttok\r\n'))?.ops, 'the trimmed token answers');
      assert.ok((await probeBridge(plain.url, '\r\ntok'))?.ops, 'a line break at the start is trimmed, not refused');
      assert.deepEqual(plain.seen, ['tok', 'tok']);
      assert.ok((await probeBridge(latin.url, 'é'))?.ops, 'é goes as the one byte 0xE9');
      assert.deepEqual(latin.seen, ['é']);
    } finally {
      await plain.close();
      await latin.close();
    }
  });
});

