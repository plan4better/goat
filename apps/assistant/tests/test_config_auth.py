import threading
from uuid import UUID

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient
from jose import JOSEError

from assistant import auth
from assistant.auth import Principal, get_principal
from assistant.config import AssistantSettings
from assistant.db import Database


def test_defaults_match_the_spec(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "false")
    settings = AssistantSettings()
    assert settings.run_max_tool_calls == 40
    assert settings.run_max_tokens == 200_000
    assert settings.run_max_seconds == 900
    assert settings.user_max_concurrent_runs == 3
    assert settings.db_schema == "assistant"


def test_root_path_is_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("ROOT_PATH", "assistant/")
    assert AssistantSettings().root_path == "/assistant"


def test_auth_on_without_keycloak_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.delenv("KEYCLOAK_SERVER_URL", raising=False)
    with pytest.raises(ValueError, match="KEYCLOAK_SERVER_URL"):
        AssistantSettings()


def test_allowed_clients_without_the_web_client_are_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "https://auth.example.org")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "goat")
    monkeypatch.setenv("AUTH_ALLOWED_CLIENTS", "other-app")
    with pytest.raises(ValueError, match="AUTH_ALLOWED_CLIENTS"):
        AssistantSettings()


def test_tokens_are_checked_against_the_allowed_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "https://auth.example.org")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "goat")
    monkeypatch.setenv("AUTH_ALLOWED_CLIENTS", "goat, goat-scripts")
    built: list[dict[str, object]] = []

    class FakeKeycloak:
        def __init__(self, **kwargs: object) -> None:
            built.append(kwargs)

        def decode_token(self, token: str) -> dict[str, str]:
            return {"sub": "x"}

    monkeypatch.setattr(auth, "KeycloakAuth", FakeKeycloak)
    monkeypatch.setattr(auth, "_keycloak_cache", {})
    auth.validate_token(AssistantSettings(), "token")
    assert built[0]["allowed_clients"] == "goat, goat-scripts"


@pytest.mark.parametrize(
    ("value", "expected"), [("true", True), (" On ", True), ("", False), ("no", False)]
)
def test_transaction_pooler_is_parsed_like_the_other_services(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
) -> None:
    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("POSTGRES_TRANSACTION_POOLER", value)
    assert AssistantSettings().postgres_transaction_pooler is expected


async def test_behind_a_transaction_pooler_the_pool_prepares_no_statements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("POSTGRES_TRANSACTION_POOLER", "true")
    seen: dict[str, object] = {}

    async def create_pool(**kwargs: object) -> object:
        seen.update(kwargs)
        return object()

    monkeypatch.setattr("assistant.db.asyncpg.create_pool", create_pool)
    await Database(AssistantSettings()).connect()
    assert seen["statement_cache_size"] == 0
    assert seen["server_settings"] == {"application_name": "goat-assistant"}


def _app(settings: AssistantSettings) -> FastAPI:
    app = FastAPI()
    app.state.settings = settings

    @app.get("/me")
    async def me(principal: Principal = Depends(get_principal)) -> dict[str, str]:
        return {"user_id": str(principal.user_id)}

    return app


async def test_auth_off_uses_the_default_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "false")
    app = _app(AssistantSettings())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        response = await client.get("/me")
    assert response.json() == {"user_id": "744e4fd1-685c-495c-8b02-efebce875359"}


async def test_auth_on_requires_a_valid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "http://keycloak.invalid")
    app = _app(AssistantSettings())

    def fake_validate(settings: AssistantSettings, token: str) -> dict[str, str]:
        if token != "good":
            raise JOSEError("bad token")
        return {"sub": "00000000-0000-0000-0000-000000000001"}

    monkeypatch.setattr(auth, "validate_token", fake_validate)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        assert (await client.get("/me")).status_code == 401
        assert (
            await client.get("/me", headers={"Authorization": "Bearer bad"})
        ).status_code == 401
        ok = await client.get("/me", headers={"Authorization": "Bearer good"})
    assert ok.json() == {"user_id": str(UUID(int=1))}


async def test_non_uuid_subject_is_401(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "http://keycloak.invalid")
    app = _app(AssistantSettings())
    monkeypatch.setattr(
        auth, "validate_token", lambda settings, token: {"sub": "not-a-uuid"}
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        response = await client.get("/me", headers={"Authorization": "Bearer t"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Token subject is not a UUID"


async def test_token_validation_runs_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "true")
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "http://keycloak.invalid")
    app = _app(AssistantSettings())
    threads: list[int] = []

    def fake_validate(settings: AssistantSettings, token: str) -> dict[str, str]:
        threads.append(threading.get_ident())
        return {"sub": str(UUID(int=1))}

    monkeypatch.setattr(auth, "validate_token", fake_validate)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        response = await client.get("/me", headers={"Authorization": "Bearer t"})
    assert response.status_code == 200
    assert threads and threads[0] != threading.get_ident()


def test_a_principal_repr_holds_no_token() -> None:
    principal = Principal(user_id=UUID(int=1), token="eyJ-secret-bearer")
    assert "eyJ-secret-bearer" not in repr(principal)
    assert principal.token == "eyJ-secret-bearer"
