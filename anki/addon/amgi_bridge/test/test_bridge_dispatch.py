# bridge_dispatch.py's writes, end to end through its real code, against a REAL
# anki.collection.Collection, with a stand-in for the two pieces of aqt it
# uses (aqt.mw and aqt.operations). The stand-in does what Anki's own
# CollectionOp does with a write's result: it hands the result to the success
# callback, and then takes the OpChanges off it (the result itself, or its
# `.changes`) to fire Anki's change hooks. A write in bridge_ops.py that
# returns anything else (a bare dict) fails here the way it fails inside Anki.
#
# Needs the `anki` pip package, as test_bridge_ops.py does; skipped without it.

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import anki.lang
    from anki.collection import Collection, OpChanges
except ModuleNotFoundError:  # pragma: no cover - environment-dependent
    anki = None  # type: ignore[assignment]


class _Op:
    def __init__(self, parent=None, op=None, success=None):
        self._op, self._success, self._failure = op, success, None

    def success(self, fn):
        self._success = fn
        return self

    def failure(self, fn):
        self._failure = fn
        return self


class FakeCollectionOp(_Op):
    def run_in_background(self, *, initiator=None):
        mw = sys.modules["aqt"].mw
        try:
            out = self._op(mw.col)
        except Exception as error:  # noqa: BLE001 - handed to the failure callback, as aqt does
            self._failure(error)
            return
        # aqt.operations.CollectionOp: success first, then the change hooks
        # read the OpChanges off the result.
        self._success(out)
        changes = out if isinstance(out, OpChanges) else out.changes
        if not isinstance(changes, OpChanges):
            raise TypeError(f"a CollectionOp result must carry OpChanges, got {type(changes).__name__}")
        mw.changes_seen.append(changes)


class FakeQueryOp(_Op):
    def run_in_background(self):
        mw = sys.modules["aqt"].mw
        try:
            out = self._op(mw.col)
        except Exception as error:  # noqa: BLE001
            self._failure(error)
            return
        self._success(out)


@unittest.skipIf(anki is None, "the `anki` pip package is not installed")
class DispatcherWriteTests(unittest.TestCase):
    def setUp(self):
        anki.lang.set_lang("en_US")
        self.tmpdir = tempfile.mkdtemp()
        self.col = Collection(os.path.join(self.tmpdir, "collection.anki2"))
        mw = types.SimpleNamespace(col=self.col, changes_seen=[], taskman=types.SimpleNamespace(run_on_main=lambda fn: fn()))
        aqt = types.ModuleType("aqt")
        aqt.mw = mw
        operations = types.ModuleType("aqt.operations")
        operations.CollectionOp, operations.QueryOp = FakeCollectionOp, FakeQueryOp
        self._saved = {k: sys.modules.get(k) for k in ("aqt", "aqt.operations", "bridge_dispatch")}
        sys.modules["aqt"], sys.modules["aqt.operations"] = aqt, operations
        sys.modules.pop("bridge_dispatch", None)
        import bridge_dispatch

        self.dispatcher = bridge_dispatch.AqtBridgeDispatcher(timeout=5)
        self.mw = mw
        self.addCleanup(self._restore)

    def _restore(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        self.col.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _note(self, did, front):
        note = self.col.new_note(self.col.models.by_name("Basic"))
        note.fields[0], note.fields[1] = front, "back"
        self.col.add_note(note, did)
        return note

    def test_rename_deck(self):
        did = self.col.decks.id("Korean")
        self.assertEqual(self.dispatcher.rename_deck(did, "Korean 2"), {"id": did, "name": "Korean 2"})
        self.assertEqual(len(self.mw.changes_seen), 1)

    def test_remove_note(self):
        note = self._note(self.col.decks.id("Korean"), "a")
        self.assertEqual(self.dispatcher.remove_note(note.id), {"noteId": note.id, "cardsRemoved": 1})
        self.assertEqual(len(self.mw.changes_seen), 1)

    def test_deck_summary_and_remove_deck(self):
        did = self.col.decks.id("Korean")
        self.col.decks.id("Korean::Verbs")
        self._note(did, "a")
        self.assertEqual(self.dispatcher.deck_summary(did), {"id": did, "name": "Korean", "subdecks": 1, "cards": 1, "notes": 1})
        self.assertEqual(self.dispatcher.remove_deck(did), {"id": did, "name": "Korean", "decks": 2, "cards": 1, "notes": 1})
        self.assertEqual(len(self.mw.changes_seen), 1)
        self.assertIsNone(self.col.decks.get(did, default=False))


if __name__ == "__main__":
    unittest.main()
