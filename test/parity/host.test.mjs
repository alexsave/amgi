// DNS rebinding: a page on another site whose name is made to resolve to 127.0.0.1 reaches the
// loopback server as same-origin, and CORS never comes into it. So the server answers only a Host
// it is: 127.0.0.1, localhost or [::1] at the port it listens on (cbase's Host allow-list,
// cb_app.host_allow). Any other Host gets 403 before any route runs, on the page, its files, the
// API and the clips alike; the same requests with the server's own Host are answered as usual.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startServer } from './servers.mjs';

let app;
let port;
let headers;
before(async () => {
  app = await startServer();
  port = new URL(app.url).port;
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-host-'));
  const base = path.join(top, 'Anki2');
  fs.cpSync(path.join(ROOT, 'test', 'parity', 'fixtures', 'schema18'), path.join(base, 'User 1'), { recursive: true });
  headers = { 'x-amgi-collection': encodeURIComponent(path.join(base, 'User 1', 'collection.anki2')) };
});
after(() => app?.stop());

/** One GET with the Host header as given (fetch would not let a test set it). */
function get(pathname, host, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { ...extra, host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const PATHS = ['/decks', '/app.wasm', '/favicon.svg', '/api/anki/status', '/api/anki/decks', '/api/anki/media/clip.ogg', '/nope'];

test('another site\'s name is refused on every route', async () => {
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost:${Number(port) + 1}`]) {
    for (const p of PATHS) assert.equal(await get(p, host, headers), 403, `${host} ${p}`);
  }
});

test('the server\'s own names are answered', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal(await get('/decks', host), 200, `${host} /decks`);
    assert.equal(await get('/api/anki/status', host), 200, `${host} status`);
    assert.equal(await get('/api/anki/decks', host, headers), 200, `${host} decks`);
    assert.equal(await get('/api/anki/media/clip.ogg', host, headers), 200, `${host} a clip`);
  }
});

// The platform's own routes are not amgi's: amgi's port carries exactly amgi's routes, and answers its
// own 404 on cbase's, which cbase serves only for an app that declares them (health, ready, the
// admin console, the account routes).
test('the platform\'s /health, /ready, /admin and /v1/auth are not served', async () => {
  for (const p of ['/health', '/ready', '/admin', '/admin/', '/admin/api/overview', '/v1/auth/signup', '/v1/auth/signin', '/v1/auth/refresh']) {
    assert.equal(await get(p, `127.0.0.1:${port}`), 404, p);
  }
});
