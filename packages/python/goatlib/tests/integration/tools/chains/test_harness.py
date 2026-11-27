"""What the chain harness itself promises: it refuses the app's own data,
passes a script its arguments the way Windmill does, saves each run's
workflow as core does, fails a test whose dataset steps name a layer the
world does not have, gives each run only its own jobs, checks each tool
step's preview style against the style contract, and sees the safety net
replace a tool's style."""

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.tools import style as tool_style
from goatlib.tools.base import BaseToolRunner, ToolSettings
from goatlib.tools.sync_windmill import FINALIZE_LAYER_SCRIPT, windmill_script

from ..conftest import TEST_CUSTOMER_SCHEMA, get_pg_connection
from .configs import dataset, edge, export, tool, workflow
from .conftest import SAFETY_NET, ChainRun, _check_tool_styles, _SafetyNet, refusal
from .windmill_stand_in import windmill_arguments
from .world import SCHULEN

BUFFER = "f/goat/tools/buffer"
RUNNER = "f/goat/tools/workflow_runner"


def _ring() -> dict[str, Any]:
    return workflow(
        [dataset("schools", SCHULEN), tool("ring", "buffer", distances=[500])],
        [edge("schools", "ring")],
    )


@pytest.mark.parametrize("database", ["goat", "goat_slot_feat_chains"])
def test_the_app_databases_are_refused(database: str, tmp_path: Path) -> None:
    reason = refusal(database, str(tmp_path / "lake"), tmp_path / ".env")
    assert reason is not None
    assert reason.startswith(f"POSTGRES_DB is {database}")


def test_the_data_dir_the_root_env_names_is_refused(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text('POSTGRES_DB=goat\nDUCKLAKE_DATA_DIR="/srv/goat/ducklake"\n')
    reason = refusal("goat_chains_test", "/srv/goat/ducklake", env_file)
    assert reason is not None
    assert reason.startswith("DUCKLAKE_DATA_DIR is /srv/goat/ducklake")
    assert refusal("goat_chains_test", str(tmp_path / "lake"), env_file) is None


def test_a_script_without_kwargs_gets_its_arguments_as_windmill_binds_them() -> None:
    """Each name `main` declares: a required one as sent (None when not
    sent), one with a default only when sent and not None, so its default
    applies; nothing it does not declare."""
    namespace: dict[str, Any] = {}
    exec(FINALIZE_LAYER_SCRIPT, namespace)
    sent = {
        "user_id": "u",
        "workflow_id": "w",
        "node_id": "n",
        "project_id": "p",
        "overwrite_previous": None,
        "layer_name": "Gespeichert",
        "delete_temp": False,
    }
    assert windmill_arguments(namespace["main"], sent) == {
        "user_id": "u",
        "workflow_id": "w",
        "node_id": "n",
        "project_id": "p",
        "folder_id": None,
        "layer_name": "Gespeichert",
    }


def test_a_tool_step_s_preview_style_is_checked_against_its_result(
    tmp_path: Path,
) -> None:
    """Point bands fit the point result; polygon bands on it fail; a step
    that is no tool is not checked."""
    points = tmp_path / "points.parquet"
    with duckdb.connect() as con:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            "COPY (SELECT (i % 2 + 1) * 5 AS cost_step, ST_Point(i, 0) AS geometry "
            f"FROM range(10) t(i)) TO '{points}' (FORMAT PARQUET)"
        )

    def bands(geometry: str) -> dict[str, Any]:
        return tool_style.bands(
            "cost_step", [5, 10], "colorbrewer:YlGn", geometry, "Travel time", "min"
        )

    def run(style: dict[str, Any]) -> ChainRun:
        step = {"geometry_type": "POINT", "parquet_path": str(points), "style": style}
        return ChainRun({"node_results": {"reach": step, "save": step}}, {}, tmp_path)

    config = workflow([tool("reach", "catchment_area"), export("save", "Saved")], [])
    _check_tool_styles(run(bands("point")), config)
    with pytest.raises(AssertionError, match="part_not_for_geometry"):
        _check_tool_styles(run(bands("polygon")), config)
    _check_tool_styles(run(bands("polygon")), workflow([export("save", "S")], []))


def test_the_safety_net_is_seen_after_a_tool_replaces_the_root_handlers() -> None:
    recorder = _SafetyNet()
    base_logger = logging.getLogger("goatlib.tools.base")
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    base_logger.addHandler(recorder)
    try:
        BaseToolRunner._configure_logging_for_windmill()
        base_logger.warning("The style of buffer %s (unknown_field)", SAFETY_NET)
        base_logger.warning("Computing the result's style failed")
    finally:
        base_logger.removeHandler(recorder)
        root.handlers[:] = handlers
        root.setLevel(level)
    assert recorder.replaced == [f"The style of buffer {SAFETY_NET} (unknown_field)"]


def test_a_script_with_kwargs_gets_every_argument_as_sent() -> None:
    namespace: dict[str, Any] = {}
    exec(windmill_script(BUFFER), namespace)
    sent = {"input_layer_id": "l", "user_id": "u", "units": None, "extra": 1}
    assert windmill_arguments(namespace["main"], sent) == sent


@pytest.mark.asyncio(loop_scope="session")
async def test_a_run_saves_its_workflow_as_core_does(
    run_workflow: Any, tool_settings: ToolSettings
) -> None:
    config = _ring()
    workflow_id = str(uuid.uuid4())
    run = await asyncio.to_thread(run_workflow, config, workflow_id)
    run.assert_succeeded()
    conn = await get_pg_connection(tool_settings)
    try:
        saved = await conn.fetchval(
            f"SELECT config FROM {TEST_CUSTOMER_SCHEMA}.workflow WHERE id = $1",
            uuid.UUID(workflow_id),
        )
    finally:
        await conn.close()
    assert json.loads(saved) == {"nodes": config["nodes"], "edges": config["edges"]}


@pytest.mark.asyncio(loop_scope="session")
async def test_a_dataset_step_on_an_entry_the_world_lacks_fails_the_test(
    run_workflow: Any,
) -> None:
    """The runner reads a dataset step's layer through its project entry and
    falls back to the saved layer id when it cannot. Here the saved id is a
    layer of the world, so the run itself would succeed."""
    config = _ring()
    config["nodes"][0]["data"]["projectLayerId"] = 41
    with pytest.raises(pytest.fail.Exception, match=r"\[41\]"):
        await asyncio.to_thread(run_workflow, config)


@pytest.mark.asyncio(loop_scope="session")
async def test_each_run_holds_only_its_own_jobs(run_workflow: Any) -> None:
    first = await asyncio.to_thread(run_workflow, _ring())
    second = await asyncio.to_thread(run_workflow, _ring())
    for run in (first, second):
        run.assert_succeeded()
        assert [job.path for job in run.jobs.values()] == [BUFFER, RUNNER]
    assert not set(first.jobs) & set(second.jobs)
