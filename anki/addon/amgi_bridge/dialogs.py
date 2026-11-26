# The dialog this add-on shows: BridgeStatusDialog (is the local HTTP bridge
# listening, on what port, and what is its token - see bridge_server.py and
# README.md, "Local HTTP bridge").
#
# UNVERIFIED - this file needs Qt to import at all, and Qt is not
# installable in the environment this add-on was written and tested in. See
# README.md, "What is unverified", for the exact manual steps to check it.
#
# Kept deliberately dumb: no network calls, no collection writes, nothing
# that bridge_ops.py's tests could have covered instead. Its only job is
# turning what the user picks into a config dict update; __init__.py does the rest.

from __future__ import annotations

from aqt.qt import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGuiApplication,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
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
