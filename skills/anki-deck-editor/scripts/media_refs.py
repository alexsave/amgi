"""How a note field points at a media file, and how a generated clip is named.

Kept free of any `anki` import so it can be used (and tested) on its own.
"""

from __future__ import annotations

import hashlib
import html
import re
import unicodedata

# Bump when the voice or validation policy changes enough that every clip
# this skill generated should be regenerated: it is part of every clip's name.
AUDIO_PROFILE = "v1"

SOUND_TAG = re.compile(r"\[sound:([^\]]+)\]")
AUDIO_ELEMENT = re.compile(r"<audio\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"'][^>]*>\s*(?:</audio>)?", re.IGNORECASE)
HTML_TAG = re.compile(r"<[^>]+>")
FURIGANA = re.compile(r"\[[^\]]*\]")


def render(filename: str, form: str) -> str:
    """The text to put in a field so Anki treats `filename` as used media.

    sound  [sound:x.mp3]               Anki's own player, the R replay key, every client.
    html   <audio src="x.mp3"></audio> survives into the card's DOM so a template's
                                       JavaScript can play and sequence it. Anki strips
                                       [sound:] tags before the template ever sees them.
    img    <img src="x.png">
    A bare filename is never right: Check Media calls it unused and offers to
    delete it, and an export leaves it behind.
    """
    escaped = html.escape(filename, quote=True)
    if form == "sound":
        return f"[sound:{filename}]"
    if form == "html":
        return f'<audio src="{escaped}"></audio>'
    if form == "img":
        return f'<img src="{escaped}">'
    raise ValueError(f"unknown reference form {form!r}")


def speakable_text(field_value: str) -> str:
    """What a TTS voice should read for a field: no media refs, markup or furigana readings."""
    text = SOUND_TAG.sub(" ", field_value)
    text = AUDIO_ELEMENT.sub(" ", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = HTML_TAG.sub("", text)
    text = html.unescape(text).replace(" ", " ")
    # Anki's furigana syntax, 漢字[かんじ]: read the word, not word plus reading.
    text = FURIGANA.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def clip_name(text: str, language: str, prefix: str = "tts-") -> str:
    """A content hash of what was spoken.

    The same text always maps to the same file, so a rerun finds the note
    already pointing at the clip it would make and does nothing; changed text
    gets a new name, so a stale clip is replaced rather than kept.
    """
    digest = hashlib.sha1(f"{AUDIO_PROFILE}\n{language}\n{text}".encode("utf-8")).hexdigest()
    return f"{prefix}{digest[:20]}.mp3"


def replace_owned(field_value: str, filename: str, form: str, prefix: str = "tts-") -> str:
    """Put this tool's clip in the field, dropping only references this tool wrote.

    The deck author's own recordings, images and other references stay where
    they are; the old generated clip, in either form, goes.
    """
    owned = re.compile(rf"^{re.escape(prefix)}[0-9a-f]{{20}}\.mp3$")

    def drop_if_owned(match):
        return "" if owned.match(html.unescape(match.group(1))) else match.group(0)

    kept = SOUND_TAG.sub(drop_if_owned, field_value)
    kept = AUDIO_ELEMENT.sub(drop_if_owned, kept).strip()
    reference = render(filename, form)
    return f"{kept} {reference}" if kept else reference


def normalize_for_comparison(text: str) -> str:
    """Case, punctuation, symbols and spacing removed: what a transcript is compared on."""
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = "".join(ch for ch in text if not unicodedata.category(ch).startswith(("P", "S")))
    return re.sub(r"\s+", "", text)
