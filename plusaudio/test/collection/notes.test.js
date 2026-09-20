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

for (const schema of [11, 18]) {
  test(
    `countNotesInDeck (schema ${schema}): matches the number of rows listNotesInDeck actually pages through`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Count Test').result.deck;

      // A brand new deck starts at zero, not undefined or an error.
      assert.equal(col.countNotesInDeck(deck.id).result, 0);

      for (let i = 0; i < 5; i += 1) {
        col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: [`front ${i}`, `back ${i}`] });
      }
      assert.equal(col.countNotesInDeck(deck.id).result, 5);

      // Paging through with a small page size must visit exactly that many
      // notes, no more and no fewer than the count reports - the property
      // that makes the count trustworthy for a pager built on top of it.
      let seen = 0;
      let offset = 0;
      for (;;) {
        const page = col.listNotesInDeck(deck.id, { offset, limit: 2 }).result;
        seen += page.length;
        if (page.length < 2) break;
        offset += 2;
      }
      assert.equal(seen, 5);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}

// The romanisation guard (cardText.ts's flagRomanizedFields): a soft warning
// on the returned result, never a thrown error - see that file's own
// docstring for why a hand-authored note is warned about, not refused.
test(
  'addNote warns when a non-Latin-script note is written entirely in Latin letters',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const { dir, col } = setUp(18);
    const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
    const deck = col.createDeck('Romanisation Test').result.deck;

    // Basic's fields are ["Front", "Back"]; index 1 ("Back") is the field the
    // caller identifies as the learning-language text, the same way
    // CardForm.js's own "read aloud" field picker would.
    const romanized = col.addNote({
      deckId: deck.id,
      notetypeId: basic.id,
      fields: ['hello', 'annyeonghaseyo'],
      language: 'ko',
      learningFieldIndex: 1,
    }).result;
    assert.match(romanized.warning, /Back/);
    assert.match(romanized.warning, /ko/);

    const native = col.addNote({
      deckId: deck.id,
      notetypeId: basic.id,
      fields: ['hello', '안녕하세요'],
      language: 'ko',
      learningFieldIndex: 1,
    }).result;
    assert.equal(native.warning, undefined, 'real Hangul must not be flagged');

    // Pointing the check at "Front" (index 0, "hello") instead of "Back"
    // demonstrates it only ever looks at the ONE field it is told about: the
    // check does not know or guess which field is the known-language side,
    // it trusts the caller entirely, which is why a real add-note form must
    // pass its own "read aloud" field choice as learningFieldIndex rather
    // than leaving it unset.
    const wrongFieldPointedAt = col.addNote({
      deckId: deck.id,
      notetypeId: basic.id,
      fields: ['hello', '안녕하세요'],
      language: 'ko',
      learningFieldIndex: 0,
    }).result;
    assert.match(wrongFieldPointedAt.warning, /Front/);

    const noLanguage = col.addNote({
      deckId: deck.id,
      notetypeId: basic.id,
      fields: ['hello', 'annyeonghaseyo'],
      learningFieldIndex: 1,
    }).result;
    assert.equal(noLanguage.warning, undefined, 'omitting language must skip the check entirely');

    const noFieldIndex = col.addNote({
      deckId: deck.id,
      notetypeId: basic.id,
      fields: ['hello', 'annyeonghaseyo'],
      language: 'ko',
    }).result;
    assert.equal(noFieldIndex.warning, undefined, 'omitting learningFieldIndex must skip the check entirely');

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

for (const schema of [11, 18]) {
  test(
    `listFieldValuesInDeck (schema ${schema}): returns one field's value for every note of that note type in the deck`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Bulk Add Test').result.deck;
      col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['line one', 'a'] });
      col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['line two', 'b'] });

      const values = col.listFieldValuesInDeck(deck.id, basic.id, 0).result;
      assert.deepEqual(values.sort(), ['line one', 'line two']);

      // A different field index off the same notes - proving this reads the
      // requested column, not always field 0.
      const backValues = col.listFieldValuesInDeck(deck.id, basic.id, 1).result;
      assert.deepEqual(backValues.sort(), ['a', 'b']);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  test(
    `listFieldValuesInDeck (schema ${schema}): scoped to the requested note type, an empty deck returns nothing`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const cloze = col.listNotetypes().result.find((n) => n.name === 'Cloze');
      const deck = col.createDeck('Scoped Test').result.deck;
      col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['basic front', 'basic back'] });
      col.addNote({ deckId: deck.id, notetypeId: cloze.id, fields: ['a {{c1::cloze}} note', 'extra'] });

      assert.deepEqual(col.listFieldValuesInDeck(deck.id, basic.id, 0).result, ['basic front']);

      const emptyDeck = col.createDeck('Truly Empty').result.deck;
      assert.deepEqual(col.listFieldValuesInDeck(emptyDeck.id, basic.id, 0).result, []);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}

test(
  'updateNote warns the same way addNote does',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const { dir, col } = setUp(18);
    const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
    const deck = col.createDeck('Romanisation Update Test').result.deck;
    const added = col.addNote({ deckId: deck.id, notetypeId: basic.id, fields: ['hello', '안녕'] }).result;

    const updated = col.updateNote(added.noteId, ['hello', 'annyeong'], 'ko', 1).result;
    assert.match(updated.warning, /Back/);

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// Regression coverage for a real cross-transport bug found while hardening
// this layer against real collections: countNotesInDeck, listNotesInDeck and
// noteFieldValuesInDeck used to match only `c.did = ?`, so a deck with
// subdecks (the norm for anyone organizing a real collection, and the exact
// shape the bridge side already handled - see
// anki/addon/amgi_bridge/test/test_bridge_ops.py's own
// test_subdeck_notes_are_included) would show fewer notes here than the
// bridge transport reports for the identical collection file. Browsing the
// same deck must not depend on whether Anki happens to be open.
for (const schema of [11, 18]) {
  test(
    `countNotesInDeck/listNotesInDeck/listFieldValuesInDeck (schema ${schema}): include notes from subdecks, at every depth`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const parent = col.createDeck('Subdeck Test').result.deck;
      const child = col.createDeck('Subdeck Test::Verbs').result.deck;
      const grandchild = col.createDeck('Subdeck Test::Verbs::Irregular').result.deck;
      const unrelated = col.createDeck('Subdeck Test Sibling').result.deck;

      col.addNote({ deckId: parent.id, notetypeId: basic.id, fields: ['p', 'p2'] });
      col.addNote({ deckId: child.id, notetypeId: basic.id, fields: ['c', 'c2'] });
      col.addNote({ deckId: grandchild.id, notetypeId: basic.id, fields: ['g', 'g2'] });
      col.addNote({ deckId: unrelated.id, notetypeId: basic.id, fields: ['u', 'u2'] });

      assert.equal(col.countNotesInDeck(parent.id).result, 3, 'parent + child + grandchild, not the sibling');
      assert.equal(col.countNotesInDeck(unrelated.id).result, 1, 'a deck that only looks similarly named is untouched');

      const fronts = col.listNotesInDeck(parent.id, { limit: 10 }).result.map((n) => n.fields[0]).sort();
      assert.deepEqual(fronts, ['c', 'g', 'p']);

      const values = col.listFieldValuesInDeck(parent.id, basic.id, 0).result.sort();
      assert.deepEqual(values, ['c', 'g', 'p']);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}

// addNotesBulk: the direct-mode equivalent of bridge_ops.add_notes_bulk - one
// collection open/notetypes-read for the whole batch, per-note validation
// isolated so one bad note doesn't abort notes already added earlier in the
// same call. Added while hardening this layer against a real, measured bug:
// a caller looping over addNote() reopened (and, before an earlier fix in
// this same hardening pass, fully re-copied) the whole collection file once
// per note, which made a bulk paste's cost scale with the collection's own
// size, not just the batch size.
for (const schema of [11, 18]) {
  test(
    `addNotesBulk (schema ${schema}): every note lands, in one call, checked against the real Anki library`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, collectionPath, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Bulk Notes Test').result.deck;

      const notes = Array.from({ length: 12 }, (_, i) => ({
        deckId: deck.id,
        notetypeId: basic.id,
        fields: [`bulk front ${i}`, `bulk back ${i}`],
      }));
      const results = col.addNotesBulk(notes).result;
      assert.equal(results.length, 12);
      assert.ok(results.every((r) => r.ok), JSON.stringify(results));

      const report = withAnkiLibrary(
        collectionPath,
        `
count = col.db.scalar("select count(*) from notes where id in (${results.map((r) => r.noteId).join(',')})")
assert count == 12, count
problems = col.fix_integrity()
print("INTEGRITY:", problems.problems if hasattr(problems, "problems") else problems)
`,
      );
      assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  test(
    `addNotesBulk (schema ${schema}): one bad note in the middle is reported on its own, the rest still land`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const { dir, col } = setUp(schema);
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const deck = col.createDeck('Bulk Partial Failure Test').result.deck;

      const results = col.addNotesBulk([
        { deckId: deck.id, notetypeId: basic.id, fields: ['ok one', 'b1'] },
        { deckId: deck.id, notetypeId: basic.id, fields: ['wrong field count'] }, // Basic wants 2 fields
        { deckId: deck.id, notetypeId: 999999999, fields: ['unknown notetype', 'b'] },
        { deckId: deck.id, notetypeId: basic.id, fields: ['ok two', 'b2'] },
      ]).result;

      assert.deepEqual(
        results.map((r) => r.ok),
        [true, false, false, true],
      );
      assert.match(results[1].error, /has 2 fields, got 1/);
      assert.match(results[2].error, /no note type with id/);
      assert.equal(col.countNotesInDeck(deck.id).result, 2, 'the two good notes still landed');

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}
