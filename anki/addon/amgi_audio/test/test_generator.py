# Tests for the edge-function seam, mocked at the transport boundary
# (urllib.request.urlopen) rather than run against the real deployment: there
# is no Supabase project or API key available to this add-on's automated
# tests, and it must never touch the production project regardless. These
# tests check everything on this side of that boundary - request shape, auth
# headers, token refresh on a 401, and error mapping - which is the part a
# mock can prove and a live call could not prove any better.

from __future__ import annotations

import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generator  # noqa: E402


def http_response(payload: dict) -> mock.MagicMock:
    response = mock.MagicMock()
    response.read.return_value = json.dumps(payload).encode("utf-8")
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    return response


def http_error(code: int, body: bytes = b"{}") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url="https://example.test", code=code, msg="error", hdrs=None, fp=io.BytesIO(body))


class SupabaseSessionTests(unittest.TestCase):
    def test_signs_in_lazily_and_caches_the_access_token(self):
        session = generator.SupabaseSession("https://proj.supabase.co", "anon", "a@b.com", "pw")
        with mock.patch("urllib.request.urlopen", return_value=http_response({"access_token": "t1", "refresh_token": "r1"})) as urlopen:
            self.assertEqual(session.access_token(), "t1")
            self.assertEqual(session.access_token(), "t1")
            urlopen.assert_called_once()
            request = urlopen.call_args[0][0]
            self.assertEqual(request.full_url, "https://proj.supabase.co/auth/v1/token?grant_type=password")
            self.assertEqual(request.headers["Apikey"], "anon")

    def test_refresh_uses_the_refresh_token_when_one_is_held(self):
        session = generator.SupabaseSession("https://proj.supabase.co", "anon", "a@b.com", "pw")
        with mock.patch("urllib.request.urlopen", return_value=http_response({"access_token": "t1", "refresh_token": "r1"})):
            session.access_token()
        with mock.patch("urllib.request.urlopen", return_value=http_response({"access_token": "t2", "refresh_token": "r2"})) as urlopen:
            self.assertEqual(session.refresh(), "t2")
            request = urlopen.call_args[0][0]
            self.assertIn("grant_type=refresh_token", request.full_url)
            self.assertEqual(json.loads(request.data), {"refresh_token": "r1"})

    def test_refresh_falls_back_to_password_sign_in_when_the_refresh_token_is_dead(self):
        session = generator.SupabaseSession("https://proj.supabase.co", "anon", "a@b.com", "pw")
        with mock.patch("urllib.request.urlopen", return_value=http_response({"access_token": "t1", "refresh_token": "r1"})):
            session.access_token()

        calls = [http_error(401), http_response({"access_token": "t2", "refresh_token": "r2"})]

        def side_effect(*_args, **_kwargs):
            result = calls.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with mock.patch("urllib.request.urlopen", side_effect=side_effect):
            self.assertEqual(session.refresh(), "t2")

    def test_missing_access_token_in_response_is_an_auth_error(self):
        session = generator.SupabaseSession("https://proj.supabase.co", "anon", "a@b.com", "pw")
        with mock.patch("urllib.request.urlopen", return_value=http_response({"error": "invalid credentials"})):
            with self.assertRaises(generator.SupabaseAuthError):
                session.access_token()


def make_session(token: str = "t1") -> generator.SupabaseSession:
    session = generator.SupabaseSession("https://proj.supabase.co", "anon-key", "a@b.com", "pw")
    with mock.patch("urllib.request.urlopen", return_value=http_response({"access_token": token, "refresh_token": "r1"})):
        session.access_token()
    return session


class EdgeFunctionAudioGeneratorTests(unittest.TestCase):
    def test_ensure_authenticated_raises_before_any_note_is_attempted(self):
        session = generator.SupabaseSession("https://proj.supabase.co", "anon", "a@b.com", "wrong-password")
        gen = generator.EdgeFunctionAudioGenerator("https://proj.supabase.co", session)
        with mock.patch("urllib.request.urlopen", side_effect=http_error(400, b'{"error_description":"Invalid login"}')):
            with self.assertRaises(generator.GenerationError):
                gen.ensure_authenticated()

    def test_fetch_audio_sends_a_regenerate_only_request_and_downloads_the_result(self):
        gen = generator.EdgeFunctionAudioGenerator("https://proj.supabase.co", make_session())
        cards_response = http_response({"card": {"back_audio_path": "1700000000_back_abcd1234.mp3"}})
        audio_response = mock.MagicMock()
        audio_response.read.return_value = b"\x00mp3bytes"
        audio_response.__enter__.return_value = audio_response
        audio_response.__exit__.return_value = False

        calls = [cards_response, audio_response]
        with mock.patch("urllib.request.urlopen", side_effect=lambda *_a, **_k: calls.pop(0)) as urlopen:
            audio = gen.fetch_audio("안녕하세요", "ko")

        self.assertEqual(audio, b"\x00mp3bytes")
        self.assertEqual(urlopen.call_count, 2)

        cards_request = urlopen.call_args_list[0][0][0]
        self.assertEqual(cards_request.full_url, "https://proj.supabase.co/functions/v1/cards")
        self.assertEqual(cards_request.headers["Authorization"], "Bearer t1")
        self.assertEqual(cards_request.headers["Apikey"], "anon-key")
        body = json.loads(cards_request.data)
        self.assertEqual(body["regenerate_parts"], ["back_audio_path"])
        self.assertEqual(body["current_card"]["back_text"], "안녕하세요")
        self.assertEqual(body["learning_language"], "ko")
        # Only the audio side is asked for; nothing here should smuggle in a
        # second, competing text-generation request.
        self.assertNotIn("user_input", body)

        audio_request = urlopen.call_args_list[1][0][0]
        self.assertEqual(
            audio_request.full_url,
            "https://proj.supabase.co/storage/v1/object/public/card-audio/1700000000_back_abcd1234.mp3",
        )

    def test_a_401_from_the_cards_function_is_retried_once_after_a_refresh(self):
        gen = generator.EdgeFunctionAudioGenerator("https://proj.supabase.co", make_session())
        refresh_response = http_response({"access_token": "t2", "refresh_token": "r2"})
        retried_cards_response = http_response({"card": {"back_audio_path": "clip.mp3"}})
        audio_response = mock.MagicMock()
        audio_response.read.return_value = b"bytes"
        audio_response.__enter__.return_value = audio_response
        audio_response.__exit__.return_value = False

        calls = [http_error(401), refresh_response, retried_cards_response, audio_response]

        def side_effect(*_args, **_kwargs):
            result = calls.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with mock.patch("urllib.request.urlopen", side_effect=side_effect):
            audio = gen.fetch_audio("text", "ja")
        self.assertEqual(audio, b"bytes")

    def test_missing_back_audio_path_raises_generation_error(self):
        gen = generator.EdgeFunctionAudioGenerator("https://proj.supabase.co", make_session())
        with mock.patch("urllib.request.urlopen", return_value=http_response({"card": {}})):
            with self.assertRaises(generator.GenerationError):
                gen.fetch_audio("text", "ko")

    def test_a_quota_error_from_the_cards_function_surfaces_the_server_message(self):
        gen = generator.EdgeFunctionAudioGenerator("https://proj.supabase.co", make_session())
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=http_error(403, json.dumps({"error": "quota exceeded"}).encode()),
        ):
            with self.assertRaises(generator.GenerationError) as ctx:
                gen.fetch_audio("text", "ko")
        self.assertIn("quota exceeded", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
