# amgi: two things, one add-on, one live collection.
#
# 1. Tools > amgi: Fill missing audio... - fills missing audio into a live
#    collection, with no export/import step. Opens a dialog to pick a deck
#    and field mapping (dialogs.py), then runs core.plan_fill/apply_fill
#    inside a single CollectionOp so the whole run lands as one undo step and
#    Anki's own change hooks fire when it is done. Unchanged by the bridge
#    below - see README.md for why both jobs live in one add-on regardless.
#
# 2. Tools > amgi: Bridge status... - a local HTTP bridge (bridge_server.py,
#    bridge_dispatch.py, bridge_ops.py) that lets the amgi web UI talk to
#    this same collection while Anki is running, mirroring what the Node
#    layer (plusaudio/lib/collection/) does when Anki is closed. Off by
#    default; see README.md, "Local HTTP bridge", for the full security
#    model.
#
# 3. Installing amgi's own note type into the collection on profile open
#    (notetype.py). The amgi website copies this add-on onto disk and drops
#    the card type into cardtype/ next to it; this is the half that needs
#    Anki's own API and so cannot happen from the website at all. Silent and
#    idempotent when there is nothing to do, which is every profile open
#    after the first.
#
# Everything GUI-shaped lives in this file and dialogs.py, and neither can be
# run outside Anki itself - Qt is not installable in the environment this was
# written in. core.py, deck_text.py, generator.py, bridge_ops.py,
# bridge_auth.py and bridge_server.py have no aqt import and are what test/
# actually exercises; see README.md, "What is unverified", for the exact
# manual steps to check this file.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import os
import secrets
from typing import Optional

from aqt import gui_hooks, mw
from aqt.operations import CollectionOp
from aqt.qt import QAction
from aqt.utils import showWarning, tooltip

from .bridge_dispatch import AqtBridgeDispatcher
from .bridge_server import BridgeServer
from .core import AudioFillConfig, FillResult, apply_fill, plan_fill
from .dialogs import BridgeStatusDialog, FillAudioDialog
from .generator import GenerationError, NodeCliAudioGenerator
from .notetype import AssetsMissing, assets_dir_for, ensure_notetype

DEFAULT_BRIDGE_PORT = 8798
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def _config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


def _build_generator(config: dict) -> NodeCliAudioGenerator:
    return NodeCliAudioGenerator(
        node_path=(config.get("node_path") or "node"),
        plusaudio_dir=(config.get("plusaudio_dir") or ""),
        openai_api_key=(config.get("openai_api_key") or None),
    )


def _run_fill(fill_config: AudioFillConfig) -> None:
    generator = _build_generator(_config())
    try:
        # A missing Node, repo checkout or API key is a local, instant check
        # (no subprocess, no network) - do it before the progress dialog even
        # opens, so a bad config is one clear message, not a background op
        # that starts and then immediately fails.
        generator.ensure_ready()
    except GenerationError as error:
        showWarning(str(error))
        return

    def op(col) -> FillResult:
        plan = plan_fill(col, fill_config)

        def progress(done: int, total: int, text: str) -> None:
            mw.taskman.run_on_main(
                lambda: mw.progress.update(
                    label=f"amgi: generating audio ({done}/{total})\n{text[:80]}",
                    value=done,
                    max=total,
                )
            )

        return apply_fill(
            col,
            plan,
            fetch_audio=lambda text: generator.fetch_audio(text, fill_config.language),
            progress=progress,
            want_cancel=mw.progress.want_cancel,
        )

    def on_success(result: FillResult) -> None:
        message = f"amgi: filled audio for {len(result.updated)} note(s)."
        if result.cancelled:
            message += " Cancelled - run it again to pick up where it left off."
        if result.failed:
            message += f" {len(result.failed)} failed and will be retried on the next run."
        tooltip(message, parent=mw)

    def on_failure(error: Exception) -> None:
        showWarning(f"amgi audio fill stopped: {error}")

    (
        CollectionOp(parent=mw, op=op)
        .with_progress(label="amgi: filling missing audio")
        .success(on_success)
        .failure(on_failure)
        .run_in_background()
    )


def _open_dialog() -> None:
    dialog = FillAudioDialog(mw)
    if dialog.exec():
        _run_fill(dialog.result_config())


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
    fill_action = QAction("amgi: Fill missing audio...", mw)
    fill_action.triggered.connect(_open_dialog)
    mw.form.menuTools.addAction(fill_action)

    bridge_action = QAction("amgi: Bridge status...", mw)
    bridge_action.triggered.connect(_open_bridge_status)
    mw.form.menuTools.addAction(bridge_action)


_add_menu_items()
gui_hooks.profile_did_open.append(_install_notetype)
gui_hooks.profile_did_open.append(_start_bridge_if_enabled)
gui_hooks.profile_will_close.append(_stop_bridge)
mw.addonManager.setConfigUpdatedAction(__name__, lambda _new_config: _start_bridge_if_enabled())
