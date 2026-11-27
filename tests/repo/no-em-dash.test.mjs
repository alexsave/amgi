// Alex's rule: no em dash anywhere, a plain "-" instead. Every tracked text file is read; a file
// with a NUL byte in it (audio, images) is not text and is passed over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EM_DASH = String.fromCodePoint(0x2014);

test('no tracked text file holds an em dash', () => {
    const found = [];
    for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')) {
        const full = path.join(ROOT, file);
        if (!file || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const bytes = fs.readFileSync(full);
        if (bytes.includes(0)) continue;
        bytes.toString('utf8').split('\n').forEach((line, i) => {
            if (line.includes(EM_DASH)) found.push(`${file}:${i + 1}`);
        });
    }
    assert.deepEqual(found, []);
});
