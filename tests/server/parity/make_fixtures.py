"""Builds the collection-parity fixtures with the real Anki library: one collection, written twice,
as schema 18 (what current Anki writes) and schema 11 (the same collection downgraded, as an Anki
before 2.1.28 keeps it). The parity runner (tests/server/parity/collection.test.mjs) applies one operation
list to a copy of each, through the Node collection code and through the C one.

    $ANKI_PYTHON_BIN tests/server/parity/make_fixtures.py tests/server/parity/fixtures

The fixtures are committed, so a parity run needs no Python and every run starts from the same
bytes. Run this again only when the fixture's content should change, then update
tests/server/parity/expect/ to match and review every changed line: the recordings are the contract, and
since L4 there is no recorder (PARITY_RECORD went with the Node side).

What is in it, each piece there because an operation in the list needs it:
  decks       Default; "Existing" with the subdeck "Existing::Child"; "Korean::문장"; "Café"; a
              filtered deck "Filtered" holding one card whose home is "Existing"; an empty
              "Empty"; a per-deck config key for Existing (what deck removal clears)
  note types  Basic, Basic (and reversed card), Cloze, and "Retro's sentences" (three fields)
  notes       Basic notes in Existing and its subdeck (one with tags), a reversed note whose two
              cards live in two decks, a cloze note, a Korean note, a Retro note
  media       one clip in collection.media
  sync state  every row usn 0, as a collection that has just synced
"""
import os
import shutil
import sys

from anki.collection import Collection
from anki.scheduler.base import FilteredDeckForUpdate  # noqa: F401  (the import proves the API is there)


def build(path):
    col = Collection(path)
    existing = col.decks.id("Existing")
    child = col.decks.id("Existing::Child")
    korean = col.decks.id("Korean::문장")
    cafe = col.decks.id("Café")
    col.decks.id("Empty")

    basic = col.models.by_name("Basic")
    reversed_nt = col.models.by_name("Basic (and reversed card)")
    cloze = col.models.by_name("Cloze")

    retro = col.models.new("Retro's sentences")
    for name in ("Sentence", "Audio", "Sort"):
        col.models.add_field(retro, col.models.new_field(name))
    t = col.models.new_template("Card 1")
    t["qfmt"] = "{{Sentence}}"
    t["afmt"] = "{{FrontSide}}<hr id=answer>{{Audio}}"
    col.models.add_template(retro, t)
    col.models.add(retro)
    retro = col.models.by_name("Retro's sentences")

    def add(nt, deck, fields, tags=()):
        n = col.new_note(nt)
        for k, v in fields.items():
            n[k] = v
        for tag in tags:
            n.add_tag(tag)
        col.add_note(n, deck)
        return n

    add(basic, existing, {"Front": "existing one", "Back": "b1"})
    add(basic, existing, {"Front": "existing two", "Back": "b2"}, tags=("lyrics", "amgi"))
    add(basic, existing, {"Front": "<b>bold</b> &amp; more", "Back": "b3"})
    add(basic, child, {"Front": "child one", "Back": "c1"})
    split = add(reversed_nt, existing, {"Front": "split front", "Back": "split back"})
    # One of its two cards moves to another deck, so the note outlives a delete of either deck.
    cards = split.cards()
    col.set_deck([cards[1].id], cafe)
    add(cloze, korean, {"Text": "{{c1::안녕}} {{c2::하세요}}", "Back Extra": ""})
    add(basic, korean, {"Front": "역이 어디예요?", "Back": "where is the station"})
    add(retro, korean, {"Sentence": "문장입니다", "Audio": "[sound:clip.ogg]", "Sort": "k"})
    add(basic, cafe, {"Front": "café", "Back": "coffee"})

    # The last note type used in Existing: a per-deck config key ("_deck_<id>_lastNotetype").
    col.set_config(f"_deck_{existing}_lastNotetype", basic["id"])

    filtered = col.sched.get_or_create_filtered_deck(deck_id=0)
    filtered.name = "Filtered"
    filtered.config.search_terms[0].search = '"deck:Existing" "front:existing one"'
    filtered.config.search_terms[0].limit = 10
    col.sched.add_or_update_filtered_deck(filtered)

    # As if just synced: every row usn 0, so a write that forgets to mark its rows pending (usn -1)
    # shows in the parity dump instead of hiding behind rows that were pending anyway.
    for table in ("notes", "cards", "decks", "notetypes", "templates", "deck_config", "config", "tags", "graves", "revlog"):
        col.db.execute(f"update {table} set usn = 0")
    col.db.execute("update col set usn = 0")

    media = os.path.join(os.path.dirname(path), "collection.media")
    os.makedirs(media, exist_ok=True)
    with open(os.path.join(media, "clip.ogg"), "wb") as f:
        f.write(b"OggS fixture clip\n")
    return col


def main(out):
    os.makedirs(out, exist_ok=True)
    for schema in ("18", "11"):
        d = os.path.join(out, f"schema{schema}")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        col = build(os.path.join(d, "collection.anki2"))
        # As small as it gets, through Anki's own connection (it has the unicase collation the
        # name indexes are ordered by).
        col.db.execute("vacuum")
        col.close(downgrade=(schema == "11"))
        for side in ("-wal", "-shm"):
            p = os.path.join(d, "collection.anki2" + side)
            if os.path.exists(p):
                os.remove(p)
    print("built", out)


if __name__ == "__main__":
    main(sys.argv[1])
