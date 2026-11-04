"""User fields on logs, child spans and access logs (the other services use
goatobs' ``build_auth_context_middleware``).

A pure ASGI middleware rather than goatobs' ``app.middleware("http")``
closure: that one runs on Starlette's ``BaseHTTPMiddleware``, which wraps
every response body, and the run streams are long-lived SSE responses whose
disconnects must reach the endpoint unchanged.
"""

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

from goatobs import set_user_context
from starlette.types import ASGIApp, Receive, Scope, Send

from assistant.auth import validate_token
from assistant.config import AssistantSettings

logger = logging.getLogger(__name__)


def _bearer(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"authorization":
            text = value.decode("latin-1")
            if text.lower().startswith("bearer "):
                return text[7:].strip() or None
    return None


def _realm(issuer: str) -> str:
    parts = urlparse(issuer).path.rstrip("/").split("/")
    if "realms" in parts:
        index = parts.index("realms")
        if index + 1 < len(parts):
            return parts[index + 1]
    return ""


class AuthContextMiddleware:
    def __init__(self, app: ASGIApp, settings: AssistantSettings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self.settings.auth:
            token = _bearer(scope)
            if token is not None:
                await self._bind(token)
        await self.app(scope, receive, send)

    async def _bind(self, token: str) -> None:
        try:
            # The first verification may fetch the realm key over the network.
            payload: dict[str, Any] = await asyncio.to_thread(
                validate_token, self.settings, token
            )
        except Exception:
            # Anything a bad token or an unreachable Keycloak raises: the
            # route's own auth answers 401 (or 503); this middleware only
            # labels logs and must never turn a request into a 500.
            logger.debug("No user context for this request", exc_info=True)
            return
        user_id = payload.get("sub")
        if not user_id:
            return
        # set, not bind: the value lives until the request task ends, so the
        # access log written after the response still carries it.
        set_user_context(
            user_id=str(user_id),
            email=str(payload.get("email", "")),
            realm=_realm(str(payload.get("iss", ""))),
        )
