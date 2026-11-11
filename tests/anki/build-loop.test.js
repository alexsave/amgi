'use strict';

// Guards the one thing that makes the Anki template worth shipping: it runs
// amgi's review loop, not a copy of it that drifts.
//
//   node --test tests/anki/    (or npm test at the repo root)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'anki', 'tools', 'build-loop.sh');
const OUTPUT = path.join(ROOT, 'anki', 'media', '_amgi-loop.js');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// The bundle is built, not committed: make -C anki, which this runs, so a stale file cannot be read.
execFileSync('make', ['-s', '-B', '-C', path.join(ROOT, 'anki')]);
const bundle = fs.readFileSync(OUTPUT, 'utf8');
const front = read('anki', 'notetype', 'front.html');
const back = read('anki', 'notetype', 'back.html');
const styling = read('anki', 'notetype', 'styling.css');

test('make -C anki leaves the bundle alone until a source changes', () => {
  const before = fs.statSync(OUTPUT).mtimeMs;
  execFileSync('make', ['-s', '-C', path.join(ROOT, 'anki')]);
  assert.equal(fs.statSync(OUTPUT).mtimeMs, before, 'rebuilt with nothing changed');
});

test('the bundle carries the shared code verbatim, not a paraphrase of it', () => {
  for (const file of ['src/utils/voiceActivity.js', 'src/utils/reviewLoop.js']) {
    const source = read(...file.split('/'));
    // A handful of distinctive whole blocks, rather than the entire file: the
    // build strips module syntax, so only the bodies can match exactly.
    const blocks = source
      .split('\n\n')
      .filter((block) => block.length > 200 && !/^import\b/.test(block.trim()))
      .map((block) => block.replace(/^export\s+/gm, ''));
    assert.ok(blocks.length > 2, `${file}: expected several blocks to compare`);
    for (const block of blocks) {
      assert.ok(bundle.includes(block.trim()), `${file}: this block is not in the bundle:\n${block}`);
    }
  }
});

test('the bundle is a classic script with no module syntax left', () => {
  assert.doesNotMatch(bundle, /^\s*(import|export)\b/m);
  // Parses standalone, which is all an Anki <script src> needs of it.
  assert.doesNotThrow(() => new Function(bundle));
});

// The script reads src/utils and anki/src relative to where it runs, so a temp directory with fake
// sources there is a build of whatever a test wants to refuse.
function buildFake(voice, loop) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-loop-'));
  fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'anki', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'anki', 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'utils', 'voiceActivity.js'), voice);
  fs.writeFileSync(path.join(dir, 'src', 'utils', 'reviewLoop.js'), loop);
  fs.writeFileSync(path.join(dir, 'anki', 'src', 'anki-loop.js'), 'host();\n');
  const out = path.join(dir, 'anki', 'media', 'out.js');
  const run = spawnSync(SCRIPT, [out], { cwd: dir, encoding: 'utf8' });
  const built = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  fs.rmSync(dir, { recursive: true });
  return { run, built };
}

test('the build refuses a dependency a card template could not load', () => {
  const imported = buildFake("import React from 'react';\n", 'const b = 1;\n');
  assert.notEqual(imported.run.status, 0);
  assert.match(imported.run.stderr, /cannot follow this import/);
  assert.equal(imported.built, null, 'and writes nothing');
  const exported = buildFake('export default 1;\n', 'const b = 1;\n');
  assert.notEqual(exported.run.status, 0);
  assert.match(exported.run.stderr, /unsupported export/);
  // The one import the bundle can satisfy by concatenation is allowed through.
  const ok = buildFake('export const a = 1;\n', "import { a } from './voiceActivity.js';\nconst b = a;\n");
  assert.equal(ok.run.status, 0, ok.run.stderr);
  assert.match(ok.built, /\nconst a = 1;\n/);
  assert.match(ok.built, /\nconst b = a;\n/);
  assert.doesNotMatch(ok.built, /^\s*(import|export)\b/m);
});

// Anki decides which files to carry into an .apkg by scanning templates and
// styling for quoted names beginning with an underscore
// (rslib/src/text.rs: UNDERSCORED_REFERENCES, UNDERSCORED_CSS_IMPORTS). If the
// template ever stops matching, the deck would export without its loop.
const UNDERSCORED_REFERENCES = /\[sound:(_[^\]]+)\]|"(_[^"]+)"|'(_[^']+)'|\b(?:src|data)=(_[^ >]+)/g;
const UNDERSCORED_CSS_IMPORTS =
  /(?:@import\s+(?:"(_[^"]*.css)"|'(_[^']*.css)'))|(?:url\(\s*(?:"(_[^"]+)"|'(_[^']+)'|(_.+?))\s*\))/gi;

const matches = (regex, text) =>
  [...text.matchAll(regex)].map((match) => match.slice(1).find(Boolean)).filter(Boolean);

test('Anki will see the loop script as a used media file', () => {
  for (const [name, template] of [
    ['front', front],
    ['back', back],
  ]) {
    assert.deepEqual(
      matches(UNDERSCORED_REFERENCES, template),
      ['_amgi-loop.js'],
      `${name} template: Anki's exporter would not pick up the loop`
    );
  }
});

test('Anki will see the stylesheet as a used media file', () => {
  assert.deepEqual(matches(UNDERSCORED_CSS_IMPORTS, styling), ['_amgi-loop.css']);
});

test('the question side cannot show the answer, because it never renders it', () => {
  const fields = [...front.matchAll(/\{\{([^}#/^]+)\}\}/g)].map((match) => match[1].trim());
  assert.deepEqual(fields, ['CueAudio'], 'the front template may only render the cue audio');
  assert.match(front, /data-amgi-side="front"/);
});

test('nothing in a template can be mistaken for a sound tag', () => {
  // Anki rewrites [sound:...] anywhere in the rendered card, comments
  // included (rslib/src/text.rs, AV_TAGS), which would leave a replay button
  // pointing at a file that does not exist.
  for (const [name, template] of [
    ['front', front],
    ['back', back],
  ]) {
    assert.doesNotMatch(template, /\[sound:/, `${name} template contains a sound tag`);
  }
});

test('the answer side renders the text and both clips', () => {
  const fields = [...back.matchAll(/\{\{([^}#/^]+)\}\}/g)].map((match) => match[1].trim());
  for (const field of ['Cue', 'Target', 'CueAudio', 'TargetAudio']) {
    assert.ok(fields.includes(field), `the back template is missing {{${field}}}`);
  }
});

test('the back template never writes a literal field marker inside a comment', () => {
  // Anki substitutes fields inside HTML comments too (see front.html's own
  // warning about this), so a stray {{FieldName}} left in prose - rather
  // than escaped or reworded - would get replaced with real field content
  // the moment the note type is used, not just when this file is read.
  const comments = [...back.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1]);
  for (const comment of comments) {
    assert.doesNotMatch(comment, /\{\{\w/, `a template comment contains a literal field marker: ${comment}`);
  }
});

test('every action the loop drives exists in a template', () => {
  const host = read('anki', 'src', 'anki-loop.js');
  const wanted = [...host.matchAll(/(?:action|wireReplay)\(root, '([^']+)'/g)].map((match) => match[1]);
  assert.ok(wanted.length >= 6, `expected the host to name several actions, found ${wanted.length}`);
  const offered = [...(front + back).matchAll(/data-amgi-action="([^"]+)"/g)].map((match) => match[1]);
  for (const action of new Set(wanted)) {
    assert.ok(offered.includes(action), `no template offers data-amgi-action="${action}"`);
  }
});
