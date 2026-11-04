"""Keeping a detached run signed in (spec §6.5)."""

import asyncio
import base64
import json
from typing import Any
from urllib.parse import parse_qs
from uuid import UUID

import httpx
import pytest
from pydantic import SecretStr

from assistant.auth import Principal
from assistant.config import AssistantSettings
from assistant.login import (
    Login,
    LoginFailed,
    RefreshingLogin,
    StaticLogin,
    make_login,
    token_claims,
)

USER = UUID(int=1)
OTHER = UUID(int=2)
NOW = 1_000_000.0


def _jwt(sub: UUID, exp: float, marker: str = "") -> str:
    def part(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'none'})}.{part({'sub': str(sub), 'exp': exp, 'm': marker})}.sig"


class Keycloak:
    """Answers token requests; records their forms."""

    def __init__(self, *answers: httpx.Response | Exception) -> None:
        self.answers = list(answers)
        self.forms: list[dict[str, str]] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        # Yield once, so concurrent callers really overlap in the handler.
        await asyncio.sleep(0)
        self.forms.append(
            {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        )
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(self), base_url="http://keycloak.test"
        )


def _authed(settings: AssistantSettings, **changes: Any) -> AssistantSettings:
    return settings.model_copy(
        update={
            "auth": True,
            "keycloak_server_url": "http://keycloak.test",
            "realm_name": "goat",
            "web_client_id": "goat-web",
            # model_copy does not validate: secrets go in as SecretStr.
            "web_client_secret": SecretStr("web-secret"),
            **changes,
        }
    )


def test_token_claims_reads_an_unverified_payload() -> None:
    assert token_claims(_jwt(USER, NOW))["sub"] == str(USER)
    with pytest.raises(LoginFailed):
        token_claims("not-a-jwt")


async def test_without_auth_or_refresh_token_the_access_token_is_used(
    settings: AssistantSettings,
) -> None:
    assert (
        await (await make_login(settings, Principal(USER, None), "r", None)).bearer()
        is None
    )
    access = _jwt(USER, NOW + 3600)
    login = await make_login(
        _authed(settings), Principal(USER, access), None, Keycloak().client()
    )
    assert isinstance(login, StaticLogin)
    assert await login.bearer() == access
    assert access not in repr(login)


async def test_a_fresh_token_is_used_without_asking_keycloak(
    settings: AssistantSettings,
) -> None:
    keycloak = Keycloak()
    access = _jwt(USER, NOW + 600)
    login = await make_login(
        _authed(settings),
        Principal(USER, access),
        "refresh-1",
        keycloak.client(),
        clock=lambda: NOW,
    )
    assert isinstance(login, RefreshingLogin)
    assert await login.bearer() == access
    assert keycloak.forms == []
    assert "refresh-1" not in repr(login) and access not in repr(login)


async def test_expiring_token_is_refreshed_once_for_concurrent_calls(
    settings: AssistantSettings,
) -> None:
    """Review Focus 3: several tool calls at once near expiry refresh once, with
    the web client, and the rotated refresh token is used next time."""
    first = _jwt(USER, NOW + 3600, "first")
    second = _jwt(USER, NOW + 7200, "second")
    keycloak = Keycloak(
        httpx.Response(200, json={"access_token": first, "refresh_token": "refresh-2"}),
        httpx.Response(200, json={"access_token": second}),
    )
    clock = [NOW]
    login = await make_login(
        _authed(settings),
        Principal(USER, _jwt(USER, NOW + 30)),
        "refresh-1",
        keycloak.client(),
        clock=lambda: clock[0],
    )
    tokens = await asyncio.gather(*(login.bearer() for _ in range(5)))
    assert tokens == [first] * 5
    assert keycloak.forms == [
        {
            "grant_type": "refresh_token",
            "client_id": "goat-web",
            "client_secret": "web-secret",
            "refresh_token": "refresh-1",
        }
    ]
    clock[0] = NOW + 3600
    assert await login.bearer() == second
    assert keycloak.forms[1]["refresh_token"] == "refresh-2"


async def test_a_public_web_client_sends_no_secret(settings: AssistantSettings) -> None:
    keycloak = Keycloak(
        httpx.Response(200, json={"access_token": _jwt(USER, NOW + 3600)})
    )
    login = await make_login(
        _authed(settings, web_client_secret=SecretStr("")),
        Principal(USER, _jwt(USER, NOW)),
        "refresh-1",
        keycloak.client(),
        clock=lambda: NOW,
    )
    await login.bearer()
    assert "client_secret" not in keycloak.forms[0]


async def test_refreshed_token_of_another_user_is_refused(
    settings: AssistantSettings,
) -> None:
    """Review Focus 3: a swapped refresh token cannot change whose permissions a run has."""
    keycloak = Keycloak(
        httpx.Response(200, json={"access_token": _jwt(OTHER, NOW + 3600)})
    )
    login = await make_login(
        _authed(settings),
        Principal(USER, _jwt(USER, NOW)),
        "foreign",
        keycloak.client(),
        clock=lambda: NOW,
    )
    with pytest.raises(LoginFailed, match="another user"):
        await login.bearer()


async def test_a_refused_refresh_is_a_login_failure(
    settings: AssistantSettings,
) -> None:
    keycloak = Keycloak(httpx.Response(400, json={"error": "invalid_grant"}))
    login = await make_login(
        _authed(settings),
        Principal(USER, _jwt(USER, NOW)),
        "stale",
        keycloak.client(),
        clock=lambda: NOW,
    )
    with pytest.raises(LoginFailed, match="HTTP 400"):
        await login.bearer()


async def test_token_exchange_uses_the_assistant_client(
    settings: AssistantSettings,
) -> None:
    delegated = _jwt(USER, NOW + 900, "delegated")
    keycloak = Keycloak(
        httpx.Response(
            200, json={"access_token": delegated, "refresh_token": "own-refresh"}
        )
    )
    access = _jwt(USER, NOW + 300)
    login = await make_login(
        _authed(
            settings,
            token_exchange_enabled=True,
            keycloak_client_id="goat-assistant",
            keycloak_client_secret=SecretStr("assistant-secret"),
        ),
        Principal(USER, access),
        "ignored",
        keycloak.client(),
        clock=lambda: NOW,
    )
    assert await login.bearer() == delegated
    assert keycloak.forms == [
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "client_id": "goat-assistant",
            "client_secret": "assistant-secret",
            "subject_token": access,
            "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "requested_token_type": "urn:ietf:params:oauth:token-type:refresh_token",
        }
    ]


async def test_secrets_lists_the_current_tokens_and_failures_carry_none(
    settings: AssistantSettings,
) -> None:
    """The login names its tokens for redaction, and a refusal never quotes them."""
    access = _jwt(USER, NOW)
    assert StaticLogin(access).secrets() == [access]
    assert StaticLogin().secrets() == []
    rotated = _jwt(USER, NOW + 3600, "rotated")
    keycloak = Keycloak(
        httpx.Response(
            200, json={"access_token": rotated, "refresh_token": "refresh-2"}
        ),
        httpx.Response(400, json={"error": "invalid_grant", "echo": "refresh-2"}),
    )
    clock = [NOW]
    login = await make_login(
        _authed(settings),
        Principal(USER, access),
        "refresh-1",
        keycloak.client(),
        clock=lambda: clock[0],
    )
    assert login.secrets() == [access, "refresh-1"]
    await login.bearer()
    assert login.secrets() == [rotated, "refresh-2"]
    clock[0] = NOW + 3600
    with pytest.raises(LoginFailed) as failure:
        await login.bearer()
    assert "refresh-2" not in str(failure.value) and rotated not in str(failure.value)


async def _login_that_must_refresh(
    settings: AssistantSettings, keycloak: Keycloak, **changes: Any
) -> Login:
    return await make_login(
        _authed(settings, **changes),
        Principal(USER, _jwt(USER, NOW)),
        "refresh-1",
        keycloak.client(),
        clock=lambda: NOW,
    )


async def test_an_unreachable_keycloak_is_a_login_failure_without_a_cause(
    settings: AssistantSettings,
) -> None:
    """The httpx error carries the request body (the refresh token), so it is not chained."""
    keycloak = Keycloak(httpx.ConnectError("refused"))
    login = await _login_that_must_refresh(settings, keycloak)
    with pytest.raises(LoginFailed, match="not reachable") as failure:
        await login.bearer()
    assert failure.value.__cause__ is None
    assert failure.value.__suppress_context__


async def test_an_answer_that_is_not_json_is_a_login_failure(
    settings: AssistantSettings,
) -> None:
    keycloak = Keycloak(httpx.Response(200, content=b"<html>oops</html>"))
    login = await _login_that_must_refresh(settings, keycloak)
    with pytest.raises(LoginFailed, match="not JSON"):
        await login.bearer()


async def test_an_invalid_expiry_is_a_login_failure(
    settings: AssistantSettings,
) -> None:
    keycloak = Keycloak(
        httpx.Response(200, json={"access_token": _jwt(USER, "soon")})  # type: ignore[arg-type]
    )
    login = await _login_that_must_refresh(settings, keycloak)
    with pytest.raises(LoginFailed, match="expiry"):
        await login.bearer()


async def test_a_failed_refresh_is_remembered(settings: AssistantSettings) -> None:
    """Later and waiting callers get the same failure without another round trip."""
    keycloak = Keycloak(httpx.Response(400, json={"error": "invalid_grant"}))
    login = await _login_that_must_refresh(settings, keycloak)
    results = await asyncio.gather(
        *(login.bearer() for _ in range(3)), return_exceptions=True
    )
    assert all(isinstance(r, LoginFailed) for r in results)
    assert len({id(r) for r in results}) == 1
    with pytest.raises(LoginFailed, match="HTTP 400"):
        await login.bearer()
    assert len(keycloak.forms) == 1


async def test_an_exchange_answer_without_a_refresh_token_lasts_one_access_token(
    settings: AssistantSettings,
) -> None:
    delegated = _jwt(USER, NOW + 900)
    keycloak = Keycloak(httpx.Response(200, json={"access_token": delegated}))
    clock = [NOW]
    login = await make_login(
        _authed(
            settings,
            token_exchange_enabled=True,
            keycloak_client_id="goat-assistant",
            keycloak_client_secret=SecretStr("assistant-secret"),
        ),
        Principal(USER, _jwt(USER, NOW + 300)),
        None,
        keycloak.client(),
        clock=lambda: clock[0],
    )
    clock[0] = NOW + 5000
    assert await login.bearer() == delegated
    assert len(keycloak.forms) == 1


async def test_token_exchange_needs_an_http_client(settings: AssistantSettings) -> None:
    with pytest.raises(LoginFailed, match="not configured"):
        await make_login(
            _authed(
                settings,
                token_exchange_enabled=True,
                keycloak_client_id="goat-assistant",
                keycloak_client_secret=SecretStr("assistant-secret"),
            ),
            Principal(USER, _jwt(USER, NOW + 300)),
            None,
            None,
        )


async def test_an_exchanged_token_of_another_user_is_refused(
    settings: AssistantSettings,
) -> None:
    keycloak = Keycloak(
        httpx.Response(200, json={"access_token": _jwt(OTHER, NOW + 900)})
    )
    with pytest.raises(LoginFailed, match="another user"):
        await make_login(
            _authed(
                settings,
                token_exchange_enabled=True,
                keycloak_client_id="goat-assistant",
                keycloak_client_secret=SecretStr("assistant-secret"),
            ),
            Principal(USER, _jwt(USER, NOW + 300)),
            None,
            keycloak.client(),
            clock=lambda: NOW,
        )
