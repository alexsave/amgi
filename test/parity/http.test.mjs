// HTTP parity: every /api/anki route and every error shape, over real HTTP, against the server
// under test (test/parity/servers.mjs: the Node server by default, AMGI_SERVER=<executable> for
// another), compared with what was recorded from today's Node server in test/parity/expect/http.txt.
//
// What is compared, per request: the status, the headers that are contract (content-type,
// cache-control, retry-after, location, content-length on a clip, and that there is no
// Access-Control-* header at all), and the body byte for byte. A wire answer is first checked to
// be canonical (decoding it by its kind and writing it again gives the same bytes, so nothing
// sits outside the schema), then the parts that differ from run to run are normalised and it is
// written again, and those bytes are what must equal the recording:
//   - ids made during the run (decks, note types, notes) become small numbers by first appearance
//     per kind, the same in every run that makes the same things in the same order;
//   - the temporary Anki folder's path becomes <base>;
//   - retryAfterMs, the rate gate's jittered wait, is checked to lie in its range and becomes 1
//     (the Retry-After header is checked against the real value first).
// The recording also shows each answer decoded, for a person reading a diff.
//
// The Gemini routes run against the tests' fake Gemini (plusaudio/test/helpers/fake-gemini.js),
// each scenario on fresh servers so no rate gate remembers another's limits. The locked case
// holds the collection open with the real Anki library and skips without it (ANKI_PYTHON_BIN).
//
// PARITY_RECORD=1 writes the recording instead of comparing (only from the Node server).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BRIDGE_PROTOCOL, WIRE_MIME, decode, encode } from '../../ui/server/wire.mjs';
import { ROOT, SERVER, startFakeGemini, startServer } from './servers.mjs';

const require = createRequire(import.meta.url);
const { anki, holdCollectionOpen } = require('../../plusaudio/test/collection/helpers/anki-python.js');
const { controlFake } = require('../../plusaudio/test/helpers/fake-gemini.js');

const RECORD = process.env.PARITY_RECORD === '1';
const EXPECT = path.join(ROOT, 'test', 'parity', 'expect', 'http.txt');
const FIXTURES = path.join(ROOT, 'test', 'parity', 'fixtures');

/** The kind each route answers (ui/server/serve.mjs's ROUTES), by method and path pattern. */
const ANSWERS = [
  ['GET', /^status$/, 'status'], ['GET', /^decks$/, 'decks'], ['POST', /^decks$/, 'deck_created'],
  ['PATCH', /^decks\/[^/]+$/, 'deck_renamed'], ['GET', /^decks\/[^/]+$/, 'deck_summary'],
  ['DELETE', /^decks\/[^/]+$/, 'deck_removed'], ['GET', /^decks\/[^/]+\/notes$/, 'notes'],
  ['GET', /^decks\/[^/]+\/notes\/field-values$/, 'field_values'], ['GET', /^install$/, 'install_state'],
  ['POST', /^install$/, 'installed'], ['GET', /^profiles$/, 'profiles'], ['GET', /^notetypes$/, 'notetypes'],
  ['POST', /^notes$/, 'note_added'], ['POST', /^notes\/bulk$/, 'notes_added'], ['PATCH', /^notes\/[^/]+$/, 'note_changed'],
  ['DELETE', /^notes\/[^/]+$/, 'note_changed'], ['POST', /^card-text$/, 'card_text'], ['POST', /^audio$/, 'clip'],
  ['GET', /^starter$/, 'starter_state'], ['POST', /^starter$/, 'starter_built'],
];
function answerKind(method, apiPath) {
  const hit = ANSWERS.find(([m, re]) => m === method && re.test(apiPath));
  return hit ? hit[2] : null;
}

/** Which kind of id a field is, by its key (and for "id", the list it is in or the answer kind). */
function idKind(key, list, kind) {
  if (key === 'noteId') return 'N';
  if (key === 'notetypeId') return 'M';
  if (key === 'deckId' || key === 'deck.id') return 'D';
  if (key === 'id') {
    if (list === 'notes') return 'N';
    if (list === 'notetypes') return 'M';
    if (list === 'decks') return 'D';
    if (['deck_renamed', 'deck_summary', 'deck_removed'].includes(kind)) return 'D';
  }
  return null;
}

/** The run's normaliser: ids made during it by first appearance per kind, paths, jitter. */
function normaliser() {
  const since = Date.now();
  const maps = { D: new Map(), M: new Map(), N: new Map() };
  const BASE = { D: 10_000_000, M: 20_000_000, N: 30_000_000 };
  const made = (v) => typeof v === 'number' && v >= since;
  const id = (k, v) => {
    if (!made(v)) return v;
    const map = maps[k];
    if (!map.has(v)) map.set(v, BASE[k] + map.size + 1);
    return map.get(v);
  };
  const text = (s, bases) => {
    let out = s;
    for (const b of bases) out = out.split(b).join('<base>');
    return out.replace(/\d{12,}/g, (d) => {
      const v = Number(d);
      if (!made(v)) return d;
      for (const k of ['D', 'M', 'N']) if (maps[k].has(v)) return String(maps[k].get(v));
      return '<T>';
    });
  };
  const walk = (value, kind, bases, list = null) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, kind, bases, list));
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const ik = idKind(k, list, kind);
        if (ik && typeof v === 'number') out[k] = id(ik, v);
        else if (Array.isArray(v)) out[k] = walk(v, kind, bases, k);
        else out[k] = walk(v, kind, bases, list);
      }
      return out;
    }
    if (typeof value === 'string') return text(value, bases);
    return value;
  };
  return { walk, text };
}

/** A decoded answer as one readable line. */
function show(value) {
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${k}=${show(v)}`).join(' ')}}`;
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
  return String(value);
}

/** decode gives a dotted key ("deck.id") as one flat key; encode reads it nested. */
function nest(flat) {
  if (Array.isArray(flat)) return flat.map(nest);
  if (!flat || typeof flat !== 'object' || flat instanceof Uint8Array) return flat;
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts.at(-1)] = nest(v);
  }
  return out;
}
const reencode = (kind, flat) => encode(kind, nest(flat));

const CONTRACT_HEADERS = ['content-type', 'cache-control', 'retry-after', 'location'];

let norm;
const recorded = [];
let expected = null;

/**
 * One request, checked against the recording. `body` is [kind, object] for a wire body, or
 * {raw, type} for anything else. Answers the decoded object (with real ids) for the next steps.
 */
async function call(ctx, name, method, url, { headers = {}, body, bases = [], jitter } = {}) {
  const u = new URL(url, ctx.server);
  let payload;
  const h = { ...headers };
  if (Array.isArray(body)) {
    payload = encode(body[0], body[1]);
    h['content-type'] ??= WIRE_MIME;
  } else if (body) {
    payload = body.raw;
    if (body.type) h['content-type'] = body.type;
  }
  const response = await fetch(u, { method, headers: h, body: payload, redirect: 'manual' });
  const bytes = Buffer.from(await response.arrayBuffer());
  const lines = [`== ${name}`, `> ${method} ${norm.text(`${u.pathname}${u.search}`, [])}`];
  const head = [String(response.status)];
  for (const k of CONTRACT_HEADERS) {
    const v = response.headers.get(k);
    if (v === null) continue;
    if (k === 'retry-after' && jitter) {
      head.push(`${k}=<checked>`);
      continue;
    }
    head.push(`${k}=${v}`);
  }
  const cors = [...response.headers.keys()].filter((k) => k.startsWith('access-control-'));
  assert.deepEqual(cors, [], `${name}: no Access-Control-* header at all`);
  lines.push(`< ${head.join(' ')}`);
  let decoded = null;
  const type = response.headers.get('content-type') || '';
  if (type.startsWith(WIRE_MIME)) {
    const apiPath = u.pathname.replace(/^\/api\/anki\//, '');
    const kind = response.status >= 400 ? 'error' : answerKind(method, apiPath);
    assert.ok(kind, `${name}: a wire answer from a route with a kind`);
    decoded = decode(kind, bytes);
    assert.ok(decoded, `${name}: the body is one whole ${kind} message`);
    assert.equal(reencode(kind, decoded).toString('hex'), bytes.toString('hex'), `${name}: the ${kind} answer is canonical`);
    let shown = decoded;
    if (jitter) {
      const [lo, hi] = jitter;
      assert.ok(decoded.retryAfterMs >= lo && decoded.retryAfterMs <= hi,
        `${name}: retryAfterMs ${decoded.retryAfterMs} in [${lo}, ${hi}]`);
      assert.equal(response.headers.get('retry-after'), String(Math.max(1, Math.ceil(decoded.retryAfterMs / 1000))),
        `${name}: Retry-After is the wait in whole seconds`);
      // The message names the same jittered wait in seconds.
      shown = { ...decoded, retryAfterMs: 1, error: decoded.error.replace(/\b\d+s\b/g, '<n>s') };
    }
    shown = norm.walk(shown, kind, bases);
    lines.push(`< ${kind} ${show(shown)}`, `< bytes ${reencode(kind, shown).toString('hex')}`);
  } else if (ctx.files?.[u.pathname]) {
    // A built page file: the same bytes as on disk, whatever the build made of it this time.
    assert.ok(bytes.equals(fs.readFileSync(ctx.files[u.pathname])), `${name}: the body is ${ctx.files[u.pathname]}`);
    lines.push(`< the bytes of ${path.relative(ROOT, ctx.files[u.pathname])}`);
  } else {
    if (u.pathname.startsWith('/api/anki/media/') && response.status === 200) {
      lines.push(`< content-length=${response.headers.get('content-length')}`);
    }
    lines.push(`< raw ${show(bytes.toString('latin1'))}`);
  }
  recorded.push(...lines);
  if (!RECORD) {
    const at = expected.indexOf(`== ${name}`);
    assert.ok(at >= 0, `${name}: recorded (PARITY_RECORD=1 from the Node server)`);
    const want = expected.slice(at, at + lines.length);
    assert.deepEqual(lines, want, `${name}: the same answer as recorded`);
  }
  return { status: response.status, decoded, bytes };
}

/** A fixture copy as profile "User 1" under a fresh Anki folder; the headers that point at it. */
function profile(schema = '18', folderName = 'Anki2') {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-http-'));
  const base = path.join(top, folderName);
  fs.cpSync(path.join(FIXTURES, `schema${schema}`), path.join(base, 'User 1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'addons21'), { recursive: true });
  const collection = path.join(base, 'User 1', 'collection.anki2');
  return {
    top, base, collection,
    headers: {
      'x-amgi-base-dir': encodeURIComponent(base),
      'x-amgi-collection': encodeURIComponent(collection),
      'x-amgi-profile': encodeURIComponent('User 1'),
    },
  };
}

/** A stand-in Anki add-on answering every request with `status`, `headers` and `body`. */
async function fakeAddon(status, headers, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const ids = (decks) => Object.fromEntries(decks.map((d) => [d.name, d.id]));

before(() => {
  norm = normaliser();
  if (!RECORD) {
    assert.ok(fs.existsSync(EXPECT), `${EXPECT} is recorded (PARITY_RECORD=1 from the Node server)`);
    expected = fs.readFileSync(EXPECT, 'utf8').split('\n');
  }
});

after(() => {
  if (RECORD) {
    fs.mkdirSync(path.dirname(EXPECT), { recursive: true });
    fs.writeFileSync(EXPECT, `${recorded.join('\n')}\n`);
  }
});

describe(`HTTP parity${SERVER ? ` (${path.basename(SERVER)})` : ' (Node)'}`, { concurrency: false }, () => {
  const ctx = {};
  const stops = [];
  before(async () => {
    const app = await startServer();
    stops.push(app.stop);
    ctx.server = app.url;
    const out = path.join(ROOT, 'ui', 'out');
    ctx.files = {
      '/decks': path.join(out, 'index.html'), '/settings': path.join(out, 'index.html'),
      '/deck/1794169279580': path.join(out, 'index.html'), '/app.wasm': path.join(out, 'app.wasm'),
      '/app.css': path.join(out, 'app.css'), '/favicon.ico': path.join(ROOT, 'public', 'favicon.ico'),
      '/favicon.svg': path.join(ROOT, 'public', 'favicon.svg'),
    };
  });
  after(async () => {
    for (const s of stops) await s();
  });

  test('the page and its files, and what is not there', async () => {
    await call(ctx, 'root redirects', 'GET', '/');
    for (const p of ['/decks', '/settings', '/deck/1794169279580', '/app.wasm', '/app.css', '/favicon.ico', '/favicon.svg']) {
      await call(ctx, `page ${p}`, 'GET', p);
    }
    for (const p of ['/deck/1/notes', '/nope', '/sub/favicon.ico', '/app.js', '/public/favicon.ico', '/decks/']) {
      await call(ctx, `not a page ${p}`, 'GET', p);
    }
  });

  test('routes that are not there, and bodies that are not wire messages', async () => {
    const p = profile();
    const h = p.headers;
    await call(ctx, 'unknown api route', 'GET', '/api/anki/nope', { headers: h });
    await call(ctx, 'too deep', 'GET', '/api/anki/decks/1/notes/field-values/x', { headers: h });
    await call(ctx, 'api root', 'GET', '/api/anki/', { headers: h });
    await call(ctx, 'a method with no layout', 'PUT', '/api/anki/decks', { headers: h });
    await call(ctx, 'POST on a GET route', 'POST', '/api/anki/profiles', { headers: h });
    await call(ctx, 'a preflight', 'OPTIONS', '/api/anki/decks', {
      headers: { ...h, origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    await call(ctx, 'body as text/plain', 'POST', '/api/anki/decks', { headers: h, body: { raw: 'name=x', type: 'text/plain' } });
    await call(ctx, 'body with no type', 'POST', '/api/anki/decks', { headers: h, body: { raw: encode('q_deck_name', { name: 'x' }) } });
    await call(ctx, 'body not wire', 'POST', '/api/anki/decks', { headers: h, body: { raw: 'garbage', type: WIRE_MIME } });
    await call(ctx, 'body of another kind', 'POST', '/api/anki/decks', { headers: h, body: ['q_install', { baseDirOverride: 'x' }] });
    const whole = encode('q_deck_name', { name: 'x' });
    await call(ctx, 'body with bytes after it', 'POST', '/api/anki/decks', { headers: h, body: { raw: Buffer.concat([whole, Buffer.from([0])]), type: WIRE_MIME } });
    await call(ctx, 'body cut short', 'POST', '/api/anki/decks', { headers: h, body: { raw: whole.subarray(0, whole.length - 1), type: WIRE_MIME } });
    await call(ctx, 'empty body', 'POST', '/api/anki/decks', { headers: h, body: { raw: Buffer.alloc(0), type: WIRE_MIME } });
    await call(ctx, 'wire type with parameters', 'POST', '/api/anki/decks', { headers: h, body: { raw: encode('q_deck_name', { name: 'Typed' }), type: `${WIRE_MIME}; charset=binary` } });
    await call(ctx, 'a malformed escape in the path', 'GET', '/api/anki/media/%E0%A4%A', { headers: h });
  });

  test('a cross-origin page gets no permission', async () => {
    const p = profile();
    const evil = { ...p.headers, origin: 'http://evil.example' };
    await call(ctx, 'cross-origin GET', 'GET', '/api/anki/decks', { headers: evil });
    await call(ctx, 'cross-origin POST', 'POST', '/api/anki/decks', { headers: evil, body: ['q_deck_name', { name: 'From elsewhere' }] });
    await call(ctx, 'cross-origin page', 'GET', '/decks', { headers: { origin: 'http://evil.example' } });
  });

  test('the transport modes: status always answers, every other route says why it cannot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-http-modes-'));
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(path.join(dir, 'old.anki2'));
    old.exec('CREATE TABLE col (id integer primary key, ver integer); INSERT INTO col VALUES (1, 5);');
    old.close();
    const cases = {
      unconfigured: {},
      'not-found': { 'x-amgi-collection': encodeURIComponent(path.join(dir, 'missing.anki2')) },
      'unsupported-schema': { 'x-amgi-collection': encodeURIComponent(path.join(dir, 'old.anki2')) },
      'malformed escape': { 'x-amgi-collection': '%E0%A4%A' },
    };
    for (const [mode, headers] of Object.entries(cases)) {
      for (const [m, u, body] of [
        ['GET', '/api/anki/status'], ['GET', '/api/anki/decks'], ['POST', '/api/anki/decks', ['q_deck_name', { name: 'x' }]],
        ['GET', '/api/anki/decks/1'], ['DELETE', '/api/anki/decks/2'], ['GET', '/api/anki/notetypes'],
        ['GET', '/api/anki/decks/1/notes'], ['GET', '/api/anki/decks/1/notes/field-values?notetypeId=1&fieldIndex=0'],
        ['POST', '/api/anki/notes', ['q_note', { deckId: 1, notetypeId: 1, fields: ['a', 'b'] }]],
        ['POST', '/api/anki/notes/bulk', ['q_notes', { notes: [] }]], ['PATCH', '/api/anki/notes/1', ['q_note_update', { fields: [] }]],
        ['DELETE', '/api/anki/notes/1'], ['GET', '/api/anki/media/clip.ogg'],
        ['POST', '/api/anki/card-text', ['q_card_text', { userInput: 'x', knownLanguage: 'en', learningLanguage: 'ko' }]],
        ['POST', '/api/anki/audio', ['q_audio', { text: 'x', language: 'ko' }]],
        ['POST', '/api/anki/starter', ['q_starter', { known: 'en', learning: 'ko' }]],
      ]) {
        await call(ctx, `${mode}: ${m} ${u}`, m, u, { headers, body, bases: [dir] });
      }
    }
  });

  test('the bridge: an add-on in another protocol (older and newer), one with no profile open, one not answering', async () => {
    const p = profile();
    const token = 'tok';
    const older = await fakeAddon(200, { 'Content-Type': 'application/json' }, '{"collectionOpen":true}');
    const newer = await fakeAddon(409, { 'Content-Type': WIRE_MIME, 'X-Amgi-Bridge-Protocol': String(BRIDGE_PROTOCOL + 1) },
      encode('b_error', { error: `this amgi add-on speaks bridge protocol ${BRIDGE_PROTOCOL + 1}` }));
    const closed = await fakeAddon(200, {}, '');
    await closed.close();
    const noProfile = await fakeAddon(200, { 'Content-Type': WIRE_MIME, 'X-Amgi-Bridge-Protocol': String(BRIDGE_PROTOCOL) },
      encode('b_status', { profileOpen: false, profileName: '', collectionOpen: false, ankiVersion: '26.09.4', qtVersion: '6.9' }));
    const open = await fakeAddon(200, { 'Content-Type': WIRE_MIME, 'X-Amgi-Bridge-Protocol': String(BRIDGE_PROTOCOL) },
      encode('b_status', { profileOpen: true, profileName: 'User 1', collectionOpen: true, schemaVersion: 18, ankiVersion: '26.09.4', qtVersion: '6.9' }));
    try {
      for (const [name, url, withCollection] of [
        ['older add-on', older.url, true], ['newer add-on', newer.url, true], ['no profile open', noProfile.url, false],
        ['not answering, collection set', closed.url, true], ['not answering, no collection', closed.url, false],
        ['answering', open.url, false],
      ]) {
        const headers = {
          ...(withCollection ? p.headers : {}),
          'x-amgi-bridge-url': encodeURIComponent(url), 'x-amgi-bridge-token': token,
        };
        const bases = [url.replace('http://', ''), p.base];
        await call(ctx, `bridge ${name}: status`, 'GET', '/api/anki/status', { headers, bases });
        if (name !== 'answering') await call(ctx, `bridge ${name}: decks`, 'GET', '/api/anki/decks', { headers, bases });
      }
      await call(ctx, 'bridge token without url', 'GET', '/api/anki/status', { headers: { ...p.headers, 'x-amgi-bridge-token': token } });
    } finally {
      await older.close();
      await newer.close();
      await noProfile.close();
      await open.close();
    }
  });

  for (const schema of ['18', '11']) {
    test(`the collection routes, schema ${schema}`, async () => {
      const p = profile(schema);
      const h = p.headers;
      const bases = [p.base];
      const s = (n) => `s${schema} ${n}`;
      await call(ctx, s('status'), 'GET', '/api/anki/status', { headers: h, bases });
      const listed = await call(ctx, s('decks'), 'GET', '/api/anki/decks', { headers: h, bases });
      const decks = ids(listed.decoded.decks);
      const nts = (await call(ctx, s('notetypes'), 'GET', '/api/anki/notetypes', { headers: h, bases })).decoded.notetypes;
      const basic = nts.find((n) => n.name === 'Basic').id;
      const ex = decks.Existing;

      for (const q of ['', '?offset=2&limit=2', '?offset=-5', '?limit=0', '?limit=500', '?limit=abc&offset=x', '?offset=1.5&limit=2.5', '?limit=1']) {
        await call(ctx, s(`notes ${q}`), 'GET', `/api/anki/decks/${ex}/notes${q}`, { headers: h, bases });
      }
      await call(ctx, s('notes of a deck not there'), 'GET', '/api/anki/decks/999/notes', { headers: h, bases });
      await call(ctx, s('notes of a deck id not a number'), 'GET', '/api/anki/decks/abc/notes', { headers: h, bases });
      for (const q of [`?notetypeId=${basic}&fieldIndex=0`, `?notetypeId=${basic}&fieldIndex=1`, '', '?notetypeId=abc&fieldIndex=0',
        `?notetypeId=${basic}&fieldIndex=1.5`, `?notetypeId=${basic}`, `?notetypeId=${basic}&fieldIndex=9`]) {
        await call(ctx, s(`field values ${q.replaceAll(String(basic), 'Basic')}`), 'GET', `/api/anki/decks/${ex}/notes/field-values${q}`, { headers: h, bases });
      }

      const made = await call(ctx, s('create deck'), 'POST', '/api/anki/decks', { headers: h, bases, body: ['q_deck_name', { name: '  Made::Here  ' }] });
      const madeId = made.decoded['deck.id'];
      await call(ctx, s('create deck that exists'), 'POST', '/api/anki/decks', { headers: h, bases, body: ['q_deck_name', { name: 'made::here' }] });
      await call(ctx, s('create deck, blank name'), 'POST', '/api/anki/decks', { headers: h, bases, body: ['q_deck_name', { name: '   ' }] });
      await call(ctx, s('create deck, no name'), 'POST', '/api/anki/decks', { headers: h, bases, body: ['q_deck_name', {}] });
      await call(ctx, s('rename deck'), 'PATCH', `/api/anki/decks/${madeId}`, { headers: h, bases, body: ['q_deck_name', { name: 'Renamed::Deep' }] });
      await call(ctx, s('rename deck to a taken name'), 'PATCH', `/api/anki/decks/${madeId}`, { headers: h, bases, body: ['q_deck_name', { name: 'Existing' }] });
      await call(ctx, s('rename deck, blank name'), 'PATCH', `/api/anki/decks/${madeId}`, { headers: h, bases, body: ['q_deck_name', { name: ' ' }] });
      await call(ctx, s('rename a deck not there'), 'PATCH', '/api/anki/decks/999', { headers: h, bases, body: ['q_deck_name', { name: 'X' }] });

      const added = await call(ctx, s('add note'), 'POST', '/api/anki/notes', {
        headers: h, bases, body: ['q_note', { deckId: madeId, notetypeId: basic, fields: ['hello', 'world'], tags: ['a', 'b'] }],
      });
      const noteId = added.decoded.noteId;
      await call(ctx, s('add note, romanised'), 'POST', '/api/anki/notes', {
        headers: h, bases, body: ['q_note', { deckId: madeId, notetypeId: basic, fields: ['annyeong', 'hi'], language: 'ko', learningFieldIndex: 0 }],
      });
      await call(ctx, s('add note, no deck'), 'POST', '/api/anki/notes', { headers: h, bases, body: ['q_note', { notetypeId: basic, fields: ['a', 'b'] }] });
      await call(ctx, s('add note, no note type'), 'POST', '/api/anki/notes', { headers: h, bases, body: ['q_note', { deckId: madeId, fields: ['a', 'b'] }] });
      await call(ctx, s('add note, no fields'), 'POST', '/api/anki/notes', { headers: h, bases, body: ['q_note', { deckId: madeId, notetypeId: basic }] });
      await call(ctx, s('add note, unknown note type'), 'POST', '/api/anki/notes', { headers: h, bases, body: ['q_note', { deckId: madeId, notetypeId: 42, fields: ['a', 'b'] }] });
      await call(ctx, s('bulk add'), 'POST', '/api/anki/notes/bulk', {
        headers: h, bases, body: ['q_notes', { notes: [
          { deckId: madeId, notetypeId: basic, fields: ['bulk 1', 'x'] }, { deckId: madeId, notetypeId: basic, fields: ['bad'] },
          { deckId: madeId, notetypeId: basic, fields: ['bulk 3', 'x'], language: 'ja', learningFieldIndex: 0 },
        ] }],
      });
      await call(ctx, s('bulk add, empty'), 'POST', '/api/anki/notes/bulk', { headers: h, bases, body: ['q_notes', { notes: [] }] });
      await call(ctx, s('bulk add, a note with no deck'), 'POST', '/api/anki/notes/bulk', {
        headers: h, bases, body: ['q_notes', { notes: [{ deckId: madeId, notetypeId: basic, fields: ['a', 'b'] }, { notetypeId: basic, fields: ['a', 'b'] }] }],
      });
      await call(ctx, s('edit note'), 'PATCH', `/api/anki/notes/${noteId}`, { headers: h, bases, body: ['q_note_update', { fields: ['hello 2', 'world 2'] }] });
      await call(ctx, s('edit note, romanised'), 'PATCH', `/api/anki/notes/${noteId}`, {
        headers: h, bases, body: ['q_note_update', { fields: ['privet', 'x'], language: 'ru', learningFieldIndex: 0 }],
      });
      await call(ctx, s('edit note, wrong field count'), 'PATCH', `/api/anki/notes/${noteId}`, { headers: h, bases, body: ['q_note_update', { fields: ['one'] }] });
      await call(ctx, s('edit a note not there'), 'PATCH', '/api/anki/notes/999', { headers: h, bases, body: ['q_note_update', { fields: ['a', 'b'] }] });
      await call(ctx, s('notes after the edits'), 'GET', `/api/anki/decks/${madeId}/notes`, { headers: h, bases });
      await call(ctx, s('delete note'), 'DELETE', `/api/anki/notes/${noteId}`, { headers: h, bases });
      await call(ctx, s('delete note again'), 'DELETE', `/api/anki/notes/${noteId}`, { headers: h, bases });

      await call(ctx, s('clip'), 'GET', '/api/anki/media/clip.ogg', { headers: h, bases });
      for (const name of ['nope.wav', '..%2Fclip.ogg', '%2E%2E', 'CLIP.OGG', 'a%5Cb']) {
        await call(ctx, s(`clip ${name}`), 'GET', `/api/anki/media/${name}`, { headers: h, bases });
      }
      fs.writeFileSync(path.join(p.base, 'User 1', 'collection.media', 'Upper.MP3'), 'mp3 bytes');
      fs.writeFileSync(path.join(p.base, 'User 1', 'collection.media', 'x.wav'), 'wav');
      fs.writeFileSync(path.join(p.base, 'User 1', 'collection.media', 'x.m4a'), 'm4a');
      fs.writeFileSync(path.join(p.base, 'User 1', 'collection.media', '노래.ogg'), 'ogg');
      for (const name of ['Upper.MP3', 'x.wav', 'x.m4a', '%EB%85%B8%EB%9E%98.ogg']) {
        await call(ctx, s(`clip type ${name}`), 'GET', `/api/anki/media/${name}`, { headers: h, bases });
      }

      await call(ctx, s('deck summary'), 'GET', `/api/anki/decks/${ex}`, { headers: h, bases });
      await call(ctx, s('deck summary, filtered'), 'GET', `/api/anki/decks/${decks.Filtered}`, { headers: h, bases });
      await call(ctx, s('deck summary, not there'), 'GET', '/api/anki/decks/999', { headers: h, bases });
      await call(ctx, s('deck summary, id not a number'), 'GET', '/api/anki/decks/abc', { headers: h, bases });
      await call(ctx, s('delete Default'), 'DELETE', '/api/anki/decks/1', { headers: h, bases });
      await call(ctx, s('delete filtered'), 'DELETE', `/api/anki/decks/${decks.Filtered}`, { headers: h, bases });
      await call(ctx, s('delete with subdeck'), 'DELETE', `/api/anki/decks/${ex}`, { headers: h, bases });
      await call(ctx, s('delete again'), 'DELETE', `/api/anki/decks/${ex}`, { headers: h, bases });
      await call(ctx, s('decks at the end'), 'GET', '/api/anki/decks', { headers: h, bases });

      // Install, then what it changed, then the starter deck it makes possible.
      await call(ctx, s('install state before'), 'GET', '/api/anki/install', { headers: h, bases });
      await call(ctx, s('install'), 'POST', '/api/anki/install', { headers: h, bases, body: ['q_install', {}] });
      await call(ctx, s('install state after'), 'GET', '/api/anki/install', { headers: h, bases });
      await call(ctx, s('install into a folder not there'), 'POST', '/api/anki/install', {
        headers: h, bases: [...bases, p.top], body: ['q_install', { baseDirOverride: path.join(p.top, 'nowhere') }],
      });
      await call(ctx, s('install state, folder not there'), 'GET', '/api/anki/install', {
        headers: { ...h, 'x-amgi-base-dir': encodeURIComponent(path.join(p.top, 'nowhere')) }, bases: [...bases, p.top],
      });
      await call(ctx, s('starter'), 'POST', '/api/anki/starter', { headers: h, bases, body: ['q_starter', { known: 'en', learning: 'ko' }] });
      await call(ctx, s('starter again'), 'POST', '/api/anki/starter', { headers: h, bases, body: ['q_starter', { known: 'en', learning: 'ko', name: 'amgi starter' }] });
      await call(ctx, s('starter, same languages'), 'POST', '/api/anki/starter', { headers: h, bases, body: ['q_starter', { known: 'ko', learning: 'ko' }] });
      await call(ctx, s('starter, unknown pair'), 'POST', '/api/anki/starter', { headers: h, bases, body: ['q_starter', { known: 'en', learning: 'xx' }] });
      await call(ctx, s('starter, no languages'), 'POST', '/api/anki/starter', { headers: h, bases, body: ['q_starter', {}] });
      await call(ctx, s('starter state'), 'GET', '/api/anki/starter', { headers: h, bases });

      // Generation's own checks, before any Gemini call: missing fields.
      await call(ctx, s('card text, no input'), 'POST', '/api/anki/card-text', { headers: h, bases, body: ['q_card_text', { userInput: '  ', knownLanguage: 'en', learningLanguage: 'ko' }] });
      await call(ctx, s('card text, no language'), 'POST', '/api/anki/card-text', { headers: h, bases, body: ['q_card_text', { userInput: 'x', knownLanguage: 'en' }] });
      await call(ctx, s('audio, no text'), 'POST', '/api/anki/audio', { headers: h, bases, body: ['q_audio', { text: ' ', language: 'ko' }] });
      await call(ctx, s('audio, no language'), 'POST', '/api/anki/audio', { headers: h, bases, body: ['q_audio', { text: 'x' }] });
    });
  }

  test('profiles: the Anki folder, its profiles, and none', async () => {
    const p = profile('18', '앙키 폴더');
    fs.mkdirSync(path.join(p.base, '사용자 2'));
    fs.copyFileSync(p.collection, path.join(p.base, '사용자 2', 'collection.anki2'));
    fs.mkdirSync(path.join(p.base, 'Empty profile'));
    fs.writeFileSync(path.join(p.base, 'prefs21.db'), '');
    const bases = [p.base];
    await call(ctx, 'profiles', 'GET', '/api/anki/profiles', { headers: p.headers, bases });
    await call(ctx, 'profiles, folder not there', 'GET', '/api/anki/profiles', {
      headers: { 'x-amgi-base-dir': encodeURIComponent(path.join(p.top, 'nowhere')) }, bases: [p.top],
    });
  });

  test('a collection Anki holds open: locked, and install still answers', { skip: !anki && 'needs ANKI_PYTHON_BIN' }, async () => {
    const p = profile();
    const holder = holdCollectionOpen(p.collection);
    await holder.held;
    try {
      const bases = [p.base];
      await call(ctx, 'locked: status', 'GET', '/api/anki/status', { headers: p.headers, bases });
      await call(ctx, 'locked: decks', 'GET', '/api/anki/decks', { headers: p.headers, bases });
      await call(ctx, 'locked: add note', 'POST', '/api/anki/notes', { headers: p.headers, bases, body: ['q_note', { deckId: 1, notetypeId: 1, fields: ['a'] }] });
      await call(ctx, 'locked: clip', 'GET', '/api/anki/media/clip.ogg', { headers: p.headers, bases });
      await call(ctx, 'locked: install state', 'GET', '/api/anki/install', { headers: p.headers, bases });
      await call(ctx, 'locked: install', 'POST', '/api/anki/install', { headers: p.headers, bases, body: ['q_install', {}] });
    } finally {
      await holder.release();
    }
    await call(ctx, 'released: status', 'GET', '/api/anki/status', { headers: p.headers, bases: [p.base] });
  });
});

describe(`HTTP parity: Gemini, against the fake${SERVER ? ` (${path.basename(SERVER)})` : ' (Node)'}`, { concurrency: false }, () => {
  test('without a key: the starter deck is offered, and generation says what is missing', async () => {
    const keyless = await startServer({ key: '', base: null });
    try {
      const ctx = { server: keyless.url };
      const p = profile();
      await call(ctx, 'keyless: starter state', 'GET', '/api/anki/starter');
      await call(ctx, 'keyless: card text', 'POST', '/api/anki/card-text', { headers: p.headers, bases: [p.base], body: ['q_card_text', { userInput: 'hello', knownLanguage: 'en', learningLanguage: 'ko' }] });
      await call(ctx, 'keyless: audio', 'POST', '/api/anki/audio', { headers: p.headers, bases: [p.base], body: ['q_audio', { text: '안녕', language: 'ko' }] });
    } finally {
      await keyless.stop();
    }
  });

  test('a card and its clips, then a per-minute limit: started (retryAfterMs), then refused before starting (notStarted)', async () => {
    const fake = await startFakeGemini();
    const app = await startServer({ key: 'fake', base: fake.url });
    try {
      const ctx = { server: app.url };
      const p = profile();
      const h = p.headers;
      const bases = [p.base];
      await call(ctx, 'fake: card text with cue audio', 'POST', '/api/anki/card-text', { headers: h, bases, body: ['q_card_text', { userInput: 'line 7', knownLanguage: 'en', learningLanguage: 'ko', includeCueAudio: true }] });
      await call(ctx, 'fake: card text without', 'POST', '/api/anki/card-text', { headers: h, bases, body: ['q_card_text', { userInput: 'line 8', knownLanguage: 'en', learningLanguage: 'ko' }] });
      const clip = await call(ctx, 'fake: audio', 'POST', '/api/anki/audio', { headers: h, bases, body: ['q_audio', { text: '안녕하세요', language: 'ko' }] });
      await call(ctx, 'fake: audio again, reused', 'POST', '/api/anki/audio', { headers: h, bases, body: ['q_audio', { text: '안녕하세요', language: 'ko' }] });
      await call(ctx, 'fake: audio fresh', 'POST', '/api/anki/audio', { headers: h, bases, body: ['q_audio', { text: '안녕하세요', language: 'ko', fresh: true }] });
      await call(ctx, 'fake: a failing line', 'POST', '/api/anki/card-text', { headers: h, bases, body: ['q_card_text', { userInput: 'broken line', knownLanguage: 'en', learningLanguage: 'ko' }] });
      await call(ctx, 'fake: the clip it made', 'GET', `/api/anki/media/${clip.decoded.filename}`, { headers: h, bases });
      await controlFake(fake.url, 'perMinute=1');
      // One speech call is allowed this minute; the second, the cue clip, is refused with about a
      // minute to wait, longer than the generator sits through: the card answers 429 at once.
      await call(ctx, 'fake: limited after starting', 'POST', '/api/anki/card-text', {
        headers: h, bases, jitter: [40000, 76000], body: ['q_card_text', { userInput: 'line 9', knownLanguage: 'en', learningLanguage: 'ko', includeCueAudio: true }],
      });
      await call(ctx, 'fake: refused before starting', 'POST', '/api/anki/audio', {
        headers: h, bases, jitter: [30000, 76000], body: ['q_audio', { text: '다음', language: 'ko' }],
      });
      await call(ctx, 'fake: card refused before starting', 'POST', '/api/anki/card-text', {
        headers: h, bases, jitter: [30000, 76000], body: ['q_card_text', { userInput: 'line 10', knownLanguage: 'en', learningLanguage: 'ko' }],
      });
    } finally {
      await app.stop();
      await fake.stop();
    }
  });

  test('a spent daily cap: dailyCap, no wait', async () => {
    const fake = await startFakeGemini();
    const app = await startServer({ key: 'fake', base: fake.url });
    try {
      const ctx = { server: app.url };
      const p = profile();
      await controlFake(fake.url, 'daily=1');
      await call(ctx, 'fake: daily cap', 'POST', '/api/anki/card-text', { headers: p.headers, bases: [p.base], body: ['q_card_text', { userInput: 'line 1', knownLanguage: 'en', learningLanguage: 'ko' }] });
      await call(ctx, 'fake: daily cap again', 'POST', '/api/anki/card-text', { headers: p.headers, bases: [p.base], body: ['q_card_text', { userInput: 'line 2', knownLanguage: 'en', learningLanguage: 'ko' }] });
    } finally {
      await app.stop();
      await fake.stop();
    }
  });
});
