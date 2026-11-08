"""Text to an MP3 clip with OpenAI's speech API, checked by transcribing it back.

Standard library only. Needs OPENAI_API_KEY. Model ids can be overridden with
OPENAI_TTS_MODEL / OPENAI_TRANSCRIBE_MODEL, and the endpoint with
OPENAI_BASE_URL.

Usable on its own:  python3 tts.py "안녕하세요" ko out.mp3
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

from media_refs import normalize_for_comparison

BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe")

# A retry in the same voice tends to repeat the same mispronunciation;
# rotating voices lets a retry actually try something different.
VOICES = ["alloy", "nova", "echo"]

INSTRUCTIONS = (
    "Speak as a native speaker of the language with this tag: {language}. "
    "Use natural, standard pronunciation, rhythm and intonation, at a clear learner-friendly pace. "
    "Read the text exactly as written. Do not add, translate or explain anything."
)


class TtsError(Exception):
    pass


def _key() -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise TtsError("OPENAI_API_KEY is not set")
    return key


def _post(path: str, body: bytes, content_type: str) -> bytes:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        headers={"Authorization": f"Bearer {_key()}", "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        raise TtsError(f"OpenAI {path} returned {error.code}: {detail}")


def speak(text: str, language: str, voice: str, instructions: str | None = None) -> bytes:
    body = {
        "model": TTS_MODEL,
        "voice": voice,
        "input": text,
        "instructions": instructions or INSTRUCTIONS.format(language=language),
        "response_format": "mp3",
    }
    return _post("/audio/speech", json.dumps(body).encode(), "application/json")


def transcribe(audio: bytes) -> str:
    # Derived from the audio itself, so the request is reproducible and no
    # random source is needed; a hash of the clip cannot occur inside it.
    boundary = "amgi" + hashlib.sha256(audio).hexdigest()[:32]
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{TRANSCRIBE_MODEL}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp3"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n".encode()
        + audio
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    reply = _post("/audio/transcriptions", b"".join(parts), f"multipart/form-data; boundary={boundary}")
    return json.loads(reply).get("text", "")


def synthesize(text: str, language: str, *, verify: bool = True, attempts: int = 3) -> bytes:
    """A clip that says `text`, or an exception. Never a clip known to be wrong.

    With `verify`, each attempt is transcribed and compared ignoring case,
    punctuation and spacing. Transcribers normalise numbers, switch scripts
    and sometimes translate, so a correct clip can fail this; the error
    carries what was heard so a person can decide, and `verify=False` skips it.
    """
    heard = []
    for attempt in range(attempts):
        audio = speak(text, language, VOICES[attempt % len(VOICES)])
        if not verify:
            return audio
        transcript = transcribe(audio)
        if normalize_for_comparison(transcript) == normalize_for_comparison(text):
            return audio
        heard.append(transcript)
    raise TtsError(f"no attempt was transcribed as {text!r}; heard {heard!r} (rerun with --no-verify to accept anyway)")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: tts.py TEXT LANGUAGE OUT.mp3")
    with open(sys.argv[3], "wb") as out:
        out.write(synthesize(sys.argv[1], sys.argv[2]))
