# Authentication and origin-checking for the local HTTP bridge - deliberately
# split out from bridge_server.py so it can be unit tested as plain data in,
# plain data out, with no socket, no thread and no Qt anywhere near it.
#
# The threat model this defends against (see README.md, "Security model and
# threat model", for the long version): any webpage the user's browser has
# open can point `fetch()` at 127.0.0.1 and any port on it, including this
# one, whether or not the page has anything to do with amgi. Two things a
# browser does NOT do that would otherwise save us:
#
#   - CORS does not stop the request from being sent or executed. It only
#     stops the page's own JavaScript from reading the *response* - by the
#     time the browser enforces that, this server has already run whatever
#     the request asked for. A same-origin-only Access-Control-Allow-Origin
#     header is a "does the caller get to read the answer" control, not a
#     "should this request run at all" one.
#   - A "simple" cross-origin request (GET, or POST with a body type of
#     text/plain / form-urlencoded / multipart, and no custom headers) skips
#     the CORS preflight (OPTIONS) entirely - it is just sent. Relying on
#     "the browser will preflight it" to gate anything is therefore not a
#     defence by itself.
#
# So every request - simple or not, preflighted or not - is checked here
# before bridge_server.py does anything else with it:
#
#   1. Origin, if the request carries one, must be in the configured
#      allowlist. A cross-origin fetch() always sets Origin (that is what
#      makes it cross-origin in the first place), so a hostile page's
#      request always has one to check. A request with no Origin header at
#      all (a same-machine CLI tool, curl, a Node script) is not rejected on
#      Origin grounds alone - Origin is a browser-only signal, not a general
#      identity check - but it still needs the token below.
#   2. The shared-secret token, generated on first run and shown to the user
#      so they can paste it into the UI's own settings (see __init__.py),
#      must be present and match exactly. A custom header is what forces a
#      real cross-origin browser request into a preflight in the first
#      place, so requiring one here also closes the "simple request, no
#      preflight" gap: a hostile page's fetch() cannot add this header
#      without triggering a preflight, and a request that skips the header
#      to skip the preflight fails this check instead.
#
# Both checks run on every non-OPTIONS request, in that order, and a
# preflight OPTIONS request is answered from the Origin check alone (it
# carries no token by construction - see bridge_server.py).

from __future__ import annotations

import dataclasses
import hmac
from typing import Mapping, Optional

TOKEN_HEADER = "X-Amgi-Bridge-Token"


@dataclasses.dataclass(frozen=True)
class AuthResult:
    ok: bool
    status: int = 200
    reason: str = ""
    # None means "no Origin header was sent"; distinct from "" (an Origin
    # header with an empty value, which browsers do send for some sandboxed/
    # opaque-origin requests, and which never matches a real allowlist entry).
    origin: Optional[str] = None


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    # Header names are case-insensitive; http.server hands us a
    # case-preserving Mapping (email.message.Message), so look up
    # case-insensitively rather than assuming a canonical spelling.
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return value
    return None


def is_allowed_origin(origin: Optional[str], allowed_origins: frozenset[str]) -> bool:
    """No Origin header at all is not an origin failure - see the module
    docstring. An Origin header present but not in the allowlist always is,
    including the empty-string opaque-origin case."""
    if origin is None:
        return True
    return origin in allowed_origins


def check_preflight(headers: Mapping[str, str], allowed_origins: frozenset[str]) -> AuthResult:
    """A CORS preflight (OPTIONS) never carries the token - by the fetch
    spec, a preflight cannot include the very headers it exists to ask
    permission for - so it is judged on Origin alone. Answering it does not
    grant anything: the actual request still has to pass check_request."""
    origin = _header(headers, "Origin")
    if origin is not None and origin not in allowed_origins:
        return AuthResult(ok=False, status=403, reason="origin not allowed", origin=origin)
    return AuthResult(ok=True, origin=origin)


def check_request(headers: Mapping[str, str], *, token: str, allowed_origins: frozenset[str]) -> AuthResult:
    origin = _header(headers, "Origin")
    if origin is not None and origin not in allowed_origins:
        return AuthResult(ok=False, status=403, reason="origin not allowed", origin=origin)

    supplied = _header(headers, TOKEN_HEADER)
    if supplied is None:
        return AuthResult(ok=False, status=401, reason="missing token", origin=origin)
    if not hmac.compare_digest(supplied, token):
        return AuthResult(ok=False, status=401, reason="invalid token", origin=origin)

    return AuthResult(ok=True, origin=origin)
