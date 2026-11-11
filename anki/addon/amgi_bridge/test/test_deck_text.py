# Unit tests for deck_text.py, plus golden values for the rules it ports. The values were recorded
# from the JavaScript this was ported from (plusaudio/lib/deck.js and audio-store.js, both since
# deleted), so a divergence is still caught with the original gone. No dependency on the `anki` pip
# package or on Node: these run anywhere Python 3.10+ is installed.
#
# Deliberately does not `import anki`: this repo's own anki/ directory has no
# __init__.py, so if these tests ever ran with the repo root on sys.path and a
# real `anki` package also installed (as the ankienv used for
# test_core_collection.py does), Python's namespace-package rules would merge
# the two "anki" trees and could resolve `anki.media` to the wrong one. Adding
# this addon's own directory to sys.path and importing deck_text directly,
# the way Anki itself imports an add-on's modules, sidesteps that entirely.

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import deck_text  # noqa: E402

SPOKEN_TEXT = ["",
  "plain text",
  "안녕하십니까? 9시 뉴스입니다",
  "",
  "A&BA C&notarealentity;",
  "line break para item",
  "",
  "bare unquoted"]

DECODED = ["",
  "plain text",
  "<div><b>안녕하십니까</b>? 9시 뉴스<b>입니다</b></div><div></div>",
  "[sound:1-1-13-1.mp3]<img src=\"paste-125aeb8fa1091ecc1898eba0a2372987a17817a2.jpg\">",
  "A&BA C&notarealentity;",
  "line<br>break<p>para</p><li>item</li>",
  "<audio src='a.mp3'></audio><AUDIO SRC=\"b.mp3\">",
  "<audio src=c.mp3>bare unquoted</audio>"]

REFS = [[],
  [],
  [],
  [("1-1-13-1.mp3", "sound", 0, 20)],
  [],
  [],
  [("a.mp3", "html", 0, 27), ("b.mp3", "html", 27, 19)],
  [("c.mp3", "html", 0, 17)]]

RENDERED = ["[sound:a.mp3]",
  "<audio src=\"a&quot;b&amp;c.mp3\"></audio>",
  "<audio src=\"안녕.mp3\"></audio>"]

SET_OWNED = ["[sound:1-1-13-1.mp3]<img src=\"paste-125aeb8fa1091ecc1898eba0a2372987a17817a2.jpg\">[sound:plusaudio-cccccccccccccccccccc.mp3]",
  "[sound:1-1-13-1.mp3]<img src=\"paste-125aeb8fa1091ecc1898eba0a2372987a17817a2.jpg\"><audio src=\"plusaudio-cccccccccccccccccccc.mp3\"></audio>",
  "[sound:plusaudio-cccccccccccccccccccc.mp3]",
  "1-1-13-1_gpt4o.mp3 plain<audio src=\"plusaudio-dddddddddddddddddddd.mp3\"></audio>"]

MEDIA_NAMES = ["plusaudio-dce4d16cea2470806c22.wav",
  "plusaudio-f364f47094e4d8912c22.wav",
  "plusaudio-90f9a7cbebe9c12e69e1.wav",
  "plusaudio-88fce36fc5541e5201ec.wav"]


class DeckTextUnitTests(unittest.TestCase):
    def test_spoken_text_strips_markup_and_sound_tags(self):
        html = "<div><b>안녕하십니까</b>? 9시 뉴스<b>입니다</b></div>[sound:x.mp3]<!-- c -->"
        self.assertEqual(deck_text.spoken_text(html), "안녕하십니까? 9시 뉴스입니다")

    def test_decode_entities_handles_named_numeric_and_nbsp(self):
        self.assertEqual(deck_text.decode_entities("A&amp;B&#65;&nbsp;C"), "A&BA C")

    def test_audio_references_finds_both_forms_in_order(self):
        field = '[sound:a.mp3]<img src="x.jpg"><audio src="b.mp3"></audio>'
        refs = deck_text.audio_references(field)
        self.assertEqual([(r.name, r.form) for r in refs], [("a.mp3", "sound"), ("b.mp3", "html")])

    def test_render_audio_reference_escapes_html_form(self):
        self.assertEqual(deck_text.render_audio_reference('a"b&c.mp3', "html"), '<audio src="a&quot;b&amp;c.mp3"></audio>')
        self.assertEqual(deck_text.render_audio_reference("a.mp3", "sound"), "[sound:a.mp3]")

    def test_set_owned_audio_replaces_only_owned_reference_and_keeps_other_content(self):
        field = '[sound:1-1.mp3]<img src="pic.jpg">[sound:plusaudio-aaaaaaaaaaaaaaaaaaaa.mp3]'
        updated = deck_text.set_owned_audio(field, "plusaudio-bbbbbbbbbbbbbbbbbbbb.mp3", deck_text.is_owned_media_name, "sound")
        self.assertEqual(updated, '[sound:1-1.mp3]<img src="pic.jpg">[sound:plusaudio-bbbbbbbbbbbbbbbbbbbb.mp3]')

    def test_set_owned_audio_appends_when_nothing_owned_yet(self):
        field = '[sound:1-1.mp3]<img src="pic.jpg">'
        updated = deck_text.set_owned_audio(field, "plusaudio-bbbbbbbbbbbbbbbbbbbb.mp3", deck_text.is_owned_media_name, "html")
        self.assertEqual(updated, field + '<audio src="plusaudio-bbbbbbbbbbbbbbbbbbbb.mp3"></audio>')

    def test_media_name_is_a_sha1_of_profile_language_and_text(self):
        name = deck_text.media_name("안녕하세요", "ko")
        self.assertRegex(name, r"^plusaudio-[0-9a-f]{20}\.wav$")
        # Same inputs, same name - the whole idempotency scheme depends on this.
        self.assertEqual(name, deck_text.media_name("안녕하세요", "ko"))
        self.assertNotEqual(name, deck_text.media_name("안녕하세요", "ja"))

    def test_is_owned_media_name_recognises_current_and_legacy_names(self):
        self.assertTrue(deck_text.is_owned_media_name("plusaudio-" + "a" * 20 + ".mp3"))
        self.assertTrue(deck_text.is_owned_media_name("plusaudio-" + "a" * 20 + ".wav"))
        self.assertFalse(deck_text.is_owned_media_name("plusaudio-" + "a" * 20 + ".ogg"))
        self.assertTrue(deck_text.is_owned_media_name("1-1-13-1_gpt4o.mp3"))
        self.assertFalse(deck_text.is_owned_media_name("1-1-13-1.mp3"))
        self.assertFalse(deck_text.is_owned_media_name("plusaudio-" + "a" * 19 + ".mp3"))


class DeckTextGoldenTests(unittest.TestCase):
    """A divergence from the rules deck_text.py ports would be a bug in a user's live collection, not
    just a failing test. The expected values above were recorded from the JavaScript original."""

    SAMPLE_FIELDS = [
        "",
        "plain text",
        "<div><b>안녕하십니까</b>? 9시 뉴스<b>입니다</b></div><div></div>",
        '[sound:1-1-13-1.mp3]<img src="paste-125aeb8fa1091ecc1898eba0a2372987a17817a2.jpg">',
        "A&amp;B&#65;&nbsp;C&notarealentity;",
        "line<br>break<p>para</p><li>item</li>",
        '<audio src=\'a.mp3\'></audio><AUDIO SRC="b.mp3">',
        "<audio src=c.mp3>bare unquoted</audio>",
    ]

    def test_spoken_text_matches_the_recording(self):
        for field, want in zip(self.SAMPLE_FIELDS, SPOKEN_TEXT):
            with self.subTest(field=field):
                self.assertEqual(deck_text.spoken_text(field), want)

    def test_decode_entities_matches_the_recording(self):
        for field, want in zip(self.SAMPLE_FIELDS, DECODED):
            with self.subTest(field=field):
                self.assertEqual(deck_text.decode_entities(field), want)

    def test_audio_references_matches_the_recording(self):
        for field, want in zip(self.SAMPLE_FIELDS, REFS):
            with self.subTest(field=field):
                got = [(r.name, r.form, r.index, r.length) for r in deck_text.audio_references(field)]
                self.assertEqual(got, want)

    def test_render_audio_reference_matches_the_recording(self):
        cases = [("a.mp3", "sound"), ('a"b&c.mp3', "html"), ("안녕.mp3", "html")]
        for (filename, form), want in zip(cases, RENDERED):
            with self.subTest(filename=filename, form=form):
                self.assertEqual(deck_text.render_audio_reference(filename, form), want)

    def test_set_owned_audio_matches_the_recording(self):
        cases = [
            (self.SAMPLE_FIELDS[3], "plusaudio-" + "c" * 20 + ".mp3", "sound"),
            (self.SAMPLE_FIELDS[3], "plusaudio-" + "c" * 20 + ".mp3", "html"),
            ("", "plusaudio-" + "c" * 20 + ".mp3", "sound"),
            ("1-1-13-1_gpt4o.mp3 plain", "plusaudio-" + "d" * 20 + ".mp3", "html"),
        ]
        for (field, filename, form), want in zip(cases, SET_OWNED):
            with self.subTest(field=field, filename=filename, form=form):
                self.assertEqual(deck_text.set_owned_audio(field, filename, deck_text.is_owned_media_name, form), want)

    def test_media_name_matches_the_recording(self):
        cases = [("안녕하세요", "ko"), ("hello", "en"), ("", "ja"), ("a\nb", "zh_cn")]
        for (text, language), want in zip(cases, MEDIA_NAMES):
            with self.subTest(text=text, language=language):
                self.assertEqual(deck_text.media_name(text, language), want)


if __name__ == "__main__":
    unittest.main()
