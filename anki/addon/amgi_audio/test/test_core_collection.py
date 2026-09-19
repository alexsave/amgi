# Integration tests for core.py against a REAL anki.collection.Collection -
# not a fake, not a mock of Anki's own API. This is the closest this add-on
# can get to proving it works without running inside Anki itself, and it is
# the whole reason core.py has no aqt import: aqt needs Qt, which is not
# installable in a throwaway environment, but the pure `anki` package - the
# real Collection, the real media manager, the real note/field bookkeeping -
# is, and this suite runs against it.
#
# NOT wired into `pnpm test`: the `anki` pip package is a large, Rust-backed
# wheel this repo does not otherwise depend on, and pnpm test has to pass on
# a plain checkout with no Python environment at all. Run this manually with
# a Python that has `anki` installed:
#
#   python -m venv anki-test-env && anki-test-env/bin/pip install anki
#   cd anki/addon/amgi_audio && anki-test-env/bin/python -m unittest test.test_core_collection -v
#
# The `cd` matters, not just the pip install: see the sys.path note below.

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

# Import this add-on's own modules directly, from its own directory, rather
# than as `anki.addon.amgi_audio.core`. This repo's own top-level anki/
# directory has no __init__.py, and neither does the real `anki` pip package
# (it is an implicit namespace package - see anki/addon/amgi_audio/README.md,
# "A namespace collision worth knowing about"). If this file's own directory
# is not what ends up on sys.path - for instance if these tests are run with
# the repo root as the working directory - Python can merge the repo's anki/
# folder into the real `anki` package's namespace and resolve `anki.media` to
# the wrong thing entirely. Prepending this test's own directory's parent
# keeps `import core` and `import anki.collection` from ever touching the
# same namespace.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import core  # noqa: E402
from core import AudioFillConfig, apply_fill, plan_fill  # noqa: E402

try:
    import anki.lang
except ModuleNotFoundError:  # pragma: no cover - environment-dependent
    anki = None  # type: ignore[assignment]


SAMPLE_DECK = os.environ.get("AMGI_SAMPLE_APKG")


def _require_anki() -> None:
    if anki is None:
        raise unittest.SkipTest("the `anki` pip package is not installed; see this file's module docstring")


class FakeMediaCollection(unittest.TestCase):
    """A hand-built collection covering the field shapes that matter, so these
    checks do not depend on any particular sample deck being present. The
    real sample-deck suite below covers the messier, real-world case."""

    def setUp(self):
        _require_anki()
        import anki.lang
        from anki.collection import Collection

        anki.lang.set_lang("en_US")
        self.tmpdir = tempfile.mkdtemp()
        self.col = Collection(os.path.join(self.tmpdir, "collection.anki2"))
        self.addCleanup(self._close)

        notetype = self.col.models.by_name("Basic")
        self.col.models.rename_field(notetype, notetype["flds"][0], "Text")
        self.col.models.rename_field(notetype, notetype["flds"][1], "Audio")
        self.col.models.update_dict(notetype)
        self.notetype = notetype

        self.deck_id = self.col.decks.id("Fill test")

    def _close(self):
        self.col.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _add_note(self, text: str, audio_field: str = "") -> int:
        note = self.col.new_note(self.notetype)
        note["Text"] = text
        note["Audio"] = audio_field
        self.col.add_note(note, self.deck_id)
        return note.id

    def config(self, **overrides) -> AudioFillConfig:
        defaults = dict(deck_id=self.deck_id, text_field="Text", audio_field="Audio", language="ko", audio_tag="sound")
        defaults.update(overrides)
        return AudioFillConfig(**defaults)

    # ------------------------------------------------------------------
    # plan_fill

    def test_plan_finds_a_note_with_no_audio_yet(self):
        nid = self._add_note("안녕하세요")
        plan = plan_fill(self.col, self.config())
        self.assertEqual([p.note_id for p in plan.to_fill], [nid])
        self.assertEqual(plan.up_to_date_count, 0)

    def test_plan_skips_a_note_whose_text_field_is_empty_after_stripping_markup(self):
        self._add_note("<div></div>")
        plan = plan_fill(self.col, self.config())
        self.assertEqual(plan.to_fill, [])
        self.assertEqual([reason for _nid, reason in plan.skipped], ["text field is empty once markup is stripped"])

    def test_plan_leaves_out_a_note_from_a_different_deck(self):
        other_deck = self.col.decks.id("Somewhere else")
        note = self.col.new_note(self.notetype)
        note["Text"] = "안녕"
        note["Audio"] = ""
        self.col.add_note(note, other_deck)
        plan = plan_fill(self.col, self.config())
        self.assertEqual(plan.to_fill, [])

    # ------------------------------------------------------------------
    # apply_fill: the write path

    def test_apply_fill_writes_media_and_a_sound_tag_and_leaves_other_content_alone(self):
        nid = self._add_note("안녕하세요", audio_field='<img src="pic.jpg">')
        plan = plan_fill(self.col, self.config(audio_tag="sound"))
        result = apply_fill(self.col, plan, fetch_audio=lambda text: b"FAKE-MP3-BYTES")

        self.assertEqual(result.updated, [nid])
        self.assertEqual(result.failed, [])
        self.assertIsNotNone(result.changes)

        note = self.col.get_note(nid)
        self.assertIn('<img src="pic.jpg">', note["Audio"])
        self.assertRegex(note["Audio"], r"\[sound:plusaudio-[0-9a-f]{20}\.mp3\]")

        filename = core.media_name("안녕하세요", "ko")
        self.assertTrue(self.col.media.have(filename))
        with open(os.path.join(self.col.media.dir(), filename), "rb") as fh:
            self.assertEqual(fh.read(), b"FAKE-MP3-BYTES")

    def test_apply_fill_writes_the_html_audio_form_when_asked(self):
        nid = self._add_note("안녕하세요")
        plan = plan_fill(self.col, self.config(audio_tag="html"))
        apply_fill(self.col, plan, fetch_audio=lambda text: b"FAKE-MP3-BYTES")
        note = self.col.get_note(nid)
        self.assertRegex(note["Audio"], r'<audio src="plusaudio-[0-9a-f]{20}\.mp3"></audio>')

    def test_a_second_run_is_a_no_op(self):
        self._add_note("안녕하세요")
        config = self.config()
        first_plan = plan_fill(self.col, config)
        apply_fill(self.col, first_plan, fetch_audio=lambda text: b"FAKE-MP3-BYTES")

        calls: list[str] = []
        second_plan = plan_fill(self.col, config)
        self.assertEqual(second_plan.to_fill, [])
        self.assertEqual(second_plan.up_to_date_count, 1)
        second_result = apply_fill(self.col, second_plan, fetch_audio=lambda text: calls.append(text) or b"should not run")
        self.assertEqual(calls, [])
        self.assertEqual(second_result.updated, [])
        self.assertIsNone(second_result.changes)

    def test_editing_the_text_regenerates_and_replaces_the_old_clip_reference(self):
        nid = self._add_note("안녕하세요")
        config = self.config()
        apply_fill(self.col, plan_fill(self.col, config), fetch_audio=lambda text: b"FIRST")

        note = self.col.get_note(nid)
        note["Text"] = "안녕히 가세요"
        self.col.update_note(note)

        second_plan = plan_fill(self.col, config)
        self.assertEqual([p.note_id for p in second_plan.to_fill], [nid])
        apply_fill(self.col, second_plan, fetch_audio=lambda text: b"SECOND")

        updated = self.col.get_note(nid)
        # Exactly one owned reference - the note never ends up pointing at
        # both the old and the new clip.
        owned = [r for r in core.audio_references(updated["Audio"]) if core.is_owned_media_name(r.name)]
        self.assertEqual(len(owned), 1)
        self.assertEqual(owned[0].name, core.media_name("안녕히 가세요", "ko"))

    def test_running_the_other_audio_tag_converts_without_regenerating(self):
        nid = self._add_note("안녕하세요")
        apply_fill(self.col, plan_fill(self.col, self.config(audio_tag="sound")), fetch_audio=lambda text: b"FAKE")

        calls: list[str] = []
        converted_plan = plan_fill(self.col, self.config(audio_tag="html"))
        self.assertEqual([p.note_id for p in converted_plan.to_fill], [nid])
        apply_fill(self.col, converted_plan, fetch_audio=lambda text: calls.append(text) or b"should not run")

        self.assertEqual(calls, [], "the clip is a content hash of the same text; converting should not regenerate it")
        note = self.col.get_note(nid)
        self.assertIn("<audio src=", note["Audio"])
        self.assertNotIn("[sound:", note["Audio"])

    def test_a_note_that_already_has_the_deck_authors_own_audio_still_gets_the_generated_clip_appended(self):
        nid = self._add_note("안녕하세요", audio_field="[sound:original-recording.mp3]")
        apply_fill(self.col, plan_fill(self.col, self.config()), fetch_audio=lambda text: b"FAKE")
        note = self.col.get_note(nid)
        self.assertIn("[sound:original-recording.mp3]", note["Audio"])
        self.assertRegex(note["Audio"], r"\[sound:plusaudio-[0-9a-f]{20}\.mp3\]")

    def test_a_note_type_missing_the_mapped_field_is_skipped_not_crashed_on(self):
        other_notetype = self.col.models.by_name("Basic (and reversed card)")
        note = self.col.new_note(other_notetype)
        self.col.add_note(note, self.deck_id)
        plan = plan_fill(self.col, self.config())
        self.assertEqual(plan.to_fill, [])
        self.assertEqual(len(plan.skipped), 1)

    def test_a_failed_generation_is_skipped_and_retried_next_run(self):
        nid = self._add_note("안녕하세요")
        config = self.config()

        def failing_fetch(text: str) -> bytes:
            raise RuntimeError("network exploded")

        plan = plan_fill(self.col, config)
        result = apply_fill(self.col, plan, fetch_audio=failing_fetch)
        self.assertEqual(result.updated, [])
        self.assertEqual(len(result.failed), 1)
        self.assertIsNone(result.changes)

        note = self.col.get_note(nid)
        self.assertEqual(note["Audio"], "")

        retry_plan = plan_fill(self.col, config)
        self.assertEqual([p.note_id for p in retry_plan.to_fill], [nid])
        retry_result = apply_fill(self.col, retry_plan, fetch_audio=lambda text: b"OK NOW")
        self.assertEqual(retry_result.updated, [nid])

    def test_cancelling_partway_leaves_earlier_notes_committed_and_later_ones_untouched(self):
        first = self._add_note("첫번째")
        second = self._add_note("두번째")
        config = self.config()
        plan = plan_fill(self.col, config)
        self.assertEqual(len(plan.to_fill), 2)

        cancel_after_first = {"count": 0}

        def want_cancel() -> bool:
            return cancel_after_first["count"] >= 1

        def counting_fetch(text: str) -> bytes:
            cancel_after_first["count"] += 1
            return b"AUDIO"

        result = apply_fill(self.col, plan, fetch_audio=counting_fetch, want_cancel=want_cancel)
        self.assertTrue(result.cancelled)
        self.assertEqual(result.updated, [first])

        note_one = self.col.get_note(first)
        note_two = self.col.get_note(second)
        self.assertNotEqual(note_one["Audio"], "")
        self.assertEqual(note_two["Audio"], "")

        # A resumed run finishes the one the cancellation left behind, and
        # does not touch the one already done.
        resumed_plan = plan_fill(self.col, config)
        self.assertEqual([p.note_id for p in resumed_plan.to_fill], [second])
        apply_fill(self.col, resumed_plan, fetch_audio=lambda text: b"AUDIO2")
        self.assertNotEqual(self.col.get_note(second)["Audio"], "")

    def test_media_check_reports_the_added_clip_as_used_and_nothing_missing(self):
        self._add_note("안녕하세요")
        apply_fill(self.col, plan_fill(self.col, self.config()), fetch_audio=lambda text: b"FAKE")
        report = self.col.media.check()
        self.assertEqual(list(report.missing), [])
        self.assertEqual(list(report.unused), [])


@unittest.skipUnless(SAMPLE_DECK, "set AMGI_SAMPLE_APKG to a real .apkg to run the sample-deck suite")
class SampleDeckTests(unittest.TestCase):
    """Runs against a real, messy, 333-note shared deck rather than a
    hand-built fixture: existing [sound:] tags from the deck's own author,
    <img> tags in the same field the audio goes into, HTML in the text field.
    Set AMGI_SAMPLE_APKG to the .apkg path to run it."""

    # Fresh collection per test, imported from the same source .apkg each
    # time: these tests mutate the collection, and sharing one across tests
    # would make each test's result depend on what ran before it.
    def setUp(self):
        _require_anki()
        import anki.lang
        from anki.collection import Collection
        from anki.import_export_pb2 import ImportAnkiPackageOptions, ImportAnkiPackageRequest

        anki.lang.set_lang("en_US")
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.col = Collection(os.path.join(self.tmpdir, "collection.anki2"))
        self.addCleanup(self.col.close)
        self.col.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=os.path.abspath(SAMPLE_DECK),
                options=ImportAnkiPackageOptions(with_scheduling=True),
            )
        )
        names_and_ids = self.col.decks.all_names_and_ids()
        self.deck_id = next(d.id for d in names_and_ids if d.name.endswith("Retro's Beginner Grammar Sentences"))

    def config(self, **overrides) -> AudioFillConfig:
        defaults = dict(deck_id=self.deck_id, text_field="Korean", audio_field="Audio", language="ko", audio_tag="sound")
        defaults.update(overrides)
        return AudioFillConfig(**defaults)

    def test_plan_covers_every_note_in_the_deck(self):
        plan = plan_fill(self.col, self.config())
        self.assertEqual(plan.total_considered, 333)
        self.assertEqual(plan.up_to_date_count, 0)
        self.assertEqual(plan.to_fill.__len__() + len(plan.skipped), 333)

    def test_fill_the_first_thirty_notes_and_check_media_and_idempotency(self):
        plan = plan_fill(self.col, self.config())
        subset = plan.to_fill[:30]
        from dataclasses import replace

        partial_plan = replace(plan, to_fill=subset)

        seen_texts: list[str] = []

        def fetch(text: str) -> bytes:
            seen_texts.append(text)
            return f"FAKE-AUDIO-FOR-{text}".encode("utf-8")

        result = apply_fill(self.col, partial_plan, fetch_audio=fetch)
        self.assertEqual(len(result.updated), 30)
        self.assertEqual(len(seen_texts), len(set(seen_texts)), "no clip should be generated twice in one run")

        for planned in subset:
            note = self.col.get_note(planned.note_id)
            self.assertRegex(note["Audio"], r"\[sound:plusaudio-[0-9a-f]{20}\.mp3\]")
            # The original deck's own recording, wherever there was one,
            # must still be there.
            self.assertIn(planned.note_id, [p.note_id for p in subset])

        report = self.col.media.check()
        our_missing = [name for name in report.missing if name.startswith("plusaudio-")]
        our_unused = [name for name in report.unused if name.startswith("plusaudio-")]
        self.assertEqual(our_missing, [])
        self.assertEqual(our_unused, [])

        # Re-running over the whole deck now only proposes the remaining 303.
        second_plan = plan_fill(self.col, self.config())
        self.assertEqual(len(second_plan.to_fill), 333 - 30)
        self.assertEqual(second_plan.up_to_date_count, 30)


if __name__ == "__main__":
    unittest.main()
