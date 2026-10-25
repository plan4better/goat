"""Admin AI page API (spec §4, §10)."""

import asyncio
import ipaddress
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import pytest
from cryptography.fernet import Fernet
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from assistant.app import AppServices, create_app
from assistant.auth import Principal, get_principal
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.llm.endpoints import EndpointPolicy, IPAddress
from assistant.llm.probe import ProbeResult
from assistant.llm.providers import Target
from assistant.llm.vault import SecretBox
from assistant.org_repo import OrgSettingsRepository
from assistant.repo import Repository
from assistant.routers import ai_settings
from assistant.runs.manager import RunManager

USER = UUID(int=1)
ADMIN = UUID(int=3)
OTHER_ADMIN = UUID(int=4)
SECRET = "sk-secret-abcd1234"
CREATE = {
    "name": "Own",
    "provider": "openai_compatible",
    "base_url": "https://llm.example.org/v1",
    "model": "own-model",
    "credentials": {"api_key": SECRET},
}


@pytest.fixture
def authed(settings: AssistantSettings) -> AssistantSettings:
    """Admin rules apply only with AUTH on; the principal is injected anyway."""
    return settings.model_copy(update={"auth": True})


@pytest.fixture(autouse=True)
def _dns(monkeypatch: pytest.MonkeyPatch) -> None:
    table = {
        "llm.example.org": "93.184.215.14",
        "openrouter.ai": "104.18.2.115",
        "inside.example.org": "10.0.0.5",
    }

    async def resolve(host: str, port: int) -> list[IPAddress]:
        if host not in table:
            raise OSError(host)
        return [ipaddress.ip_address(table[host])]

    monkeypatch.setattr(ai_settings, "RESOLVER", resolve)


class FakeProbe:
    def __init__(self, ok: bool = True, error: str | None = None) -> None:
        self.ok, self.error = ok, error
        self.targets: list[Target] = []

    async def __call__(self, target: Target, policy: EndpointPolicy) -> ProbeResult:
        self.targets.append(target)
        capabilities = {"tool_calling": True, "streaming": True} if self.ok else {}
        return ProbeResult(ok=self.ok, error=self.error, capabilities=capabilities)


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch) -> FakeProbe:
    fake = FakeProbe()
    monkeypatch.setattr(ai_settings, "PROBE", fake)
    return fake


@asynccontextmanager
async def _client(
    db: Database, settings: AssistantSettings, user: UUID
) -> AsyncIterator[AsyncClient]:
    repo = Repository(db)
    bus = InMemoryEventBus()
    services = AppServices(
        db=db, repo=repo, bus=bus, runs=RunManager(repo, bus, settings, owner="t")
    )
    app = create_app(settings, services=services)
    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id=user, token=None
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        yield client


async def _create(client: AsyncClient, **changes: Any) -> dict[str, Any]:
    response = await client.post("/connections", json={**CREATE, **changes})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _settings_body(**changes: Any) -> dict[str, Any]:
    return {
        "enabled": True,
        "active_connection_id": None,
        "data_policy": "standard",
        "allow_default_fallback": False,
        **changes,
    }


async def _activate(client: AsyncClient, connection_id: str) -> None:
    assert (await client.post(f"/connections/{connection_id}/test")).json()[
        "last_test_ok"
    ] is True
    response = await client.put(
        "/settings", json=_settings_body(active_connection_id=connection_id)
    )
    assert response.status_code == 200, response.text


async def test_member_status(db: Database, authed: AssistantSettings) -> None:
    async with _client(db, authed, USER) as client:
        response = await client.get("/status")
    assert response.json() == {
        "available": True,
        "reason": None,
        "is_admin": False,
        "provider": "test",
        "model": "test",
        "data_policy": "restricted",
        "disabled_surfaces": [],
    }


async def test_member_cannot_manage_ai_settings(
    db: Database, authed: AssistantSettings
) -> None:
    """Review Focus 3: every admin route, including the ones that name a real connection."""
    async with _client(db, authed, ADMIN) as admin:
        connection_id = (await _create(admin))["id"]
    async with _client(db, authed, USER) as client:
        for method, path, body in [
            ("GET", "/settings", None),
            ("PUT", "/settings", _settings_body()),
            ("GET", "/connections", None),
            ("POST", "/connections", CREATE),
            ("PATCH", f"/connections/{connection_id}", {"name": "Hijacked"}),
            ("DELETE", f"/connections/{connection_id}", None),
            ("POST", f"/connections/{connection_id}/test", None),
        ]:
            response = await client.request(method, path, json=body)
            assert response.status_code == 403, (method, path)
            assert response.json()["detail"]["code"] == "not_admin", (method, path)
    rows = await db.pool.fetch(f"SELECT name, last_test_at FROM {db.t('connection')}")
    assert [(row["name"], row["last_test_at"]) for row in rows] == [("Own", None)]


async def test_user_without_an_organization(
    db: Database, authed: AssistantSettings
) -> None:
    async with _client(db, authed, UUID(int=99)) as client:
        assert (await client.get("/settings")).json()["detail"][
            "code"
        ] == "no_organization"
        status = await client.get("/status")
    assert status.status_code == 200
    assert (status.json()["available"], status.json()["reason"]) == (
        False,
        "no_organization",
    )


async def test_admin_reads_the_defaults(
    db: Database, authed: AssistantSettings
) -> None:
    async with _client(db, authed, ADMIN) as client:
        body = (await client.get("/settings")).json()
    assert body == {
        "enabled": True,
        "active_connection_id": None,
        "data_policy": "restricted",
        "allow_default_fallback": False,
        "status": "ok",
        "instance": {
            "goat_ai": {"available": True, "provider": "test", "model": "test"},
            "org_connections": True,
            "secrets_key_configured": True,
            "allowed_providers": list(authed.allowed_providers),
            "private_endpoints": False,
        },
    }


async def test_a_connection_has_one_model(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """The model that answers also names the conversation: a connection keeps no
    second model, and a client that still sends one has it ignored."""
    async with _client(db, authed, ADMIN) as client:
        created = await _create(client, background_model="own-small")
        updated = await client.patch(
            f"/connections/{created['id']}", json={"background_model": "own-small"}
        )
    assert updated.status_code == 200, updated.text
    for body in (created, updated.json()):
        assert body["model"] == CREATE["model"]
        assert "background_model" not in body


async def test_an_openrouter_connection_keeps_its_provider_order(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    openrouter = {**CREATE, "base_url": "https://openrouter.ai/api/v1"}
    async with _client(db, authed, ADMIN) as client:
        created = await _create(
            client, **openrouter, provider_order=["DeepInfra"], allow_fallbacks=False
        )
        changed = await client.patch(
            f"/connections/{created['id']}",
            json={"provider_order": ["DeepInfra", "Together"]},
        )
        kept = await client.patch(
            f"/connections/{created['id']}", json={"name": "Own 2"}
        )
        elsewhere = await client.post(
            "/connections",
            json={**CREATE, "name": "Other", "provider_order": ["DeepInfra"]},
        )
    assert (created["provider_order"], created["allow_fallbacks"]) == (
        ["DeepInfra"],
        False,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["provider_order"] == ["DeepInfra", "Together"]
    assert changed.json()["allow_fallbacks"] is False
    assert kept.json()["provider_order"] == ["DeepInfra", "Together"]
    assert elsewhere.status_code == 422
    assert elsewhere.json()["detail"]["field"] == "provider_order"


async def test_key_is_write_only(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """Review Focus 4: the last 4 characters are all that ever comes back."""
    async with _client(db, authed, ADMIN) as client:
        created = await client.post("/connections", json=CREATE)
        connection_id = created.json()["id"]
        listed = await client.get("/connections")
        tested = await client.post(f"/connections/{connection_id}/test")
        renamed = await client.patch(
            f"/connections/{connection_id}", json={"name": "Renamed"}
        )
        settings_body = await client.get("/settings")
    assert created.status_code == 201
    assert created.json()["key_last4"] == "1234"
    # The known profile is there before any test (§4.3).
    assert set(created.json()["capabilities"]) == {
        "vision",
        "context_window",
        "prompt_caching",
        "strict_schemas",
    }
    assert listed.json()[0]["key_last4"] == "1234"
    ciphertext = await db.pool.fetchval(
        f"SELECT credentials_encrypted FROM {db.t('connection')}"
    )
    assert "sk-secret" not in ciphertext
    for response in (created, listed, tested, renamed, settings_body):
        # The row holds the ciphertext: no response may carry it, or any key material.
        assert "credentials_encrypted" not in response.text
        assert ciphertext not in response.text
        assert "credentials" not in (
            response.json()[0] if isinstance(response.json(), list) else response.json()
        )
        for fragment in ("sk-secret", SECRET, "abcd1234"):
            assert fragment not in response.text


async def test_key_is_not_logged_when_the_profile_fails(
    db: Database,
    authed: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Review Focus 4: a path that logs. The failure carries the key, as an SDK
    error echoing a request header would."""

    def failing(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError(f"Authorization: Bearer {SECRET}")

    monkeypatch.setattr(ai_settings, "open_models", failing)
    caplog.set_level(logging.DEBUG)
    async with _client(db, authed, ADMIN) as client:
        created = await client.post("/connections", json=CREATE)
        connection_id = created.json()["id"]
        # The edit path builds the profile too (a model change, not active).
        patched = await client.patch(
            f"/connections/{connection_id}", json={"model": "other-model"}
        )
    assert created.status_code == 201 and created.json()["capabilities"] == {}
    assert patched.status_code == 200
    assert caplog.text.count("No capability profile") == 2
    assert "RuntimeError" in caplog.text  # the traceback is logged, masked
    assert "abcd1234" not in caplog.text
    assert "sk-secret" not in caplog.text


async def test_empty_key_keeps_the_stored_key(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """Review Focus 4: the edit form sends an empty key field when unchanged."""
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await client.post(f"/connections/{connection['id']}/test")
        renamed = await client.patch(
            f"/connections/{connection['id']}",
            json={"name": "Renamed", "credentials": {"api_key": ""}},
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["key_last4"] == "1234"
        assert renamed.json()["last_test_ok"] is True  # a rename keeps the test result
        changed = await client.patch(
            f"/connections/{connection['id']}", json={"model": "other-model"}
        )
        assert changed.json()["last_test_ok"] is None  # a new model needs a new test
        assert (
            "context_window" in changed.json()["capabilities"]
        )  # its known profile meanwhile
    box = SecretBox.from_settings(authed)
    assert box is not None
    stored = await db.pool.fetchval(
        f"SELECT credentials_encrypted FROM {db.t('connection')}"
    )
    assert box.decrypt(stored) == {"api_key": SECRET}


async def test_other_organizations_connection_is_404(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """Review Focus 3: an admin of organization 200 with a connection ID of organization 100."""
    async with _client(db, authed, ADMIN) as client:
        connection_id = (await _create(client))["id"]
    async with _client(db, authed, OTHER_ADMIN) as stranger:
        assert (await stranger.get("/connections")).json() == []
        for method, path in [
            ("PATCH", f"/connections/{connection_id}"),
            ("DELETE", f"/connections/{connection_id}"),
            ("POST", f"/connections/{connection_id}/test"),
        ]:
            response = await stranger.request(
                method, path, json={} if method == "PATCH" else None
            )
            assert response.status_code == 404, path
        response = await stranger.put(
            "/settings", json=_settings_body(active_connection_id=connection_id)
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "connection_not_found"
    assert probe.targets == []


async def test_activation_requires_a_passed_test(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        refused = await client.put(
            "/settings", json=_settings_body(active_connection_id=connection["id"])
        )
        assert refused.status_code == 422
        assert refused.json()["detail"]["code"] == "connection_not_tested"
        tested = await client.post(f"/connections/{connection['id']}/test")
        assert tested.json()["last_test_ok"] is True
        assert tested.json()["capabilities"] == {
            "tool_calling": True,
            "streaming": True,
        }
        assert probe.targets[0].credentials == {"api_key": SECRET}
        await _activate(client, connection["id"])
        settings_body = (await client.get("/settings")).json()
        listed = (await client.get("/connections")).json()
    assert settings_body["active_connection_id"] == connection["id"]
    assert settings_body["status"] == "ok"
    assert listed[0]["active"] is True
    async with _client(db, authed, USER) as member:
        status = (await member.get("/status")).json()
    assert (status["provider"], status["model"]) == ("openai_compatible", "own-model")


async def test_a_failed_test_is_recorded_and_blocks_activation(
    db: Database, authed: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        ai_settings,
        "PROBE",
        FakeProbe(ok=False, error="The provider rejected the credentials (HTTP 401)."),
    )
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        tested = (await client.post(f"/connections/{connection['id']}/test")).json()
        refused = await client.put(
            "/settings", json=_settings_body(active_connection_id=connection["id"])
        )
    assert tested["last_test_ok"] is False
    assert (
        tested["last_test_error"] == "The provider rejected the credentials (HTTP 401)."
    )
    assert refused.json()["detail"]["code"] == "connection_not_tested"


async def test_settings_change_while_the_active_connection_is_failing(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """Keeping a failing active connection must not block switching AI off or
    changing the data policy; only a new activation needs a passed test."""
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await _activate(client, connection["id"])
        await OrgSettingsRepository(db).mark_connection_failed(
            UUID(int=100),
            UUID(connection["id"]),
            "The provider rejected the credentials (HTTP 401).",
        )
        off = await client.put(
            "/settings",
            json=_settings_body(enabled=False, active_connection_id=connection["id"]),
        )
        restricted = await client.put(
            "/settings",
            json=_settings_body(
                active_connection_id=connection["id"], data_policy="restricted"
            ),
        )
    assert off.status_code == 200, off.text
    assert off.json()["enabled"] is False
    assert restricted.status_code == 200, restricted.text
    assert restricted.json()["data_policy"] == "restricted"


async def test_active_connection_cannot_be_deleted(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """Review Focus 1."""
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await _activate(client, connection["id"])
        refused = await client.delete(f"/connections/{connection['id']}")
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "connection_active"
        assert (await client.put("/settings", json=_settings_body())).status_code == 200
        assert (
            await client.delete(f"/connections/{connection['id']}")
        ).status_code == 204


async def test_editing_the_active_connection_retests_first(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await _activate(client, connection["id"])
        probe.ok, probe.error = (
            False,
            "The model answered without calling the test tool.",
        )
        refused = await client.patch(
            f"/connections/{connection['id']}", json={"model": "broken-model"}
        )
        assert refused.status_code == 422
        assert refused.json()["detail"] == {
            "code": "test_failed",
            "message": "The model answered without calling the test tool.",
        }
        assert (await client.get("/connections")).json()[0]["model"] == "own-model"
        probe.ok, probe.error = True, None
        saved = await client.patch(
            f"/connections/{connection['id']}", json={"model": "better-model"}
        )
    assert saved.status_code == 200
    assert (saved.json()["model"], saved.json()["last_test_ok"]) == (
        "better-model",
        True,
    )
    assert probe.targets[-1].model == "better-model"


async def test_private_endpoint_is_refused_on_save(
    db: Database, authed: AssistantSettings
) -> None:
    """Review Focus 2 (save time; connect time is Task 3)."""
    async with _client(db, authed, ADMIN) as client:
        for base_url in (
            "https://10.0.0.5/v1",
            "https://inside.example.org/v1",
            "http://llm.example.org/v1",
            "https://nowhere.example.org/v1",
        ):
            response = await client.post(
                "/connections", json={**CREATE, "base_url": base_url}
            )
            assert response.status_code == 422, base_url
            assert response.json()["detail"]["code"] == "endpoint_not_allowed"


async def test_invalid_fields_name_the_field(
    db: Database, authed: AssistantSettings
) -> None:
    async with _client(db, authed, ADMIN) as client:
        missing_key = await client.post(
            "/connections",
            json={
                "name": "OpenAI",
                "provider": "openai",
                "model": "gpt-4.1",
                "credentials": {},
            },
        )
        duplicate_first = await client.post("/connections", json=CREATE)
        duplicate = await client.post("/connections", json=CREATE)
        blank_name = await client.patch(
            f"/connections/{duplicate_first.json()['id']}", json={"name": "   "}
        )
    assert blank_name.status_code == 422
    assert blank_name.json()["detail"]["field"] == "name"
    assert missing_key.json()["detail"] == {
        "code": "invalid_connection",
        "field": "api_key",
        "message": "This field is required.",
    }
    assert duplicate_first.status_code == 201
    assert (
        duplicate.status_code == 409
        and duplicate.json()["detail"]["code"] == "name_taken"
    )


async def test_instance_rules_for_own_connections(
    db: Database, authed: AssistantSettings
) -> None:
    only_openai = authed.model_copy(update={"allowed_providers": ["openai"]})
    async with _client(db, only_openai, ADMIN) as client:
        response = await client.post("/connections", json=CREATE)
    assert (
        response.status_code == 422
        and response.json()["detail"]["code"] == "provider_not_allowed"
    )
    no_own = authed.model_copy(update={"allow_org_connections": False})
    async with _client(db, no_own, ADMIN) as client:
        response = await client.post("/connections", json=CREATE)
        instance = (await client.get("/settings")).json()["instance"]
    assert (
        response.status_code == 409
        and response.json()["detail"]["code"] == "org_connections_unavailable"
    )
    assert instance["org_connections"] is False


async def test_fallback_needs_goat_ai(db: Database, authed: AssistantSettings) -> None:
    no_goat_ai = authed.model_copy(update={"default_provider": "none"})
    async with _client(db, no_goat_ai, ADMIN) as client:
        response = await client.put(
            "/settings", json=_settings_body(allow_default_fallback=True)
        )
        status = (await client.get("/settings")).json()["status"]
    assert (
        response.status_code == 422
        and response.json()["detail"]["code"] == "goat_ai_unavailable"
    )
    assert status == "no_connection"


async def test_unreadable_credentials_are_reported(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
    rotated_away = authed.model_copy(
        update={"secrets_key": SecretStr(Fernet.generate_key().decode())}
    )
    async with _client(db, rotated_away, ADMIN) as client:
        listed = (await client.get("/connections")).json()
        tested = await client.post(f"/connections/{connection['id']}/test")
    assert (listed[0]["credentials_readable"], listed[0]["key_last4"]) == (False, None)
    assert (
        tested.status_code == 409
        and tested.json()["detail"]["code"] == "credentials_unreadable"
    )


async def test_auth_off_makes_the_default_identity_an_admin(
    db: Database, settings: AssistantSettings
) -> None:
    """Spec §4.8: with AUTH=False the admin page is open to the default identity."""
    async with _client(db, settings, USER) as client:
        assert (await client.get("/settings")).status_code == 200
        assert (await client.get("/status")).json()["is_admin"] is True


async def test_missing_secrets_key_is_reported_to_the_admin(
    db: Database, authed: AssistantSettings
) -> None:
    """Review Focus: own connections are unavailable without ASSISTANT_SECRETS_KEY
    and the admin page can say why (the operator allows them; the key is missing)."""
    no_key = authed.model_copy(update={"secrets_key": SecretStr("")})
    async with _client(db, no_key, ADMIN) as client:
        instance = (await client.get("/settings")).json()["instance"]
        response = await client.post("/connections", json=CREATE)
    assert instance["org_connections"] is False
    assert instance["secrets_key_configured"] is False
    assert (
        response.status_code == 409
        and response.json()["detail"]["code"] == "org_connections_unavailable"
    )


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_cors_preflight_allows_the_settings_methods(
    db: Database, authed: AssistantSettings, method: str
) -> None:
    origin = authed.cors_origins[0]
    async with _client(db, authed, ADMIN) as client:
        response = await client.options(
            f"/connections/{UUID(int=7)}",
            headers={"Origin": origin, "Access-Control-Request-Method": method},
        )
    assert response.status_code == 200
    assert method in response.headers["access-control-allow-methods"]
    assert response.headers["access-control-allow-origin"] == origin


async def test_validation_errors_do_not_echo_the_key(
    db: Database, authed: AssistantSettings
) -> None:
    """FastAPI's default 422 puts the submitted value in ``detail[].input``."""
    vertex_file = {"type": "service_account", "private_key": SECRET}
    async with _client(db, authed, ADMIN) as client:
        connection_id = (await _create(client))["id"]
        responses = [
            # A POST missing its name, with a key in the body.
            await client.post("/connections", json={**CREATE, "name": None}),
            await client.post(
                "/connections", json={k: v for k, v in CREATE.items() if k != "name"}
            ),
            # A PATCH whose credentials are a string.
            await client.patch(
                f"/connections/{connection_id}", json={"credentials": SECRET}
            ),
            # A Vertex key file sent as an object instead of text.
            await client.post(
                "/connections",
                json={
                    "name": "Vertex",
                    "provider": "vertex",
                    "region": "us-east5",
                    "model": "claude-sonnet",
                    "credentials": {"service_account_json": vertex_file},
                },
            ),
        ]
    for response in responses:
        assert response.status_code == 422, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "invalid_request"
        assert set(detail) <= {"code", "field", "message"}
        assert "sk-secret" not in response.text and "abcd1234" not in response.text
    assert responses[1].json()["detail"]["field"] == "name"
    assert responses[3].json()["detail"]["field"] == "credentials.service_account_json"


async def test_an_edit_stores_its_test_result_with_the_change(
    db: Database, authed: AssistantSettings, probe: FakeProbe
) -> None:
    """The new configuration and its passed test are one write."""
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await _activate(client, connection["id"])
        probe.error = None
        saved = await client.patch(
            f"/connections/{connection['id']}", json={"model": "better-model"}
        )
    assert saved.status_code == 200
    stored = await db.pool.fetchrow(f"SELECT * FROM {db.t('connection')}")
    assert stored is not None
    assert (stored["model"], stored["last_test_ok"]) == ("better-model", True)
    assert stored["capabilities"] == {"tool_calling": True, "streaming": True}
    assert stored["last_test_error"] is None


async def test_an_edit_that_races_an_activation_is_refused(
    db: Database,
    authed: AssistantSettings,
    probe: FakeProbe,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The edit read the connection as inactive; an admin activates it before the
    write. Resetting its test then would leave the active connection untested."""
    repo = OrgSettingsRepository(db)
    original = ai_settings._profile

    async def activate_meanwhile(caller: Any, target: Target) -> dict[str, Any]:
        profile = await original(caller, target)
        await repo.record_test(
            UUID(int=100), target.connection_id, ok=True, error=None, capabilities={}
        )
        await repo.save_settings(
            UUID(int=100),
            enabled=True,
            active_connection_id=target.connection_id,
            data_policy="standard",
            allow_default_fallback=False,
            updated_by=ADMIN,
            require_tested=True,
        )
        return profile

    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        monkeypatch.setattr(ai_settings, "_profile", activate_meanwhile)
        refused = await client.patch(
            f"/connections/{connection['id']}", json={"model": "other-model"}
        )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "connection_changed"
    stored = await db.pool.fetchrow(f"SELECT * FROM {db.t('connection')}")
    assert stored is not None
    assert (stored["model"], stored["last_test_ok"]) == ("own-model", True)


async def test_editing_needs_the_provider_to_be_allowed(
    db: Database, authed: AssistantSettings
) -> None:
    async with _client(db, authed, ADMIN) as client:
        connection_id = (await _create(client))["id"]
    only_openai = authed.model_copy(update={"allowed_providers": ["openai"]})
    async with _client(db, only_openai, ADMIN) as client:
        response = await client.patch(
            f"/connections/{connection_id}", json={"model": "other-model"}
        )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "connection_not_allowed"


class BlockedProbe(FakeProbe):
    """A probe that waits for the test to let it finish."""

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, target: Target, policy: EndpointPolicy) -> ProbeResult:
        self.started.set()
        await self.release.wait()
        return await super().__call__(target, policy)


async def test_one_probe_per_connection_at_a_time(
    db: Database, authed: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocked = BlockedProbe()
    monkeypatch.setattr(ai_settings, "PROBE", blocked)
    async with _client(db, authed, ADMIN) as client:
        first = await _create(client)
        second = await _create(client, name="Second")
        running = asyncio.create_task(client.post(f"/connections/{first['id']}/test"))
        await asyncio.wait_for(blocked.started.wait(), 5)
        again = await client.post(f"/connections/{first['id']}/test")
        # Another connection is not held up by it.
        blocked.release.set()
        other = await client.post(f"/connections/{second['id']}/test")
        finished = await running
        after = await client.post(f"/connections/{first['id']}/test")
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "test_in_progress"
    assert other.status_code == 200
    assert finished.status_code == 200
    assert after.status_code == 200
    assert len(blocked.targets) == 3


async def test_an_edit_probe_is_single_flight_too(
    db: Database, authed: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    probe = FakeProbe()
    monkeypatch.setattr(ai_settings, "PROBE", probe)
    async with _client(db, authed, ADMIN) as client:
        connection = await _create(client)
        await _activate(client, connection["id"])
        blocked = BlockedProbe()
        monkeypatch.setattr(ai_settings, "PROBE", blocked)
        running = asyncio.create_task(
            client.patch(
                f"/connections/{connection['id']}", json={"model": "slow-model"}
            )
        )
        await asyncio.wait_for(blocked.started.wait(), 5)
        again = await client.post(f"/connections/{connection['id']}/test")
        blocked.release.set()
        finished = await running
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "test_in_progress"
    assert finished.status_code == 200


async def test_listing_reads_the_settings_once(
    db: Database, authed: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with _client(db, authed, ADMIN) as client:
        for name in ("A", "B", "C"):
            await _create(client, name=name)
        reads: list[UUID] = []
        original = OrgSettingsRepository.get_settings

        async def counting(self: OrgSettingsRepository, organization_id: UUID) -> Any:
            reads.append(organization_id)
            return await original(self, organization_id)

        monkeypatch.setattr(OrgSettingsRepository, "get_settings", counting)
        listed = await client.get("/connections")
    assert len(listed.json()) == 3
    assert len(reads) == 1
