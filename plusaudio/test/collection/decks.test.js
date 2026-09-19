'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, fixtureApkg, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');
const { normalizeComponent } = require('../../lib/collection/decks');

test('normalizeComponent: control characters (including the internal \\x1f separator) are stripped', () => {
  assert.equal(normalizeComponent('Ko\x1frean'), 'Korean');
  // Only the ends are trimmed (name.rs's trim_matches), so an interior colon
  // survives - "spaced" here would be a different (wrong) expectation.
  assert.equal(normalizeComponent('  spaced : name  '), 'spaced : name');
  assert.equal(normalizeComponent(''), 'blank');
  assert.equal(normalizeComponent('   '), 'blank');
});

for (const schema of [11, 18]) {
  test(
    `createDeck (schema ${schema}): creates missing ancestors, dedupes case-insensitively, and Anki agrees`,
    { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
    () => {
      const dir = tempDir();
      const collectionPath = path.join(dir, 'collection.anki2');
      buildFixtureCollection(collectionPath, { downgradeToSchema11: schema === 11 });

      const col = new Collection(collectionPath);
      assert.equal(col.status().schemaVersion, schema);

      const created = col.createDeck('Korean::Verbs');
      assert.equal(created.result.created, true);
      assert.equal(created.result.deck.name, 'Korean::Verbs');

      // Re-requesting the same name, differently cased, must return the
      // existing deck rather than creating a duplicate - the same contract
      // as Anki's own col.decks.id().
      const again = col.createDeck('korean::verbs');
      assert.equal(again.result.created, false);
      assert.equal(again.result.deck.id, created.result.deck.id);

      // Verify against Anki's own library, not just this reader: the deck is
      // listed with the right name and parent, col.decks.id() resolves to
      // the same id, a note added to it lands in it, and the database
      // passes Anki's own integrity check.
      const basic = col.listNotetypes().result.find((n) => n.name === 'Basic');
      const added = col.addNote({ deckId: created.result.deck.id, notetypeId: basic.id, fields: ['f', 'b'] });

      const report = withAnkiLibrary(
        collectionPath,
        `
did = col.decks.id("Korean::Verbs", create=False)
assert did == ${created.result.deck.id}, f"col.decks.id disagrees: {did}"
parent_did = col.decks.id("Korean", create=False)
assert parent_did is not None, "parent deck Korean was not created"
deck = col.decks.get(did)
assert deck["name"] == "Korean::Verbs", deck["name"]
nid = ${added.result.noteId}
cids = [c.id for c in col.get_note(nid).cards()]
assert all(col.db.scalar("select did from cards where id = ?", cid) == did for cid in cids), "note's cards are not in the new deck"
problems = col.fix_integrity()
msg = problems.problems if hasattr(problems, "problems") else problems
print("INTEGRITY:", msg)
print("MEDIA:", col.media.check())
`,
      );
      assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);
      assert.doesNotMatch(report, /missing files: [1-9]/i);

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
}

test(
  'createDeck: a name that only differs from an existing one by Unicode case fold reuses it',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir();
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);
    const col = new Collection(collectionPath);

    const first = col.createDeck('Practice');
    const second = col.createDeck('PRACTICE');
    assert.equal(second.result.created, false);
    assert.equal(second.result.deck.id, first.result.deck.id);

    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test(
  'createDeck against the real fixture deck: nested Korean deck names, non-ASCII throughout',
  { skip: (!anki || !fixtureApkg) && 'requires ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG' },
  () => {
    for (const downgradeToSchema11 of [false, true]) {
      const dir = tempDir();
      const collectionPath = path.join(dir, 'collection.anki2');
      buildFixtureCollection(collectionPath, { importApkg: true, downgradeToSchema11 });

      const col = new Collection(collectionPath);
      const decks = col.listDecks().result;
      assert.ok(decks.some((d) => d.name.includes('Retro')), 'the real deck was imported');

      const created = col.createDeck('Korean::문장::New Practice');
      assert.equal(created.result.created, true);

      const report = withAnkiLibrary(
        collectionPath,
        `
did = col.decks.id("Korean::문장::New Practice", create=False)
assert did == ${created.result.deck.id}
problems = col.fix_integrity()
print("INTEGRITY:", problems.problems if hasattr(problems, "problems") else problems)
`,
      );
      assert.match(report, /INTEGRITY:.*rebuilt and optimized/i);

      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
