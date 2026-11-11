// .env.local, as amgi's start path reads it (server/tools/start.sh sets CBASE_ENV_FILE to it): cbase
// reads KEY=VALUE lines, and an unquoted value's '#' after a space or a tab starts a comment, as
// Node's loadEnvFile read it, while "a#b" keeps its '#'. What reaches Gemini is the key itself: the
// fake Gemini sees each request's x-goog-api-key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, encode } from '../../../ui/wire/wire.mjs';
import { LISTENING, ROOT, SERVER } from './servers.mjs';
import { sandboxEnv } from '../../../test/sandbox-home.cjs';

const require = createRequire(import.meta.url);
const { fakeGemini } = require('../plusaudio/helpers/fake-gemini.js');

/** The server with only an env file for its Gemini settings; resolves to its URL and a stop(). */
function serveWith(envFile) {
  const env = sandboxEnv({ CBASE_LISTEN: '127.0.0.1:0', CBASE_ENV_FILE: envFile });
  const child = spawn(SERVER, ['serve'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = LISTENING.exec(out);
      if (m) resolve({ url: `http://${m[1]}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }) });
    });
    child.once('exit', (code) => reject(new Error(`the server exited ${code}`)));
  });
}

test('an inline comment in .env.local is not part of the key Gemini gets', async () => {
  const fake = await fakeGemini({ speech: { raw: true, hang: true } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-env-'));
  const base = path.join(dir, 'Anki2');
  fs.cpSync(path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18'), path.join(base, 'User 1'), { recursive: true });
  const headers = { 'x-amgi-collection': encodeURIComponent(path.join(base, 'User 1', 'collection.anki2')), 'content-type': WIRE_MIME };
  for (const [line, want] of [
    ['GEMINI_API_KEY=abc # my key', 'abc'],
    ['GEMINI_API_KEY=abc\t# my key', 'abc'],
    ['GEMINI_API_KEY=a#b', 'a#b'],
    ['GEMINI_API_KEY="abc # kept"', 'abc # kept'],
  ]) {
    const file = path.join(dir, '.env.local');
    fs.writeFileSync(file, `# amgi's key\n${line}\nGEMINI_API_BASE=${fake.baseUrl}\n`);
    const app = await serveWith(file);
    try {
      fake.requests.length = 0;
      // The clip's speech call reaches the fake (which never answers it) and carries the key.
      fetch(new URL('/api/anki/audio', app.url), { method: 'POST', headers, body: encode('q_audio', { text: `env ${want}`, language: 'ko' }) }).catch(() => {});
      for (let i = 0; i < 100 && fake.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(fake.requests[0]?.headers['x-goog-api-key'], want, line);
    } finally {
      await app.stop();
    }
  }
  await fake.close();
});
