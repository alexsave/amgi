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

TEMPLATE_NAME = "Listening"

# Both are underscore-prefixed so Anki's own media check treats them as
# deliberately-unreferenced files rather than offering to delete them, and so
# an .apkg export carries them along.
MEDIA_FILES = ("_amgi-loop.js", "_amgi-loop.css")

ASSET_FILES = {
    "front": "front.html",
    "back": "back.html",
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
    css_updated: bool = False
    media_written: list = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.created
            or self.fields_added
            or self.templates_updated
            or self.css_updated
            or self.media_written
        )

    def summary(self) -> str:
        if not self.changed:
            return f"{NOTETYPE_NAME} is already up to date"
        parts = []
        if self.created:
            parts.append("created the note type")
        if self.fields_added:
            parts.append("added fields " + ", ".join(self.fields_added))
        if self.templates_updated:
            parts.append("updated the card templates")
        if self.css_updated:
            parts.append("updated the styling")
        if self.media_written:
            parts.append("wrote " + ", ".join(self.media_written))
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
        result.media_written = _write_media(col, assets["media"])
        return result

    result.notetype_id = notetype["id"]
    have = {f["name"] for f in notetype["flds"]}
    for name in FIELD_NAMES:
        if name in have:
            continue
        col.models.add_field(notetype, col.models.new_field(name))
        result.fields_added.append(name)

    if not notetype["tmpls"]:
        template = col.models.new_template(TEMPLATE_NAME)
        template["qfmt"] = assets["front"]
        template["afmt"] = assets["back"]
        col.models.add_template(notetype, template)
        result.templates_updated = True
    else:
        template = notetype["tmpls"][0]
        if template.get("qfmt") != assets["front"] or template.get("afmt") != assets["back"]:
            template["qfmt"] = assets["front"]
            template["afmt"] = assets["back"]
            result.templates_updated = True

    if notetype.get("css") != assets["css"]:
        notetype["css"] = assets["css"]
        result.css_updated = True

    if result.fields_added or result.templates_updated or result.css_updated:
        col.models.update_dict(notetype)

    result.media_written = _write_media(col, assets["media"])
    return result


def _build_new(col: "Collection", assets: dict) -> dict:
    notetype = col.models.new(NOTETYPE_NAME)
    for name in FIELD_NAMES:
        col.models.add_field(notetype, col.models.new_field(name))
    template = col.models.new_template(TEMPLATE_NAME)
    template["qfmt"] = assets["front"]
    template["afmt"] = assets["back"]
    col.models.add_template(notetype, template)
    notetype["css"] = assets["css"]
    return notetype


def _write_media(col: "Collection", media: dict) -> list:
    """Write the loop's js/css into the collection's media folder.

    Only writes a file whose bytes differ from what is already there, so a
    profile that is already current does no media work at all - which matters
    because every media write is something AnkiWeb has to sync.
    """
    written = []
    folder = col.media.dir()
    for name, data in media.items():
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            with open(path, "rb") as handle:
                if handle.read() == data:
                    continue
        col.media.write_data(name, data)
        written.append(name)
    return written
