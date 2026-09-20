'use strict';

// A bridge to the real Anki library, used only by tests: this package's own
// code never shells out to Python, but proving it against Anki's own
// implementation - not just against its own reader - is the whole point of
// this test suite (see the task this was built from: "an assertion that only
// your own reader agrees with your own writer proves nothing").
//
// None of this is required to exist for `npm test` to pass elsewhere: every
// test that needs it skips cleanly when no working `python3 -c "import
// anki"` can be found, via ANKI_PYTHON_BIN or a plain `python3` on PATH.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findPython() {
  const candidates = [process.env.ANKI_PYTHON_BIN, 'python3', 'python'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import anki.buildinfo; print(anki.buildinfo.buildhash)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) return { bin: candidate, buildhash: probe.stdout.trim() };
  }
  return null;
}

const anki = findPython();

function findFixtureApkg() {
  const candidates = [process.env.ANKI_FIXTURE_APKG].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

const fixtureApkg = findFixtureApkg();

/** Run a Python script (as a string) with the anki library importable, returning stdout. */
function runPython(script, args = []) {
  if (!anki) throw new Error('anki python library not available; guard callers with anki !== null');
  const result = spawnSync(anki.bin, ['-c', script, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`python script failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

/** A fresh temp directory to build a fixture collection in. */
function tempDir(prefix = 'anki-collection-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a fresh collection at `collectionPath` (schema 18, as any current
 * Anki writes), seeded with a couple of decks/notes so tests have something
 * pre-existing to check against, and optionally importing the real
 * ANKI_FIXTURE_APKG deck. Returns nothing; inspect the file afterwards.
 */
function buildFixtureCollection(collectionPath, { importApkg = false, downgradeToSchema11 = false } = {}) {
  const script = `
import sys
from anki.collection import Collection
p = sys.argv[1]
col = Collection(p)
col.decks.id("Existing::Child")
nt = col.models.by_name("Basic")
n = col.new_note(nt); n['Front'] = 'existing'; n['Back'] = 'b'
col.add_note(n, col.decks.id("Existing"))
${
  importApkg
    ? `
from anki.collection import ImportAnkiPackageRequest
col.import_anki_package(ImportAnkiPackageRequest(package_path=sys.argv[2]))
`
    : ''
}
col.close(downgrade=${downgradeToSchema11 ? 'True' : 'False'})
`;
  const args = importApkg ? [collectionPath, fixtureApkg] : [collectionPath];
  runPython(script, args);
}

/** Open `collectionPath` with the real anki library and run `body` (python source, using `col`). */
function withAnkiLibrary(collectionPath, body) {
  const script = `
import sys, json
from anki.collection import Collection
p = sys.argv[1]
col = Collection(p)
${body}
col.close()
`;
  return runPython(script, [collectionPath]);
}

/**
 * Open `collectionPath` with the real anki library and keep it open (holding
 * the exclusive lock a running Anki would hold) until `release()` is called.
 * Used to prove this package's lock detection against a real Anki-shaped
 * lock, not a simulation of one.
 */
function holdCollectionOpen(collectionPath) {
  const script = `
import sys
from anki.collection import Collection
col = Collection(sys.argv[1])
print("HELD", flush=True)
sys.stdin.readline()
col.close()
print("RELEASED", flush=True)
`;
  const child = spawn(anki.bin, ['-c', script, collectionPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const held = new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => {
      if (chunk.toString().includes('HELD')) resolve();
      else reject(new Error(`unexpected output from holder: ${chunk}`));
    });
    child.once('error', reject);
  });
  function release() {
    return new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.write('\n');
      child.stdin.end();
    });
  }
  return { held, release };
}

module.exports = {
  anki,
  buildFixtureCollection,
  fixtureApkg,
  holdCollectionOpen,
  runPython,
  tempDir,
  withAnkiLibrary,
};
