"""Migration 0021 holds every schema change of the GOAT Style release, so the data
step of 0022 runs after they are committed and takes no table lock of its own.
Its statements on the existing tables wait for a lock only as long as
`LOCK_TIMEOUT`, then the revision fails and leaves nothing behind.

Run on a scratch schema with minimal copies of the four tables it changes: the
test schema is built from the models, where 0021 has nothing left to do."""

import ast
import asyncio
import importlib.util
import os
from pathlib import Path
from types import ModuleType

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.db.session import session_manager

ALEMBIC = Path(__file__).resolve().parents[2] / "alembic"
MIGRATION = ALEMBIC / "versions" / "0021_layer_styles.py"
TABLES = (
    "CREATE TABLE {s}.layer (id uuid PRIMARY KEY)",
    "CREATE TABLE {s}.layer_project (id serial PRIMARY KEY)",
    "CREATE TABLE {s}.layer_project_group (id serial PRIMARY KEY)",
    "CREATE TABLE {s}.project (id uuid PRIMARY KEY)",
)


def load(schema: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0021", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.S = schema
    return module


def step(module: ModuleType, name: str):  # noqa: ANN201
    def run(connection: sa.Connection) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()

    return run


async def columns(schema: str, table: str) -> set[str]:
    async with session_manager.connect() as connection:
        rows = await connection.execute(
            sa.text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = :s AND table_name = :t"
            ),
            {"s": schema, "t": table},
        )
        return set(rows.scalars())


@pytest.fixture
async def scratch() -> str:
    schema = f"migration_0021_{os.getpid()}"
    async with session_manager.connect() as connection:
        await connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        for statement in TABLES:
            await connection.execute(sa.text(statement.format(s=schema)))
    yield schema
    async with session_manager.connect() as connection:
        await connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))


@pytest.mark.asyncio
async def test_the_upgrade_adds_every_column_of_the_release(scratch: str) -> None:
    module = load(scratch)
    async with session_manager.transaction() as connection:
        await connection.run_sync(step(module, "upgrade"))
    assert {"visible", "expanded"} <= await columns(scratch, "layer_project_group")
    assert {
        "active_style_id",
        "visible",
        "position",
        "time_value",
        "legend_expanded",
    } <= await columns(scratch, "layer_project")
    assert {"locale", "scene"} <= await columns(scratch, "project")
    assert "data_snapshot" in await columns(scratch, "layer")

    async with session_manager.transaction() as connection:
        await connection.run_sync(step(module, "upgrade"))
    async with session_manager.transaction() as connection:
        await connection.run_sync(step(module, "downgrade"))
    assert await columns(scratch, "layer_project_group") == {"id"}
    assert await columns(scratch, "layer_project") == {"id"}


@pytest.mark.asyncio
async def test_a_table_another_session_holds_fails_the_upgrade_quickly(
    scratch: str,
) -> None:
    """A long transaction reading `layer_project` keeps the ALTER from its lock:
    the revision gives up after `LOCK_TIMEOUT` and rolls back, so no query
    queues behind it. Once the reader is done, the revision runs."""
    module = load(scratch)
    module.LOCK_TIMEOUT = "200ms"
    async with session_manager.transaction() as reader:
        await reader.execute(
            sa.text(f'LOCK TABLE "{scratch}".layer_project IN ACCESS SHARE MODE')
        )
        loop = asyncio.get_running_loop()
        started = loop.time()
        with pytest.raises(sa.exc.DBAPIError) as failure:
            async with session_manager.transaction() as connection:
                # Without a lock timeout the ALTER would wait for the reader
                # forever; this only ends the test.
                await connection.execute(sa.text("SET LOCAL statement_timeout = '5s'"))
                await connection.run_sync(step(module, "upgrade"))
        assert getattr(failure.value.orig, "sqlstate", None) == "55P03"
        assert loop.time() - started < 3
    assert "active_style_id" not in await columns(scratch, "layer_project")
    assert not await columns(scratch, "layer_style")

    async with session_manager.transaction() as connection:
        await connection.run_sync(step(module, "upgrade"))
    assert "active_style_id" in await columns(scratch, "layer_project")


def configure_calls(source: str) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "configure"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "context"
    ]


def test_migrations_commit_each_revision_on_its_own() -> None:
    """Online and offline, `env.py` gives every revision its own transaction, so
    0021's locks end before 0022 converts."""
    calls = configure_calls((ALEMBIC / "env.py").read_text())
    assert len(calls) == 2
    for call in calls:
        flags = {
            k.arg: k.value.value
            for k in call.keywords
            if isinstance(k.value, ast.Constant)
        }
        assert flags.get("transaction_per_migration") is True
