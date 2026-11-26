// The clips' name prefix is "amgi-", owned by AMGI_MEDIA_PREFIX in ui/wire/wire.h. The old prefix is gone from
// the repository: no tracked file names it, and no tracked file's path does. The old prefix is written in two
// halves here so that this file does not hold it either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OLD = 'plus' + 'audio-';

/** The tracked files, as git lists them (a path git lists that is not on disk, deleted but not committed, is skipped). */
export const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));

test('no tracked file holds the old clip prefix, in its text or in its path', () => {
    const hits = [];
    for (const file of tracked()) {
        if (file.includes(OLD)) hits.push(`${file} (path)`);
        // A submodule is a directory here: its files are its own repository's.
        if (!fs.statSync(path.join(ROOT, file)).isFile()) continue;
        if (fs.readFileSync(path.join(ROOT, file)).includes(OLD)) hits.push(file);
    }
    assert.deepEqual(hits, []);
});

test('the one owner of the prefix is AMGI_MEDIA_PREFIX in wire.h, and the add-on reads it from wire_schema.py', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'ui/wire/wire.h'), 'utf8'), /#define AMGI_MEDIA_PREFIX "amgi-"\n/);
    assert.match(fs.readFileSync(path.join(ROOT, 'anki/addon/amgi_bridge/wire_schema.py'), 'utf8'), /\nMEDIA_PREFIX = "amgi-"\n/);
});
