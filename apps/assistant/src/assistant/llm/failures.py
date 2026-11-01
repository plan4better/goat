"""Provider failures and how they are reported (spec §4.6).

Members see a neutral sentence; admins see the reason (HTTP status, refused
endpoint) on the AI page and in the service log. What is guaranteed about keys:

- Keys are saved as printable ASCII without whitespace (``normalize_credentials``).
- A failure without an HTTP status never carries the exception's text, only its
  class name: transport libraries may echo request headers in their messages.
- The text of a failure with an HTTP status (the provider's error body) is
  masked with ``redact`` before it is cut to a short excerpt. ``redact`` masks
  each credential value of at least 4 characters, the encoded forms that
  ``secrets_of`` adds (repr, URL, JSON, base64) and, for values of 12
  characters or more, any run of 8 or more of their characters.

Not guaranteed: a fragment shorter than 8 characters of a credential, a value
shorter than 4 characters, or a transformation of a key that is not listed
(for example a hash).
"""

import base64
import json
import traceback
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote

from google.auth.exceptions import RefreshError, TransportError
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError

from assistant.events import RunErrorCode
from assistant.llm.endpoints import BlockedEndpoint
from assistant.llm.providers import Target

FailureKind = Literal["rejected", "blocked", "unreachable", "busy", "error"]

_DETAIL_CHARS = 300
#: Text is cut to this length before masking, so a very large error body does
#: not make the scan slow. It is far beyond the excerpt, so a key that straddles
#: the cut is never part of the excerpt.
_SCAN_CHARS = 2000
_MIN_SECRET = 4
_RUN = 8
_LONG_SECRET = 12


@dataclass(frozen=True)
class ProviderFailure:
    kind: FailureKind
    status: int | None
    detail: str


def _as_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def _short(value: object, secrets: Iterable[str]) -> str:
    """An excerpt of ``value`` with the secrets masked first, so no prefix of a
    key can remain at the cut."""
    return redact(_as_text(value)[:_SCAN_CHARS], secrets)[:_DETAIL_CHARS]


def _chain(exc: BaseException) -> list[BaseException]:
    links: list[BaseException] = []
    current: BaseException | None = exc
    while current is not None and current not in links and len(links) < 12:
        links.append(current)
        current = current.__cause__ or current.__context__
    return links


def classify_failure(
    exc: BaseException, secrets: Iterable[str] = (), *, vertex: bool = False
) -> ProviderFailure | None:
    """What went wrong talking to the provider; None for anything else (a
    tool error, a usage limit, a bug), which the caller handles itself.

    Only a Pydantic AI ``ModelAPIError`` at the top counts: the model classes
    wrap every provider transport error in it, so a bare httpx or httpcore
    error can only come from elsewhere (a tool's own HTTP call) and must not
    trigger a fallback or mark the connection. The exception is Vertex AI
    (``vertex=True``): its token exchange runs outside the model class, so a
    google-auth ``RefreshError`` (rejected credentials) or ``TransportError``
    (unreachable) arrives bare."""
    links = _chain(exc)
    if vertex:
        for link in links:
            if isinstance(link, RefreshError):
                return ProviderFailure("rejected", None, "")
            if isinstance(link, TransportError):
                return ProviderFailure("unreachable", None, type(link).__name__)
    if not isinstance(exc, ModelAPIError):
        return None
    known = list(secrets)
    for link in links:
        if isinstance(link, BlockedEndpoint):
            return ProviderFailure("blocked", None, _short(link, known))
    for link in links:
        if isinstance(link, ModelHTTPError):
            status = link.status_code
            kind: FailureKind
            if status in (401, 403):
                kind = "rejected"
            elif status == 429:
                kind = "busy"
            elif status >= 500:
                kind = "unreachable"
            else:
                kind = "error"
            return ProviderFailure(
                kind,
                status,
                _short(link.body if link.body is not None else link, known),
            )
    # No status: only the class name, never the exception text.
    return ProviderFailure("unreachable", None, type(links[-1]).__name__)


def _variants(secret: str) -> set[str]:
    raw = secret.encode()
    return {
        secret,
        repr(secret)[1:-1],
        quote(secret, safe=""),
        json.dumps(secret)[1:-1],
        base64.b64encode(raw).decode(),
        base64.urlsafe_b64encode(raw).decode(),
    }


def secrets_of(target: Target) -> list[str]:
    """Every credential value of a connection plus the encoded forms an error
    text may carry. For Vertex AI the key file is taken apart: its private key,
    each line of the key body, the key id and the service account address."""
    values: list[str] = []
    for name, value in target.credentials.items():
        if target.provider == "vertex" and name == "service_account_json":
            try:
                info = json.loads(value)
            except ValueError:
                info = None
            if isinstance(info, dict):
                key = info.get("private_key")
                if isinstance(key, str):
                    values.append(key)
                    values.extend(
                        line.strip()
                        for line in key.splitlines()
                        if line.strip() and not line.startswith("-----")
                    )
                values.extend(
                    item
                    for item in (info.get("private_key_id"), info.get("client_email"))
                    if isinstance(item, str)
                )
                continue
        values.append(value)
    found: set[str] = set()
    for value in values:
        if value:
            found |= _variants(value)
    return sorted(found)


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every secret that occurs in ``text`` with "…", longest first,
    then every run of 8 or more characters taken from a secret of 12 or more
    characters. A provider's error body may echo the key it rejected, whole or
    in part."""
    known = {secret for secret in secrets if len(secret) >= _MIN_SECRET}
    for secret in sorted(known, key=len, reverse=True):
        text = text.replace(secret, "…")
    runs = {
        secret[start : start + _RUN]
        for secret in known
        if len(secret) >= _LONG_SECRET
        for start in range(len(secret) - _RUN + 1)
    }
    if not runs:
        return text
    spans: list[list[int]] = []
    for start in range(len(text) - _RUN + 1):
        if text[start : start + _RUN] in runs:
            if spans and start <= spans[-1][1]:
                spans[-1][1] = start + _RUN
            else:
                spans.append([start, start + _RUN])
    pieces: list[str] = []
    last = 0
    for begin, end in spans:
        pieces.append(text[last:begin])
        pieces.append("…")
        last = end
    pieces.append(text[last:])
    return "".join(pieces)


def log_text(exc: BaseException, secrets: Iterable[str]) -> str:
    """The traceback of ``exc`` with credentials masked: SDK and transport
    messages can echo request headers."""
    return redact("".join(traceback.format_exception(exc)), secrets)


def user_message(failure: ProviderFailure, *, own: bool) -> str:
    if failure.kind == "rejected":
        return "AI is unavailable right now."
    who = "Your organization's AI provider" if own else "GOAT AI"
    if failure.kind in ("blocked", "unreachable"):
        return f"{who} isn't reachable right now."
    if failure.kind == "busy":
        return f"{who} is busy. Try again in a moment."
    return f"{who} returned an error."


_CODES: dict[tuple[FailureKind, bool], RunErrorCode] = {
    ("rejected", True): "ai_unavailable",
    ("rejected", False): "ai_unavailable",
    ("blocked", True): "provider_unreachable",
    ("blocked", False): "goat_ai_unreachable",
    ("unreachable", True): "provider_unreachable",
    ("unreachable", False): "goat_ai_unreachable",
    ("busy", True): "provider_busy",
    ("busy", False): "goat_ai_busy",
    ("error", True): "provider_error",
    ("error", False): "goat_ai_error",
}


def failure_code(failure: ProviderFailure, *, own: bool) -> RunErrorCode:
    """The code the web app translates; one per ``user_message`` text."""
    return _CODES[(failure.kind, own)]


def admin_message(failure: ProviderFailure) -> str:
    if failure.kind == "rejected":
        if failure.status is None:
            return "The provider rejected the credentials."
        return f"The provider rejected the credentials (HTTP {failure.status})."
    if failure.kind == "blocked":
        return f"The endpoint is not allowed: {failure.detail}"
    if failure.kind == "busy":
        return "The provider is rate limiting requests (HTTP 429)."
    if failure.kind == "unreachable":
        if failure.status is not None:
            return f"The provider is not available (HTTP {failure.status})."
        return f"The provider could not be reached ({failure.detail})."
    return f"The provider returned HTTP {failure.status}: {failure.detail}"
