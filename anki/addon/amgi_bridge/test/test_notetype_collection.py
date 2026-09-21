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
    for name in ("front.html", "back.html", "front-reverse.html", "back-reverse.html", "styling.css"):
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
        self.assertEqual([t["name"] for t in found["tmpls"]], [s["name"] for s in notetype.TEMPLATES])

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

        # Two cards, one per direction, off the same note.
        cards = note.cards()
        self.assertEqual(len(cards), 2, "the note type did not generate both directions")

        forward = cards[0].render_output()
        self.assertIn("cue.mp3", forward.question_text)
        self.assertIn("이번 주말에", forward.answer_text)

        reverse = cards[1].render_output()
        # The reverse card asks the other way round: it plays the learning
        # language and wants the known one back.
        self.assertIn("target.mp3", reverse.question_text)
        self.assertNotIn("cue.mp3", reverse.question_text)
        self.assertIn("I'm meeting a friend this weekend.", reverse.answer_text)

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

        # Neither direction may show its own answer on the front.
        forward = note.cards()[0].render_output().question_text
        self.assertNotIn("타깃문장", forward)
        self.assertNotIn("a gloss that must not appear", forward)

        reverse = note.cards()[1].render_output().question_text
        self.assertNotIn("a gloss that must not appear", reverse)
        self.assertNotIn("타깃문장", reverse)

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


    def test_media_lands_under_the_name_the_card_references(self) -> None:
        """The bug this guards is silent and cost an evening to find.

        col.media.write_data() does not overwrite: given a name that already
        exists with different bytes it writes a SECOND file with the content
        hash in the name. The card hard-codes these two names - styling.css
        imports "_amgi-loop.css", the templates load "_amgi-loop.js" - so the
        current code landed somewhere nothing references and the collection
        went on rendering the first version it ever got, while a pile of
        _amgi-loop-<sha1>.js accumulated beside it. ensure_notetype even
        reported success, because it had asked for the write and believed the
        answer.

        So this asserts on the FILE the card names, after a change, which is
        the only thing that was ever actually in question.
        """
        notetype.ensure_notetype(self.col, self.assets)
        media_dir = self.col.media.dir()

        # A second install with genuinely different bytes: the case that
        # triggers Anki's rename, and the case a real card update always is.
        changed = b"// a newer build of the loop\n" + b"x" * 64
        with open(os.path.join(self.assets, "_amgi-loop.js"), "wb") as handle:
            handle.write(changed)
        notetype.ensure_notetype(self.col, self.assets)

        with open(os.path.join(media_dir, "_amgi-loop.js"), "rb") as handle:
            self.assertEqual(
                handle.read(),
                changed,
                "the file the card loads must hold the new code, not the old",
            )
        strays = [n for n in os.listdir(media_dir) if n.startswith("_amgi-loop-")]
        self.assertEqual(strays, [], "no hash-named copies should be left behind")

    def test_stray_hash_named_copies_are_cleaned_up(self) -> None:
        notetype.ensure_notetype(self.col, self.assets)
        media_dir = self.col.media.dir()
        # What the old code left in real collections.
        stray = os.path.join(media_dir, "_amgi-loop-" + "a" * 40 + ".js")
        with open(stray, "wb") as handle:
            handle.write(b"orphan")
        mine = os.path.join(media_dir, "_amgi-loop-notahash.js")
        theirs = os.path.join(media_dir, "cat.jpg")
        for path in (mine, theirs):
            with open(path, "wb") as handle:
                handle.write(b"keep me")

        notetype.ensure_notetype(self.col, self.assets)

        self.assertFalse(os.path.exists(stray), "the hash-named orphan should go")
        # Narrow on purpose: anything that is not exactly what this add-on
        # produced belongs to the learner and is not ours to delete.
        self.assertTrue(os.path.exists(mine), "a near-miss name must be left alone")
        self.assertTrue(os.path.exists(theirs), "the learner's own media must be left alone")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class ReverseCardTests(unittest.TestCase):
    """The second direction, which is a template rather than a second note."""

    def setUp(self) -> None:
        if Collection is None:
            raise unittest.SkipTest("the `anki` pip package is not installed")
        self.tmp = tempfile.mkdtemp(prefix="amgi-reverse-")
        self.col = Collection(os.path.join(self.tmp, "collection.anki2"))
        self.assets = build_assets(os.path.join(self.tmp, "cardtype"))
        notetype.ensure_notetype(self.col, self.assets)
        self.nt = self.col.models.by_name(notetype.NOTETYPE_NAME)

    def tearDown(self) -> None:
        if getattr(self, "col", None) is not None:
            self.col.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _note(self, **fields):
        note = self.col.new_note(self.nt)
        for key, value in fields.items():
            note[key] = value
        self.col.add_note(note, self.col.decks.id("amgi test"))
        return note

    def test_a_note_with_no_learning_audio_gets_no_reverse_card(self):
        # Anki only makes a card where the front renders something, so the
        # reverse direction appears by itself once the recording exists
        # rather than sitting there as an unanswerable card in the meantime.
        note = self._note(
            Cue="hello",
            CueAudio='<audio src="cue.mp3"></audio>',
            Target="안녕하세요",
            TargetAudio="",
        )
        self.assertEqual(len(note.cards()), 1)

    def test_adding_the_recording_later_creates_the_reverse_card(self):
        note = self._note(
            Cue="hello",
            CueAudio='<audio src="cue.mp3"></audio>',
            Target="안녕하세요",
            TargetAudio="",
        )
        self.assertEqual(len(note.cards()), 1)
        note["TargetAudio"] = '<audio src="target.mp3"></audio>'
        self.col.update_note(note)
        self.assertEqual(len(self.col.get_note(note.id).cards()), 2)

    def test_the_two_directions_share_one_copy_of_the_text(self):
        note = self._note(
            Cue="hello",
            CueAudio='<audio src="cue.mp3"></audio>',
            Target="안녕하세요",
            TargetAudio='<audio src="target.mp3"></audio>',
        )
        note["Target"] = "안녕"
        self.col.update_note(note)
        cards = self.col.get_note(note.id).cards()
        self.assertIn("안녕", cards[0].render_output().answer_text)
        self.assertIn("안녕", cards[1].render_output().question_text + cards[1].render_output().answer_text)

    def test_an_install_from_before_the_reverse_card_gains_it(self):
        # The upgrade path that matters: a collection built by an earlier
        # amgi has one template, and must end up with two without losing the
        # cards (or the review history) attached to the first.
        single = self.col.models.by_name(notetype.NOTETYPE_NAME)
        while len(single["tmpls"]) > 1:
            self.col.models.remove_template(single, single["tmpls"][-1])
        self.col.models.update_dict(single)
        note = self._note(
            Cue="hello",
            CueAudio='<audio src="cue.mp3"></audio>',
            Target="안녕하세요",
            TargetAudio='<audio src="target.mp3"></audio>',
        )
        first_card_id = note.cards()[0].id

        result = notetype.ensure_notetype(self.col, self.assets)
        self.assertIn("Listening reversed", result.templates_added)
        cards = self.col.get_note(note.id).cards()
        self.assertEqual(len(cards), 2)
        self.assertIn(first_card_id, [c.id for c in cards], "the original card was replaced rather than kept")
