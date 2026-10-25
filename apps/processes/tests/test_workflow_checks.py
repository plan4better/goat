"""`check_workflow` lists a workflow's issues the way a run would meet them.

Real tools from the registry: buffer (one input, settings shown by
`visible_when`), aggregate_points (required settings), heatmap_2sfca (a
required setting shown only once its layer is connected), heatmap_gravity
(numbered opportunity inputs), catchment_area_v2 (starting points), dissolve
(multi-select fields). Layer fields come from a fake `layer_fields`, feature
counts from a fake `layer_feature_count`.
"""

import threading
from typing import Any

import pytest
from goatlib.analysis.accessibility.heatmap_v2 import MAX_SEED_POINTS_TOTAL
from goatlib.tools.if_node import IF_FALSE_HANDLE, IF_TRUE_HANDLE
from goatlib.workflows.checks import Issue

from processes.services.workflow_checks import check_workflow, step_name

LAYER = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def dataset(
    node_id: str = "data", layer_id: str | None = LAYER, **extra: Any
) -> dict[str, Any]:
    data: dict[str, Any] = {"type": "dataset", "label": "Schools", **extra}
    if layer_id:
        data["layerId"] = layer_id
    return {
        "id": node_id,
        "type": "dataset",
        "position": {"x": 0, "y": 0},
        "data": data,
    }


def tool(
    node_id: str,
    process_id: str,
    config: dict[str, Any] | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "type": "tool",
        "processId": process_id,
        "config": config or {},
        "status": "idle",
    }
    if label is not None:
        data["label"] = label
    return {"id": node_id, "type": "tool", "position": {"x": 0, "y": 0}, "data": data}


def step(node_id: str, kind: str, **data: Any) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": kind,
        "position": {"x": 0, "y": 0},
        "data": {"type": kind, **data},
    }


def edge(source: str, target: str, handle: str | None = None) -> dict[str, Any]:
    connection: dict[str, Any] = {
        "id": f"{source}-{target}-{handle}",
        "source": source,
        "target": target,
    }
    if handle is not None:
        connection["targetHandle"] = handle
    return connection


class FakeFields:
    """`layer_fields` answering from a dict, remembering what it was asked."""

    def __init__(self, fields: dict[str, list[str]] | None = None) -> None:
        self.fields = fields or {}
        self.asked: list[str] = []

    async def __call__(self, layer_id: str) -> list[str] | None:
        self.asked.append(layer_id)
        return self.fields.get(layer_id)


class FakeCounts:
    """`layer_feature_count` answering from a dict, remembering what it was
    asked."""

    def __init__(self, counts: dict[str, int] | None = None) -> None:
        self.counts = counts or {}
        self.asked: list[str] = []

    async def __call__(self, layer_id: str) -> int | None:
        self.asked.append(layer_id)
        return self.counts.get(layer_id)


async def check(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    variables: list[dict[str, Any]] | None = None,
    *,
    language: str = "en",
    unreadable: frozenset[str] = frozenset(),
    fields: FakeFields | None = None,
    counts: FakeCounts | None = None,
) -> list[Issue]:
    return await check_workflow(
        nodes,
        edges,
        variables or [],
        language=language,
        unreadable_layer_ids=unreadable,
        layer_fields=fields or FakeFields(),
        layer_feature_count=counts or FakeCounts(),
    )


def codes(issues: list[Issue]) -> list[str]:
    return [issue.code for issue in issues]


def only(issues: list[Issue], code: str) -> Issue:
    found = [issue for issue in issues if issue.code == code]
    assert len(found) == 1, issues
    return found[0]


def buffer_chain(
    config: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """A dataset wired into a buffer step with `config`."""
    return (
        [dataset(), tool("buffer", "buffer", config)],
        [edge("data", "buffer", "input_layer_id")],
    )


# -- the workflow as a whole ----------------------------------------------------


async def test_a_complete_buffer_workflow_has_no_issue() -> None:
    nodes, edges = buffer_chain({"distances": [100], "units": "meters"})

    assert await check(nodes, edges) == []


async def test_a_damaged_workflow_gets_only_its_damaged_issues() -> None:
    nodes = [{"type": "tool", "data": {"type": "tool"}}, tool("buffer", "buffer")]

    issues = await check(nodes, [])

    assert codes(issues) == ["node_without_id"]
    assert issues[0].level == "damaged"


async def test_steps_and_connections_that_are_not_objects_are_damaged() -> None:
    nodes, edges = buffer_chain({"distances": [100]})

    broken_nodes: list[Any] = ["not a step", *nodes]
    broken_edges: list[Any] = [*edges, None]

    assert codes(await check(broken_nodes, edges)) == ["node_without_id"]
    assert codes(await check(nodes, broken_edges)) == ["edge_without_ends"]


async def test_a_workflow_without_a_tool_step_has_no_issue() -> None:
    assert await check([dataset(), step("out", "export", label="Result")], []) == []


async def test_steps_in_a_cycle_form_a_loop() -> None:
    nodes = [
        dataset(),
        tool("a", "buffer", {"distances": [100]}, label="Near"),
        tool("b", "buffer", {"distances": [200]}, label="Far"),
    ]
    edges = [
        edge("data", "a", "input_layer_id"),
        edge("a", "b", "input_layer_id"),
        edge("b", "a", "input_layer_id"),
    ]

    loop = only(await check(nodes, edges), "loop")

    assert loop.node_ids == ("a", "b")
    assert loop.params == {"steps": ["Near", "Far"]}


async def test_a_connection_to_a_removed_step_is_reported_once() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    edges += [edge("buffer", "gone"), edge("gone", "buffer", "input_layer_id")]

    issue = only(await check(nodes, edges), "connection_to_removed_step")

    assert issue.node_ids == ()


async def test_a_connection_to_an_input_the_tool_does_not_have() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(dataset("roads", OTHER))
    edges.append(edge("roads", "buffer", "overlay_layer_id"))

    issue = only(await check(nodes, edges), "connection_to_unknown_input")

    assert issue.node_ids == ("buffer",)
    assert issue.field == "overlay_layer_id"
    assert issue.params == {"step": "Buffer", "input": "overlay_layer_id"}


# -- tool steps -----------------------------------------------------------------


async def test_a_tool_step_without_a_tool() -> None:
    nodes = [dataset(), tool("t", "", label="New step")]

    issue = only(
        await check(nodes, [edge("data", "t", "input_layer_id")]), "tool_missing"
    )

    assert issue.params == {"step": "New step"}


async def test_a_tool_that_does_not_exist_any_more() -> None:
    nodes = [dataset(), tool("t", "retired_tool", label="Old step")]

    issue = only(
        await check(nodes, [edge("data", "t", "input_layer_id")]), "tool_removed"
    )

    assert issue.params == {"step": "Old step", "tool": "retired_tool"}


async def test_an_input_without_a_connection_in_the_callers_language() -> None:
    nodes = [tool("buffer", "buffer", {"distances": [100]})]

    english = only(await check(nodes, []), "input_not_connected")
    german = only(await check(nodes, [], language="de"), "input_not_connected")

    assert english.field == "input_layer_id"
    assert english.params == {"step": "Buffer", "label": "Input layer"}
    assert english.message == "Buffer: Input layer is not connected."
    assert german.params == {"step": "Puffer", "label": "Eingabe-Layer"}


async def test_a_tool_step_keeps_its_tools_title_until_renamed() -> None:
    # The editor labels every new tool step with its tool id.
    default = [tool("buffer", "buffer", {"distances": [100]}, label="buffer")]
    renamed = [tool("buffer", "buffer", {"distances": [100]}, label="Near schools")]

    english = only(await check(default, []), "input_not_connected")
    german = only(await check(default, [], language="de"), "input_not_connected")
    own = only(await check(renamed, [], language="de"), "input_not_connected")

    assert english.params["step"] == "Buffer"
    assert german.params["step"] == "Puffer"
    assert own.params["step"] == "Near schools"


def test_the_name_of_a_step() -> None:
    assert step_name(tool("t", "buffer", label="buffer"), language="de") == "Puffer"
    assert step_name(tool("t", "buffer"), language="en") == "Buffer"
    renamed = tool("t", "buffer", label="Near schools")
    assert step_name(renamed, language="de") == "Near schools"
    retired = tool("t", "retired_tool", label="retired_tool")
    assert step_name(retired, language="en") == "retired_tool"
    assert step_name(dataset(label="Schools"), language="en") == "Schools"
    assert step_name(step("out", "export", label=""), language="en") == "export"


async def test_starting_points_need_a_connection() -> None:
    nodes = [tool("ca", "catchment_area_v2", {"routing_mode": "walking"})]

    issues = await check(nodes, [])

    assert codes(issues) == ["input_not_connected"]
    assert issues[0].field == "starting_points"


async def test_an_opportunity_tool_without_opportunity_layers() -> None:
    nodes = [tool("heat", "heatmap_gravity", {"routing_mode": "walking"})]

    issues = await check(nodes, [])

    assert codes(issues) == ["opportunity_not_connected"]
    assert issues[0].params == {"step": "Heatmap Gravity"}


async def test_one_connected_opportunity_layer_is_enough() -> None:
    nodes = [dataset(), tool("heat", "heatmap_gravity", {"routing_mode": "walking"})]

    issues = await check(nodes, [edge("data", "heat", "opportunity_layer_2_id")])

    assert issues == []


async def test_required_settings_left_empty() -> None:
    nodes = [dataset(), tool("agg", "aggregate_points", {"column_statistics": []})]

    issues = await check(nodes, [edge("data", "agg", "source_layer_id")])

    required = [issue for issue in issues if issue.code == "setting_required"]
    assert [issue.field for issue in required] == ["area_type", "column_statistics"]
    assert required[0].params == {"step": "Aggregate Points", "label": "Area Type"}


async def test_a_required_setting_counts_only_while_it_is_shown() -> None:
    # demand_field is shown once the demand layer is connected.
    heatmap = tool("heat", "heatmap_2sfca", {"routing_mode": "walking"}, label="Supply")
    opportunity = edge("data", "heat", "opportunity_layer_1_id")
    demand = edge("homes", "heat", "demand_layer_id")

    hidden = await check([dataset(), heatmap], [opportunity])
    shown = await check(
        [dataset(), dataset("homes", OTHER), heatmap], [opportunity, demand]
    )

    assert codes(hidden) == ["input_not_connected"]
    assert hidden[0].field == "demand_layer_id"
    assert codes(shown) == ["setting_required"]
    assert shown[0].field == "demand_field"


async def test_a_reference_to_a_variable_that_does_not_exist() -> None:
    nodes, edges = buffer_chain({"distances": "{{@reach}}"})

    issue = only(await check(nodes, edges), "variable_undefined")

    assert issue.field == "distances"
    assert issue.params == {"step": "Buffer", "variable": "reach"}


async def test_a_defined_variable_is_no_issue() -> None:
    nodes, edges = buffer_chain({"distances": "{{@reach}}"})
    reach = {"name": "reach", "type": "number", "defaultValue": 250}

    assert await check(nodes, edges, [reach]) == []


# -- dataset, If and export steps ---------------------------------------------


async def test_a_dataset_step_without_a_layer() -> None:
    nodes = [
        dataset(layer_id=None, label="Schools"),
        dataset("open", OTHER, label="Template input", unresolved=True),
        tool("a", "buffer", {"distances": [100]}),
        tool("b", "buffer", {"distances": [100]}),
    ]
    edges = [edge("data", "a", "input_layer_id"), edge("open", "b", "input_layer_id")]

    issues = await check(nodes, edges)

    assert codes(issues) == ["layer_not_chosen", "layer_not_chosen"]
    assert [issue.params["step"] for issue in issues] == ["Schools", "Template input"]


def if_step(**data: Any) -> dict[str, Any]:
    return step("if", "if", label="Enough schools?", **data)


COUNT_ROW = {
    "id": "r",
    "kind": "statistic",
    "method": "count",
    "operator": ">",
    "value": 10,
}


async def test_an_if_step_needs_exactly_one_incoming_connection() -> None:
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [dataset(), dataset("more", OTHER), if_step(condition=condition)]
    nodes.append(tool("buffer", "buffer", {"distances": [100]}))
    out = edge("if", "buffer", "input_layer_id")

    none = only(await check(nodes, [out]), "if_input_count")
    two = only(
        await check(nodes, [edge("data", "if"), edge("more", "if"), out]),
        "if_input_count",
    )

    assert none.params == {"step": "Enough schools?", "count": 0}
    assert two.params["count"] == 2


async def test_an_if_condition_must_be_complete() -> None:
    nodes = [dataset(), tool("buffer", "buffer", {"distances": [100]})]
    edges = [edge("data", "if"), edge("if", "buffer", "input_layer_id")]
    no_value = {**COUNT_ROW, "value": None}
    no_field = {**COUNT_ROW, "method": "mean"}
    logical = {"id": "l", "attribute": "kind", "expression": "is", "value": ""}
    blank = {"id": "b", "attribute": "kind", "expression": "is_blank"}

    def condition(row: dict[str, Any]) -> dict[str, Any]:
        return {"op": "and", "expressions": [row]}

    for data in (
        {},
        {"condition": {"op": "and", "expressions": []}},
        {"condition": condition(no_value)},
        {"condition": condition(no_field)},
        {"condition": condition(logical)},
        {"mode": "custom", "customExpression": "  "},
    ):
        issues = await check([*nodes, if_step(**data)], edges)
        assert codes(issues) == ["if_condition_incomplete"], data

    for data in (
        {"condition": condition(COUNT_ROW)},
        {"condition": condition(blank)},
        {"mode": "custom", "customExpression": "COUNT(*) > 10"},
    ):
        assert await check([*nodes, if_step(**data)], edges) == [], data


async def test_an_if_condition_using_an_undefined_variable() -> None:
    row = {**COUNT_ROW, "value": "{{@minimum}}"}
    nodes = [
        dataset(),
        if_step(condition={"op": "and", "expressions": [row]}),
        tool("buffer", "buffer", {"distances": [100]}),
    ]
    edges = [edge("data", "if"), edge("if", "buffer", "input_layer_id")]

    issue = only(await check(nodes, edges), "variable_undefined")

    assert issue.node_ids == ("if",)
    assert issue.field is None
    assert issue.params == {"step": "Enough schools?", "variable": "minimum"}


async def test_an_export_step_needs_a_name_once_something_is_connected() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(step("out", "export", label="Save", datasetName="  "))
    edges.append(edge("buffer", "out"))

    issue = only(await check(nodes, edges), "export_name_missing")

    assert issue.level == "error"
    assert issue.field == "datasetName"


async def test_an_export_straight_behind_a_dataset_needs_a_name() -> None:
    """Without a tool step the run still saves the dataset's rows
    (`workflow_runner`), so the workflow is judged like any other."""
    nodes = [dataset(), step("out", "export", label="Save", datasetName="  ")]

    issue = only(await check(nodes, [edge("data", "out")]), "export_name_missing")

    assert issue.level == "error"
    assert issue.node_ids == ("out",)


async def test_an_export_straight_behind_a_dataset_with_a_name_has_no_issue() -> None:
    nodes = [dataset(), step("out", "export", label="Save", datasetName="Schools")]

    assert await check(nodes, [edge("data", "out")]) == []


async def test_an_export_behind_a_dataset_next_to_a_tool_needs_a_name() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(step("out", "export", label="Save", datasetName="  "))
    edges.append(edge("data", "out"))

    assert codes(await check(nodes, edges)) == ["export_name_missing"]


async def test_an_export_adding_to_a_chosen_dataset_needs_no_name() -> None:
    """Adding the rows to an existing dataset saves no new one, so there is
    no name to give."""
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(
        step("out", "export", label="Save", destination="existing", targetLayerId=OTHER)
    )
    edges.append(edge("buffer", "out"))

    assert await check(nodes, edges) == []


async def test_an_export_adding_to_an_existing_dataset_needs_that_dataset() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(
        step("out", "export", label="Save", destination="existing", datasetName="")
    )
    edges.append(edge("buffer", "out"))

    issues = await check(nodes, edges)

    # The hidden name field is not judged.
    assert codes(issues) == ["export_target_missing"]
    issue = issues[0]
    assert issue.level == "error"
    assert issue.node_ids == ("out",)
    assert issue.field == "targetLayerId"
    assert issue.params == {"step": "Save"}


async def test_an_export_to_a_new_dataset_still_needs_a_name() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(
        step("out", "export", label="Save", destination="new", targetLayerId=OTHER)
    )
    edges.append(edge("buffer", "out"))

    assert codes(await check(nodes, edges)) == ["export_name_missing"]


async def test_an_export_step_with_nothing_connected_is_only_a_warning() -> None:
    # It saves nothing, and a run passes it by.
    nodes, edges = buffer_chain({"distances": [100]})
    nodes.append(step("out", "export", label="Save", datasetName="  "))

    issues = await check(nodes, edges)

    assert [(i.code, i.level) for i in issues] == [("export_not_connected", "warning")]
    assert issues[0].params == {"step": "Save"}


# -- warnings -------------------------------------------------------------------


async def test_an_unconnected_step_with_no_other_issue_is_a_warning() -> None:
    nodes, edges = buffer_chain({"distances": [100]})
    nodes += [
        dataset("spare", OTHER, label="Spare"),
        tool("lonely", "buffer", {"distances": [100]}),
        step("note", "textAnnotation", text="<p>Remember</p>"),
    ]

    issues = await check(nodes, edges)

    warning = only(issues, "step_not_connected")
    assert warning.level == "warning"
    assert warning.node_ids == ("spare",)
    # The unconnected buffer has an issue of its own; the note is never checked.
    assert only(issues, "input_not_connected").node_ids == ("lonely",)


# -- valid values ---------------------------------------------------------------


async def test_a_value_the_tool_rejects_is_reported_on_the_step() -> None:
    nodes, edges = buffer_chain({"distances": [-5], "units": "meters"})

    issue = only(await check(nodes, edges), "setting_invalid")

    assert issue.field is None
    assert issue.params == {
        "step": "Buffer",
        "label": "",
        "reason": "All buffer distances must be positive numbers.",
    }
    assert issue.message == "Buffer: All buffer distances must be positive numbers."


async def test_an_option_that_does_not_exist_is_reported_on_its_setting() -> None:
    nodes, edges = buffer_chain({"distances": [100], "units": "parsecs"})

    issue = only(await check(nodes, edges), "setting_invalid")

    assert issue.field == "units"
    assert issue.params["label"] == "Distance Units"
    assert issue.params["reason"].startswith("Input should be 'meters'")


async def test_settings_that_do_not_fit_together() -> None:
    nodes, edges = buffer_chain({"distances": [100], "polygon_difference": True})

    issue = only(await check(nodes, edges), "setting_invalid")

    assert issue.field is None
    assert issue.params["reason"] == (
        "polygon_difference can only be True when polygon_union is also True."
    )


async def test_a_variable_is_validated_with_its_default_value() -> None:
    nodes, edges = buffer_chain({"distances": "{{@reach}}"})
    negative = {"name": "reach", "type": "number", "defaultValue": -5}

    issue = only(await check(nodes, edges, [negative]), "setting_invalid")

    assert issue.params["reason"] == "All buffer distances must be positive numbers."


async def test_an_opportunity_setting_error_names_its_numbered_setting() -> None:
    heatmap = tool(
        "heat",
        "heatmap_gravity",
        {"routing_mode": "walking", "opportunity_3_max_cost": -3},
    )
    nodes = [dataset(), dataset("hospitals", OTHER), heatmap]
    edges = [
        edge("data", "heat", "opportunity_layer_1_id"),
        edge("hospitals", "heat", "opportunity_layer_3_id"),
    ]

    issue = only(await check(nodes, edges), "setting_invalid")

    # The second connected opportunity layer sits on handle 3.
    assert issue.field == "opportunity_3_max_cost"
    assert issue.params["reason"] == "Input should be greater than 0"


async def test_the_end_to_end_buffer_workflow_has_no_blocking_issue() -> None:
    """The workflow the end-to-end suite builds and runs
    (`createBufferWorkflow` in apps/web/playwright/fixtures/projects.ts), also
    with the stale layer id it can keep in the input the edge feeds."""
    for stale in (None, OTHER):
        config: dict[str, Any] = {"distances": [100], "units": "meters"}
        if stale:
            config["input_layer_id"] = stale
        nodes = [
            {
                "id": "dataset-e2e",
                "type": "dataset",
                "position": {"x": 100, "y": 150},
                "data": {
                    "type": "dataset",
                    "label": "Points",
                    "layerId": LAYER,
                    "layerName": "Points",
                    "geometryType": "point",
                    "layerType": "feature",
                },
            },
            {
                "id": "tool-e2e",
                "type": "tool",
                "position": {"x": 450, "y": 150},
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "label": "Buffer",
                    "status": "idle",
                    "config": config,
                },
            },
        ]
        edges = [
            {
                "id": "edge-e2e",
                "source": "dataset-e2e",
                "target": "tool-e2e",
                "targetHandle": "input_layer_id",
            }
        ]

        issues = await check(nodes, edges, unreadable=frozenset({OTHER}))

        assert [i for i in issues if i.level != "warning"] == [], stale


# -- fields and access ---------------------------------------------------------


def field_buffer(field: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return buffer_chain({"distance_type": "field", "distance_field": field})


async def test_a_field_the_layer_does_not_have() -> None:
    fields = FakeFields({LAYER: ["name", "width"]})

    issue = only(
        await check(*field_buffer("speed"), fields=fields), "field_not_in_layer"
    )

    assert issue.node_ids == ("buffer",)
    assert issue.field == "distance_field"
    assert issue.params == {
        "step": "Buffer",
        "label": "Distance Field",
        "field_name": "speed",
    }
    assert await check(*field_buffer("width"), fields=fields) == []


async def test_the_fields_of_an_unknown_layer_are_not_judged() -> None:
    assert await check(*field_buffer("speed"), fields=FakeFields()) == []


async def test_a_field_setting_the_form_hides_is_not_judged() -> None:
    # A constant distance hides distance_field; its old value stays in the config.
    nodes, edges = buffer_chain({"distances": [100], "distance_field": "speed"})

    assert await check(nodes, edges, fields=FakeFields({LAYER: ["width"]})) == []


async def test_every_name_of_a_multi_select_field_setting_is_checked() -> None:
    nodes = [
        dataset(),
        tool("dissolve", "dissolve", {"dissolve_fields": ["district", "kind"]}),
    ]
    edges = [edge("data", "dissolve", "input_layer_id")]

    issue = only(
        await check(nodes, edges, fields=FakeFields({LAYER: ["district"]})),
        "field_not_in_layer",
    )

    assert issue.field == "dissolve_fields"
    assert issue.params["field_name"] == "kind"


async def test_a_list_items_field_is_read_from_the_layer_its_own_widget_names() -> None:
    # aggregate_polygon's statistics name no layer on the list itself; each
    # item's field reads source_layer_id, not the areas.
    statistics = [{"operation": "sum", "field": "guessed"}]
    nodes = [
        dataset("residents"),
        dataset("districts", OTHER),
        tool(
            "agg",
            "aggregate_polygon",
            {"area_type": "polygon", "column_statistics": statistics},
        ),
    ]
    edges = [
        edge("residents", "agg", "source_layer_id"),
        edge("districts", "agg", "area_layer_id"),
    ]
    fields = FakeFields({LAYER: ["population"], OTHER: ["guessed"]})

    issue = only(await check(nodes, edges, fields=fields), "field_not_in_layer")

    assert issue.field == "column_statistics"
    assert issue.params["field_name"] == "guessed"
    statistics[0]["field"] = "population"
    assert codes(await check(nodes, edges, fields=fields)) == []


async def test_an_opportunity_field_is_read_from_its_numbered_layer() -> None:
    heatmap = tool(
        "heat",
        "heatmap_gravity",
        {"routing_mode": "walking", "opportunity_2_potential_field": "beds"},
    )
    nodes = [dataset(), dataset("hospitals", OTHER), heatmap]
    edges = [
        edge("data", "heat", "opportunity_layer_1_id"),
        edge("hospitals", "heat", "opportunity_layer_2_id"),
    ]
    fields = FakeFields({LAYER: ["beds"], OTHER: ["name"]})

    issue = only(await check(nodes, edges, fields=fields), "field_not_in_layer")

    assert issue.field == "opportunity_2_potential_field"
    assert issue.params["field_name"] == "beds"


async def test_a_field_read_through_an_if_step_is_checked_against_its_dataset() -> None:
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [
        dataset(),
        if_step(condition=condition),
        tool("buffer", "buffer", {"distance_type": "field", "distance_field": "speed"}),
    ]
    edges = [edge("data", "if"), edge("if", "buffer", "input_layer_id")]

    issues = await check(nodes, edges, fields=FakeFields({LAYER: ["width"]}))

    assert codes(issues) == ["field_not_in_layer"]


async def test_a_field_the_step_before_may_not_produce_is_a_warning() -> None:
    # A merged buffer keeps only buffer_distance; one per feature keeps the
    # input's fields too.
    merged = tool(
        "a", "buffer", {"distances": [100], "polygon_union": True}, label="Merged"
    )
    by_width = tool(
        "b",
        "buffer",
        {"distance_type": "field", "distance_field": "width"},
        label="By width",
    )
    edges = [edge("data", "a", "input_layer_id"), edge("a", "b", "input_layer_id")]
    fields = FakeFields({LAYER: ["name", "width"]})

    issue = only(
        await check([dataset(), merged, by_width], edges, fields=fields),
        "field_maybe_missing",
    )
    each = tool("a", "buffer", {"distances": [100]}, label="Each")

    assert issue.level == "warning"
    assert issue.node_ids == ("b",)
    assert issue.params == {
        "step": "By width",
        "label": "Distance Field",
        "field_name": "width",
    }
    assert await check([dataset(), each, by_width], edges, fields=fields) == []


def joined_then_grouped(
    group_by: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Census points joined to their district, then summed per district by
    `group_by` (aggregate_points' group fields read the joined points)."""
    join = tool(
        "join",
        "join",
        {
            "use_spatial_relationship": True,
            "spatial_relationship": "intersects",
            "use_attribute_relationship": False,
            "join_operation": "one_to_one",
            "join_type": "inner",
            "add_join_fields": True,
            "join_fields": ["district_name"],
        },
        label="District per point",
    )
    agg = tool(
        "agg",
        "aggregate_points",
        {
            "area_type": "polygon",
            "group_by_field": group_by,
            "column_statistics": [{"operation": "sum", "field": "residents"}],
        },
        label="Residents per district",
    )
    nodes = [dataset("points"), dataset("districts", OTHER), join, agg]
    edges = [
        edge("points", "join", "target_layer_id"),
        edge("districts", "join", "join_layer_id"),
        edge("join", "agg", "source_layer_id"),
        edge("districts", "agg", "area_layer_id"),
    ]
    return nodes, edges


JOIN_FIELDS = FakeFields({LAYER: ["residents"], OTHER: ["district_name"]})


async def test_a_field_the_join_renamed_is_an_error_naming_the_joined_field() -> None:
    """A join names the fields it adds join_<field>; a step after it that
    names the field as the join layer has it fails when it runs."""
    nodes, edges = joined_then_grouped(["district_name"])

    issue = only(await check(nodes, edges, fields=JOIN_FIELDS), "field_renamed_by_join")

    assert issue.level == "error"
    assert issue.node_ids == ("agg",)
    assert issue.field == "group_by_field"
    assert issue.params == {
        "step": "Residents per district",
        "label": "Group Fields",
        "field_name": "district_name",
        "joined_field": "join_district_name",
    }
    assert issue.message == (
        "Residents per district: Group Fields names the field district_name, "
        "which the step before does not produce: the join names it "
        "join_district_name."
    )


async def test_the_field_by_its_joined_name_is_no_issue() -> None:
    nodes, edges = joined_then_grouped(["join_district_name"])
    assert await check(nodes, edges, fields=JOIN_FIELDS) == []


async def test_a_field_both_layers_have_is_no_issue() -> None:
    """The target keeps its own district_name beside the join's
    join_district_name: the field is there."""
    nodes, edges = joined_then_grouped(["district_name"])
    fields = FakeFields(
        {LAYER: ["residents", "district_name"], OTHER: ["district_name"]}
    )
    assert await check(nodes, edges, fields=fields) == []


def buffered_by(field: str) -> dict[str, Any]:
    """A buffer whose distance is read from `field` of the step before."""
    return tool(
        "by_field",
        "buffer",
        {"distance_type": "field", "distance_field": field},
        label="By field",
    )


async def test_a_field_a_join_further_up_renamed_is_an_error() -> None:
    """A buffer between keeps the join's fields, join_<field> among them."""
    nodes, edges = joined_then_grouped([])
    ring = tool("ring", "buffer", {"distances": [100]}, label="Ring")
    nodes = [*nodes[:3], ring, buffered_by("district_name")]
    edges = [
        *edges[:2],
        edge("join", "ring", "input_layer_id"),
        edge("ring", "by_field", "input_layer_id"),
    ]

    issue = only(await check(nodes, edges, fields=JOIN_FIELDS), "field_renamed_by_join")

    assert issue.node_ids == ("by_field",)
    assert issue.params["joined_field"] == "join_district_name"


async def test_a_join_prefixed_field_without_a_join_is_only_a_warning() -> None:
    """A saved layer can carry join_<field> from an earlier workflow; with no
    join in this one, the field is only one the step before may not
    produce."""
    ring = tool("ring", "buffer", {"distances": [100]}, label="Ring")
    nodes = [dataset(), ring, buffered_by("district_name")]
    edges = [
        edge("data", "ring", "input_layer_id"),
        edge("ring", "by_field", "input_layer_id"),
    ]
    fields = FakeFields({LAYER: ["join_district_name"]})

    issue = only(await check(nodes, edges, fields=fields), "field_maybe_missing")

    assert issue.level == "warning"
    assert "joined_field" not in issue.params


async def test_an_unreadable_dataset_is_reported_and_never_looked_up() -> None:
    fields = FakeFields({LAYER: ["width"]})

    issues = await check(
        *field_buffer("speed"), unreadable=frozenset({LAYER}), fields=fields
    )

    assert codes(issues) == ["layer_not_readable"]
    assert issues[0].node_ids == ("data",)
    assert issues[0].params == {"step": "Schools"}
    assert fields.asked == []


async def test_a_tool_setting_naming_an_unreadable_layer() -> None:
    catchment = tool(
        "ca",
        "catchment_area_v2",
        {"routing_mode": "walking", "point_grid_layer_id": OTHER},
        label="Reach",
    )
    nodes = [dataset(), catchment]
    edges = [edge("data", "ca", "starting_points")]

    issue = only(
        await check(nodes, edges, unreadable=frozenset({OTHER})), "layer_not_readable"
    )

    assert issue.node_ids == ("ca",)


# -- review fixes ---------------------------------------------------------------


async def test_a_connection_left_at_the_editors_placeholder_input_is_no_issue() -> None:
    # The editor names a tool's only input "input" until the tool's description
    # has loaded; a run passes such a connection on and the tool never reads it.
    nodes, edges = buffer_chain({"distances": [100], "units": "meters"})
    nodes.append(dataset("roads", OTHER))
    edges.append(edge("roads", "buffer", "input"))

    assert await check(nodes, edges) == []
    alone = [
        dataset(),
        tool("buffer", "buffer", {"distances": [100], "units": "meters"}),
    ]
    assert codes(await check(alone, [edge("data", "buffer", "input")])) == [
        "input_not_connected"
    ]


def sql_chain(query: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """A dataset into a custom SQL step into a buffer by the field `width`."""
    nodes = [
        dataset(),
        tool("sql", "custom_sql", {"sql_query": query}, label="Query"),
        tool(
            "b",
            "buffer",
            {"distance_type": "field", "distance_field": "width"},
            label="By width",
        ),
    ]
    edges = [
        edge("data", "sql", "input_layer_1_id"),
        edge("sql", "b", "input_layer_id"),
    ]
    return nodes, edges


async def test_a_field_a_custom_sql_step_produces_is_no_warning() -> None:
    nodes, edges = sql_chain("SELECT name, width, geometry FROM input_1")
    fields = FakeFields({LAYER: ["id", "name", "width", "geometry"]})

    assert await check(nodes, edges, fields=fields) == []


async def test_a_custom_sql_step_whose_output_cannot_be_predicted_judges_nothing() -> (
    None
):
    nodes, edges = sql_chain("SELECT name FROM a_table_that_does_not_exist")
    fields = FakeFields({LAYER: ["id", "name", "width", "geometry"]})

    assert await check(nodes, edges, fields=fields) == []


async def test_the_steps_output_is_predicted_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from processes.services import workflow_checks

    threads: list[threading.Thread] = []
    predict = workflow_checks.predict_node_output_schema

    def recording(*args: Any) -> Any:
        threads.append(threading.current_thread())
        return predict(*args)

    monkeypatch.setattr(workflow_checks, "predict_node_output_schema", recording)
    merged = tool("a", "buffer", {"distances": [100], "polygon_union": True})
    by_width = tool(
        "b", "buffer", {"distance_type": "field", "distance_field": "width"}
    )
    edges = [edge("data", "a", "input_layer_id"), edge("a", "b", "input_layer_id")]

    await check(
        [dataset(), merged, by_width], edges, fields=FakeFields({LAYER: ["width"]})
    )

    assert threads and threading.main_thread() not in threads


# -- the heatmap's destination limit -------------------------------------------

AREA_FILTER = {
    "op": "and",
    "expressions": [
        {
            "id": "f1",
            "type": "spatial",
            "attribute": "geom",
            "expression": "s_intersects",
            "value": '{"type":"Polygon","coordinates":[[[11,48],[12,48],[12,49],[11,48]]]}',
        }
    ],
}
THIRD = "33333333-3333-3333-3333-333333333333"


def heatmap(
    process_id: str = "heatmap_closest_average", **config: Any
) -> dict[str, Any]:
    return tool("heat", process_id, {"routing_mode": "walking", **config})


def opportunities(*node_ids: str) -> list[dict[str, Any]]:
    return [
        edge(node_id, "heat", f"opportunity_layer_{number}_id")
        for number, node_id in enumerate(node_ids, start=1)
    ]


@pytest.mark.parametrize(
    ("process_id", "title"),
    [
        ("heatmap_closest_average", "Heatmap Closest Average"),
        ("heatmap_gravity", "Heatmap Gravity"),
        ("heatmap_2sfca", "Heatmap 2SFCA"),
    ],
)
async def test_destinations_above_the_heatmaps_limit_are_an_error(
    process_id: str, title: str
) -> None:
    counts = FakeCounts({LAYER: 934_847})

    issues = await check(
        [dataset(), heatmap(process_id)], opportunities("data"), counts=counts
    )

    issue = only(issues, "too_many_destinations")
    assert issue.level == "error"
    assert issue.node_ids == ("heat",)
    assert issue.field is None
    assert issue.params == {
        "step": title,
        "features": 934_847,
        "limit": MAX_SEED_POINTS_TOTAL,
    }
    assert issue.message == (
        f"{title}: the opportunity layers without a filter have 934,847 features "
        f"together, more than the {MAX_SEED_POINTS_TOTAL:,} the heatmap takes. "
        "Limit them to an area or with a filter."
    )


async def test_the_destinations_of_every_opportunity_layer_add_up() -> None:
    nodes = [
        dataset(),
        dataset("hospitals", OTHER),
        dataset("doctors", THIRD),
        heatmap(),
    ]
    edges = opportunities("data", "hospitals", "doctors")
    half = MAX_SEED_POINTS_TOTAL // 2

    under = FakeCounts({LAYER: half, OTHER: half})
    over = FakeCounts({LAYER: half, OTHER: half, THIRD: 1})

    assert "too_many_destinations" not in codes(await check(nodes, edges, counts=under))
    issue = only(await check(nodes, edges, counts=over), "too_many_destinations")
    assert issue.params["features"] == MAX_SEED_POINTS_TOTAL + 1


async def test_a_filter_on_an_opportunity_layer_leaves_the_limit_to_the_run() -> None:
    """The count after a filter is not known without reading the layer, so a
    filtered layer adds nothing, however large it is."""
    counts = FakeCounts({LAYER: 934_847, OTHER: 10})
    nodes = [
        dataset(filter=AREA_FILTER),
        dataset("hospitals", OTHER),
        heatmap(),
    ]

    issues = await check(nodes, opportunities("data", "hospitals"), counts=counts)

    assert "too_many_destinations" not in codes(issues)


async def test_unfiltered_layers_over_the_limit_beside_a_filtered_one() -> None:
    """The layers without a filter are over the limit on their own: a filter
    on another layer cannot bring the run under it."""
    counts = FakeCounts({LAYER: 934_847, OTHER: 10})
    nodes = [dataset(), dataset("hospitals", OTHER, filter=AREA_FILTER), heatmap()]

    issues = await check(nodes, opportunities("data", "hospitals"), counts=counts)

    issue = only(issues, "too_many_destinations")
    assert issue.params["features"] == 934_847


async def test_an_empty_filter_is_no_filter() -> None:
    empty = {"op": "and", "expressions": []}
    counts = FakeCounts({LAYER: 934_847})

    issues = await check(
        [dataset(filter=empty), heatmap()], opportunities("data"), counts=counts
    )

    assert codes(issues) == ["too_many_destinations"]


def branch(
    target: str, handle: str | None = None, taken: str = IF_TRUE_HANDLE
) -> dict[str, Any]:
    """A connection from the If step's `taken` output."""
    return {**edge("if", target, handle), "sourceHandle": taken}


async def test_destinations_behind_an_if_step_are_a_warning() -> None:
    """The run skips a heatmap on the If's branch not taken: the limit may
    never be reached, so the issue does not refuse the run."""
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [dataset(), if_step(condition=condition), heatmap()]
    edges = [edge("data", "if"), branch("heat", "opportunity_layer_1_id")]

    issues = await check(nodes, edges, counts=FakeCounts({LAYER: 934_847}))

    issue = only(issues, "too_many_destinations")
    assert issue.level == "warning"
    assert issue.node_ids == ("heat",)
    assert issue.params == {
        "step": "Heatmap Closest Average",
        "features": 934_847,
        "limit": MAX_SEED_POINTS_TOTAL,
    }


async def test_a_heatmap_on_an_ifs_false_branch_is_a_warning_too() -> None:
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [dataset(), if_step(condition=condition), heatmap()]
    edges = [
        edge("data", "if"),
        branch("heat", "opportunity_layer_1_id", taken=IF_FALSE_HANDLE),
    ]

    issues = await check(nodes, edges, counts=FakeCounts({LAYER: 934_847}))

    assert only(issues, "too_many_destinations").level == "warning"


async def test_a_heatmap_behind_an_if_on_another_input_is_a_warning() -> None:
    """The run skips a step that the If's branch not taken reaches, whatever
    else it reads: a large layer connected straight to the heatmap is never
    used then either."""
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [
        dataset(),
        dataset("hospitals", OTHER),
        if_step(condition=condition),
        heatmap(),
    ]
    edges = [
        edge("data", "heat", "opportunity_layer_1_id"),
        edge("hospitals", "if"),
        branch("heat", "opportunity_layer_2_id"),
    ]
    counts = FakeCounts({LAYER: 934_847, OTHER: 10})

    issues = await check(nodes, edges, counts=counts)

    issue = only(issues, "too_many_destinations")
    assert issue.level == "warning"
    assert issue.params["features"] == 934_857


async def test_a_heatmap_both_branches_of_an_if_reach_keeps_the_error() -> None:
    """Either branch the If takes runs the heatmap."""
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [dataset(), if_step(condition=condition), heatmap()]
    edges = [
        edge("data", "if"),
        branch("heat", "opportunity_layer_1_id"),
        branch("heat", "opportunity_layer_2_id", taken=IF_FALSE_HANDLE),
    ]

    issues = await check(nodes, edges, counts=FakeCounts({LAYER: 934_847}))

    assert only(issues, "too_many_destinations").level == "error"


async def test_an_if_step_elsewhere_keeps_the_error() -> None:
    """An If that the heatmap is not behind cannot skip it."""
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [
        dataset(),
        if_step(condition=condition),
        tool("ring", "buffer", {"distances": [100]}),
        heatmap(),
    ]
    edges = [
        edge("data", "heat", "opportunity_layer_1_id"),
        edge("data", "if"),
        branch("ring", "input_layer_id"),
    ]

    issues = await check(nodes, edges, counts=FakeCounts({LAYER: 934_847}))

    assert only(issues, "too_many_destinations").level == "error"


async def test_a_filter_behind_an_if_step_leaves_the_limit_to_the_run() -> None:
    """An If step passes its input layer on with the dataset's filter
    (`workflow_runner.dataset_filter_for_source`), so the run reads the
    filtered rows, whose count is not known."""
    condition = {"op": "and", "expressions": [COUNT_ROW]}
    nodes = [dataset(filter=AREA_FILTER), if_step(condition=condition), heatmap()]
    edges = [edge("data", "if"), edge("if", "heat", "opportunity_layer_1_id")]

    issues = await check(nodes, edges, counts=FakeCounts({LAYER: 934_847}))

    assert "too_many_destinations" not in codes(issues)


async def test_a_tool_step_on_an_opportunity_input_adds_nothing() -> None:
    """A step's result has no recorded count, whatever its input has."""
    counts = FakeCounts({LAYER: 10, OTHER: 934_847})
    nodes = [
        dataset(),
        dataset("hospitals", OTHER),
        tool("ring", "buffer", {"distances": [100]}),
        heatmap(),
    ]
    edges = [
        edge("data", "heat", "opportunity_layer_1_id"),
        edge("hospitals", "ring", "input_layer_id"),
        edge("ring", "heat", "opportunity_layer_2_id"),
    ]

    issues = await check(nodes, edges, counts=counts)

    assert "too_many_destinations" not in codes(issues)
    assert counts.asked == [LAYER]


async def test_without_a_feature_count_lookup_nothing_is_looked_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from processes.services import workflow_checks

    async def never(*args: Any) -> Any:
        raise AssertionError("a feature count was looked up")

    monkeypatch.setattr(workflow_checks, "recorded_feature_count", never)
    monkeypatch.setattr(workflow_checks, "_get_pool", never)

    issues = await check_workflow(
        [dataset(), heatmap()],
        opportunities("data"),
        [],
        language="en",
        unreadable_layer_ids=frozenset(),
        layer_fields=FakeFields(),
    )

    assert issues == []


async def test_destinations_of_unknown_size_are_left_to_the_run() -> None:
    counts = FakeCounts()

    issues = await check([dataset(), heatmap()], opportunities("data"), counts=counts)

    assert issues == []
    assert counts.asked == [LAYER]


async def test_a_reference_area_leaves_the_limit_to_the_run() -> None:
    """Closest average on a street mode drops the destinations beyond the
    reach of its reference area before it applies the limit."""
    counts = FakeCounts({LAYER: 934_847})
    nodes = [dataset(), dataset("city", OTHER), heatmap()]
    edges = [*opportunities("data"), edge("city", "heat", "reference_area_layer_id")]

    issues = await check(nodes, edges, counts=counts)

    assert "too_many_destinations" not in codes(issues)


@pytest.mark.parametrize(
    ("process_id", "routing_mode"),
    [
        ("heatmap_gravity", "walking"),
        ("heatmap_2sfca", "walking"),
        ("heatmap_closest_average", "pt"),
    ],
)
async def test_a_reference_area_that_only_clips_the_result_counts_everything(
    process_id: str, routing_mode: str
) -> None:
    """Gravity, 2SFCA and closest average by public transport clip their
    result to the reference area, but route from every destination."""
    counts = FakeCounts({LAYER: 934_847})
    nodes = [
        dataset(),
        dataset("city", OTHER),
        heatmap(process_id, routing_mode=routing_mode),
    ]
    edges = [*opportunities("data"), edge("city", "heat", "reference_area_layer_id")]

    issues = await check(nodes, edges, counts=counts)

    assert "too_many_destinations" in codes(issues)


@pytest.mark.parametrize(
    ("process_id", "reported"),
    [("heatmap_closest_average", False), ("heatmap_gravity", True)],
)
async def test_a_reference_area_in_the_settings_counts_as_one(
    process_id: str, reported: bool
) -> None:
    counts = FakeCounts({LAYER: 934_847})
    nodes = [dataset(), heatmap(process_id, reference_area_layer_id=OTHER)]

    issues = await check(nodes, opportunities("data"), counts=counts)

    assert ("too_many_destinations" in codes(issues)) is reported


async def test_a_reference_area_with_an_unknown_mode_leaves_the_limit_to_the_run() -> (
    None
):
    """Without a routing mode the check cannot tell whether the run trims the
    destinations to the area's reach."""
    counts = FakeCounts({LAYER: 934_847})
    nodes = [dataset(), dataset("city", OTHER), tool("heat", "heatmap_closest_average")]
    edges = [*opportunities("data"), edge("city", "heat", "reference_area_layer_id")]

    issues = await check(nodes, edges, counts=counts)

    assert "too_many_destinations" not in codes(issues)


@pytest.mark.parametrize(
    "process_id", ["heatmap_gravity_legacy", "heatmap_closest_average_legacy"]
)
async def test_heatmaps_without_the_limit_never_count(process_id: str) -> None:
    counts = FakeCounts({LAYER: 934_847})

    issues = await check(
        [dataset(), heatmap(process_id)], opportunities("data"), counts=counts
    )

    assert "too_many_destinations" not in codes(issues)
    assert counts.asked == []


async def test_the_size_of_an_unreadable_layer_is_never_looked_up() -> None:
    counts = FakeCounts({LAYER: 934_847})

    issues = await check(
        [dataset(), heatmap()],
        opportunities("data"),
        unreadable=frozenset({LAYER}),
        counts=counts,
    )

    assert "too_many_destinations" not in codes(issues)
    assert counts.asked == []
