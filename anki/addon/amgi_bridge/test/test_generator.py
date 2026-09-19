# Tests for the subprocess seam, mocked at the transport boundary
# (subprocess.run) rather than run against a real Node process: there is no
# OpenAI API key available to this add-on's automated tests, and live calls
# are not authorised regardless. These tests check everything on this side
# of that boundary - argument construction, exit-code handling, error
# messages, and temp-file cleanup - the same way the previous, edge-function
# version of this file mocked urllib.request.urlopen. generate-clip.js's own
# test/generate-clip.test.js (plusaudio/test/) proves the other side of the
# same contract from Node.

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generator  # noqa: E402

# test/test_generator.py -> test -> amgi_bridge -> addon -> anki -> repo root.
REAL_PLUSAUDIO_DIR = str(Path(__file__).resolve().parents[4] / "plusaudio")


def completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["node"], returncode=returncode, stdout=stdout, stderr=stderr)


class FindNodeTests(unittest.TestCase):
    def test_a_bare_command_is_resolved_against_path(self):
        with mock.patch("generator.shutil.which", return_value="/usr/local/bin/node") as which:
            self.assertEqual(generator._find_node("node"), "/usr/local/bin/node")
            which.assert_called_once_with("node")

    def test_a_bare_command_not_on_path_is_a_clear_generation_error(self):
        with mock.patch("generator.shutil.which", return_value=None):
            with self.assertRaises(generator.GenerationError) as ctx:
                generator._find_node("node")
        self.assertIn("could not find", str(ctx.exception))
        self.assertIn("node_path", str(ctx.exception))

    def test_an_explicit_path_that_is_not_executable_is_a_clear_generation_error(self):
        with self.assertRaises(generator.GenerationError) as ctx:
            generator._find_node("/definitely/not/a/real/node/binary")
        self.assertIn("not an executable file", str(ctx.exception))


class FindScriptTests(unittest.TestCase):
    def test_an_empty_plusaudio_dir_is_a_clear_generation_error(self):
        with self.assertRaises(generator.GenerationError) as ctx:
            generator._find_script("")
        self.assertIn("plusaudio_dir", str(ctx.exception))

    def test_a_plusaudio_dir_missing_generate_clip_js_is_a_clear_generation_error(self, ):
        with self.assertRaises(generator.GenerationError) as ctx:
            generator._find_script("/definitely/not/a/real/plusaudio/checkout")
        self.assertIn("generate-clip.js", str(ctx.exception))

    def test_the_real_plusaudio_dir_in_this_checkout_resolves(self):
        real_plusaudio_dir = REAL_PLUSAUDIO_DIR
        script_path = generator._find_script(real_plusaudio_dir)
        self.assertTrue(script_path.endswith("generate-clip.js"))
        self.assertTrue(os.path.isfile(script_path))


class EnsureReadyTests(unittest.TestCase):
    def setUp(self):
        self.real_plusaudio_dir = REAL_PLUSAUDIO_DIR

    def test_raises_when_node_is_missing(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch("generator.shutil.which", return_value=None):
            with self.assertRaises(generator.GenerationError):
                gen.ensure_ready()

    def test_raises_when_plusaudio_dir_has_no_script(self):
        gen = generator.NodeCliAudioGenerator("node", "/nowhere", openai_api_key="sk-test")
        with mock.patch("generator.shutil.which", return_value="/usr/bin/node"):
            with self.assertRaises(generator.GenerationError):
                gen.ensure_ready()

    def test_raises_when_no_key_is_configured_environed_or_in_a_dotenv_file(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir)
        with mock.patch("generator.shutil.which", return_value="/usr/bin/node"), \
             mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch("generator._env_file_has_key", return_value=False):
            os.environ.pop("OPENAI_API_KEY", None)
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.ensure_ready()
        self.assertIn("OpenAI API key", str(ctx.exception))

    def test_passes_when_the_key_comes_from_config(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch("generator.shutil.which", return_value="/usr/bin/node"), \
             mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENAI_API_KEY", None)
            gen.ensure_ready()  # does not raise

    def test_passes_when_the_key_comes_from_the_environment(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir)
        with mock.patch("generator.shutil.which", return_value="/usr/bin/node"), \
             mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            gen.ensure_ready()  # does not raise

    def test_passes_when_the_key_comes_from_a_dotenv_file(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir)
        with mock.patch("generator.shutil.which", return_value="/usr/bin/node"), \
             mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch("generator._env_file_has_key", return_value=True):
            os.environ.pop("OPENAI_API_KEY", None)
            gen.ensure_ready()  # does not raise


class FetchAudioTests(unittest.TestCase):
    def setUp(self):
        self.real_plusaudio_dir = REAL_PLUSAUDIO_DIR
        self.which_patch = mock.patch("generator.shutil.which", return_value="/usr/bin/node")
        self.which_patch.start()
        self.addCleanup(self.which_patch.stop)

    def test_success_writes_the_clip_generate_clip_js_left_behind_and_cleans_up(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")

        def fake_run(args, **kwargs):
            out_path = args[args.index("--out") + 1]
            with open(out_path, "wb") as handle:
                handle.write(b"\xff\xfb\x90\x00")
            return completed(0)

        with mock.patch("generator.subprocess.run", side_effect=fake_run) as run:
            audio = gen.fetch_audio("안녕하세요", "ko")

        self.assertEqual(audio, b"\xff\xfb\x90\x00")
        args, kwargs = run.call_args
        command = args[0]
        self.assertEqual(command[0], "/usr/bin/node")
        self.assertTrue(command[1].endswith("generate-clip.js"))
        self.assertEqual(command[2:], ["--text", "안녕하세요", "--language", "ko", "--out", command[-1]])
        self.assertEqual(kwargs["env"]["OPENAI_API_KEY"], "sk-test")
        # The temp file generate-clip.js "wrote" is cleaned up afterwards.
        self.assertFalse(os.path.exists(command[-1]))

    def test_config_key_overrides_whatever_is_already_in_the_environment(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-config")

        def fake_run(args, **kwargs):
            out_path = args[args.index("--out") + 1]
            with open(out_path, "wb") as handle:
                handle.write(b"x")
            return completed(0)

        with mock.patch("generator.subprocess.run", side_effect=fake_run) as run, \
             mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-environment"}):
            gen.fetch_audio("text", "ko")

        self.assertEqual(run.call_args.kwargs["env"]["OPENAI_API_KEY"], "sk-config")

    def test_a_non_zero_exit_raises_with_generate_clip_js_stderr_as_the_message(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch(
            "generator.subprocess.run",
            return_value=completed(1, stderr="OPENAI_API_KEY is not set (checked the environment and plusaudio/.env).\n"),
        ):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("OPENAI_API_KEY is not set", str(ctx.exception))

    def test_a_non_zero_exit_with_empty_stderr_still_raises_a_readable_error(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch("generator.subprocess.run", return_value=completed(1, stderr="")):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("exited 1", str(ctx.exception))

    def test_a_missing_node_binary_at_spawn_time_is_a_clear_generation_error(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch("generator.subprocess.run", side_effect=FileNotFoundError("no such file")):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("could not run", str(ctx.exception))

    def test_a_timeout_is_a_clear_generation_error(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test", timeout=5)
        with mock.patch(
            "generator.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["node"], timeout=5)
        ):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("did not finish", str(ctx.exception))

    def test_exit_zero_but_no_clip_written_is_treated_as_a_generation_error_not_a_crash(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")
        with mock.patch("generator.subprocess.run", return_value=completed(0)):
            with self.assertRaises(generator.GenerationError):
                gen.fetch_audio("text", "ko")

    def test_warnings_on_stderr_do_not_fail_a_successful_run(self):
        gen = generator.NodeCliAudioGenerator("node", self.real_plusaudio_dir, openai_api_key="sk-test")

        def fake_run(args, **kwargs):
            out_path = args[args.index("--out") + 1]
            with open(out_path, "wb") as handle:
                handle.write(b"clip")
            return completed(0, stderr="No expected reading for ...; the transcript check cannot tell\n")

        with mock.patch("generator.subprocess.run", side_effect=fake_run):
            audio = gen.fetch_audio("text", "ja")
        self.assertEqual(audio, b"clip")


if __name__ == "__main__":
    unittest.main()
