// Golden file: the install (server/amgi/install.c) and the starter deck (server/amgi/starter.c)
// through the C server's HTTP surface, as the page drives them, on a fresh Anki folder with Anki
// closed. tests/server/parity/golden/install-starter-expected.txt was recorded once from the Node server
// (by a generator removed at L4) and is the contract: the install's collection
// checks before and after, the note type the direct install writes (its fields and sort field), the
// starter's offer with no key, the deck built in en->ko, the same press again (every phrase already
// there, nothing added), a second pair, the decks and their counts, the starter notes' fields, and
// every file copied into the media folder (the template's files and the shipped clips, byte for
// byte). Needs the anki library (ANKI_PYTHON_BIN) for the fresh collection; skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';
import { ROOT, startServer } from './servers.mjs';
import { runSteps } from './golden/install-starter-steps.mjs';
import { freshAnki } from './golden/fresh-anki.mjs';

const { anki } = createRequire(import.meta.url)('../plusaudio/collection/helpers/anki-python.js');

test('install and the starter deck answer the golden file, line for line', { skip: !anki && 'needs ANKI_PYTHON_BIN' }, async () => {
  const want = fs.readFileSync(path.join(import.meta.dirname, 'golden', 'install-starter-expected.txt'), 'utf8').trimEnd().split('\n');
  const ankiDir = freshAnki(anki.bin);
  const server = await startServer({ key: '' });
  try {
    const got = await runSteps({ url: server.url, ankiDir, repo: ROOT, decode, WIRE_MIME, encode });
    for (let i = 0; i < Math.max(got.length, want.length); i++) assert.equal(got[i], want[i], `line ${i + 1}`);
  } finally {
    await server.stop();
    fs.rmSync(ankiDir, { recursive: true, force: true });
  }
});
