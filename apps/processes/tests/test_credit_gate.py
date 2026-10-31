import pytest
from fastapi import HTTPException

from processes.services import access, credit_gate

USER = "00000000-0000-0000-0000-000000000001"


@pytest.fixture(autouse=True)
def billing_on(monkeypatch):
    monkeypatch.setattr(credit_gate.settings, "BILLING_ENABLED", True)


class _Pool:
    """Answers the gate's query the way customer.credits_exhausted would."""

    def __init__(self, exhausted=None, exc=None):
        self.exhausted, self.exc = exhausted, exc
        self.queries: list[tuple] = []

    async def fetchval(self, sql, *args):
        self.queries.append((sql, args))
        if self.exc:
            raise self.exc
        return self.exhausted


def _use(monkeypatch, pool):
    async def _get_pool():
        return pool

    monkeypatch.setattr(access, "_get_pool", _get_pool)
    return pool


@pytest.mark.asyncio
async def test_blocks_when_credits_are_exhausted(monkeypatch):
    pool = _use(monkeypatch, _Pool(exhausted=True))
    with pytest.raises(HTTPException) as ei:
        await credit_gate.assert_credits_available(USER)
    assert ei.value.status_code == 402
    sql, args = pool.queries[0]
    assert "credits_exhausted" in sql and args == (USER,)


@pytest.mark.asyncio
async def test_allows_when_credits_are_left(monkeypatch):
    _use(monkeypatch, _Pool(exhausted=False))
    await credit_gate.assert_credits_available(USER)  # no raise


@pytest.mark.asyncio
async def test_a_user_without_an_organization_is_allowed(monkeypatch):
    _use(monkeypatch, _Pool(exhausted=None))
    await credit_gate.assert_credits_available(USER)  # no raise


@pytest.mark.asyncio
async def test_fails_open_on_a_database_error(monkeypatch, caplog):
    _use(monkeypatch, _Pool(exc=RuntimeError("db down")))
    with caplog.at_level("WARNING", logger=credit_gate.logger.name):
        await credit_gate.assert_credits_available(USER)  # must NOT raise
    assert any("allowing" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_checks_nothing_with_billing_off(monkeypatch):
    # Self-hosted: the database is not even asked.
    monkeypatch.setattr(credit_gate.settings, "BILLING_ENABLED", False)
    pool = _use(monkeypatch, _Pool(exhausted=True))
    await credit_gate.assert_credits_available(USER)  # no raise
    assert pool.queries == []


@pytest.mark.asyncio
async def test_deleting_data_is_never_refused(monkeypatch):
    # Out of credits, an organization must still be able to free space.
    _use(monkeypatch, _Pool(exhausted=True))
    for process_id in ("layer_delete", "layer_delete_multi", "bundle_artifact_delete"):
        await credit_gate.assert_credits_available(USER, process_id)  # no raise
    with pytest.raises(HTTPException):
        await credit_gate.assert_credits_available(USER, "buffer")
