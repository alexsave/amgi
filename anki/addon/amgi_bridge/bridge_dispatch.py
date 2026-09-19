# The only file in this add-on's bridge that imports aqt: it adapts
# bridge_ops.py's pure Collection functions to the dispatcher shape
# bridge_server.py expects, by running every one of them through Anki's own
# operation queue (aqt.operations.CollectionOp / QueryOp) and blocking the
# calling thread - the HTTP server's - until Anki hands back a result.
#
# This is the one rule the whole bridge exists to enforce: mw.col is never
# touched from the HTTP server's thread. Every method below only ever reads
# mw.col indirectly, from inside a callable that CollectionOp or QueryOp
# itself invokes on Anki's own background-operation pool, after being
# scheduled from the main thread via mw.taskman.run_on_main. The HTTP
# thread's only synchronization primitive is a plain threading.Event, which
# is safe to signal from any thread - no Qt object ever crosses threads here.
#
# Read-only operations (status, list decks, list note types, list notes) use
# QueryOp: aqt.operations.QueryOp's own docstring names exactly this case -
# "primarily used for read-only requests". Mutating operations (create deck,
# add note, update note) use CollectionOp instead, specifically so Anki's own
# undo state and change hooks fire - the deck list, browser and editor all
# noticing a note or deck the bridge just added, exactly as if it had come
# from Anki's UI. Adding media is a mutation that doesn't touch the
# collection database at all (col.media lives in its own file next to it,
# not in an undo-tracked table) - QueryOp's own docstring calls out "adding/
# deleting files" as exactly its other intended use, so that one uses QueryOp
# too, per aqt.operations.QueryOp's docstring on mutations outside the undo
# system.

from __future__ import annotations

import threading
from typing import Any, Callable, Optional, TypeVar

from aqt.operations import CollectionOp, QueryOp

try:
    from . import bridge_ops
    from .bridge_server import BridgeBadRequest, BridgeBusy
except ImportError:
    import bridge_ops
    from bridge_server import BridgeBadRequest, BridgeBusy

T = TypeVar("T")

DEFAULT_TIMEOUT_SECONDS = 30.0


def _run_on_main_and_wait(schedule: Callable[[Callable[[Any], None], Callable[[Exception], None]], None], timeout: float) -> Any:
    """Post `schedule` to Anki's main thread via mw.taskman.run_on_main, then
    block this (calling) thread on a plain threading.Event until one of the
    two callbacks `schedule` is given fires. `schedule` itself decides how
    the work actually runs (CollectionOp, QueryOp, or a bare main-thread
    call for state that isn't collection data - see get_status below); this
    function only owns the wait-for-it plumbing shared by all three.
    """
    from aqt import mw

    done = threading.Event()
    outcome: dict[str, Any] = {}

    def on_success(result: Any) -> None:
        outcome["result"] = result
        done.set()

    def on_failure(exc: Exception) -> None:
        outcome["error"] = exc
        done.set()

    def start() -> None:
        schedule(on_success, on_failure)

    mw.taskman.run_on_main(start)
    if not done.wait(timeout):
        raise TimeoutError(f"amgi bridge: operation did not finish within {timeout}s")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["result"]


class AqtBridgeDispatcher:
    """The real dispatcher bridge_server.BridgeServer is constructed with
    inside Anki (see __init__.py). Every public method here matches one
    bridge_server.py route handler 1:1."""

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    def _require_collection(self) -> None:
        from aqt import mw

        if mw is None or mw.col is None:
            raise BridgeBusy()

    def _run_read(self, op: Callable[[Any], T]) -> T:
        self._require_collection()
        from aqt import mw

        def schedule(on_success: Callable[[T], None], on_failure: Callable[[Exception], None]) -> None:
            QueryOp(parent=mw, op=op, success=on_success).failure(on_failure).run_in_background()

        return _run_on_main_and_wait(schedule, self._timeout)

    def _run_write(self, op: Callable[[Any], "bridge_ops.OpResult"]) -> Any:
        self._require_collection()
        from aqt import mw

        def schedule(
            on_success: Callable[["bridge_ops.OpResult"], None], on_failure: Callable[[Exception], None]
        ) -> None:
            CollectionOp(parent=mw, op=op).success(on_success).failure(on_failure).run_in_background()

        result: "bridge_ops.OpResult" = _run_on_main_and_wait(schedule, self._timeout)
        return result.payload

    # -- dispatcher protocol, one method per bridge_server.py route --------

    def get_status(self) -> dict:
        # Deliberately not routed through QueryOp/CollectionOp: both require
        # mw.col to exist (they run `self._op(mw.col)`), but "is a
        # collection even open" is exactly what this endpoint has to be able
        # to answer when it isn't. Reading mw.pm.name and mw.col still has to
        # happen on the main thread, so this schedules a bare callable there
        # instead - the same run_on_main + threading.Event handoff, just
        # without Anki's operation queue wrapped around it.
        from aqt import mw
        from anki.buildinfo import version as anki_version
        from aqt.qt import qtmajor, qtminor

        def schedule(on_success: Callable[[dict], None], on_failure: Callable[[Exception], None]) -> None:
            try:
                # mw.pm.name raises if no profile has been loaded yet (the
                # profile picker is showing) - a normal status to report, not
                # a failure, so it is read defensively rather than let the
                # broader try/except below turn it into a 500.
                try:
                    profile_name = mw.pm.name if mw.pm else None
                except Exception:  # noqa: BLE001 - "no profile open yet" is not an error
                    profile_name = None
                on_success(
                    bridge_ops.status(
                        mw.col,
                        profile_name=profile_name,
                        anki_version=anki_version,
                        qt_version=f"{qtmajor}.{qtminor}",
                    )
                )
            except Exception as error:  # noqa: BLE001 - handed to the HTTP caller as a 500
                on_failure(error)

        return _run_on_main_and_wait(schedule, self._timeout)

    def list_decks(self) -> list:
        return self._run_read(bridge_ops.list_decks)

    def list_notetypes(self) -> list:
        return self._run_read(bridge_ops.list_notetypes)

    def list_notes(self, deck_id: int, *, offset: int, limit: int) -> dict:
        return self._run_read(lambda col: bridge_ops.list_notes_in_deck(col, deck_id, offset=offset, limit=limit))

    def create_deck(self, name: str) -> dict:
        if not name.strip():
            raise BridgeBadRequest("deck name must not be blank")
        return self._run_write(lambda col: bridge_ops.create_deck(col, name))

    def add_note(self, *, deck_id: int, notetype_id: int, fields: list, tags: list) -> dict:
        return self._run_write(
            lambda col: bridge_ops.add_note(col, deck_id=deck_id, notetype_id=notetype_id, fields=fields, tags=tags)
        )

    def update_note(self, note_id: int, fields: list) -> dict:
        return self._run_write(lambda col: bridge_ops.update_note(col, note_id, fields))

    def add_media(self, filename: str, data: bytes) -> dict:
        # QueryOp, not CollectionOp: col.media.write_data touches the media
        # folder and collection.media.db2, not the undo-tracked notes/cards/
        # decks tables, so there is no OpChanges for CollectionOp to look
        # for - see this file's module docstring.
        return self._run_read(lambda col: bridge_ops.add_media(col, filename, data))
