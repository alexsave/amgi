# The collection operations the HTTP bridge exposes, expressed purely in
# terms of anki.collection.Collection - no aqt, no HTTP, no threading.
#
# This is the in-process mirror of plusaudio/lib/collection/index.js's
# Collection class: same capabilities (status, list decks, list note types,
# list notes in a deck paginated, create a deck with `::` nesting, add a
# note, update a note's fields, add a media file), same vocabulary in the
# JSON shapes each function returns, so bridge_server.py's HTTP responses and
# plusaudio's direct-file responses can be treated as interchangeable by
# whatever picks a transport on the UI side.
#
# The one rule every function here follows, and the whole reason this file
# is short: never compute anything Anki's own Collection already computes.
# plusaudio/lib/collection/ hand-rolls usn, mod, sfld and csum because it is
# talking to a *closed* collection file with nothing else to do the
# bookkeeping. In-process, `col` already has the pen - `col.decks.id`,
# `col.add_note`, `col.update_note`, `col.media.write_data` - so every
# mutation here is a call into Anki's API, never a raw SQL write.
#
# No function in this file touches aqt.operations, mw, or a socket. It is
# tested the same way core.py is (test/test_bridge_ops.py, against a real
# anki.collection.Collection): only bridge_dispatch.py knows this file
# exists inside an Anki add-on at all.

from __future__ import annotations

import os

import dataclasses
from typing import TYPE_CHECKING, Any, Optional, Sequence

try:
    # The normal case: Anki has amgi_bridge's parent directory on sys.path and
    # imports this as part of the amgi_bridge package.
    from .deck_text import looks_romanized
except ImportError:
    # test/ imports this module directly, with the add-on's own directory on
    # sys.path (see test/test_bridge_ops.py) - the same dual-import tolerance
    # core.py uses for deck_text.py.
    from deck_text import looks_romanized

if TYPE_CHECKING:
    from anki.collection import Collection, OpChanges


@dataclasses.dataclass(frozen=True)
class OpResult:
    """What a mutating function in this file returns: the JSON-ready payload
    for the HTTP response, plus the real `OpChanges` Anki's own API handed
    back for that mutation. bridge_dispatch.py's CollectionOp reads `.changes`
    off this (see aqt.operations.HasChangesProperty) to fire Anki's own
    change hooks - the browser, deck list and editor all noticing a note or
    deck the bridge just added - exactly as if the write had come from
    Anki's UI instead of an HTTP request.
    """

    payload: Any
    changes: "OpChanges"


def status(col: Optional["Collection"], *, profile_name: Optional[str], anki_version: str, qt_version: str) -> dict:
    """Collection/profile/version status. Unlike every other function here,
    this one is meaningful with `col is None` (no profile open yet, or the
    profile picker is showing) - the whole point of a status endpoint is to
    answer "is there anything to talk to" without demanding there is."""
    if col is None:
        return {
            "profileOpen": profile_name is not None,
            "profileName": profile_name,
            "collectionOpen": False,
            "schemaVersion": None,
            "ankiVersion": anki_version,
            "qtVersion": qt_version,
        }
    return {
        "profileOpen": True,
        "profileName": profile_name,
        "collectionOpen": True,
        "schemaVersion": col.db.scalar("select ver from col"),
        "ankiVersion": anki_version,
        "qtVersion": qt_version,
    }


def list_decks(col: "Collection") -> list[dict]:
    # include_filtered=True (the default): plusaudio/lib/collection/decks.js's
    # listDecks is a plain, unfiltered `SELECT id, name FROM decks`, and this
    # matches it rather than diverging to hide filtered decks.
    return [{"id": d.id, "name": d.name} for d in col.decks.all_names_and_ids()]


def list_notetypes(col: "Collection") -> list[dict]:
    result = []
    for name_id in col.models.all_names_and_ids():
        notetype = col.models.get(name_id.id)
        if notetype is None:
            continue
        result.append(
            {
                "id": notetype["id"],
                "name": notetype["name"],
                "kind": "cloze" if notetype["type"] == 1 else "normal",
                "sortFieldIndex": notetype["sortf"],
                "fieldNames": [f["name"] for f in notetype["flds"]],
                "templates": [
                    {"ord": t["ord"], "name": t["name"], "questionFormat": t["qfmt"]} for t in notetype["tmpls"]
                ],
            }
        )
    return result


def list_notes_in_deck(col: "Collection", deck_id: int, *, offset: int = 0, limit: int = 200) -> dict:
    """Notes with at least one card in `deck_id` or a subdeck of it, oldest
    id first, paginated at the SQL layer (LIMIT/OFFSET on an indexed join)
    so a 20k-note deck costs one small query per page, not one big load: the
    same shape plusaudio/lib/collection/notes.js's listNotesInDeck uses,
    reusing Anki's own `col.db` rather than a second SQLite connection.

    Field/tag splitting is left to `col.get_note()` (real Note objects, one
    per row of *this page only*) instead of hand-parsing `flds` - the pure
    read-side equivalent of "let Anki's API do the bookkeeping".
    """
    deck_ids = tuple(col.decks.deck_and_child_ids(deck_id))
    if not deck_ids:
        return {"notes": [], "total": 0, "offset": offset, "limit": limit}

    placeholders = ",".join("?" for _ in deck_ids)
    total = col.db.scalar(
        f"SELECT COUNT(DISTINCT n.id) FROM notes n JOIN cards c ON c.nid = n.id WHERE c.did IN ({placeholders})",
        *deck_ids,
    )
    note_ids = col.db.list(
        f"SELECT DISTINCT n.id FROM notes n JOIN cards c ON c.nid = n.id "
        f"WHERE c.did IN ({placeholders}) ORDER BY n.id LIMIT ? OFFSET ?",
        *deck_ids,
        limit,
        offset,
    )
    notes = []
    for note_id in note_ids:
        note = col.get_note(note_id)
        notes.append(
            {
                "id": note.id,
                "notetypeId": note.mid,
                "fields": list(note.fields),
                "tags": list(note.tags),
            }
        )
    return {"notes": notes, "total": total, "offset": offset, "limit": limit}


def list_field_values(col: "Collection", deck_id: int, notetype_id: int, field_index: int) -> list[str]:
    """One field's value across every note of `notetype_id` already in
    `deck_id` - what the web UI's bulk-add-from-paste screen checks a pasted
    line against before writing it, so pasting the same song twice doesn't
    produce a second set of notes.

    Deliberately a raw `flds` split rather than `col.get_note()` per row (the
    way list_notes_in_deck reads a page of notes): a bulk paste needs every
    matching note's text at once to dedupe against, not one page, and a
    Note object's extra bookkeeping (tags, note type lookup) is wasted work
    when all that's wanted is one field's string. Same WHERE clause as
    list_notes_in_deck (did = ?, no subdeck expansion) plus the note-type
    filter, so this only ever compares against the note type bulk add is
    about to write into.
    """
    deck_ids = tuple(col.decks.deck_and_child_ids(deck_id))
    if not deck_ids:
        return []
    placeholders = ",".join("?" for _ in deck_ids)
    rows = col.db.all(
        f"SELECT DISTINCT n.id, n.flds FROM notes n JOIN cards c ON c.nid = n.id "
        f"WHERE c.did IN ({placeholders}) AND n.mid = ?",
        *deck_ids,
        notetype_id,
    )
    values = []
    for _note_id, flds in rows:
        fields = flds.split("\x1f")
        values.append(fields[field_index] if 0 <= field_index < len(fields) else "")
    return values


def has_media(col: "Collection", filename: str) -> bool:
    """Whether a content-hashed clip name (see plusaudio/lib/audio-store.js's
    mediaName, mirrored by deck_text.media_name) is already in this
    collection's media folder - the same resumability check
    plan_fill/apply_fill make with `col.media.have()` in core.py, exposed here
    so the web UI's bulk-add screen can skip a generation call it would only
    throw away.
    """
    return col.media.have(filename)


def add_notes_bulk(col: "Collection", notes: Sequence[dict]) -> OpResult:
    """Add several notes in one call, so the bridge dispatcher (see
    bridge_dispatch.add_notes_bulk) can wrap the whole batch in a single
    `CollectionOp` - one undo step and one round of Anki's own change hooks
    firing, instead of one of each per note. A bulk paste of 60 lines through
    60 separate `POST /notes` calls would each open and close their own
    CollectionOp on Anki's main thread, which is slow and (worse) repaints
    the browser/deck list 60 times in a row for what the user experiences as
    a single action.

    Each note is validated and added independently; one bad note (wrong field
    count, unknown note type) is reported in its own result slot rather than
    aborting notes already added earlier in the same batch - a paste is a
    batch of independent lines, not a single transaction that should all
    fail together over one bad line.

    `changes` on the returned OpResult is whichever successful add's own
    OpChanges was seen last, not a real union of all of them - every
    successful call in this loop sets the same flags (a note and its cards
    were added), so any one of them is equally correct as the signal
    CollectionOp forwards to Anki's change hooks. An empty, real OpChanges is
    used when nothing was actually added, the same convention create_deck
    above uses for its own no-op case.
    """
    results = []
    changes: Optional["OpChanges"] = None
    for note in notes:
        try:
            op_result = add_note(
                col,
                deck_id=note["deck_id"],
                notetype_id=note["notetype_id"],
                fields=note["fields"],
                tags=note.get("tags", ()),
                language=note.get("language"),
                learning_field_index=note.get("learning_field_index"),
            )
            results.append({"ok": True, **op_result.payload})
            changes = op_result.changes
        except Exception as error:  # noqa: BLE001 - reported per note, batch continues
            results.append({"ok": False, "error": str(error)})

    if changes is None:
        from anki.collection import OpChanges

        changes = OpChanges()
    return OpResult(payload={"results": results}, changes=changes)


def create_deck(col: "Collection", human_name: str) -> OpResult:
    """Find-or-create `human_name`, creating any missing `::` ancestors,
    the same contract as Anki's own "Create Deck" dialog and as
    plusaudio/lib/collection/decks.js's resolveOrCreateDeck: a name that
    already exists (matched with Anki's real collation, not an ASCII
    approximation of it - see decks.js's own module comment for the gap this
    closes) is returned rather than duplicated.

    `col.decks.id(name)` already walks the "::" ancestors and does this
    matching internally, but its return value is a bare id: the
    `OpChangesWithId` the backend actually produced for a newly-created deck
    is thrown away by that convenience wrapper. Recreating the ancestor walk
    here with `id_for_name` (a plain read) and `add_deck_legacy` (Anki's own
    mutating primitive) only decides *which* backend calls to make; every
    byte written - id allocation, usn, mod, the unicase-collated name index -
    is still Anki's own, never re-derived here.
    """
    components = human_name.split("::")
    changes: Optional["OpChanges"] = None
    created_any = False

    for depth in range(1, len(components) + 1):
        prefix = "::".join(components[:depth])
        if col.decks.id_for_name(prefix) is not None:
            continue
        deck = col.decks.new_deck_legacy(False)
        deck["name"] = prefix
        changes = col.decks.add_deck_legacy(deck).changes
        created_any = True

    final_id = col.decks.id_for_name(human_name)
    if final_id is None:
        # Anki normalizes component whitespace/blank components the same way
        # name.rs does (see decks.js's normalizeComponent for the reasoning
        # this mirrors); id_for_name on the raw, un-normalized human_name can
        # miss for the same reason. col.decks.id() applies that
        # normalization and is the fallback of record here.
        final_id = col.decks.id(human_name)
        if changes is None:
            created_any = True
    deck = col.decks.get(final_id)
    payload = {"deck": {"id": final_id, "name": deck["name"]}, "created": created_any}
    if changes is None:
        # Nothing was actually created (every ancestor already existed): a
        # real but empty OpChanges, so callers can still treat this
        # uniformly as "an OpResult with real changes attached".
        from anki.collection import OpChanges

        changes = OpChanges()
    return OpResult(payload=payload, changes=changes)


def _romanization_warning(
    field_names: Sequence[str], fields: Sequence[str], language: Optional[str], learning_field_index: Optional[int]
) -> Optional[str]:
    """Port of plusaudio/lib/collection/notes.js's romanizationWarning - see
    cardText.ts's looksRomanized (mirrored here by deck_text.looks_romanized)
    for the policy. Both `language` and `learning_field_index` are optional
    and caller-supplied (a bridge client typing a note by hand can send
    neither, and nothing is checked); only the ONE field the caller names is
    ever looked at, never every field, so a note's known-language side being
    ordinary English is never mistaken for the bug this exists to catch.
    """
    if not language or learning_field_index is None:
        return None
    if not (0 <= learning_field_index < len(fields)):
        return None
    text = fields[learning_field_index]
    if not looks_romanized(text, language):
        return None
    name = field_names[learning_field_index] if learning_field_index < len(field_names) else f"field {learning_field_index}"
    return f'"{name}" looks fully romanised for a {language} note - check it is not meant to be written in {language}\'s own script.'


def add_note(
    col: "Collection",
    *,
    deck_id: int,
    notetype_id: int,
    fields: Sequence[str],
    tags: Sequence[str] = (),
    language: Optional[str] = None,
    learning_field_index: Optional[int] = None,
) -> OpResult:
    """Add a note to `deck_id`, letting Anki generate whatever cards its note
    type's templates (or cloze numbers) call for - `col.add_note` does that
    itself; this function's only job is validating the field count against
    the note type first, so a mismatch is a clear error instead of Anki
    silently padding or truncating.

    `language`/`learning_field_index` are optional and only feed the
    romanisation guard (see _romanization_warning) - omitting either just
    means nothing is checked, same as before this guard existed.
    """
    notetype = col.models.get(notetype_id)
    if notetype is None:
        raise ValueError(f"no note type with id {notetype_id} in this collection")
    field_names = col.models.field_names(notetype)
    if len(fields) != len(field_names):
        raise ValueError(f'note type "{notetype["name"]}" has {len(field_names)} fields, got {len(fields)}')

    note = col.new_note(notetype)
    for index, value in enumerate(fields):
        note.fields[index] = value
    if tags:
        note.tags = list(tags)

    # col.add_note() returns OpChangesWithCount, not a bare OpChanges (unlike
    # col.update_note() below) - its own .changes field is the real OpChanges
    # that aqt.operations.on_op_finished expects. Storing the wrapper itself
    # here used to hand deckbrowser.op_executed/browser/table/table.py an
    # object missing the study_queues/browser_table attributes they read off
    # a real OpChanges, crashing Anki's own UI-refresh hooks (AttributeError)
    # right after every successful add - the note was written correctly, only
    # the live refresh blew up.
    changes = col.add_note(note, deck_id).changes
    warning = _romanization_warning(field_names, fields, language, learning_field_index)
    payload = {"noteId": note.id, "guid": note.guid, "cardIds": [c.id for c in note.cards()]}
    if warning:
        payload["warning"] = warning
    return OpResult(payload=payload, changes=changes)


def update_note(
    col: "Collection",
    note_id: int,
    fields: Sequence[str],
    language: Optional[str] = None,
    learning_field_index: Optional[int] = None,
) -> OpResult:
    """Replace a note's field contents in place. Like
    plusaudio/lib/collection/notes.js's updateNoteFields, this never touches
    tags or regenerates cards - a card's existence was decided once, at add
    time, from the note type's templates, and changing field text doesn't
    retroactively add or remove cards in real Anki either.
    """
    note = col.get_note(note_id)
    notetype = note.note_type()
    field_names = col.models.field_names(notetype) if notetype else []
    if len(fields) != len(field_names):
        name = notetype["name"] if notetype else "<unknown>"
        raise ValueError(f'note type "{name}" has {len(field_names)} fields, got {len(fields)}')

    for index, value in enumerate(fields):
        note.fields[index] = value

    changes = col.update_note(note)
    warning = _romanization_warning(field_names, fields, language, learning_field_index)
    payload = {"noteId": note.id}
    if warning:
        payload["warning"] = warning
    return OpResult(payload=payload, changes=changes)


def remove_note(col: "Collection", note_id: int) -> OpResult:
    """Delete one note and its cards.

    `col.remove_notes` rather than any SQL of our own: it is what writes the
    graves a sync needs so the deletion propagates instead of the note being
    pushed back from AnkiWeb, and it is undoable from Anki's own Edit menu
    afterwards, which deleting rows by hand would not be.
    """
    changes = col.remove_notes([note_id])
    return OpResult(changes=changes.changes if hasattr(changes, "changes") else changes, count=1)


def read_media(col: "Collection", filename: str) -> Optional[bytes]:
    """The bytes of one media file, or None when it is not there.

    This exists so the web UI can play a clip back while Anki is open, which
    is the case the direct transport cannot serve at all: Anki holds
    collection.anki2 in an exclusive lock, so nothing outside this process
    can read the note that names the clip. The media FOLDER is not locked -
    it is ordinary files next to the collection - but the app still has to
    come through here, because it has no way to learn the folder's path while
    the collection it would read that from is unreadable.

    `filename` arrives from a note field, which is content anyone could have
    put in a collection, so it is refused outright if it carries a path
    separator or a parent segment rather than being normalised into
    something safe. The only legitimate values are the bare names Anki's own
    media manager produced.
    """
    if not filename or "/" in filename or "\\" in filename or "\x00" in filename:
        return None
    if filename in (".", ".."):
        return None
    folder = col.media.dir()
    full = os.path.join(folder, filename)
    # Belt and braces after the shape check above: resolve and confirm the
    # result is still inside the media folder.
    if os.path.dirname(os.path.abspath(full)) != os.path.abspath(folder):
        return None
    if not os.path.isfile(full):
        return None
    with open(full, "rb") as handle:
        return handle.read()


def add_media(col: "Collection", desired_name: str, data: bytes) -> dict:
    """Write `data` into the collection's media folder under (close to)
    `desired_name`, returning the filename Anki actually used - `col.media`
    is Anki's own media manager, so the same content-hash-on-collision
    dedup plusaudio/lib/collection/media.js re-implements for a closed
    collection happens here for free, and this function's whole job is
    reduced to "call it and hand back what it says".
    """
    filename = col.media.write_data(desired_name, data)
    return {"filename": filename}
