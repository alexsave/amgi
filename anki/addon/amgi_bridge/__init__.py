# amgi: the bridge between a live Anki collection and the amgi web UI.
#
# 1. Tools > amgi: Bridge status... - a local HTTP bridge (bridge_server.py,
#    bridge_dispatch.py, bridge_ops.py) that lets the amgi web UI talk to
#    this collection while Anki is running, as the server's collection core
#    (server/collection/) does when Anki is closed. Off by default; see
#    README.md, "Local HTTP bridge", for the full security model.
#
# 2. Installing amgi's own note type into the collection on profile open
#    (notetype.py). The amgi website copies this add-on onto disk and drops
#    the card type into cardtype/ next to it; this is the half that needs
#    Anki's own API and so cannot happen from the website at all. Silent and
#    idempotent when there is nothing to do, which is every profile open
#    after the first.
#
# Everything GUI-shaped lives in this file and dialogs.py, and neither can be
# run outside Anki itself - Qt is not installable in the environment this was
# written in. deck_text.py, bridge_ops.py, bridge_auth.py and bridge_server.py
# have no aqt import and are what tests/anki/addon/ actually exercises; see
# README.md, "What is unverified", for the exact manual steps to check this file.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import os
import secrets
from typing import Optional

from aqt import gui_hooks, mw
from aqt.qt import QAction
from aqt.utils import showWarning, tooltip

from .bridge_dispatch import AqtBridgeDispatcher
from .bridge_server import BridgeServer
from .dialogs import BridgeStatusDialog
from .notetype import AssetsMissing, assets_dir_for, ensure_notetype

DEFAULT_BRIDGE_PORT = 8798
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def _config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


# ---------------------------------------------------------------------------
# Local HTTP bridge: off unless the user turns it on, and torn down whenever
# the profile that opened it closes (a new profile is a different
# collection; a leftover listener bound to the old one would be a bug, not a
# feature).

def _install_notetype() -> None:
    """Make sure the amgi note type and its media are in this collection.

    Runs on every profile open and says nothing when there is nothing to do,
    which is the normal case. It is deliberately quiet rather than
    reassuring: a dialog on every startup to report that nothing changed is
    how an add-on gets uninstalled.

    Every failure here is swallowed into a tooltip. Anki is starting up, the
    learner asked for their collection and not for this, and no part of
    reviewing depends on it having succeeded - a collection with no amgi note
    type is simply a collection they cannot use amgi cards in yet.
    """
    assets = assets_dir_for(os.path.dirname(os.path.abspath(__file__)))
    try:
        result = ensure_notetype(mw.col, assets)
    except AssetsMissing:
        # Installed by hand, from a zip with no cardtype/ folder in it. That
        # is a supported way to install this add-on, so it is not an error -
        # it just means the note type has to be built the manual way.
        return
    except Exception as error:  # noqa: BLE001 - see docstring
        tooltip(f"amgi could not set up its note type: {error}")
        return
    if result.changed:
        tooltip(result.summary())


_bridge_server: Optional[BridgeServer] = None


def _ensure_bridge_token(config: dict) -> str:
    """A token generated once, on the machine it will be used from, and
    stored in this add-on's own config - never hard-coded, never sent
    anywhere but checked against what a caller supplies. See
    bridge_auth.py's module docstring for what it defends against."""
    token = config.get("bridge_token") or ""
    if token:
        return token
    # Deliberately the OS's cryptographic source, not tests/helpers/random.js:
    # a secret must stay unguessable even with a seed fixed (see the ALLOWED
    # list in tests/repo/random.test.mjs).
    token = secrets.token_urlsafe(32)
    config["bridge_token"] = token
    mw.addonManager.writeConfig(__name__, config)
    return token


def _stop_bridge() -> None:
    global _bridge_server
    if _bridge_server is not None:
        _bridge_server.stop()
        _bridge_server = None


def _start_bridge_if_enabled() -> None:
    """Called on profile open and whenever the user edits this add-on's
    config (see setConfigUpdatedAction below) - always stops whatever was
    running first, so toggling `bridge_enabled` off, changing the port, or
    switching profiles never leaves two listeners or a stale one behind."""
    global _bridge_server
    _stop_bridge()

    config = _config()
    if not config.get("bridge_enabled", False):
        return

    token = _ensure_bridge_token(config)
    allowed_origins = frozenset(config.get("bridge_allowed_origins") or DEFAULT_ALLOWED_ORIGINS)
    port = int(config.get("bridge_port", DEFAULT_BRIDGE_PORT))

    try:
        server = BridgeServer(AqtBridgeDispatcher(), token=token, allowed_origins=allowed_origins, port=port)
    except OSError as error:
        showWarning(
            f"amgi bridge: could not listen on 127.0.0.1:{port} ({error}).\n"
            "Pick a different bridge_port in Tools > Add-ons > amgi_bridge > Config, "
            "then reopen Tools > amgi: Bridge status... to retry."
        )
        return

    server.start()
    _bridge_server = server


def _on_bridge_toggle(enabled: bool) -> None:
    config = _config()
    config["bridge_enabled"] = enabled
    mw.addonManager.writeConfig(__name__, config)
    _start_bridge_if_enabled()


def _open_bridge_status() -> None:
    config = _config()
    dialog = BridgeStatusDialog(
        mw,
        is_running=_bridge_server is not None,
        port=_bridge_server.port if _bridge_server is not None else None,
        config=config,
        on_toggle=_on_bridge_toggle,
    )
    dialog.exec()


def _add_menu_items() -> None:
    bridge_action = QAction("amgi: Bridge status...", mw)
    bridge_action.triggered.connect(_open_bridge_status)
    mw.form.menuTools.addAction(bridge_action)


_add_menu_items()
gui_hooks.profile_did_open.append(_install_notetype)
gui_hooks.profile_did_open.append(_start_bridge_if_enabled)
gui_hooks.profile_will_close.append(_stop_bridge)
mw.addonManager.setConfigUpdatedAction(__name__, lambda _new_config: _start_bridge_if_enabled())
