'use strict';

// Deleting a deck on the direct transport, proved against Anki itself: one fixture collection is
// copied twice, Anki's own col.decks.remove deletes the deck in one copy and
// lib/collection/deck-remove.js in the other, and the two are then read back with the real Anki
// library and must agree on every row that matters (decks, cards with their deck, due and queue,
// notes, graves, per-deck config, review log, deck options, the schema time). The copy amgi wrote
// must also pass Anki's own integrity checks.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { anki, runPython, tempDir, withAnkiLibrary } = require('./helpers/anki-python');
const { Collection } = require('../../lib/collection');

const skip = !anki && 'no python3 with the anki library on PATH (set ANKI_PYTHON_BIN)';

// The fixture: a tree with a subdeck and a grandchild, a filtered deck inside the tree pulling
// cards from outside it (they must go home, not be deleted), a filtered deck outside the tree
// holding cards whose home is inside (they must be deleted), cards that are new, learning,
// relearning and in review (each goes back to its own queue), a note with one card inside and one
// outside (it must stay), reviews (their log must stay), per-deck config keys, and decks whose
// names differ only by non-ASCII case beside the tree (the name index under a relaxed collation).
// With `defaultInside`, the Default deck is renamed into the tree with a card in it: Anki empties
// it and names it "Default" again rather than removing it.
const BUILD = `
import sys
from anki.collection import Collection
col = Collection(sys.argv[1])
basic = col.models.by_name("Basic")
both = col.models.by_name("Basic (and reversed card)")
def deck(name): return col.decks.id(name)
def add(did, front, nt=basic):
    n = col.new_note(nt); n.fields[0] = front; n.fields[1] = "back " + front
    col.add_note(n, did); return n
def review(card, ease):
    card.start_timer(); col.sched.answerCard(card, ease)
top, child, grand, other = deck("Top"), deck("Top::Child"), deck("Top::Child::Grand"), deck("Other")
for name in ["Top::Café", "CAFÉ", "café 2", "straße", "STRASSE x", "Ölfarbe", "ölfarbe 2", "한국어"]:
    add(deck(name), "in " + name)
a = add(top, "top a"); add(top, "top b"); add(child, "child a"); add(grand, "grand a")
review(a.cards()[0], 3)
o1 = add(other, "other 1"); o2 = add(other, "other 2"); o3 = add(other, "other 3"); add(other, "other 4")
review(o1.cards()[0], 1)          # a learning card
review(o2.cards()[0], 4)          # a review card
review(o3.cards()[0], 4); review(o3.cards()[0], 1)  # a relearning card
split = add(top, "split", both)   # one card in Top, one in Other
c = split.cards()[1]; c.did = other; col.update_card(c)
col.set_config("_deck_%d_lastNotetype" % top, basic["id"])
col.set_config("_deck_%d_lastNotetype" % grand, basic["id"])
col.set_config("_deck_%d_lastNotetype" % other, basic["id"])
inside = col.decks.new_filtered("Top::Filtered")
# without rescheduling, every card in it sits in the review queue until it goes home
d = col.decks.get(inside); d["terms"] = [["deck:Other", 100, 0]]; d["resched"] = False; col.decks.save(d)
col.sched.rebuild_filtered_deck(inside)
outside = col.decks.new_filtered("Elsewhere")
d = col.decks.get(outside); d["terms"] = [['"deck:Top::Child"', 100, 0]]; col.decks.save(d)
col.sched.rebuild_filtered_deck(outside)
if sys.argv[2] == "1":
    default = col.decks.get(1); default["name"] = "Top::Default"; col.decks.save(default)
    add(1, "in default")
col.db.execute("update col set ls = mod")
print(top, col.db.scalar("select count() from cards where did = ?", inside),
      col.db.scalar("select count() from cards where did = ?", outside))
col.close(downgrade=sys.argv[3] == "11")
`;

// Everything about the collection that a delete may change, one row per line, sorted; no
// modification times (those are the moment each side ran).
const DUMP = `
rows = []
for r in col.db.all("select id, name from decks"): rows.append("deck %d %s" % tuple(r))
for r in col.db.all("select id, nid, did, odid, due, odue, queue, type, usn from cards"):
    rows.append("card %d nid=%d did=%d odid=%d due=%d odue=%d queue=%d type=%d usn=%d" % tuple(r))
for r in col.db.all("select id, usn from notes"): rows.append("note %d usn=%d" % tuple(r))
for r in col.db.all("select oid, type, usn from graves"): rows.append("grave %d type=%d usn=%d" % tuple(r))
for r in col.db.all("select key from config where key like '\\\\_deck\\\\_%' escape '\\\\'"): rows.append("config " + r[0])
for r in col.db.all("select id from deck_config"): rows.append("deck_config %d" % r[0])
rows.append("revlog %d" % col.db.scalar("select count() from revlog"))
rows.append("scm %d" % col.db.scalar("select scm from col"))
rows.append("synced-before-edit %s" % (col.db.scalar("select mod > ls from col") == 1))
print("\\n".join(sorted(rows)))
`;

function fixture({ schema = 18, defaultInside = false } = {}) {
  const dir = tempDir('deck-remove-');
  const original = path.join(dir, 'original.anki2');
  const [top, inside, outside] = runPython(BUILD, [original, defaultInside ? '1' : '0', String(schema)]).trim().split(' ').map(Number);
  const facts = { top, filtered_in: inside, filtered_out: outside };
  const copy = (name) => {
    const to = path.join(dir, name);
    fs.mkdirSync(to);
    fs.copyFileSync(original, path.join(to, 'collection.anki2'));
    return path.join(to, 'collection.anki2');
  };
  return { dir, facts, byAnki: copy('anki'), byAmgi: copy('amgi') };
}

function removeWithAnki(collectionPath, deckId) {
  return withAnkiLibrary(collectionPath, `print(col.decks.remove([${deckId}]).count)`).trim();
}

for (const schema of [18, 11]) {
  for (const defaultInside of [false, true]) {
    test(
      `removeDeck (schema ${schema}${defaultInside ? ', Default renamed into the tree' : ''}): the same collection Anki's own remove leaves`,
      { skip },
      () => {
        const { dir, facts, byAnki, byAmgi } = fixture({ schema, defaultInside });
        assert.ok(facts.filtered_in > 0 && facts.filtered_out > 0, 'the fixture has cards in both filtered decks');

        const col = new Collection(byAmgi);
        assert.equal(col.status().schemaVersion, schema);
        const summary = col.deckRemovalSummary(facts.top).result;
        const removed = col.removeDeck(facts.top).result;
        const ankiCount = removeWithAnki(byAnki, facts.top);

        // Anki's count is the cards it deleted; amgi's summary said the same before the delete.
        assert.equal(String(removed.cards), ankiCount);
        assert.equal(summary.cards, removed.cards);
        assert.equal(summary.notes, removed.notes);
        assert.equal(summary.subdecks, defaultInside ? 5 : 4); // Child, Grand, Café, Filtered (+ Default)
        assert.equal(removed.decks, 5); // the Default deck is emptied and renamed, not removed

        const theirs = withAnkiLibrary(byAnki, DUMP);
        const ours = withAnkiLibrary(byAmgi, DUMP);
        assert.equal(ours, theirs);
        assert.match(ours, /grave \d+ type=2 usn=-1/, 'deck graves were written');
        assert.match(ours, /^synced-before-edit True$/m, 'col.mod moved past the last sync');
        if (defaultInside) assert.match(ours, /^deck 1 Default$/m);

        // Anki's own checks of the file amgi wrote: the SQLite integrity check under Anki's real
        // unicase collation (the name index is whole and in order), then Check Database.
        const checked = withAnkiLibrary(
          byAmgi,
          `
print("PRAGMA:", col.db.scalar("pragma integrity_check"))
print("CHECK:", col.fix_integrity())
`,
        );
        assert.match(checked, /^PRAGMA: ok$/m);
        assert.match(checked, /CHECK:.*rebuilt and optimized/is);
        assert.doesNotMatch(checked, /missing|invalid|fixed/i);

        fs.rmSync(dir, { recursive: true, force: true });
      },
    );
  }
}

test('removeDeck: a subdeck alone takes only its own branch', { skip }, () => {
  const { dir, byAnki, byAmgi } = fixture();
  const child = Number(withAnkiLibrary(byAmgi, 'print(col.decks.id("Top::Child", create=False))').trim());
  const removed = new Collection(byAmgi).removeDeck(child).result;
  assert.equal(removed.name, 'Top::Child');
  assert.equal(removed.decks, 2);
  removeWithAnki(byAnki, child);
  assert.equal(withAnkiLibrary(byAmgi, DUMP), withAnkiLibrary(byAnki, DUMP));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeDeck: the Default deck is refused, a missing deck is a 404, and neither changes the file', { skip }, () => {
  const { dir, byAmgi } = fixture();
  const before = withAnkiLibrary(byAmgi, DUMP);
  const col = new Collection(byAmgi);
  assert.throws(() => col.removeDeck(1), (e) => e.status === 400 && /Default deck cannot be deleted/.test(e.message));
  assert.throws(() => col.removeDeck(12345), (e) => e.status === 404);
  assert.throws(() => col.deckRemovalSummary(12345), (e) => e.status === 404);
  assert.equal(withAnkiLibrary(byAmgi, DUMP), before);
  fs.rmSync(dir, { recursive: true, force: true });
});
