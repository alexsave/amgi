# Integration tests for bridge_server.py against a REAL listening socket and
# a real HTTP client - no Qt, no anki, no CollectionOp: the dispatcher is a
# small fake recording what it was called with. This is what proves the
# threat-model claims in bridge_auth.py and README.md ("Local HTTP bridge")
# against actual bytes on a socket, not just the pure functions
# test_bridge_auth.py already checks in isolation.

from __future__ import annotations

import base64
import http.client
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge_auth import TOKEN_HEADER  # noqa: E402
from bridge_server import BridgeBusy, BridgeServer  # noqa: E402

TOKEN = "test-token-0123456789"
ALLOWED_ORIGIN = "http://localhost:3000"
FOREIGN_ORIGIN = "https://evil.example"
ALLOWED = frozenset({ALLOWED_ORIGIN})


class FakeDispatcher:
    """Records every call and returns canned, JSON-serializable data - the
    same shapes bridge_dispatch.AqtBridgeDispatcher's real methods produce,
    without needing Anki to build them."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def _record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))

    def get_status(self):
        self._record("get_status")
        return {"collectionOpen": True, "profileName": "User 1"}

    def list_decks(self):
        self._record("list_decks")
        return [{"id": 1, "name": "Default"}]

    def list_notetypes(self):
        self._record("list_notetypes")
        return [{"id": 1, "name": "Basic", "fieldNames": ["Front", "Back"]}]

    def list_notes(self, deck_id, *, offset, limit):
        self._record("list_notes", deck_id, offset=offset, limit=limit)
        return {"notes": [], "total": 0, "offset": offset, "limit": limit}

    def create_deck(self, name):
        self._record("create_deck", name)
        return {"deck": {"id": 42, "name": name}, "created": True}

    def add_note(self, *, deck_id, notetype_id, fields, tags, language=None, learning_field_index=None):
        self._record(
            "add_note",
            deck_id=deck_id,
            notetype_id=notetype_id,
            fields=fields,
            tags=tags,
            language=language,
            learning_field_index=learning_field_index,
        )
        return {"noteId": 7, "guid": "abc123", "cardIds": [8]}

    def update_note(self, note_id, fields, language=None, learning_field_index=None):
        self._record("update_note", note_id, fields, language=language, learning_field_index=learning_field_index)
        return {"noteId": note_id}

    def add_media(self, filename, data):
        self._record("add_media", filename, data)
        return {"filename": filename}


class FailingDispatcher(FakeDispatcher):
    def __init__(self, exc: Exception) -> None:
        super().__init__()
        self._exc = exc

    def get_status(self):
        raise self._exc


class BridgeServerTestCase(unittest.TestCase):
    def make_dispatcher(self):
        return FakeDispatcher()

    def setUp(self):
        self.dispatcher = self.make_dispatcher()
        self.server = BridgeServer(self.dispatcher, token=TOKEN, allowed_origins=ALLOWED, port=0)
        self.server.start()
        self.addCleanup(self.server.stop)

    def _connection(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)

    def _request(self, method, path, *, headers=None, body=None):
        conn = self._connection()
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        parsed = json.loads(raw) if raw else None
        return response.status, dict(response.getheaders()), parsed


class BindingTests(BridgeServerTestCase):
    def test_binds_to_127_0_0_1_only(self):
        # Never 0.0.0.0: BridgeServer.__init__ hardcodes the bind host and
        # cross-checks it, so this is really asserting there is no way to
        # have gotten a different address here at all.
        self.assertEqual(self.server._httpd.server_address[0], "127.0.0.1")


class AuthAndOriginTests(BridgeServerTestCase):
    def test_valid_token_and_allowed_origin_succeeds(self):
        status, headers, body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: TOKEN, "Origin": ALLOWED_ORIGIN}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"collectionOpen": True, "profileName": "User 1"})
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN)

    def test_valid_token_with_no_origin_header_succeeds(self):
        # A same-machine caller with no Origin at all (curl, a local script)
        # is not a browser and is judged on the token alone.
        status, _headers, _body = self._request("GET", "/status", headers={TOKEN_HEADER: TOKEN})
        self.assertEqual(status, 200)

    def test_missing_token_fails(self):
        status, _headers, body = self._request("GET", "/status", headers={"Origin": ALLOWED_ORIGIN})
        self.assertEqual(status, 401)
        self.assertIn("token", body["error"])

    def test_wrong_token_fails(self):
        status, _headers, _body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: "wrong", "Origin": ALLOWED_ORIGIN}
        )
        self.assertEqual(status, 401)

    def test_foreign_origin_fails_even_with_the_correct_token(self):
        status, headers, _body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: TOKEN, "Origin": FOREIGN_ORIGIN}
        )
        self.assertEqual(status, 403)
        # No CORS header handed to an origin that was just rejected.
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_a_simple_no_preflight_cross_origin_post_from_a_foreign_origin_is_rejected(self):
        # Shaped exactly like a "simple request" the browser would never
        # preflight: POST, Content-Type: text/plain, no custom headers - and
        # sent to a mutating route, to make sure the rejection happens
        # before any dispatcher method runs.
        status, _headers, _body = self._request(
            "POST",
            "/decks",
            headers={"Origin": FOREIGN_ORIGIN, "Content-Type": "text/plain"},
            body=json.dumps({"name": "Hijacked"}),
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.dispatcher.calls, [])

    def test_a_simple_no_preflight_post_from_an_allowed_origin_still_needs_the_token(self):
        # Defense in depth: even if a request somehow originates from an
        # allowed origin, skipping the token (as any "simple" request must,
        # to remain unpreflighted) is still rejected. The Origin allowlist
        # is not, by itself, sufficient - see bridge_auth.py's docstring.
        status, _headers, _body = self._request(
            "POST",
            "/decks",
            headers={"Origin": ALLOWED_ORIGIN, "Content-Type": "text/plain"},
            body=json.dumps({"name": "No token"}),
        )
        self.assertEqual(status, 401)
        self.assertEqual(self.dispatcher.calls, [])

    def test_preflight_from_an_allowed_origin_is_answered_with_no_token_required(self):
        conn = self._connection()
        conn.request("OPTIONS", "/decks", headers={"Origin": ALLOWED_ORIGIN})
        response = conn.getresponse()
        response.read()
        conn.close()
        self.assertEqual(response.status, 204)
        headers = dict(response.getheaders())
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN)
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))
        self.assertIn(TOKEN_HEADER, headers.get("Access-Control-Allow-Headers", ""))

    def test_preflight_from_a_foreign_origin_is_rejected(self):
        conn = self._connection()
        conn.request("OPTIONS", "/decks", headers={"Origin": FOREIGN_ORIGIN})
        response = conn.getresponse()
        response.read()
        conn.close()
        self.assertEqual(response.status, 403)


class RoutingTests(BridgeServerTestCase):
    def _auth_headers(self, extra=None):
        headers = {TOKEN_HEADER: TOKEN, "Origin": ALLOWED_ORIGIN}
        headers.update(extra or {})
        return headers

    def test_get_decks(self):
        status, _headers, body = self._request("GET", "/decks", headers=self._auth_headers())
        self.assertEqual(status, 200)
        self.assertEqual(body, [{"id": 1, "name": "Default"}])

    def test_get_notetypes(self):
        status, _headers, body = self._request("GET", "/notetypes", headers=self._auth_headers())
        self.assertEqual(status, 200)
        self.assertEqual(body[0]["name"], "Basic")

    def test_list_notes_in_deck_parses_pagination_query_params(self):
        status, _headers, body = self._request(
            "GET", "/decks/9/notes?offset=40&limit=20", headers=self._auth_headers()
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"notes": [], "total": 0, "offset": 40, "limit": 20})
        self.assertEqual(self.dispatcher.calls, [("list_notes", (9,), {"offset": 40, "limit": 20})])

    def test_list_notes_defaults_offset_and_limit_when_absent(self):
        self._request("GET", "/decks/9/notes", headers=self._auth_headers())
        self.assertEqual(self.dispatcher.calls, [("list_notes", (9,), {"offset": 0, "limit": 200})])

    def test_create_deck(self):
        status, _headers, body = self._request(
            "POST", "/decks", headers=self._auth_headers(), body=json.dumps({"name": "Korean::Verbs"})
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"deck": {"id": 42, "name": "Korean::Verbs"}, "created": True})

    def test_create_deck_without_a_name_is_a_bad_request(self):
        status, _headers, body = self._request("POST", "/decks", headers=self._auth_headers(), body="{}")
        self.assertEqual(status, 400)
        self.assertIn("name", body["error"])

    def test_add_note(self):
        payload = {"deckId": 1, "notetypeId": 1, "fields": ["front", "back"], "tags": ["x"]}
        status, _headers, body = self._request(
            "POST", "/notes", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"noteId": 7, "guid": "abc123", "cardIds": [8]})
        self.assertEqual(
            self.dispatcher.calls,
            [
                (
                    "add_note",
                    (),
                    {
                        "deck_id": 1,
                        "notetype_id": 1,
                        "fields": ["front", "back"],
                        "tags": ["x"],
                        "language": None,
                        "learning_field_index": None,
                    },
                )
            ],
        )

    def test_add_note_passes_through_the_optional_romanisation_guard_fields(self):
        payload = {
            "deckId": 1,
            "notetypeId": 1,
            "fields": ["front", "back"],
            "tags": ["x"],
            "language": "ko",
            "learningFieldIndex": 1,
        }
        self._request("POST", "/notes", headers=self._auth_headers(), body=json.dumps(payload))
        self.assertEqual(self.dispatcher.calls[0][2]["language"], "ko")
        self.assertEqual(self.dispatcher.calls[0][2]["learning_field_index"], 1)

    def test_add_note_defaults_tags_to_empty(self):
        payload = {"deckId": 1, "notetypeId": 1, "fields": ["a", "b"]}
        self._request("POST", "/notes", headers=self._auth_headers(), body=json.dumps(payload))
        self.assertEqual(self.dispatcher.calls[0][2]["tags"], [])

    def test_add_note_missing_a_required_field_is_a_bad_request(self):
        payload = {"deckId": 1, "fields": ["a", "b"]}
        status, _headers, body = self._request(
            "POST", "/notes", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 400)
        self.assertIn("notetypeId", body["error"])

    def test_update_note(self):
        status, _headers, body = self._request(
            "PATCH", "/notes/55", headers=self._auth_headers(), body=json.dumps({"fields": ["x", "y"]})
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"noteId": 55})
        self.assertEqual(
            self.dispatcher.calls,
            [("update_note", (55, ["x", "y"]), {"language": None, "learning_field_index": None})],
        )

    def test_update_note_passes_through_the_optional_romanisation_guard_fields(self):
        payload = {"fields": ["x", "y"], "language": "ja", "learningFieldIndex": 0}
        self._request("PATCH", "/notes/55", headers=self._auth_headers(), body=json.dumps(payload))
        self.assertEqual(self.dispatcher.calls[0][2]["language"], "ja")
        self.assertEqual(self.dispatcher.calls[0][2]["learning_field_index"], 0)

    def test_add_media_decodes_base64(self):
        data = b"not really audio"
        payload = {"filename": "clip.mp3", "dataBase64": base64.b64encode(data).decode("ascii")}
        status, _headers, body = self._request(
            "POST", "/media", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"filename": "clip.mp3"})
        name, args, _kwargs = self.dispatcher.calls[0]
        self.assertEqual(name, "add_media")
        self.assertEqual(args, ("clip.mp3", data))

    def test_add_media_rejects_invalid_base64(self):
        payload = {"filename": "clip.mp3", "dataBase64": "not-valid-base64!!"}
        status, _headers, body = self._request(
            "POST", "/media", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 400)

    def test_invalid_json_body_is_a_bad_request(self):
        status, _headers, body = self._request(
            "POST", "/decks", headers=self._auth_headers(), body="{not json"
        )
        self.assertEqual(status, 400)

    def test_unknown_route_is_404(self):
        status, _headers, _body = self._request("GET", "/nope", headers=self._auth_headers())
        self.assertEqual(status, 404)


class BridgeBusyDispatcherTests(BridgeServerTestCase):
    def make_dispatcher(self):
        return FailingDispatcher(BridgeBusy("no collection is open"))

    def test_bridge_busy_is_reported_as_503(self):
        status, _headers, body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: TOKEN, "Origin": ALLOWED_ORIGIN}
        )
        self.assertEqual(status, 503)
        self.assertIn("collection", body["error"])


class ValueErrorDispatcherTests(BridgeServerTestCase):
    def make_dispatcher(self):
        return FailingDispatcher(ValueError("bad field count"))

    def test_a_value_error_from_the_dispatcher_is_a_400(self):
        status, _headers, body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: TOKEN, "Origin": ALLOWED_ORIGIN}
        )
        self.assertEqual(status, 400)
        self.assertIn("bad field count", body["error"])


class UnexpectedErrorDispatcherTests(BridgeServerTestCase):
    def make_dispatcher(self):
        return FailingDispatcher(RuntimeError("boom"))

    def test_an_unexpected_error_from_the_dispatcher_is_a_500(self):
        status, _headers, body = self._request(
            "GET", "/status", headers={TOKEN_HEADER: TOKEN, "Origin": ALLOWED_ORIGIN}
        )
        self.assertEqual(status, 500)
        self.assertIn("boom", body["error"])


if __name__ == "__main__":
    unittest.main()
