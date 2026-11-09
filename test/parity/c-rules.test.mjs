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

// The incident-1842 checkpoint rule is held by test/no-checkpoint.test.mjs, for the C, the
// JavaScript and the add-on's Python at once, with comments blanked.
