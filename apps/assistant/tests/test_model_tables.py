"""The model-layer tables, built from core's definitions (Task 1)."""

from uuid import UUID, uuid4

import asyncpg
import pytest

from assistant.db import Database

ORG = UUID(int=100)
OTHER_ORG = UUID(int=200)


async def _connection(
    db: Database, name: str = "Own", organization: UUID = ORG
) -> UUID:
    connection_id: UUID = await db.pool.fetchval(
        f"INSERT INTO {db.t('connection')} "
        "(organization_id, name, provider, model, credentials_encrypted) "
        "VALUES ($1, $2, 'openai', 'gpt-test', 'token') RETURNING id",
        organization,
        name,
    )
    return connection_id


async def test_connection_defaults(db: Database) -> None:
    connection_id = await _connection(db)
    row = await db.pool.fetchrow(
        f"SELECT * FROM {db.t('connection')} WHERE id = $1", connection_id
    )
    assert row is not None
    assert row["capabilities"] == {}
    assert row["last_test_ok"] is None
    assert row["base_url"] is None


async def test_connection_names_are_unique_per_organization(db: Database) -> None:
    await _connection(db, "Same")
    with pytest.raises(asyncpg.UniqueViolationError):
        await _connection(db, "Same")
    await _connection(db, "Same", organization=OTHER_ORG)


async def test_the_active_connection_cannot_be_deleted(db: Database) -> None:
    connection_id = await _connection(db)
    await db.pool.execute(
        f"INSERT INTO {db.t('organization_settings')} "
        "(organization_id, active_connection_id) VALUES ($1, $2)",
        ORG,
        connection_id,
    )
    # The foreign key is ON DELETE RESTRICT, read from the catalog: the error
    # alone cannot tell it from NO ACTION, as PostgreSQL 16 reports a RESTRICT
    # violation as 23503 (ForeignKeyViolationError) and newer servers as 23001
    # (RestrictViolationError). Both are integrity constraint violations.
    delete_rule = await db.pool.fetchval(
        "SELECT c.confdeltype::text FROM pg_constraint c "
        "JOIN pg_class t ON t.oid = c.conrelid "
        "JOIN pg_namespace n ON n.oid = t.relnamespace "
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey) "
        "WHERE c.contype = 'f' AND n.nspname = $1 "
        "AND t.relname = 'organization_settings' "
        "AND a.attname = 'active_connection_id'",
        db.settings.db_schema,
    )
    assert delete_rule == "r"
    with pytest.raises(asyncpg.IntegrityConstraintViolationError):
        await db.pool.execute(
            f"DELETE FROM {db.t('connection')} WHERE id = $1", connection_id
        )


async def test_settings_defaults_and_data_policy_check(db: Database) -> None:
    await db.pool.execute(
        f"INSERT INTO {db.t('organization_settings')} (organization_id) VALUES ($1)",
        ORG,
    )
    row = await db.pool.fetchrow(
        f"SELECT * FROM {db.t('organization_settings')} WHERE organization_id = $1", ORG
    )
    assert row is not None
    assert row["enabled"] is True
    assert row["active_connection_id"] is None
    assert row["data_policy"] == "restricted"
    assert row["allow_default_fallback"] is False
    with pytest.raises(asyncpg.CheckViolationError):
        await db.pool.execute(
            f"UPDATE {db.t('organization_settings')} SET data_policy = 'open'"
        )


async def test_one_usage_row_per_run_and_purpose(db: Database) -> None:
    run_id = uuid4()
    insert = (
        f"INSERT INTO {db.t('usage')} (run_id, user_id, provider, model, purpose) "
        "VALUES ($1, $2, 'test', 'test', $3)"
    )
    await db.pool.execute(insert, run_id, UUID(int=1), "main")
    await db.pool.execute(insert, run_id, UUID(int=1), "background")
    with pytest.raises(asyncpg.UniqueViolationError):
        await db.pool.execute(insert, run_id, UUID(int=1), "main")


async def test_seeded_identities(db: Database) -> None:
    rows = await db.pool.fetch(
        f"SELECT u.id, u.organization_id, r.name FROM {db.customer('user')} u "
        f"JOIN {db.customer('user_role')} ur ON ur.user_id = u.id "
        f"JOIN {db.customer('role')} r ON r.id = ur.role_id ORDER BY u.id"
    )
    assert [(r["id"], r["organization_id"], r["name"]) for r in rows] == [
        (UUID(int=1), ORG, "organization-viewer"),
        (UUID(int=2), ORG, "organization-viewer"),
        (UUID(int=3), ORG, "organization-admin"),
        (UUID(int=4), OTHER_ORG, "organization-admin"),
    ]
