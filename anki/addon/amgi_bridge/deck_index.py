# Repairing the deck-name index after amgi has written to a closed collection.
#
# THE BUG THIS EXISTS FOR, because it is not obvious and it is expensive to
# rediscover. Anki declares `decks.name` as `text NOT NULL COLLATE unicase`,
# and registers `unicase` on its own connections. amgi's direct transport
# (plusaudio/lib/collection/decks.js) writes decks from Node, where
# node:sqlite has no collation API at all - so SQLite refuses to even PLAN a
# statement against that table, and the only way through is to strip
# ` COLLATE unicase` out of the live schema text with PRAGMA writable_schema
# for the duration of the write.
#
# That makes the write succeed and leaves the index wrong. Every entry added
# inside that window is placed using BINARY comparison, because that is what
# the schema said at the time. Restoring the schema afterwards restores the
# DECLARATION, not the ordering already committed to the B-tree, so the entry
# is now sitting in a position Anki's own unicase comparisons will not look
# in. The row is perfectly intact and a table scan finds it - which is why the
# deck list still shows a deck, with a correct new-card count next to it -
# while anything that reaches the deck through the index does not.
#
# Observed on a real collection: a freshly created deck showed "20" in the
# deck list and answered "Congratulations! You have finished this deck for
# now" when opened, because the v3 scheduler could not resolve the deck
# through that index and so gathered no cards for it. `REINDEX decks` alone
# fixed it; reindexing cards, notes or notetypes did not. Tools > Check
# Database fixes it too, for the same reason, which is the workaround anyone
# hits this without the add-on installed has to find on their own.
#
# WHY THE REPAIR LIVES HERE AND NOT IN THE WRITER. A rebuild has to compare
# keys with the real collation, and the writer is precisely the process that
# does not have it: REINDEX from Node either fails outright with "no such
# collation sequence: unicase" against the true schema, or silently rebuilds
# in BINARY inside the relaxed window, which is the bug again. Node cannot
# even reliably DETECT the problem, since the correct lookup is the one it
# cannot plan. Anki has the collation, so Anki is where this belongs.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from anki.collection import Collection


def repair_deck_index(col: "Collection") -> bool:
    """Rebuild the `decks` table's indexes with Anki's own collation.

    Unconditional, and deliberately so. Asking "did amgi write a deck since
    last time" would mean a marker somewhere in the collection, which is one
    more thing to write, to sync, and to get out of step with reality - and
    the question it answers is only worth asking if the answer is expensive.
    It is not: this is one index over one row per deck, so a collection with
    a thousand decks rebuilds a thousand short keys, once, while Anki is
    already opening a database.

    It also writes no rows. REINDEX rebuilds a B-tree from the table it
    already agrees with, so no note, card or deck record is touched, no usn
    or mod moves, and nothing here gives AnkiWeb anything new to sync. That
    is what makes "just always do it" the safe option rather than a
    trade-off.

    @return whether the rebuild ran, so a caller can say so in a test.
    """
    col.db.execute("REINDEX decks")
    return True
