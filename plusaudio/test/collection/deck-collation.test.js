'use strict';

// Does a deck this package creates actually work in Anki afterwards?
//
// Anki declares decks.name as `text NOT NULL COLLATE unicase` and registers
// that collation on its own connections. node:sqlite has no collation API, so
// SQLite will not even plan a statement against that table from here, and the
// writer's way through is to rewrite the live schema text for the length of
// the write (decks.js's withDecksCollationRelaxed).
//
// What that rewrite says matters enormously, and it is invisible from this
// side. Stripping the collation outright leaves BINARY, which files the new
// index entry by raw byte order - so "k study" lands AFTER "Korean", because
// ASCII puts every capital before every lowercase letter, while Anki's own
// comparison folds the case first and looks for it BEFORE "Korean". The row
// is perfectly intact and a table scan finds it, so the deck list shows a
// card count, and the v3 scheduler - which reaches the deck through that
// index - gathers nothing and says "Congratulations! You have finished this
// deck for now". That was a real bug on a real collection.
//
// Rewriting to NOCASE instead of nothing is what this test guards. NOCASE
// folds ASCII case, which is exactly what unicase does for any name whose
// cased characters are ASCII - verified over several thousand generated
// names, zero disagreements - so the entry is placed correctly at write time
// and needs no repair. Names with non-ASCII CASED letters (é, ß, Cyrillic)
// can still diverge, which is what the add-on's REINDEX at profile open is
// for; this closes the common case at the source rather than after the fact.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { anki, buildFixtureCollection, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');

test(
  'a deck created here is schedulable by Anki with no repair',
  { skip: !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)' },
  () => {
    const dir = tempDir('anki-deck-collation-');
    const collectionPath = path.join(dir, 'collection.anki2');
    buildFixtureCollection(collectionPath);

    // The neighbour is the whole point: a mis-filed entry is only unreachable
    // when byte order and Anki's own order disagree about where it goes.
    // "Korean" and "k study" are exactly that pair - K(75) sorts before
    // k(107) by byte, and after it once the case is folded away.
    withAnkiLibrary(collectionPath, 'col.decks.id("Korean")');

    const created = new Collection(collectionPath).createDeck('k study');
    assert.equal(created.status, 'ok');
    const deckId = created.result.deck.id;

    // Anki opens it cold. No REINDEX, no Check Database, nothing.
    const out = withAnkiLibrary(collectionPath, `
nt = col.models.by_name("Basic")
n = col.new_note(nt)
n.fields[0] = "front"
n.fields[1] = "back"
col.add_note(n, ${deckId})
col.decks.set_current(${deckId})
print(json.dumps({
  "counts": list(col.sched.counts()),
  "serves": bool(col.sched.get_queued_cards(fetch_limit=1).cards),
}))
`);
    const result = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(
      result.counts,
      [1, 0, 0],
      'Anki should find the card; [0,0,0] means the index entry was filed where Anki will not look',
    );
    assert.equal(result.serves, true, 'the scheduler should hand back the card');
  },
);
