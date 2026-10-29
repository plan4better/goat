"""The runner's final phase for "Save as dataset" nodes set to "Add to
existing" (``destination: "existing"``).

They write only when the whole run succeeded, after the export nodes that
create new datasets, through ``finalize_layer`` with a ``target_layer_id``. Windmill, the temp store and the
tools themselves are replaced at ``run_tool_node``.
"""

from typing import Any
from unittest.mock import patch

import pytest
from goatlib.tools import workflow_runner
from goatlib.tools.workflow_runner import run_append_nodes

USER = "00000000-0000-0000-0000-000000000001"
PROJECT = "00000000-0000-0000-0000-000000000030"
WORKFLOW = "00000000-0000-0000-0000-000000000010"
FOLDER = "00000000-0000-0000-0000-000000000040"
TARGET = "00000000-0000-0000-0000-000000000abc"

TOOL = {"id": "t1", "data": {"type": "tool", "processId": "buffer"}}
EXPORT = {"id": "e1", "data": {"type": "export", "datasetName": "Result"}}
APPEND = {
    "id": "a1",
    "data": {
        "type": "export",
        "label": "Save as dataset",
        "destination": "existing",
        "targetLayerId": TARGET,
        "addToProject": False,
    },
}
EDGES = [
    {"source": "t1", "target": "e1"},
    {"source": "t1", "target": "a1"},
]


class _Tools:
    """Stands in for Windmill: records which tool ran with what."""

    def __init__(self, fail: str | None = None) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.fail = fail

    def __call__(
        self, node_id: str, process_id: str, inputs: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        self.calls.append((node_id, process_id, inputs))
        kind = (
            "append"
            if process_id == "finalize_layer" and inputs.get("target_layer_id")
            else process_id
        )
        if kind == self.fail:
            return "job", {"error": f"{kind} failed"}
        if process_id == "buffer":
            return "job-t1", {"temp_layer_id": "tmp:t1", "feature_count": 2}
        if process_id == "finalize_layer" and not inputs.get("target_layer_id"):
            return "job-e1", {"layer_id": "new-layer"}
        return "job-a1", {"layer_id": TARGET, "rows_appended": 2}


def _run(tools: _Tools, nodes: list[dict]) -> Any:
    with (
        patch.object(workflow_runner, "run_tool_node", side_effect=tools),
        patch.object(workflow_runner, "resolve_dataset_layers", lambda p: p.nodes),
        patch.object(workflow_runner, "cleanup_previous_results"),
        patch.object(workflow_runner, "build_tool_inputs", return_value={}),
    ):
        return workflow_runner.main(
            user_id=USER,
            project_id=PROJECT,
            workflow_id=WORKFLOW,
            folder_id=FOLDER,
            nodes=nodes,
            edges=EDGES,
        )


def test_append_runs_after_exports() -> None:
    tools = _Tools()
    result = _run(tools, [TOOL, EXPORT, APPEND])
    assert [c[1] for c in tools.calls] == ["buffer", "finalize_layer", "finalize_layer"]
    assert result["node_results"]["a1"]["rows_appended"] == 2
    assert result["node_jobs"]["a1"] == "job-a1"


def test_append_inputs() -> None:
    tools = _Tools()
    _run(tools, [TOOL, APPEND])
    node_id, process_id, inputs = tools.calls[-1]
    assert (node_id, process_id) == ("a1", "finalize_layer")
    assert inputs == {
        "user_id": USER,
        "workflow_id": WORKFLOW,
        "node_id": "t1",
        "export_node_id": "a1",
        "project_id": PROJECT,
        "folder_id": FOLDER,
        "target_layer_id": TARGET,
        "add_to_project": False,
        "delete_temp": False,
    }


def test_append_not_run_when_tool_failed() -> None:
    tools = _Tools(fail="buffer")
    with pytest.raises(RuntimeError):
        _run(tools, [TOOL, APPEND])
    assert all(not c[2].get("target_layer_id") for c in tools.calls)


def test_failed_append_fails_the_run() -> None:
    tools = _Tools(fail="append")
    with pytest.raises(RuntimeError, match="a1"):
        _run(tools, [TOOL, APPEND])


def test_append_skipped_on_rejected_branch() -> None:
    tools = _Tools()
    results: dict[str, dict] = {
        "t1": {"temp_layer_id": "tmp:t1", "feature_count": 2},
        "a1": {"status": "skipped", "skipped_by": "if1"},
    }
    errors: list[dict] = []
    with patch.object(workflow_runner, "run_tool_node", side_effect=tools):
        run_append_nodes(_params(), [TOOL, APPEND], EDGES, results, {}, errors)
    assert tools.calls == []
    assert errors == []


def test_append_without_target_is_error() -> None:
    tools = _Tools()
    node = {"id": "a1", "data": {"type": "export", "destination": "existing"}}
    results: dict[str, dict] = {"t1": {"temp_layer_id": "tmp:t1", "feature_count": 2}}
    errors: list[dict] = []
    with patch.object(workflow_runner, "run_tool_node", side_effect=tools):
        run_append_nodes(_params(), [TOOL, node], EDGES, results, {}, errors)
    assert tools.calls == []
    assert errors == [{"node_id": "a1", "error": "Choose a target layer."}]


def _params() -> workflow_runner.WorkflowRunnerParams:
    return workflow_runner.WorkflowRunnerParams(
        user_id=USER,
        project_id=PROJECT,
        workflow_id=WORKFLOW,
        folder_id=FOLDER,
        nodes=[],
        edges=EDGES,
    )


def test_append_without_a_tool_result_is_error() -> None:
    # A dataset node wired straight into Append produces no temp result: the
    # run must say so instead of reporting success with nothing appended.
    tools = _Tools()
    dataset = {"id": "d1", "data": {"type": "dataset", "layerId": "x"}}
    edges = [{"source": "d1", "target": "a1"}]
    errors: list[dict] = []
    with patch.object(workflow_runner, "run_tool_node", side_effect=tools):
        run_append_nodes(_params(), [dataset, APPEND], edges, {}, {}, errors)
    assert tools.calls == []
    assert errors == [
        {
            "node_id": "a1",
            "error": "Connect the result of a tool to this node; a dataset "
            "cannot be appended directly.",
        }
    ]


def test_failed_append_keeps_what_the_exports_saved() -> None:
    # No write right on the target: the append fails, the run is marked
    # failed and names the append node, and the exports that ran before it
    # stay saved (they committed on their own).
    tools = _Tools(fail="append")
    with pytest.raises(RuntimeError, match="a1") as failure:
        _run(tools, [TOOL, EXPORT, APPEND])
    assert [c[1] for c in tools.calls] == ["buffer", "finalize_layer", "finalize_layer"]
    assert "e1" not in str(failure.value)
