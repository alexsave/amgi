# Tests for the subprocess seam, mostly mocked at the transport boundary
# (subprocess.run): there is no API key available to this add-on's automated
# tests, and live calls are not authorised regardless. Those tests check
# everything on this side of that boundary - the lookup of amgi-clip,
# argument construction, the environment and working directory, exit-code
# handling, error messages, and temp-file cleanup.
#
# One test (EndToEndTests) runs the real server/build/amgi-clip through
# AmgiClipAudioGenerator against the tests' fake Gemini
# (plusaudio/test/helpers/fake-gemini.js, a real gRPC server on 127.0.0.1),
# when the binary is built. test/parity/clip.test.mjs proves the C side of
# the same contract case by case.

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generator  # noqa: E402
from sandbox_home import sandbox_env  # noqa: E402

# test/test_generator.py -> test -> amgi_bridge -> addon -> anki -> repo root.
REPO_ROOT = Path(__file__).resolve().parents[4]
REAL_CLIP = REPO_ROOT / "server" / "build" / "amgi-clip"
FAKE_GEMINI = REPO_ROOT / "plusaudio" / "test" / "helpers" / "fake-gemini.js"


def completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["amgi-clip"], returncode=returncode, stdout=stdout, stderr=stderr)


def make_checkout(test: unittest.TestCase, *, executable: bool = True, env_local: str | None = None) -> str:
    """A scratch amgi_dir with a stand-in server/build/amgi-clip (never run: subprocess.run is mocked)."""
    directory = tempfile.mkdtemp(prefix="amgi-checkout-")
    test.addCleanup(shutil.rmtree, directory, True)
    build = os.path.join(directory, "server", "build")
    os.makedirs(build)
    clip = os.path.join(build, "amgi-clip")
    with open(clip, "w", encoding="utf-8") as handle:
        handle.write("#!/bin/sh\nexit 1\n")
    os.chmod(clip, 0o755 if executable else 0o644)
    if env_local is not None:
        with open(os.path.join(directory, ".env.local"), "w", encoding="utf-8") as handle:
            handle.write(env_local)
    return directory


def writes_clip(data: bytes, returncode: int = 0, stdout: str = "", stderr: str = ""):
    """A subprocess.run stand-in that writes `data` to --out, as amgi-clip does on exit 0."""

    def fake_run(args, **kwargs):
        out_path = args[args.index("--out") + 1]
        with open(out_path, "wb") as handle:
            handle.write(data)
        return completed(returncode, stdout, stderr)

    return fake_run


class FindClipTests(unittest.TestCase):
    def test_an_empty_amgi_dir_is_a_clear_generation_error(self):
        with self.assertRaises(generator.GenerationError) as ctx:
            generator._find_clip("")
        self.assertIn("amgi_dir", str(ctx.exception))

    def test_a_checkout_without_the_build_says_to_run_make(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(generator.GenerationError) as ctx:
                generator._find_clip(directory)
        self.assertIn("make -C server", str(ctx.exception))
        self.assertIn(os.path.join("server", "build", "amgi-clip"), str(ctx.exception))

    def test_a_clip_that_is_not_executable_is_not_found(self):
        checkout = make_checkout(self, executable=False)
        with self.assertRaises(generator.GenerationError) as ctx:
            generator._find_clip(checkout)
        self.assertIn("make -C server", str(ctx.exception))

    def test_a_built_checkout_resolves_to_its_amgi_clip(self):
        checkout = make_checkout(self)
        self.assertEqual(generator._find_clip(checkout), os.path.join(checkout, "server", "build", "amgi-clip"))


class EnsureReadyTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(os.environ, {}, clear=False)
        patch.start()
        self.addCleanup(patch.stop)
        os.environ.pop("GEMINI_API_KEY", None)

    def test_raises_when_amgi_dir_is_not_set(self):
        with self.assertRaises(generator.GenerationError) as ctx:
            generator.AmgiClipAudioGenerator("", gemini_api_key="g-test").ensure_ready()
        self.assertIn("amgi_dir", str(ctx.exception))

    def test_raises_when_amgi_clip_is_not_built(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(generator.GenerationError) as ctx:
                generator.AmgiClipAudioGenerator(directory, gemini_api_key="g-test").ensure_ready()
        self.assertIn("make -C server", str(ctx.exception))

    def test_raises_when_no_key_is_configured_environed_or_in_env_local(self):
        checkout = make_checkout(self)
        with self.assertRaises(generator.GenerationError) as ctx:
            generator.AmgiClipAudioGenerator(checkout).ensure_ready()
        self.assertIn("Gemini API key", str(ctx.exception))
        self.assertIn("gemini_api_key", str(ctx.exception))
        self.assertIn(os.path.join(checkout, ".env.local"), str(ctx.exception))

    def test_an_openai_key_alone_is_not_enough(self):
        checkout = make_checkout(self, env_local="OPENAI_API_KEY=sk-old\n")
        os.environ["OPENAI_API_KEY"] = "sk-old"
        with self.assertRaises(generator.GenerationError):
            generator.AmgiClipAudioGenerator(checkout).ensure_ready()

    def test_passes_when_the_key_comes_from_config(self):
        generator.AmgiClipAudioGenerator(make_checkout(self), gemini_api_key="g-test").ensure_ready()

    def test_passes_when_the_key_comes_from_the_environment(self):
        os.environ["GEMINI_API_KEY"] = "g-test"
        generator.AmgiClipAudioGenerator(make_checkout(self)).ensure_ready()

    def test_passes_when_the_key_comes_from_the_checkouts_env_local(self):
        checkout = make_checkout(self, env_local="# amgi\nGEMINI_API_KEY=g-test\n")
        generator.AmgiClipAudioGenerator(checkout).ensure_ready()

    def test_env_local_counts_only_with_a_gemini_key_in_it(self):
        checkout = make_checkout(self, env_local="OPENAI_API_KEY=sk-old\nGEMINI_API_KEY=\n")
        self.assertFalse(generator._env_file_has_key(checkout))
        # The old Node generator's plusaudio/.env is not read any more.
        os.makedirs(os.path.join(checkout, "plusaudio"))
        with open(os.path.join(checkout, "plusaudio", ".env"), "w", encoding="utf-8") as handle:
            handle.write("GEMINI_API_KEY=g-old\n")
        self.assertFalse(generator._env_file_has_key(checkout))
        with open(os.path.join(checkout, ".env.local"), "w", encoding="utf-8") as handle:
            handle.write("GEMINI_API_KEY=g-test\n")
        self.assertTrue(generator._env_file_has_key(checkout))


class FetchAudioTests(unittest.TestCase):
    def setUp(self):
        self.checkout = make_checkout(self)
        self.gen = generator.AmgiClipAudioGenerator(self.checkout, gemini_api_key="g-test")

    def failure(self, result: subprocess.CompletedProcess) -> str:
        with mock.patch("generator.subprocess.run", return_value=result):
            with self.assertRaises(generator.GenerationError) as ctx:
                self.gen.fetch_audio("text", "ko")
        return str(ctx.exception)

    def test_success_returns_the_clip_amgi_clip_wrote_and_cleans_up(self):
        with mock.patch("generator.subprocess.run", side_effect=writes_clip(b"RIFF\x00clip")) as run:
            audio = self.gen.fetch_audio("こんにちは", "ja")

        self.assertEqual(audio, b"RIFF\x00clip")
        args, kwargs = run.call_args
        command = args[0]
        out_path = command[-1]
        self.assertEqual(command, [
            os.path.join(self.checkout, "server", "build", "amgi-clip"),
            "--text", "こんにちは", "--language", "ja", "--out", out_path,
        ])
        self.assertEqual(kwargs["cwd"], self.checkout, "amgi-clip runs in the checkout, where .env.local is")
        self.assertEqual(kwargs["env"]["GEMINI_API_KEY"], "g-test")
        self.assertIn("timeout", kwargs)
        self.assertTrue(out_path.endswith(".wav"))
        self.assertFalse(os.path.exists(out_path), "the clip's temp file is removed afterwards")

    def test_the_out_path_does_not_exist_before_amgi_clip_runs(self):
        seen = []

        def fake_run(args, **kwargs):
            seen.append(os.path.exists(args[args.index("--out") + 1]))
            return writes_clip(b"x")(args, **kwargs)

        with mock.patch("generator.subprocess.run", side_effect=fake_run):
            self.gen.fetch_audio("text", "ko")
        self.assertEqual(seen, [False], "amgi-clip must be the one to create --out")

    def test_config_key_overrides_whatever_is_already_in_the_environment(self):
        gen = generator.AmgiClipAudioGenerator(self.checkout, gemini_api_key="g-config")
        with mock.patch("generator.subprocess.run", side_effect=writes_clip(b"x")) as run, \
             mock.patch.dict(os.environ, {"GEMINI_API_KEY": "g-environment"}):
            gen.fetch_audio("text", "ko")
        self.assertEqual(run.call_args.kwargs["env"]["GEMINI_API_KEY"], "g-config")

    def test_with_no_config_key_the_environment_is_passed_through(self):
        gen = generator.AmgiClipAudioGenerator(self.checkout)
        with mock.patch("generator.subprocess.run", side_effect=writes_clip(b"x")) as run, \
             mock.patch.dict(os.environ, {"GEMINI_API_KEY": "g-environment"}):
            gen.fetch_audio("text", "ko")
        self.assertEqual(run.call_args.kwargs["env"]["GEMINI_API_KEY"], "g-environment")

    def test_exit_1_raises_with_the_last_stderr_line_as_the_message(self):
        message = self.failure(completed(1, stderr=(
            "2026-11-10T09:00:00Z amgi: gemini: speech attempt 3 failed\n"
            "Failed to generate valid audio for \"text\" after 3 attempts.\n\n"
        )))
        self.assertEqual(message, "Failed to generate valid audio for \"text\" after 3 attempts.")

    def test_a_non_zero_exit_with_empty_stderr_still_raises_a_readable_error(self):
        self.assertEqual(self.failure(completed(1, stderr="")), "amgi-clip exited 1 with no message")
        self.assertEqual(self.failure(completed(2, stderr="  \n\n")), "amgi-clip exited 2 with no message")

    def test_exit_3_says_gemini_asked_to_wait_and_how_long_rounded_up(self):
        message = self.failure(completed(3, stdout="retry-after-ms=61200\n", stderr="limiting how many requests\n"))
        self.assertIn("Gemini asked amgi to wait 62 s", message)
        self.assertIn("1 s", self.failure(completed(3, stdout="retry-after-ms=0\n")))

    def test_exit_3_with_no_wait_on_stdout_still_says_it_is_rate_limited(self):
        message = self.failure(completed(3, stdout="", stderr="whatever\n"))
        self.assertIn("limiting how many requests", message)
        self.assertNotIn("whatever", message)

    def test_exit_4_says_the_daily_cap_is_spent(self):
        message = self.failure(completed(4, stderr="You have used up today's Gemini requests.\n"))
        self.assertIn("daily cap is spent", message)

    def test_a_failed_run_leaves_no_temp_file(self):
        with mock.patch("generator.subprocess.run", side_effect=writes_clip(b"half", returncode=1, stderr="no\n")) as run:
            with self.assertRaises(generator.GenerationError):
                self.gen.fetch_audio("text", "ko")
        self.assertFalse(os.path.exists(run.call_args.args[0][-1]))

    def test_a_missing_binary_at_spawn_time_is_a_clear_generation_error(self):
        with mock.patch("generator.subprocess.run", side_effect=FileNotFoundError("no such file")):
            with self.assertRaises(generator.GenerationError) as ctx:
                self.gen.fetch_audio("text", "ko")
        self.assertIn("could not run", str(ctx.exception))
        self.assertIn("make -C server", str(ctx.exception))

    def test_a_binary_gone_before_fetch_is_the_same_clear_message_as_ensure_ready(self):
        os.remove(os.path.join(self.checkout, "server", "build", "amgi-clip"))
        with mock.patch("generator.subprocess.run") as run:
            with self.assertRaises(generator.GenerationError) as ctx:
                self.gen.fetch_audio("text", "ko")
        run.assert_not_called()
        self.assertIn("make -C server", str(ctx.exception))

    def test_a_timeout_is_a_clear_generation_error(self):
        gen = generator.AmgiClipAudioGenerator(self.checkout, gemini_api_key="g-test", timeout=5)
        with mock.patch(
            "generator.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["amgi-clip"], timeout=5)
        ):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("did not finish within 5s", str(ctx.exception))

    def test_exit_zero_but_no_clip_written_is_a_generation_error_not_a_crash(self):
        message = self.failure(completed(0))
        self.assertIn("wrote no clip", message)


class EndToEndTests(unittest.TestCase):
    """The real amgi-clip, run by AmgiClipAudioGenerator, against the fake Gemini."""

    def setUp(self):
        if not os.access(REAL_CLIP, os.X_OK):
            self.skipTest(f"{REAL_CLIP} is not built; run `make -C server` to run the real amgi-clip here.")
        if shutil.which("node") is None:
            self.skipTest("node is not on PATH, and the fake Gemini this test speaks to is a Node program.")
        fake = subprocess.Popen(
            ["node", str(FAKE_GEMINI), "0"], stdout=subprocess.PIPE, text=True, env=sandbox_env()
        )
        self.addCleanup(fake.wait)
        self.addCleanup(fake.kill)
        line = fake.stdout.readline().strip()
        fake.stdout.close()
        self.assertTrue(line.startswith("GEMINI_API_BASE="), f"the fake Gemini said {line!r}")
        self.base = line[len("GEMINI_API_BASE="):]

    def test_a_clip_comes_back_from_the_real_binary_with_the_key_from_env_local(self):
        # A checkout of its own: the real binary, and a .env.local holding the only key there is.
        checkout = tempfile.mkdtemp(prefix="amgi-checkout-")
        self.addCleanup(shutil.rmtree, checkout, True)
        os.makedirs(os.path.join(checkout, "server", "build"))
        os.symlink(REAL_CLIP, os.path.join(checkout, "server", "build", "amgi-clip"))
        with open(os.path.join(checkout, ".env.local"), "w", encoding="utf-8") as handle:
            handle.write("GEMINI_API_KEY=from-env-local\n")
        # The child inherits this process's environment: a sandboxed one, pointed at the fake, with
        # no GEMINI_API_KEY, so a clip at all proves the key was read from .env.local.
        with mock.patch.dict(os.environ, sandbox_env(GEMINI_API_BASE=self.base), clear=True):
            gen = generator.AmgiClipAudioGenerator(checkout, timeout=60)
            gen.ensure_ready()
            audio = gen.fetch_audio("안녕하세요", "ko")
        self.assertEqual(audio[:4], b"RIFF")
        self.assertEqual(audio[8:12], b"WAVE")
        self.assertGreater(len(audio), 44, "a WAV header and some samples")


if __name__ == "__main__":
    unittest.main()
