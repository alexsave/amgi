# Pure logic for filling missing audio into notes in a live Anki collection.
#
# No aqt import anywhere in this file: it only depends on anki.collection.Collection,
# so it can be exercised in a plain Python process against a real collection,
# independent of the Qt event loop, dialogs, and the aqt.operations machinery
# that only run inside Anki itself. __init__.py is the thin layer that wires
# this to a menu item, a progress dialog and CollectionOp; everything a test
# can check without a GUI lives here instead of there.
#
# What this module deliberately does NOT do, because a live Collection already
# does it: renumber or match notes by GUID, touch revlog, maintain notes.sfld
# or notes.csum, or read/write any package format. Collection.update_note
# recomputes the derived columns itself; that is the entire benefit of having
# Anki hold the pen instead of plusaudio/lib's hand-rolled SQLite writer.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING, Callable, Optional

try:
    # The normal case: Anki has amgi_bridge's parent directory on sys.path and
    # imports this as part of the amgi_bridge package.
    from .deck_text import AUDIO_TAG_FORMS, audio_references, is_owned_media_name, media_name, set_owned_audio, spoken_text
except ImportError:
    # test/ imports this add-on's modules directly, with the add-on's own
    # directory on sys.path, so it can exercise core.py without going through
    # __init__.py - which imports aqt, and aqt needs Qt installed to import at
    # all. Both import styles reach the same file; this just tolerates
    # whichever one the caller used.
    from deck_text import AUDIO_TAG_FORMS, audio_references, is_owned_media_name, media_name, set_owned_audio, spoken_text

if TYPE_CHECKING:
    from anki.collection import Collection, OpChanges
    from anki.decks import DeckId
    from anki.notes import Note, NoteId


@dataclasses.dataclass(frozen=True)
class AudioFillConfig:
    """What the "Fill missing audio" dialog collects from the user.

    `text_field` and `audio_field` are field NAMES, resolved against each
    note's own note type rather than a fixed field order, because a deck can
    mix note types and because a name survives the user reordering fields in
    Anki's field editor while an index would not.
    """

    deck_id: "DeckId"
    text_field: str
    audio_field: str
    language: str
    audio_tag: str = "sound"

    def __post_init__(self) -> None:
        if self.audio_tag not in AUDIO_TAG_FORMS:
            raise ValueError(f"audio_tag must be one of {AUDIO_TAG_FORMS}, got {self.audio_tag!r}")
        if self.text_field == self.audio_field:
            raise ValueError("text_field and audio_field must be different fields")


@dataclasses.dataclass(frozen=True)
class PlannedNote:
    """One note that needs audio, and what plan_fill already worked out about it."""

    note_id: "NoteId"
    text: str
    wanted_filename: str


@dataclasses.dataclass
class FillPlan:
    config: AudioFillConfig
    to_fill: list[PlannedNote]
    up_to_date_count: int
    skipped: list[tuple["NoteId", str]]

    @property
    def total_considered(self) -> int:
        return len(self.to_fill) + self.up_to_date_count + len(self.skipped)


def _note_ids_in_deck(col: "Collection", deck_id: "DeckId") -> list["NoteId"]:
    """Every note with at least one card in this deck or a subdeck of it.

    Card ids rather than a `deck:` search string: a deck name can contain
    characters ("::", quotes) that need escaping in Anki's search grammar, and
    a numeric id has none of that to get wrong.
    """
    seen: dict[int, None] = {}
    for card_id in col.decks.cids(deck_id, children=True):
        note_id = col.get_card(card_id).nid
        seen.setdefault(int(note_id), None)
    return list(seen.keys())  # type: ignore[return-value]


def plan_fill(col: "Collection", config: AudioFillConfig) -> FillPlan:
    """Decide which notes in `config.deck_id` still need audio, without
    changing anything. Read-only, and safe to call as often as you like:
    calling it twice in a row against an unchanged collection returns the same
    answer both times, which is what apply_fill's idempotency rests on.
    """
    to_fill: list[PlannedNote] = []
    skipped: list[tuple["NoteId", str]] = []
    up_to_date_count = 0

    for note_id in sorted(_note_ids_in_deck(col, config.deck_id)):
        note = col.get_note(note_id)  # type: ignore[arg-type]
        if config.text_field not in note or config.audio_field not in note:
            skipped.append((note_id, "note type has no matching field"))  # type: ignore[arg-type]
            continue

        text = spoken_text(note[config.text_field])
        if not text:
            skipped.append((note_id, "text field is empty once markup is stripped"))  # type: ignore[arg-type]
            continue

        wanted = media_name(text, config.language)
        owned = [ref for ref in audio_references(note[config.audio_field]) if is_owned_media_name(ref.name)]
        up_to_date = (
            len(owned) == 1
            and owned[0].name == wanted
            and owned[0].form == config.audio_tag
            and col.media.have(wanted)
        )
        if up_to_date:
            up_to_date_count += 1
            continue

        to_fill.append(PlannedNote(note_id=note_id, text=text, wanted_filename=wanted))  # type: ignore[arg-type]

    return FillPlan(config=config, to_fill=to_fill, up_to_date_count=up_to_date_count, skipped=skipped)


@dataclasses.dataclass
class FillResult:
    updated: list["NoteId"] = dataclasses.field(default_factory=list)
    failed: list[tuple["NoteId", str]] = dataclasses.field(default_factory=list)
    cancelled: bool = False
    # What CollectionOp commits as the run's single undo step. Only ever
    # non-empty when `updated` is, so a run that changes nothing produces no
    # undo entry at all.
    changes: Optional["OpChanges"] = None


ProgressCallback = Callable[[int, int, str], None]
WantCancel = Callable[[], bool]
FetchAudio = Callable[[str], bytes]


def apply_fill(
    col: "Collection",
    plan: FillPlan,
    fetch_audio: FetchAudio,
    *,
    progress: Optional[ProgressCallback] = None,
    want_cancel: Optional[WantCancel] = None,
) -> FillResult:
    """Fetch audio for each planned note and write it into the collection.

    Every field write happens on an in-memory Note object; the collection's
    database is not touched until a single `col.update_notes()` call at the
    very end, covering whatever got finished before a cancellation or an
    exception. That call is what CollectionOp turns into one undo step, and it
    is also why cancelling mid-run cannot leave a note half updated: a note's
    field is only ever mutated after its audio has already been fetched and
    written to the media folder, and the collection itself does not change
    until every mutation the run is going to make is queued up for that one
    call.

    Call from inside a CollectionOp's `op` callback (see __init__.py), not
    from a bare QThread: Anki's rule is that collection writes are made
    through aqt.operations so they get undo/redo support and so the rest of
    the UI (browser, editor, deck list) hears about them through Anki's own
    change hooks instead of going stale.
    """
    result = FillResult()
    touched_notes: list["Note"] = []
    # A second note in this run wanting the identical clip should not pay for
    # generation twice, even though plan_fill already made each note's target
    # filename cheap to re-derive on a *later* run via col.media.have().
    fetched_this_run: dict[str, bool] = {}

    total = len(plan.to_fill)
    for done, planned in enumerate(plan.to_fill):
        if want_cancel is not None and want_cancel():
            result.cancelled = True
            break

        if progress is not None:
            progress(done, total, planned.text)

        if planned.wanted_filename not in fetched_this_run and not col.media.have(planned.wanted_filename):
            try:
                audio = fetch_audio(planned.text)
            except Exception as error:  # noqa: BLE001 - reported per note, run continues
                result.failed.append((planned.note_id, str(error)))
                continue
            if not audio:
                result.failed.append((planned.note_id, "generator produced no audio"))
                continue
            written_name = col.media.write_data(planned.wanted_filename, audio)
            # Content-hashed names make a rename here vanishingly unlikely,
            # but if Anki's own dedup ever answers with a different name than
            # the one asked for, that answer - not our guess - is what's
            # actually on disk, and what the note has to point at.
            if written_name != planned.wanted_filename:
                planned = dataclasses.replace(planned, wanted_filename=written_name)
            fetched_this_run[planned.wanted_filename] = True

        note = col.get_note(planned.note_id)
        note[plan.config.audio_field] = set_owned_audio(
            note[plan.config.audio_field], planned.wanted_filename, is_owned_media_name, plan.config.audio_tag
        )
        touched_notes.append(note)
        result.updated.append(planned.note_id)

    if progress is not None:
        progress(len(result.updated) + len(result.failed), total, "")

    if touched_notes:
        result.changes = col.update_notes(touched_notes)

    return result
