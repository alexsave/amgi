'use strict';

// plusaudio/lib/random.js is the codebase's one random source. These tests
// prove it is deterministic for a seed, and - the part that keeps it the
// ONLY source - that nothing else in the repo draws a random of its own.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { Random, SEED, createRandom, random } = require('../../../plusaudio/lib/random');

const REPO = path.join(__dirname, '..', '..', '..');

test('the same seed gives the same raw draw sequence, and another seed another one', () => {
  const draws = (seed) => {
    const source = createRandom(seed);
    return Array.from({ length: 64 }, () => source.uint32());
  };
  assert.deepEqual(draws(99), draws(99));
  assert.notDeepEqual(draws(99), draws(100));
  // Pinned, so a change to the generator is a deliberate one.
  assert.deepEqual(draws(1).slice(0, 4), PINNED_SEED_1);
});

const PINNED_SEED_1 = [1828152527, 3394835397, 2967886022, 2251045104];

test('int() and bytes() cost a fixed number of draws, whatever values come out', () => {
  const a = createRandom(5);
  const b = createRandom(5);
  a.int(3);
  a.int(1000);
  a.bytes(8);
  for (let i = 0; i < 4; i += 1) b.uint32();
  assert.equal(a.uint32(), b.uint32());
});

test('int(n) stays in [0, n)', () => {
  const source = createRandom(3);
  for (let i = 0; i < 2000; i += 1) {
    const value = source.int(3);
    assert.ok(value >= 0 && value < 3 && Number.isInteger(value));
  }
  assert.throws(() => source.int(0), /positive integer/);
});

test('the C source is the same generator, its seed one named value', () => {
  const source = fs.readFileSync(path.join(REPO, 'server', 'collection', 'rng.c'), 'utf8');
  assert.equal((source.match(/^#define AMGI_SEED /gm) || []).length, 1, 'exactly one line sets the C seed');
  // tests/server/c/unit.c pins rng.c's seed-1 draws to this generator's, so the two stay one sequence.
});

test('the shipped seed is the one named value, and the shared generator is a Random', () => {
  assert.ok(SEED === null || Number.isInteger(SEED));
  assert.ok(random instanceof Random);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plusaudio', 'lib', 'random.js'), 'utf8');
  assert.equal((source.match(/^const SEED = /gm) || []).length, 1, 'exactly one line sets the seed');
});

// ========================
// NO STRAY RANDOMS
// ========================

// Each is a way to draw a random number, or to seed one from the clock,
// without going through lib/random.js. Built from pieces so this file does
// not match itself.
const BANNED = [
  ['Math', 'random'].join('\\.'),
  ['random', 'Bytes'].join(''),
  ['random', 'UUID'].join(''),
  ['getRandom', 'Values'].join(''),
  ['random', 'Int\\('].join(''),
  ['arc4', 'random'].join(''),
  ['\\bs?rand', '\\(\\)'].join(''),
  ['^\\s*(?:import|from) ', 'random\\b'].join(''),
  ['\\bsecrets', '\\.'].join(''),
  ['os\\.u', 'random'].join(''),
  ['uuid', '\\.uuid4'].join(''),
  ['seed.*Date', '\\.now|Date\\.now.*seed'].join(''),
  // C: libc's and the OS's generators and entropy, OpenSSL's, Apple's, and a clock-seeded srand.
  ['\\bs?random', '\\s*\\('].join(''),
  ['\\bsrand', '\\s*\\('].join(''),
  ['\\b[delmnj]?rand', '48\\s*\\('].join(''),
  ['\\bget', '(?:entropy|random)\\s*\\('].join(''),
  ['/dev/u?', 'random'].join(''),
  ['\\bRAND_', '(?:priv_)?bytes\\s*\\('].join(''),
  ['\\b(?:SecRandom', 'CopyBytes|CCRandom', 'GenerateBytes)'].join(''),
].map((pattern) => new RegExp(pattern, 'im'));

const SCANNED = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|html|c|h)$/;
// The source itself; vendored upstream code (Anki's own, not ours); retired
// code kept for reference only.
// server/collection/rng.c is the C side's one source: the same generator, seeded once from the OS.
const EXEMPT = [/^plusaudio\/lib\/random\.js$/, /^server\/collection\/rng\.c$/, /^plusaudio\/vendor\//, /^archives\//, /(^|\/)node_modules\//];

// Lines that must NOT go through lib/random.js, each for a stated reason.
// A security secret has to be unpredictable even when someone has fixed the
// seed to debug something, so it keeps the OS's cryptographic source - a
// different job from "a random voice", not a stray.
const ALLOWED = [
  // The local HTTP bridge's auth token (bridge_auth.py): a guessable token
  // would let any local web page drive the person's Anki.
  { file: 'anki/addon/amgi_bridge/__init__.py', line: /^\s*token = secrets\.token_urlsafe\(32\)$/ },
];

function strayRandoms(files) {
  const found = [];
  for (const file of files) {
    if (!SCANNED.test(file) || EXEMPT.some((pattern) => pattern.test(file))) continue;
    if (file === path.relative(REPO, __filename)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(REPO, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    text.split('\n').forEach((line, index) => {
      if (ALLOWED.some((allowed) => allowed.file === file && allowed.line.test(line))) return;
      if (BANNED.some((pattern) => pattern.test(line))) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('nothing in the repo draws a random except through lib/random.js', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(files.length > 100, 'the scan saw the repository');
  assert.deepEqual(strayRandoms(files), []);
});

test('the scan does catch each kind of stray random', () => {
  const dir = fs.mkdtempSync(path.join(REPO, 'tests', 'server', 'plusaudio', '.stray-'));
  try {
    const samples = [
      'const x = Math' + '.random();',
      "const b = require('node:crypto').random" + 'Bytes(4);',
      'const id = crypto.random' + 'UUID();',
      'window.crypto.getRandom' + 'Values(a);',
      'import ' + 'random',
      'const seed = Date' + '.now();',
      'int x = ran' + 'd();',
      'sran' + 'd(time(NULL));',
      'long r = ran' + 'dom();',
      'double d = dran' + 'd48();',
      'getentr' + 'opy(&s, 4);',
      'arc4' + 'random_buf(b, 8);',
      'RAND_' + 'bytes(b, 8);',
    ];
    const ext = (line) => (line.startsWith('import') ? 'py' : /;$/.test(line) && !/^const /.test(line) ? 'c' : 'js');
    samples.forEach((line, i) => fs.writeFileSync(path.join(dir, `s${i}.${ext(line)}`), `${line}\n`));
    const files = fs.readdirSync(dir).map((name) => path.relative(REPO, path.join(dir, name)));
    assert.equal(strayRandoms(files).length, samples.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
