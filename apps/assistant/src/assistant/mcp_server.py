"""The MCP endpoint (spec §9.1), moved from the catalog service.

Publishes the tools flagged ``mcp`` (the four read-only catalog tools) through
the same ``execute`` path the in-app agent uses. Streamable HTTP, stateless and
with JSON responses, so any replica answers any request. SDK v2 answers the
2026-07-28 revision and 2025-era clients that start with ``initialize``.

Auth is the bearer check the catalog's /mcp had: with AUTH=True every request
needs a valid GOAT realm token, which the tools forward to the services. That is
acceptable only while the endpoint is internal (spec §9.1); the external MCP of
§9.2 replaces it with audience-bound tokens and token exchange.
"""

import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pydantic_ai.exceptions import ToolFailed
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from assistant.auth import InvalidToken, Principal, principal_from_token
from assistant.config import AssistantSettings
from assistant.context import NO_PAGE
from assistant.login import StaticLogin
from assistant.services import AppServices
from assistant.tools.registry import MCP_TOOLS
from assistant.tools.runtime import InputInvalid, ToolEnv, client_secrets, execute

MCP_PATH = "/mcp"
SERVER_NAME = "goat-assistant"
_PRINCIPAL = "goat.principal"


def build_transport_security(allowed_hosts: list[str]) -> TransportSecuritySettings:
    """The transport's Host/Origin validation from ``ASSISTANT_MCP_ALLOWED_HOSTS``.

    The SDK's own default (``host="127.0.0.1"``) enables DNS-rebinding
    protection scoped to localhost only, which answers 421 to every request
    addressed to a real hostname. A ``"*"`` entry (the default, also next to
    other entries) switches the check off, for a deployment whose ingress
    hostname is not known yet; any other list enables it for exactly those Host
    values. ``"host:*"`` matches that host with any port but not the bare host,
    so list both (``goat.example.com`` and ``goat.example.com:*``) when clients
    may send either.
    Once the hosts are narrowed, no Origin is allowed: a request that carries an
    Origin header (a browser) is refused with 403, and only a request without
    one, the normal case for a non-browser MCP client, passes.
    """
    # Empty means the default, as in the settings: never "no host allowed".
    if not allowed_hosts or "*" in allowed_hosts:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=[],
    )


class BearerAuthASGIMiddleware:
    """The bearer-token gate for the MCP transport, which is a raw ASGI app that
    FastAPI's dependencies cannot reach. Uses ``principal_from_token``, as the API
    does, so the two gates cannot drift apart, and leaves the caller in the scope
    for the tools."""

    def __init__(self, app: ASGIApp, settings: AssistantSettings) -> None:
        self._app = app
        self._settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        if not self._settings.auth:
            scope[_PRINCIPAL] = Principal(
                user_id=UUID(self._settings.default_user_id), token=None
            )
            await self._app(scope, receive, send)
            return
        header = Headers(scope=scope).get("authorization") or ""
        token = header[len("Bearer ") :] if header.startswith("Bearer ") else None
        detail: str | None = None
        if not token:
            detail = "Missing authorization token"
        else:
            try:
                scope[_PRINCIPAL] = await principal_from_token(self._settings, token)
            except InvalidToken as exc:
                detail = str(exc)
        if detail is not None:
            response = JSONResponse(
                status_code=401,
                content={"detail": detail},
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)


def _error(message: str) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=message)], is_error=True
    )


def _principal(ctx: Any) -> Principal | None:
    scope = getattr(getattr(ctx, "request", None), "scope", None)
    value = scope.get(_PRINCIPAL) if isinstance(scope, dict) else None
    return value if isinstance(value, Principal) else None


def build_mcp(
    settings: AssistantSettings, get_services: Callable[[], AppServices]
) -> tuple[ASGIApp, StreamableHTTPSessionManager]:
    """A fresh server and session manager per app (a manager runs only once)."""

    async def list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=spec.wire_name,
                    description=spec.description,
                    input_schema=spec.json_schema(),
                    annotations=types.ToolAnnotations(
                        read_only_hint=True,
                        destructive_hint=False,
                        open_world_hint=False,
                    ),
                )
                for spec in MCP_TOOLS
            ]
        )

    async def call_tool(
        ctx: Any, params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        spec = next((spec for spec in MCP_TOOLS if spec.wire_name == params.name), None)
        if spec is None:
            return _error(f"Unknown tool {params.name!r}.")
        principal = _principal(ctx)
        services = get_services()
        if principal is None or services.tools is None:
            return _error("The assistant's tools are not available.")
        env = ToolEnv(
            services=services.tools,
            login=StaticLogin(principal.token),
            user_id=principal.user_id,
            # MCP tools return no data values (a registry test checks it);
            # Restricted is the safe default should one ever be flagged.
            data_policy="restricted",
            page=NO_PAGE,
            repo=services.repo,
            extra_secrets=client_secrets(settings),
        )
        try:
            payload = await execute(spec, env, params.arguments or {})
        except (InputInvalid, ToolFailed) as exc:
            # The model-facing text only, already masked by ``execute``; never
            # the exception chain, whose HTTP request carries the bearer.
            return _error(exc.message)
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text", text=json.dumps(payload, ensure_ascii=False)
                )
            ],
            structured_content=payload,
        )

    server: Server[Any] = Server(
        SERVER_NAME, on_list_tools=list_tools, on_call_tool=call_tool
    )
    transport = server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        transport_security=build_transport_security(settings.mcp_allowed_hosts),
    )
    return BearerAuthASGIMiddleware(transport, settings), server.session_manager
