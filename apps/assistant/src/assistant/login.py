"""The user's login for a detached run (spec §6.5).

A run can outlive the access token the browser sent with it. The login is held
in memory for the run only: never in the database, events, logs or traces, and
``repr`` of every holder names the user only.

- Refresh (v1): the browser hands over the user's refresh token with the run
  request, the precedent print jobs set. It was issued to the web app's
  Keycloak client, and only that client may refresh it, so the assistant uses
  ``KEYCLOAK_CLIENT_ID`` / ``KEYCLOAK_CLIENT_SECRET``, as the print worker does.
  This needs the realm not to revoke refresh tokens on reuse (Keycloak's
  "Revoke Refresh Token" off, its default). With it on, a refresh invalidates
  the token it used, in both directions: the assistant's refresh would
  invalidate the copy the web app still holds, and the web app's refresh would
  invalidate the assistant's copy. The print worker has the same requirement.
- Token exchange (``ASSISTANT_TOKEN_EXCHANGE_ENABLED``): at run start the
  assistant's own confidential client exchanges the user's access token for a
  delegated token with a refresh token of its own (RFC 8693, Keycloak standard
  token exchange, Keycloak >= 26.2). Keycloak requires two things of the
  setup: the subject token's ``aud`` claim must contain the requesting client
  (an audience mapper on the web client), and the assistant's client needs the
  option "Allow refresh token in Standard Token Exchange". Without that option
  Keycloak rejects the exchange (HTTP 400), so every run fails at start; it
  does not degrade to a run without a refresh token. Off until the Keycloak
  upgrade of §15.

Without a refresh token, or with ``AUTH=False``, a run uses the access token
as it is, which is enough for short runs. Every refreshed token must belong to
the run's user, so a swapped refresh token cannot change whose permissions a
run has.
"""

import asyncio
import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

import httpx

from assistant.auth import Principal
from assistant.config import AssistantSettings

#: Refresh this long before the access token expires, so a tool call never
#: leaves with a token that lapses on its way.
REFRESH_MARGIN_SECONDS = 60

TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token"

Clock = Callable[[], float]


class LoginFailed(Exception):  # noqa: N818
    """The run's login could not be prepared or renewed."""


class Login(Protocol):
    async def bearer(self) -> str | None: ...

    def secrets(self) -> list[str]:
        """The token values held right now, for masking them in logs and errors."""
        ...


@dataclass(frozen=True)
class StaticLogin:
    """A fixed token (or none, with AUTH=False)."""

    token: str | None = field(default=None, repr=False)

    async def bearer(self) -> str | None:
        return self.token

    def secrets(self) -> list[str]:
        return [self.token] if self.token else []


def token_claims(token: str) -> dict[str, Any]:
    """The payload of a JWT, unverified. Only for tokens verified on the way in
    (``assistant.auth``) or received straight from Keycloak."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError):
        # No chaining: a decoding error quotes the token text it failed on.
        raise LoginFailed("The token is not a JWT.") from None
    if not isinstance(claims, dict):
        raise LoginFailed("The token is not a JWT.")
    return claims


def _client_form(client_id: str, client_secret: str, **fields: str) -> dict[str, str]:
    """A token request's form. The secret is sent only when there is one: a
    public client (no secret) must not send an empty ``client_secret``."""
    form = {"client_id": client_id, **fields}
    if client_secret:
        form["client_secret"] = client_secret
    return form


def token_url(settings: AssistantSettings) -> str:
    base = settings.keycloak_server_url.rstrip("/")
    return f"{base}/realms/{settings.realm_name}/protocol/openid-connect/token"


async def _token_request(
    http: httpx.AsyncClient, url: str, form: dict[str, str]
) -> dict[str, Any]:
    try:
        response = await http.post(url, data=form)
    except httpx.HTTPError:
        # No chaining: the httpx error carries the request, whose body holds the
        # refresh or subject token and the client secret.
        raise LoginFailed("Keycloak is not reachable.") from None
    if response.status_code != 200:
        raise LoginFailed(
            f"Keycloak refused the token request (HTTP {response.status_code})."
        )
    try:
        body = response.json()
    except ValueError:
        raise LoginFailed("Keycloak sent an answer that is not JSON.") from None
    if not isinstance(body, dict):
        raise LoginFailed("Keycloak sent an unexpected answer.")
    return body


class RefreshingLogin:
    """An access token that is renewed with a refresh token before it expires.

    Tool calls run concurrently; the lock makes one of them refresh and the
    others wait for its result instead of spending the refresh token twice.
    A failed refresh is remembered: later calls raise the same failure at once,
    because the refresh token may be spent and Keycloak would only refuse again.
    """

    def __init__(
        self,
        *,
        http: httpx.AsyncClient,
        token_url: str,
        client_id: str,
        client_secret: str,
        user_id: UUID,
        access_token: str,
        refresh_token: str | None,
        clock: Clock = time.time,
    ) -> None:
        self._http = http
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._user_id = user_id
        self._clock = clock
        self._lock = asyncio.Lock()
        self._access = ""
        self._expires_at = 0.0
        self._refresh_token = refresh_token
        self._failure: LoginFailed | None = None
        self._accept({"access_token": access_token})

    def __repr__(self) -> str:
        return f"RefreshingLogin(user_id={self._user_id})"

    async def bearer(self) -> str:
        async with self._lock:
            if self._failure is not None:
                raise self._failure
            if self._expires_at - self._clock() > REFRESH_MARGIN_SECONDS:
                return self._access
            if not self._refresh_token:
                # Nothing to renew with: the services decide whether the token still counts.
                return self._access
            try:
                tokens = await _token_request(
                    self._http,
                    self._token_url,
                    _client_form(
                        self._client_id,
                        self._client_secret,
                        grant_type="refresh_token",
                        refresh_token=self._refresh_token,
                    ),
                )
                self._accept(tokens)
            except LoginFailed as failure:
                self._failure = failure
                raise
            return self._access

    def secrets(self) -> list[str]:
        return [t for t in (self._access, self._refresh_token) if t]

    def _accept(self, tokens: dict[str, Any]) -> None:
        access = tokens.get("access_token")
        if not isinstance(access, str) or not access:
            raise LoginFailed("Keycloak sent no access token.")
        claims = token_claims(access)
        if str(claims.get("sub")) != str(self._user_id):
            raise LoginFailed("The token belongs to another user.")
        try:
            expires_at = float(claims.get("exp") or 0)
        except (TypeError, ValueError):
            raise LoginFailed("The token has no valid expiry.") from None
        self._access = access
        self._expires_at = expires_at
        rotated = tokens.get("refresh_token")
        if isinstance(rotated, str) and rotated:
            self._refresh_token = rotated


async def make_login(
    settings: AssistantSettings,
    principal: Principal,
    refresh_token: str | None,
    http: httpx.AsyncClient | None,
    *,
    clock: Clock = time.time,
) -> Login:
    """The login a run uses, decided once at run start."""
    if not settings.auth or principal.token is None:
        return StaticLogin(principal.token)
    if settings.token_exchange_enabled:
        if http is None:
            raise LoginFailed("Keycloak is not configured.")
        tokens = await _token_request(
            http,
            token_url(settings),
            _client_form(
                settings.keycloak_client_id,
                settings.keycloak_client_secret.get_secret_value(),
                grant_type=TOKEN_EXCHANGE_GRANT,
                subject_token=principal.token,
                subject_token_type=ACCESS_TOKEN_TYPE,
                requested_token_type=REFRESH_TOKEN_TYPE,
            ),
        )
        access = tokens.get("access_token")
        if not isinstance(access, str):
            raise LoginFailed("Keycloak sent no access token.")
        rotated = tokens.get("refresh_token")
        return RefreshingLogin(
            http=http,
            token_url=token_url(settings),
            client_id=settings.keycloak_client_id,
            client_secret=settings.keycloak_client_secret.get_secret_value(),
            user_id=principal.user_id,
            access_token=access,
            refresh_token=rotated if isinstance(rotated, str) else None,
            clock=clock,
        )
    if refresh_token and settings.web_client_id and http is not None:
        return RefreshingLogin(
            http=http,
            token_url=token_url(settings),
            client_id=settings.web_client_id,
            client_secret=settings.web_client_secret.get_secret_value(),
            user_id=principal.user_id,
            access_token=principal.token,
            refresh_token=refresh_token,
            clock=clock,
        )
    return StaticLogin(principal.token)
