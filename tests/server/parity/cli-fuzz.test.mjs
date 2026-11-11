// The C collection CLI (server/collection/cli.c) under hostile protocol lines: every command with
// tokens of broken percent escapes, unbalanced lists, numbers that are not numbers (NaN, -1, 1e30,
// 2^64), counts that are negative or huge, and the session commands (open, probe, transport) in
// orders the runner never sends, such as a probe that finds no bridge, or a transport refused for a
// file that is not a database, followed by direct commands on the collection opened before it. The
// process must answer and exit 0, with nothing on stderr but cbase's log lines (run it with
// AMGI_COLLECTION_IMPL=server/build/asan/collection_cli to have ASan and UBSan judge every line).
// The lines come from one seeded source, so a failure replays.
//
// Needs the C core (AMGI_COLLECTION_IMPL); skips with a sentence without it. The CLI is the runner's
// side of the protocol, so this goes with it at L4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';
import { createRequire } from 'node:module';
import { enc } from './protocol.mjs';

const require = createRequire(import.meta.url);
const { createRandom } = require('../../../plusaudio/lib/random.js');

const IMPL = process.env.AMGI_COLLECTION_IMPL;
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SEED = 20261108;

const VERBS = ['status', 'listDecks', 'countNotesInDeck', 'listNotetypes', 'listNotesInDeck', 'existingFieldValues', 'createDeck', 'renameDeck',
  'deckRemovalSummary', 'removeDeck', 'addNote', 'updateNote', 'removeNote', 'hasMedia', 'readMedia', 'addMedia', 'createNotetype', 'nosuchverb', ''];
const NUMBERS = ['0', '1', '-1', 'NaN', 'Infinity', '-Infinity', '1e30', '18446744073709551616', '9007199254740993', '1.5', '0x10', '', '!', '~', 'abc'];
const COUNTS = ['-1', 'NaN', '1e30', '18446744073709551616', 'abc', '', '2', '0'];

function hostileToken(r) {
  const pick = (xs) => xs[r.int(xs.length)];
  switch (r.int(8)) {
    case 0: return pick(NUMBERS);
    case 1: return '%';
    case 2: return '%4';
    case 3: return `%${pick(['ZZ', 'C3', 'FF', '00', '0A', 'E2%82'])}`;
    case 4: return pick(['[', ']', '[]', '[,]', '[[', `[${pick(NUMBERS)},${pick(NUMBERS)}]`, '[%5B%5D]', '[~,!]']);
    case 5: return enc(pick(['../collection.anki2', 'a::b', '::', ' ', '\u0000', '\u001f', 'é', '😀', 'x'.repeat(300)]));
    case 6: return 'f'.repeat(r.int(9));
    default: {
      let s = '';
      for (let k = r.int(12); k > 0; k -= 1) s += String.fromCharCode(33 + r.int(94));
      return s;
    }
  }
}

function lines(collection, junk) {
  const r = createRandom(SEED);
  const out = [`open ${enc(collection)}`];
  for (let i = 0; i < 600; i += 1) {
    const roll = r.int(40);
    if (roll === 0) out.push(`open ${enc(collection)}`);
    else if (roll === 1) out.push(`probe ${enc('http://127.0.0.1:1')} ${hostileToken(r)}`);
    else if (roll === 2) {
      // A collection, none, or one the transport refuses (not a database, a folder).
      const at = [enc(collection), '!', enc(junk), enc(path.dirname(junk))][r.int(4)];
      out.push(`transport ${at} ${r.int(2) ? enc('http://127.0.0.1:1') : '!'} ${hostileToken(r)}`);
    }
    else if (roll === 3) out.push(`open ${hostileToken(r)}`);
    else if (roll === 4 || roll === 5) {
      const count = COUNTS[r.int(COUNTS.length)];
      out.push(`${roll === 4 ? 'parallel' : 'addNotesBulk'} ${count}`);
      if (count === '2') for (let k = 0; k < 2; k += 1) out.push(roll === 4 ? `${VERBS[r.int(VERBS.length)]} ${hostileToken(r)}` : `${hostileToken(r)} ${hostileToken(r)}`);
    } else {
      const parts = [VERBS[r.int(VERBS.length)]];
      for (let k = r.int(8); k > 0; k -= 1) parts.push(hostileToken(r));
      out.push(parts.join(' '));
    }
  }
  return out;
}

test('the C CLI answers hostile protocol lines without a fault', { skip: IMPL ? false : 'needs the C core (AMGI_COLLECTION_IMPL)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-cli-fuzz-'));
  const collection = path.join(dir, 'collection.anki2');
  fs.copyFileSync(path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18', 'collection.anki2'), collection);
  const junk = path.join(dir, 'junk.anki2');
  fs.writeFileSync(junk, 'not a database\n');
  // Run two folders down in the scratch folder: an "open" of a hostile relative name (one is
  // "../collection.anki2") makes its files there, and never beside the checkout. A run from the
  // checkout once made an empty amgi-collection-backups in its parent folder. HOME is a fresh temp
  // dir of its own (tests/repo/sandbox-home.cjs), so a default base dir never reaches the real one.
  const cwd = path.join(dir, 'a', 'b');
  fs.mkdirSync(cwd, { recursive: true });
  const input = `${lines(collection, junk).join('\n')}\nquit\n`;
  const run = spawnSync(path.resolve(ROOT, IMPL), [], {
    cwd, env: sandboxEnv({ ASAN_OPTIONS: process.env.ASAN_OPTIONS, UBSAN_OPTIONS: process.env.UBSAN_OPTIONS }), input, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.error, undefined, `the CLI ran (${run.error})`);
  // cbase's log lines (a refused connection is a WARN) are the only stderr allowed.
  const faults = run.stderr.split('\n').filter((l) => l && !/^\S+ (WARN|INFO) /.test(l)).join('\n');
  assert.equal(faults, '', 'nothing else on stderr (a sanitizer report, a crash)');
  assert.equal(run.signal, null, 'no signal');
  assert.equal(run.status, 0, 'exit 0');
  assert.ok(run.stdout.split('\n').length > 600, 'answered');
});
