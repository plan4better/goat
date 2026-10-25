"""Settings of the tool layer, and the HTTP calls tools make (spec §7.5, §8.3)."""

from typing import Any
from urllib.parse import quote

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from pydantic_ai.exceptions import ToolFailed

from assistant.config import AssistantSettings
from assistant.tools.http import (
    ServiceClients,
    ServiceError,
    call_service,
    sign_in_expired,
)
from assistant.tools.testing import signed_in

_TOOL_ENV = (
    "GOAT_PROCESSES_URL",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET",
    "ASSISTANT_CORE_URL",
    "ASSISTANT_GEOAPI_URL",
    "ASSISTANT_PROCESSES_URL",
    "ASSISTANT_CATALOG_URL",
    "ASSISTANT_DISABLED_SURFACES",
    "ASSISTANT_ENABLE_MCP",
    "ASSISTANT_MCP_ALLOWED_HOSTS",
    "ASSISTANT_WEB_CLIENT_ID",
    "ASSISTANT_WEB_CLIENT_SECRET",
    "ASSISTANT_TOKEN_EXCHANGE_ENABLED",
    "ASSISTANT_KEYCLOAK_CLIENT_ID",
    "ASSISTANT_KEYCLOAK_CLIENT_SECRET",
    "ASSISTANT_MCP_AUDIT_RETENTION_DAYS",
    "ASSISTANT_RUN_WAIT_MAX_SECONDS",
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in _TOOL_ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _build(**overrides: Any) -> AssistantSettings:
    # The settings class's own tests (Global Constraints): built explicitly.
    return AssistantSettings(
        **{
            "db_schema": "s",
            "ASSISTANT_REDIS_URL": "memory://",
            "AUTH": False,
            "default_provider": "test",
            "default_model": "test",
            **overrides,
        }
    )


def test_service_urls_default_to_the_local_ports(clean_env: pytest.MonkeyPatch) -> None:
    settings = _build()
    assert (
        settings.core_url,
        settings.geoapi_url,
        settings.processes_url,
        settings.catalog_url,
    ) == (
        "http://localhost:8000",
        "http://localhost:8100",
        "http://localhost:8300",
        "http://localhost:8400",
    )
    assert settings.enable_mcp is True
    assert settings.mcp_allowed_hosts == ["*"]
    assert settings.disabled_surfaces == []
    assert settings.token_exchange_enabled is False


def test_repo_wide_variables_are_read(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("GOAT_PROCESSES_URL", "http://processes:8000")
    clean_env.setenv("KEYCLOAK_CLIENT_ID", "goat-web")
    clean_env.setenv("KEYCLOAK_CLIENT_SECRET", "web-secret")
    settings = _build()
    assert settings.processes_url == "http://processes:8000"
    assert settings.web_client_id == "goat-web"
    assert settings.web_client_secret.get_secret_value() == "web-secret"
    assert "web-secret" not in repr(settings)


def test_list_settings_take_commas_or_json(clean_env: pytest.MonkeyPatch) -> None:
    assert _build(disabled_surfaces="catalog, project.map").disabled_surfaces == [
        "catalog",
        "project.map",
    ]
    assert _build(disabled_surfaces='["project.dashboard"]').disabled_surfaces == [
        "project.dashboard"
    ]
    # The catalog's old value format keeps working.
    assert _build(mcp_allowed_hosts='["goat.example.com"]').mcp_allowed_hosts == [
        "goat.example.com"
    ]
    with pytest.raises(ValidationError):
        _build(disabled_surfaces="catalog,maps")


def test_empty_mcp_allowed_hosts_mean_the_default(
    clean_env: pytest.MonkeyPatch,
) -> None:
    # An empty list would enable the host check with no host allowed.
    clean_env.setenv("ASSISTANT_MCP_ALLOWED_HOSTS", "")
    assert _build().mcp_allowed_hosts == ["*"]
    clean_env.setenv("ASSISTANT_MCP_ALLOWED_HOSTS", " , ")
    assert _build().mcp_allowed_hosts == ["*"]
    clean_env.setenv("ASSISTANT_MCP_ALLOWED_HOSTS", "*,goat.example.com")
    assert _build().mcp_allowed_hosts == ["*", "goat.example.com"]


def test_mcp_audit_retention_is_read_and_at_least_a_day(
    clean_env: pytest.MonkeyPatch,
) -> None:
    assert _build().mcp_audit_retention_days == 30
    clean_env.setenv("ASSISTANT_MCP_AUDIT_RETENTION_DAYS", "90")
    assert _build().mcp_audit_retention_days == 90
    for value in ("0", "-1"):
        clean_env.setenv("ASSISTANT_MCP_AUDIT_RETENTION_DAYS", value)
        with pytest.raises(ValidationError):
            _build()
    description = AssistantSettings.model_fields["mcp_audit_retention_days"].description
    assert description and "MCP" in description


def test_the_wait_limit_is_read(clean_env: pytest.MonkeyPatch) -> None:
    assert AssistantSettings().run_wait_max_seconds == 1800
    clean_env.setenv("ASSISTANT_RUN_WAIT_MAX_SECONDS", "600")
    assert AssistantSettings().run_wait_max_seconds == 600


def test_token_exchange_needs_the_assistant_client(
    clean_env: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValidationError, match="ASSISTANT_KEYCLOAK_CLIENT_ID"):
        _build(token_exchange_enabled=True)
    settings = _build(
        token_exchange_enabled=True,
        keycloak_client_id="goat-assistant",
        keycloak_client_secret="s",
    )
    assert settings.token_exchange_enabled is True


def _clients(handler: Any, base: str = "http://core") -> ServiceClients:
    def client() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=base)

    return ServiceClients(
        core=client(), geoapi=client(), processes=client(), catalog=client()
    )


async def test_a_call_sends_the_bearer_and_drops_empty_parameters() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    body = await call_service(
        _clients(handler),
        "core",
        "GET",
        "/api/v2/project",
        bearer="user-token",
        params={"search": "rad", "folder_id": None, "size": 10, "tags": ["a", "b"]},
    )
    assert body == {"ok": True}
    assert seen[0].headers["Authorization"] == "Bearer user-token"
    assert dict(seen[0].url.params) == {"search": "rad", "size": "10", "tags": "a,b"}


async def test_no_bearer_without_a_login() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    await call_service(_clients(handler), "core", "GET", "/x", bearer=None)
    assert "Authorization" not in seen[0].headers


async def test_a_base_url_with_a_path_prefix_is_kept() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    await call_service(
        _clients(handler, base="http://gateway/geoapi"),
        "geoapi",
        "GET",
        "/collections",
        bearer=None,
    )
    assert seen[0].url.path == "/geoapi/collections"


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (
            400,
            {"code": 400, "description": "invalid bbox: ['x']"},
            "rejected the request (HTTP 400): invalid bbox",
        ),
        (401, {"detail": "expired"}, "did not accept the user's sign-in"),
        (403, {"detail": "nope"}, "has no access"),
        (
            404,
            {"detail": "Project not found"},
            "Not found in the GOAT core service: Project not found",
        ),
        (500, {"detail": "boom with secrets"}, "not available right now (HTTP 500)"),
    ],
)
async def test_errors_become_tool_failures(
    status: int, body: dict[str, Any], expected: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    with pytest.raises(ServiceError) as caught:
        await call_service(_clients(handler), "core", "GET", "/x", bearer=None)
    assert caught.value.status == status
    assert expected in caught.value.message
    # Server internals of a 5xx never reach the model.
    assert "secrets" not in caught.value.message


SIGN_IN_TEXT = (
    "The GOAT core service did not accept the user's sign-in. "
    "The user may need to sign in again."
)


@pytest.mark.parametrize(
    ("expires_in", "expected"),
    [
        (None, SIGN_IN_TEXT),
        (-60, SIGN_IN_TEXT),
        (
            300,
            "The GOAT core service refused the request: the user has no access "
            "to this.",
        ),
    ],
    ids=["no token", "expired token", "valid token"],
)
async def test_a_401_names_the_sign_in_only_for_an_expired_one(
    expires_in: float | None, expected: str
) -> None:
    """Core answers 401 also when its authorization denies a request, so a
    401 for a token that is still valid is no access, not a sign-in to renew."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "Unauthorized"})

    bearer = None if expires_in is None else signed_in(expires_in).token
    with pytest.raises(ServiceError) as caught:
        await call_service(_clients(handler), "core", "GET", "/x", bearer=bearer)
    assert caught.value.message == expected
    assert sign_in_expired(caught.value) is (expected == SIGN_IN_TEXT)


async def test_unreachable_and_slow_services_are_tool_failures() -> None:
    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(ToolFailed, match="not reachable"):
        await call_service(_clients(refused), "catalog", "GET", "/stac", bearer=None)
    with pytest.raises(ToolFailed, match="did not answer in time"):
        await call_service(_clients(slow), "catalog", "GET", "/stac", bearer=None)


@pytest.mark.parametrize(
    "path",
    [
        "http://evil.example/x",
        "x",
        "//evil.example/x",
        "/stac/../admin",
        "/stac/./x",
        "/stac/resolve/..",
    ],
)
async def test_a_tool_can_only_name_a_path(path: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called")

    with pytest.raises(ValueError, match="only name a path"):
        await call_service(_clients(handler), "core", "GET", path, bearer=None)


async def test_a_redirect_is_a_service_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://evil.example/"})

    with pytest.raises(ServiceError) as caught:
        await call_service(_clients(handler), "core", "GET", "/x", bearer=None)
    assert caught.value.status == 302
    assert "redirect" in caught.value.message


@pytest.mark.parametrize(
    "name", ["core_url", "geoapi_url", "processes_url", "catalog_url"]
)
@pytest.mark.parametrize(
    "value",
    [
        "",
        "core:8000",
        "localhost",
        "ftp://core:8000",
        "http://",
        "http://core:8000?x=1",
        "http://core:8000#frag",
        "http://core:8000/api?",
    ],
)
def test_a_service_url_must_be_an_http_url(
    clean_env: pytest.MonkeyPatch, name: str, value: str
) -> None:
    with pytest.raises(ValidationError) as caught:
        _build(**{name: value})
    text = str(caught.value)
    assert (
        f"ASSISTANT_{name.upper()} must be an http(s) URL such as http://core:8000"
        in text
    )
    # The raw value is not echoed back.
    assert "input_value" not in text


def test_a_service_url_from_the_environment_is_checked(
    clean_env: pytest.MonkeyPatch,
) -> None:
    clean_env.setenv("ASSISTANT_CORE_URL", "")
    with pytest.raises(ValidationError, match="ASSISTANT_CORE_URL must be an http"):
        _build()


def test_a_service_url_may_carry_a_path_prefix(clean_env: pytest.MonkeyPatch) -> None:
    settings = _build(
        core_url="http://core:8000/api", catalog_url="https://gw.example/catalog/"
    )
    assert settings.core_url == "http://core:8000/api"
    assert settings.catalog_url == "https://gw.example/catalog/"


@pytest.mark.parametrize(
    "path",
    [
        "/x?a=1",
        "/x#frag",
        "/x\ny",
        "/x\x00y",
        "/x\ty",
        "/x\\y",
        "/stac/%2e%2e/admin",
        "/stac/%2E%2E/admin",
        "/stac/%2e/x",
        "/stac/..%2fadmin/x",
        "/stac/%2e%2e%2fadmin",
    ],
)
async def test_a_path_cannot_smuggle_a_query_control_characters_or_encoded_dots(
    path: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called")

    with pytest.raises(ValueError, match="only name a path"):
        await call_service(_clients(handler), "core", "GET", path, bearer=None)


async def test_a_quoted_identifier_is_kept_as_it_is() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    await call_service(
        _clients(handler),
        "core",
        "GET",
        "/api/v2/layer/" + quote("a b/c", safe=""),
        bearer=None,
    )
    assert seen[0].url.raw_path == b"/api/v2/layer/a%20b%2Fc"


async def test_a_path_httpx_cannot_build_is_an_invalid_path() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called")

    with pytest.raises(ValueError, match="only name a path"):
        await call_service(
            _clients(handler), "core", "GET", "/" + "a" * 70_000, bearer=None
        )


def test_an_unknown_service_is_refused() -> None:
    clients = _clients(lambda request: httpx.Response(200))
    with pytest.raises(ValueError, match="Unknown service"):
        clients.client("keycloak")  # type: ignore[arg-type]
    assert clients.client("geoapi") is clients.geoapi


def test_from_settings_builds_hardened_clients(settings: AssistantSettings) -> None:
    custom = settings.model_copy(
        update={
            "core_url": "http://core:8000/",
            "geoapi_url": "http://geoapi:8100///",
            "tool_timeout_seconds": 7.0,
            "auth": False,
            "keycloak_server_url": "http://keycloak.test",
        }
    )
    clients = ServiceClients.from_settings(custom)
    assert str(clients.core.base_url) == "http://core:8000"
    assert str(clients.geoapi.base_url).rstrip("/") == "http://geoapi:8100"
    for service in ("core", "geoapi", "processes", "catalog"):
        client = clients.client(service)  # type: ignore[arg-type]
        assert client.follow_redirects is False
        assert client.timeout.read == 7.0
        assert client.timeout.connect == 5.0
    assert clients.keycloak is None


def test_from_settings_builds_a_keycloak_client_with_auth(
    settings: AssistantSettings,
) -> None:
    clients = ServiceClients.from_settings(
        settings.model_copy(
            update={"auth": True, "keycloak_server_url": "http://keycloak.test/"}
        )
    )
    assert clients.keycloak is not None
    assert clients.keycloak.follow_redirects is False


async def test_aclose_closes_every_client() -> None:
    clients = _clients(lambda request: httpx.Response(200))
    clients.keycloak = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200))
    )
    await clients.aclose()
    for client in (
        clients.core,
        clients.geoapi,
        clients.processes,
        clients.catalog,
        clients.keycloak,
    ):
        assert client.is_closed


def test_auth_without_a_web_client_warns_at_startup(
    settings: AssistantSettings, caplog: pytest.LogCaptureFixture
) -> None:
    """Without the web client a run cannot refresh the user's token, so a long
    run fails once the token expires: said once, when the app is built."""
    import logging

    from assistant.app import create_app

    authed = settings.model_copy(
        update={
            "auth": True,
            "keycloak_server_url": "http://keycloak.test",
            "web_client_secret": SecretStr("web-secret-value"),
        }
    )
    with caplog.at_level(logging.WARNING, logger="assistant.app"):
        create_app(authed)
    [record] = [r for r in caplog.records if "refresh" in r.getMessage()]
    assert record.levelno == logging.WARNING
    assert "ASSISTANT_WEB_CLIENT_ID" in record.getMessage()
    assert "web-secret-value" not in caplog.text
    # With the client, with token exchange, or with AUTH off: no warning.
    for update in (
        {"web_client_id": "goat-web"},
        {
            "token_exchange_enabled": True,
            "keycloak_client_id": "goat-assistant",
            "keycloak_client_secret": SecretStr("x"),
        },
        {"auth": False},
    ):
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="assistant.app"):
            create_app(authed.model_copy(update=update))
        assert not [r for r in caplog.records if "refresh" in r.getMessage()]


async def test_a_refusal_with_issues_keeps_them() -> None:
    """processes refuses a run with its check's issues under detail.issues."""
    issues = [{"code": "setting_invalid", "level": "error", "message": "Walk: bad."}]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={"detail": {"message": "The workflow has issues.", "issues": issues}},
        )

    with pytest.raises(ServiceError) as caught:
        await call_service(_clients(handler), "processes", "POST", "/x", bearer=None)
    assert caught.value.status == 422
    assert caught.value.issues == issues


async def test_a_refusal_without_issues_has_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "Project not found"})

    with pytest.raises(ServiceError) as caught:
        await call_service(_clients(handler), "core", "GET", "/x", bearer=None)
    assert caught.value.issues is None
