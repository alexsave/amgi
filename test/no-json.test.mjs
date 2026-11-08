// No JSON in a shipped path.
//
// The owner's rule: JSON is slow to parse and slow to format, so amgi's own boundaries cross as
// fixed binary layouts (the page and its server: ui/wire), and JSON is kept only where something
// outside amgi forces it. This test keeps it that way. It scans every tracked source file that
// ships (not a test, a tool, a script, a fixture or a document) for the calls that parse or
// format JSON, in JavaScript and in the Anki add-on's Python. Every hit must be in ALLOWED below,
// at exactly the count stated, with the reason it stays. A new hit fails. A second hit in an
// allowed file fails. An allowed hit that is gone fails too, so the list cannot outlive what it
// excuses, except for an entry marked `leaving`: work in flight removes those, and they may have
// fewer hits than stated, or none.
//
// amgi's own JSON lives in one folder, plusaudio/lib/json, behind one named function per use; the
// only JSON outside it is Anki's own (its collection and package formats, which amgi reads and
// writes as Anki defines them) and the add-on's Python side of the bridge protocol (leaving).
//
// README.md's "JSON that remains and why" names the same files; the last test holds the two
// together.
//
// A mention in a comment is not a hit: comments are stripped first. Package files that tooling
// reads (package.json, the lockfile) and the eslint config are not source and are not scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FOLDER = 'plusaudio/lib/json/';

/** JavaScript: JSON.x, .json() (Response.json, NextResponse.json, request.json), and fork(), whose IPC channel Node serializes as JSON by default. */
const JS_JSON = /\bJSON\s*\.\s*[A-Za-z_]+|\.json\s*\(|\bfork\s*\(/g;
/** Python: the json module imported, or any of its four calls. */
const PY_JSON = /^\s*import\s+json\b|^\s*from\s+json\s+import\b|\bjson\s*\.\s*(?:loads|dumps|load|dump)\s*\(/g;

const SOURCE = /\.(?:js|mjs|cjs|ts|html|py)$/;
/** Not shipped: a directory of this name anywhere in the path. */
const NOT_SHIPPED_DIR = new Set([
  'test', 'tests', '__tests__', 'test-helpers', 'tools', 'scripts', 'docs', 'fixtures', 'e2e', 'vendor', 'node_modules',
]);
const notShipped = (file) => {
  const parts = file.split('/');
  return parts.some((p) => NOT_SHIPPED_DIR.has(p)) || /\.(?:test|spec|config)\.[a-z]+$/.test(parts.at(-1));
};

const ANSWER_FORMAT = 'plusaudio/ANSWER_FORMAT.md';
const ANKI = 'FORCED by Anki: ';
/**
 * kind: 'ours' (amgi's own JSON, which must live in FOLDER), 'anki' (Anki's own formats, read and
 * written where the collection code is), 'ipc' (a child process's Node IPC channel), or 'addon'
 * (the add-on's Python).
 */
const ALLOWED = [
  {
    file: `${FOLDER}modelAnswer.js`, count: 1, kind: 'ours',
    why: `FORCED by Gemini: the API's structured output is JSON text, and parseModelAnswer reads it once; the caller then checks every field against its format. ${ANSWER_FORMAT} records what was measured against function calling and labelled lines.`,
  },
  {
    file: `${FOLDER}cardTextLine.js`, count: 2, kind: 'ours', leaving: true,
    why: 'Ours, leaving: the line plusaudio/generate-card-text.js prints for the app server (src/server/anki/cardText.js reads it). A fixed layout can replace it.',
  },
  {
    file: `${FOLDER}bridgeBody.js`, count: 2, kind: 'ours', leaving: true,
    why: 'Ours, leaving: the amgi_bridge add-on\'s HTTP bodies as the app server writes and reads them. The bridge protocol moves to a binary layout with a version check.',
  },
  {
    file: 'src/server/anki/plusaudioCli.js', count: 1, kind: 'ipc', leaving: true,
    why: 'Ours, leaving: fork() gives the generator scripts an IPC channel that Node serializes as JSON; it carries the rate gate\'s acquire, record and reply messages (plusaudio/lib/ipcGate.js).',
  },
  {
    file: 'anki/addon/amgi_bridge/bridge_server.py', count: 3, kind: 'addon', leaving: true,
    why: 'Ours, leaving: the add-on side of the bridge protocol, the request body read (json.loads) and the answer written (json.dumps). It goes with bridgeBody.js.',
  },
  {
    file: 'plusaudio/lib/collection/decks.js', count: 5, kind: 'anki',
    why: `${ANKI}a schema 11 collection keeps every deck in one JSON column (col.decks); listing, creating and renaming decks reads and rewrites it as Anki does.`,
  },
  {
    file: 'plusaudio/lib/collection/notes.js', count: 4, kind: 'anki',
    why: `${ANKI}the next new-card position is col.conf's nextPos (JSON) in schema 11, and a JSON-encoded number in the config table in schema 18.`,
  },
  {
    file: 'plusaudio/lib/collection/notetypes.js', count: 1, kind: 'anki',
    why: `${ANKI}a schema 11 collection keeps every note type in one JSON column (col.models).`,
  },
  {
    file: 'plusaudio/lib/deck.js', count: 1, kind: 'anki',
    why: `${ANKI}an .apkg of schema 11 keeps its note types in col.models, JSON, which the CLI reads to find the fields.`,
  },
  {
    file: 'plusaudio/lib/package.js', count: 2, kind: 'anki',
    why: `${ANKI}an older .apkg's media member is a JSON map from member number to file name; reading and writing that package format means reading and writing it.`,
  },
];

/** JavaScript with its comments blanked, lines kept. Strings are kept, so a "//" in a URL does not start a comment. */
function stripJsComments(src) {
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote || (c === '\n' && quote !== '`')) quote = '';
      i++;
    } else if (c === '"' || c === '\'' || c === '`') {
      quote = c; out += c; i++;
    } else if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** Python with its comments and triple-quoted strings (docstrings) blanked, lines kept. */
function stripPyComments(src) {
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const triple = src.slice(i, i + 3);
    if (quote.length === 3) {
      if (triple === quote) { quote = ''; i += 3; continue; }
      if (c === '\n') out += '\n';
      i++;
    } else if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote || c === '\n') quote = '';
      i++;
    } else if (triple === '"""' || triple === '\'\'\'') {
      quote = triple; i += 3;
    } else if (c === '"' || c === '\'') {
      quote = c; out += c; i++;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** Every JSON use in a file's source, as "line: text". */
export function jsonUses(src, file) {
  const py = file.endsWith('.py');
  const hits = [];
  (py ? stripPyComments(src) : stripJsComments(src)).split('\n').forEach((line, n) => {
    for (const m of line.matchAll(py ? PY_JSON : JS_JSON)) hits.push(`${n + 1}: ${m[0].trim()}`);
  });
  return hits;
}

function shippedSources() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0');
  return tracked.filter((f) => f && SOURCE.test(f) && !notShipped(f));
}

/** Each problem with `found` (file -> hits) against `allowed`, as a line a person can act on. */
export function judge(found, allowed) {
  const byFile = new Map(allowed.map((a) => [a.file, a]));
  const problems = [];
  for (const [file, hits] of found) {
    const a = byFile.get(file);
    if (!a) problems.push(`${file}: JSON in a shipped path, and no reason on record\n${hits.map((h) => `      ${h}`).join('\n')}`);
    else if (a.leaving ? hits.length > a.count : hits.length !== a.count) {
      problems.push(`${file}: ${hits.length} JSON use(s), the list allows ${a.leaving ? 'at most' : 'exactly'} ${a.count}\n${hits.map((h) => `      ${h}`).join('\n')}`);
    }
  }
  for (const a of allowed) {
    if (!found.has(a.file) && !a.leaving) problems.push(`${a.file}: allowed ${a.count} JSON use(s) but has none - delete its entry`);
  }
  return problems;
}

function scan() {
  const found = new Map();
  for (const file of shippedSources()) {
    const hits = jsonUses(readFileSync(path.join(ROOT, file), 'utf8'), file);
    if (hits.length) found.set(file, hits);
  }
  return found;
}

test('the scan reads code and not comments, in each language', () => {
  assert.deepEqual(jsonUses('const a = JSON.parse(x);\nconst b = await res.json();\nfork(script, args);\n', 'a.js'),
    ['1: JSON.parse', '2: .json(', '3: fork(']);
  assert.deepEqual(jsonUses('return NextResponse.json({ ok: true })', 'a.js'), ['1: .json(']);
  assert.deepEqual(jsonUses('// it used to JSON.stringify(x)\n/* JSON.parse(a)\n   res.json() */\nconst u = "https://x/y.json"; // .json()\n', 'a.js'), [],
    'a mention in a comment, or a .json file name, is not a use');
  assert.deepEqual(jsonUses('const u = "http://a//b"; JSON.stringify(u)', 'a.js'), ['1: JSON.stringify'], 'a // in a string hides nothing');
  assert.deepEqual(jsonUses('import json\nfrom json import loads\nx = json.loads(raw)\ny = json.dumps(v)\njson.load(f)\njson.dump(v, f)\n', 'a.py'),
    ['1: import json', '2: from json import', '3: json.loads(', '4: json.dumps(', '5: json.load(', '6: json.dump(']);
  assert.deepEqual(jsonUses('# json.loads(x)\n"""\njson.dumps(y)\n"""\nurl = "a#b"; json.loads(z)\n', 'a.py'), ['5: json.loads('],
    'a comment or a docstring is not a use, and a # in a string is not a comment');
  assert.deepEqual(jsonUses('import jsonschema\nmy_json.loads(x)\n', 'a.py'), [], 'other names are not the json module');
});

test('the judge: a new file, a count off either way, and a stale entry fail; a leaving entry may shrink', () => {
  const allowed = [
    { file: 'a.js', count: 2, why: '' },
    { file: 'b.js', count: 2, why: '', leaving: true },
    { file: 'c.js', count: 1, why: '' },
    { file: 'd.py', count: 1, why: '', leaving: true },
  ];
  const ok = new Map([['a.js', ['1', '2']], ['b.js', ['1']], ['c.js', ['1']]]);
  assert.deepEqual(judge(ok, allowed), []);
  assert.equal(judge(new Map([...ok, ['new.js', ['1']]]), allowed).length, 1, 'a new file');
  assert.equal(judge(new Map([...ok, ['a.js', ['1', '2', '3']]]), allowed).length, 1, 'one more than allowed');
  assert.equal(judge(new Map([...ok, ['a.js', ['1']]]), allowed).length, 1, 'one fewer than allowed');
  assert.equal(judge(new Map([...ok, ['b.js', ['1', '2', '3']]]), allowed).length, 1, 'a leaving entry may not grow');
  const gone = new Map(ok);
  gone.delete('c.js');
  assert.equal(judge(gone, allowed).length, 1, 'an entry whose hits are gone');
});

test('the scan covers the shipped code', () => {
  const files = shippedSources();
  // Canaries: if a root moves or the filter starts dropping one, the scan looks at nothing and passes forever.
  for (const must of [
    'src/server/anki/bridgeClient.js', 'src/server/api/anki/decks/route.js', 'ui/server/serve.mjs', 'ui/server/wire.mjs',
    'plusaudio/generate-card-text.js', 'plusaudio/lib/cardGeneration/cardGeneration.ts', `${FOLDER}modelAnswer.js`,
    'anki/addon/amgi_bridge/bridge_server.py', 'anki/addon/amgi_bridge/bridge_ops.py', 'anki/media/_amgi-loop.js',
    'anki/notetype/front.html',
  ]) assert.ok(files.includes(must), `${must} is scanned`);
  assert.ok(!files.some((f) => /(^|\/)(test|__tests__|tools|scripts)\//.test(f)), 'and no test, tool or script is');
});

test('no shipped code parses or formats JSON, but for the uses listed with their reasons', () => {
  assert.equal(new Set(ALLOWED.map((a) => a.file)).size, ALLOWED.length, 'one entry per file');
  const problems = judge(scan(), ALLOWED);
  assert.deepEqual(problems, [],
    `\n${problems.join('\n')}\n\n`
    + 'amgi\'s own boundaries cross as fixed binary layouts (ui/wire/wire.c is the model: one schema table that every\n'
    + `reader and writer walks). If something outside amgi really does force JSON here, put the call in ${FOLDER}\n`
    + 'behind a named function and add it to ALLOWED in test/no-json.test.mjs with who forces it.\n');
});

test('amgi\'s own JSON lives in the one folder, and every entry says why', () => {
  for (const a of ALLOWED) {
    assert.ok(a.why.length > 40, `${a.file}: a reason, not a label`);
    if (a.kind === 'ours') assert.ok(a.file.startsWith(FOLDER), `${a.file}: our own JSON belongs in ${FOLDER}`);
    else assert.ok(['anki', 'ipc', 'addon'].includes(a.kind), `${a.file}: kind ${a.kind}`);
  }
  assert.ok(ALLOWED.find((a) => a.file === `${FOLDER}modelAnswer.js`).why.includes(ANSWER_FORMAT));
});

test('README.md\'s "JSON that remains and why" names exactly the allowed files', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('### JSON that remains and why');
  assert.ok(start >= 0, 'the section exists');
  const rest = readme.slice(start + 1);
  const end = rest.search(/\n#{1,3} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  // The files a list item is about: the backticked paths before its first ": ".
  const named = new Set(section.split('\n').filter((line) => line.startsWith('- '))
    .flatMap((line) => [...line.split(': ')[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])));
  assert.deepEqual([...named].sort(), ALLOWED.map((a) => a.file).sort());
});
