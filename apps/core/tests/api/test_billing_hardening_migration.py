"""0013 on the test schema (built from the models, so already at its end
state): downgrade and upgrade must both work and upgrade must be re-runnable."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.core.config import settings
from core.db.session import session_manager

MIG = Path(__file__).resolve().parents[2] / "alembic/versions/0013_billing_hardening.py"
S = settings.SCHEMA
COLUMNS = {"entitlement_as_of", "deleted_at", "odoo_sync_pending"}
INDEXES = ("uq_credit_usage_compute_job", "idx_organization_odoo_sync_pending")


def _load():
    spec = importlib.util.spec_from_file_location("mig0013", MIG)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(sync_conn, step):
    with Operations.context(MigrationContext.configure(sync_conn)):
        step()


def _state(sync_conn):
    columns = {
        c["name"] for c in sa.inspect(sync_conn).get_columns("organization", schema=S)
    }
    indexes = {
        row[0]
        for row in sync_conn.execute(
            sa.text("SELECT indexname FROM pg_indexes WHERE schemaname = :s"), {"s": S}
        )
    }
    return columns & COLUMNS, {i for i in INDEXES if i in indexes}


@pytest.mark.asyncio
async def test_the_migration_round_trips():
    mig = _load()
    async with session_manager.connect() as conn:
        try:
            await conn.run_sync(_run, mig.downgrade)
            assert await conn.run_sync(_state) == (set(), set())
            await conn.run_sync(_run, mig.downgrade)  # nothing left to drop
        finally:
            await conn.run_sync(_run, mig.upgrade)
        assert await conn.run_sync(_state) == (COLUMNS, set(INDEXES))
        await conn.run_sync(_run, mig.upgrade)  # re-run is a no-op
        assert await conn.run_sync(_state) == (COLUMNS, set(INDEXES))
        await conn.commit()
