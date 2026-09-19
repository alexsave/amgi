#!/usr/bin/env node
'use strict';

// Builds anki/media/_amgi-loop.js out of amgi's own source.
//
// The point of this script is that the Anki template does not get its own copy
// of the review loop or of the voice detector. It gets amgi's, verbatim, with
// the ES module syntax removed, because an Anki card template is a classic
// script: the reviewer re-runs <script> tags by cloning them into the page
// (ts/reviewer/index.ts), and a module would neither re-execute nor load on
// clients that serve cards from a non-HTTP origin.
//
// The generated file is committed, because it has to ship as a media file
// inside the collection. anki/test/build-loop.test.js regenerates it and fails
// if the committed copy has drifted, so "edit the web app, forget the deck"
// cannot happen quietly.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(ROOT, 'anki', 'media', '_amgi-loop.js');

// Order matters: the detector is used by the loop, and the loop by the host.
const SHARED = [
  path.join(ROOT, 'src', 'utils', 'voiceActivity.js'),
  path.join(ROOT, 'src', 'utils', 'reviewLoop.js'),
];
const HOST = path.join(ROOT, 'anki', 'src', 'anki-loop.js');

// The only import allowed inside the bundle is one shared file reaching for
// another, which concatenation already satisfies. Anything else means the
// shared code has grown a dependency that cannot cross into a card template,
// and the build should stop rather than emit something subtly broken.
const INTERNAL_IMPORT = /^import\s+\{[^}]+\}\s+from\s+'\.\/(voiceActivity|reviewLoop)';$/;

function toClassicScript(source, file) {
  return source
    .split('\n')
    .map((line, index) => {
      const where = `${path.relative(ROOT, file)}:${index + 1}`;
      if (/^\s*import\b/.test(line)) {
        if (INTERNAL_IMPORT.test(line.trim())) return null;
        throw new Error(`${where}: a card template cannot follow this import: ${line.trim()}`);
      }
      if (/^\s*export\s+default\b/.test(line) || /^\s*export\s*\{/.test(line)) {
        throw new Error(`${where}: unsupported export form: ${line.trim()}`);
      }
      return line.replace(/^export\s+(?=(const|let|var|function|async|class)\b)/, '');
    })
    .filter((line) => line !== null)
    .join('\n')
    .trim();
}

function build() {
  const parts = SHARED.map((file) => ({
    file,
    code: toClassicScript(fs.readFileSync(file, 'utf8'), file),
  }));
  parts.push({ file: HOST, code: fs.readFileSync(HOST, 'utf8').trim() });

  const banner = [
    '// GENERATED FILE - do not edit.',
    '//',
    '// Built by anki/tools/build-loop.js from:',
    ...parts.map((part) => `//   ${path.relative(ROOT, part.file)}`),
    '//',
    '// Run `node anki/tools/build-loop.js` after changing any of them.',
    '// The leading underscore is deliberate: Anki never reports a media file',
    '// whose name starts with one as unused (rslib/src/media/check.rs), and the',
    '// quoted "_amgi-loop.js" in the card template is what makes the exporter',
    '// carry it into an .apkg (rslib/src/text.rs, UNDERSCORED_REFERENCES).',
  ].join('\n');

  const body = parts
    .map((part) => {
      const name = path.relative(ROOT, part.file);
      return `// ---- ${name} ${'-'.repeat(Math.max(3, 70 - name.length))}\n\n${part.code}`;
    })
    .join('\n\n');

  return `${banner}\n\n(function () {\n'use strict';\n\n${body}\n\n})();\n`;
}

module.exports = { build, toClassicScript, OUTPUT };

if (require.main === module) {
  const generated = build();
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;
  if (current === generated) {
    process.stdout.write(`${path.relative(ROOT, OUTPUT)} is up to date\n`);
  } else {
    fs.writeFileSync(OUTPUT, generated);
    process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
  }
}
