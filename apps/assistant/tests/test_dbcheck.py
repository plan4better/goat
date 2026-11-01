"""The database privileges the assistant needs (Plan 4 review: customer.can
runs with the caller's privileges and reads core's tables).

Roles are cluster-wide and the local Postgres is shared by every checkout, so
the tests that create one run only with ASSISTANT_TEST_ROLES=1 (CI's Postgres is
throwaway and sets it); the test database user must then be a superuser (on
PostgreSQL 16 and later CREATEROLE is not enough to SET ROLE to the new role). The test against a predefined role creates nothing and always runs
where the user may SET ROLE to it."""

import logging
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio

from assistant import app as app_module
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.dbcheck import (
    AUTHZ_FUNCTIONS,
    CREDIT_FUNCTIONS,
    CUSTOMER_READS,
    missing_privileges,
)
from tests.conftest import BILLING_SQL

ROOT = Path(__file__).resolve().parents[3]
AUTHZ_SQL = (
    ROOT / "apps" / "core" / "src" / "core" / "db" / "sql" / "functions" / "authz"
)
GRANTS = ROOT / "apps" / "assistant" / "sql" / "grants.sql"
SRC = ROOT / "apps" / "assistant" / "src" / "assistant"


def test_the_check_covers_every_table_the_authz_functions_read() -> None:
    sql = "\n".join(path.read_text() for path in sorted(AUTHZ_SQL.glob("*.sql")))
    names = {m.strip('"') for m in re.findall(r'customer\.("?[a-z_]+"?)', sql)}
    defined = set(re.findall(r"FUNCTION customer\.([a-z_]+)", sql))
    # Every function the authz files define is one the check looks for ...
    assert defined <= set(AUTHZ_FUNCTIONS), sorted(defined - set(AUTHZ_FUNCTIONS))
    # ... and every other name they use is a table the check (and grants.sql) covers.
    tables = names - defined
    assert tables <= set(CUSTOMER_READS), sorted(tables - set(CUSTOMER_READS))


def test_the_check_covers_the_services_own_reads() -> None:
    own = set()
    for path in SRC.rglob("*.py"):
        own |= set(
            re.findall(r"\.customer\(\s*[\"']([a-z_]+)[\"']\s*\)", path.read_text())
        )
    assert own, "expected Database.customer(...) lookups in the service"
    # Tables need SELECT (CUSTOMER_READS), functions EXECUTE (AUTHZ_FUNCTIONS,
    # CREDIT_FUNCTIONS).
    known = set(CUSTOMER_READS) | set(AUTHZ_FUNCTIONS) | set(CREDIT_FUNCTIONS)
    assert own <= known, sorted(own - known)


DEFAULT_FUNCTION_GRANT = (
    "ALTER DEFAULT PRIVILEGES IN SCHEMA customer\n"
    "  GRANT EXECUTE ON FUNCTIONS TO goat_assistant;"
)


def test_grants_file_lists_exactly_the_checked_tables() -> None:
    text = GRANTS.read_text()
    block = re.search(r"GRANT SELECT ON\s+(.*?)\s+TO goat_assistant;", text, re.S)
    assert block, "grants.sql must have one GRANT SELECT ON customer.* block"
    granted = {
        name.strip().removeprefix("customer.").strip('"')
        for name in block.group(1).split(",")
    }
    assert granted == set(CUSTOMER_READS)
    assert (
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA customer TO goat_assistant;" in text
    )
    assert (
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA assistant TO goat_assistant;"
        in text
    )
    # Core's initial_data drops and re-creates its functions on every deploy,
    # and a dropped function loses its grants: the credit functions, which are
    # not executable by everyone, keep the role's EXECUTE only through the
    # schema's default privileges.
    assert DEFAULT_FUNCTION_GRANT in text
    # By name as well: the file fails when it runs before initial_data.
    named = re.search(
        r"GRANT EXECUTE ON FUNCTION\s+(.*?)\s+TO goat_assistant;", text, re.S
    )
    assert named, "grants.sql must grant the AI credit functions by name"
    assert {
        item.strip().removeprefix("customer.").split("(")[0]
        for item in re.split(r",\s*(?=customer\.)", named.group(1))
    } == set(CREDIT_FUNCTIONS)


@pytest_asyncio.fixture
async def conn(db: Database) -> AsyncIterator[asyncpg.Connection]:
    async with db.pool.acquire() as connection:
        yield connection


async def test_the_credit_functions_keep_the_grant_when_core_reinstalls_them(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    """grants.sql's default privileges, run as the role that installs core's
    functions, give a function re-created by initial_data (drop, create,
    revoke from PUBLIC) the role's EXECUTE again. pg_monitor stands in for the
    assistant's role; everything is rolled back."""
    schema = settings.customer_schema

    async def reinstall() -> bool:
        for name in CREDIT_FUNCTIONS:
            await conn.execute(f'DROP FUNCTION "{schema}".{name} CASCADE')
            sql = (BILLING_SQL / f"{name}.sql").read_text()
            await conn.execute(sql.replace("customer.", f'"{schema}".'))
        allowed = await conn.fetch(
            "SELECT has_function_privilege('pg_monitor', p.oid, 'EXECUTE') AS ok "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = $1 AND p.proname = ANY($2::text[])",
            schema,
            list(CREDIT_FUNCTIONS),
        )
        assert len(allowed) == len(CREDIT_FUNCTIONS)
        return all(row["ok"] for row in allowed)

    transaction = conn.transaction()
    await transaction.start()
    try:
        await conn.execute(
            f'GRANT EXECUTE ON FUNCTION "{schema}".ai_credits_left(uuid) TO pg_monitor'
        )
        # A grant by name alone is gone after the reinstall ...
        assert not await reinstall()
        await conn.execute(
            DEFAULT_FUNCTION_GRANT.replace("customer", f'"{schema}"').replace(
                "goat_assistant", "pg_monitor"
            )
        )
        # ... the default privileges are not.
        assert await reinstall()
    finally:
        await transaction.rollback()


async def test_owner_has_every_privilege_on_the_assistant_tables(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    missing = await missing_privileges(
        conn, schema=settings.db_schema, customer_schema=settings.customer_schema
    )
    # The test schema has the assistant tables but only a few of core's
    # tables and no authz functions: those are reported as not migrated.
    assert not [
        item
        for item in missing
        if item.startswith(
            ("SELECT ON", "INSERT ON", "UPDATE ON", "DELETE ON", "USAGE ON")
        )
    ]
    assert (
        f'table "{settings.customer_schema}"."folder" (run core\'s migration)'
        in missing
    )
    assert (
        f'function "{settings.customer_schema}".effective_role (run core\'s initial_data)'
        in missing
    )
    # Core's AI credit functions are installed there (conftest), and found.
    assert not [item for item in missing if any(f in item for f in CREDIT_FUNCTIONS)]


async def test_a_role_without_schema_usage_is_reported_not_raised(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    # pg_monitor is a predefined role with no USAGE on the test schema. A lookup
    # by name would raise "permission denied for schema" for it.
    transaction = conn.transaction()
    await transaction.start()
    try:
        try:
            await conn.execute("SET LOCAL ROLE pg_monitor")
        except asyncpg.InsufficientPrivilegeError:
            pytest.skip("the test database user cannot SET ROLE pg_monitor")
        missing = await missing_privileges(
            conn, schema=settings.db_schema, customer_schema=settings.customer_schema
        )
    finally:
        await transaction.rollback()
    assert f'USAGE ON SCHEMA "{settings.db_schema}"' in missing
    assert f'USAGE ON SCHEMA "{settings.customer_schema}"' in missing
    # The object checks of a schema without USAGE are skipped.
    assert not [item for item in missing if 'ON "' in item and "SCHEMA" not in item]


needs_roles = pytest.mark.skipif(
    os.environ.get("ASSISTANT_TEST_ROLES") != "1",
    reason="creates a cluster-wide role; set ASSISTANT_TEST_ROLES=1 on a throwaway Postgres",
)


async def _with_role(
    conn: asyncpg.Connection, settings: AssistantSettings, role: str, *grants: str
) -> list[str]:
    await conn.execute(f'DROP ROLE IF EXISTS "{role}"')
    await conn.execute(f'CREATE ROLE "{role}" NOLOGIN')
    try:
        for grant in grants:
            await conn.execute(grant.format(role=f'"{role}"'))
        async with conn.transaction():
            await conn.execute(f'SET LOCAL ROLE "{role}"')
            return await missing_privileges(
                conn,
                schema=settings.db_schema,
                customer_schema=settings.customer_schema,
            )
    finally:
        # Only when the role exists, so a failed CREATE is not masked.
        if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role):
            await conn.execute(f'DROP OWNED BY "{role}"')
            await conn.execute(f'DROP ROLE IF EXISTS "{role}"')


@needs_roles
async def test_a_role_without_grants_is_told_what_it_lacks(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    missing = await _with_role(
        conn, settings, f"assistant_dbcheck_nogrants_{os.getpid()}"
    )
    assert f'USAGE ON SCHEMA "{settings.db_schema}"' in missing


@needs_roles
async def test_a_role_with_usage_only_is_told_which_tables_it_lacks(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    missing = await _with_role(
        conn,
        settings,
        f"assistant_dbcheck_usage_{os.getpid()}",
        f'GRANT USAGE ON SCHEMA "{settings.db_schema}" TO {{role}}',
    )
    assert f'SELECT ON "{settings.db_schema}"."conversation"' in missing
    assert f'USAGE ON SCHEMA "{settings.db_schema}"' not in missing


@needs_roles
async def test_a_role_without_execute_on_the_credit_functions_is_told(
    conn: asyncpg.Connection, settings: AssistantSettings
) -> None:
    """Core's install revokes EXECUTE on them from PUBLIC (conftest installs
    its files): a role that can read everything still lacks them."""
    schema = settings.customer_schema
    missing = await _with_role(
        conn,
        settings,
        f"assistant_dbcheck_credits_{os.getpid()}",
        f'GRANT USAGE ON SCHEMA "{schema}" TO {{role}}',
        f'GRANT SELECT ON ALL TABLES IN SCHEMA "{schema}" TO {{role}}',
    )
    lacking = [item for item in missing if item.startswith("EXECUTE ON FUNCTION")]
    for name in CREDIT_FUNCTIONS:
        assert any(f"{name}(" in item for item in lacking), (name, missing)


async def test_start_logs_what_is_missing_and_never_aborts(
    db: Database,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def lacking(*args: object, **kwargs: object) -> list[str]:
        return ['SELECT ON "customer"."folder"']

    monkeypatch.setattr(app_module, "missing_privileges", lacking)
    with caplog.at_level(logging.ERROR, logger="assistant.app"):
        await app_module._log_missing_privileges(db, settings)
    assert 'SELECT ON "customer"."folder"' in caplog.text
    assert "grants.sql" in caplog.text


async def test_a_failing_check_is_logged_not_raised(
    db: Database,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def explode(*args: object, **kwargs: object) -> list[str]:
        raise RuntimeError("catalog unreadable")

    monkeypatch.setattr(app_module, "missing_privileges", explode)
    with caplog.at_level(logging.ERROR, logger="assistant.app"):
        await app_module._log_missing_privileges(db, settings)
    assert "Checking the database privileges failed" in caplog.text
