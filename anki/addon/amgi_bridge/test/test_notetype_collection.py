# Integration tests for notetype.py against a REAL anki.collection.Collection.
#
# The whole point of putting note type creation inside the add-on rather than
# in the Node collection layer is that Anki's own API is correct by
# construction across schema versions, where hand-written protobuf would not
# be. A test against a fake `col` would throw that away entirely: it would
# prove this file calls the methods it calls, and nothing about whether the
# note type Anki ends up with is one Anki can actually render. So this runs
# against the real thing, and asserts on what the COLLECTION says afterwards
# rather than on what was called.
#
# NOT wired into `npm test`, same as test_core_collection.py: the `anki` pip
# package is a large Rust-backed wheel this repo does not otherwise depend on.
# Run it manually with a Python that has `anki` installed:
#
#   python -m venv anki-test-env && anki-test-env/bin/pip install anki
#   cd anki/addon/amgi_bridge && anki-test-env/bin/python -m unittest test.test_notetype_collection -v
#
# The `cd` matters - see test_core_collection.py's own note on the namespace
# collision between this repo's anki/ directory and the real anki package.

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import notetype  # noqa: E402

# `npm test` runs this directory with a plain python3 that has no `anki` in
# it, so the import cannot be unconditional - an ImportError at module scope
# is a hard failure for the whole discovery run, not a skip. Same pattern as
# test_core_collection.py, for the same reason.
try:
    from anki.collection import Collection
except ModuleNotFoundError:  # pragma: no cover - environment-dependent
    Collection = None  # type: ignore[assignment]

REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)


def build_assets(target: str) -> str:
    """A cardtype/ folder, populated from the repo the way the installer does."""
    os.makedirs(target, exist_ok=True)
    for name in ("front.html", "back.html", "styling.css"):
        shutil.copyfile(os.path.join(REPO_ROOT, "anki", "notetype", name), os.path.join(target, name))
    for name in notetype.MEDIA_FILES:
        shutil.copyfile(os.path.join(REPO_ROOT, "anki", "media", name), os.path.join(target, name))
    return target


class EnsureNotetypeTests(unittest.TestCase):
    def setUp(self) -> None:
        if Collection is None:
            raise unittest.SkipTest(
                "the `anki` pip package is not installed; see this file's module docstring"
            )
        self.tmp = tempfile.mkdtemp(prefix="amgi-notetype-")
        self.col = Collection(os.path.join(self.tmp, "collection.anki2"))
        self.assets = build_assets(os.path.join(self.tmp, "cardtype"))

    def tearDown(self) -> None:
        if getattr(self, "col", None) is not None:
            self.col.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_creates_a_notetype_anki_itself_can_render(self):
        result = notetype.ensure_notetype(self.col, self.assets)
        self.assertTrue(result.created)

        found = self.col.models.by_name(notetype.NOTETYPE_NAME)
        self.assertIsNotNone(found, "the note type is not in the collection afterwards")
        self.assertEqual([f["name"] for f in found["flds"]], list(notetype.FIELD_NAMES))
        self.assertEqual(len(found["tmpls"]), 1)

        # The real proof: a note on this type produces a card, and Anki's own
        # renderer turns it into a question containing the cue audio and an
        # answer containing the target - which is what the templates promise.
        note = self.col.new_note(found)
        note["Cue"] = "I'm meeting a friend this weekend."
        note["CueAudio"] = '<audio src="cue.mp3"></audio>'
        note["Target"] = "이번 주말에 친구를 만날 거예요."
        note["TargetAudio"] = '<audio src="target.mp3"></audio>'
        note["Language"] = "ko"
        self.col.add_note(note, self.col.decks.id("amgi test"))

        cards = note.cards()
        self.assertEqual(len(cards), 1, "the note type did not generate exactly one card")
        rendered = cards[0].render_output()
        self.assertIn("cue.mp3", rendered.question_text)
        self.assertIn("이번 주말에", rendered.answer_text)

    def test_the_front_never_contains_the_answer(self):
        # The one property of this note type that actually matters for
        # learning, asserted against Anki's own renderer rather than against
        # the template text: if the target leaks onto the front, the card is
        # a reading exercise.
        notetype.ensure_notetype(self.col, self.assets)
        found = self.col.models.by_name(notetype.NOTETYPE_NAME)
        note = self.col.new_note(found)
        note["Cue"] = "a gloss that must not appear"
        note["CueAudio"] = '<audio src="cue.mp3"></audio>'
        note["Target"] = "타깃문장"
        note["TargetAudio"] = '<audio src="target.mp3"></audio>'
        self.col.add_note(note, self.col.decks.id("amgi test"))

        question = note.cards()[0].render_output().question_text
        self.assertNotIn("타깃문장", question)
        self.assertNotIn("a gloss that must not appear", question)

    def test_media_lands_in_the_collection_media_folder(self):
        result = notetype.ensure_notetype(self.col, self.assets)
        self.assertEqual(sorted(result.media_written), sorted(notetype.MEDIA_FILES))
        for name in notetype.MEDIA_FILES:
            self.assertTrue(
                os.path.isfile(os.path.join(self.col.media.dir(), name)),
                f"{name} is not in the media folder",
            )

    def test_running_twice_changes_nothing_the_second_time(self):
        notetype.ensure_notetype(self.col, self.assets)
        again = notetype.ensure_notetype(self.col, self.assets)
        self.assertFalse(again.created)
        self.assertEqual(again.fields_added, [])
        self.assertFalse(again.templates_updated)
        self.assertFalse(again.css_updated)
        self.assertEqual(again.media_written, [])
        self.assertFalse(again.changed, again.summary())

    def test_a_stale_template_is_refreshed_without_touching_notes(self):
        notetype.ensure_notetype(self.col, self.assets)
        found = self.col.models.by_name(notetype.NOTETYPE_NAME)
        note = self.col.new_note(found)
        note["Cue"] = "keep me"
        note["CueAudio"] = '<audio src="cue.mp3"></audio>'
        note["Target"] = "지켜줘"
        self.col.add_note(note, self.col.decks.id("amgi test"))
        note_id = note.id

        # Simulate an older install: templates and styling from a previous
        # version of the repo. The stale front still has to reference a field
        # - Anki's own backend rejects a front template with no field
        # replacement outright (CardTypeError), which is worth knowing: it
        # means a half-written template can never be saved, by us or anyone.
        found["tmpls"][0]["qfmt"] = "<div>old front {{CueAudio}}</div>"
        found["css"] = "/* old */"
        self.col.models.update_dict(found)

        result = notetype.ensure_notetype(self.col, self.assets)
        self.assertTrue(result.templates_updated)
        self.assertTrue(result.css_updated)

        refreshed = self.col.models.by_name(notetype.NOTETYPE_NAME)
        self.assertNotIn("old front", refreshed["tmpls"][0]["qfmt"])
        self.assertNotIn("/* old */", refreshed["css"])

        kept = self.col.get_note(note_id)
        self.assertEqual(kept["Cue"], "keep me")
        self.assertEqual(kept["Target"], "지켜줘")

    def test_a_field_the_learner_added_is_left_alone(self):
        notetype.ensure_notetype(self.col, self.assets)
        found = self.col.models.by_name(notetype.NOTETYPE_NAME)
        self.col.models.add_field(found, self.col.models.new_field("MyOwnField"))
        self.col.models.update_dict(found)

        notetype.ensure_notetype(self.col, self.assets)
        after = [f["name"] for f in self.col.models.by_name(notetype.NOTETYPE_NAME)["flds"]]
        self.assertIn("MyOwnField", after)

    def test_a_missing_field_is_added_back(self):
        notetype.ensure_notetype(self.col, self.assets)
        found = self.col.models.by_name(notetype.NOTETYPE_NAME)
        target = next(f for f in found["flds"] if f["name"] == "Notes")
        self.col.models.remove_field(found, target)
        self.col.models.update_dict(found)

        result = notetype.ensure_notetype(self.col, self.assets)
        self.assertEqual(result.fields_added, ["Notes"])
        after = [f["name"] for f in self.col.models.by_name(notetype.NOTETYPE_NAME)["flds"]]
        self.assertIn("Notes", after)

    def test_incomplete_assets_are_refused_rather_than_half_installed(self):
        os.remove(os.path.join(self.assets, "back.html"))
        with self.assertRaises(notetype.AssetsMissing):
            notetype.ensure_notetype(self.col, self.assets)
        self.assertIsNone(self.col.models.by_name(notetype.NOTETYPE_NAME))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
