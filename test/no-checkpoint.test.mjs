// No explicit checkpoint in amgi's shipped code.
//
// The lock rule (skills/amgi/references/collection-internals.md): a -wal with no -shm beside it is an
// exclusive-mode owner (Anki, or an Anki that crashed), and amgi reports the collection locked
// without opening it. amgi never checkpoints a WAL itself. Why: Anki's own backup on close drops its
// exclusive lock, and a second SQLite connection's checkpoint then resets Anki's live -wal; the
// incident of 2026-11-08 (~/Dev/foolish-reports/incident-1842.md) emptied a real collection that way.
//
// This test scans every tracked source file that ships (test/source-scan.mjs: not a test, a tool, a
// script, a fixture or a document; the submodules are not in git ls-files), in C, JavaScript and the
// add-on's Python, with comments blanked, for a checkpoint asked for by name: the wal_checkpoint
// pragma, sqlite3_wal_checkpoint and sqlite3_wal_checkpoint_v2, Python's and node:sqlite's spelling
// of the same pragma, and the SQLITE_CHECKPOINT_* modes. Every hit must be in ALLOWED at exactly
// its count; a new one fails, and so does an allowed one that is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shippedSources, stripJsComments, stripPyComments } from './source-scan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** A checkpoint by name, in any of the three languages (the pragma, the C API, the mode constants). */
const CHECKPOINT = /wal_checkpoint|SQLITE_CHECKPOINT_[A-Z]+/g;

const ALLOWED = [
  {
    // writePackage: pkg.db is the .apkg tool's own unpacked copy. openPackage writes the package's
    // collection into a fresh fs.mkdtempSync(os.tmpdir()) folder and opens that, so the checkpoint
    // folds the tool's own writes into its own temporary file before it is read back into the new
    // package. No other process has that file, and it is never the user's collection.
    file: 'plusaudio/lib/package.js', count: 1,
    why: 'the .apkg tool\'s own temporary database (openPackage\'s mkdtemp copy), never a live collection',
  },
  {
    // TEMPORARY. openCollection checkpoints on every open, which is the incident's sequence. The
    // owner decided on 2026-11-08 that the Node server gets no fix: it is stopped (not run) until
    // the switch to the C server, and the switch deletes it, this file with it. REMOVE THIS ENTRY
    // WITH THE FILE: once open.js is gone the entry has nothing left to excuse, and the exact-count
    // rule fails ("allowed 1 checkpoint(s) but has none - delete its entry").
    file: 'plusaudio/lib/collection/open.js', count: 1,
    why: 'temporary: the Node server, stopped and deleted at the switch (owner decision 2026-11-08); remove with the file',
  },
];

/** Every checkpoint asked for in a file's code, as "line: text". */
export function checkpointUses(src, file) {
  const code = file.endsWith('.py') ? stripPyComments(src) : stripJsComments(src);
  const hits = [];
  code.split('\n').forEach((line, n) => {
    for (const m of line.matchAll(CHECKPOINT)) hits.push(`${n + 1}: ${m[0]}`);
  });
  return hits;
}

function scan() {
  const found = new Map();
  for (const file of shippedSources(ROOT)) {
    const hits = checkpointUses(readFileSync(path.join(ROOT, file), 'utf8'), file);
    if (hits.length) found.set(file, hits);
  }
  return found;
}

/** Each problem with `found` (file -> hits) against `allowed`, as a line a person can act on. */
function judge(found, allowed) {
  const byFile = new Map(allowed.map((a) => [a.file, a]));
  const problems = [];
  for (const [file, hits] of found) {
    const a = byFile.get(file);
    const list = hits.map((h) => `      ${h}`).join('\n');
    if (!a) problems.push(`${file}: a checkpoint in a shipped path (amgi never checkpoints a collection)\n${list}`);
    else if (hits.length !== a.count) problems.push(`${file}: ${hits.length} checkpoint(s), the list allows exactly ${a.count}\n${list}`);
  }
  for (const a of allowed) if (!found.has(a.file)) problems.push(`${a.file}: allowed ${a.count} checkpoint(s) but has none - delete its entry`);
  return problems;
}

test('the scan finds a checkpoint in each language, and not in a comment', () => {
  assert.deepEqual(checkpointUses('conn_exec(c, k, "PRAGMA wal_checkpoint(TRUNCATE)");\n// wal_checkpoint\n', 'x.c'), ['1: wal_checkpoint']);
  assert.deepEqual(checkpointUses('/* a\n wal_checkpoint */\nsqlite3_wal_checkpoint_v2(db, NULL, SQLITE_CHECKPOINT_TRUNCATE, 0, 0);\n', 'x.c'),
    ['3: wal_checkpoint', '3: SQLITE_CHECKPOINT_TRUNCATE']);
  assert.deepEqual(checkpointUses("db.exec('PRAGMA wal_checkpoint(PASSIVE)'); // wal_checkpoint\n", 'x.js'), ['1: wal_checkpoint']);
  assert.deepEqual(checkpointUses('# wal_checkpoint\n"""wal_checkpoint"""\ndb.execute("pragma wal_checkpoint")\n', 'x.py'), ['3: wal_checkpoint']);
  assert.deepEqual(checkpointUses('PRAGMA wal_autocheckpoint = 0\n', 'x.c'), [], 'turning the automatic checkpoint off is not asking for one');
});

test('the judge: a new file, a count off either way, and a stale entry fail', () => {
  const allowed = [{ file: 'a.js', count: 1, why: '' }];
  assert.deepEqual(judge(new Map([['a.js', ['1']]]), allowed), []);
  assert.equal(judge(new Map([['a.js', ['1']], ['b.c', ['2']]]), allowed).length, 1, 'a new file');
  assert.equal(judge(new Map([['a.js', ['1', '2']]]), allowed).length, 1, 'one too many');
  assert.equal(judge(new Map(), allowed).length, 1, 'an entry with nothing left to excuse');
});

test('the scan covers the shipped C, JavaScript and Python', () => {
  const files = shippedSources(ROOT);
  for (const f of ['server/collection/db.c', 'plusaudio/lib/package.js', 'anki/addon/amgi_bridge/bridge_ops.py']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('cbase/') || f.startsWith('cdom/')), 'the submodules are not amgi\'s code');
});

test('nothing shipped checkpoints a WAL, but for the one entry listed with its reason', () => {
  const problems = judge(scan(), ALLOWED);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`
    + 'amgi never checkpoints: see the lock rule in skills/amgi/references/collection-internals.md.\n');
});
