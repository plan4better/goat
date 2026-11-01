"""Migration 0020 counts every organization's projects and storage again, as
the triggers log_project_count and log_storage_usage count them: without the
hidden copies of project templates, with the projects and layers in the
trash, and a project or layer whose creator was removed for the organization
of its space."""

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.db.session import session_manager

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "0020_project_count.py"
)


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0020", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_the_revision_follows_ai_credits() -> None:
    module = _load()
    assert (module.revision, module.down_revision) == (
        "0020_project_count",
        "0019_ai_credits",
    )


MB = 1_048_576


@pytest.mark.asyncio
async def test_the_upgrade_recounts_the_projects_and_the_storage() -> None:
    """On a small world. Projects: org A has a member's project, a member's
    project in the trash, a template copy, and projects of removed creators
    in its own space, a team's space and a member's personal space; org B one
    project in its space and a stale count; org C none and a stale count.
    Storage, in MB as the trigger log_storage_usage keeps it: org A stale high
    (a member's layer, one in the trash, layers of removed creators in a
    team's space and a member's personal space, one without a size), org B
    stale low (one layer of a removed creator in its space), org C stale with
    no layers; a catalog layer (no creator, no space) is nobody's. A second
    upgrade changes nothing, the downgrade leaves the counts."""
    module = _load()
    scratch = f"migration_0020_{os.getpid()}"
    module.S = scratch

    def migrate(connection: sa.Connection, step: str) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()

    async def counts(connection: Any) -> dict[str, tuple[int, float]]:
        rows = await connection.execute(
            sa.text(
                f'SELECT id, used_projects, used_storage FROM "{scratch}".organization'
            )
        )
        return {id_: (projects, round(storage, 6)) for id_, projects, storage in rows}

    async with session_manager.connect() as connection:
        await connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE'))
        await connection.execute(sa.text(f'CREATE SCHEMA "{scratch}"'))
        try:
            for statement in (
                'CREATE TABLE "{s}".organization (id text PRIMARY KEY, '
                "used_projects integer NOT NULL DEFAULT 0, "
                "used_storage double precision NOT NULL DEFAULT 0)",
                'CREATE TABLE "{s}"."user" (id text PRIMARY KEY, organization_id text)',
                'CREATE TABLE "{s}".team (id text PRIMARY KEY, organization_id text)',
                'CREATE TABLE "{s}".space (id text PRIMARY KEY, user_id text, '
                "team_id text, organization_id text)",
                'CREATE TABLE "{s}".project (id text PRIMARY KEY, user_id text, '
                "space_id text, is_template_source boolean NOT NULL DEFAULT false, "
                "deleted_at timestamptz)",
                'CREATE TABLE "{s}".layer (id text PRIMARY KEY, user_id text, '
                "space_id text, size bigint, deleted_at timestamptz)",
                "INSERT INTO \"{s}\".organization VALUES ('A', 661, 999), "
                "('B', 0, 1), ('C', 4, 7)",
                "INSERT INTO \"{s}\".\"user\" VALUES ('anna', 'A'), ('bo', 'B')",
                "INSERT INTO \"{s}\".team VALUES ('team-a', 'A')",
                'INSERT INTO "{s}".space VALUES '
                "('space-a', NULL, NULL, 'A'), ('space-team-a', NULL, 'team-a', NULL), "
                "('space-anna', 'anna', NULL, NULL), ('space-b', NULL, NULL, 'B')",
                'INSERT INTO "{s}".project VALUES '
                "('mine', 'anna', 'space-anna', false, NULL), "
                "('binned', 'anna', 'space-a', false, now()), "
                "('copy', 'anna', 'space-a', true, NULL), "
                "('orphan-org', NULL, 'space-a', false, NULL), "
                "('orphan-team', NULL, 'space-team-a', false, NULL), "
                "('orphan-personal', NULL, 'space-anna', false, now()), "
                "('orphan-b', NULL, 'space-b', false, NULL), "
                "('nowhere', NULL, NULL, false, NULL)",
                'INSERT INTO "{s}".layer VALUES '
                f"('mine', 'anna', 'space-a', {2 * MB}, NULL), "
                f"('binned', 'anna', 'space-a', {MB}, now()), "
                f"('orphan-team', NULL, 'space-team-a', {3 * MB}, NULL), "
                f"('orphan-personal', NULL, 'space-anna', {MB // 2}, NULL), "
                "('no-size', NULL, 'space-a', NULL, NULL), "
                f"('orphan-b', NULL, 'space-b', {4 * MB}, NULL), "
                f"('catalog', NULL, NULL, {100 * MB}, NULL)",
            ):
                await connection.execute(sa.text(statement.format(s=scratch)))

            await connection.run_sync(migrate, "upgrade")
            expected = {"A": (5, 6.5), "B": (1, 4.0), "C": (0, 0.0)}
            assert await counts(connection) == expected
            await connection.run_sync(migrate, "upgrade")
            assert await counts(connection) == expected
            await connection.run_sync(migrate, "downgrade")
            assert await counts(connection) == expected
        finally:
            await connection.execute(
                sa.text(f'DROP SCHEMA IF EXISTS "{scratch}" CASCADE')
            )
