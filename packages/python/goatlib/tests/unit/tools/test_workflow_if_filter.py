"""A dataset's filter reaches the steps behind an If, and an export saves it.

An If passes its input layer on unchanged, and with it the filter of the
dataset the layer comes from: the If judges the filtered rows, and so does
every If, tool and export behind it. A tool step's result carries no dataset
filter, so nothing behind it gets one. An export straight behind a dataset
saves the dataset's rows with its filter, as one behind an If on it does, and
both save them in the dataset's own style.
"""

from typing import Any
from unittest.mock import patch

import pytest
from goatlib.tools import workflow_runner
from goatlib.tools.if_node import IF_TRUE_HANDLE

pytestmark = pytest.mark.unit

IDS = {
    "user_id": "00000000-0000-0000-0000-000000000001",
    "project_id": "00000000-0000-0000-0000-000000000030",
    "workflow_id": "00000000-0000-0000-0000-000000000010",
    "folder_id": "00000000-0000-0000-0000-000000000040",
}
LAYER = "90e3bcb2-d7ec-4abf-955d-50633ab4a101"
SCHOOLS_ONLY = {
    "op": "and",
    "expressions": [{"attribute": "kind", "expression": "is", "value": "school"}],
}
SCHOOLS_ONLY_CQL = {"op": "=", "args": [{"property": "kind"}, "school"]}


def _dataset(**extra: Any) -> dict[str, Any]:
    return {
        "id": "n-data",
        "type": "dataset",
        "data": {"type": "dataset", "layerId": LAYER, **extra},
    }


def _tool(node_id: str, process_id: str, config: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "tool",
        "data": {"type": "tool", "processId": process_id, "config": config},
    }


def _if(node_id: str) -> dict[str, Any]:
    return {"id": node_id, "type": "if", "data": {"type": "if"}}


BUFFER = _tool("n-buffer", "buffer", {"distances": [100]})


def _edge(
    source: str,
    target: str,
    target_handle: str = "input_layer_id",
    source_handle: str | None = None,
) -> dict[str, Any]:
    return {
        "id": f"{source}-{target}",
        "source": source,
        "target": target,
        "sourceHandle": source_handle,
        "targetHandle": target_handle,
    }


def _true(source: str, target: str, handle: str = "input_layer_id") -> dict[str, Any]:
    """A connection from an If's True output."""
    return _edge(source, target, handle, source_handle=IF_TRUE_HANDLE)


class _Run:
    """`main` with the database, the temp files and Windmill left out. Every
    If takes its True branch; what each tool job and each If got is kept, and
    each job's step and tool in the order they ran. A tool in `failing` fails
    with that message; one in `raising` raises it, as the run does for a job
    that was cancelled. A dataset layer's style comes from `styles`, and the
    dataset steps whose style was looked up are kept."""

    def __init__(
        self,
        failing: dict[str, str] | None = None,
        styles: dict[str, dict[str, Any]] | None = None,
        raising: dict[str, str] | None = None,
    ) -> None:
        self.failing = failing or {}
        self.raising = raising or {}
        self.styles = styles or {}
        self.tool_inputs: dict[str, dict[str, Any]] = {}
        self.jobs: list[tuple[str, str]] = []
        self.if_filters: dict[str, dict[str, Any] | None] = {}
        self.if_layers: dict[str, str | None] = {}
        self.styled: list[str] = []

    def _dataset_layer_style(
        self, params: workflow_runner.WorkflowRunnerParams, node: dict[str, Any]
    ) -> dict[str, Any] | None:
        self.styled.append(node["id"])
        return self.styles.get(node["data"].get("layerId"))

    def _run_tool_node(
        self, node_id: str, process_id: str, inputs: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        self.tool_inputs[node_id] = inputs
        self.jobs.append((node_id, process_id))
        if process_id in self.raising:
            raise RuntimeError(self.raising[process_id])
        job_id = f"job-{node_id}"
        if process_id in self.failing:
            return job_id, {
                "node_id": node_id,
                "process_id": process_id,
                "job_id": job_id,
                "error": {"name": "ValueError", "message": self.failing[process_id]},
            }
        return job_id, {
            "node_id": node_id,
            "process_id": process_id,
            "job_id": job_id,
            "temp_layer_id": f"wf:{node_id}:abc",
        }

    def _execute_if_node(
        self,
        node: dict[str, Any],
        upstream_layer_id: str | None,
        user_id: str,
        var_map: dict[str, Any],
        upstream_filter: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.if_filters[node["id"]] = upstream_filter
        self.if_layers[node["id"]] = upstream_layer_id
        return {
            "node_id": node["id"],
            "status": "completed",
            "active_handle": IF_TRUE_HANDLE,
            "temp_layer_id": upstream_layer_id,
        }

    def __call__(
        self, nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
    ) -> dict[str, Any]:
        with (
            patch.object(
                workflow_runner,
                "resolve_dataset_layers",
                side_effect=lambda params: params.nodes,
            ),
            patch.object(workflow_runner, "cleanup_previous_results"),
            patch.object(
                workflow_runner, "run_tool_node", side_effect=self._run_tool_node
            ),
            patch.object(
                workflow_runner, "execute_if_node", side_effect=self._execute_if_node
            ),
            patch.object(
                workflow_runner,
                "dataset_layer_style",
                side_effect=self._dataset_layer_style,
            ),
        ):
            result: dict[str, Any] = workflow_runner.main(
                nodes=nodes, edges=edges, **IDS
            )
        if not self.failing and not self.raising:
            assert result["status"] == "success", result["errors"]
        return result


def test_a_tool_behind_an_if_gets_the_datasets_filter() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), BUFFER],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-buffer")],
    )

    assert run.if_filters["n-if"] == SCHOOLS_ONLY_CQL
    assert run.tool_inputs["n-buffer"]["input_layer_id"] == LAYER
    assert run.tool_inputs["n-buffer"]["input_layer_filter"] == SCHOOLS_ONLY_CQL


def test_the_filter_passes_through_a_chain_of_ifs() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if-1"), _if("n-if-2"), BUFFER],
        [
            _edge("n-data", "n-if-1", "input"),
            _true("n-if-1", "n-if-2", "input"),
            _true("n-if-2", "n-buffer"),
        ],
    )

    # The second If judges the same rows as the first, and so does the tool.
    assert run.if_filters == {"n-if-1": SCHOOLS_ONLY_CQL, "n-if-2": SCHOOLS_ONLY_CQL}
    assert run.if_layers == {"n-if-1": LAYER, "n-if-2": LAYER}
    assert run.tool_inputs["n-buffer"]["input_layer_id"] == LAYER
    assert run.tool_inputs["n-buffer"]["input_layer_filter"] == SCHOOLS_ONLY_CQL


def test_a_dataset_without_a_filter_passes_none_through_an_if() -> None:
    run = _Run()

    run(
        [_dataset(), _if("n-if"), BUFFER],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-buffer")],
    )

    assert run.if_filters["n-if"] is None
    assert run.tool_inputs["n-buffer"]["input_layer_id"] == LAYER
    assert "input_layer_filter" not in run.tool_inputs["n-buffer"]


def test_a_tool_result_passed_through_an_if_carries_no_filter() -> None:
    """The dataset's filter applies to the tool it feeds; that tool's result
    is already the filtered rows' result and has no filter of its own."""
    run = _Run()
    clip = _tool("n-clip", "clip", {})

    run(
        [_dataset(filter=SCHOOLS_ONLY), BUFFER, _if("n-if"), clip],
        [
            _edge("n-data", "n-buffer"),
            _edge("n-buffer", "n-if", "input"),
            _true("n-if", "n-clip"),
        ],
    )

    assert run.tool_inputs["n-buffer"]["input_layer_filter"] == SCHOOLS_ONLY_CQL
    assert run.if_filters["n-if"] is None
    assert run.tool_inputs["n-clip"]["input_layer_id"] == "wf:n-buffer:abc"
    assert "input_layer_filter" not in run.tool_inputs["n-clip"]


def test_a_heatmaps_opportunity_layer_behind_an_if_keeps_its_filter() -> None:
    run = _Run()
    heatmap = _tool("n-heat", "heatmap_gravity", {"routing_mode": "walking"})

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), heatmap],
        [
            _edge("n-data", "n-if", "input"),
            _true("n-if", "n-heat", "opportunity_layer_1_id"),
        ],
    )

    assert run.tool_inputs["n-heat"]["opportunities"] == [
        {"input_path": LAYER, "input_layer_filter": SCHOOLS_ONLY_CQL}
    ]


def _export(node_id: str = "n-export", **extra: Any) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "export",
        "data": {"type": "export", "datasetName": "Schools", **extra},
    }


def test_an_export_behind_an_if_saves_the_datasets_rows_with_its_filter() -> None:
    """An export saves what finalize_layer finds in its source step's temp
    folder, and only a tool writes one. So the rows an If passes on from a
    dataset are first copied, with the dataset's filter, into the If's own
    temp folder: the one finalize_layer reads for an export behind the If."""
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export()],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-export", "input")],
    )

    assert run.jobs == [
        ("n-if", "layer_create_filtered"),
        ("n-export", "finalize_layer"),
    ]
    copy = run.tool_inputs["n-if"]
    assert copy["source_layer_id"] == LAYER
    assert copy["cql_filter"] == SCHOOLS_ONLY_CQL
    assert copy["temp_mode"] is True
    assert (copy["workflow_id"], copy["node_id"]) == (IDS["workflow_id"], "n-if")
    finalize = run.tool_inputs["n-export"]
    assert (finalize["node_id"], finalize["export_node_id"]) == ("n-if", "n-export")


def test_an_export_behind_an_if_on_an_unfiltered_dataset_saves_every_row() -> None:
    run = _Run()

    run(
        [_dataset(), _if("n-if"), _export()],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-export", "input")],
    )

    copy = run.tool_inputs["n-if"]
    assert copy["source_layer_id"] == LAYER
    # The copy takes a filter; an empty one keeps every row.
    assert copy["cql_filter"] == {}
    assert run.tool_inputs["n-export"]["node_id"] == "n-if"


def test_an_export_behind_a_chain_of_ifs_saves_the_datasets_filtered_rows() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if-1"), _if("n-if-2"), _export()],
        [
            _edge("n-data", "n-if-1", "input"),
            _true("n-if-1", "n-if-2", "input"),
            _true("n-if-2", "n-export", "input"),
        ],
    )

    assert run.jobs == [
        ("n-if-2", "layer_create_filtered"),
        ("n-export", "finalize_layer"),
    ]
    assert run.tool_inputs["n-if-2"]["source_layer_id"] == LAYER
    assert run.tool_inputs["n-if-2"]["cql_filter"] == SCHOOLS_ONLY_CQL
    assert run.tool_inputs["n-export"]["node_id"] == "n-if-2"


def test_two_exports_behind_one_if_share_one_copy() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export(), _export("n-export-2")],
        [
            _edge("n-data", "n-if", "input"),
            _true("n-if", "n-export", "input"),
            _true("n-if", "n-export-2", "input"),
        ],
    )

    assert run.jobs == [
        ("n-if", "layer_create_filtered"),
        ("n-export", "finalize_layer"),
        ("n-export-2", "finalize_layer"),
    ]
    assert run.tool_inputs["n-export-2"]["node_id"] == "n-if"


def test_a_failed_copy_is_the_exports_error() -> None:
    run = _Run(failing={"layer_create_filtered": "Layer not found"})

    result = run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export()],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-export", "input")],
    )

    assert result["status"] == "failed"
    assert result["errors"] == [{"node_id": "n-export", "message": "Layer not found"}]
    assert run.jobs == [("n-if", "layer_create_filtered")]


def test_two_exports_behind_one_if_share_a_failed_copy() -> None:
    run = _Run(failing={"layer_create_filtered": "Layer not found"})

    result = run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export(), _export("n-export-2")],
        [
            _edge("n-data", "n-if", "input"),
            _true("n-if", "n-export", "input"),
            _true("n-if", "n-export-2", "input"),
        ],
    )

    assert run.jobs == [("n-if", "layer_create_filtered")]
    assert result["errors"] == [
        {"node_id": "n-export", "message": "Layer not found"},
        {"node_id": "n-export-2", "message": "Layer not found"},
    ]


def test_a_copy_that_raised_is_not_run_again_for_a_second_export() -> None:
    """A copy whose job raised (it was cancelled, or Windmill could not be
    reached) fails every export behind the If, as one that returned an error
    does: the second export reuses the failure instead of copying again."""
    run = _Run(raising={"layer_create_filtered": "Job job-n-if was cancelled"})

    result = run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export(), _export("n-export-2")],
        [
            _edge("n-data", "n-if", "input"),
            _true("n-if", "n-export", "input"),
            _true("n-if", "n-export-2", "input"),
        ],
    )

    assert run.jobs == [("n-if", "layer_create_filtered")]
    assert result["status"] == "failed"
    assert result["errors"] == [
        {"node_id": "n-export", "message": "Job job-n-if was cancelled"},
        {"node_id": "n-export-2", "message": "Job job-n-if was cancelled"},
    ]


def test_an_export_on_the_branch_not_taken_copies_nothing() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export()],
        [
            _edge("n-data", "n-if", "input"),
            _edge("n-if", "n-export", "input", source_handle="false"),
        ],
    )

    assert run.jobs == []


def test_an_export_behind_an_if_on_a_tool_saves_the_tools_result() -> None:
    """The temp layer id an If passes on from a tool names that tool's step,
    whose temp folder finalize_layer reads: nothing is copied."""
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), BUFFER, _if("n-if"), _export()],
        [
            _edge("n-data", "n-buffer"),
            _edge("n-buffer", "n-if", "input"),
            _true("n-if", "n-export", "input"),
        ],
    )

    assert run.jobs == [("n-buffer", "buffer"), ("n-export", "finalize_layer")]
    finalize = run.tool_inputs["n-export"]
    assert (finalize["node_id"], finalize["export_node_id"]) == (
        "n-buffer",
        "n-export",
    )


def test_an_export_behind_a_tool_saves_the_tools_result() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), BUFFER, _export()],
        [_edge("n-data", "n-buffer"), _edge("n-buffer", "n-export", "input")],
    )

    assert run.jobs == [("n-buffer", "buffer"), ("n-export", "finalize_layer")]
    assert run.tool_inputs["n-export"]["node_id"] == "n-buffer"


# -- an export straight behind a dataset -----------------------------------------


def test_an_export_behind_a_dataset_saves_its_rows_with_its_filter() -> None:
    """A dataset step writes no temp folder either: its rows are copied, with
    its filter, into the dataset step's own one, which finalize_layer reads."""
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _export()],
        [_edge("n-data", "n-export", "input")],
    )

    assert run.jobs == [
        ("n-data", "layer_create_filtered"),
        ("n-export", "finalize_layer"),
    ]
    copy = run.tool_inputs["n-data"]
    assert copy["source_layer_id"] == LAYER
    assert copy["cql_filter"] == SCHOOLS_ONLY_CQL
    assert copy["temp_mode"] is True
    assert (copy["workflow_id"], copy["node_id"]) == (IDS["workflow_id"], "n-data")
    finalize = run.tool_inputs["n-export"]
    assert (finalize["node_id"], finalize["export_node_id"]) == ("n-data", "n-export")
    assert finalize["layer_name"] == "Schools"


def test_an_export_behind_an_unfiltered_dataset_saves_every_row() -> None:
    run = _Run()

    run([_dataset(), _export()], [_edge("n-data", "n-export", "input")])

    assert run.tool_inputs["n-data"]["cql_filter"] == {}
    assert run.tool_inputs["n-export"]["node_id"] == "n-data"


def test_two_exports_behind_one_dataset_share_one_copy() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _export(), _export("n-export-2")],
        [
            _edge("n-data", "n-export", "input"),
            _edge("n-data", "n-export-2", "input"),
        ],
    )

    assert run.jobs == [
        ("n-data", "layer_create_filtered"),
        ("n-export", "finalize_layer"),
        ("n-export-2", "finalize_layer"),
    ]
    assert run.tool_inputs["n-export-2"]["node_id"] == "n-data"


def test_a_failed_copy_of_a_dataset_is_the_exports_error() -> None:
    run = _Run(failing={"layer_create_filtered": "Layer not found"})

    result = run(
        [_dataset(filter=SCHOOLS_ONLY), _export()],
        [_edge("n-data", "n-export", "input")],
    )

    assert result["status"] == "failed"
    assert result["errors"] == [{"node_id": "n-export", "message": "Layer not found"}]
    assert run.jobs == [("n-data", "layer_create_filtered")]


def test_a_copy_of_a_dataset_that_raised_is_not_run_again() -> None:
    run = _Run(raising={"layer_create_filtered": "Job job-n-data was cancelled"})

    result = run(
        [_dataset(filter=SCHOOLS_ONLY), _export(), _export("n-export-2")],
        [
            _edge("n-data", "n-export", "input"),
            _edge("n-data", "n-export-2", "input"),
        ],
    )

    assert run.jobs == [("n-data", "layer_create_filtered")]
    assert result["errors"] == [
        {"node_id": "n-export", "message": "Job job-n-data was cancelled"},
        {"node_id": "n-export-2", "message": "Job job-n-data was cancelled"},
    ]


def test_an_export_fed_by_a_tool_and_a_dataset_saves_the_tools_result() -> None:
    """A dataset connected next to a step's result is not saved instead of
    it, whatever the order of the connections."""
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), BUFFER, _export()],
        [
            _edge("n-data", "n-buffer"),
            _edge("n-data", "n-export", "input"),
            _edge("n-buffer", "n-export", "input"),
        ],
    )

    assert run.jobs == [("n-buffer", "buffer"), ("n-export", "finalize_layer")]
    assert run.tool_inputs["n-export"]["node_id"] == "n-buffer"


def test_an_export_without_a_name_behind_a_dataset_copies_nothing() -> None:
    run = _Run()

    run(
        [_dataset(filter=SCHOOLS_ONLY), _export(datasetName="")],
        [_edge("n-data", "n-export", "input")],
    )

    assert run.jobs == []


def test_a_dataset_step_without_a_layer_saves_nothing() -> None:
    run = _Run()

    run([_dataset(layerId=None), _export()], [_edge("n-data", "n-export", "input")])

    assert run.jobs == []


# -- the style of a saved dataset ------------------------------------------------

STYLE = {"color": [12, 34, 56], "visibility": True}
REMEMBERED = {"color": [200, 0, 0], "visibility": True}


def test_a_dataset_is_saved_in_its_own_style() -> None:
    """The copy carries the dataset layer's style into its temp metadata,
    which finalize_layer applies when the export brings no style of its
    own."""
    run = _Run(styles={LAYER: STYLE})

    run(
        [_dataset(filter=SCHOOLS_ONLY), _export()],
        [_edge("n-data", "n-export", "input")],
    )

    assert run.tool_inputs["n-data"]["source_properties"] == STYLE
    assert run.styled == ["n-data"]
    assert "properties" not in run.tool_inputs["n-export"]


def test_a_dataset_behind_an_if_is_saved_in_its_own_style() -> None:
    run = _Run(styles={LAYER: STYLE})

    run(
        [_dataset(filter=SCHOOLS_ONLY), _if("n-if"), _export()],
        [_edge("n-data", "n-if", "input"), _true("n-if", "n-export", "input")],
    )

    # The style of the dataset the If passes on, copied into the If's folder.
    assert run.tool_inputs["n-if"]["source_properties"] == STYLE
    assert run.styled == ["n-data"]
    assert "properties" not in run.tool_inputs["n-export"]


def test_a_dataset_without_a_style_gets_the_default_style() -> None:
    run = _Run()

    run([_dataset(), _export()], [_edge("n-data", "n-export", "input")])

    assert run.tool_inputs["n-data"]["source_properties"] is None
    assert "properties" not in run.tool_inputs["n-export"]


def test_a_remembered_style_wins_over_the_datasets_own() -> None:
    run = _Run(styles={LAYER: STYLE})

    run(
        [_dataset(), _export(outputStyle=REMEMBERED)],
        [_edge("n-data", "n-export", "input")],
    )

    assert run.tool_inputs["n-export"]["properties"] == REMEMBERED
