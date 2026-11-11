// No JSON in a shipped path.
//
// The owner's rule: JSON is slow to parse and slow to format, so amgi's own boundaries cross as
// fixed binary layouts (the page and its server: ui/wire), and JSON is kept only where something
// outside amgi forces it. This test keeps it that way. It scans every tracked source file that
// ships (not a test, a tool, a script, a fixture or a document) for the calls that parse or
// format JSON, in JavaScript, in C and in the Anki add-on's Python. Every hit must be in ALLOWED below,
// at exactly the count stated, with the reason it stays. A new hit fails. A second hit in an
// allowed file fails. An allowed hit that is gone fails too, so the list cannot outlive what it
// excuses, except for an entry marked `leaving`: work in flight removes those, and they may have
// fewer hits than stated, or none.
//
// amgi's own JavaScript JSON lives in one folder, plusaudio/lib/json, behind one named function per
// use, and its C JSON in one quarantine, server/json, behind three. Outside them there is only
// Anki's own JSON (its collection and package formats, which amgi reads and writes as Anki defines
// them) and the Gemini model's answer, read through the quarantine. The Anki add-on's Python
// is scanned too.
//
// README.md's "JSON that remains and why" names the same files; the last test holds the two
// together.
//
// A mention in a comment is not a hit: comments are stripped first. Package files that tooling
// reads (package.json, the lockfile) and the eslint config are not source and are not scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shippedSources, stripJsComments, stripPyComments } from './source-scan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FOLDER = 'plusaudio/lib/json/';
/**
 * The C quarantine: amgi's C reads and writes JSON only here (server/json/anki_json.h says why), through
 * three named functions: anki_json_parse and anki_json_stringify for Anki's columns, and
 * model_answer_parse for the Gemini model's answer (server/json/model_answer.h).
 */
const C_FOLDER = 'server/json/';

/**
 * JavaScript: JSON.x, .json() (Response.json, NextResponse.json, request.json), and fork(), whose
 * IPC channel Node serializes as JSON unless the call asks for 'advanced' (see BINARY_IPC).
 */
const JS_JSON = /\bJSON\s*\.\s*[A-Za-z_]+|\.json\s*\(|\bfork\s*\(/g;
/**
 * C: a call that parses or formats JSON (the quarantine's anki_json_parse, anki_json_stringify and model_answer_parse,
 * and the entry points of the JSON libraries a C program would reach for: json-c, jansson, cJSON,
 * yyjson, parson), and any JSON library's header. The quarantine's own header may be included;
 * calling into it still counts, file by file.
 */
const C_JSON = /\b(?:anki_json_parse|anki_json_stringify|model_answer_parse|json_(?:loads?|dumps?|parse\w*|tokener_\w+|object_\w+|value_\w+|serialize\w*)|cJSON_\w+|yyjson_\w+)\s*\(|#\s*include\s*[<"](?![^>"]*\b(?:anki_json|model_answer)\.h)[^>"]*(?:json|jansson|parson)[^>"]*[>"]/gi;
/** Python: the json module imported, or any of its four calls. */
const PY_JSON = /^\s*import\s+json\b|^\s*from\s+json\s+import\b|\bjson\s*\.\s*(?:loads|dumps|load|dump)\s*\(/g;

/** A fork() call whose options choose V8's binary clone for the channel: plusaudio/lib/ipcGate.js's FORK_IPC_OPTIONS, or the option written out. */
const BINARY_IPC = /\bFORK_IPC_OPTIONS\b|\bserialization\s*:\s*['"]advanced['"]/;

/** The text of the call whose "(" is at `open`, through its matching ")" (or to the end). */
function callAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

const ANSWER_FORMAT = 'plusaudio/ANSWER_FORMAT.md';
const ANKI = 'FORCED by Anki: ';
/**
 * kind: 'ours' (amgi's own JSON, which must live in FOLDER), 'model' (the Gemini model's answer in C:
 * the quarantine's model_answer_parse and its one caller), or 'anki' (Anki's own formats, read
 * and written where the collection code is).
 */
const ALLOWED = [
  {
    file: `${FOLDER}modelAnswer.js`, count: 1, kind: 'ours',
    why: `FORCED by Gemini: the API's structured output is JSON text, and parseModelAnswer reads it once; the caller then checks every field against its format. ${ANSWER_FORMAT} records what was measured against function calling and labelled lines.`,
  },
  {
    file: `${C_FOLDER}anki_json.c`, count: 2, kind: 'anki',
    why: `${ANKI}the C collection core's one JSON reader and writer (anki_json_parse and anki_json_stringify, defined here), for Anki's JSON columns, written to give the bytes JSON.parse and JSON.stringify gave.`,
  },
  {
    file: `${C_FOLDER}anki_json.h`, count: 2, kind: 'anki',
    why: `${ANKI}the declarations of the C quarantine's two named functions; the header says what Anki stores as JSON and why.`,
  },
  {
    file: `${C_FOLDER}model_answer.c`, count: 2, kind: 'model',
    why: `FORCED by Gemini: model_answer_parse (defined here) reads the model's structured answer, JSON text and nothing else, through the quarantine's one parser (anki_json_parse); the caller then checks every field against its format. ${ANSWER_FORMAT} records what was measured against the alternatives.`,
  },
  {
    file: `${C_FOLDER}model_answer.h`, count: 1, kind: 'model',
    why: 'FORCED by Gemini: the declaration of model_answer_parse, the C reader of the model\'s answer.',
  },
  {
    file: 'server/amgi/cards.c', count: 1, kind: 'model',
    why: `FORCED by Gemini: cardGeneration.ts's readStructured in C reads each structured answer (card text, the audio verdict, the transcript match) once, through model_answer_parse, and checks every field against its format. ${ANSWER_FORMAT}.`,
  },
  {
    file: 'server/collection/decks.c', count: 5, kind: 'anki',
    why: `${ANKI}the C port of decks.js and deck-remove.js: a schema 11 collection's col.decks and col.conf are JSON columns, read and rewritten through the quarantine.`,
  },
  {
    file: 'server/collection/notes.c', count: 5, kind: 'anki',
    why: `${ANKI}the C port of notes.js and notetypes.js: col.models (schema 11), and nextPos in col.conf (schema 11) or the config table (schema 18), through the quarantine.`,
  },
];

/** Every JSON use in a file's source, as "line: text". */
export function jsonUses(src, file) {
  const py = file.endsWith('.py');
  const c = /\.[ch]$/.test(file);
  // C's comments are JavaScript's (and a char literal reads as a short string), so one stripper serves both.
  const code = py ? stripPyComments(src) : stripJsComments(src);
  const hits = [];
  code.split('\n').forEach((line, n) => {
    for (const m of line.matchAll(py ? PY_JSON : c ? C_JSON : JS_JSON)) hits.push({ line: n + 1, text: m[0].trim() });
  });
  if (c) return hits.map((h) => `${h.line}: ${h.text}`);
  if (!py) {
    // A fork that asks for the binary channel is not a JSON use: drop it, looking at the whole call.
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    const binary = new Set();
    for (const m of code.matchAll(/\bfork\s*\(/g)) {
      if (BINARY_IPC.test(callAt(code, m.index + m[0].length - 1))) {
        binary.add(lineStarts.findLastIndex((start) => start <= m.index) + 1);
      }
    }
    return hits.filter((h) => !(h.text.startsWith('fork') && binary.has(h.line))).map((h) => `${h.line}: ${h.text}`);
  }
  return hits.map((h) => `${h.line}: ${h.text}`);
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
  for (const file of shippedSources(ROOT)) {
    const hits = jsonUses(readFileSync(path.join(ROOT, file), 'utf8'), file);
    if (hits.length) found.set(file, hits);
  }
  return found;
}

test('the scan reads code and not comments, in each language', () => {
  assert.deepEqual(jsonUses('const a = JSON.parse(x);\nconst b = await res.json();\nfork(script, args);\n', 'a.js'),
    ['1: JSON.parse', '2: .json(', '3: fork(']);
  assert.deepEqual(jsonUses('return NextResponse.json({ ok: true })', 'a.js'), ['1: .json(']);
  assert.deepEqual(jsonUses('fork(a, b, {\n  stdio: [],\n  ...FORK_IPC_OPTIONS,\n});\nfork(a, b, { serialization: "advanced" });\nfork(a, b, { stdio: [] });\n', 'a.js'),
    ['6: fork('], 'a fork that asks for the binary channel is not a use; one that does not is');
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
  const files = shippedSources(ROOT);
  // Canaries: if a root moves or the filter starts dropping one, the scan looks at nothing and passes forever.
  for (const must of [
    'server/amgi/routes.c', 'server/collection/bridge.c', 'server/app/amgi_app.c', 'ui/wire/wire.mjs', 'ui/wire/wire.c',
    'plusaudio/generate-clip.js', 'plusaudio/lib/cardGeneration/cardGeneration.ts', `${FOLDER}modelAnswer.js`,
    'anki/addon/amgi_bridge/bridge_server.py', 'anki/addon/amgi_bridge/bridge_ops.py', 'anki/src/anki-loop.js',
    'anki/notetype/front.html',
  ]) assert.ok(files.includes(must), `${must} is scanned`);
  assert.ok(!files.some((f) => /(^|\/)(test|tests|__tests__|tools|scripts)\//.test(f)), 'and no test, tool or script is');
});

test('no shipped code parses or formats JSON, but for the uses listed with their reasons', () => {
  assert.equal(new Set(ALLOWED.map((a) => a.file)).size, ALLOWED.length, 'one entry per file');
  const problems = judge(scan(), ALLOWED);
  assert.deepEqual(problems, [],
    `\n${problems.join('\n')}\n\n`
    + 'amgi\'s own boundaries cross as fixed binary layouts (ui/wire/wire.c is the model: one schema table that every\n'
    + `reader and writer walks). If something outside amgi really does force JSON here, put the call in ${FOLDER}\n`
    + 'behind a named function and add it to ALLOWED in tests/repo/no-json.test.mjs with who forces it.\n');
});

test('amgi\'s own JSON lives in the one folder, and every entry says why', () => {
  for (const a of ALLOWED) {
    assert.ok(a.why.length > 40, `${a.file}: a reason, not a label`);
    if (a.kind === 'ours') assert.ok(a.file.startsWith(FOLDER), `${a.file}: our own JSON belongs in ${FOLDER}`);
    else if (a.kind === 'model') assert.ok(a.file.startsWith(C_FOLDER) || a.file === 'server/amgi/cards.c', `${a.file}: the model's answer is read in ${C_FOLDER}, by cards.c alone`);
    else assert.equal(a.kind, 'anki', `${a.file}: kind ${a.kind}`);
  }
  assert.ok(ALLOWED.find((a) => a.file === `${FOLDER}modelAnswer.js`).why.includes(ANSWER_FORMAT));
});

test('C reaches JSON only through the quarantine\'s three named functions', () => {
  for (const [file, hits] of scan()) {
    if (!/\.[ch]$/.test(file) || file.startsWith(C_FOLDER)) continue;
    for (const hit of hits) assert.match(hit, /: (?:anki_json_(?:parse|stringify)|model_answer_parse)\($/, `${file}: ${hit}`);
  }
  // And the scan sees a library call, a library header and the quarantine's own calls, in C.
  assert.deepEqual(jsonUses('#include <jansson.h>\njson_t *v = json_loads(s, 0, &e);\nstr t = anki_json_stringify(a, v); // json_dumps(x)\n', 'x.c'),
    ['1: #include <jansson.h>', '2: json_loads(', '3: anki_json_stringify(']);
  assert.deepEqual(jsonUses('#include "../json/anki_json.h"\nstatic aj *read_col_value(void);\n', 'x.c'), []);
  assert.deepEqual(jsonUses('#include "../json/model_answer.h"\naj *v = model_answer_parse(a, t, &d);\n', 'x.c'), ['2: model_answer_parse(']);
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
