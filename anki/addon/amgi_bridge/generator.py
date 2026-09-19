# Where this add-on gets a clip's audio bytes from.
#
# The generation policy - prompts, TTS voice instructions, the
# transcribe-then-judge validation loop - lives in exactly one place,
# plusaudio/lib/cardGeneration/cardGeneration.ts, and is not allowed a second
# copy. This add-on is Python and cannot require() that TypeScript module the
# way plusaudio/lib/generator.js does, so it shells out instead, to
# plusaudio/generate-clip.js - a small Node entry point built for exactly
# this: text and a language in, one clip written to a file, over a documented
# argument/exit-code contract (see that file's own top-of-file comment, which
# is the actual contract; this file is one side of it).
#
# That is the seam this file exists to be. AudioGenerator below is the only
# thing core.apply_fill depends on - a callable from text to bytes - so
# nothing in core.py or __init__.py needs to know or care that the other end
# of fetch_audio is a subprocess.
#
# This add-on runs entirely on the machine it is installed on: no amgi
# account, no hosted quota, no network dependency but OpenAI's own API. What
# it needs from that machine - Node, a checkout of this repo (for
# plusaudio/generate-clip.js and the shared policy it requires), and an
# OpenAI API key - is what NodeCliAudioGenerator.ensure_ready checks up
# front, in __init__.py, before a run touches a single note, so a missing
# piece is one clear message instead of one identical failure per note.
#
# test/test_generator.py mocks subprocess.run, the transport boundary here,
# the same way the previous edge-function version of this file mocked
# urllib.request.urlopen: everything on this side of that boundary (argument
# construction, exit-code handling, error messages, file cleanup) is what a
# mock can prove, and generate-clip.js's own test/generate-clip.test.js
# proves the other side of the same contract from Node.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from typing import Optional, Protocol


class AudioGenerator(Protocol):
    def fetch_audio(self, text: str, language: str) -> bytes:
        ...


class GenerationError(Exception):
    """Raised when a clip could not be produced, with a message meant to be
    shown to the user as-is: a missing Node install, a missing repo
    checkout, a missing API key, or generate-clip.js's own failure."""


def _find_node(node_path: str) -> str:
    """Resolves `node_path` to an executable, or raises a GenerationError
    explaining exactly what to fix.

    A bare command name (the default, "node") is resolved against PATH with
    shutil.which rather than handed straight to subprocess: Anki is commonly
    launched as a GUI app rather than from a shell, and a GUI app on macOS in
    particular does not inherit a shell's PATH (an rc file's `nvm`/`brew`
    additions in particular), so "node happens to work in Terminal" and
    "node happens to work inside Anki" are different claims. Failing that
    check now, with a clear message, beats letting subprocess.run raise a
    bare FileNotFoundError deep inside a run.
    """
    if os.sep in node_path or (os.altsep and os.altsep in node_path):
        if os.path.isfile(node_path) and os.access(node_path, os.X_OK):
            return node_path
        raise GenerationError(
            f"amgi audio fill's configured node_path ({node_path!r}) is not an executable file. "
            "Fix node_path in Tools > Add-ons > amgi_bridge > Config, or clear it to search PATH."
        )
    found = shutil.which(node_path)
    if found is None:
        raise GenerationError(
            "amgi audio fill needs Node.js to generate audio and could not find "
            f"{node_path!r} on PATH. Install Node (https://nodejs.org) or set node_path in "
            "Tools > Add-ons > amgi_bridge > Config to its full path (run `which node` in a "
            "terminal where `node` already works to find it)."
        )
    return found


def _find_script(plusaudio_dir: str) -> str:
    if not plusaudio_dir:
        raise GenerationError(
            "amgi audio fill needs plusaudio_dir set to your amgi checkout's plusaudio folder "
            "first: open Tools > Add-ons, select amgi_bridge, click Config, and fill it in."
        )
    script_path = os.path.join(plusaudio_dir, "generate-clip.js")
    if not os.path.isfile(script_path):
        raise GenerationError(
            f"amgi audio fill's configured plusaudio_dir ({plusaudio_dir!r}) has no "
            "generate-clip.js in it. Point plusaudio_dir at the plusaudio/ folder of a checkout "
            "of https://github.com/alexsave/amgi (Tools > Add-ons > amgi_bridge > Config)."
        )
    return script_path


def _env_file_has_key(plusaudio_dir: str) -> bool:
    """Same fallback generate-clip.js itself checks (a plusaudio/.env file),
    read here only to decide whether ensure_ready can call the key
    "resolvable" without actually spawning Node. Deliberately tolerant of a
    malformed .env: this is a courtesy pre-check, not a parser generate-clip.js
    depends on - a bad line here is generate-clip.js's own error to raise."""
    env_path = os.path.join(plusaudio_dir, ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("OPENAI_API_KEY=") and line[len("OPENAI_API_KEY="):].strip():
                    return True
    except OSError:
        return False
    return False


class NodeCliAudioGenerator:
    """Generates a clip by shelling out to `node generate-clip.js`.

    Config precedence for the OpenAI key, most specific first: `openai_api_key`
    in this add-on's own config (if set, passed to the subprocess as
    OPENAI_API_KEY, overriding whatever it would otherwise inherit);
    otherwise OPENAI_API_KEY already in this process's environment, inherited
    by the subprocess as normal; otherwise generate-clip.js's own fallback,
    plusaudio/.env next to it. The same three places, in the same order, are
    what ensure_ready checks before a run starts.
    """

    def __init__(
        self,
        node_path: str,
        plusaudio_dir: str,
        *,
        openai_api_key: Optional[str] = None,
        timeout: float = 120.0,
    ) -> None:
        self._node_path = node_path
        self._plusaudio_dir = plusaudio_dir
        self._openai_api_key = openai_api_key or None
        self._timeout = timeout

    def ensure_ready(self) -> None:
        """Checks Node, the script, and the API key up front, so a bad
        config fails once, before any note is attempted, rather than as a
        wall of identical per-note failures once a run is already under way.
        Raises GenerationError with a message meant to be shown as-is."""
        _find_node(self._node_path)
        _find_script(self._plusaudio_dir)
        if self._openai_api_key or os.environ.get("OPENAI_API_KEY") or _env_file_has_key(self._plusaudio_dir):
            return
        raise GenerationError(
            "amgi audio fill needs an OpenAI API key and found none. Set openai_api_key in "
            "Tools > Add-ons > amgi_bridge > Config, or set OPENAI_API_KEY in the environment "
            f"Anki runs in, or put OPENAI_API_KEY=... in {os.path.join(self._plusaudio_dir, '.env')}."
        )

    def fetch_audio(self, text: str, language: str) -> bytes:
        node_path = _find_node(self._node_path)
        script_path = _find_script(self._plusaudio_dir)

        env = os.environ.copy()
        if self._openai_api_key:
            env["OPENAI_API_KEY"] = self._openai_api_key

        handle, out_path = tempfile.mkstemp(prefix="amgi-audio-", suffix=".clip")
        os.close(handle)
        try:
            os.remove(out_path)  # generate-clip.js must be the one to create it, not us.
            result = self._run_node(node_path, script_path, text, language, out_path, env)
            if result.returncode != 0:
                message = result.stderr.strip() or f"generate-clip.js exited {result.returncode} with no message"
                raise GenerationError(message)
            self._forward_warnings(result.stderr)
            if not os.path.isfile(out_path):
                raise GenerationError("generate-clip.js exited 0 but wrote no clip; this is a bug in generate-clip.js")
            with open(out_path, "rb") as handle:
                return handle.read()
        finally:
            try:
                os.remove(out_path)
            except OSError:
                pass

    def _run_node(
        self, node_path: str, script_path: str, text: str, language: str, out_path: str, env: dict
    ) -> subprocess.CompletedProcess:
        args = [node_path, script_path, "--text", text, "--language", language, "--out", out_path]
        try:
            return subprocess.run(
                args, capture_output=True, text=True, timeout=self._timeout, env=env, cwd=self._plusaudio_dir
            )
        except FileNotFoundError as error:
            # Defensive: ensure_ready and _find_node already check node_path is an
            # executable file, but Node could still vanish between that check and
            # this call (an upgrade, a removed nvm version). Same actionable
            # message either way, rather than a bare traceback mid-run.
            raise GenerationError(f"could not run {node_path!r}: {error}") from error
        except subprocess.TimeoutExpired as error:
            raise GenerationError(
                f"generate-clip.js did not finish within {self._timeout:.0f}s for {text!r}"
            ) from error

    @staticmethod
    def _forward_warnings(stderr: str) -> None:
        # cardGeneration.ts's own non-fatal warnings (a missing reading for a
        # language whose script hides one, a validator falling back after
        # the audio judge is unreachable) arrive on stderr even on a
        # successful run. The previous, edge-function version of this file
        # had no way to surface these at all - they stayed in the edge
        # function's own server logs. Printing them here is strictly more
        # visible than that, not a new requirement: this add-on still does
        # not fail or warn the user in the UI over them.
        text = stderr.strip()
        if text:
            print(text, file=sys.stderr)
