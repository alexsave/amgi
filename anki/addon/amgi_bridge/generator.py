# Where this add-on gets a clip's audio bytes from.
#
# The generation policy - prompts, Gemini speech, the
# transcribe-then-judge validation loop - lives in exactly one place, the
# amgi server's C code (server/amgi/cards.c, card_generate_audio), and is not
# allowed a second copy. This add-on is Python, so it runs that code the one
# way a program that is not C can: as the small C program built for exactly
# this, server/build/amgi-clip (server/cli/clip.c). Text and a language in,
# one clip written to a file, over a documented argument/exit-code contract
# (clip.c's own top-of-file comment is the actual contract; this file is the
# other side of it).
#
# That is the seam this file exists to be. AudioGenerator below is the only
# thing core.apply_fill depends on - a callable from text to bytes - so
# nothing in core.py or __init__.py needs to know or care that the other end
# of fetch_audio is a subprocess.
#
# This add-on runs entirely on the machine it is installed on: no amgi
# account, no hosted quota, no network dependency but Google's Gemini API
# (which speaks the clip and checks it). What it needs from that machine -
# a checkout of this repo with amgi-clip built in it (`make -C server`), and
# a Gemini API key - is what AmgiClipAudioGenerator.ensure_ready checks up
# front, in __init__.py, before a run touches a single note, so a missing
# piece is one clear message instead of one identical failure per note.
#
# test/test_generator.py mocks subprocess.run, the transport boundary here:
# everything on this side of that boundary (argument construction, exit-code
# handling, error messages, file cleanup) is what a mock can prove. One test
# there also runs the real amgi-clip against the tests' fake Gemini, and
# test/parity/clip.test.mjs proves the C side of the same contract.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import math
import os
import re
import subprocess
import tempfile
from typing import Optional, Protocol

# Where amgi-clip is built, and the key file it reads, both relative to the checkout (amgi_dir).
CLIP_PATH = os.path.join("server", "build", "amgi-clip")
ENV_FILE = ".env.local"

# amgi-clip's exit codes (server/cli/clip.c's header).
EXIT_RATE_LIMITED = 3
EXIT_DAILY_CAP = 4

_RETRY_AFTER = re.compile(r"^retry-after-ms=(\d+)$", re.MULTILINE)


class AudioGenerator(Protocol):
    def fetch_audio(self, text: str, language: str) -> bytes:
        ...


class GenerationError(Exception):
    """Raised when a clip could not be produced, with a message meant to be
    shown to the user as-is: a missing checkout or amgi-clip build, a missing
    API key, or amgi-clip's own failure."""


def _find_clip(amgi_dir: str) -> str:
    """The path of amgi-clip in the checkout at `amgi_dir`, or a
    GenerationError saying exactly what to fix."""
    if not amgi_dir:
        raise GenerationError(
            "amgi audio fill needs amgi_dir set to the folder of your amgi checkout first: "
            "open Tools > Add-ons, select amgi_bridge, click Config, and fill it in."
        )
    clip_path = os.path.join(amgi_dir, CLIP_PATH)
    if not (os.path.isfile(clip_path) and os.access(clip_path, os.X_OK)):
        raise GenerationError(
            f"amgi audio fill's configured amgi_dir ({amgi_dir!r}) has no built {CLIP_PATH} in it. "
            "Run `make -C server` in that checkout of https://github.com/alexsave/amgi, or point "
            "amgi_dir at one where it is built (Tools > Add-ons > amgi_bridge > Config)."
        )
    return clip_path


def _env_file_has_key(amgi_dir: str) -> bool:
    """Whether the checkout's .env.local, amgi-clip's own fallback, holds a
    GEMINI_API_KEY, read here only to decide whether ensure_ready can call the
    key "resolvable" without spawning anything. Deliberately tolerant of a
    malformed file: this is a courtesy pre-check, not a parser amgi-clip
    depends on - a bad line here is amgi-clip's own error to raise."""
    try:
        with open(os.path.join(amgi_dir, ENV_FILE), "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("GEMINI_API_KEY=") and line[len("GEMINI_API_KEY="):].strip():
                    return True
    except OSError:
        return False
    return False


def _last_line(text: str) -> str:
    """The last non-empty line of `text`: amgi-clip's message to show a
    person (a log line with a timestamp can come before it)."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def _failure_message(result: subprocess.CompletedProcess) -> str:
    """The sentence a failed amgi-clip run is shown to the user as."""
    if result.returncode == EXIT_RATE_LIMITED:
        match = _RETRY_AFTER.search(result.stdout or "")
        if match:
            seconds = max(1, math.ceil(int(match.group(1)) / 1000))
            return (
                f"Gemini asked amgi to wait {seconds} s before the next request (it is limiting how "
                "many requests your key makes). Run Fill missing audio again after that; notes "
                "already filled are kept."
            )
        return (
            "Gemini is limiting how many requests your key makes. Wait a minute and run Fill "
            "missing audio again; notes already filled are kept."
        )
    if result.returncode == EXIT_DAILY_CAP:
        return (
            "Your Gemini key's daily cap is spent, so no more audio can be made today. Run Fill "
            "missing audio again tomorrow, or enable billing on the key's Google project for a "
            "higher cap; notes already filled are kept."
        )
    return _last_line(result.stderr or "") or f"amgi-clip exited {result.returncode} with no message"


class AmgiClipAudioGenerator:
    """Generates a clip by running the checkout's server/build/amgi-clip.

    One key is needed, GEMINI_API_KEY: it speaks each clip and checks that
    the clip says what the note says. Config precedence, most specific
    first: `gemini_api_key` in this add-on's own config (if set, passed to
    the subprocess as GEMINI_API_KEY, overriding whatever it would otherwise
    inherit); otherwise GEMINI_API_KEY already in this process's environment,
    inherited by the subprocess as normal; otherwise amgi-clip's own
    fallback, .env.local at the root of the checkout (amgi-clip runs there).
    The same three places, in the same order, are what ensure_ready checks
    before a run starts.
    """

    def __init__(
        self,
        amgi_dir: str,
        *,
        gemini_api_key: Optional[str] = None,
        timeout: float = 120.0,
    ) -> None:
        self._amgi_dir = amgi_dir
        self._gemini_api_key = gemini_api_key or None
        self._timeout = timeout

    def ensure_ready(self) -> None:
        """Checks the checkout, its amgi-clip build, and the API key up
        front, so a bad config fails once, before any note is attempted,
        rather than as a wall of identical per-note failures once a run is
        already under way. Raises GenerationError with a message meant to be
        shown as-is."""
        _find_clip(self._amgi_dir)
        if self._gemini_api_key or os.environ.get("GEMINI_API_KEY") or _env_file_has_key(self._amgi_dir):
            return
        raise GenerationError(
            "amgi audio fill needs a Gemini API key (https://aistudio.google.com/apikey) and found none. "
            "Set gemini_api_key in Tools > Add-ons > amgi_bridge > Config, or set GEMINI_API_KEY in the "
            f"environment Anki runs in, or put GEMINI_API_KEY=... in {os.path.join(self._amgi_dir, ENV_FILE)}."
        )

    def fetch_audio(self, text: str, language: str) -> bytes:
        clip_path = _find_clip(self._amgi_dir)

        env = os.environ.copy()
        if self._gemini_api_key:
            env["GEMINI_API_KEY"] = self._gemini_api_key

        handle, out_path = tempfile.mkstemp(prefix="amgi-audio-", suffix=".wav")
        os.close(handle)
        try:
            os.remove(out_path)  # amgi-clip must be the one to create it, not us.
            result = self._run_clip(clip_path, text, language, out_path, env)
            if result.returncode != 0:
                raise GenerationError(_failure_message(result))
            if not os.path.isfile(out_path):
                raise GenerationError("amgi-clip exited 0 but wrote no clip; this is a bug in amgi-clip")
            with open(out_path, "rb") as handle:
                return handle.read()
        finally:
            try:
                os.remove(out_path)
            except OSError:
                pass

    def _run_clip(
        self, clip_path: str, text: str, language: str, out_path: str, env: dict
    ) -> subprocess.CompletedProcess:
        args = [clip_path, "--text", text, "--language", language, "--out", out_path]
        try:
            return subprocess.run(
                args, capture_output=True, text=True, timeout=self._timeout, env=env, cwd=self._amgi_dir
            )
        except FileNotFoundError as error:
            # Defensive: ensure_ready and _find_clip already check amgi-clip is an
            # executable file, but it can still vanish between that check and this
            # call (a `make clean` in the checkout). Same actionable message either
            # way, rather than a bare traceback mid-run.
            raise GenerationError(
                f"could not run {clip_path!r}: {error}. Run `make -C server` in your amgi checkout."
            ) from error
        except subprocess.TimeoutExpired as error:
            raise GenerationError(
                f"amgi-clip did not finish within {self._timeout:.0f}s for {text!r}"
            ) from error
