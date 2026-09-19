# The test that matters most in this add-on's bridge: proving the Node
# transport (plusaudio/lib/collection/, used when Anki is closed) and the
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
# python3 with anki on PATH; see test_bridge_ops.py) and a `node` on PATH.
# Skips cleanly, like every other test in this suite, when either is
# missing - see README.md, "Testing".

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge_ops  # noqa: E402

try:
    import anki.lang
except ModuleNotFoundError:  # pragma: no cover - environment-dependent
    anki = None  # type: ignore[assignment]

# .../test/test_cross_transport.py -> test -> amgi_bridge -> addon -> anki -> repo root
REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
)
COLLECTION_LIB = os.path.join(REPO_ROOT, "plusaudio", "lib", "collection")

# One small dispatcher script, so every call below is "run this one Node
# Collection method against this file" rather than a bespoke script per
# operation - keeping the Node side of this test as close as possible to
# just "the same lib/collection index.js everything else in plusaudio uses".
NODE_RUNNER = r"""
const { Collection } = require(process.argv[1]);
const [, , collectionPath, op, argsJson] = process.argv;
const args = JSON.parse(argsJson);
const col = new Collection(collectionPath);
let out;
switch (op) {
  case 'createDeck': out = col.createDeck(args.name); break;
  case 'listDecks': out = col.listDecks(); break;
  case 'listNotetypes': out = col.listNotetypes(); break;
  case 'addNote': out = col.addNote(args.note); break;
  case 'listNotesInDeck': out = col.listNotesInDeck(args.deckId, args.options || {}); break;
  default: throw new Error('unknown op ' + op);
}
process.stdout.write(JSON.stringify(out));
"""


def node_available() -> bool:
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def run_node(collection_path: str, op: str, args: dict):
    """Run one plusaudio/lib/collection Collection method against
    `collection_path` from Node, and return its `.result` - the file must
    not be open from Python (or anywhere else) when this runs; Anki's
    exclusive-lock semantics (see plusaudio/lib/collection/open.js) make that
    a hard requirement, not just good hygiene."""
    completed = subprocess.run(
        ["node", "-e", NODE_RUNNER, COLLECTION_LIB, collection_path, op, json.dumps(args)],
        capture_output=True,
        text=True,
        check=True,
    )
    envelope = json.loads(completed.stdout)
    assert envelope["status"] == "ok", f"node side returned non-ok status: {envelope}"
    return envelope["result"]


def _require_anki_and_node() -> None:
    if anki is None:
        raise unittest.SkipTest("the `anki` pip package is not installed; see test_bridge_ops.py")
    if not node_available():
        raise unittest.SkipTest("no `node` on PATH")


class CrossTransportTests(unittest.TestCase):
    def setUp(self):
        _require_anki_and_node()
        self.tmpdir = tempfile.mkdtemp()
        self.collection_path = os.path.join(self.tmpdir, "collection.anki2")
        self.addCleanup(lambda: shutil.rmtree(self.tmpdir, ignore_errors=True))

        # Seed a collection and immediately close it - closed is the only
        # state either transport is allowed to touch it in (see open.js's
        # module docstring: Anki's exclusive lock means at most one thing
        # ever has the file open at a time).
        import anki.lang
        from anki.collection import Collection

        anki.lang.set_lang("en_US")
        seed_col = Collection(self.collection_path)
        seed_col.close()

    def _open(self):
        from anki.collection import Collection

        return Collection(self.collection_path)

    def test_a_deck_node_creates_is_recognised_not_duplicated_by_the_bridge(self):
        node_created = run_node(self.collection_path, "createDeck", {"name": "Korean::Verbs"})
        self.assertTrue(node_created["created"])

        col = self._open()
        try:
            bridge_result = bridge_ops.create_deck(col, "Korean::Verbs")
        finally:
            col.close()

        self.assertFalse(bridge_result.payload["created"])
        self.assertEqual(bridge_result.payload["deck"]["id"], node_created["deck"]["id"])
        self.assertEqual(bridge_result.payload["deck"]["name"], node_created["deck"]["name"])

    def test_a_deck_the_bridge_creates_is_recognised_not_duplicated_by_node(self):
        col = self._open()
        try:
            bridge_result = bridge_ops.create_deck(col, "Japanese::Verbs")
        finally:
            col.close()
        self.assertTrue(bridge_result.payload["created"])

        node_result = run_node(self.collection_path, "createDeck", {"name": "japanese::VERBS"})
        self.assertFalse(node_result["created"])
        self.assertEqual(node_result["deck"]["id"], bridge_result.payload["deck"]["id"])

    def test_both_transports_see_the_same_deck_list_after_writes_from_both(self):
        run_node(self.collection_path, "createDeck", {"name": "Korean"})
        col = self._open()
        try:
            bridge_ops.create_deck(col, "Japanese")
        finally:
            col.close()

        node_decks = {d["name"] for d in run_node(self.collection_path, "listDecks", {})}
        col = self._open()
        try:
            bridge_decks = {d["name"] for d in bridge_ops.list_decks(col)}
        finally:
            col.close()

        self.assertEqual(node_decks, bridge_decks)
        self.assertEqual({"Default", "Korean", "Japanese"}, node_decks)

    def test_a_note_node_adds_round_trips_through_the_bridges_own_reader(self):
        deck = run_node(self.collection_path, "createDeck", {"name": "Korean"})["deck"]
        basic = next(nt for nt in run_node(self.collection_path, "listNotetypes", {}) if nt["name"] == "Basic")

        added = run_node(
            self.collection_path,
            "addNote",
            {"note": {"deckId": deck["id"], "notetypeId": basic["id"], "fields": ["node front", "node back"], "tags": ["from-node"]}},
        )

        col = self._open()
        try:
            page = bridge_ops.list_notes_in_deck(col, deck["id"])
        finally:
            col.close()

        note = next(n for n in page["notes"] if n["id"] == added["noteId"])
        self.assertEqual(note["notetypeId"], basic["id"])
        self.assertEqual(note["fields"], ["node front", "node back"])
        self.assertEqual(note["tags"], ["from-node"])

    def test_a_note_the_bridge_adds_round_trips_through_nodes_own_reader(self):
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
        notes = run_node(self.collection_path, "listNotesInDeck", {"deckId": deck["id"], "options": {}})
        note = next(n for n in notes if n["id"] == added.payload["noteId"])
        self.assertEqual(note["notetypeId"], basic["id"])
        self.assertEqual(note["fields"], ["py front", "py back"])
        self.assertEqual(note["tags"], ["from-py"])


if __name__ == "__main__":
    unittest.main()
