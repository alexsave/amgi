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
from .generator import EdgeFunctionAudioGenerator, GenerationError, SupabaseSession

CONFIG_KEYS = ("supabase_url", "supabase_anon_key", "email", "password")


def _config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


def _build_generator(config: dict) -> EdgeFunctionAudioGenerator:
    missing = [key for key in CONFIG_KEYS if not config.get(key)]
    if missing:
        raise GenerationError(
            "amgi audio fill needs its Supabase settings first: open Tools > Add-ons, "
            f"select amgi_audio, click Config, and fill in {', '.join(missing)}."
        )
    session = SupabaseSession(
        config["supabase_url"], config["supabase_anon_key"], config["email"], config["password"]
    )
    return EdgeFunctionAudioGenerator(config["supabase_url"], session)


def _run_fill(fill_config: AudioFillConfig) -> None:
    try:
        generator = _build_generator(_config())
    except GenerationError as error:
        showWarning(str(error))
        return

    def op(col) -> FillResult:
        plan = plan_fill(col, fill_config)
        if plan.to_fill:
            # Fails once, up front, instead of as one identical failure per
            # note if the configured account can't sign in at all.
            generator.ensure_authenticated()

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
