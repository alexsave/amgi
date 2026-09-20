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

    def list_field_values(self, deck_id, notetype_id, field_index):
        self._record("list_field_values", deck_id, notetype_id, field_index)
        return ["one", "two"]

    def add_notes_bulk(self, notes):
        self._record("add_notes_bulk", notes)
        return {"results": [{"ok": True, "noteId": i + 1, "guid": f"g{i}", "cardIds": [i + 1]} for i in range(len(notes))]}

    def update_note(self, note_id, fields, language=None, learning_field_index=None):
        self._record("update_note", note_id, fields, language=language, learning_field_index=learning_field_index)
        return {"noteId": note_id}

    def add_media(self, filename, data):
        self._record("add_media", filename, data)
        return {"filename": filename}

    def has_media(self, filename):
        self._record("has_media", filename)
        return filename == "already-there.mp3"


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

    def test_list_field_values(self):
        status, _headers, body = self._request(
            "GET", "/decks/9/notes/field-values?notetypeId=3&fieldIndex=1", headers=self._auth_headers()
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"values": ["one", "two"]})
        self.assertEqual(self.dispatcher.calls, [("list_field_values", (9, 3, 1), {})])

    def test_list_field_values_requires_notetype_id_and_field_index(self):
        status, _headers, body = self._request(
            "GET", "/decks/9/notes/field-values?notetypeId=3", headers=self._auth_headers()
        )
        self.assertEqual(status, 400)
        self.assertIn("fieldIndex", body["error"])

    def test_add_notes_bulk(self):
        payload = {
            "notes": [
                {"deckId": 1, "notetypeId": 1, "fields": ["a", "b"]},
                {"deckId": 1, "notetypeId": 1, "fields": ["c", "d"], "language": "ko", "learningFieldIndex": 1},
            ]
        }
        status, _headers, body = self._request(
            "POST", "/notes/bulk", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(body["results"]), 2)
        self.assertTrue(all(r["ok"] for r in body["results"]))
        name, args, _kwargs = self.dispatcher.calls[0]
        self.assertEqual(name, "add_notes_bulk")
        notes = args[0]
        self.assertEqual(notes[0], {"deck_id": 1, "notetype_id": 1, "fields": ["a", "b"], "tags": [], "language": None, "learning_field_index": None})
        self.assertEqual(notes[1]["language"], "ko")
        self.assertEqual(notes[1]["learning_field_index"], 1)

    def test_add_notes_bulk_requires_a_non_empty_notes_array(self):
        status, _headers, body = self._request(
            "POST", "/notes/bulk", headers=self._auth_headers(), body=json.dumps({"notes": []})
        )
        self.assertEqual(status, 400)
        self.assertIn("notes", body["error"])

    def test_add_notes_bulk_missing_a_required_field_is_a_bad_request(self):
        payload = {"notes": [{"deckId": 1, "fields": ["a", "b"]}]}
        status, _headers, body = self._request(
            "POST", "/notes/bulk", headers=self._auth_headers(), body=json.dumps(payload)
        )
        self.assertEqual(status, 400)
        self.assertIn("notetypeId", body["error"])

    def test_has_media(self):
        status, _headers, body = self._request(
            "GET", "/media/already-there.mp3", headers=self._auth_headers()
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"exists": True})

    def test_has_media_false_for_a_name_not_present(self):
        status, _headers, body = self._request(
            "GET", "/media/missing.mp3", headers=self._auth_headers()
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"exists": False})

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

    def test_a_content_length_beyond_the_body_size_limit_is_rejected_without_reading_it(self):
        # A caller (malicious, or just a badly configured proxy) claiming a
        # huge Content-Length must be refused before the server ever tries
        # to read that many bytes off the socket - see MAX_BODY_BYTES's own
        # comment in bridge_server.py. This sends real headers and NO body at
        # all: if the server ever actually called rfile.read() for this, the
        # connection would hang waiting for bytes that never arrive, and this
        # test would time out instead of finishing quickly.
        from bridge_server import MAX_BODY_BYTES

        conn = self._connection()
        conn.putrequest("POST", "/decks")
        conn.putheader(TOKEN_HEADER, TOKEN)
        conn.putheader("Origin", ALLOWED_ORIGIN)
        conn.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
        conn.endheaders()
        response = conn.getresponse()
        status = response.status
        body = json.loads(response.read())
        conn.close()
        self.assertEqual(status, 413)
        self.assertIn("bytes", body["error"])
        self.assertEqual(self.dispatcher.calls, [], "the dispatcher must never be reached for a rejected body")

    def test_media_route_gets_a_larger_body_allowance_than_every_other_route(self):
        from bridge_server import MAX_BODY_BYTES, MAX_MEDIA_BODY_BYTES

        self.assertGreater(MAX_MEDIA_BODY_BYTES, MAX_BODY_BYTES)

        conn = self._connection()
        conn.putrequest("POST", "/decks")
        conn.putheader(TOKEN_HEADER, TOKEN)
        conn.putheader("Origin", ALLOWED_ORIGIN)
        # Comfortably over the ordinary limit but under the media one - only
        # meaningful because /decks is NOT the media route, so it must still
        # be rejected at the tighter limit.
        conn.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
        conn.endheaders()
        response = conn.getresponse()
        status = response.status
        response.read()
        conn.close()
        self.assertEqual(status, 413)


class SlowClientTests(BridgeServerTestCase):
    """A client that promises a body (Content-Length) and then never finishes
    sending it - a stalled connection, or a proxy/hand-built request with a
    wrong header - must not pin this thread forever. Uses a millisecond-scale
    `body_read_timeout` (see BridgeServer's own parameter) so this test
    finishes quickly instead of waiting out the real 30-second default."""

    def setUp(self):
        self.dispatcher = self.make_dispatcher()
        self.server = BridgeServer(
            self.dispatcher, token=TOKEN, allowed_origins=ALLOWED, port=0, body_read_timeout=0.2
        )
        self.server.start()
        self.addCleanup(self.server.stop)

    def make_dispatcher(self):
        return FakeDispatcher()

    def test_a_body_that_never_finishes_arriving_times_out_instead_of_hanging_forever(self):
        import socket

        sock = socket.create_connection(("127.0.0.1", self.server.port), timeout=5)
        request = (
            f"POST /decks HTTP/1.1\r\n"
            f"Host: 127.0.0.1\r\n"
            f"{TOKEN_HEADER}: {TOKEN}\r\n"
            f"Origin: {ALLOWED_ORIGIN}\r\n"
            f"Content-Length: 1000\r\n"
            f"\r\n"
            f'{{"name": "on'  # a partial body; the other ~985 promised bytes never arrive
        )
        sock.sendall(request.encode("ascii"))
        # The client's own socket timeout (5s) is just a safety net for this
        # test process; the real assertion is that the SERVER's own
        # body_read_timeout (0.2s) fires well before that and the connection
        # is closed/responded to rather than sitting open indefinitely.
        response = sock.recv(4096)
        sock.close()
        self.assertTrue(response, "the server must respond (or at least close the connection), not hang")


class ConcurrencyTests(BridgeServerTestCase):
    """ThreadingHTTPServer hands each connection its own handler instance and
    thread; this proves that promise holds in practice - many concurrent
    requests, each carrying request-specific data, get back exactly their own
    answer with no cross-talk - rather than just asserting it from reading
    the stdlib's docs."""

    def test_many_concurrent_requests_never_cross_talk(self):
        import concurrent.futures

        def one_request(i):
            status, _headers, body = self._request(
                "GET", f"/decks/{i}/notes?offset={i}&limit=5", headers={TOKEN_HEADER: TOKEN}
            )
            return i, status, body

        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            outcomes = list(pool.map(one_request, range(40)))

        for i, status, body in outcomes:
            self.assertEqual(status, 200)
            # Each response must echo back the offset that specific request
            # asked for - proof this thread's request never got mixed up
            # with a different concurrent request's data.
            self.assertEqual(body["offset"], i)


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
