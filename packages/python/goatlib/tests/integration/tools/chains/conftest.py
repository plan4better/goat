"""Fixtures for the workflow chain tests: the eval project's layers in the
test schema and in DuckLake (`world.py`), and `run_workflow`, which runs a
workflow config the way processes submits it, with Windmill stood in
(`windmill_stand_in.py`) and the temp results under `tmp_path`.

The tests write tables, layers and DuckLake snapshots into the database they
run on and DuckLake files into its data directory, so they refuse the app's
own (`refusal`). Locally, from packages/python/goatlib, on a throwaway
database of the Postgres the root .env file names (`createdb
goat_chains_test`, then `CREATE EXTENSION postgis` in it):

    POSTGRES_DB=goat_chains_test DUCKLAKE_DATA_DIR="$(mktemp -d)" uv run --no-sync --env-file ../../../.env pytest tests/integration/tools/chains -v
"""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import asyncpg
import duckdb
import pytest
import pytest_asyncio
from goatlib.tools import cleanup_temp, finalize_layer, temp_writer, workflow_runner
from goatlib.tools.base import ToolSettings
from goatlib.tools.workflow_dataset_nodes import project_layer_ids
from goatlib.utils.layer import layer_schema_name

from ..conftest import (
    TEST_CUSTOMER_SCHEMA,
    TEST_FOLDER_ID,
    TEST_PROJECT_ID,
    TEST_USER_ID,
    get_full_table_path,
    get_pg_connection,
)
from .windmill_stand_in import InProcessWindmill, Job
from .world import WORLD

RUNNER = "f/goat/tools/workflow_runner"
FINALIZE = "f/goat/tools/finalize_layer"
SCHEMA = TEST_CUSTOMER_SCHEMA
#: The repository's .env file: the settings the app's services run with.
ROOT_ENV = Path(__file__).resolve().parents[7] / ".env"


def _env_value(env_file: Path, name: str) -> str | None:
    """The value a .env file gives `name`, None when it gives none."""
    if not env_file.is_file():
        return None
    for line in env_file.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == name:
            return value.strip().strip("\"'")
    return None


def refusal(postgres_db: str, ducklake_data_dir: str, env_file: Path) -> str | None:
    """Why the tests must not run on these settings, None when they may: the
    app's database (`goat`, or a stack's `goat_slot_*` copy), whose DuckLake
    catalog it also holds, or the DuckLake data directory the app's services
    use (the one `env_file` names)."""
    if postgres_db == "goat" or postgres_db.startswith("goat_slot_"):
        return (
            f"POSTGRES_DB is {postgres_db}: the chain tests write tables, layers "
            "and DuckLake snapshots into the database they run on. Create a "
            "throwaway database (createdb goat_chains_test, then CREATE "
            "EXTENSION postgis in it) and set POSTGRES_DB=goat_chains_test on "
            "the command line."
        )
    shared = _env_value(env_file, "DUCKLAKE_DATA_DIR")
    if shared and Path(shared).resolve() == Path(ducklake_data_dir).resolve():
        return (
            f"DUCKLAKE_DATA_DIR is {ducklake_data_dir}, the app's own (the root "
            ".env file names it): the chain tests write DuckLake files there. "
            'Set DUCKLAKE_DATA_DIR="$(mktemp -d)" on the command line.'
        )
    return None


@pytest.fixture(scope="session", autouse=True)
def _throwaway_data(tool_settings: ToolSettings) -> None:
    """Stops every chain test before anything is written when the settings
    name the app's own data (`refusal`). Autouse fixtures are set up before a
    test's other fixtures, so this comes before the chain fixtures write
    anything, and before `test_schemas` and the DuckLake attach unless a test
    outside this folder set those up earlier in the session."""
    reason = refusal(
        tool_settings.postgres_db, tool_settings.ducklake_data_dir, ROOT_ENV
    )
    if reason is not None:
        pytest.fail(reason, pytrace=False)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def world(
    postgres_pool: asyncpg.Pool,
    test_folder: dict[str, Any],
    ducklake_connection: duckdb.DuckDBPyConnection,
) -> AsyncIterator[None]:
    """The eval project's layers: DuckLake tables, layer rows, and entries in
    the test project under the entry ids the eval's drafts name."""
    ducklake_connection.execute(
        f"CREATE SCHEMA IF NOT EXISTS lake.{layer_schema_name()}"
    )
    for layer in WORLD.values():
        ducklake_connection.execute(
            f"CREATE OR REPLACE TABLE {layer.table} AS {layer.select}"
        )
    user = uuid.UUID(TEST_USER_ID)
    folder = uuid.UUID(TEST_FOLDER_ID)
    project = uuid.UUID(TEST_PROJECT_ID)
    async with postgres_pool.acquire() as conn:
        await conn.execute(
            f"INSERT INTO {SCHEMA}.project (id, user_id, folder_id, name) "
            "VALUES ($1, $2, $3, 'Test Project') ON CONFLICT (id) DO NOTHING",
            project,
            user,
            folder,
        )
        for layer in WORLD.values():
            await conn.execute(
                f"INSERT INTO {SCHEMA}.layer (id, user_id, folder_id, name, type, "
                "feature_layer_type, feature_layer_geometry_type) "
                "VALUES ($1, $2, $3, $4, 'feature', 'standard', $5)",
                uuid.UUID(layer.layer_id),
                user,
                folder,
                layer.name,
                layer.geometry,
            )
            await conn.execute(
                f'INSERT INTO {SCHEMA}.layer_project (id, layer_id, project_id, name, "order") '
                "VALUES ($1, $2, $3, $4, 0)",
                layer.link_id,
                uuid.UUID(layer.layer_id),
                project,
                layer.name,
            )
        # Entries the runs add take ids from the sequence, past the world's.
        await conn.execute(
            f"SELECT setval(pg_get_serial_sequence('{SCHEMA}.layer_project', 'id'), 1000)"
        )
    yield
    for layer in WORLD.values():
        ducklake_connection.execute(f"DROP TABLE IF EXISTS {layer.table}")


@dataclass
class ChainRun:
    """A finished run: the runner's result, the jobs this run started (its
    own job last), and the folder the temp results went to."""

    result: dict[str, Any]
    jobs: dict[str, Job]
    temp_root: Path

    def step(self, node_id: str) -> dict[str, Any]:
        """What a step left in the run's result."""
        step: dict[str, Any] = self.result["node_results"][node_id]
        return step

    def args(self, node_id: str) -> dict[str, Any]:
        """The arguments the step's job was started with."""
        return self.jobs[self.result["node_jobs"][node_id]].args

    def assert_succeeded(self) -> None:
        assert self.result.get("status") == "success", (
            self.result.get("errors") or self.result
        )


async def _save_workflow(
    settings: ToolSettings, workflow_id: str, config: dict[str, Any]
) -> None:
    """The workflow row as core saves it before a run: a name, and the steps
    and connections the run gets as its config. finalize checks a result's
    workflow against it, and an overwrite reads its config."""
    conn = await get_pg_connection(settings)
    try:
        await conn.execute(
            f"INSERT INTO {SCHEMA}.workflow (id, project_id, name, config) "
            "VALUES ($1, $2, $3, $4::jsonb) "
            "ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, "
            "updated_at = NOW()",
            uuid.UUID(workflow_id),
            uuid.UUID(TEST_PROJECT_ID),
            "Workflow chain",
            json.dumps({"nodes": config["nodes"], "edges": config["edges"]}),
        )
    finally:
        await conn.close()


@pytest.fixture
def run_workflow(
    world: None,
    tool_settings: ToolSettings,
    ducklake_connection: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Iterator[Callable[..., ChainRun]]:
    """Runs a workflow config as processes submits it and returns the run.

    Call it through `asyncio.to_thread`: the runner and the tools run event
    loops of their own. Every job reads the test settings
    (`ToolSettings.from_env` is what each one calls), temp results go under
    `tmp_path`, and the layers the exports saved are dropped afterwards.

    The runner reads each dataset step's layer through its project entry
    (`current_layer_ids`) and falls back to the layer id as saved when the
    entry is not found or the look-up fails. A run whose dataset steps name
    an entry the look-up did not resolve fails the test, so a chain cannot
    pass on that fallback.
    """
    temp_root = tmp_path / "temporary"
    for module in (temp_writer, cleanup_temp, finalize_layer):
        monkeypatch.setattr(module, "TEMP_DATA_ROOT", temp_root)
    monkeypatch.setattr(
        ToolSettings, "from_env", classmethod(lambda cls: tool_settings)
    )
    windmill = InProcessWindmill()
    monkeypatch.setattr(workflow_runner, "wmill", windmill)
    # The entries the current run's look-up resolved, by entry id.
    resolved: dict[int, str] = {}
    look_up = workflow_runner.current_layer_ids

    async def resolving(*args: Any, **kwargs: Any) -> dict[int, str]:
        current: dict[int, str] = await look_up(*args, **kwargs)
        resolved.update(current)
        return current

    monkeypatch.setattr(workflow_runner, "current_layer_ids", resolving)

    def run(config: dict[str, Any], workflow_id: str | None = None) -> ChainRun:
        workflow_id = workflow_id or str(uuid.uuid4())
        asyncio.run(_save_workflow(tool_settings, workflow_id, config))
        resolved.clear()
        earlier = set(windmill.jobs)
        args: dict[str, Any] = {
            "user_id": TEST_USER_ID,
            "project_id": TEST_PROJECT_ID,
            "workflow_id": workflow_id,
            "folder_id": TEST_FOLDER_ID,
            "nodes": config["nodes"],
            "edges": config["edges"],
        }
        if config.get("variables"):
            args["variables"] = config["variables"]
        job_id = windmill.run_script_async(RUNNER, args=args)
        unresolved = sorted(set(project_layer_ids(config["nodes"])) - set(resolved))
        if unresolved:
            pytest.fail(
                f"The dataset steps name the project entries {unresolved}, which "
                "the runner's look-up did not resolve: the world has no layer "
                "behind them (world.py), or the look-up failed (the run's output "
                "says why). The run read the layer ids as saved instead.",
                pytrace=False,
            )
        jobs = {key: job for key, job in windmill.jobs.items() if key not in earlier}
        return ChainRun(windmill.get_result(job_id), jobs, temp_root)

    yield run

    for job in windmill.jobs.values():
        saved = job.result.get("layer_id") if isinstance(job.result, dict) else None
        if job.path == FINALIZE and saved:
            ducklake_connection.execute(
                f"DROP TABLE IF EXISTS {get_full_table_path(TEST_USER_ID, saved)}"
            )


@pytest.fixture
def saved_rows(ducklake_connection: duckdb.DuckDBPyConnection) -> Callable[[str], int]:
    """The rows of a layer an export saved."""

    def count(layer_id: str) -> int:
        row = ducklake_connection.execute(
            f"SELECT COUNT(*) FROM {get_full_table_path(TEST_USER_ID, layer_id)}"
        ).fetchone()
        assert row is not None
        return int(row[0])

    return count
