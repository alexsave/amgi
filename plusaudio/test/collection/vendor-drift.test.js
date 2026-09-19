'use strict';

// The files under plusaudio/vendor/anki-src/ are byte-for-byte copies of Anki's own
// source, with a 3-line citation header prepended (see any of them). Our hand-rolled
// SQL and protobuf encodings are written against the copy checked in here, so a
// silent edit to a vendored file would make the citations in lib/collection/ lie.
//
// This test guards against that by diffing the vendored copy against the real
// upstream clone, when one happens to be on disk. It is not wired to fetch the
// clone itself - that would make `pnpm test` depend on network access - so when no
// clone is found the check is skipped rather than failed. Set ANKI_SRC_DIR to point
// at a checkout of github.com/ankitects/anki to run it for real.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const VENDOR_ROOT = path.join(__dirname, '..', '..', 'vendor', 'anki-src');

const VENDORED_FILES = [
  'proto/anki/decks.proto',
  'proto/anki/notetypes.proto',
  'rslib/src/storage/note/add.sql',
  'rslib/src/storage/note/update.sql',
  'rslib/src/storage/schema11.sql',
  'rslib/src/storage/deck/alloc_id.sql',
  'rslib/src/storage/deck/add_or_update_deck.sql',
  'rslib/src/storage/card/add_card.sql',
];

// The header we prepend to every vendored file: 3 comment lines plus the blank line
// that separates them from the real upstream content.
function stripCitationHeader(text) {
  const lines = text.split('\n');
  return lines.slice(4).join('\n');
}

function findAnkiSrcDir() {
  const candidates = [process.env.ANKI_SRC_DIR].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'Cargo.toml'))) return candidate;
  }
  return null;
}

const ankiSrcDir = findAnkiSrcDir();

test('vendored anki-src files have citation headers', () => {
  for (const rel of VENDORED_FILES) {
    const text = fs.readFileSync(path.join(VENDOR_ROOT, rel), 'utf8');
    assert.match(text.split('\n')[0], /^(\/\/|--) Vendored from github\.com\/ankitects\/anki/, rel);
    assert.match(text.split('\n')[1], new RegExp(`Upstream path: ${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), rel);
  }
});

test('vendored anki-src files match upstream (skipped without ANKI_SRC_DIR)', { skip: !ankiSrcDir }, () => {
  for (const rel of VENDORED_FILES) {
    const vendored = stripCitationHeader(fs.readFileSync(path.join(VENDOR_ROOT, rel), 'utf8'));
    const upstream = fs.readFileSync(path.join(ankiSrcDir, rel), 'utf8');
    assert.equal(vendored, upstream, `${rel} has drifted from upstream; re-vendor it and re-check every citation`);
  }
});
