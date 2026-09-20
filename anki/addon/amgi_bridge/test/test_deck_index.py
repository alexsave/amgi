# Does repair_deck_index actually undo what amgi's direct writer does?
#
# This test reproduces the corruption rather than mocking it. It writes a deck
# row the exact way plusaudio/lib/collection/decks.js writes one - with
# ` COLLATE unicase` stripped out of the live schema via PRAGMA
# writable_schema, because node:sqlite has no collation API - then reopens the
# collection with Anki and asserts that Anki cannot schedule the deck. If the
# reproduction ever stops failing, this test is worthless, so it asserts the
# broken state first and only then repairs it.
#
# NOT wired into `npm test`, same as the other collection tests here: the
# `anki` pip package is a large Rust-backed wheel this repo does not otherwise
# depend on. Run it with a Python that has `anki` installed:
#
#   python -m venv anki-test-env && anki-test-env/bin/pip install anki
#   cd anki/addon/amgi_bridge && anki-test-env/bin/python -m unittest test.test_deck_index -v

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from anki.collection import Collection
except ImportError:  # pragma: no cover - the skip path
    Collection = None

from deck_index import repair_deck_index  # noqa: E402


def _write_deck_like_amgi(path: str, deck_id: int, name: str) -> None:
    """Insert a deck the way the Node writer has to: collation stripped.

    This is decks.js's withDecksCollationRelaxed, transliterated. The point
    is the INSERT happening while the schema says `name` is BINARY - that is
    what puts the index entry in a position Anki will not look in.
    """
    db = sqlite3.connect(path)
    original = db.execute("SELECT sql FROM sqlite_master WHERE name = 'decks'").fetchone()[0]
    db.execute("PRAGMA writable_schema = ON")
    db.execute(
        "UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '') WHERE name = 'decks'"
    )
    db.execute("PRAGMA writable_schema = RESET")
    # The blobs are the defaults Anki itself writes for a normal deck; their
    # contents are irrelevant here, only that the row is well formed.
    common = db.execute("SELECT common FROM decks WHERE id = 1").fetchone()[0]
    kind = db.execute("SELECT kind FROM decks WHERE id = 1").fetchone()[0]
    db.execute(
        "INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, 0, -1, ?, ?)",
        (deck_id, name, common, kind),
    )
    db.execute("PRAGMA writable_schema = ON")
    db.execute("UPDATE sqlite_master SET sql = ? WHERE name = 'decks'", (original,))
    db.execute("PRAGMA writable_schema = RESET")
    db.commit()
    db.close()


@unittest.skipIf(Collection is None, "needs the anki library on this interpreter")
class DeckIndexRepairTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="amgi-deckindex-")
        self.path = os.path.join(self.dir, "collection.anki2")
        col = Collection(self.path)
        self.notetype_id = col.models.by_name("Basic")["id"]
        col.close()

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def _add_card(self, col, deck_id: int) -> None:
        note = col.new_note(col.models.get(self.notetype_id))
        note.fields[0] = "front"
        note.fields[1] = "back"
        col.add_note(note, deck_id)

    def test_a_deck_written_the_amgi_way_cannot_be_scheduled_until_repaired(self) -> None:
        # The neighbour matters, and this is the whole subtlety of the bug.
        # A mis-sorted entry is only unreachable when BINARY and unicase
        # actually disagree about where it goes, so the deck next to it has
        # to be one the two collations order differently. "Korean" and
        # "k study" are exactly that pair: ASCII puts every capital before
        # every lowercase letter, so BINARY reads K(75) < k(107) and files
        # "k study" AFTER "Korean", while unicase folds the case first and
        # compares "korean" against "k study", where the space (32) beats
        # o(111) and puts "k study" BEFORE it. Anki then searches the half of
        # the tree the entry is not in.
        #
        # Without a neighbour like that the corrupt entry still happens to be
        # findable, the reproduction quietly passes before the repair, and
        # the test proves nothing. This was written the naive way first and
        # did exactly that.
        col = Collection(self.path)
        col.decks.id("Korean")
        col.close()

        deck_id = 1789945427606
        _write_deck_like_amgi(self.path, deck_id, "k study")

        col = Collection(self.path)
        self._add_card(col, deck_id)

        # The reproduction itself. If this stops holding, the rest of the test
        # proves nothing, so it is asserted rather than assumed: the deck list
        # sees the card and the scheduler does not.
        node = next(n for n in col.sched.deck_due_tree().children if n.name == "k study")
        self.assertEqual(node.new_count, 1, "the deck list should still count the card")
        col.decks.set_current(deck_id)
        self.assertEqual(col.sched.counts(), (0, 0, 0), "the scheduler should not find it yet")

        repair_deck_index(col)

        col.decks.set_current(deck_id)
        self.assertEqual(col.sched.counts(), (1, 0, 0), "the repair should make it schedulable")
        self.assertTrue(col.sched.get_queued_cards(fetch_limit=1).cards)
        col.close()

    def test_the_repair_changes_no_rows(self) -> None:
        col = Collection(self.path)
        col.decks.id("Korean")
        col.close()
        deck_id = 1789945427607
        _write_deck_like_amgi(self.path, deck_id, "k study")
        col = Collection(self.path)
        self._add_card(col, deck_id)
        before = {
            table: col.db.all(f"select * from {table}")
            for table in ("cards", "notes", "decks", "notetypes", "revlog")
        }
        repair_deck_index(col)
        after = {
            table: col.db.all(f"select * from {table}")
            for table in ("cards", "notes", "decks", "notetypes", "revlog")
        }
        # Rebuilding an index must not be able to lose or alter a record. This
        # is what makes running it unconditionally on every profile open a
        # safe default rather than a risk taken for convenience.
        self.assertEqual(before, after)
        col.close()

    def test_a_healthy_collection_is_left_schedulable(self) -> None:
        # Anki's own deck creation goes through the real collation, so there
        # is nothing to fix - and the repair must not break what is already
        # correct.
        col = Collection(self.path)
        deck_id = col.decks.id("made by anki")
        self._add_card(col, deck_id)
        repair_deck_index(col)
        col.decks.set_current(deck_id)
        self.assertEqual(col.sched.counts(), (1, 0, 0))
        col.close()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
