#!/usr/bin/env python3
"""Starts a real amgi_bridge HTTP server against a real Anki collection, with
no Qt and no running Anki desktop app, so bridge-http.js can prove
bridge_server.py's routing, bridge_auth.py's token/Origin rules, and
bridge_ops.py's collection-mutating calls against real HTTP and real bytes on
disk - not the FakeDispatcher anki/addon/amgi_bridge/test/test_bridge_server.py
uses to prove the same routing/auth logic in isolation, and not a running Anki
process either.

This deliberately does NOT use bridge_dispatch.AqtBridgeDispatcher: that class
needs aqt (Anki's Qt/GUI package, which `pip install anki` does not install,
and which needs a running Anki process to have an mw/main window at all) to
hop every call onto Anki's main thread via CollectionOp/QueryOp. The
dispatcher below calls bridge_ops.py directly and synchronously instead - safe
here because nothing else is touching this collection while this process
holds it, which is true of every caller this script has. bridge_server.py
itself cannot tell the difference: it only ever calls methods on
`dispatcher`, never anything Qt- or thread-related (see that file's own
module comment) - which is exactly the seam that makes this a legitimate way
to exercise its real routing and auth code, not a reason to distrust the
result.

    python bridge_server_entry.py <collection.anki2> <token> <origin1,origin2> <port>

`port` 0 asks the OS for a free one; the actual port is in the line this
prints. Prints "LISTENING <port>" once the socket is up, then blocks on a
line from stdin before shutting the server down and closing the collection,
printing "STOPPED" last.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "anki", "addon", "amgi_bridge"),
)

from anki.buildinfo import version as anki_version  # noqa: E402
from anki.collection import Collection  # noqa: E402

import bridge_ops as ops  # noqa: E402
from bridge_server import BridgeServer  # noqa: E402


class SyncDispatcher:
    """The non-Qt stand-in described in this file's module docstring - one
    method per bridge_server.py route, matching bridge_dispatch.AqtBridgeDispatcher's
    payload shapes exactly (mutations return `.payload`, reads return the
    plain dict/list bridge_ops.py already built) so a caller of this server
    cannot tell it apart from the real one by the JSON it gets back."""

    def __init__(self, col: Collection) -> None:
        self._col = col

    def get_status(self) -> dict:
        return ops.status(
            self._col,
            profile_name="e2e-fixture",
            anki_version=anki_version,
            qt_version="n/a (no Qt in this harness)",
        )

    def list_decks(self) -> list:
        return ops.list_decks(self._col)

    def list_notetypes(self) -> list:
        return ops.list_notetypes(self._col)

    def list_notes(self, deck_id: int, *, offset: int, limit: int) -> dict:
        return ops.list_notes_in_deck(self._col, deck_id, offset=offset, limit=limit)

    def create_deck(self, name: str) -> dict:
        return ops.create_deck(self._col, name).payload

    def add_note(self, *, deck_id: int, notetype_id: int, fields: list, tags: list) -> dict:
        return ops.add_note(self._col, deck_id=deck_id, notetype_id=notetype_id, fields=fields, tags=tags).payload

    def update_note(self, note_id: int, fields: list) -> dict:
        return ops.update_note(self._col, note_id, fields).payload

    def add_media(self, filename: str, data: bytes) -> dict:
        return ops.add_media(self._col, filename, data)


def main() -> None:
    collection_path, token, origins_csv, port = sys.argv[1:5]
    allowed_origins = frozenset(o for o in origins_csv.split(",") if o)

    col = Collection(collection_path)
    try:
        server = BridgeServer(SyncDispatcher(col), token=token, allowed_origins=allowed_origins, port=int(port))
        server.start()
        print(f"LISTENING {server.port}", flush=True)
        sys.stdin.readline()
        server.stop()
    finally:
        col.close()
    print("STOPPED", flush=True)


if __name__ == "__main__":
    main()
