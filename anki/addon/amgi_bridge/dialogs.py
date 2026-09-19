# The dialogs this add-on shows: FillAudioDialog (pick a deck, then which
# field to read and which field to write the clip into) and
# BridgeStatusDialog (is the local HTTP bridge listening, on what port, and
# what is its token - see bridge_server.py and README.md, "Local HTTP
# bridge").
#
# UNVERIFIED - this file needs Qt to import at all, and Qt is not
# installable in the environment this add-on was written and tested in. See
# README.md, "What is unverified", for the exact manual steps to check it.
#
# Kept deliberately dumb: no network calls, no collection writes, nothing
# that core.py's or bridge_ops.py's tests could have covered instead. Their
# only job is turning what the user picks into a plain value (a
# core.AudioFillConfig, a config dict update); __init__.py does the rest.

from __future__ import annotations

from aqt.qt import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGuiApplication,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
)

from .core import AUDIO_TAG_FORMS, AudioFillConfig

# A starting point, not a limit: the field is editable, and any code
# cardGeneration.ts's per-language TTS instructions understand works, even if
# it is not in this shortlist.
COMMON_LANGUAGES = [
    "ko", "ja", "zh_cn", "zh_hk", "es", "fr", "de", "it", "pt", "ru",
    "vi", "th", "id", "hi", "ur", "ar", "tr", "en",
]

AUDIO_TAG_LABELS = {
    "sound": "[sound:...] - plays with Anki's own player (default)",
    "html": '<audio src="..."> - for the amgi review-loop note type in anki/notetype/',
}


def _field_names_in_deck(col, deck_id) -> list[str]:
    """Every field name used by any note type that has a note in this deck,
    union'd rather than intersected: a deck mixing note types should still
    offer every field a user might want to map, and core.plan_fill already
    skips a note whose type lacks the field chosen."""
    notetype_ids: set[int] = set()
    for card_id in col.decks.cids(deck_id, children=True):
        notetype_ids.add(col.get_card(card_id).note_type().id)

    names: list[str] = []
    seen = set()
    for notetype_id in notetype_ids:
        notetype = col.models.get(notetype_id)
        if notetype is None:
            continue
        for name in col.models.field_names(notetype):
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names


class FillAudioDialog(QDialog):
    def __init__(self, mw) -> None:
        super().__init__(mw)
        self.mw = mw
        self.setWindowTitle("amgi: Fill missing audio")

        self.deck_combo = QComboBox()
        self.decks = sorted(mw.col.decks.all_names_and_ids(), key=lambda d: d.name.lower())
        for deck in self.decks:
            self.deck_combo.addItem(deck.name, deck.id)
        self.deck_combo.currentIndexChanged.connect(self._refresh_fields)

        self.text_field_combo = QComboBox()
        self.audio_field_combo = QComboBox()

        self.language_combo = QComboBox()
        self.language_combo.setEditable(True)
        self.language_combo.addItems(COMMON_LANGUAGES)

        self.audio_tag_combo = QComboBox()
        for form in AUDIO_TAG_FORMS:
            self.audio_tag_combo.addItem(AUDIO_TAG_LABELS[form], form)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        form = QFormLayout()
        form.addRow("Deck", self.deck_combo)
        form.addRow("Read this field aloud", self.text_field_combo)
        form.addRow("Write the clip into", self.audio_field_combo)
        form.addRow("Language", self.language_combo)
        form.addRow("Reference form", self.audio_tag_combo)

        layout = QVBoxLayout()
        layout.addWidget(QLabel(
            "Finds notes in the chosen deck missing amgi-generated audio and adds it.\n"
            "Only the audio field is ever changed, and only to add or update this tool's own clip."
        ))
        layout.addLayout(form)
        layout.addWidget(buttons)
        self.setLayout(layout)

        self._refresh_fields()

    def _refresh_fields(self) -> None:
        deck_id = self.deck_combo.currentData()
        if deck_id is None:
            return
        fields = _field_names_in_deck(self.mw.col, deck_id)

        for combo, previous in ((self.text_field_combo, self.text_field_combo.currentText()),
                                 (self.audio_field_combo, self.audio_field_combo.currentText())):
            combo.clear()
            combo.addItems(fields)
            if previous in fields:
                combo.setCurrentText(previous)

        # A field whose name looks like an audio field is a reasonable
        # default, not a guarantee; the user can always pick a different one.
        for i in range(self.audio_field_combo.count()):
            if self.audio_field_combo.itemText(i).lower() in ("audio", "sound", "pronunciation"):
                self.audio_field_combo.setCurrentIndex(i)
                break

    def result_config(self) -> AudioFillConfig:
        return AudioFillConfig(
            deck_id=self.deck_combo.currentData(),
            text_field=self.text_field_combo.currentText(),
            audio_field=self.audio_field_combo.currentText(),
            language=self.language_combo.currentText().strip(),
            audio_tag=self.audio_tag_combo.currentData(),
        )


class BridgeStatusDialog(QDialog):
    """Tools > amgi: Bridge status... - the whole reason a background HTTP
    listener is allowed to exist at all without asking permission every
    time: the user can always see whether it is running, on what port, and
    turn it off from here without hunting through Tools > Add-ons > Config.

    The token is shown in full and is copyable, on purpose - it is not a
    password to a remote account, only a local shared secret the amgi web UI
    needs pasted into its own settings once so the two sides can talk (see
    bridge_auth.py's module docstring for what it is actually defending
    against). Anyone who can read this dialog can already read Anki's
    add-on config file it is stored in, on the same machine, so hiding it
    behind another click would add friction without adding security.
    """

    def __init__(self, mw, *, is_running: bool, port: "int | None", config: dict, on_toggle) -> None:
        super().__init__(mw)
        self.mw = mw
        self._on_toggle = on_toggle
        self.setWindowTitle("amgi: Bridge status")

        status_text = f"Listening on 127.0.0.1:{port}" if is_running else "Not running"
        self.status_label = QLabel(status_text)

        self.enabled_checkbox = QCheckBox("Enable the local HTTP bridge")
        self.enabled_checkbox.setChecked(bool(config.get("bridge_enabled", False)))
        self.enabled_checkbox.toggled.connect(self._toggled)

        self.token_field = QLineEdit(config.get("bridge_token") or "(generated once the bridge is enabled)")
        self.token_field.setReadOnly(True)

        copy_button = QPushButton("Copy token")
        copy_button.clicked.connect(self._copy_token)

        origins = config.get("bridge_allowed_origins") or []
        origins_label = QLabel(", ".join(origins) if origins else "(none configured)")
        origins_label.setWordWrap(True)

        form = QFormLayout()
        form.addRow("Status", self.status_label)
        form.addRow("Token", self.token_field)
        form.addRow("", copy_button)
        form.addRow("Allowed origins", origins_label)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        buttons.accepted.connect(self.accept)

        layout = QVBoxLayout()
        layout.addWidget(QLabel(
            "Lets the amgi web UI talk to this collection while Anki is running.\n"
            "Off by default; only 127.0.0.1 can reach it, and only with this token."
        ))
        layout.addWidget(self.enabled_checkbox)
        layout.addLayout(form)
        layout.addWidget(buttons)
        self.setLayout(layout)

    def _toggled(self, checked: bool) -> None:
        self._on_toggle(checked)

    def _copy_token(self) -> None:
        QGuiApplication.clipboard().setText(self.token_field.text())
