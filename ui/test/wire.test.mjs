// The server's encoders (ui/server/wire.mjs over ui/out/wire.wasm) against the app's readers
// (ui/wire/wire.c, built natively as ui/out/wire_dump): what the server writes is what C reads,
// field for field, and no cut-short answer reads as a whole one. Run ui/build.sh first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encoders } from '../server/wire.mjs';

const dump = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'wire_dump');
const read = (bytes) => execFileSync(dump, { input: bytes }).toString();

// Every proper prefix of an answer is refused, and so is the answer with a byte too many.
function refusesCutShort(bytes) {
  for (let n = 0; n < bytes.length; n++) {
    assert.equal(spawnSync(dump, { input: bytes.subarray(0, n) }).stdout.toString(), 'bad\n', `prefix of ${n} bytes`);
  }
  assert.equal(spawnSync(dump, { input: Buffer.concat([bytes, Buffer.from([0])]) }).stdout.toString(), 'bad\n', 'one byte too many');
}

test('decks: ids past 2^32, UTF-8 names, counts', () => {
  const bytes = encoders.decks({ mode: 'direct', decks: [
    { id: 1, name: 'Default', noteCount: 0 },
    { id: 1794149693370, name: '한국어::일상 표현', noteCount: 2 },
  ] });
  assert.equal(read(bytes), 'mode=direct\nn=2\nid=1\ncount=0\nname=Default\nid=1794149693370\ncount=2\nname=한국어::일상 표현\n');
  refusesCutShort(bytes);
});

test('status, and a mode the table does not know', () => {
  assert.equal(read(encoders.status({ mode: 'bridge', schemaVersion: 18 })), 'mode=bridge\nschema=18\ndetail=\n');
  assert.equal(read(encoders.status({ mode: 'not-found', detail: 'no file' })), 'mode=not-found\nschema=0\ndetail=no file\n');
  assert.equal(read(encoders.status({ mode: 'from-the-future' })), 'mode=\nschema=0\ndetail=\n');
  refusesCutShort(encoders.status({ mode: 'locked', schemaVersion: 18, detail: 'x' }));
});

test('error: the 429 shape', () => {
  const bytes = encoders.error({ error: 'Gemini is rate limited', retryAfterMs: 41500.4, notStarted: true, dailyCap: false });
  assert.equal(read(bytes), 'mode=\nretry=41500\nflags=1\nerror=Gemini is rate limited\n');
  assert.equal(read(encoders.error({ mode: 'locked', error: 'e', dailyCap: true })), `mode=locked\nretry=${2 ** 32 - 1}\nflags=2\nerror=e\n`);
  refusesCutShort(bytes);
});

test('install and profiles', () => {
  assert.equal(read(encoders.install({ installed: true, upToDate: null, collectionChecked: true, collectionStale: ['a', 'b'], ready: false })),
    'installed=1\nup_to_date=2\nchecked=1\nstale=2\nready=0\n');
  const bytes = encoders.profiles({ baseDir: '/A', baseDirExists: true, profiles: [{ name: '사용자 1', collectionPath: '/A/사용자 1/collection.anki2' }] });
  assert.equal(read(bytes), 'base=/A\nexists=1\nn=1\nname=사용자 1\npath=/A/사용자 1/collection.anki2\n');
  refusesCutShort(bytes);
});
