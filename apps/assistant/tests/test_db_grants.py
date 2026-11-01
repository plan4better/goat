"""grants.sql against core's real schema and authz functions.

Needs a database migrated by core (alembic upgrade head) with its SQL
functions installed (initial_data's first step): the CI `alembic` job, or the
slot's database locally:
ASSISTANT_GRANTS_CHECK_DSN=postgresql://<user>:<pw>@localhost:5432/<db> uv run pytest tests/test_db_grants.py
The connecting user must be a superuser (on PostgreSQL 16 and later CREATEROLE
is not enough to SET ROLE to the new role). It creates and drops one NOLOGIN role, and roles are cluster-wide,
so it also needs ASSISTANT_TEST_ROLES=1 (set in CI's throwaway Postgres, never
on a shared one).
"""

import os
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

from assistant.dbcheck import missing_privileges

DSN = os.environ.get("ASSISTANT_GRANTS_CHECK_DSN", "")
GRANTS = Path(__file__).resolve().parents[1] / "sql" / "grants.sql"
ROLE = f"goat_assistant_grants_check_{os.getpid()}"

pytestmark = [
    pytest.mark.skipif(
        not DSN, reason="needs ASSISTANT_GRANTS_CHECK_DSN (a database migrated by core)"
    ),
    pytest.mark.skipif(
        os.environ.get("ASSISTANT_TEST_ROLES") != "1",
        reason="creates a cluster-wide role; set ASSISTANT_TEST_ROLES=1 on a throwaway Postgres",
    ),
]


async def test_the_documented_grants_let_customer_can_run() -> None:
    owner = await asyncpg.connect(DSN)
    try:
        if await owner.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", ROLE):
            # Left over from an interrupted run.
            await owner.execute(f'DROP OWNED BY "{ROLE}"')
            await owner.execute(f'DROP ROLE "{ROLE}"')
        await owner.execute(f'CREATE ROLE "{ROLE}" NOLOGIN')
        await owner.execute(GRANTS.read_text().replace("goat_assistant", f'"{ROLE}"'))
        async with owner.transaction():
            await owner.execute(f'SET LOCAL ROLE "{ROLE}"')
            assert (
                await missing_privileges(
                    owner, schema="assistant", customer_schema="customer"
                )
                == []
            )
            # The complete table list is proven by missing_privileges == [] and
            # test_dbcheck's scan of the authz SQL. This call runs the function
            # as the role on top: with unknown ids it reads the resource's own
            # table, then returns early, so it is a smoke test, not the proof.
            for resource_type in ("project", "layer", "folder"):
                allowed = await owner.fetchval(
                    "SELECT customer.can($1, $2, $3, 'read')",
                    resource_type,
                    uuid4(),
                    uuid4(),
                )
                assert allowed in (False, None)
            await owner.execute("DELETE FROM assistant.conversation WHERE false")
    finally:
        # Only when the role exists, so a failed CREATE is not masked.
        if await owner.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", ROLE):
            await owner.execute(f'DROP OWNED BY "{ROLE}"')
            await owner.execute(f'DROP ROLE IF EXISTS "{ROLE}"')
        await owner.close()
