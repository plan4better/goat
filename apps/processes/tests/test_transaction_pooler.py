"""processes's query pool behind a connection pooler in transaction mode.

With POSTGRES_TRANSACTION_POOLER the pool caches no prepared statements and
sends only its session name at startup; a pooler with stock settings refuses
the keepalive settings and loses track of cached statements.
"""

import asyncpg
import pytest

from processes.config import settings


@pytest.fixture
def pool_kwargs(monkeypatch: pytest.MonkeyPatch) -> dict:
    captured: dict = {}

    async def create_pool(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(asyncpg, "create_pool", create_pool)
    return captured


@pytest.mark.parametrize("pooler", [False, True])
async def test_the_pool_follows_the_switch(
    monkeypatch: pytest.MonkeyPatch, pool_kwargs: dict, pooler: bool
) -> None:
    monkeypatch.setattr(settings, "POSTGRES_TRANSACTION_POOLER", pooler)
    from processes.services import access

    monkeypatch.setattr(access, "_pool", None)
    await access.get_pool()

    assert pool_kwargs["server_settings"]["application_name"] == "goat-processes"
    if pooler:
        assert pool_kwargs["statement_cache_size"] == 0
        assert set(pool_kwargs["server_settings"]) == {"application_name"}
    else:
        assert "statement_cache_size" not in pool_kwargs


@pytest.mark.parametrize(("value", "enabled"), [("", False), (" on ", True)])
def test_any_spelling_starts_the_service(
    monkeypatch: pytest.MonkeyPatch, value: str, enabled: bool
) -> None:
    """A blank or padded value must not stop processes from starting."""
    from processes.config import Settings

    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("POSTGRES_TRANSACTION_POOLER", value)
    assert Settings(_env_file=None).POSTGRES_TRANSACTION_POOLER is enabled
