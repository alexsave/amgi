'use strict';

// Builds and holds/releases a fixture Anki collection for this skill's other
// scripts, on top of the exact same real-Anki-library bridge plusaudio's own
// test suite uses to prove its collection reader against reality
// (plusaudio/test/collection/helpers/anki-python.js) - see that file for how
// ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG are resolved, and for why shelling
// out to the real `anki` Python library, not a hand-rolled reader, is what
// makes any of this worth trusting. This is a thin wrapper, not a second
// implementation: reuse it rather than re-deriving it, or the two can drift.
//
// What you need, and how to get it:
//
//   - A Python with the `anki` library importable. `pip install anki` into
//     a fresh virtualenv gets you one (`python3 -m venv .venv && .venv/bin/pip
//     install anki`, or `uv venv && uv pip install anki`); it does not need
//     Anki itself installed, and does not need aqt (Anki's Qt/GUI package).
//     Point ANKI_PYTHON_BIN at that interpreter, or leave it unset to try
//     ANKI_PYTHON_BIN, then `python3`, then `python` on PATH.
//   - A real `.apkg` to seed the fixture from. Any shared deck works - see
//     https://ankiweb.net/shared/decks/ for a small one, or export one from
//     your own Anki. Point ANKI_FIXTURE_APKG at its path.
//
//   ANKI_PYTHON_BIN=/path/to/venv/bin/python \
//   ANKI_FIXTURE_APKG=/path/to/SomeDeck.apkg \
//   node .claude/skills/e2e-ui/scripts/fixture.js [outDir]
//
// Prints the resulting collection.anki2 path on success. outDir defaults to
// .e2e/fixture (gitignored) and is wiped and rebuilt every run, so this is
// safe to re-run as often as you like.

const fs = require('fs');
const path = require('path');
const {
  anki,
  buildFixtureCollection,
  fixtureApkg,
  holdCollectionOpen,
  runPython,
  withAnkiLibrary,
} = require('../../../../plusaudio/test/collection/helpers/anki-python');

function build(outDir) {
  if (!anki) {
    throw new Error(
      'No python with the `anki` library on PATH. Set ANKI_PYTHON_BIN to one - ' +
        'see this file\'s own top-of-file comment for how to get one.',
    );
  }
  if (!fixtureApkg) {
    throw new Error(
      'Set ANKI_FIXTURE_APKG to a real .apkg to seed the fixture from - ' +
        'see this file\'s own top-of-file comment for where to get one.',
    );
  }
  const dir = outDir || path.join(process.cwd(), '.e2e', 'fixture');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const collectionPath = path.join(dir, 'collection.anki2');
  // importApkg pulls ANKI_FIXTURE_APKG in on top of a couple of hand-made
  // decks/notes buildFixtureCollection always seeds, so the fixture has both
  // a real, large deck to page through and a small known-shape one to assert
  // exact values against.
  buildFixtureCollection(collectionPath, { importApkg: true });
  return collectionPath;
}

module.exports = { anki, build, fixtureApkg, holdCollectionOpen, runPython, withAnkiLibrary };

if (require.main === module) {
  try {
    console.log(build(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
