// A write through the Anki bridge is sent once, never again on its own: the add-on runs it as a
// CollectionOp the moment it has read it, so a second copy is a second note or a second rename,
// whatever became of the first answer.
//
// The case that would resend one: a client that keeps the connection of an earlier request alive
// and, when a request on that reused connection fails before any byte of an answer, retries it once
// on a fresh one (cbase's cb_http_plain_request does, for every method). The stand-in add-on here
// answers the probe (GET /status) on a kept-alive connection, then reads each write and closes the
// connection without answering. The server under test (test/parity/servers.mjs) must have sent each
// write exactly once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { BRIDGE_PROTOCOL, WIRE_MIME, encode } from '../../ui/wire/wire.mjs';
import { startServer } from './servers.mjs';

const STATUS = encode('b_status', { profileOpen: true, profileName: 'User 1', collectionOpen: true, schemaVersion: 18, ankiVersion: '26.09.4', qtVersion: '6.9' });

/** The stand-in: every request it read, by method and path. */
async function silentWriter() {
  const seen = [];
  const heads = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = pending.subarray(0, end).toString('latin1');
        const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (pending.length < end + 4 + length) return;
        pending = pending.subarray(end + 4 + length);
        const [method, path] = head.split(' ');
        seen.push(`${method} ${path}`);
        heads.push(head);
        if (method === 'GET') {
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: ${WIRE_MIME}\r\nX-Amgi-Bridge-Protocol: ${BRIDGE_PROTOCOL}\r\n`
            + `Content-Length: ${STATUS.length}\r\nConnection: keep-alive\r\n\r\n`);
          socket.write(STATUS);
        } else {
          socket.destroy(); // read, and gone without a word
          return;
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    heads,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(resolve);
    }),
  };
}

let app;
let addon;
before(async () => {
  app = await startServer();
  addon = await silentWriter();
});
after(async () => {
  await app?.stop();
  await addon?.close();
});

for (const [method, path, kind, body] of [
  ['POST', '/api/anki/decks', 'q_deck_name', { name: 'Once' }],
  ['PATCH', '/api/anki/decks/1794170430284', 'q_deck_name', { name: 'Once' }],
  ['DELETE', '/api/anki/notes/1794170430290', null, null],
  ['POST', '/api/anki/notes', 'q_note', { deckId: 1, notetypeId: 2, fields: ['a', 'b'] }],
]) {
  test(`${method} ${path}: the write reaches the add-on once, though its connection dies unanswered`, async () => {
    addon.seen.length = 0;
    const headers = { 'x-amgi-bridge-url': encodeURIComponent(addon.url), 'x-amgi-bridge-token': 'tok' };
    if (kind) headers['content-type'] = WIRE_MIME;
    const response = await fetch(new URL(path, app.url), { method, headers, body: kind ? encode(kind, body) : undefined });
    await response.arrayBuffer();
    const writes = addon.seen.filter((line) => !line.startsWith('GET '));
    assert.equal(writes.length, 1, `sent once, not resent: ${addon.seen.join(', ')}`);
    assert.ok(response.status >= 400, `answered as the failure it is (${response.status})`);
  });
}

// A bridge token or address is the person's setting, percent-decoded from a header, so it can hold
// a line break. Formatted into the request to the add-on, that would be a header of the sender's
// choosing. The client takes them as fetch did (server/collection/bridge.c): a token with a CR, LF
// or NUL is refused before anything is sent, and an address loses its tabs and line breaks as the
// URL parser drops them. Either way no header of the setting's making reaches the add-on.
test('a token or an address with a line break in it writes no header into the request to the add-on', async () => {
  for (const [what, url, token] of [
    ['token', addon.url, 'tok\r\nX-Injected: 1'],
    ['token, a bare LF', addon.url, 'tok\nX-Injected: 1'],
    ['address', `${addon.url}/x\r\nX-Injected: 1`, 'tok'],
  ]) {
    addon.seen.length = 0;
    addon.heads.length = 0;
    for (const [method, path, kind, body] of [['GET', '/api/anki/status'], ['POST', '/api/anki/decks', 'q_deck_name', { name: 'x' }]]) {
      const headers = { 'x-amgi-bridge-url': encodeURIComponent(url), 'x-amgi-bridge-token': encodeURIComponent(token) };
      if (kind) headers['content-type'] = WIRE_MIME;
      const response = await fetch(new URL(path, app.url), { method, headers, body: kind ? encode(kind, body) : undefined });
      await response.arrayBuffer();
    }
    assert.deepEqual(addon.heads.filter((h) => /\r\nx-injected/i.test(h)), [], `${what}: no header of the setting's making`);
    if (what !== 'address') assert.deepEqual(addon.seen, [], `${what}: a refused token sends nothing at all`);
  }
});

// HTTP whitespace around a token is not part of it: fetch trims a header value's leading and trailing
// tabs and spaces, so a token pasted with a stray tab or space still reaches the add-on, as itself.
test('a token with a trailing tab or a leading space is sent, trimmed', async () => {
  for (const token of ['tok\t', ' tok', '\ttok \t']) {
    addon.seen.length = 0;
    addon.heads.length = 0;
    const headers = { 'x-amgi-bridge-url': encodeURIComponent(addon.url), 'x-amgi-bridge-token': encodeURIComponent(token) };
    const response = await fetch(new URL('/api/anki/status', app.url), { headers });
    await response.arrayBuffer();
    assert.deepEqual(addon.seen, ['GET /status'], `${JSON.stringify(token)}: the probe goes out`);
    assert.match(addon.heads[0], /\r\nX-Amgi-Bridge-Token: tok\r\n/i, `${JSON.stringify(token)}: as the token alone`);
  }
});
