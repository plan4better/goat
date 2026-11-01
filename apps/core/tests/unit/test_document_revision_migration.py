"""Migration 0013 adds the revision counters, who saved last, and the
assistant's undo record, the same columns a fresh database gets from the
models; rows that exist before it start at revision 1."""

import importlib.util
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import core.db.models.assistant  # noqa: F401  (registers the assistant tables)
import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.core.config import settings
from core.db.session import session_manager
from sqlmodel import SQLModel

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "0018_document_revision.py"
)

#: (table, column) the revision adds, by schema.
ADDED = {
    ("customer", "workflow", "revision"),
    ("customer", "workflow", "updated_by"),
    ("customer", "report_layout", "revision"),
    ("customer", "report_layout", "updated_by"),
    ("customer", "project", "builder_revision"),
    ("customer", "project", "updated_by"),
    ("assistant", "tool_call", "undo"),
}


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0013", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _recorded_upgrade() -> tuple[dict[tuple[str, str, str], sa.Column], set[Any]]:
    module = _load()
    schemas = {module.S: "customer", module.A: "assistant"}
    columns: dict[tuple[str, str, str], sa.Column] = {}
    fks: set[Any] = set()

    def add_column(table: str, column: sa.Column, schema: str) -> None:
        columns[(schemas[schema], table, column.name)] = column

    def ensure_fk(
        name: str,
        source: str,
        referent: str,
        local: list[str],
        remote: list[str],
        schema: str,
        ondelete: str | None = None,
        not_valid: bool = False,
    ) -> None:
        fks.add((source, tuple(local), referent, tuple(remote), ondelete))

    module.h = SimpleNamespace(add_column_if_missing=add_column, ensure_fk=ensure_fk)
    module.upgrade()
    return columns, fks


def _model_column(schema: str, table: str, column: str) -> sa.Column:
    # The models carry the schema names of the configuration they were
    # imported with; the test run maps them to its own schema.
    assistant = schema == "assistant"
    [model] = [
        t
        for t in SQLModel.metadata.tables.values()
        if t.name == table and (t.schema == settings.ASSISTANT_SCHEMA) == assistant
    ]
    return model.c[column]


def _default(column: sa.Column) -> str | None:
    default = column.server_default
    return None if default is None else str(default.arg)  # type: ignore[attr-defined]


@pytest.mark.unit
def test_the_upgrade_adds_the_columns_the_models_define() -> None:
    columns, fks = _recorded_upgrade()

    assert set(columns) == ADDED
    for key, added in columns.items():
        model = _model_column(*key)
        assert added.nullable == model.nullable, key
        assert type(added.type) is type(model.type), key
        assert _default(added) == _default(model), key
    for table in ("workflow", "report_layout", "project"):
        assert (table, ("updated_by",), "user", ("id",), "SET NULL") in fks


@pytest.mark.unit
def test_existing_rows_start_at_revision_1() -> None:
    columns, _ = _recorded_upgrade()

    for key in [k for k in ADDED if k[2].endswith("revision")]:
        assert columns[key].nullable is False, key
        assert _default(columns[key]) == "1", key


@pytest.mark.asyncio
async def test_the_upgrade_runs_on_a_database_before_it() -> None:
    """On tables shaped as before the revision, with rows in them: every row
    reads revision 1, a second upgrade changes nothing, and the downgrade
    removes the columns again."""
    module = _load()
    scratch = f"migration_0013_{os.getpid()}"
    module.S = module.A = scratch

    def columns(connection: sa.Connection, table: str) -> set[str]:
        return {c["name"] for c in sa.inspect(connection).get_columns(table, scratch)}

    def migrate(connection: sa.Connection, step: str) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()

    async with session_manager.connect() as connection:
        await connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE'))
        await connection.execute(sa.text(f'CREATE SCHEMA "{scratch}"'))
        try:
            for statement in (
                'CREATE TABLE "{s}"."user" (id uuid PRIMARY KEY)',
                'CREATE TABLE "{s}".project (id uuid PRIMARY KEY)',
                'CREATE TABLE "{s}".workflow (id uuid PRIMARY KEY)',
                'CREATE TABLE "{s}".report_layout (id uuid PRIMARY KEY)',
                'CREATE TABLE "{s}".tool_call (id uuid PRIMARY KEY)',
                'INSERT INTO "{s}".project VALUES (gen_random_uuid())',
                'INSERT INTO "{s}".workflow VALUES (gen_random_uuid())',
                'INSERT INTO "{s}".report_layout VALUES (gen_random_uuid())',
            ):
                await connection.execute(sa.text(statement.format(s=scratch)))

            await connection.run_sync(migrate, "upgrade")
            await connection.run_sync(migrate, "upgrade")

            revisions = (
                await connection.execute(
                    sa.text(
                        f'SELECT (SELECT revision FROM "{scratch}".workflow),'
                        f' (SELECT revision FROM "{scratch}".report_layout),'
                        f' (SELECT builder_revision FROM "{scratch}".project)'
                    )
                )
            ).one()
            assert tuple(revisions) == (1, 1, 1)
            assert "undo" in await connection.run_sync(columns, "tool_call")

            await connection.run_sync(migrate, "downgrade")
            assert await connection.run_sync(columns, "workflow") == {"id"}
            assert await connection.run_sync(columns, "report_layout") == {"id"}
            assert await connection.run_sync(columns, "project") == {"id"}
            assert await connection.run_sync(columns, "tool_call") == {"id"}
        finally:
            await connection.execute(
                sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE')
            )
