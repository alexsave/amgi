# The romanisation guard the bridge applies to hand-authored text: a soft
# warning, never a hard rule, and never applied to LLM-generated text, which the
# generation prompt already forbids romanising. The same rule is in C as
# looks_romanized (server/collection/text.c). Ranges match \p{Script=...} for the
# same scripts; Python's stdlib `re` has no Unicode script property support, so
# this is done by hand with explicit codepoint blocks instead.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import re

_NATIVE_SCRIPT_RANGES: dict[str, tuple[tuple[int, int], ...]] = {
    "ko": ((0xAC00, 0xD7A3), (0x1100, 0x11FF), (0x3130, 0x318F)),  # Hangul syllables + Jamo
    "ja": ((0x3040, 0x309F), (0x30A0, 0x30FF), (0x4E00, 0x9FFF), (0x3400, 0x4DBF)),  # kana + kanji (Han)
    "zh_cn": ((0x4E00, 0x9FFF), (0x3400, 0x4DBF)),  # Han
    "zh_hk": ((0x4E00, 0x9FFF), (0x3400, 0x4DBF)),  # Han
    "ru": ((0x0400, 0x04FF),),  # Cyrillic
    "ar": ((0x0600, 0x06FF), (0x0750, 0x077F)),  # Arabic
    "ur": ((0x0600, 0x06FF), (0x0750, 0x077F)),  # Arabic (Urdu's script)
    "hi": ((0x0900, 0x097F),),  # Devanagari
    "th": ((0x0E00, 0x0E7F),),  # Thai
}

_LATIN_LETTER = re.compile(r"[A-Za-z]")


def _normalize_language_code(language: str) -> str:
    return (language or "").lower().replace("-", "_").strip()


def looks_romanized(text: str, language: str) -> bool:
    """True when `text` is written entirely in the Latin alphabet even though
    `language`'s own script is something else. Mixed text (a gloss, a proper
    noun) is not flagged: this only fires when the native script is entirely
    absent. """
    ranges = _NATIVE_SCRIPT_RANGES.get(_normalize_language_code(language))
    if not ranges:
        return False
    trimmed = (text or "").strip()
    if not trimmed:
        return False
    if any(lo <= ord(ch) <= hi for ch in trimmed for lo, hi in ranges):
        return False
    return bool(_LATIN_LETTER.search(trimmed))
