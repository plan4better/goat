"""Migration 0019 adds the AI-credit pool, the AI terms, the per-run charge
index and the hosting line of an answer, the same columns a fresh database
gets from the models; with billing on, existing organizations get their AI
allowance (a trial's amount, or seats times the per-editor amount)."""

import importlib.util
import json
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
from core.crud.crud_billing_terms import (
    DEFAULT_AI_CREDIT_TIERS,
    DEFAULT_AI_CREDITS_PER_EDITOR,
    DEFAULT_TRIAL,
)
from core.db.session import session_manager
from sqlmodel import SQLModel
from tests.billing import enable_billing

MIGRATION = (
    Path(__file__).resolve().parents[2] / "alembic" / "versions" / "0019_ai_credits.py"
)

#: (schema, table, column) the revision adds.
ADDED = {
    ("customer", "organization", "total_ai_credits"),
    ("customer", "organization", "used_ai_credits"),
    ("customer", "organization", "ai_credits_override"),
    ("customer", "billing_terms", "trial_ai_credits"),
    ("customer", "billing_terms", "ai_credits_per_editor"),
    ("customer", "billing_terms", "ai_credit_tiers"),
    ("assistant", "usage", "hosted_in"),
}


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0019", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _recorded_upgrade() -> tuple[dict[tuple[str, str, str], sa.Column], list[str]]:
    module = _load()
    schemas = {module.S: "customer", module.A: "assistant"}
    columns: dict[tuple[str, str, str], sa.Column] = {}
    statements: list[str] = []

    def add_column(table: str, column: sa.Column, schema: str) -> None:
        columns[(schemas[schema], table, column.name)] = column

    module.h = SimpleNamespace(
        add_column_if_missing=add_column,
        column_exists=lambda *_: False,
        table_exists=lambda *_: True,
    )
    module.op = SimpleNamespace(execute=lambda sql: statements.append(str(sql)))
    module.upgrade()
    return columns, statements


def _model_column(schema: str, table: str, column: str) -> sa.Column:
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


def _jsonb_literal(default: str) -> Any:
    """The JSON in a `'<json>'::jsonb` server default."""
    assert default.endswith("::jsonb"), default
    return json.loads(default[: -len("::jsonb")].strip("'"))


@pytest.mark.unit
def test_the_upgrade_adds_the_columns_the_models_define() -> None:
    columns, _ = _recorded_upgrade()

    assert set(columns) == ADDED
    for key, added in columns.items():
        model = _model_column(*key)
        assert added.nullable == model.nullable, key
        assert type(added.type) is type(model.type), key
        assert _default(added) == _default(model), key


@pytest.mark.unit
def test_the_column_defaults_are_cores_defaults() -> None:
    """The database defaults, the model and core's Python defaults agree."""
    columns, _ = _recorded_upgrade()

    def default(table: str, column: str) -> str:
        value = _default(columns[("customer", table, column)])
        assert value is not None
        return value

    assert (
        float(default("billing_terms", "trial_ai_credits"))
        == (DEFAULT_TRIAL["ai_credits"])
    )
    assert float(default("billing_terms", "ai_credits_per_editor")) == (
        DEFAULT_AI_CREDITS_PER_EDITOR
    )
    assert _jsonb_literal(default("billing_terms", "ai_credit_tiers")) == (
        DEFAULT_AI_CREDIT_TIERS
    )
    assert default("organization", "used_ai_credits") == "0"
    assert columns[("customer", "organization", "total_ai_credits")].nullable


@pytest.mark.unit
def test_the_upgrade_indexes_ai_charges_by_run_and_drops_the_token_rate() -> None:
    _, statements = _recorded_upgrade()
    sql = " ".join(statements)

    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_usage_ai_run" in sql
    assert "((payload->>'run_id')) WHERE category = 'ai'" in sql
    assert "DELETE FROM" in sql and "credit_rate WHERE category = 'ai'" in sql


@pytest.mark.asyncio
@pytest.mark.parametrize("billing", [True, False])
async def test_the_upgrade_runs_on_a_database_before_it(
    monkeypatch: pytest.MonkeyPatch, billing: bool
) -> None:
    """On tables shaped as before the revision, with rows in them: with billing
    on, a trial gets the trial's AI credits and a subscription seats times the
    per-editor amount (unlimited seats, unlimited AI credits); with billing off
    every organization stays unlimited. A second upgrade changes nothing, an
    answer is charged once per run, and the downgrade removes it all again."""
    if billing:
        enable_billing(monkeypatch)
    else:
        monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    module = _load()
    scratch = f"migration_0019_{os.getpid()}_{int(billing)}"
    module.S = module.A = scratch

    def columns(connection: sa.Connection, table: str) -> set[str]:
        return {c["name"] for c in sa.inspect(connection).get_columns(table, scratch)}

    def migrate(connection: sa.Connection, step: str) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()

    async def scalar(connection: Any, sql: str) -> Any:
        return (await connection.execute(sa.text(sql.format(s=scratch)))).scalar()

    async with session_manager.connect() as connection:
        await connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE'))
        await connection.execute(sa.text(f'CREATE SCHEMA "{scratch}"'))
        try:
            for statement in (
                'CREATE TABLE "{s}".organization (id text PRIMARY KEY, '
                "on_trial boolean NOT NULL, total_editors integer)",
                'CREATE TABLE "{s}".billing_terms (id smallint PRIMARY KEY, '
                "trial_days integer NOT NULL)",
                'CREATE TABLE "{s}".credit_usage (id bigserial PRIMARY KEY, '
                "category text NOT NULL, payload jsonb NOT NULL DEFAULT '{{}}')",
                'CREATE TABLE "{s}".credit_rate (category text PRIMARY KEY, '
                "rate numeric NOT NULL, unit_basis text NOT NULL)",
                'CREATE TABLE "{s}".usage (id uuid PRIMARY KEY)',
                'INSERT INTO "{s}".organization VALUES '
                "('trial', true, 5), ('subscription', false, 5), "
                "('unlimited', false, NULL)",
                'INSERT INTO "{s}".billing_terms VALUES (1, 30)',
                'INSERT INTO "{s}".credit_rate VALUES '
                "('compute', 10, 'minute'), ('ai', 1, '1k_tokens')",
            ):
                await connection.execute(sa.text(statement.format(s=scratch)))

            await connection.run_sync(migrate, "upgrade")
            await connection.run_sync(migrate, "upgrade")

            allowance = dict(
                (
                    await connection.execute(
                        sa.text(
                            f'SELECT id, total_ai_credits FROM "{scratch}".organization'
                        )
                    )
                ).all()
            )
            if billing:
                assert {k: v and float(v) for k, v in allowance.items()} == {
                    "trial": DEFAULT_TRIAL["ai_credits"],
                    "subscription": 5 * DEFAULT_AI_CREDITS_PER_EDITOR,
                    "unlimited": None,
                }
            else:
                assert set(allowance.values()) == {None}
            assert await scalar(
                connection,
                "SELECT bool_and(used_ai_credits = 0 AND NOT ai_credits_override) "
                'FROM "{s}".organization',
            )
            terms = (
                await connection.execute(
                    sa.text(
                        "SELECT trial_ai_credits, ai_credits_per_editor, "
                        f'ai_credit_tiers FROM "{scratch}".billing_terms'
                    )
                )
            ).one()
            assert (float(terms[0]), float(terms[1]), terms[2]) == (
                DEFAULT_TRIAL["ai_credits"],
                DEFAULT_AI_CREDITS_PER_EDITOR,
                DEFAULT_AI_CREDIT_TIERS,
            )
            assert await scalar(
                connection, 'SELECT array_agg(category) FROM "{s}".credit_rate'
            ) == ["compute"]
            assert "hosted_in" in await connection.run_sync(columns, "usage")

            await connection.execute(
                sa.text(
                    f'INSERT INTO "{scratch}".credit_usage (category, payload) VALUES '
                    """('ai', '{"run_id": "r1"}'), ('compute', '{"run_id": "r1"}')"""
                )
            )
            with pytest.raises(sa.exc.IntegrityError, match="uq_credit_usage_ai_run"):
                await connection.execute(
                    sa.text(
                        f'INSERT INTO "{scratch}".credit_usage (category, payload) '
                        """VALUES ('ai', '{"run_id": "r1"}')"""
                    )
                )

            await connection.run_sync(migrate, "downgrade")
            assert await connection.run_sync(columns, "organization") == {
                "id",
                "on_trial",
                "total_editors",
            }
            assert await connection.run_sync(columns, "billing_terms") == {
                "id",
                "trial_days",
            }
            assert await connection.run_sync(columns, "usage") == {"id"}
            assert (
                await scalar(
                    connection,
                    "SELECT count(*) FROM pg_indexes "
                    "WHERE schemaname = '{s}' AND indexname = 'uq_credit_usage_ai_run'",
                )
                == 0
            )
        finally:
            await connection.execute(
                sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE')
            )
