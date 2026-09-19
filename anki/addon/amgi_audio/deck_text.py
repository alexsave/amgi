# Field-text rules ported from plusaudio/lib/deck.js and plusaudio/lib/audio-store.js.
#
# Only the parts those two files need for THIS job are ported here: parsing and
# rendering an audio reference, recognising this tool's own filenames, and
# deriving a clip's content-hashed name. Everything else those modules do -
# notes.flds/csum/sfld bookkeeping, note-type introspection from a raw SQLite
# file, package (.apkg) reading and writing - is machinery plusaudio/lib needs
# because it edits a package by hand. This add-on has a live
# anki.collection.Collection instead, and Anki's own Note/Collection.update_note
# already does that bookkeeping, so none of it is reimplemented here.
#
# This is a port, not a shared module, because the add-on is Python and
# plusaudio/lib is Node. test/test_deck_text.py checks the two stay identical
# by shelling out to Node and comparing outputs on the same inputs - a
# divergence here would be a bug in a user's live collection, not just a test
# failure, so it is worth the extra suite.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Callable

AUDIO_TAG_FORMS = ("sound", "html")

# Mirrors plusaudio/lib/deck.js SOUND_TAG.
_SOUND_TAG = re.compile(r"\[sound:([^\]]*)\]")

# Mirrors plusaudio/lib/deck.js HTML_AUDIO_TAG: an <audio> element with a src,
# closing tag optional, which is what Anki's own media tracker treats as a
# reference (rslib/src/text.rs, HTML_MEDIA_TAGS).
_HTML_AUDIO_TAG = re.compile(
    r"""<\s*audio\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))[^>]*>(?:\s*</\s*audio\s*>)?""",
    re.IGNORECASE,
)

_NAMED_ENTITIES = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "nbsp": " ",
}
_ENTITY = re.compile(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);")


def decode_entities(text: str) -> str:
    """Mirrors deck.js decodeEntities, including its collapse of every
    non-breaking space to an ordinary one."""

    def replace(match: "re.Match[str]") -> str:
        body = match.group(1)
        if body[0] == "#":
            try:
                code = int(body[2:], 16) if body[1] in "xX" else int(body[1:], 10)
            except ValueError:
                return match.group(0)
            return chr(code) if code > 0 else match.group(0)
        named = _NAMED_ENTITIES.get(body.lower())
        return match.group(0) if named is None else named

    return _ENTITY.sub(replace, text).replace(" ", " ")


_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_BLOCK_BREAK = re.compile(r"<(br|div|p|li|tr|td)\b[^>]*>", re.IGNORECASE)
_ANY_TAG = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")


def spoken_text(html: str) -> str:
    """The text a field is meant to be read aloud as: mirrors deck.js spokenText."""
    text = _SOUND_TAG.sub(" ", html)
    text = _COMMENT.sub("", text)
    text = _BLOCK_BREAK.sub(" ", text)
    text = _ANY_TAG.sub("", text)
    return _WHITESPACE.sub(" ", decode_entities(text)).strip()


@dataclass(frozen=True)
class AudioReference:
    name: str
    form: str  # 'sound' or 'html'
    index: int
    length: int


def audio_references(field_text: str) -> list[AudioReference]:
    """Every clip a field points at, in either form, in the order they appear.
    Mirrors deck.js audioReferences."""
    found: list[AudioReference] = []
    for match in _SOUND_TAG.finditer(field_text):
        found.append(AudioReference(match.group(1), "sound", match.start(), len(match.group(0))))
    for match in _HTML_AUDIO_TAG.finditer(field_text):
        name = match.group(1)
        if name is None:
            name = match.group(2)
        if name is None:
            name = match.group(3) or ""
        # Anki decodes entities in a media src before it looks the file up, so
        # a name read back here has to be decoded too or it would never match.
        found.append(AudioReference(decode_entities(name), "html", match.start(), len(match.group(0))))
    found.sort(key=lambda reference: reference.index)
    return found


def render_audio_reference(filename: str, form: str) -> str:
    """Mirrors deck.js renderAudioReference."""
    if form == "html":
        src = filename.replace("&", "&amp;").replace('"', "&quot;")
        return f'<audio src="{src}"></audio>'
    return f"[sound:{filename}]"


def set_owned_audio(
    field_text: str,
    filename: str | None,
    is_owned: Callable[[str], bool],
    form: str = "sound",
) -> str:
    """Replace the clip references this tool owns with a single new one in the
    requested form, leaving any other content of the field - images, the deck
    author's own recordings, plain text - exactly where it was.

    Mirrors deck.js setOwnedAudio.
    """
    owned = [reference for reference in audio_references(field_text) if is_owned(reference.name)]
    tag = "" if filename is None else render_audio_reference(filename, form)

    if not owned:
        if tag == "":
            return field_text
        return tag if len(field_text) == 0 else f"{field_text}{tag}"

    out: list[str] = []
    cursor = 0
    for i, reference in enumerate(owned):
        out.append(field_text[cursor : reference.index])
        if i == 0:
            out.append(tag)
        cursor = reference.index + reference.length
    out.append(field_text[cursor:])
    return "".join(out)


# Mirrors plusaudio/lib/audio-store.js.

# Bump when the voice, prompt or validation policy changes enough that every
# existing clip should be regenerated. Must stay identical to AUDIO_PROFILE in
# plusaudio/lib/audio-store.js: the two are meant to name the same clip the
# same way, whichever tool a note was last touched by.
AUDIO_PROFILE = "v1"

_OWNED_NAME = re.compile(r"^plusaudio-[0-9a-f]{20}\.mp3\Z")
# Clips written by the 2025 scripts plusaudio replaced. Recognising them here
# too means a note already carrying one is treated as already having audio,
# consistent with plusaudio/lib/audio-store.js isOwnedMediaName.
_LEGACY_OWNED_NAME = re.compile(r"_gpt4o\.mp3\Z")


def media_name(text: str, language: str) -> str:
    """The filename a clip of `text` in `language` must have. Mirrors
    audio-store.js mediaName exactly, hash algorithm and all: two tools naming
    the same clip differently would defeat the whole point of content-hashed
    names, which is that a deck augmented by either one is consistent."""
    digest = hashlib.sha1(f"{AUDIO_PROFILE}\n{language}\n{text}".encode("utf-8")).hexdigest()
    return f"plusaudio-{digest[:20]}.mp3"


def is_owned_media_name(filename: str) -> bool:
    return bool(_OWNED_NAME.match(filename) or _LEGACY_OWNED_NAME.search(filename))
