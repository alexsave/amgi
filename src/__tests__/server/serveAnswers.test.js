// How ui/server/serve.mjs sends what a route refuses, over real HTTP: a clip that is not there is a
// 404 like every other 404 of this server (text/plain, no-store), and a clip name that is not a
// valid percent-encoding is the route's 400, in the wire error answer, not a 500 from the path.
// Needs the anki library for a real collection (ANKI_PYTHON_BIN); skipped without it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode } from '../../../ui/server/wire.mjs';

const require = createRequire(import.meta.url);
const { anki, buildFixtureCollection, tempDir } = require('../../../plusaudio/test/collection/helpers/anki-python');
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const maybe = anki ? test : test.skip;

let server;
let base;
let dir;
let headers;
before(async () => {
  if (!anki) return;
  dir = tempDir('amgi-serve-answers-');
  const collection = path.join(dir, 'collection.anki2');
  buildFixtureCollection(collection);
  headers = { 'X-Amgi-Base-Dir': encodeURIComponent(dir), 'X-Amgi-Collection': encodeURIComponent(collection) };
  server = spawn(process.execPath, ['ui/server/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', GEMINI_API_KEY: '' } });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
      const match = /amgi on (http:\/\/\S+)/.exec(chunk.toString());
      if (match) resolve(match[1]);
    });
    server.once('error', reject);
  });
});
after(() => {
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

maybe('a clip that is not there is a 404 shaped as the server\'s others', async () => {
  const missing = await fetch(`${base}/api/anki/media/not-there.wav`, { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-type'), 'text/plain');
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(await missing.text(), 'no such clip');
  const route = await fetch(`${base}/api/anki/nowhere`, { headers });
  assert.equal(route.headers.get('content-type'), missing.headers.get('content-type'), 'the same as a missing route');
  assert.equal(route.headers.get('cache-control'), missing.headers.get('cache-control'));
});

maybe('a clip name that is not a valid percent-encoding is a 400 with a sentence', async () => {
  const response = await fetch(`${base}/api/anki/media/%E0%A4%A.wav`, { headers });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), WIRE_MIME);
  assert.equal(decode('error', new Uint8Array(await response.arrayBuffer())).error, 'the clip name is not a valid name');
});
