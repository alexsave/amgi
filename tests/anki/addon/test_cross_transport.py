# The test that matters most in this add-on's bridge: proving the direct
# transport (the C collection core, server/collection/, used when Anki is closed) and the
# in-process transport (bridge_ops.py, used through the HTTP bridge when
# Anki is running) agree on the same collection file - not each against its
# own idea of "correct", but against each other, on the same bytes on disk.
#
# The UI is going to pick whichever transport is available at the moment
# (see the task this was built from) and assume the two are interchangeable.
# An assertion that only one side's own tests agree with its own writer
# proves nothing about that assumption; this file is what actually pins it.
#
# Needs both a working `anki` Python install (ANKI_PYTHON_BIN, or a plain
# python3 with anki on PATH; see test_bridge_ops.py) and the C core's CLI,
# server/build/collection_cli (make -C server). Skips cleanly, like every
# other test in this suite, when either is missing - see README.md, "Testing".

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "anki", "addon", "amgi_bridge")))

import bridge_ops  # noqa: E402
from sandbox_home import sandbox_env  # noqa: E402

try:
    import anki.lang
except ModuleNotFoundError:  # pragma: no cover - environment-dependent
    anki = None  # type: ignore[assignment]

# tests/anki/addon/test_cross_transport.py -> three folders up is the repo root
REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
COLLECTION_CLI = os.path.join(REPO_ROOT, "server", "build", "collection_cli")


# The CLI's line protocol (tests/server/parity/protocol.mjs says it in full): a text token is
# percent-encoded UTF-8, "~" the empty string; a list is "[a,b]".
def _enc(value: str) -> str:
    if value == "":
        return "~"
    safe = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
    return "".join(chr(b) if chr(b) in safe else "%%%02X" % b for b in value.encode("utf-8"))


def _dec(token: str) -> str:
    if token == "~":
        return ""
    out = bytearray()
    i = 0
    while i < len(token):
        if token[i] == "%":
            out.append(int(token[i + 1:i + 3], 16))
            i += 3
        else:
            out.append(ord(token[i]))
            i += 1
    return out.decode("utf-8")


def _items(token: str) -> list:
    inner = token[1:-1]
    return [] if inner == "" else inner.split(",")


def run_c(collection_path: str, op: str, args: dict):
    """Run one collection operation against `collection_path` through the C
    core's CLI, answered in the shapes the checks below read - the file must
    not be open from Python (or anywhere else) when this runs; Anki's
    exclusive-lock semantics make that a hard requirement, not just good
    hygiene."""
    if op == "createDeck":
        line = "createDeck " + _enc(args["name"])
    elif op == "listDecks":
        line = "listDecks"
    elif op == "setDeckLanguages":
        line = "setDeckLanguages %d %s %s" % (args["deckId"], _enc(args["known"]), _enc(args["learning"]))
    elif op == "listNotetypes":
        line = "listNotetypes"
    elif op == "addNote":
        note = args["note"]
        fields = "[" + ",".join(_enc(f) for f in note["fields"]) + "]"
        tags = "[" + ",".join(_enc(t) for t in note.get("tags", [])) + "]"
        line = "addNote %d %d %s %s ! !" % (note["deckId"], note["notetypeId"], fields, tags)
    elif op == "listNotesInDeck":
        line = "listNotesInDeck %d 0 50" % args["deckId"]
    else:
        raise ValueError("unknown op " + op)
    completed = subprocess.run(
        [COLLECTION_CLI],
        env=sandbox_env(),
        input="open %s\n%s\nquit\n" % (_enc(collection_path), line),
        capture_output=True,
        text=True,
        check=True,
    )
    lines = completed.stdout.split("\n")
    assert lines[0].startswith("ok"), lines[0]
    answer = lines[1].split(" ")
    assert answer[0] == "ok", f"the C core answered: {lines[1]}"
    rows = lines[2:]
    if op == "createDeck":
        return {"deck": {"id": int(answer[1]), "name": _dec(answer[2])}, "created": answer[3] == "1"}
    if op == "listDecks":
        return [{"id": int(r.split(" ")[0]), "name": _dec(r.split(" ")[1]), "known": _dec(r.split(" ")[2]),
                 "learning": _dec(r.split(" ")[3])} for r in rows[: int(answer[1])]]
    if op == "setDeckLanguages":
        return {"id": int(answer[1]), "known": _dec(answer[2]), "learning": _dec(answer[3])}
    if op == "listNotetypes":
        out = []
        for r in rows[: int(answer[1])]:
            t = r.split(" ")
            out.append({"id": int(t[0]), "name": _dec(t[1]), "fieldNames": [_dec(f) for f in _items(t[4])]})
        return out
    if op == "addNote":
        return {"noteId": int(answer[1])}
    out = []
    for r in rows[: int(answer[4])]:
        t = r.split(" ")
        out.append({"id": int(t[0]), "notetypeId": int(t[1]), "fields": [_dec(f) for f in _items(t[2])],
                    "tags": [_dec(g) for g in _items(t[3])]})
    return out


def _require_anki_and_c() -> None:
    if anki is None:
        raise unittest.SkipTest("the `anki` pip package is not installed; see test_bridge_ops.py")
    if not os.path.exists(COLLECTION_CLI):
        raise unittest.SkipTest("no server/build/collection_cli (make -C server)")


class _SeededCollection(unittest.TestCase):
    """A closed, freshly made collection in a temporary folder: the only state either transport may touch."""

    def setUp(self):
        _require_anki_and_c()
        self.tmpdir = tempfile.mkdtemp()
        self.collection_path = os.path.join(self.tmpdir, "collection.anki2")
        self.addCleanup(lambda: shutil.rmtree(self.tmpdir, ignore_errors=True))

        # Seed a collection and immediately close it - closed is the only
        # state either transport is allowed to touch it in (Anki's exclusive
        # lock means at most one thing ever has the file open at a time; the
        # Node core's open.js said so, and server/collection/db.c's
        # openCollection, its C port, says it now).
        import anki.lang
        from anki.collection import Collection

        anki.lang.set_lang("en_US")
        seed_col = Collection(self.collection_path)
        seed_col.close()

    def _open(self):
        from anki.collection import Collection

        return Collection(self.collection_path)


class CrossTransportTests(_SeededCollection):
    def test_a_deck_the_c_core_creates_is_recognised_not_duplicated_by_the_bridge(self):
        c_created = run_c(self.collection_path, "createDeck", {"name": "Korean::Verbs"})
        self.assertTrue(c_created["created"])

        col = self._open()
        try:
            bridge_result = bridge_ops.create_deck(col, "Korean::Verbs")
        finally:
            col.close()

        self.assertFalse(bridge_result.payload["created"])
        self.assertEqual(bridge_result.payload["deck"]["id"], c_created["deck"]["id"])
        self.assertEqual(bridge_result.payload["deck"]["name"], c_created["deck"]["name"])

    def test_a_deck_the_bridge_creates_is_recognised_not_duplicated_by_the_c_core(self):
        col = self._open()
        try:
            bridge_result = bridge_ops.create_deck(col, "Japanese::Verbs")
        finally:
            col.close()
        self.assertTrue(bridge_result.payload["created"])

        c_result = run_c(self.collection_path, "createDeck", {"name": "japanese::VERBS"})
        self.assertFalse(c_result["created"])
        self.assertEqual(c_result["deck"]["id"], bridge_result.payload["deck"]["id"])

    def test_both_transports_see_the_same_deck_list_after_writes_from_both(self):
        run_c(self.collection_path, "createDeck", {"name": "Korean"})
        col = self._open()
        try:
            bridge_ops.create_deck(col, "Japanese")
        finally:
            col.close()

        c_decks = {d["name"] for d in run_c(self.collection_path, "listDecks", {})}
        col = self._open()
        try:
            bridge_decks = {d["name"] for d in bridge_ops.list_decks(col)}
        finally:
            col.close()

        self.assertEqual(c_decks, bridge_decks)
        self.assertEqual({"Default", "Korean", "Japanese"}, c_decks)

    def test_a_note_the_c_core_adds_round_trips_through_the_bridges_own_reader(self):
        deck = run_c(self.collection_path, "createDeck", {"name": "Korean"})["deck"]
        basic = next(nt for nt in run_c(self.collection_path, "listNotetypes", {}) if nt["name"] == "Basic")

        added = run_c(
            self.collection_path,
            "addNote",
            {"note": {"deckId": deck["id"], "notetypeId": basic["id"], "fields": ["c front", "c back"], "tags": ["from-c"]}},
        )

        col = self._open()
        try:
            page = bridge_ops.list_notes_in_deck(col, deck["id"])
        finally:
            col.close()

        note = next(n for n in page["notes"] if n["id"] == added["noteId"])
        self.assertEqual(note["notetypeId"], basic["id"])
        self.assertEqual(note["fields"], ["c front", "c back"])
        self.assertEqual(note["tags"], ["from-c"])

    def test_a_note_the_bridge_adds_round_trips_through_the_c_cores_own_reader(self):
        col = self._open()
        try:
            deck = bridge_ops.create_deck(col, "Korean").payload["deck"]
            basic = next(nt for nt in bridge_ops.list_notetypes(col) if nt["name"] == "Basic")
            added = bridge_ops.add_note(
                col, deck_id=deck["id"], notetype_id=basic["id"], fields=["py front", "py back"], tags=["from-py"]
            )
        finally:
            col.close()

        # Node's listNotesInDeck returns the notes array directly (see
        # plusaudio/lib/collection/notes.js) - unlike bridge_ops.py's
        # dict-with-pagination-metadata shape, a deliberate divergence noted
        # in bridge_ops.list_notes_in_deck's own docstring.
        notes = run_c(self.collection_path, "listNotesInDeck", {"deckId": deck["id"], "options": {}})
        note = next(n for n in notes if n["id"] == added.payload["noteId"])
        self.assertEqual(note["notetypeId"], basic["id"])
        self.assertEqual(note["fields"], ["py front", "py back"])
        self.assertEqual(note["tags"], ["from-py"])


class DeckLanguagesCrossTransportTests(_SeededCollection):
    """A deck's language pair is one string in the deck's own add-on area. The C core writes it with Anki closed
    and Anki's own library reads it as it reads any add-on's key; Anki writes it and the C core lists it; and a
    write of the C core's reaches another device through Anki's own sync server."""

    def test_the_c_core_sets_a_pair_anki_reads_it_and_another_add_ons_key_survives(self):
        col = self._open()
        try:
            did = col.decks.id("Chinese")
            deck = col.decks.get(did)
            deck["otherAddon"] = 1
            col.decks.save(deck)
        finally:
            col.close()
        answer = run_c(self.collection_path, "setDeckLanguages", {"deckId": did, "known": "en", "learning": "zh_cn"})
        self.assertEqual(answer, {"id": did, "known": "en", "learning": "zh_cn"})
        col = self._open()
        try:
            deck = col.decks.get(did)
            self.assertEqual(deck["amgiLanguages"], "en zh_cn")
            self.assertEqual(deck["otherAddon"], 1, "another add-on's key is still there")
            self.assertEqual(deck["name"], "Chinese")
            self.assertEqual(col.decks.get(1).get("amgiLanguages"), None, "no other deck got one")
        finally:
            col.close()

    def test_anki_sets_a_pair_and_the_c_core_lists_it(self):
        col = self._open()
        try:
            did = col.decks.id("Korean")
            other = col.decks.id("Other")
            bridge_ops.set_deck_languages(col, did, "ko", "en")
        finally:
            col.close()
        listed = {d["id"]: d for d in run_c(self.collection_path, "listDecks", {})}
        self.assertEqual((listed[did]["known"], listed[did]["learning"]), ("ko", "en"))
        self.assertEqual((listed[other]["known"], listed[other]["learning"]), ("", ""))
        # and the C core replaces what Anki wrote, which Anki reads back
        run_c(self.collection_path, "setDeckLanguages", {"deckId": did, "known": "ja", "learning": "en"})
        col = self._open()
        try:
            self.assertEqual(col.decks.get(did)["amgiLanguages"], "ja en")
        finally:
            col.close()

    def test_a_c_core_write_moves_col_mod_and_the_decks_own_mtime_and_usn(self):
        col = self._open()
        try:
            did = col.decks.id("Chinese")
            mod_before = col.db.scalar("select mod from col")
        finally:
            col.close()
        time.sleep(0.01)
        run_c(self.collection_path, "setDeckLanguages", {"deckId": did, "known": "en", "learning": "zh_cn"})
        col = self._open()
        try:
            self.assertGreater(col.db.scalar("select mod from col"), mod_before, "col.mod moved, or sync reports no changes")
            self.assertEqual(col.db.scalar("select usn from decks where id = ?", did), -1)
            self.assertGreaterEqual(col.db.scalar("select mtime_secs from decks where id = ?", did), int(time.time()) - 60)
        finally:
            col.close()

    def test_a_pair_the_c_core_writes_reaches_another_device_through_anki_own_sync_server(self):
        from anki.collection import Collection

        base = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        server = subprocess.Popen(
            [sys.executable, "-c", "from anki.syncserver import run_sync_server; run_sync_server()"],
            env=sandbox_env(PYTHONPATH=os.environ.get("PYTHONPATH", ""), SYNC_USER1="u:p", SYNC_BASE=os.path.join(base, "srv"), SYNC_HOST="127.0.0.1", SYNC_PORT=str(port)),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: (server.kill(), server.wait()))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            self.fail("Anki's sync server did not come up")
        endpoint = f"http://127.0.0.1:{port}/"

        def sync(col, upload=False):
            auth = col.sync_login("u", "p", endpoint=endpoint)
            out = col.sync_collection(auth, sync_media=False)
            if out.required in (out.FULL_UPLOAD, out.FULL_SYNC) and upload:
                col.close_for_full_sync()
                col.full_upload_or_download(auth=auth, server_usn=out.server_media_usn, upload=True)
                col.reopen(after_full_sync=True)
            elif out.required in (out.FULL_DOWNLOAD, out.FULL_SYNC):
                col.close_for_full_sync()
                col.full_upload_or_download(auth=auth, server_usn=out.server_media_usn, upload=False)
                col.reopen(after_full_sync=True)

        path_a, path_b = (os.path.join(base, n, "collection.anki2") for n in ("A", "B"))
        os.makedirs(os.path.dirname(path_a))
        os.makedirs(os.path.dirname(path_b))
        a = Collection(path_a)
        did = a.decks.id("Chinese")
        bridge_ops.set_deck_languages(a, did, "en", "ja")
        sync(a, upload=True)
        b = Collection(path_b)
        sync(b)
        self.assertEqual(b.decks.get(did).get("amgiLanguages"), "en ja", "device B has the deck and its pair after the first download")
        # An ordinary incremental round first (B changes it through Anki's own API, both sync), so that A's
        # collection and the server's agree on col.mod: the state in which a write that leaves col.mod
        # where it was is never offered to the server (measured against this very sync server).
        bridge_ops.set_deck_languages(b, did, "en", "ko")
        sync(b)
        sync(a)
        self.assertEqual(a.decks.get(did).get("amgiLanguages"), "en ko", "device A got B's change")
        # the C core changes A's file with Anki closed; both devices then sync, an ordinary incremental one
        a.close()
        run_c(path_a, "setDeckLanguages", {"deckId": did, "known": "en", "learning": "zh_cn"})
        a = Collection(path_a)
        self.assertEqual(a.decks.get(did).get("amgiLanguages"), "en zh_cn", "Anki reads the C core's write")
        sync(a)
        sync(b)
        self.assertEqual(b.decks.get(did).get("amgiLanguages"), "en zh_cn", "device B got the pair A's C-core write made")
        a.close()
        b.close()


if __name__ == "__main__":
    unittest.main()
