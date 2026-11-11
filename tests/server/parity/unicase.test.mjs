// The C core's unicase collation against Anki's own, through what Anki checks: deck names written
// by the C core must leave a name index Anki's integrity check and Check
// Database accept, and the C core must find or make exactly the decks Anki's own col.decks.id makes
// for the same names. The names cover every character whose case fold is more than one code point
// (where Anki's collation, measured, puts a three-code-point fold's third first), the ones Unicode
// folds specially (sigma, dotted I, sharp s), and mixtures of them.
//
// Needs the C core and the anki library; skips with a sentence without either. This compares C with
// real Anki, not with the JavaScript, so it stays after L4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Impl } from './impl-process.mjs';
import { enc } from './protocol.mjs';

const require = createRequire(import.meta.url);
const { anki, runPython } = require('../../../plusaudio/test/collection/helpers/anki-python.js');
const { createRandom } = require('../../../plusaudio/lib/random.js');

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const skip = !anki ? 'needs the anki library (ANKI_PYTHON_BIN)' : false;

/** Every code point whose full case fold is two or three code points, from Python's casefold. */
function expandingFolds() {
  return runPython(`
import sys
out = []
for cp in range(0x80, 0x110000):
    c = chr(cp)
    if 0xd800 <= cp <= 0xdfff: continue
    f = c.casefold()
    if len(f) > 1: out.append(c)
sys.stdout.write("".join(out))
`).split('');
}

test("deck names written by the C core keep Anki's name index whole, and find the decks Anki would", { skip }, () => {
  const expanding = [...expandingFolds().join('')];
  const special = ['ß', 'ẞ', 'SS', 'İ', 'i̇', 'ı', 'I', 'Σ', 'σ', 'ς', 'K', 'k', 'Å', 'å', 'Ä', 'ä', 'é', 'é', 'ǅ', 'ǆ', 'Ǆ'];
  const random = createRandom(20261108);
  const names = [...expanding, ...special];
  for (let i = 0; i < 120; i += 1) {
    let n = '';
    for (let k = 1 + random.int(4); k > 0; k -= 1) n += [...expanding, ...special, 'f', 'F', 'i', 'a'][random.int(expanding.length + special.length + 4)];
    names.push(n);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-unicase-'));
  const ours = path.join(dir, 'ours.anki2');
  const theirs = path.join(dir, 'theirs.anki2');
  fs.copyFileSync(path.join(ROOT, 'tests', 'server', 'parity', 'fixtures', 'schema18', 'collection.anki2'), ours);
  fs.copyFileSync(ours, theirs);
  return (async () => {
    const impl = new Impl();
    await impl.cmd(`open ${enc(ours)}`);
    const refused = [];
    for (const name of names) {
      const answer = await impl.cmd(`createDeck ${enc(name)}`);
      if (!answer.startsWith('ok')) refused.push(`${JSON.stringify(name)}: ${answer}`);
    }
    await impl.close();
    assert.deepEqual(refused, [], 'every name finds or makes a deck');
    fs.writeFileSync(path.join(dir, 'names.txt'), names.join('\n'));
    const out = runPython(`
import sys
from anki.collection import Collection
ours, theirs, names = sys.argv[1], sys.argv[2], open(sys.argv[3], encoding="utf-8").read().split("\\n")
col = Collection(theirs)
for n in names: col.decks.id(n)
anki_names = sorted(d.name for d in col.decks.all_names_and_ids())
col.close()
col = Collection(ours)
print("integrity", col.db.scalar("pragma integrity_check"))
our_names = sorted(d.name for d in col.decks.all_names_and_ids())
problems, ok = col.fix_integrity()
print("check", "clean" if "Fixed" not in problems and "rror" not in problems else problems.replace("\\n", " | "))
print("same decks", our_names == anki_names, len(our_names), len(anki_names))
if our_names != anki_names:
    print("only ours", [n for n in our_names if n not in anki_names][:8])
    print("only anki", [n for n in anki_names if n not in our_names][:8])
col.close()
`, [ours, theirs, path.join(dir, 'names.txt')]);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.match(out, /^integrity ok$/m, out);
    assert.match(out, /^check clean$/m, out);
    assert.match(out, /^same decks True/m, out);
  })();
});
