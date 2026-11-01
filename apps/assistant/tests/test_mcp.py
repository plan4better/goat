"""The MCP endpoint (spec §9.1), moved from the catalog service: transport and
auth cases of the old catalog tests, plus calls through the shared tool layer."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx
import pytest
from goatlib.auth import JOSEError
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel
from pydantic_ai.exceptions import ToolFailed

from assistant.app import AppServices, create_app
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.tools.testing import RecordingTransport, fake_clients

USER = UUID(int=1)
HANDSHAKE_VERSION = "2025-06-18"
MODERN_VERSION = "2026-07-28"
HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
CATALOG_TOOLS = {
    "catalog_search",
    "catalog_describe",
    "catalog_get_record",
    "catalog_suggest_terms",
    "catalog_find_region",
}


@asynccontextmanager
async def _mcp(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    catalog: RecordingTransport | None = None,
    host: str = "testserver",
) -> AsyncIterator[AsyncClient]:
    bus = InMemoryEventBus()
    services = AppServices(
        db=db,
        repo=repo,
        bus=bus,
        runs=RunManager(repo, bus, settings, owner="t"),
        tools=fake_clients(catalog=catalog),
    )
    app = create_app(settings, services=services)
    # ASGITransport does not run lifespans; the MCP session manager runs in it.
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url=f"http://{host}"
        ) as client:
            yield client


async def _post(
    client: AsyncClient, body: dict[str, Any], headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.post("/mcp", json=body, headers={**HEADERS, **(headers or {})})


async def _initialize(
    client: AsyncClient, headers: dict[str, str] | None = None
) -> httpx.Response:
    return await _post(
        client,
        {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": HANDSHAKE_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        },
        headers,
    )


async def _rpc(
    client: AsyncClient,
    method: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return await _post(
        client, body, {"mcp-protocol-version": HANDSHAKE_VERSION, **(headers or {})}
    )


async def _tool_names(
    client: AsyncClient, headers: dict[str, str] | None = None
) -> set[str]:
    assert (await _initialize(client, headers)).status_code == 200
    listed = await _rpc(client, "tools/list", headers=headers)
    assert listed.status_code == 200, listed.text
    return {tool["name"] for tool in listed.json()["result"]["tools"]}


def _authed(settings: AssistantSettings) -> AssistantSettings:
    return settings.model_copy(
        update={"auth": True, "keycloak_server_url": "http://keycloak.test"}
    )


@pytest.fixture
def valid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "assistant.auth.validate_token", lambda settings, token: {"sub": str(USER)}
    )


# -- transport and auth (moved from apps/catalog/tests/test_mcp.py) ------------


async def test_mcp_is_mounted_when_enabled(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(settings, db, repo) as client:
        response = await _initialize(client)
    # Never 404 (no /mcp) and never 421 (the SDK's localhost-only default host check).
    assert response.status_code == 200, response.text


async def test_mcp_lists_the_five_catalog_tools(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(settings, db, repo) as client:
        assert await _tool_names(client) == CATALOG_TOOLS


async def test_mcp_is_not_mounted_when_disabled(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(
        settings.model_copy(update={"enable_mcp": False}), db, repo
    ) as client:
        assert (await _initialize(client)).status_code == 404


async def test_mcp_requires_a_token_when_auth_is_on(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(_authed(settings), db, repo) as client:
        response = await _initialize(client)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_mcp_is_open_when_auth_is_off(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(settings, db, repo) as client:
        response = await _initialize(client)
        assert response.status_code == 200, response.text
        assert response.json()["result"]["serverInfo"]["name"] == "goat-assistant"
        assert await _tool_names(client) == CATALOG_TOOLS


async def test_mcp_valid_token_allows_the_handshake(
    settings: AssistantSettings, db: Database, repo: Repository, valid_token: None
) -> None:
    async with _mcp(_authed(settings), db, repo) as client:
        assert (
            await _tool_names(client, {"Authorization": "Bearer sometoken"})
            == CATALOG_TOOLS
        )


async def test_mcp_invalid_token_is_401(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(settings: AssistantSettings, token: str) -> dict[str, object]:
        raise JOSEError("bad signature")

    monkeypatch.setattr("assistant.auth.validate_token", refuse)
    async with _mcp(_authed(settings), db, repo) as client:
        response = await _initialize(client, {"Authorization": "Bearer sometoken"})
    assert response.status_code == 401


async def test_mcp_token_without_a_uuid_subject_is_401(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same checks as the API (assistant.auth.principal_from_token)."""
    monkeypatch.setattr(
        "assistant.auth.validate_token",
        lambda settings, token: {"sub": "service-account-x"},
    )
    async with _mcp(_authed(settings), db, repo) as client:
        response = await _initialize(client, {"Authorization": "Bearer sometoken"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Token subject is not a UUID"


async def test_mcp_takes_post_only(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(settings, db, repo) as client:
        assert (await client.delete("/mcp", headers=HEADERS)).status_code == 405
        assert (await client.get("/mcp", headers=HEADERS)).status_code == 405


async def test_mcp_allowed_hosts_wildcard_switches_the_check_off(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    async with _mcp(settings, db, repo, host="anything.example") as client:
        assert (await _initialize(client)).status_code == 200


async def test_mcp_allowed_hosts_narrowed_to_the_matching_host(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    narrowed = settings.model_copy(update={"mcp_allowed_hosts": ["testserver"]})
    async with _mcp(narrowed, db, repo) as client:
        assert (await _initialize(client)).status_code == 200


async def test_mcp_allowed_hosts_narrowed_to_another_host_is_421(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    narrowed = settings.model_copy(
        update={"mcp_allowed_hosts": ["api.goat.example.com"]}
    )
    async with _mcp(narrowed, db, repo) as client:
        assert (await _initialize(client)).status_code == 421


async def test_mcp_narrowed_hosts_refuse_a_request_with_an_origin(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    """Narrowed hosts allow no Origin: a browser's request is refused, a
    non-browser client (no Origin header) passes."""
    narrowed = settings.model_copy(update={"mcp_allowed_hosts": ["testserver"]})
    async with _mcp(narrowed, db, repo) as client:
        response = await _initialize(client, {"Origin": "https://x"})
    assert response.status_code == 403


@pytest.mark.parametrize("hosts", [["*", "api.goat.example.com"], []])
async def test_mcp_allowed_hosts_wildcard_or_empty_switch_the_check_off(
    settings: AssistantSettings, db: Database, repo: Repository, hosts: list[str]
) -> None:
    """A ``*`` entry switches the check off next to other entries, and an empty
    list means the default, never "no host allowed" (421 for everything)."""
    configured = settings.model_copy(update={"mcp_allowed_hosts": hosts})
    async with _mcp(configured, db, repo, host="anything.example") as client:
        assert (await _initialize(client)).status_code == 200


# -- calls through the shared tool layer ---------------------------------------


async def test_a_tool_call_runs_the_shared_tool_and_forwards_the_token(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    catalog_transport: RecordingTransport,
    valid_token: None,
) -> None:
    auth = {"Authorization": "Bearer sometoken"}
    async with _mcp(_authed(settings), db, repo, catalog_transport) as client:
        await _initialize(client, auth)
        response = await _rpc(
            client,
            "tools/call",
            {"name": "catalog_suggest_terms", "arguments": {"prefix": "radver"}},
            auth,
        )
    result = response.json()["result"]
    assert result["isError"] is False
    assert any(
        "Radverkehrsnetz" in match["title"]
        for match in result["structuredContent"]["matches"]
    )
    assert catalog_transport.requests[0].headers["Authorization"] == "Bearer sometoken"
    async with db.pool.acquire() as conn:
        [row] = await conn.fetch(f"SELECT * FROM {db.t('tool_call')}")
    assert (row["run_id"], row["user_id"], row["tool"], row["status"]) == (
        None,
        USER,
        "catalog_suggest_terms",
        "ok",
    )


async def test_tool_errors_are_tool_results(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    catalog_transport: RecordingTransport,
) -> None:
    async with _mcp(settings, db, repo, catalog_transport) as client:
        await _initialize(client)
        missing = await _rpc(
            client,
            "tools/call",
            {"name": "catalog_get_record", "arguments": {"item_id": "does-not-exist"}},
        )
        invalid = await _rpc(
            client, "tools/call", {"name": "catalog_suggest_terms", "arguments": {}}
        )
        unknown = await _rpc(
            client,
            "tools/call",
            {"name": "catalog_propose_filters", "arguments": {"title": "x"}},
        )
    for response in (missing, invalid, unknown):
        assert response.json()["result"]["isError"] is True
    assert (
        missing.json()["result"]["content"][0]["text"]
        == "Catalog record 'does-not-exist' not found"
    )
    assert "prefix" in invalid.json()["result"]["content"][0]["text"]
    # Proposal tools are in-app only.
    assert "Unknown tool" in unknown.json()["result"]["content"][0]["text"]


async def test_mcp_answers_the_2026_07_28_revision(
    settings: AssistantSettings, db: Database, repo: Repository
) -> None:
    envelope = {
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
        }
    }
    async with _mcp(settings, db, repo) as client:
        response = await _post(
            client,
            {"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": envelope},
            {"mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list"},
        )
    assert response.status_code == 200, response.text
    assert {
        tool["name"] for tool in response.json()["result"]["tools"]
    } == CATALOG_TOOLS


async def test_mcp_tool_call_in_the_2026_07_28_revision(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    catalog_transport: RecordingTransport,
) -> None:
    envelope = {
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
        }
    }
    async with _mcp(settings, db, repo, catalog_transport) as client:
        response = await _post(
            client,
            {
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {
                    "name": "catalog_suggest_terms",
                    "arguments": {"prefix": "radver"},
                    **envelope,
                },
            },
            # tools/call also names the tool in a header, which must match the body.
            {
                "mcp-protocol-version": MODERN_VERSION,
                "mcp-method": "tools/call",
                "mcp-name": "catalog_suggest_terms",
            },
        )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["isError"] is False


# -- data policy and redaction over MCP ----------------------------------------


class _Rows(BaseModel):
    rows: list[dict[str, Any]]
    count: int

    def restricted(self) -> "_RowCount":
        return _RowCount(count=self.count)


class _RowCount(BaseModel):
    count: int


class _NoArgs(BaseModel):
    pass


async def _rows(env: ToolEnv, args: _NoArgs) -> _Rows:
    return _Rows(rows=[{"name": "A"}, {"name": "B"}], count=2)


def _publish(monkeypatch: pytest.MonkeyPatch, spec: ToolSpec[Any, Any]) -> None:
    monkeypatch.setattr("assistant.mcp_server.MCP_TOOLS", (spec,))


async def test_data_tools_get_the_restricted_form_over_mcp(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No published tool returns data values today; should one be flagged, MCP
    callers get its Restricted form, as a Restricted organization does in a run."""
    _publish(
        monkeypatch,
        ToolSpec(
            name="test.rows",
            description="Rows.",
            input_model=_NoArgs,
            output_model=_Rows,
            run=_rows,
            surfaces=frozenset(),
            returns_data=True,
            mcp=True,
        ),
    )
    async with _mcp(settings, db, repo) as client:
        await _initialize(client)
        response = await _rpc(
            client, "tools/call", {"name": "test_rows", "arguments": {}}
        )
    result = response.json()["result"]
    assert result["isError"] is False
    assert result["structuredContent"] == {"count": 2}


@pytest.mark.parametrize("error", [ToolFailed, InputInvalid])
async def test_a_tool_error_never_carries_the_bearer(
    settings: AssistantSettings,
    db: Database,
    repo: Repository,
    monkeypatch: pytest.MonkeyPatch,
    error: type[Exception],
) -> None:
    token = "eyJ-a-bearer-token-the-service-echoed"
    monkeypatch.setattr(
        "assistant.auth.validate_token", lambda settings, token: {"sub": str(USER)}
    )

    async def echo_the_token(env: ToolEnv, args: _NoArgs) -> _RowCount:
        raise error(f"Service said: bad token {await env.bearer()}")

    _publish(
        monkeypatch,
        ToolSpec(
            name="test.leaky",
            description="Leaks.",
            input_model=_NoArgs,
            output_model=_RowCount,
            run=echo_the_token,
            surfaces=frozenset(),
            returns_data=False,
            mcp=True,
        ),
    )
    auth = {"Authorization": f"Bearer {token}"}
    async with _mcp(_authed(settings), db, repo) as client:
        await _initialize(client, auth)
        response = await _rpc(
            client, "tools/call", {"name": "test_leaky", "arguments": {}}, auth
        )
    result = response.json()["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"].startswith("Service said: bad token")
    assert "bearer-token" not in response.text
    async with db.pool.acquire() as conn:
        [row] = await conn.fetch(f"SELECT error FROM {db.t('tool_call')}")
    assert "bearer-token" not in row["error"]
