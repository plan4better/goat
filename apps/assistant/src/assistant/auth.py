"""Who is calling: the ``sub`` of a Keycloak token, or the default identity with ``AUTH=False``.

``validate_token`` is the seam tests replace (constructing ``KeycloakAuth`` with
signature verification fetches the realm key over the network).
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from goatlib.auth import JOSEError, KeycloakAuth

from assistant.config import AssistantSettings

_keycloak_cache: dict[tuple[str, str, str], KeycloakAuth] = {}


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    #: The caller's bearer token, forwarded by tools (plan 3); None with AUTH=False.
    #: Left out of ``repr``, so a logged principal never shows it.
    token: str | None = field(repr=False)


def validate_token(settings: AssistantSettings, token: str) -> dict[str, Any]:
    key = (settings.keycloak_server_url, settings.realm_name, settings.allowed_clients)
    keycloak = _keycloak_cache.get(key)
    if keycloak is None:
        keycloak = KeycloakAuth(
            keycloak_url=settings.keycloak_server_url,
            realm=settings.realm_name,
            verify_signature=True,
            allowed_clients=settings.allowed_clients,
        )
        _keycloak_cache[key] = keycloak
    payload: dict[str, Any] = keycloak.decode_token(token)
    return payload


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


class InvalidToken(Exception):  # noqa: N818
    """A bearer token that does not identify a user; the message is the 401 detail."""


async def principal_from_token(settings: AssistantSettings, token: str) -> Principal:
    """The caller a bearer token names. Shared by the API (``get_principal``) and
    the MCP endpoint, so both gates check the same things."""
    try:
        # Verifying a token can fetch the realm key over the network on first use;
        # a worker thread keeps that from blocking the event loop.
        payload = await asyncio.to_thread(validate_token, settings, token)
    except JOSEError as exc:
        raise InvalidToken(f"Invalid token: {exc}") from exc
    sub = payload.get("sub")
    if not sub:
        raise InvalidToken("Token has no subject")
    try:
        user_id = UUID(str(sub))
    except ValueError as exc:
        raise InvalidToken("Token subject is not a UUID") from exc
    return Principal(user_id=user_id, token=token)


async def get_principal(request: Request) -> Principal:
    settings: AssistantSettings = request.app.state.settings
    if not settings.auth:
        return Principal(user_id=UUID(settings.default_user_id), token=None)
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise _unauthorized("Missing authorization token")
    token = header[len("Bearer ") :]
    try:
        return await principal_from_token(settings, token)
    except InvalidToken as exc:
        raise _unauthorized(str(exc)) from exc
