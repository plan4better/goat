"""A failed workflow step's error, as the run result and job status show it.

The runner returns each failed step as {"node_id", "message"} instead of
raising, because Windmill keeps only an exception's text as a failed job's
result. processes reads a failed child job the same way while a run goes
on. The message is the Windmill error's `message` (its `name` when empty),
never the stack, at most 500 characters.
"""

import json
from collections.abc import Callable
from typing import Any
from unittest.mock import patch

import pytest
from goatlib.tools import workflow_runner
from goatlib.workflows.run_errors import MAX_MESSAGE_LENGTH, error_message, step_errors

pytestmark = pytest.mark.unit

STACK = 'File "/venv/lib/python3.11/site-packages/goatlib/tools/clip.py", line 88'


class TestErrorMessage:
    def test_a_windmill_error_gives_its_message_without_the_stack(self) -> None:
        error = {
            "name": "ValueError",
            "message": "Column 'name' not found",
            "stack": STACK,
        }
        assert error_message(error) == "Column 'name' not found"

    def test_an_error_without_a_message_gives_its_name(self) -> None:
        assert error_message({"name": "MemoryError", "stack": STACK}) == "MemoryError"

    def test_an_exception_gives_its_text_or_its_type(self) -> None:
        assert error_message(RuntimeError("Job job-1 was cancelled")) == (
            "Job job-1 was cancelled"
        )
        assert error_message(KeyError()) == "KeyError"

    def test_nothing_known_says_so(self) -> None:
        assert error_message(None) == "Unknown error"
        assert error_message("") == "Unknown error"

    def test_who_cancelled_a_job_is_not_shown(self) -> None:
        error = {"message": "Job canceled: cancelled by alice (reason: dismissed)"}
        assert error_message(error) == "Job canceled: cancelled (reason: dismissed)"

    def test_a_long_message_is_cut_to_500_characters(self) -> None:
        message = error_message({"message": "x" * 2000})
        assert MAX_MESSAGE_LENGTH == 500
        assert len(message) == 500
        assert message == "x" * 499 + "…"


class TestStepErrors:
    def test_each_failed_step_gives_its_message(self) -> None:
        errors = [
            {"node_id": "n-clip", "message": "Column 'name' not found"},
            {"node_id": "n-export", "message": "A layer named Roads already exists"},
        ]
        assert step_errors(errors) == {
            "n-clip": "Column 'name' not found",
            "n-export": "A layer named Roads already exists",
        }

    def test_an_entry_holding_the_raw_error_is_reduced_the_same_way(self) -> None:
        errors = [
            {
                "node_id": "n-clip",
                "error": {"name": "ValueError", "message": "y" * 2000, "stack": STACK},
            }
        ]
        (message,) = step_errors(errors).values()
        assert len(message) == 500
        assert "site-packages" not in message

    def test_entries_without_a_step_and_other_shapes_are_left_out(self) -> None:
        assert step_errors([{"message": "no step"}, "text", None]) == {}
        assert step_errors(None) == {}
        assert step_errors({"n-clip": "not a list"}) == {}


IDS = {
    "user_id": "00000000-0000-0000-0000-000000000001",
    "project_id": "00000000-0000-0000-0000-000000000030",
    "workflow_id": "00000000-0000-0000-0000-000000000010",
    "folder_id": "00000000-0000-0000-0000-000000000040",
}
ROADS: dict[str, Any] = {
    "id": "n-roads",
    "type": "dataset",
    "data": {"type": "dataset", "layerId": "90e3bcb2-d7ec-4abf-955d-50633ab4a101"},
}
BUFFER: dict[str, Any] = {
    "id": "n-buffer",
    "type": "tool",
    "data": {"type": "tool", "processId": "buffer", "config": {"distances": [100]}},
}
CLIP: dict[str, Any] = {
    "id": "n-clip",
    "type": "tool",
    "data": {"type": "tool", "processId": "clip", "config": {}},
}

RunToolNode = Callable[[str, str, dict[str, Any]], tuple[str, dict[str, Any]]]


def _edge(source: str, target: str) -> dict[str, Any]:
    return {
        "id": f"{source}-{target}",
        "source": source,
        "target": target,
        "targetHandle": "input_layer_id",
    }


def _done(node_id: str, process_id: str) -> tuple[str, dict[str, Any]]:
    job_id = f"job-{process_id}"
    return job_id, {
        "node_id": node_id,
        "process_id": process_id,
        "job_id": job_id,
        "temp_layer_id": f"wf:{node_id}:abc",
        "duration_ms": 10,
    }


def _failed(node_id: str, process_id: str, message: str) -> tuple[str, dict[str, Any]]:
    """What `run_tool_node` returns for a child job that raised."""
    job_id = f"job-{process_id}"
    return job_id, {
        "node_id": node_id,
        "process_id": process_id,
        "job_id": job_id,
        "error": {"name": "ValueError", "message": message, "stack": STACK},
        "duration_ms": 5,
    }


def _fails_at(failing_process: str, message: str) -> RunToolNode:
    def run(
        node_id: str, process_id: str, inputs: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        if process_id == failing_process:
            return _failed(node_id, process_id, message)
        return _done(node_id, process_id)

    return run


def _run(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]], run_tool_node: RunToolNode
) -> dict[str, Any]:
    """`main` with the database, the temp files and Windmill left out."""
    with (
        patch.object(
            workflow_runner,
            "resolve_dataset_layers",
            side_effect=lambda params: params.nodes,
        ),
        patch.object(workflow_runner, "cleanup_previous_results"),
        patch.object(workflow_runner, "run_tool_node", side_effect=run_tool_node),
    ):
        result: dict[str, Any] = workflow_runner.main(nodes=nodes, edges=edges, **IDS)
    return result


CHAIN = [ROADS, BUFFER, CLIP]
CHAIN_EDGES = [_edge("n-roads", "n-buffer"), _edge("n-buffer", "n-clip")]


class TestFailedRun:
    def test_a_failed_step_is_returned_not_raised(self) -> None:
        result = _run(CHAIN, CHAIN_EDGES, _fails_at("clip", "Column 'name' not found"))

        assert result["status"] == "failed"
        assert result["errors"] == [
            {"node_id": "n-clip", "message": "Column 'name' not found"}
        ]
        assert result["node_jobs"] == {"n-buffer": "job-buffer", "n-clip": "job-clip"}
        assert result["node_results"]["n-buffer"]["temp_layer_id"] == "wf:n-buffer:abc"

    def test_a_long_error_is_cut_and_carries_no_stack(self) -> None:
        result = _run(CHAIN, CHAIN_EDGES, _fails_at("clip", "x" * 2000))

        (entry,) = result["errors"]
        assert len(entry["message"]) == 500
        assert "site-packages" not in json.dumps(result["errors"])

    def test_a_step_that_raises_is_listed_with_its_message(self) -> None:
        def run(
            node_id: str, process_id: str, inputs: dict[str, Any]
        ) -> tuple[str, dict[str, Any]]:
            if process_id == "clip":
                raise RuntimeError("Job job-clip was cancelled")
            return _done(node_id, process_id)

        result = _run(CHAIN, CHAIN_EDGES, run)

        assert result["errors"] == [
            {"node_id": "n-clip", "message": "Job job-clip was cancelled"}
        ]

    def test_a_step_without_a_tool_is_listed(self) -> None:
        empty = {
            "id": "n-empty",
            "type": "tool",
            "data": {"type": "tool", "config": {}},
        }

        result = _run([empty], [], _fails_at("clip", "not reached"))

        assert result["status"] == "failed"
        assert result["errors"] == [
            {"node_id": "n-empty", "message": "No tool is chosen for this step."}
        ]

    def test_a_failing_if_step_is_listed(self) -> None:
        condition = {"id": "n-if", "type": "if", "data": {"type": "if"}}
        with patch.object(
            workflow_runner,
            "execute_if_node",
            side_effect=ValueError("Unknown workflow variable: limit"),
        ):
            result = _run(
                [ROADS, BUFFER, condition],
                [_edge("n-roads", "n-buffer"), _edge("n-buffer", "n-if")],
                _fails_at("clip", "not reached"),
            )

        assert result["errors"] == [
            {"node_id": "n-if", "message": "Unknown workflow variable: limit"}
        ]

    def test_a_failing_export_is_listed(self) -> None:
        export = {
            "id": "n-export",
            "type": "export",
            "data": {"type": "export", "datasetName": "Buffered roads"},
        }

        result = _run(
            [ROADS, BUFFER, export],
            [_edge("n-roads", "n-buffer"), _edge("n-buffer", "n-export")],
            _fails_at("finalize_layer", "A layer named Buffered roads already exists"),
        )

        assert result["errors"] == [
            {
                "node_id": "n-export",
                "message": "A layer named Buffered roads already exists",
            }
        ]

    def test_an_export_without_a_dataset_name_is_skipped(self) -> None:
        """An explicit `"datasetName": null` is an export without a name:
        skipped, as an empty name is, instead of failing the whole run."""
        export = {
            "id": "n-export",
            "type": "export",
            "data": {"type": "export", "datasetName": None},
        }

        result = _run(
            [ROADS, BUFFER, export],
            [_edge("n-roads", "n-buffer"), _edge("n-buffer", "n-export")],
            _fails_at("finalize_layer", "not reached"),
        )

        assert result["status"] == "success"
        assert "n-export" not in result["node_jobs"]

    def test_a_run_without_errors_succeeds(self) -> None:
        result = _run(
            [ROADS, BUFFER], [_edge("n-roads", "n-buffer")], _fails_at("clip", "-")
        )

        assert result["status"] == "success"
        assert result["errors"] == []
