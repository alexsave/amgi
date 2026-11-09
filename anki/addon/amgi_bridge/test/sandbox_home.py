# Every process these tests start (collection_cli, node) runs with a fresh, empty temp HOME and no
# XDG_DATA_HOME, so nothing it does can reach a real Anki profile
# (~/Library/Application Support/Anki2). Incident 18:42: ~/Dev/foolish-reports/incident-1842.md.
# The node and shell halves are test/sandbox-home.cjs and ui/tools/sandbox-home.sh;
# test/sandbox-home.test.mjs holds every spawn in the test code to one of them.

from __future__ import annotations

import atexit
import os
import pwd
import shutil
import tempfile

_made: list[str] = []
atexit.register(lambda: [shutil.rmtree(d, ignore_errors=True) for d in _made])


def assert_sandboxed(env: dict) -> dict:
    """Raises unless `env` has a HOME that is not the real home or inside it, and no XDG_DATA_HOME."""
    if not env.get("HOME"):
        raise RuntimeError("sandbox: no HOME in the child environment")
    if "XDG_DATA_HOME" in env:
        raise RuntimeError("sandbox: XDG_DATA_HOME is set in the child environment")
    home = os.path.realpath(env["HOME"])
    real = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
    if os.path.commonpath([home, real]) in (home, real):
        raise RuntimeError("sandbox: refusing HOME=%s, the real home or inside it" % env["HOME"])
    if os.path.exists(os.path.join(home, "Library", "Application Support", "Anki2")):
        raise RuntimeError("sandbox: HOME=%s holds an Anki2 profile folder" % env["HOME"])
    return env


def sandbox_env(**extra: str) -> dict:
    """PATH and TMPDIR from this process, a fresh empty HOME for this child alone, and `extra`."""
    home = tempfile.mkdtemp(prefix="amgi-home-")
    _made.append(home)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": home}
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    env.update(extra)
    return assert_sandboxed(env)
