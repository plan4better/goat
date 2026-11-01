"""Liveness and readiness (spec §3): readiness follows the dependencies,
liveness does not, so a database outage drains the pod instead of restarting it."""

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from assistant.app import create_app
from assistant.bus import InMemoryEventBus, RedisEventBus
from assistant.config import AssistantSettings
from assistant.db import Database


class _DownPool:
    async def fetchval(self, query: str, *args: Any) -> Any:
        raise OSError("connection refused")


def _client(settings: AssistantSettings, services: object) -> AsyncClient:
    app = create_app(settings)
    # ASGITransport runs no lifespan; these are the services it would build.
    app.state.services = services
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://assistant.test"
    )


async def test_readyz_is_ok_with_database_and_bus(
    settings: AssistantSettings, db: Database
) -> None:
    services = SimpleNamespace(db=db, bus=InMemoryEventBus())
    async with _client(settings, services) as client:
        response = await client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {"database": "ok", "redis": "ok"},
    }


async def test_readyz_is_503_when_the_database_is_down(
    settings: AssistantSettings,
) -> None:
    services = SimpleNamespace(
        db=SimpleNamespace(pool=_DownPool()), bus=InMemoryEventBus()
    )
    async with _client(settings, services) as client:
        response = await client.get("/readyz")
    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {"database": "unavailable", "redis": "ok"},
    }


async def test_readyz_is_503_when_redis_is_down(
    settings: AssistantSettings, db: Database
) -> None:
    # Port 1 on loopback refuses at once: a real Redis client, no network.
    bus = RedisEventBus("redis://127.0.0.1:1/0")
    services = SimpleNamespace(db=db, bus=bus)
    try:
        async with _client(settings, services) as client:
            response = await client.get("/readyz")
    finally:
        await bus.close()
    assert response.status_code == 503
    body = response.json()
    assert body["checks"] == {"database": "ok", "redis": "unavailable"}
    # Neutral body: no driver error text reaches the caller.
    assert "refused" not in response.text.lower()


async def test_readyz_is_503_before_the_services_exist(
    settings: AssistantSettings,
) -> None:
    app = create_app(settings)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://a.test"
    ) as client:
        response = await client.get("/readyz")
    assert response.status_code == 503
    assert response.json() == {"status": "starting", "checks": {}}


@pytest.mark.parametrize("path", ["/healthz"])
async def test_healthz_stays_ok_when_dependencies_are_down(
    settings: AssistantSettings, path: str
) -> None:
    services = SimpleNamespace(
        db=SimpleNamespace(pool=_DownPool()), bus=InMemoryEventBus()
    )
    async with _client(settings, services) as client:
        response = await client.get(path)
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readyz_is_served_under_the_root_path(
    settings: AssistantSettings, db: Database
) -> None:
    # Behind compose's Caddy the prefix arrives unstripped (ROOT_PATH=/assistant).
    prefixed = settings.model_copy(update={"root_path": "/assistant"})
    services = SimpleNamespace(db=db, bus=InMemoryEventBus())
    async with _client(prefixed, services) as client:
        response = await client.get("/assistant/readyz")
    assert response.status_code == 200


async def test_readyz_runs_the_checks_concurrently(
    settings: AssistantSettings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    from assistant.routers import health

    monkeypatch.setattr(health, "READY_TIMEOUT_SECONDS", 0.3)

    class SlowBus(InMemoryEventBus):
        async def ping(self) -> None:
            await asyncio.sleep(5)

    class SlowPool:
        async def fetchval(self, query: str, *args: Any) -> Any:
            await asyncio.sleep(5)

    services = SimpleNamespace(db=SimpleNamespace(pool=SlowPool()), bus=SlowBus())
    async with _client(settings, services) as client:
        # Started once the client is built: the bound measures the checks.
        started = time.monotonic()
        response = await client.get("/readyz")
        elapsed = time.monotonic() - started
    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": "unavailable",
        "redis": "unavailable",
    }
    # Both timed out, yet the request took about one timeout, not two.
    assert elapsed < 0.55
