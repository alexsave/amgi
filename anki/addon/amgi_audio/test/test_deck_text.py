# Unit tests for deck_text.py, plus a parity check against the Node modules it
# is a port of. No dependency on the `anki` pip package: these run anywhere
# Python 3.10+ and Node are installed, including plain `pnpm test`.
#
# Deliberately does not `import anki`: this repo's own anki/ directory has no
# __init__.py, so if these tests ever ran with the repo root on sys.path and a
# real `anki` package also installed (as the ankienv used for
# test_core_collection.py does), Python's namespace-package rules would merge
# the two "anki" trees and could resolve `anki.media` to the wrong one. Adding
# this addon's own directory to sys.path and importing deck_text directly,
# the way Anki itself imports an add-on's modules, sidesteps that entirely.

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import deck_text  # noqa: E402

# .../test/test_deck_text.py -> test -> amgi_audio -> addon -> anki -> repo root
REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
)


def node_available() -> bool:
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def run_node_probe(payload: dict) -> dict:
    """Runs the real plusaudio/lib functions in Node and returns their output,
    so the parity tests compare against the actual source rather than a
    second, hand-copied idea of what it does."""
    script = r"""
const deck = require(process.argv[1]);
const { mediaName, isOwnedMediaName } = require(process.argv[2]);
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = {};
if ('spokenTextOf' in input) out.spokenText = deck.spokenText(input.spokenTextOf);
if ('decodeEntitiesOf' in input) out.decodeEntities = deck.decodeEntities(input.decodeEntitiesOf);
if ('audioReferencesOf' in input) {
  out.audioReferences = deck.audioReferences(input.audioReferencesOf).map((r) => ({
    name: r.name, form: r.form, index: r.index, length: r.length,
  }));
}
if ('renderAudioReference' in input) {
  out.renderAudioReference = deck.renderAudioReference(
    input.renderAudioReference.filename, input.renderAudioReference.form,
  );
}
if ('setOwnedAudio' in input) {
  const p = input.setOwnedAudio;
  out.setOwnedAudio = deck.setOwnedAudio(p.fieldText, p.filename, isOwnedMediaName, p.form);
}
if ('mediaNameOf' in input) out.mediaName = mediaName(input.mediaNameOf.text, input.mediaNameOf.language);
if ('isOwnedMediaNameOf' in input) out.isOwnedMediaName = isOwnedMediaName(input.isOwnedMediaNameOf);
process.stdout.write(JSON.stringify(out));
"""
    deck_js = os.path.join(REPO_ROOT, "plusaudio", "lib", "deck.js")
    audio_store_js = os.path.join(REPO_ROOT, "plusaudio", "lib", "audio-store.js")
    result = subprocess.run(
        ["node", "-e", script, deck_js, audio_store_js],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


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
        self.assertRegex(name, r"^plusaudio-[0-9a-f]{20}\.mp3$")
        # Same inputs, same name - the whole idempotency scheme depends on this.
        self.assertEqual(name, deck_text.media_name("안녕하세요", "ko"))
        self.assertNotEqual(name, deck_text.media_name("안녕하세요", "ja"))

    def test_is_owned_media_name_recognises_current_and_legacy_names(self):
        self.assertTrue(deck_text.is_owned_media_name("plusaudio-" + "a" * 20 + ".mp3"))
        self.assertTrue(deck_text.is_owned_media_name("1-1-13-1_gpt4o.mp3"))
        self.assertFalse(deck_text.is_owned_media_name("1-1-13-1.mp3"))
        self.assertFalse(deck_text.is_owned_media_name("plusaudio-" + "a" * 19 + ".mp3"))


@unittest.skipUnless(node_available(), "node is required for the parity check against plusaudio/lib")
class DeckTextParityWithPlusaudioLib(unittest.TestCase):
    """A divergence between this port and plusaudio/lib/deck.js would be a bug
    in a user's live collection, not just a failing test, so parity is checked
    against the real source rather than trusted to two hand-written copies
    agreeing by construction."""

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

    def test_spoken_text_matches_node_for_sample_fields(self):
        for field in self.SAMPLE_FIELDS:
            with self.subTest(field=field):
                node_out = run_node_probe({"spokenTextOf": field})
                self.assertEqual(deck_text.spoken_text(field), node_out["spokenText"])

    def test_decode_entities_matches_node(self):
        for field in self.SAMPLE_FIELDS:
            with self.subTest(field=field):
                node_out = run_node_probe({"decodeEntitiesOf": field})
                self.assertEqual(deck_text.decode_entities(field), node_out["decodeEntities"])

    def test_audio_references_matches_node_for_sample_fields(self):
        for field in self.SAMPLE_FIELDS:
            with self.subTest(field=field):
                node_out = run_node_probe({"audioReferencesOf": field})
                python_refs = [
                    {"name": r.name, "form": r.form, "index": r.index, "length": r.length}
                    for r in deck_text.audio_references(field)
                ]
                self.assertEqual(python_refs, node_out["audioReferences"])

    def test_render_audio_reference_matches_node(self):
        cases = [("a.mp3", "sound"), ('a"b&c.mp3', "html"), ("안녕.mp3", "html")]
        for filename, form in cases:
            with self.subTest(filename=filename, form=form):
                node_out = run_node_probe({"renderAudioReference": {"filename": filename, "form": form}})
                self.assertEqual(deck_text.render_audio_reference(filename, form), node_out["renderAudioReference"])

    def test_set_owned_audio_matches_node(self):
        cases = [
            {"fieldText": self.SAMPLE_FIELDS[3], "filename": "plusaudio-" + "c" * 20 + ".mp3", "form": "sound"},
            {"fieldText": self.SAMPLE_FIELDS[3], "filename": "plusaudio-" + "c" * 20 + ".mp3", "form": "html"},
            {"fieldText": "", "filename": "plusaudio-" + "c" * 20 + ".mp3", "form": "sound"},
            {"fieldText": "1-1-13-1_gpt4o.mp3 plain", "filename": "plusaudio-" + "d" * 20 + ".mp3", "form": "html"},
        ]
        for case in cases:
            with self.subTest(**case):
                node_out = run_node_probe({"setOwnedAudio": case})
                python_out = deck_text.set_owned_audio(
                    case["fieldText"], case["filename"], deck_text.is_owned_media_name, case["form"]
                )
                self.assertEqual(python_out, node_out["setOwnedAudio"])

    def test_media_name_matches_node(self):
        cases = [("안녕하세요", "ko"), ("hello", "en"), ("", "ja"), ("a\nb", "zh_cn")]
        for text, language in cases:
            with self.subTest(text=text, language=language):
                node_out = run_node_probe({"mediaNameOf": {"text": text, "language": language}})
                self.assertEqual(deck_text.media_name(text, language), node_out["mediaName"])

    def test_is_owned_media_name_matches_node(self):
        cases = [
            "plusaudio-" + "a" * 20 + ".mp3",
            "plusaudio-" + "a" * 19 + ".mp3",
            "1-1-13-1_gpt4o.mp3",
            "1-1-13-1.mp3",
        ]
        for name in cases:
            with self.subTest(name=name):
                node_out = run_node_probe({"isOwnedMediaNameOf": name})
                self.assertEqual(deck_text.is_owned_media_name(name), node_out["isOwnedMediaName"])


if __name__ == "__main__":
    unittest.main()
