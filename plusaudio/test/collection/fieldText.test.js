'use strict';

// A field value with characters Anki will not store as they are: the field separator 0x1f (which
// would otherwise split a field in two, so the note reads back with one field too many), other
// control characters, a carriage return, and text not in Unicode NFC form. The direct writer must
// store exactly what Anki's own add_note and update_note store for the same input, so each case is
// written once by amgi and once by Anki into the same collection, and the rows compared.
// AMGI_COLLECTION_IMPL=<executable> writes amgi's side through that implementation (the C core).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { ankiFields } = require('../../lib/deck');
const { openCollectionUnderTest } = require('./helpers/collection-under-test');

const INPUTS = [
  ['a\x1fb', 'back'],
  ['tab\tand\nline break stay', 'carriage\r\nreturn'],
  ['\x00nul \x01 \x08 \x0b \x0c \x1b esc \x1e \x7f del', 'x'],
  ['é decomposed', '한국어 가'],
  ['plain', '<b>html</b> \x1f'],
  // Text still markup-like after one strip: Anki strips the first field once before its checksum.
  // Fixed in the C core only (PR #30 review finding 2; Node is frozen and strips twice), so these
  // run against the C core alone (test/parity/C_DIFFS.txt names the recordings this changes).
  ...(process.env.AMGI_COLLECTION_IMPL ? [
    ['<b>&lt;i&gt;</b>', 'x'],
    ['x &amp;amp; y', 'x'],
    ['a &amp;lt;b&amp;gt; c', 'x'],
    ['&amp;#65; &amp;nbsp; &lt;!-- c --&gt;', 'x'],
    ['<img src="a&amp;amp;b.png"> &lt;img src=x&gt;', 'x'],
  ] : []),
];

// A JS string as a Python literal, every code point escaped.
const py = (s) => `"${[...s].map((c) => `\\U${c.codePointAt(0).toString(16).padStart(8, '0')}`).join('')}"`;

for (const schema of [11, 18]) {
  test(`schema ${schema}: amgi stores a field's text exactly as Anki's add_note and update_note do`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' }, async () => {
      const dir = tempDir();
      try {
        const collectionPath = path.join(dir, 'collection.anki2');
        buildFixtureCollection(collectionPath, { downgradeToSchema11: schema === 11 });
        const col = await openCollectionUnderTest(collectionPath);
        const basic = (await col.listNotetypes()).find((n) => n.name === 'Basic');
        const deck = await col.createDeck('Field text');

        const added = [];
        for (const fields of INPUTS) added.push((await col.addNote({ deckId: deck.id, notetypeId: basic.id, fields, tags: [] })).noteId);
        // And edited to the same text from something plain.
        const edited = [];
        for (const fields of INPUTS) {
          const id = (await col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['before', 'before'], tags: [] })).noteId;
          await col.updateNote(id, fields);
          edited.push(id);
        }
        await col.close();

        // Anki writes the same inputs through its own API; each line compares a note of ours with Anki's.
        const report = withAnkiLibrary(collectionPath, `
nt = col.models.by_name("Basic")
did = ${deck.id}
inputs = [${INPUTS.map((f) => `[${f.map(py).join(', ')}]`).join(', ')}]
ours_added = [${added.join(', ')}]
ours_edited = [${edited.join(', ')}]
def row(nid):
    return col.db.first("select flds, sfld, csum from notes where id = ?", nid)
for i, fields in enumerate(inputs):
    n = col.new_note(nt)
    n["Front"], n["Back"] = fields
    col.add_note(n, did)
    e = col.new_note(nt)
    e["Front"], e["Back"] = "before", "before"
    col.add_note(e, did)
    e["Front"], e["Back"] = fields
    col.update_note(e)
    for kind, ours, theirs in (("add", ours_added[i], n.id), ("update", ours_edited[i], e.id)):
        a, b = row(ours), row(theirs)
        print(f"{kind} {i} {'same' if a == b else 'DIFFERENT ' + repr(a) + ' vs ' + repr(b)} {len(col.get_note(ours).fields)}")
print("integrity", col.db.scalar("pragma integrity_check"))
`);
        const lines = report.trim().split('\n');
        assert.equal(lines.pop(), 'integrity ok');
        assert.deepEqual(lines, INPUTS.flatMap((_, i) => [`add ${i} same 2`, `update ${i} same 2`]));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
}

test('ankiFields: what Anki keeps and what it removes, character by character', () => {
  assert.deepEqual(ankiFields(['a\x1fb', 'tab\tline\n', 'cr\r', '\x00\x07\x7fz', 'é']), ['ab', 'tab\tline\n', 'cr', 'z', 'é']);
  assert.deepEqual(ankiFields(['\u0085 next line and   nbsp are not ASCII and stay']), ['\u0085 next line and   nbsp are not ASCII and stay']);
});
