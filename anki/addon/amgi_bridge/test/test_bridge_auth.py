# Unit tests for bridge_auth.py's token and Origin checks - no Qt, no anki,
# no socket. See bridge_server.py's own tests (test_bridge_server.py) for the
# same checks proven against a real listening socket and a real HTTP client.

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge_auth import TOKEN_HEADER, check_preflight, check_request, is_allowed_origin  # noqa: E402

TOKEN = "s3cret-token-value"
ALLOWED = frozenset({"http://localhost:3000", "http://127.0.0.1:3000"})


class IsAllowedOriginTests(unittest.TestCase):
    def test_no_origin_header_is_not_a_failure(self):
        # Origin is a browser-only signal; a request with none (a local CLI
        # tool, curl) is not rejected on origin grounds - see the module
        # docstring for why that is not a security hole.
        self.assertTrue(is_allowed_origin(None, ALLOWED))

    def test_an_allowed_origin_passes(self):
        self.assertTrue(is_allowed_origin("http://localhost:3000", ALLOWED))

    def test_a_foreign_origin_fails(self):
        self.assertFalse(is_allowed_origin("https://evil.example", ALLOWED))

    def test_an_opaque_empty_origin_fails(self):
        self.assertFalse(is_allowed_origin("", ALLOWED))


class CheckRequestTests(unittest.TestCase):
    def test_valid_token_and_allowed_origin_succeeds(self):
        headers = {"Origin": "http://localhost:3000", TOKEN_HEADER: TOKEN}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertTrue(result.ok)
        self.assertEqual(result.origin, "http://localhost:3000")

    def test_valid_token_with_no_origin_header_succeeds(self):
        headers = {TOKEN_HEADER: TOKEN}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertTrue(result.ok)
        self.assertIsNone(result.origin)

    def test_missing_token_fails(self):
        headers = {"Origin": "http://localhost:3000"}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)

    def test_wrong_token_fails(self):
        headers = {"Origin": "http://localhost:3000", TOKEN_HEADER: "not-the-token"}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)

    def test_foreign_origin_fails_even_with_the_right_token(self):
        headers = {"Origin": "https://evil.example", TOKEN_HEADER: TOKEN}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 403)

    def test_a_simple_cross_origin_post_with_no_preflight_and_no_custom_header_fails(self):
        # A "simple" request (per the fetch/CORS spec: GET, HEAD, or POST
        # with a body type of text/plain, application/x-www-form-urlencoded
        # or multipart/form-data, and no headers beyond a small standard
        # set) never triggers a CORS preflight - the browser just sends it.
        # A hostile page relying on that to reach this bridge cannot add
        # TOKEN_HEADER without losing "simple" status and forcing a
        # preflight, so the one header this function actually requires is
        # exactly the one such a request cannot carry.
        headers = {"Origin": "https://evil.example", "Content-Type": "text/plain"}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertFalse(result.ok)

    def test_header_lookup_is_case_insensitive(self):
        headers = {"origin": "http://localhost:3000", TOKEN_HEADER.lower(): TOKEN}
        result = check_request(headers, token=TOKEN, allowed_origins=ALLOWED)
        self.assertTrue(result.ok)


class CheckPreflightTests(unittest.TestCase):
    def test_an_allowed_origin_is_accepted_with_no_token_at_all(self):
        # A real preflight cannot carry the token by construction (see the
        # module docstring) - this must succeed on Origin alone.
        result = check_preflight({"Origin": "http://localhost:3000"}, ALLOWED)
        self.assertTrue(result.ok)

    def test_a_foreign_origin_preflight_is_rejected(self):
        result = check_preflight({"Origin": "https://evil.example"}, ALLOWED)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 403)

    def test_no_origin_header_on_a_preflight_is_accepted(self):
        result = check_preflight({}, ALLOWED)
        self.assertTrue(result.ok)


if __name__ == "__main__":
    unittest.main()
