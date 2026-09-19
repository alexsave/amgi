#!/usr/bin/env python3
"""Check the tool's output against Anki's real importer, not a reading of the docs.

    <python-with-anki> tools/verify-with-anki.py <input.apkg> <package.apkg>...

Builds a collection from the input deck (as the user's existing collection) and
imports each package into it in turn, asserting after every import that the
notes were updated rather than duplicated, that nothing about the existing
cards' scheduling or the review log moved, and that Anki's own media check sees
every generated clip as referenced.

Pass the packages in the order a user would import them. Passing a [sound:] run
followed by an <audio src> run is the interesting case: it is what a learner who
re-generates with --audio-tag html actually does to their collection.

Works on any of the three package layouts, legacy or modern, and prints which
one each package is in.

Needs the `anki` package: python -m venv env && env/bin/pip install anki
"""

import os
import re
import shutil
import sys
import tempfile
import zipfile

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


# The two forms add-audio.js can write. The names are content hashes, so the
# same clip keeps the same filename whichever form points at it.
SOUND_REFERENCE = re.compile(r"\[sound:(plusaudio-[0-9a-f]{20}\.mp3)\]")
HTML_REFERENCE = re.compile(r"""<audio[^>]*\bsrc=["'](plusaudio-[0-9a-f]{20}\.mp3)["']""")


def references(col):
    """Every generated clip each note points at, by form."""
    found = {"sound": [], "html": []}
    for (flds,) in col.db.all("select flds from notes"):
        found["sound"] += SOUND_REFERENCE.findall(flds)
        found["html"] += HTML_REFERENCE.findall(flds)
    return found


def package_references(path, workdir):
    """The same counts, read straight out of the package rather than the collection.

    Comparing the two is what catches an import that silently did nothing: Anki
    only updates a matched note when the incoming copy is newer, so a package
    whose notes carry the same `mod` as the collection's is reported as
    duplicate and its fields never land.

    Read by importing the package into a scratch collection of its own rather
    than by opening its database directly: a modern package's collection is
    zstd-compressed inside the zip, and Anki's own importer is both the only
    reader to hand that can decompress it and the most honest one to use.
    """
    scratch = tempfile.mkdtemp(dir=workdir)
    col = Collection(os.path.join(scratch, "collection.anki2"))
    try:
        import_package(col, path)
        return references(col)
    finally:
        col.close()
        shutil.rmtree(scratch, ignore_errors=True)


PACKAGE_FORMATS = {1: "legacy1", 2: "legacy2", 3: "modern"}


def package_format(path):
    """The layout the package is in, as its `meta` member declares it."""
    with zipfile.ZipFile(path) as package:
        names = set(package.namelist())
        if "meta" not in names:
            return "legacy2" if "collection.anki21" in names else "legacy1"
        meta = package.read("meta")
        version = meta[1] if len(meta) >= 2 and meta[0] == 0x08 else 0
    return PACKAGE_FORMATS.get(version, f"version {version}")


def notes_with_audio(col):
    return col.db.scalar(
        "select count() from notes where flds like '%[sound:plusaudio-%'"
        " or flds like '%<audio%src=\"plusaudio-%'"
    )


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    source, packages = argv[0], argv[1:]

    tmp = tempfile.mkdtemp()
    col = Collection(os.path.join(tmp, "collection.anki2"))

    print(f"seeding a collection from {os.path.basename(source)} ({package_format(source)})")
    print("  ", import_package(col, source))
    base_guids = guids(col)
    base_sched = scheduling(col)
    base_revlog = revlog(col)
    base_notes = col.db.scalar("select count() from notes")
    print(
        f"   notes={base_notes} distinct-guids={len(set(base_guids))} "
        f"cards={len(base_sched)} revlog={len(base_revlog)} with-generated-audio={notes_with_audio(col)}"
    )
    print("")

    for index, package in enumerate(packages, start=1):
        label = f"run {index}"
        print(f"importing {label}: {os.path.basename(package)} ({package_format(package)})")
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
        found = references(col)
        wanted = package_references(package, tmp)
        check(
            f"{label}: the collection now carries the package's references, in its form",
            sorted(found["sound"]) == sorted(wanted["sound"])
            and sorted(found["html"]) == sorted(wanted["html"]),
            f"collection {len(found['sound'])} [sound:] / {len(found['html'])} <audio src>, "
            f"package {len(wanted['sound'])} / {len(wanted['html'])}",
        )
        check(
            f"{label}: the notes now carry generated audio",
            notes_with_audio(col) > 0,
            f"{notes_with_audio(col)} notes, "
            f"{len(found['sound'])} [sound:] and {len(found['html'])} <audio src>",
        )
        check(
            f"{label}: no note ended up pointing at the same clip twice",
            len(found["sound"]) + len(found["html"]) == notes_with_audio(col),
            f"{len(found['sound']) + len(found['html'])} references across "
            f"{notes_with_audio(col)} notes",
        )

        # The reason the template's references are <audio src> and not a bare
        # filename: Anki has to keep counting them as used media, or Check
        # Media offers to delete every clip and an export leaves them behind.
        clips = set(found["sound"]) | set(found["html"])
        media_dir = col.media.dir()
        report = col.media.check()
        unused = sorted(name for name in report.unused if name.startswith("plusaudio-"))
        missing = sorted(name for name in report.missing if name.startswith("plusaudio-"))
        check(
            f"{label}: Anki's media check sees every generated clip as used",
            not unused,
            f"{len(clips)} clips referenced, {len(unused)} reported unused; "
            f"{len(os.listdir(media_dir))} files in the media folder, "
            f"{len(report.unused)} of them unused",
        )
        check(
            f"{label}: Anki's media check finds no generated clip missing",
            not missing,
            f"{len(missing)} missing, {len(report.missing)} missing files overall",
        )
        # The same, for the collection as a whole and not just this tool's
        # clips: a deck that came in clean has to stay clean.
        check(
            f"{label}: Anki's media check reports nothing unused and nothing missing",
            not report.unused and not report.missing,
            f"{len(os.listdir(media_dir))} files in the media folder, "
            f"{len(report.unused)} unused, {len(report.missing)} missing",
        )
        print("")

    absent = []
    media_dir = col.media.dir()
    found = references(col)
    for name in set(found["sound"]) | set(found["html"]):
        if not os.path.exists(os.path.join(media_dir, name)):
            absent.append(name)
    check("every generated reference resolves to a file in the collection", not absent,
          f"{len(absent)} missing")

    col.close()
    print("")
    print("all checks passed" if not FAILURES else f"{len(FAILURES)} check(s) failed")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
