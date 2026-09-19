# amgi microphone for cards.
#
# Anki's webview never answers Qt's microphone permission request: qt/aqt has
# no featurePermissionRequested or permissionRequested handler at all, and Qt
# denies a request nobody answers. This add-on answers it, for one permission
# and one origin, so that a card template can open the microphone.
#
# Everything it does is in this file, and it is short on purpose: an add-on
# that asks for your microphone should be readable in one sitting.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

from typing import Any

from aqt import gui_hooks, mw
from aqt.qt import QUrl, QWebEnginePage, qtmajor, qtminor
from aqt.utils import showWarning

# Anki serves the reviewer and the collection's media from a local HTTP server
# on 127.0.0.1 (qt/aqt/main.py, serverURL). A request from anywhere else did
# not come from a card, and is refused.
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})

_ALREADY_INSTALLED = "_amgi_mic_installed"


def _is_ankis_own_page(origin: QUrl) -> bool:
    return origin.scheme() in ("http", "https") and origin.host() in LOCAL_HOSTS


def _on_permission_requested(permission: Any) -> None:
    """Qt 6.8 and later: one QWebEnginePermission object per request."""
    from aqt.qt import QWebEnginePermission

    if permission.permissionType() != QWebEnginePermission.PermissionType.MediaAudioCapture:
        # Left in the "ask" state, which Qt resolves as a denial. This add-on
        # grants the microphone and nothing else, not even the camera.
        return
    if not _is_ankis_own_page(permission.origin()):
        permission.deny()
        return
    permission.grant()


def _on_feature_permission_requested(origin: QUrl, feature: Any) -> None:
    """Qt 6.2 to 6.8: the older signal, removed in Qt 6.9."""
    page = mw.web.page()
    if feature != QWebEnginePage.Feature.MediaAudioCapture:
        return
    policy = (
        QWebEnginePage.PermissionPolicy.PermissionGrantedByUser
        if _is_ankis_own_page(origin)
        else QWebEnginePage.PermissionPolicy.PermissionDeniedByUser
    )
    page.setFeaturePermission(origin, feature, policy)


def install() -> None:
    """Connects to the main webview, which is the one the reviewer draws into
    (qt/aqt/reviewer.py: `self.web = mw.web`)."""
    web = getattr(mw, "web", None)
    page = web.page() if web is not None else None
    if page is None or getattr(page, _ALREADY_INSTALLED, False):
        return

    if hasattr(page, "permissionRequested"):
        page.permissionRequested.connect(_on_permission_requested)
    elif hasattr(page, "featurePermissionRequested"):
        page.featurePermissionRequested.connect(_on_feature_permission_requested)
    else:
        showWarning(
            "amgi microphone for cards: this Anki build's webview (Qt "
            f"{qtmajor}.{qtminor}) exposes no permission signal, so cards "
            "cannot be given the microphone. The amgi card template will fall "
            "back to its press-a-key path."
        )
        return

    setattr(page, _ALREADY_INSTALLED, True)


# The main webview exists by the time a profile is open, and reconnecting is a
# no-op, so this covers both a cold start and a profile switch.
gui_hooks.profile_did_open.append(install)
gui_hooks.main_window_did_init.append(install)
