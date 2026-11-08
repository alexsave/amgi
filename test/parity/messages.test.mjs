// The sentences the C server says (server/amgi/messages.h) and their Node copies are the same
// sentences. Until L4 deletes the Node server, each one exists in both, and this test is what keeps
// them one: it reads the header's #defines (string literals and the defines they name, joined as C
// joins them) and compares each with the JavaScript that still says it.
//
// Comparison scaffolding: removed at L4 with the Node server, when messages.h is their one owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './servers.mjs';
import { ANSWER } from '../../src/server/anki/answer.js';
import { notReadyResponse } from '../../src/server/anki/respond.js';
import { INSTALLED_MESSAGE, RESTART_MESSAGE, installAddons } from '../../src/server/anki/install.js';
import { AMGI_NOTETYPE_NAME } from '../../src/utils/amgiNotetype.js';

const require = createRequire(import.meta.url);
const { MISSING_KEY_MESSAGE, GEMINI_KEY_PAGE } = require('../../plusaudio/lib/geminiKey.js');
const { MAX_WAIT_MS } = require('../../plusaudio/lib/rateLimits.js');

/** The header's defines: name -> its value (a string, or a number for a bare integer). */
export function readDefines(text) {
  const joined = text.replace(/\\\n/g, ' ');
  const raw = new Map();
  for (const m of joined.matchAll(/^#define[ \t]+(\w+)[ \t]+(.+)$/gm)) raw.set(m[1], m[2].trim());
  const value = (name, seen = new Set()) => {
    if (seen.has(name)) throw new Error(`${name} names itself`);
    const body = raw.get(name);
    if (body === undefined) throw new Error(`no #define ${name}`);
    if (/^\d+$/.test(body)) return Number(body);
    let out = '';
    for (const t of body.matchAll(/"((?:[^"\\]|\\.)*)"|(\w+)/g)) {
      if (t[1] !== undefined) out += t[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
      else out += value(t[2], new Set([...seen, name]));
    }
    return out;
  };
  return new Map([...raw.keys()].map((k) => [k, value(k)]));
}

const C = readDefines(fs.readFileSync(path.join(ROOT, 'server', 'amgi', 'messages.h'), 'utf8'));

test('respond.js: each mode\'s sentence', () => {
  for (const [name, mode] of [['MSG_UNCONFIGURED', 'unconfigured'], ['MSG_NOT_FOUND', 'not-found'],
    ['MSG_UNSUPPORTED_SCHEMA', 'unsupported-schema'], ['MSG_LOCKED', 'locked'], ['MSG_BRIDGE_OUTDATED', 'bridge-outdated'],
    ['MSG_BRIDGE_NO_COLLECTION', 'bridge-no-collection']]) {
    assert.equal(C.get(name), notReadyResponse(mode)[ANSWER].error, name);
  }
});

test('the key, install, the note type and the longest wait', () => {
  assert.equal(C.get('GEMINI_KEY_PAGE'), GEMINI_KEY_PAGE);
  assert.equal(C.get('MISSING_KEY_MESSAGE'), MISSING_KEY_MESSAGE);
  assert.equal(C.get('RESTART_MESSAGE'), RESTART_MESSAGE);
  assert.equal(C.get('INSTALLED_MESSAGE'), INSTALLED_MESSAGE);
  assert.equal(C.get('NO_SOURCE_MESSAGE'), installAddons({ root: path.join(ROOT, 'no-such-root') }).message);
  assert.equal(C.get('AMGI_NOTETYPE_NAME'), AMGI_NOTETYPE_NAME);
  assert.equal(C.get('MAX_WAIT_MS'), MAX_WAIT_MS);
});

test('every define is compared above', () => {
  const compared = ['MSG_UNCONFIGURED', 'MSG_NOT_FOUND', 'MSG_UNSUPPORTED_SCHEMA', 'MSG_LOCKED', 'MSG_BRIDGE_OUTDATED',
    'MSG_BRIDGE_NO_COLLECTION', 'GEMINI_KEY_PAGE', 'MISSING_KEY_MESSAGE', 'RESTART_MESSAGE', 'INSTALLED_MESSAGE',
    'NO_SOURCE_MESSAGE', 'AMGI_NOTETYPE_NAME', 'MAX_WAIT_MS', 'AMGI_MESSAGES_H'];
  assert.deepEqual([...C.keys()].filter((k) => !compared.includes(k)), []);
});
