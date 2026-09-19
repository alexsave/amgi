'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, fixtureApkg, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');

function setUp(schema) {
  const dir = tempDir();
  const collectionPath = path.join(dir, 'collection.anki2');
  buildFixtureCollection(collectionPath, { downgradeToSchema11: schema === 11 });
  return { dir, collectionPath, col: new Collection(collectionPath) };
}

for (const schema of [11, 18]) {
  test(
    `addNote (schema ${schema}): the sync/note-creation bookkeeping, checked against the real Anki library`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, collectionPath, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Notes Test').result.deck;

      const added = col.addNote({
        deckId: deck.id,
        notetypeId: basic.id,
        fields: ['front <b>text</b>', 'back text'],
        tags: ['korean', 'greeting'],
      }).result;
      assert.equal(added.cardIds.length, 1);
      assert.match(added.guid, /^[!-~]{5,}$/, 'guid should be printable base-91 characters');

      const report = withAnkiLibrary(
        collectionPath,
        `
n = col.get_note(${added.noteId})
assert dict(n.items()) == {"Front": "front <b>text</b>", "Back": "back text"}, dict(n.items())
assert n.guid == ${JSON.stringify(added.guid)}
assert set(n.tags) == {"korean", "greeting"}, n.tags
assert n.usn == -1, n.usn
card = n.cards()[0]
assert card.id == ${added.cardIds[0]}
assert card.did == ${deck.id}
assert card.type == 0 and card.queue == 0, (card.type, card.queue)
assert card.usn == -1, card.usn
mod = col.db.scalar("select mod from col")
ls = col.db.scalar("select ls from col")
assert mod > ls, (mod, ls)
problems = col.fix_integrity()
print("INTEGRITY:", problems.problems if hasattr(problems, "problems") else problems)
print("MEDIA:", col.media.check())
`,
      );
      assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);
      assert.match(report, /MEDIA:.*Missing files:.*0/is);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  test(
    `updateNote (schema ${schema}): field/sfld/csum update round-trips through the real Anki library`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, collectionPath, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Update Test').result.deck;
      const added = col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['before', 'b'] }).result;

      col.updateNote(added.noteId, ['AFTER', 'b']);

      const report = withAnkiLibrary(
        collectionPath,
        `
n = col.get_note(${added.noteId})
assert n["Front"] == "AFTER", n["Front"]
assert n.usn == -1, n.usn
row = col.db.first("select sfld, csum from notes where id = ?", ${added.noteId})
assert row[0] == "AFTER", row
found = col.find_notes("AFTER")
assert ${added.noteId} in found, "search index (sfld) was not updated to match the new field text"
`,
      );
      assert.equal(report.trim(), '');

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  test(
    `listNotesInDeck (schema ${schema}): pagination never returns more than the page size, and covers every note`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, collectionPath, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Pagination Test').result.deck;
      const wanted = 25;
      for (let i = 0; i < wanted; i += 1) {
        col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: [`front ${i}`, `back ${i}`] });
      }

      const seen = new Set();
      let offset = 0;
      const pageSize = 7;
      for (;;) {
        const page = col.listNotesInDeck(deck.id, { offset, limit: pageSize }).result;
        assert.ok(page.length <= pageSize);
        if (page.length === 0) break;
        for (const note of page) seen.add(note.id);
        offset += pageSize;
      }
      assert.equal(seen.size, wanted);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}

test(
  'addNote against the real fixture: a custom note type ("Retro\'s sentences") with an apostrophe in its name',
  { skip: (!anki || !fixtureApkg) && 'requires ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath, { importApkg: true });
    const col = new Collection(collectionPath);

    const notetypes = col.listNotetypes().result;
    const retro = notetypes.find((n) => n.name.includes('Retro'));
    assert.ok(retro, 'the real note type was imported');
    assert.equal(retro.fieldNames.length, 3);

    const deck = col.createDeck('Korean::문장::Fresh Cards').result.deck;
    const added = col.addNote({
      deckId: deck.id,
      notetypeId: retro.id,
      fields: ['새 문장입니다', '[sound:clip.mp3]', 'sort-key'],
    }).result;
    assert.equal(added.cardIds.length, 1);

    const report = withAnkiLibrary(
      collectionPath,
      `
n = col.get_note(${added.noteId})
assert n["Korean"] == "새 문장입니다", n["Korean"]
problems = col.fix_integrity()
print("INTEGRITY:", problems.problems if hasattr(problems, "problems") else problems)
`,
    );
    assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);

    fs.rmSync(dir, { recursive: true, force: true });
  },
);
