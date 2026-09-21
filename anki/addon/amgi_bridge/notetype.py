# Installing amgi's own note type into a live collection, from inside Anki.
#
# This exists because of an inconsistency the owner pointed out. amgi already
# reaches into collection.anki2 and creates decks, writes notes and adds media
# without asking anybody to do it by hand - and then the README turned round
# and asked the learner to hand-build a six-field note type and paste three
# files into it. Building the note type is strictly the easier half of what
# this tool already does unattended.
#
# The reason it lives HERE, in the add-on, rather than in the Node collection
# layer next to the deck and note writers, is worth recording. A schema-18
# collection stores note types across three tables whose `config` columns are
# each a protobuf message (notetypes, fields, templates), and writing those by
# hand from Node would mean hard-coding field numbers for messages this repo
# has no vendored copy of and cannot validate against. Anki's own Python API
# is right here, inside the process, and is correct by construction across
# every schema version Anki itself supports. So the website's job is reduced
# to the one thing it genuinely can do safely - copying an add-on folder onto
# disk, which is plain filesystem work - and the collection surgery happens
# where the real API is.
#
# No aqt import, on purpose, the same as core.py: this is exercised by
# test/test_notetype_collection.py against a real anki.collection.Collection.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from anki.collection import Collection

# The name the templates and the app both expect. Changing it orphans every
# note already made with it, so it is a constant rather than a setting.
NOTETYPE_NAME = "amgi Listening"

# Order matters to a human opening Fields..., not to the templates, which
# address fields by name. Cue/Target rather than Prompt/Answer: see
# anki/README.md for the rename and how to migrate a deck off the old names.
FIELD_NAMES = ("Cue", "CueAudio", "Target", "TargetAudio", "Language", "Notes")

# Two cards per note, and the pair is the whole point: one asks you to
# produce the language you are learning, the other asks you to understand it.
# They share every field, so the two directions cannot drift apart in
# content - there is one copy of the text and one copy of each recording, and
# which direction a card is comes down to which recording its front template
# puts in the prompt slot.
#
# Anki builds a card per template per note, but only where the template's
# front renders something (rslib/src/notetype/cardgen.rs), so a note with no
# recording in the learning language simply has no reverse card until it gets
# one.
TEMPLATES = (
    {"name": "Listening", "front": "front", "back": "back"},
    {"name": "Listening reversed", "front": "front_reverse", "back": "back_reverse"},
)

# Both are underscore-prefixed so Anki's own media check treats them as
# deliberately-unreferenced files rather than offering to delete them, and so
# an .apkg export carries them along.
MEDIA_FILES = ("_amgi-loop.js", "_amgi-loop.css")

ASSET_FILES = {
    "front": "front.html",
    "back": "back.html",
    "front_reverse": "front-reverse.html",
    "back_reverse": "back-reverse.html",
    "css": "styling.css",
}


class AssetsMissing(Exception):
    """The card-type assets are not next to this add-on."""


@dataclass
class InstallResult:
    notetype_id: Optional[int] = None
    created: bool = False
    fields_added: list = field(default_factory=list)
    templates_updated: bool = False
    templates_added: list = field(default_factory=list)
    css_updated: bool = False
    media_written: list = field(default_factory=list)
    media_removed: list = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.created
            or self.fields_added
            or self.templates_updated
            or self.templates_added
            or self.css_updated
            or self.media_written
            or self.media_removed
        )

    def summary(self) -> str:
        if not self.changed:
            return f"{NOTETYPE_NAME} is already up to date"
        parts = []
        if self.created:
            parts.append("created the note type")
        if self.fields_added:
            parts.append("added fields " + ", ".join(self.fields_added))
        if self.templates_added:
            parts.append("added the " + ", ".join(self.templates_added) + " card")
        if self.templates_updated:
            parts.append("updated the card templates")
        if self.css_updated:
            parts.append("updated the styling")
        if self.media_written:
            parts.append("wrote " + ", ".join(self.media_written))
        if self.media_removed:
            parts.append(f"cleaned up {len(self.media_removed)} stray media file(s)")
        return f"{NOTETYPE_NAME}: " + "; ".join(parts)


def assets_dir_for(addon_dir: str) -> str:
    """Where the website drops the card type when it installs this add-on."""
    return os.path.join(addon_dir, "cardtype")


def read_assets(assets_dir: str) -> dict:
    """The three template files plus the two media files, as bytes/text.

    Raises AssetsMissing rather than returning a partial set: a note type
    built from half the files would render, which is worse than not being
    built at all, because it would look installed.
    """
    if not os.path.isdir(assets_dir):
        raise AssetsMissing(f"no cardtype assets at {assets_dir}")

    assets = {}
    for key, name in ASSET_FILES.items():
        path = os.path.join(assets_dir, name)
        if not os.path.isfile(path):
            raise AssetsMissing(f"missing {name} in {assets_dir}")
        with open(path, encoding="utf-8") as handle:
            assets[key] = handle.read()

    media = {}
    for name in MEDIA_FILES:
        path = os.path.join(assets_dir, name)
        if not os.path.isfile(path):
            raise AssetsMissing(f"missing {name} in {assets_dir}")
        with open(path, "rb") as handle:
            media[name] = handle.read()
    assets["media"] = media
    return assets


def _existing(col: "Collection"):
    return col.models.by_name(NOTETYPE_NAME)


def ensure_notetype(col: "Collection", assets_dir: str) -> InstallResult:
    """Create or refresh the amgi note type, and its media, in `col`.

    Idempotent, and safe to run on every profile open: an unchanged
    collection is left completely untouched (no mod bump, no USN change), so
    this cannot manufacture a sync conflict just by Anki starting.

    Fields are only ever ADDED, never removed or reordered. A field this
    function does not know about belongs to the learner - they may well have
    added it deliberately - and removing one deletes its contents from every
    note that has it, which is not a thing an automatic startup task should
    ever do.
    """
    assets = read_assets(assets_dir)
    result = InstallResult()

    notetype = _existing(col)
    if notetype is None:
        notetype = _build_new(col, assets)
        col.models.add_dict(notetype)
        notetype = _existing(col)
        result.notetype_id = notetype["id"]
        result.created = True
        result.fields_added = list(FIELD_NAMES)
        result.templates_added = [spec["name"] for spec in TEMPLATES]
        result.media_written = _write_media(col, assets["media"])
        result.media_removed = _remove_orphaned_media(col)
        return result

    result.notetype_id = notetype["id"]
    have = {f["name"] for f in notetype["flds"]}
    for name in FIELD_NAMES:
        if name in have:
            continue
        col.models.add_field(notetype, col.models.new_field(name))
        result.fields_added.append(name)

    # Templates are matched by name and only ever added, never removed: an
    # ordinal that disappears takes its cards - and their review history -
    # with it, which is not something a startup task should ever do on its
    # own. A template whose content has drifted from what this version ships
    # is refreshed in place, which is how a card design update reaches decks
    # that already exist.
    by_name = {t["name"]: t for t in notetype["tmpls"]}
    for index, spec in enumerate(TEMPLATES):
        wanted_front = assets[spec["front"]]
        wanted_back = assets[spec["back"]]
        existing = by_name.get(spec["name"])
        if existing is None and index < len(notetype["tmpls"]) and index == 0 and len(notetype["tmpls"]) == 1:
            # An install from before the reverse card existed: its single
            # template is the forward one under whatever name it was given.
            existing = notetype["tmpls"][0]
            existing["name"] = spec["name"]
            result.templates_updated = True
        if existing is None:
            template = col.models.new_template(spec["name"])
            template["qfmt"] = wanted_front
            template["afmt"] = wanted_back
            col.models.add_template(notetype, template)
            result.templates_added.append(spec["name"])
            continue
        if existing.get("qfmt") != wanted_front or existing.get("afmt") != wanted_back:
            existing["qfmt"] = wanted_front
            existing["afmt"] = wanted_back
            result.templates_updated = True

    if notetype.get("css") != assets["css"]:
        notetype["css"] = assets["css"]
        result.css_updated = True

    if result.fields_added or result.templates_added or result.templates_updated or result.css_updated:
        col.models.update_dict(notetype)

    result.media_written = _write_media(col, assets["media"])
    result.media_removed = _remove_orphaned_media(col)
    return result


def _build_new(col: "Collection", assets: dict) -> dict:
    notetype = col.models.new(NOTETYPE_NAME)
    for name in FIELD_NAMES:
        col.models.add_field(notetype, col.models.new_field(name))
    for spec in TEMPLATES:
        template = col.models.new_template(spec["name"])
        template["qfmt"] = assets[spec["front"]]
        template["afmt"] = assets[spec["back"]]
        col.models.add_template(notetype, template)
    notetype["css"] = assets["css"]
    return notetype


def _write_media(col: "Collection", media: dict) -> list:
    """Write the loop's js/css into the collection's media folder.

    Written straight to the path, NOT through col.media.write_data().

    That call looks like the right one and is the wrong one here, in a way
    that fails silently and cost an evening to find. Anki's media layer treats
    an add as "make sure this content exists under some name": handed a name
    that already exists with DIFFERENT bytes, it does not overwrite, it writes
    a second file with the content hash folded into the name and returns that
    new name. Exactly right for a note's attachments, where the caller stores
    whatever name it is given.

    Exactly wrong for these two, whose names are hard-coded in the card:
    styling.css does `@import url("_amgi-loop.css")` and the templates load
    `<script src="_amgi-loop.js">`. So every profile open dutifully wrote the
    current code into a file the card does not reference, never touched the
    one it does, and reported success - ensure_notetype said "wrote
    _amgi-loop.js" because that is what it asked for. The collection went on
    rendering whichever version happened to land first while a pile of
    _amgi-loop-<sha1>.js built up beside it.

    These files are ours and fixed-name by design - the leading underscore is
    what stops Anki's media check calling them unused - so the plain write is
    the one that belongs here. Anki picks up changed media by scanning the
    folder, so this syncs like any other change.

    Only a file whose bytes differ is written, so a profile already current
    does no media work at all, which matters because every media write is
    something AnkiWeb has to send.
    """
    written = []
    folder = col.media.dir()
    for name, data in media.items():
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            with open(path, "rb") as handle:
                if handle.read() == data:
                    continue
        with open(path, "wb") as handle:
            handle.write(data)
        written.append(name)
    return written


# The wreckage of the bug above: one file per distinct version of the loop
# ever installed, each named for its own content hash and referenced by
# nothing. Anki will not offer to clean them up either, because the leading
# underscore marks a file as deliberately unreferenced, so they would sit
# there being synced forever.
_ORPHAN = re.compile(r"^_amgi-loop-[0-9a-f]{40}\.(js|css)$")


def _remove_orphaned_media(col: "Collection") -> list:
    """Delete the hash-named copies write_data() left behind.

    Deliberately narrow: only a name this add-on can have produced, matched
    whole, with a 40-character hex digest in the one position Anki puts one.
    Anything else in that folder is the learner's or Anki's and is not ours to
    remove. A failed delete is ignored rather than raised - a leftover file is
    untidy, a profile that will not open because of one is not.
    """
    removed = []
    folder = col.media.dir()
    try:
        names = os.listdir(folder)
    except OSError:
        return removed
    for name in names:
        if not _ORPHAN.match(name):
            continue
        try:
            os.remove(os.path.join(folder, name))
            removed.append(name)
        except OSError:
            pass
    return removed
