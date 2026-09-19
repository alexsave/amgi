# AudioFillConfig validation, which needs no Collection and so no `anki` pip
# package: it is checked before core.plan_fill ever touches one.

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import AudioFillConfig  # noqa: E402


class AudioFillConfigTests(unittest.TestCase):
    def test_rejects_an_unknown_audio_tag(self):
        with self.assertRaises(ValueError):
            AudioFillConfig(deck_id=1, text_field="Korean", audio_field="Audio", language="ko", audio_tag="mp3")

    def test_rejects_the_same_field_for_text_and_audio(self):
        with self.assertRaises(ValueError):
            AudioFillConfig(deck_id=1, text_field="Korean", audio_field="Korean", language="ko")

    def test_defaults_the_audio_tag_to_sound(self):
        config = AudioFillConfig(deck_id=1, text_field="Korean", audio_field="Audio", language="ko")
        self.assertEqual(config.audio_tag, "sound")


if __name__ == "__main__":
    unittest.main()
