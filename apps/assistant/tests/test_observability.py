"""User fields on logs and spans (spec §3, ledger Task 3): a pure ASGI
middleware, so SSE responses pass through untouched."""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from goatlib.auth import JOSEError
from goatobs import get_user_context
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from assistant import observability
from assistant.config import AssistantSettings
from assistant.observability import AuthContextMiddleware

PAYLOAD = {
    "sub": "00000000-0000-0000-0000-000000000001",
    "email": "ada@example.org",
    "iss": "https://auth.example.org/realms/p4b",
}


async def _whoami(request: Request) -> JSONResponse:
    return JSONResponse(get_user_context())


async def _stream(request: Request) -> StreamingResponse:
    async def chunks() -> AsyncIterator[bytes]:
        yield b"data: one\n\n"
        yield b"data: two\n\n"

    return StreamingResponse(chunks(), media_type="text/event-stream")


def _client(settings: AssistantSettings) -> AsyncClient:
    inner = Starlette(routes=[Route("/whoami", _whoami), Route("/stream", _stream)])
    app = AuthContextMiddleware(inner, settings=settings)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://a.test")


@pytest.fixture
def auth_on(settings: AssistantSettings) -> AssistantSettings:
    return settings.model_copy(
        update={"auth": True, "keycloak_server_url": "https://auth.example.org"}
    )


async def test_binds_the_tokens_user(
    auth_on: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        observability, "validate_token", lambda settings, token: PAYLOAD
    )
    async with _client(auth_on) as client:
        response = await client.get("/whoami", headers={"Authorization": "Bearer t"})
    assert response.json() == {
        "user_id": PAYLOAD["sub"],
        "email": "ada@example.org",
        "realm": "p4b",
    }


async def test_invalid_token_passes_through_without_a_user(
    auth_on: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(settings: AssistantSettings, token: str) -> dict[str, Any]:
        raise JOSEError("bad signature")

    monkeypatch.setattr(observability, "validate_token", refuse)
    async with _client(auth_on) as client:
        response = await client.get("/whoami", headers={"Authorization": "Bearer t"})
    assert response.status_code == 200
    assert response.json() == {}


async def test_an_unexpected_decode_error_never_breaks_the_request(
    auth_on: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode(settings: AssistantSettings, token: str) -> dict[str, Any]:
        raise RuntimeError("keycloak unreachable")

    monkeypatch.setattr(observability, "validate_token", explode)
    async with _client(auth_on) as client:
        response = await client.get("/whoami", headers={"Authorization": "Bearer t"})
    assert response.status_code == 200
    assert response.json() == {}


async def test_auth_off_never_decodes(
    settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected(settings: AssistantSettings, token: str) -> dict[str, Any]:
        raise AssertionError("decoded with AUTH=False")

    monkeypatch.setattr(observability, "validate_token", unexpected)
    async with _client(settings) as client:
        response = await client.get("/whoami", headers={"Authorization": "Bearer t"})
    assert response.json() == {}


async def test_streams_pass_through_unchanged(
    auth_on: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        observability, "validate_token", lambda settings, token: PAYLOAD
    )
    async with _client(auth_on) as client:
        async with client.stream(
            "GET", "/stream", headers={"Authorization": "Bearer t"}
        ) as response:
            body = b"".join([chunk async for chunk in response.aiter_bytes()])
    assert response.headers["content-type"].startswith("text/event-stream")
    assert body == b"data: one\n\ndata: two\n\n"
