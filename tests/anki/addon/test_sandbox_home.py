# sandbox_home.py's guard: every child these tests start gets a fresh HOME that is not the real
# home, inside it or above it, holds no Anki2 folder, and has no XDG_DATA_HOME.

from __future__ import annotations

import os
import pwd
import unittest

from sandbox_home import assert_sandboxed, sandbox_env


class SandboxHomeTests(unittest.TestCase):
    def test_each_child_gets_its_own_empty_home(self):
        a, b = sandbox_env(), sandbox_env(GEMINI_API_KEY="k")
        self.assertNotEqual(a["HOME"], b["HOME"])
        self.assertEqual(os.listdir(a["HOME"]), [])
        self.assertNotIn("XDG_DATA_HOME", b)
        self.assertEqual(b["GEMINI_API_KEY"], "k")

    def test_the_guard_refuses_the_real_home_inside_and_above_it(self):
        real = pwd.getpwuid(os.getuid()).pw_dir
        ok = sandbox_env()
        for home in (real, os.path.join(real, "Library"), "/"):
            with self.assertRaisesRegex(RuntimeError, "real home"):
                assert_sandboxed(dict(ok, HOME=home))

    def test_the_guard_refuses_xdg_data_home_and_an_anki2_folder(self):
        ok = sandbox_env()
        with self.assertRaisesRegex(RuntimeError, "XDG_DATA_HOME"):
            assert_sandboxed(dict(ok, XDG_DATA_HOME=ok["HOME"]))
        os.makedirs(os.path.join(ok["HOME"], "Library", "Application Support", "Anki2"))
        with self.assertRaisesRegex(RuntimeError, "Anki2"):
            assert_sandboxed(ok)


if __name__ == "__main__":
    unittest.main()
