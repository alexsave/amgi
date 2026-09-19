#!/usr/bin/env python3
"""Check the tool's output against Anki's real importer, not a reading of the docs.

    <python-with-anki> tools/verify-with-anki.py <input.apkg> <run1.apkg> <run2.apkg>

Builds a collection from the input deck (as the user's existing collection),
imports run 1 into it, then imports run 2 into the same collection, and asserts
after each import that the notes were updated rather than duplicated and that
nothing about the existing cards' scheduling or the review log moved.

Needs the `anki` package: python -m venv env && env/bin/pip install anki
"""

import os
import sys
import tempfile

import anki.lang

anki.lang.set_lang("en_US")

from anki.collection import Collection  # noqa: E402
from anki.import_export_pb2 import (  # noqa: E402
    ImportAnkiPackageOptions,
    ImportAnkiPackageRequest,
)

FAILURES = []


def check(name, ok, detail=""):
    FAILURES.append(name) if not ok else None
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")


def scheduling(col):
    return {
        row[0]: row[1:]
        for row in col.db.all(
            "select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses from cards"
        )
    }


def revlog(col):
    return col.db.all("select id, cid, ease, ivl, lastIvl, factor, time, type from revlog order by id")


def guids(col):
    return sorted(col.db.list("select guid from notes"))


def import_package(col, path):
    log = col.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=os.path.abspath(path),
            options=ImportAnkiPackageOptions(with_scheduling=True),
        )
    )
    note_log = log.log
    return {
        "new": len(note_log.new),
        "updated": len(note_log.updated),
        "duplicate": len(note_log.duplicate),
        "conflicting": len(note_log.conflicting),
    }


def with_audio(col):
    return col.db.scalar("select count() from notes where flds like '%[sound:plusaudio-%'")


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    source, run1, run2 = argv

    tmp = tempfile.mkdtemp()
    col = Collection(os.path.join(tmp, "collection.anki2"))

    print(f"seeding a collection from {os.path.basename(source)}")
    print("  ", import_package(col, source))
    base_guids = guids(col)
    base_sched = scheduling(col)
    base_revlog = revlog(col)
    base_notes = col.db.scalar("select count() from notes")
    print(
        f"   notes={base_notes} distinct-guids={len(set(base_guids))} "
        f"cards={len(base_sched)} revlog={len(base_revlog)} with-generated-audio={with_audio(col)}"
    )
    print("")

    for label, package in (("run 1", run1), ("run 2", run2)):
        print(f"importing {label}: {os.path.basename(package)}")
        counts = import_package(col, package)
        print("  ", counts)
        notes = col.db.scalar("select count() from notes")
        check(
            f"{label}: no notes added",
            notes == base_notes and counts["new"] == 0,
            f"{notes} notes, {counts['new']} reported new",
        )
        check(f"{label}: no conflicting note types", counts["conflicting"] == 0)
        check(f"{label}: guids unchanged", guids(col) == base_guids)
        check(
            f"{label}: every existing card keeps its scheduling",
            scheduling(col) == base_sched,
            f"{len(base_sched)} cards",
        )
        check(
            f"{label}: review log unchanged",
            revlog(col) == base_revlog,
            f"{len(base_revlog)} rows",
        )
        check(
            f"{label}: the notes now carry generated audio",
            with_audio(col) > 0,
            f"{with_audio(col)} notes",
        )
        print("")

    missing = []
    media_dir = col.media.dir()
    for (flds,) in col.db.all("select flds from notes"):
        for chunk in flds.split("[sound:")[1:]:
            name = chunk.split("]")[0]
            if not os.path.exists(os.path.join(media_dir, name)):
                missing.append(name)
    check("every [sound:] reference resolves to a file in the collection", not missing,
          f"{len(missing)} missing")

    col.close()
    print("")
    print("all checks passed" if not FAILURES else f"{len(FAILURES)} check(s) failed")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
