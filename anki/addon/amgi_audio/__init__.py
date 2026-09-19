# amgi: fill missing audio into a live collection, with no export/import step.
#
# Adds one menu item, Tools > amgi: Fill missing audio..., which opens a
# dialog to pick a deck and field mapping (dialogs.py), then runs
# core.plan_fill/apply_fill inside a single CollectionOp so the whole run
# lands as one undo step and Anki's own change hooks fire when it is done.
#
# Everything GUI-shaped lives in this file and dialogs.py, and neither can be
# run outside Anki itself - Qt is not installable in the environment this was
# written in. core.py, deck_text.py and generator.py have no aqt import and
# are what test/ actually exercises; see README.md, "What is unverified", for
# the exact manual steps to check this file.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

from aqt import mw
from aqt.operations import CollectionOp
from aqt.qt import QAction
from aqt.utils import showWarning, tooltip

from .core import AudioFillConfig, FillResult, apply_fill, plan_fill
from .dialogs import FillAudioDialog
from .generator import GenerationError, NodeCliAudioGenerator


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


def _add_menu_item() -> None:
    action = QAction("amgi: Fill missing audio...", mw)
    action.triggered.connect(_open_dialog)
    mw.form.menuTools.addAction(action)


_add_menu_item()
