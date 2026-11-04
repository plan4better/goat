"""A workflow check builds a tool step's arguments the way a run does.

`build_check_arguments` runs the runner's own chain (variables, list
coercion, connected layers, folding of numbered inputs, run context) with
placeholders for what only a run knows, so the parameter model sees the
values a tool job would get.
"""

from typing import Any

import pytest
from goatlib.tools.registry import get_tool
from goatlib.tools.workflow_arguments import PLACEHOLDER_ID, build_check_arguments
from goatlib.tools.workflow_runner import WorkflowRunnerParams, build_tool_inputs

pytestmark = pytest.mark.unit

LAYER = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def _dataset(
    node_id: str = "data", layer_id: str | None = LAYER, **extra: Any
) -> dict[str, Any]:
    data: dict[str, Any] = {"type": "dataset", "label": "Schools", **extra}
    if layer_id:
        data["layerId"] = layer_id
    return {"id": node_id, "type": "dataset", "data": data}


def _tool(node_id: str, process_id: str, config: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "tool",
        "data": {
            "type": "tool",
            "processId": process_id,
            "label": "Step",
            "config": config,
        },
    }


def _edge(source: str, target: str, handle: str | None) -> dict[str, Any]:
    return {
        "id": f"{source}-{target}-{handle}",
        "source": source,
        "target": target,
        "targetHandle": handle,
    }


def test_a_connected_dataset_feeds_the_input_with_its_filter() -> None:
    expression = {"attribute": "kind", "expression": "is", "value": "school"}
    data = _dataset(filter={"op": "and", "expressions": [expression]})
    buffer = _tool("buffer", "buffer", {"distances": [100], "units": "meters"})
    edges = [_edge("data", "buffer", "input_layer_id")]

    args = build_check_arguments(buffer, [data, buffer], edges, [])

    assert args["input_layer_id"] == LAYER
    assert args["input_layer_filter"] == {
        "op": "=",
        "args": [{"property": "kind"}, "school"],
    }
    assert args["distances"] == [100]
    # The tool's own parameter model accepts what the check built.
    get_tool("buffer").get_params_class()(**args)


def test_a_dataset_behind_an_if_step_feeds_the_input_with_its_filter() -> None:
    """An If passes the dataset's layer on with its filter, in a check as in
    a run (`workflow_runner.dataset_filter_for_source`)."""
    expression = {"attribute": "kind", "expression": "is", "value": "school"}
    data = _dataset(filter={"op": "and", "expressions": [expression]})
    condition = {"id": "if", "type": "if", "data": {"type": "if"}}
    buffer = _tool("buffer", "buffer", {"distances": [100], "units": "meters"})
    edges = [_edge("data", "if", "input"), _edge("if", "buffer", "input_layer_id")]

    args = build_check_arguments(buffer, [data, condition, buffer], edges, [])

    assert args["input_layer_filter"] == {
        "op": "=",
        "args": [{"property": "kind"}, "school"],
    }
    get_tool("buffer").get_params_class()(**args)


def _condition(node_id: str = "if") -> dict[str, Any]:
    return {"id": node_id, "type": "if", "data": {"type": "if"}}


def test_an_if_step_delivers_the_layer_it_passes_on() -> None:
    """An If passes its input's layer on, so a check gives the step behind it
    the same id as a run does: a dataset's own layer, and a tool's temp
    layer named after that tool's step."""
    data = _dataset()
    first = _tool("first", "buffer", {"distances": [100]})
    centroid = _tool("centroid", "centroid", {})
    edges = [
        _edge("data", "if-a", "input"),
        _edge("if-a", "first", "input_layer_id"),
        _edge("first", "if-b", "input"),
        _edge("if-b", "centroid", "input_layer_id"),
    ]
    nodes = [data, _condition("if-a"), first, _condition("if-b"), centroid]

    assert build_check_arguments(first, nodes, edges, [])["input_layer_id"] == LAYER
    assert (
        build_check_arguments(centroid, nodes, edges, [])["input_layer_id"]
        == f"{PLACEHOLDER_ID}:first:{PLACEHOLDER_ID}"
    )


def test_an_if_step_without_an_input_still_fills_the_input() -> None:
    """`if_input_count` reports the If; the step behind it is judged as if
    something came through."""
    buffer = _tool("buffer", "buffer", {"distances": [100]})
    edges = [_edge("if", "buffer", "input_layer_id")]

    args = build_check_arguments(buffer, [_condition(), buffer], edges, [])

    assert args["input_layer_id"] == f"{PLACEHOLDER_ID}:if:{PLACEHOLDER_ID}"


def test_an_upstream_tool_step_delivers_a_placeholder_temp_layer() -> None:
    first = _tool("first", "buffer", {"distances": [100]})
    second = _tool("second", "centroid", {})
    edges = [_edge("first", "second", "input_layer_id")]

    args = build_check_arguments(second, [first, second], edges, [])

    assert args["input_layer_id"] == f"{PLACEHOLDER_ID}:first:{PLACEHOLDER_ID}"


def test_a_dataset_without_a_layer_still_fills_the_input() -> None:
    data = _dataset(layer_id=None, unresolved=True)
    buffer = _tool("buffer", "buffer", {"distances": [100]})
    edges = [_edge("data", "buffer", "input_layer_id")]

    args = build_check_arguments(buffer, [data, buffer], edges, [])

    assert args["input_layer_id"] == PLACEHOLDER_ID


def test_a_variable_resolves_to_its_default_and_is_wrapped_for_a_list() -> None:
    buffer = _tool("buffer", "buffer", {"distances": "{{@reach}}"})
    reach = {"name": "reach", "type": "number", "defaultValue": 250}

    args = build_check_arguments(buffer, [buffer], [], [reach])

    assert args["distances"] == [250]


def test_an_unknown_variable_raises() -> None:
    buffer = _tool("buffer", "buffer", {"distances": "{{@reach}}"})
    other = {"name": "other", "type": "number", "defaultValue": 1}

    with pytest.raises(ValueError, match="Unknown workflow variable: reach"):
        build_check_arguments(buffer, [buffer], [], [other])


def test_numbered_opportunity_handles_fold_into_the_opportunities_list() -> None:
    schools = _dataset("schools", LAYER)
    hospitals = _dataset("hospitals", OTHER)
    heatmap = _tool(
        "heat",
        "heatmap_gravity",
        {
            "routing_mode": "walking",
            "opportunity_2_max_cost": 15,
            "opportunity_2_potential_field": "beds",
        },
    )
    edges = [
        _edge("schools", "heat", "opportunity_layer_1_id"),
        _edge("hospitals", "heat", "opportunity_layer_2_id"),
    ]

    args = build_check_arguments(heatmap, [schools, hospitals, heatmap], edges, [])

    assert args["opportunities"] == [
        {"input_path": LAYER},
        {"input_path": OTHER, "max_cost": 15, "potential_field": "beds"},
    ]
    assert not [key for key in args if key.startswith("opportunity_")]


def test_none_values_are_left_out_like_the_tool_job_does() -> None:
    buffer = _tool("buffer", "buffer", {"distances": [100], "distance_field": None})

    args = build_check_arguments(buffer, [buffer], [], [])

    assert "distance_field" not in args
    assert args["user_id"] == PLACEHOLDER_ID
    assert args["temp_mode"] is True
    assert args["node_id"] == "buffer"
    assert args["result_layer_name"] == "Step"


def test_the_check_builds_what_the_run_builds() -> None:
    data = _dataset()
    first = _tool("first", "buffer", {"distances": "{{@reach}}"})
    clip = _tool("clip", "clip", {})
    nodes = [data, first, clip]
    edges = [
        _edge("data", "first", "input_layer_id"),
        _edge("first", "clip", "input_layer_id"),
        _edge("data", "clip", "overlay_layer_id"),
    ]
    variables = [{"name": "reach", "type": "number", "defaultValue": 250}]
    params = WorkflowRunnerParams(
        user_id=PLACEHOLDER_ID,
        project_id=PLACEHOLDER_ID,
        workflow_id=PLACEHOLDER_ID,
        folder_id=PLACEHOLDER_ID,
        nodes=nodes,
        edges=edges,
        variables=variables,
    )
    results = {"first": {"temp_layer_id": f"{PLACEHOLDER_ID}:first:{PLACEHOLDER_ID}"}}

    for node in (first, clip):
        run = build_tool_inputs(node, edges, nodes, results, params)
        check = build_check_arguments(node, nodes, edges, variables)
        assert check == {k: v for k, v in run.items() if v is not None}


def test_the_check_builds_what_the_run_builds_behind_if_steps() -> None:
    """In a run an If's result passes its input's layer id on
    (`if_node.execute_if_node`); the check gives the same ids."""
    data = _dataset()
    first = _tool("first", "buffer", {"distances": [100]})
    clip = _tool("clip", "clip", {})
    nodes = [data, _condition("if-a"), first, _condition("if-b"), clip]
    edges = [
        _edge("data", "if-a", "input"),
        _edge("if-a", "first", "input_layer_id"),
        _edge("first", "if-b", "input"),
        _edge("if-b", "clip", "input_layer_id"),
        _edge("if-a", "clip", "overlay_layer_id"),
    ]
    params = WorkflowRunnerParams(
        user_id=PLACEHOLDER_ID,
        project_id=PLACEHOLDER_ID,
        workflow_id=PLACEHOLDER_ID,
        folder_id=PLACEHOLDER_ID,
        nodes=nodes,
        edges=edges,
    )
    first_layer = f"{PLACEHOLDER_ID}:first:{PLACEHOLDER_ID}"
    results = {
        "if-a": {"temp_layer_id": LAYER},
        "first": {"temp_layer_id": first_layer},
        "if-b": {"temp_layer_id": first_layer},
    }

    for node in (first, clip):
        run = build_tool_inputs(node, edges, nodes, results, params)
        check = build_check_arguments(node, nodes, edges, [])
        assert check == {k: v for k, v in run.items() if v is not None}


def test_a_connection_without_a_named_input_feeds_input_layer_id() -> None:
    data = _dataset()
    buffer = _tool("buffer", "buffer", {"distances": [100]})
    params = WorkflowRunnerParams(
        user_id=PLACEHOLDER_ID,
        project_id=PLACEHOLDER_ID,
        workflow_id=PLACEHOLDER_ID,
        folder_id=PLACEHOLDER_ID,
        nodes=[data, buffer],
        edges=[],
    )
    missing = {"id": "e1", "source": "data", "target": "buffer"}
    null = {"id": "e2", "source": "data", "target": "buffer", "targetHandle": None}

    for edge in (missing, null):
        inputs = build_tool_inputs(buffer, [edge], [data, buffer], {}, params)
        assert inputs["input_layer_id"] == LAYER
        assert None not in inputs
