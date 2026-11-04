"""The assistant's regression workflows that do not route (the assistant's
evals/workflow_runs.json, `run: chain`) run on the eval project's layers,
which `world.py` creates with the same ids, so each config runs as the
assistant built it. Every tool step and export must give rows.

The other checks read only a config's steps and connections, so they hold
for any workflow the set gains: an export saves as many rows as the step
that feeds it, a dissolve without group fields gives one row, and an
aggregate into a polygon area layer gives one row per area."""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from .conftest import ChainRun

pytestmark = pytest.mark.integration

RUNS_FILE = (
    Path(__file__).resolve().parents[7] / "apps/assistant/evals/workflow_runs.json"
)
CASES = [
    case
    for case in json.loads(RUNS_FILE.read_text(encoding="utf-8"))["cases"]
    if case["run"] == "chain"
]

#: The aggregate tools. With a polygon area layer each keeps every area
#: row, those without a source feature included.
AGGREGATES = ("aggregate_points", "aggregate_polygon")


def _named(case: dict[str, Any], node_id: str) -> str:
    """A step of the case by its label and id, for a failure message."""
    nodes: list[dict[str, Any]] = case["config"]["nodes"]
    node = next(node for node in nodes if node["id"] == node_id)
    return f"the step {node['data'].get('label')!r} ({node_id})"


def _steps(case: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """The case's steps of a type (tool, export, dataset, ...)."""
    nodes: list[dict[str, Any]] = case["config"]["nodes"]
    return [node for node in nodes if node["data"]["type"] == kind]


def _tools(case: dict[str, Any], *process_ids: str) -> list[dict[str, Any]]:
    """The case's tool steps that run one of the tools named."""
    return [
        node
        for node in _steps(case, "tool")
        if node["data"]["processId"] in process_ids
    ]


def _feeders(case: dict[str, Any], node_id: str, handle: str) -> list[str]:
    """The steps connected into an input of a step."""
    edges: list[dict[str, Any]] = case["config"]["edges"]
    return [
        edge["source"]
        for edge in edges
        if edge["target"] == node_id and edge.get("targetHandle") == handle
    ]


def _rows(run: ChainRun, node_id: str) -> int | None:
    """The rows of a step's result, None for a step without one: a dataset
    step delivers its layer and leaves no result."""
    result = run.result["node_results"].get(node_id)
    return None if result is None else int(result.get("feature_count") or 0)


def check_every_step_gives_rows(case: dict[str, Any], run: ChainRun) -> None:
    """Every tool step and export gives rows."""
    for node in _steps(case, "tool") + _steps(case, "export"):
        rows = run.step(node["id"]).get("feature_count") or 0
        assert rows > 0, f"{case['note']}: {_named(case, node['id'])} gave no rows"


def check_exports_save_their_input(case: dict[str, Any], run: ChainRun) -> None:
    """An export saves as many rows as the step that feeds it. An export fed
    by a dataset step is not checked: that step leaves no result to count."""
    for export in _steps(case, "export"):
        for source in _feeders(case, export["id"], "input"):
            expected = _rows(run, source)
            if expected is None:
                continue
            saved = run.step(export["id"])["feature_count"]
            assert saved == expected, (
                f"{case['note']}: {_named(case, export['id'])} saved {saved} "
                f"rows, {_named(case, source)} that feeds it gave {expected}"
            )


def check_dissolves_merge_everything(case: dict[str, Any], run: ChainRun) -> None:
    """A dissolve without group fields merges every feature into one."""
    for node in _tools(case, "dissolve"):
        if node["data"]["config"].get("dissolve_fields"):
            continue
        rows = run.step(node["id"])["feature_count"]
        assert rows == 1, (
            f"{case['note']}: {_named(case, node['id'])} has no group fields "
            f"but gave {rows} rows"
        )


def check_aggregates_keep_their_areas(case: dict[str, Any], run: ChainRun) -> None:
    """An aggregate into a polygon area layer gives one row per area. An
    area layer delivered by a dataset step is not checked: that step leaves
    no result to count."""
    for node in _tools(case, *AGGREGATES):
        if node["data"]["config"].get("area_type") != "polygon":
            continue
        for area in _feeders(case, node["id"], "area_layer_id"):
            expected = _rows(run, area)
            if expected is None:
                continue
            rows = run.step(node["id"])["feature_count"]
            assert rows == expected, (
                f"{case['note']}: {_named(case, node['id'])} gave {rows} rows, "
                f"the area layer from {_named(case, area)} has {expected}"
            )


def test_the_set_has_chain_cases() -> None:
    assert CASES


@pytest.mark.asyncio(loop_scope="session")
@pytest.mark.parametrize("case", CASES, ids=[case["note"][:50] for case in CASES])
async def test_an_assistant_workflow_runs(
    case: dict[str, Any], run_workflow: Any
) -> None:
    run = await asyncio.to_thread(run_workflow, case["config"])
    run.assert_succeeded()
    check_every_step_gives_rows(case, run)
    check_exports_save_their_input(case, run)
    check_dissolves_merge_everything(case, run)
    check_aggregates_keep_their_areas(case, run)
