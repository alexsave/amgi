// Gemini work holds its request for as long as Gemini takes: a card is five to seven calls in a row,
// each up to a minute. However many cards are in flight, the rest of the server answers at once:
// the status the page polls, a clip it plays, the deck list. Twelve clip requests are held open
// against a fake Gemini that never answers speech, and while they wait, /status and a clip are
// asked for and must come back within a second; each of the twelve gets the server's answer for
// work it cannot start yet (429, notStarted) or is still running.
//
// TODO until cbase's slow route pool (CB_POOL_SLOW, cb_app.slow_workers) lands: the Gemini routes
// run on the one request pool, so twelve of them fill it and this fails. It runs as a todo and goes
// green when the routes are marked slow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, encode } from '../../ui/server/wire.mjs';
import { ROOT, startServer } from './servers.mjs';

const require = createRequire(import.meta.url);
const { fakeGemini } = require('../../plusaudio/test/helpers/fake-gemini.js');

let fake;
let app;
let headers;
before(async () => {
  fake = await fakeGemini({ speech: { raw: true, hang: true } });
  app = await startServer({ key: 'fake', base: fake.baseUrl });
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-slow-'));
  const base = path.join(top, 'Anki2');
  fs.cpSync(path.join(ROOT, 'test', 'parity', 'fixtures', 'schema18'), path.join(base, 'User 1'), { recursive: true });
  headers = { 'x-amgi-collection': encodeURIComponent(path.join(base, 'User 1', 'collection.anki2')) };
});
after(async () => {
  // The twelve are still waiting on the fake: no drain, the server goes at once.
  if (app) process.kill(app.pid, 'SIGKILL');
  await fake?.close();
});

const timed = async (url, init) => {
  const t0 = Date.now();
  const r = await fetch(url, init);
  await r.arrayBuffer();
  return { status: r.status, ms: Date.now() - t0 };
};

test('twelve Gemini requests in flight, and /status and a clip still answer at once', { todo: 'cbase CB_POOL_SLOW' }, async () => {
  const held = Array.from({ length: 12 }, (_, i) => fetch(new URL('/api/anki/audio', app.url), {
    method: 'POST', headers: { ...headers, 'content-type': WIRE_MIME }, body: encode('q_audio', { text: `slow ${i}`, language: 'ko' }),
    signal: AbortSignal.timeout(90_000),
  }).catch(() => null));
  await new Promise((resolve) => setTimeout(resolve, 1500)); // all twelve are in
  for (let round = 0; round < 3; round++) {
    const status = await timed(new URL('/api/anki/status', app.url), { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(status.status, 200);
    assert.ok(status.ms < 1000, `/status in ${status.ms} ms`);
    const clip = await timed(new URL('/api/anki/media/clip.ogg', app.url), { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(clip.status, 200);
    assert.ok(clip.ms < 1000, `a clip in ${clip.ms} ms`);
  }
  void held;
});
