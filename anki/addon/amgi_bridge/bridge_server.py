# The local HTTP bridge itself: routing, request/response JSON, and the
# auth/origin checks from bridge_auth.py, wired to a `dispatcher` object that
# does the actual work.
#
# This file has no aqt import and no anki import. It knows nothing about
# CollectionOp, mw, or even that it is running inside Anki - `dispatcher`
# is any object with the methods BridgeRequestHandler calls below, and
# bridge_dispatch.py is what supplies the real one (backed by
# aqt.operations.CollectionOp/QueryOp against mw.col). That seam is what
# makes test/test_bridge_server.py able to prove every routing, auth and
# origin decision this file makes without Qt or a running Anki: it hands in
# a fake dispatcher instead.
#
# Threading note (see also bridge_dispatch.py and __init__.py): this file
# runs on whatever thread ThreadingHTTPServer spins up per connection, which
# is never Anki's own main/GUI thread. Nothing in this file ever touches
# mw.col, mw, or any Qt object directly - it only calls methods on
# `dispatcher`, and it is that object's job (see bridge_dispatch.py) to hand
# the actual work to Anki's own operation queue and block until it is done.

from __future__ import annotations

import base64
import binascii
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

try:
    # The normal case: Anki has this add-on's directory on sys.path and
    # imports this as part of the amgi_bridge package.
    from .bridge_auth import TOKEN_HEADER, check_preflight, check_request
except ImportError:
    # test/ imports this module directly, with the add-on's own directory on
    # sys.path (see test/test_bridge_server.py) - the same dual-import
    # tolerance core.py uses for deck_text.py.
    from bridge_auth import TOKEN_HEADER, check_preflight, check_request

BIND_HOST = "127.0.0.1"

ALLOWED_METHODS = "GET, POST, PATCH, OPTIONS"
ALLOWED_HEADERS = f"Content-Type, {TOKEN_HEADER}"


class BridgeHTTPError(Exception):
    """A dispatcher-raised error that already knows its own HTTP status -
    a bad deck id, an unknown note type, a field-count mismatch. Anything
    else raised by the dispatcher is treated as a 500: a bug, not a bad
    request, and worth seeing in Anki's own debug console rather than being
    silently reworded."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class BridgeNotFound(BridgeHTTPError):
    def __init__(self, message: str) -> None:
        super().__init__(404, message)


class BridgeBadRequest(BridgeHTTPError):
    def __init__(self, message: str) -> None:
        super().__init__(400, message)


class BridgeBusy(BridgeHTTPError):
    def __init__(self, message: str = "no collection is open") -> None:
        super().__init__(503, message)


Route = tuple[str, re.Pattern, str]

ROUTES: list[Route] = [
    ("GET", re.compile(r"^/status$"), "get_status"),
    ("GET", re.compile(r"^/decks$"), "list_decks"),
    ("GET", re.compile(r"^/notetypes$"), "list_notetypes"),
    ("GET", re.compile(r"^/decks/(?P<deck_id>\d+)/notes$"), "list_notes"),
    ("POST", re.compile(r"^/decks$"), "create_deck"),
    ("POST", re.compile(r"^/notes$"), "add_note"),
    ("PATCH", re.compile(r"^/notes/(?P<note_id>\d+)$"), "update_note"),
    ("POST", re.compile(r"^/media$"), "add_media"),
]


def _parse_query(path: str) -> tuple[str, dict[str, str]]:
    if "?" not in path:
        return path, {}
    base, _, query = path.partition("?")
    params = {}
    for part in query.split("&"):
        if not part:
            continue
        key, _, value = part.partition("=")
        params[key] = value
    return base, params


def make_handler_class(
    dispatcher: Any,
    *,
    token: str,
    allowed_origins: frozenset[str],
) -> type[BaseHTTPRequestHandler]:
    """Build a BaseHTTPRequestHandler subclass bound to this one dispatcher,
    token and origin allowlist. A class, not an instance, because
    http.server instantiates a fresh handler per connection - the standard
    way to hand a stdlib HTTPServer per-server state without a shared global.
    """

    class BridgeRequestHandler(BaseHTTPRequestHandler):
        server_version = "amgi-bridge/1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
            # Anki's own console captures stdout/stderr; a hit log for every
            # poll from the UI is noise a local dev tool doesn't need. Errors
            # are still surfaced through the HTTP response body itself.
            pass

        # -- CORS / preflight -------------------------------------------------

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib method name
            result = check_preflight(self.headers, allowed_origins)
            if not result.ok:
                self._send_json(result.status, {"error": result.reason})
                return
            self.send_response(204)
            self._send_cors_headers(result.origin)
            self.send_header("Access-Control-Allow-Methods", ALLOWED_METHODS)
            self.send_header("Access-Control-Allow-Headers", ALLOWED_HEADERS)
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def _send_cors_headers(self, origin: Optional[str]) -> None:
            if origin is not None and origin in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        # -- routed methods -----------------------------------------------

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def do_PATCH(self) -> None:  # noqa: N802
            self._handle("PATCH")

        def _handle(self, method: str) -> None:
            auth = check_request(self.headers, token=token, allowed_origins=allowed_origins)
            if not auth.ok:
                self._send_json(auth.status, {"error": auth.reason}, origin=auth.origin)
                return

            path, query = _parse_query(self.path)
            for route_method, pattern, handler_name in ROUTES:
                if route_method != method:
                    continue
                match = pattern.match(path)
                if not match:
                    continue
                try:
                    body = self._read_json_body() if method in ("POST", "PATCH") else None
                    result = getattr(self, f"_op_{handler_name}")(match.groupdict(), query, body)
                    self._send_json(200, result, origin=auth.origin)
                except BridgeHTTPError as error:
                    self._send_json(error.status, {"error": str(error)}, origin=auth.origin)
                except (ValueError, LookupError) as error:
                    # A dispatcher validation error (bad field count, unknown
                    # note type or note id) - the caller's mistake, not a bug
                    # here, so 400 rather than 500.
                    self._send_json(400, {"error": str(error)}, origin=auth.origin)
                except Exception as error:  # noqa: BLE001 - reported to the caller, not crashed on
                    self._send_json(500, {"error": str(error)}, origin=auth.origin)
                return

            self._send_json(404, {"error": f"no route for {method} {path}"}, origin=auth.origin)

        def _read_json_body(self) -> dict:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length == 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw)
            except json.JSONDecodeError as error:
                raise BridgeBadRequest(f"invalid JSON body: {error}") from error

        # -- one method per route, name matched to ROUTES above -----------

        def _op_get_status(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            return dispatcher.get_status()

        def _op_list_decks(self, params: dict, query: dict, body: Optional[dict]) -> list:
            return dispatcher.list_decks()

        def _op_list_notetypes(self, params: dict, query: dict, body: Optional[dict]) -> list:
            return dispatcher.list_notetypes()

        def _op_list_notes(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            offset = int(query.get("offset", "0"))
            limit = int(query.get("limit", "200"))
            return dispatcher.list_notes(int(params["deck_id"]), offset=offset, limit=limit)

        def _op_create_deck(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            name = (body or {}).get("name")
            if not name or not isinstance(name, str):
                raise BridgeBadRequest('"name" is required')
            return dispatcher.create_deck(name)

        def _op_add_note(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            body = body or {}
            for key in ("deckId", "notetypeId", "fields"):
                if key not in body:
                    raise BridgeBadRequest(f'"{key}" is required')
            # language/learningFieldIndex are optional: they only feed the
            # romanisation guard (bridge_ops._romanization_warning). Omitting
            # either is exactly what every client did before that guard
            # existed, and still means nothing is checked.
            learning_field_index = body.get("learningFieldIndex")
            return dispatcher.add_note(
                deck_id=int(body["deckId"]),
                notetype_id=int(body["notetypeId"]),
                fields=list(body["fields"]),
                tags=list(body.get("tags", [])),
                language=body.get("language"),
                learning_field_index=int(learning_field_index) if learning_field_index is not None else None,
            )

        def _op_update_note(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            body = body or {}
            if "fields" not in body:
                raise BridgeBadRequest('"fields" is required')
            learning_field_index = body.get("learningFieldIndex")
            return dispatcher.update_note(
                int(params["note_id"]),
                list(body["fields"]),
                language=body.get("language"),
                learning_field_index=int(learning_field_index) if learning_field_index is not None else None,
            )

        def _op_add_media(self, params: dict, query: dict, body: Optional[dict]) -> dict:
            body = body or {}
            filename = body.get("filename")
            data_b64 = body.get("dataBase64")
            if not filename or not isinstance(filename, str):
                raise BridgeBadRequest('"filename" is required')
            if not data_b64 or not isinstance(data_b64, str):
                raise BridgeBadRequest('"dataBase64" is required')
            try:
                data = base64.b64decode(data_b64, validate=True)
            except (ValueError, binascii.Error) as error:
                raise BridgeBadRequest(f"invalid base64 in dataBase64: {error}") from error
            return dispatcher.add_media(filename, data)

        # -- output -----------------------------------------------------

        def _send_json(self, status: int, payload: Any, *, origin: Optional[str] = None) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._send_cors_headers(origin)
            self.end_headers()
            self.wfile.write(body)

    return BridgeRequestHandler


class BridgeServer:
    """Owns the listening socket. Always 127.0.0.1 - there is no parameter
    that can move this to 0.0.0.0 or any other interface; a caller who wants
    a different bind host has to edit this line, not pass a config value."""

    def __init__(
        self,
        dispatcher: Any,
        *,
        token: str,
        allowed_origins: frozenset[str],
        port: int = 0,
    ) -> None:
        handler_cls = make_handler_class(dispatcher, token=token, allowed_origins=allowed_origins)
        self._httpd = ThreadingHTTPServer((BIND_HOST, port), handler_cls)
        # Belt-and-braces alongside the hardcoded BIND_HOST above: fail loudly
        # if some future refactor ever lets a different host through, rather
        # than silently listening somewhere broader than intended.
        if self._httpd.server_address[0] not in (BIND_HOST, "::1"):
            self._httpd.server_close()
            raise RuntimeError(f"refusing to bind amgi bridge to {self._httpd.server_address[0]!r}")
        self._thread: Optional[threading.Thread] = None

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, name="amgi-bridge-http", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
