// Rules about amgi's C that a test holds, beside the no-JSON and random scans.
//
// No thread cancellation: the collection core's per-path ticket lock (server/collection/direct.c)
// is given back by every op, a throw included, but a cancelled thread would never give it back and
// its path would wait for ever. So nothing in amgi's C, nor in the cbase it links, may call
// pthread_cancel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function cFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cFiles(p));
    else if (/\.[ch]$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('nothing in amgi\'s C or in cbase cancels a thread', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.c', '*.h'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const files = [...tracked.map((f) => path.join(ROOT, f)), ...cFiles(path.join(ROOT, 'cbase', 'core')), ...cFiles(path.join(ROOT, 'cbase', 'providers'))];
  assert.ok(files.some((f) => f.endsWith('direct.c')), 'the scan sees the collection core');
  const hits = files.filter((f) => /\bpthread_cancel\s*\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

// incident-1842: amgi never asks SQLite for a checkpoint. One cut Anki's live -wal to nothing while
// Anki's lock was down, and Anki's next frames left a hole its close copied into the collection as
// zero pages. server/collection/db.c (collection_openable) says the rules that keep SQLite's own
// open and close safe; this holds the C to having no checkpoint call of its own.
test('nothing in amgi\'s C asks SQLite for a checkpoint', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'server/*.c', 'server/*.h'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(tracked.some((f) => f.endsWith('db.c')), 'the scan sees db.c');
  // server/test/ is left out: incident_1842.c plays Anki on a sandbox copy, checkpoint and all.
  const hits = tracked.filter((f) => !f.startsWith('server/test/')).filter((f) => /wal_checkpoint/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.deepEqual(hits, []);
});
