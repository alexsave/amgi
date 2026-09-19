# Where this add-on gets a clip's audio bytes from.
#
# The generation policy - prompts, TTS voice instructions, the
# transcribe-then-judge validation loop - lives in exactly one place,
# supabase/functions/_shared/cardGeneration.ts, and is not allowed a second
# copy. The `plusaudio` CLI reaches it by requiring the TypeScript module
# directly into Node; this add-on is Python and cannot do that, so it calls
# out instead, over HTTPS, to the deployed `cards` edge function that already
# runs that module (see supabase/functions/cards/index.ts).
#
# That is the seam this file exists to be. AudioGenerator below is the only
# thing core.apply_fill depends on - a callable from text to bytes - so this
# HTTP client is not load-bearing for anything else in the add-on: a
# NodeCliAudioGenerator that shells out to `node plusaudio/add-audio.js`'s
# generator for a user who has the repo checked out and a local Supabase
# instance running would satisfy the exact same interface, and nothing in
# core.py or __init__.py would need to change to add one.
#
# Why the edge function and not the local CLI, for v1: this add-on is for
# reaching into a live collection with no export/import step, and its whole
# reason to exist is convenience over that same manual round trip. Requiring
# Node, a repo checkout and a local Supabase instance just to fill in audio
# would trade one manual step for another. Everyone who can already use the
# amgi web app has what the edge function needs - an amgi account - and
# nothing else.
#
# There is no API key or Supabase project available to exercise this against
# in this environment, and this file must not be exercised against the real,
# production project regardless. test/test_generator.py mocks urllib at the
# transport boundary (`urllib.request.urlopen`) and checks everything on this
# side of that boundary: the request shape, the auth headers, response
# unwrapping, and error handling. What is NOT covered, and can only be proven
# against the real deployment, is listed in the add-on README.
#
# License: GNU AGPL, version 3 or later, to match Anki's own.

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Protocol


class AudioGenerator(Protocol):
    def fetch_audio(self, text: str) -> bytes:
        ...


class GenerationError(Exception):
    """Raised when the edge function refuses, or fails, to produce audio."""


class SupabaseAuthError(GenerationError):
    """Raised when signing in to get an access token fails."""


def _post_json(url: str, body: dict, headers: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise GenerationError(f"{url} returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise GenerationError(f"could not reach {url}: {error.reason}") from error


class SupabaseSession:
    """Signs in once and refreshes on demand.

    A run over hundreds of notes can outlast a Supabase access token's
    lifetime (about an hour), so this re-authenticates with the refresh token
    GoTrue hands back at sign-in rather than asking for a fresh token to be
    pasted in mid-run - the whole point of the add-on is not babysitting it.
    """

    def __init__(self, project_url: str, anon_key: str, email: str, password: str, timeout: float = 30.0) -> None:
        self._auth_url = project_url.rstrip("/") + "/auth/v1"
        self._anon_key = anon_key
        self._email = email
        self._password = password
        self._timeout = timeout
        self._access_token: str | None = None
        self._refresh_token: str | None = None

    @property
    def anon_key(self) -> str:
        return self._anon_key

    def access_token(self) -> str:
        if self._access_token is None:
            self._sign_in()
        assert self._access_token is not None
        return self._access_token

    def refresh(self) -> str:
        """Called after a request comes back unauthorized. Falls back to a
        fresh password sign-in if the refresh token has also expired."""
        if self._refresh_token is None:
            self._sign_in()
            return self.access_token()
        try:
            payload = _post_json(
                f"{self._auth_url}/token?grant_type=refresh_token",
                {"refresh_token": self._refresh_token},
                {"apikey": self._anon_key},
                self._timeout,
            )
            self._store_tokens(payload)
        except GenerationError:
            self._sign_in()
        return self.access_token()

    def _sign_in(self) -> None:
        payload = _post_json(
            f"{self._auth_url}/token?grant_type=password",
            {"email": self._email, "password": self._password},
            {"apikey": self._anon_key},
            self._timeout,
        )
        self._store_tokens(payload)

    def _store_tokens(self, payload: dict) -> None:
        access_token = payload.get("access_token")
        if not access_token:
            raise SupabaseAuthError(f"sign-in response had no access_token: {payload}")
        self._access_token = access_token
        self._refresh_token = payload.get("refresh_token", self._refresh_token)


class EdgeFunctionAudioGenerator:
    """Calls the deployed `cards` function for one clip of audio.

    Reuses the endpoint's existing "regenerate only this side's audio" path
    (supabase/functions/cards/index.ts, cardGeneration.ts cardTextMode's
    'none' branch) rather than a bare TTS endpoint, because there isn't one:
    the app never needed a way to synthesise a clip with no card behind it, and
    adding one would be a second, parallel entry point into the same policy to
    keep in sync. Sending `regenerate_parts: ["back_audio_path"]` alongside a
    `current_card` whose back_text already IS the note's text asks the
    function to speak exactly that text without generating or rewriting any
    card text - the same request src/network/supabaseApi.js's
    regenerateCardPart sends when a learner clicks the audio-only regenerate
    button on a card they already have.

    Like plusaudio/lib/generator.js's adapter, no reading is passed: a note
    this add-on did not write carries no romanisation of its own text, so for
    Japanese and Chinese the clip is validated by transcript alone.
    cardGeneration.ts logs that gap itself; it is not hidden here.
    """

    def __init__(self, project_url: str, session: SupabaseSession, timeout: float = 60.0) -> None:
        base = project_url.rstrip("/")
        self._cards_url = f"{base}/functions/v1/cards"
        self._storage_base = f"{base}/storage/v1/object/public/card-audio/"
        self._session = session
        self._timeout = timeout

    def ensure_authenticated(self) -> None:
        """Signs in now, so a bad email/password/URL fails once, up front,
        instead of as a wall of identical per-note failures once a run is
        already under way."""
        self._session.access_token()

    def fetch_audio(self, text: str, language: str) -> bytes:
        payload = self._call_cards(text, language)
        try:
            storage_path = payload["card"]["back_audio_path"]
        except (KeyError, TypeError) as error:
            raise GenerationError(f"cards function response had no back_audio_path: {payload}") from error
        if not storage_path:
            raise GenerationError(f"cards function response had no back_audio_path: {payload}")
        return self._download(storage_path)

    def _call_cards(self, text: str, language: str) -> dict:
        body = {
            # The front side is never regenerated or read; amgi's language
            # constants (src/constants/languages.js) always name a real known
            # language too, so 'en' is a placeholder, not a guess that could
            # silently steer TTS the way an unvalidated learning_language would.
            "known_language": "en",
            "learning_language": language,
            "regenerate_parts": ["back_audio_path"],
            "current_card": {"front_text": "", "back_text": text, "spoken_reading": ""},
        }
        headers = {"apikey": self._session.anon_key, "Authorization": f"Bearer {self._session.access_token()}"}
        try:
            return _post_json(self._cards_url, body, headers, self._timeout)
        except GenerationError as error:
            if "HTTP 401" not in str(error):
                raise
            headers["Authorization"] = f"Bearer {self._session.refresh()}"
            return _post_json(self._cards_url, body, headers, self._timeout)

    def _download(self, storage_path: str) -> bytes:
        # The card-audio bucket is public (supabase/migrations/20240323_reset.sql),
        # so this is a plain GET, the same shape as the public URL a browser
        # would use; the web app itself calls supabase-js's storage `.download()`
        # for this bucket, which resolves to this same public object URL.
        request = urllib.request.Request(self._storage_base + storage_path)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise GenerationError(f"could not download generated audio at {storage_path}: HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise GenerationError(f"could not download generated audio at {storage_path}: {error.reason}") from error
