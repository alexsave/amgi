// Gemini work holds its request for as long as Gemini takes: a card is five to seven calls in a row,
// each up to a minute. However many cards are in flight, the rest of the server answers at once:
// the status the page polls, a clip it plays, the deck list. Twelve clip requests are held open
// against a fake Gemini that never answers speech, and while they wait, /status and a clip are
// asked for and must come back within a second; each of the twelve gets the server's answer for
// work it cannot start yet (429, notStarted) or is still running.
//
// The Gemini routes run on cbase's slow pool (CB_ROUTE_SLOW, twelve workers, no queue), apart from
// the request pool, and a thirteenth Gemini request is refused at once as work not started.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';
import { ROOT, startServer } from './servers.mjs';

const require = createRequire(import.meta.url);
const { fakeGemini } = require('../../../plusaudio/test/helpers/fake-gemini.js');

let fake;
let app;
let headers;
before(async () => {
  fake = await fakeGemini({ speech: { raw: true, hang: true } });
  app = await startServer({ key: 'fake', base: fake.baseUrl });
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-slow-'));
  const base = path.join(top, 'Anki2');
  fs.cpSync(path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18'), path.join(base, 'User 1'), { recursive: true });
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
  const bytes = Buffer.from(await r.arrayBuffer());
  const answer = r.status >= 400 && (r.headers.get('content-type') || '').startsWith(WIRE_MIME) ? decode('error', bytes) : null;
  return { status: r.status, ms: Date.now() - t0, answer, retryAfter: r.headers.get('retry-after') };
};

test('twelve Gemini requests in flight, and /status and a clip still answer at once; a thirteenth is refused at once, not started', async () => {
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
  const extra = await timed(new URL('/api/anki/audio', app.url), {
    method: 'POST', headers: { ...headers, 'content-type': WIRE_MIME }, body: encode('q_audio', { text: 'one too many', language: 'ko' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(extra.status, 429, 'the thirteenth is refused');
  assert.ok(extra.ms < 1000, `at once, in ${extra.ms} ms`);
  assert.equal(extra.answer.notStarted, true, 'as work not started');
  assert.equal(extra.answer.retryAfterMs, 2000);
  assert.equal(extra.retryAfter, '2');
  void held;
});
