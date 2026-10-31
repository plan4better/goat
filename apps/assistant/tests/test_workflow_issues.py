"""The check's issues in the draft's terms, the assistant's own filter check,
and which issues may stay open when the workflow is created (spec §4.3, §4.4)."""

import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from assistant.workflows.draft import (
    MAX_STEPS,
    Draft,
    ProjectLayer,
    Region,
    ToolStep,
    open_steps,
    to_config,
)
from assistant.workflows.issues import (
    AREA_OUTSIDE_CODE,
    FILTER_FIELD_CODE,
    DraftIssue,
    area_issues,
    band_issues,
    counted_steps,
    draft_issues,
    filter_field_issues,
    matrix_pair_issues,
    note_issues,
    split_issues,
    starting_point_issues,
)

DRAFT = Draft.model_validate(
    {
        "name": "Toilets and shops",
        "steps": [
            {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
            {
                "id": "shops",
                "kind": "dataset",
                "layer": 34,
                "filter": {
                    "where": [
                        {"field": "kette", "op": "=", "value": "Edeka"},
                        {"field": "brand", "op": "=", "value": "x"},
                    ]
                },
            },
            {
                "id": "walk",
                "kind": "tool",
                "tool": "catchment_area_v2",
                "label": "Walk",
            },
            {"id": "ring", "kind": "tool", "tool": "buffer"},
            {"id": "save", "kind": "export", "name": "Result"},
        ],
        "connections": [
            {"from": "toilets", "to": "walk", "input": "starting_points"},
            {"from": "walk", "to": "save"},
            {"from": "shops", "to": "ring", "input": "input_layer_id"},
        ],
    }
)
CONVERTED = to_config(
    DRAFT,
    layers={
        34: ProjectLayer(
            34,
            "e2000000-0000-0000-0000-000000000034",
            "Supermärkte",
            "feature",
            "point",
        )
    },
    regions={},
    titles={"buffer": "Buffer"},
)
NODE = CONVERTED.node_ids
OPEN = open_steps(DRAFT)


def _raw(
    code: str, level: str, steps: list[str], message: str, field: str | None = None
) -> dict[str, Any]:
    return {
        "code": code,
        "level": level,
        "node_ids": [NODE.get(step, step) for step in steps],
        "field": field,
        "message": message,
        "params": {},
        "source": "check",
    }


def _issue(code: str, level: str, *steps: str, field: str | None = None) -> DraftIssue:
    return DraftIssue(
        code=code, level=level, steps=list(steps), field=field, message=code
    )


def test_node_ids_are_mapped_to_draft_ids() -> None:
    raw = _raw(
        "setting_required",
        "error",
        ["ring"],
        "Buffer: Distances is required.",
        "distances",
    )
    assert draft_issues([raw], CONVERTED) == [
        DraftIssue(
            code="setting_required",
            level="error",
            steps=["ring"],
            field="distances",
            message="Buffer: Distances is required.",
        )
    ]


def test_a_message_starts_with_the_step_name_once() -> None:
    [named, bare] = draft_issues(
        [
            _raw(
                "layer_not_chosen", "error", ["toilets"], "Toilets: no layer is chosen."
            ),
            _raw("setting_invalid", "error", ["walk"], "the travel time is too long."),
        ],
        CONVERTED,
    )
    assert named.message == "Toilets: no layer is chosen."
    assert bare.message == "Walk: the travel time is too long."


def test_an_issue_of_the_workflow_or_of_several_steps_keeps_its_message() -> None:
    whole, loop, unknown = draft_issues(
        [
            _raw(
                "connection_to_removed_step",
                "error",
                [],
                "A connection points to a step that does not exist.",
            ),
            _raw(
                "loop",
                "error",
                ["walk", "ring"],
                "These steps form a loop: Walk, Buffer.",
            ),
            _raw("tool_removed", "error", ["tool-gone"], "gone: the tool was removed."),
        ],
        CONVERTED,
    )
    assert (whole.steps, whole.message) == (
        [],
        "A connection points to a step that does not exist.",
    )
    assert (loop.steps, loop.message) == (
        ["walk", "ring"],
        "These steps form a loop: Walk, Buffer.",
    )
    assert (unknown.steps, unknown.message) == ([], "gone: the tool was removed.")


def test_filter_fields_the_layer_lacks_are_reported() -> None:
    issues = filter_field_issues(DRAFT, {"shops": ["name", "kette"]}, CONVERTED.labels)
    assert issues == [
        DraftIssue(
            code=FILTER_FIELD_CODE,
            level="error",
            steps=["shops"],
            field="brand",
            message="Supermärkte: the filter's field 'brand' is not in the layer. Its fields: name, kette.",
        )
    ]


def test_a_long_field_list_says_how_many_fields_it_leaves_out() -> None:
    fields = ["kette", *(f"f{index}" for index in range(34))]
    [issue] = filter_field_issues(DRAFT, {"shops": fields}, CONVERTED.labels)
    listed = ", ".join(fields[:30])
    assert issue.message == (
        "Supermärkte: the filter's field 'brand' is not in the layer. "
        f"Its fields: {listed} (and 5 more)."
    )


def test_a_layer_without_fields_says_so() -> None:
    issues = filter_field_issues(DRAFT, {"shops": []}, CONVERTED.labels)
    assert [issue.message for issue in issues] == [
        f"Supermärkte: the filter's field {field!r} is not in the layer. "
        "The layer has no fields that can be filtered."
        for field in ("kette", "brand")
    ]


def test_a_layer_whose_fields_cannot_be_read_yet_is_not_judged() -> None:
    """Review Focus 4: a catalog layer whose data is still being copied."""
    assert filter_field_issues(DRAFT, {"shops": None}, CONVERTED.labels) == []
    assert filter_field_issues(DRAFT, {}, CONVERTED.labels) == []


def test_layer_not_chosen_on_an_open_step_stays_open() -> None:
    issue = _issue("layer_not_chosen", "error", "toilets")
    assert split_issues([issue], OPEN) == ([], [issue])


def test_issues_the_unknown_layer_causes_downstream_stay_open() -> None:
    invalid = _issue("setting_invalid", "error", "walk")
    assert OPEN == {"toilets", "walk", "save"}
    assert split_issues([invalid], OPEN) == ([], [invalid])


def test_a_rejected_setting_stays_open_only_where_the_open_layer_reaches() -> None:
    """A setting the tool rejects stays open on a step reading from an open
    step only when the layer still to be chosen can be its cause: a layer
    input or setting that reads it (``layer_settings``), or the whole step's
    validation (no field). A choice no layer changes blocks."""
    settings = {"walk": frozenset({"starting_points", "reference_field"})}
    reach = _issue("setting_invalid", "error", "walk", field="reference_field")
    choice = _issue("setting_invalid", "error", "walk", field="routing_mode")
    whole = _issue("setting_invalid", "error", "walk")
    assert split_issues([reach, choice, whole], OPEN, layer_settings=settings) == (
        [choice],
        [reach, whole],
    )
    assert split_issues([reach, choice], OPEN) == ([reach, choice], [])


def test_the_gate_is_described_as_it_judges() -> None:
    """A rejection of the whole step (no field) stays open on a step reading
    from an open step whatever its cause, so no text says that every value no
    layer choice fixes blocks."""
    readme = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")
    for name, text in (
        ("split_issues", split_issues.__doc__ or ""),
        ("README", readme),
    ):
        flat = " ".join(text.split())
        assert "a value wrong for any layer" not in flat, name
        assert "a value no layer choice makes right" not in flat, name
        assert "whatever its cause" in flat, name


def test_too_many_destinations_blocks_also_beside_an_open_layer() -> None:
    """The heatmap's destination limit counts the layers already chosen, so
    no choice left open fixes it: the assistant limits them (filter.area) and
    checks again before it creates the workflow."""
    draft = Draft.model_validate(
        {
            "name": "Shops nearby",
            "steps": [
                {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
                {"id": "shops", "kind": "dataset", "layer": 34},
                {"id": "heat", "kind": "tool", "tool": "heatmap_closest_average"},
            ],
            "connections": [
                {"from": "shops", "to": "heat", "input": "opportunity_layer_1_id"},
                {"from": "toilets", "to": "heat", "input": "opportunity_layer_2_id"},
            ],
        }
    )
    opened = open_steps(draft)
    assert "heat" in opened
    limit = _issue("too_many_destinations", "error", "heat")
    reach = {"heat": frozenset({"opportunity_layer_2_id", "opportunities"})}
    assert split_issues([limit], opened, layer_settings=reach) == ([limit], [])


def test_a_filter_field_issue_blocks_wherever_it_is_reported() -> None:
    """A filter belongs to a dataset step with a layer, which the user has
    chosen already, so no choice left open can fix it."""
    issue = _issue(FILTER_FIELD_CODE, "error", "walk", field="kette")
    assert split_issues([issue], OPEN) == ([issue], [])


def test_a_field_not_in_layer_downstream_blocks() -> None:
    """Processes judges a field setting only against a layer it can read, so
    on a step reading from an open step the field is missing from another
    input's layer, which no layer choice changes."""
    field = _issue("field_not_in_layer", "error", "walk", field="weight_field")
    assert split_issues([field], OPEN) == ([field], [])


def test_a_field_missing_from_the_layered_input_of_a_join_blocks() -> None:
    """join reads its target from the open step and its join layer from a
    layered step; the join layer lacks the field."""
    draft = Draft.model_validate(
        {
            "name": "Join",
            "steps": [
                {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
                {"id": "shops", "kind": "dataset", "layer": 34},
                {"id": "join", "kind": "tool", "tool": "join"},
            ],
            "connections": [
                {"from": "toilets", "to": "join", "input": "target_layer_id"},
                {"from": "shops", "to": "join", "input": "join_layer_id"},
            ],
        }
    )
    field = _issue("field_not_in_layer", "error", "join", field="join_fields")
    assert open_steps(draft) == {"toilets", "join"}
    settings = {"join": frozenset({"join_fields"})}
    assert split_issues([field], open_steps(draft), field_settings=settings) == (
        [field],
        [],
    )


def test_a_required_field_setting_downstream_stays_open() -> None:
    issue = _issue("setting_required", "error", "walk", field="weight_field")
    settings = {"walk": frozenset({"weight_field"})}
    assert split_issues([issue], OPEN, field_settings=settings) == ([], [issue])


def test_a_required_other_setting_downstream_blocks() -> None:
    issue = _issue("setting_required", "error", "walk", field="travel_time")
    settings = {"walk": frozenset({"weight_field"})}
    assert split_issues([issue], OPEN, field_settings=settings) == ([issue], [])
    assert split_issues([issue], OPEN) == ([issue], [])


@pytest.mark.parametrize(
    ("code", "step"),
    [
        ("connection_to_unknown_input", "walk"),
        ("tool_removed", "walk"),
        ("tool_missing", "walk"),
        ("input_not_connected", "walk"),
        ("opportunity_not_connected", "walk"),
        ("variable_undefined", "walk"),
        ("export_name_missing", "save"),
        ("export_target_missing", "save"),
    ],
)
def test_an_issue_no_layer_choice_fixes_blocks_downstream(code: str, step: str) -> None:
    issue = _issue(code, "error", step)
    assert split_issues([issue], OPEN) == ([issue], [])


def test_a_loop_downstream_of_an_open_step_blocks() -> None:
    """toilets (open) -> walk -> ring -> walk: every step of the loop reads
    from the open step, and still no layer choice breaks the loop."""
    draft = Draft.model_validate(
        {
            "name": "Loop",
            "steps": [
                {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
                {"id": "walk", "kind": "tool", "tool": "catchment_area_v2"},
                {"id": "ring", "kind": "tool", "tool": "buffer"},
            ],
            "connections": [
                {"from": "toilets", "to": "walk", "input": "starting_points"},
                {"from": "walk", "to": "ring", "input": "input_layer_id"},
                {"from": "ring", "to": "walk", "input": "reference_layer_id"},
            ],
        }
    )
    loop = _issue("loop", "error", "walk", "ring")
    unknown_input = _issue("connection_to_unknown_input", "error", "walk")
    assert open_steps(draft) == {"toilets", "walk", "ring"}
    assert split_issues([loop, unknown_input], open_steps(draft)) == (
        [loop, unknown_input],
        [],
    )


def test_an_error_of_a_step_with_a_layer_blocks() -> None:
    issue = _issue("setting_required", "error", "ring")
    assert split_issues([issue], OPEN) == ([issue], [])


def test_a_filter_field_the_chosen_layer_lacks_blocks() -> None:
    issues = filter_field_issues(DRAFT, {"shops": ["name", "kette"]}, CONVERTED.labels)
    assert split_issues(issues, OPEN) == (issues, [])


def test_a_damaged_issue_always_blocks() -> None:
    issue = _issue("node_unknown_type", "damaged", "toilets")
    assert split_issues([issue], OPEN) == ([issue], [])


def test_warnings_neither_block_nor_stay_open() -> None:
    ring = _issue("step_not_connected", "warning", "ring")
    walk = _issue("step_not_connected", "warning", "walk")
    assert split_issues([ring, walk], OPEN) == ([], [])


def test_an_error_of_the_whole_workflow_blocks() -> None:
    issue = _issue("destination_not_writable", "error")
    assert split_issues([issue], OPEN) == ([issue], [])


def test_an_issue_naming_an_open_and_another_step_blocks() -> None:
    issue = _issue("loop", "error", "walk", "ring")
    assert split_issues([issue], OPEN) == ([issue], [])


def _catchments(budgets: list[int], **changes: Any) -> Draft:
    """Catchments from one dataset step, one per budget, each cut and counted."""
    steps: list[dict[str, Any]] = [{"id": "schools", "kind": "dataset", "layer": 31}]
    connections: list[dict[str, Any]] = []
    for budget in budgets:
        settings = {
            "routing_mode": "walking",
            "max_cost": budget,
            "steps": 1,
            **changes,
        }
        steps.append(
            {
                "id": f"walk{budget}",
                "kind": "tool",
                "tool": "catchment_area_v2",
                "settings": settings,
            }
        )
        connections.append(
            {"from": "schools", "to": f"walk{budget}", "input": "starting_points"}
        )
    return Draft.model_validate(
        {"name": "Bands", "steps": steps, "connections": connections}
    )


def test_catchments_split_by_budget_are_named_as_one_with_bands() -> None:
    [issue] = band_issues(_catchments([5, 10, 15]))
    assert (issue.code, issue.level) == ("catchment_bands_split", "warning")
    assert issue.steps == ["walk5", "walk10", "walk15"]
    assert "max_cost 15 and steps 3" in issue.message
    assert "step_sizes" not in issue.message
    [uneven] = band_issues(_catchments([5, 15, 30]))
    assert "max_cost 30, steps 3 and step_sizes [5, 15, 30]" in uneven.message


def test_catchments_that_differ_in_more_than_the_budget_are_left_alone() -> None:
    assert band_issues(_catchments([15])) == []
    draft = _catchments([10, 15])
    cycling = draft.steps[2].model_copy(
        update={"settings": {**draft.steps[2].settings, "routing_mode": "bicycle"}}
    )
    assert (
        band_issues(draft.model_copy(update={"steps": [*draft.steps[:2], cycling]}))
        == []
    )


def test_a_catchment_over_the_start_point_limit_is_an_error() -> None:
    draft = _catchments([5])
    [step] = [s for s in draft.steps if isinstance(s, ToolStep)]
    [issue] = starting_point_issues(draft, {"schools": 4918}, {})
    assert (issue.code, issue.level) == ("too_many_starting_points", "error")
    assert "4,918" in issue.message and "1,000" in issue.message
    assert issue.steps == [step.id, "schools"]
    # When every start point counts, the answer is a run in parts, combined.
    assert "run it in parts" in issue.message
    assert "merged and dissolved" in issue.message
    assert "cannot take them all" not in issue.message
    # Narrowing is the answer only when the question is about that part.
    assert "part of them already" in issue.message


def test_public_transport_has_its_own_limit() -> None:
    draft = _catchments([30])
    [step] = [s for s in draft.steps if isinstance(s, ToolStep)]
    step.settings["routing_mode"] = "pt"
    [issue] = starting_point_issues(draft, {"schools": 291}, {})
    assert "291" in issue.message and "100" in issue.message
    assert "public transport" in issue.message


def test_within_the_limit_or_uncounted_is_fine() -> None:
    draft = _catchments([5])
    assert starting_point_issues(draft, {"schools": 1000}, {}) == []
    assert starting_point_issues(draft, {}, {}) == []


def _chain(
    steps: list[dict[str, Any]], connections: list[tuple[str, str, str]]
) -> Draft:
    """A draft of these steps, each connection as (from, to, input)."""
    return Draft.model_validate(
        {
            "name": "Chain",
            "steps": steps,
            "connections": [
                {"from": source, "to": target, "input": name}
                for source, target, name in connections
            ],
        }
    )


def _dataset(step_id: str, layer: int = 31) -> dict[str, Any]:
    return {"id": step_id, "kind": "dataset", "layer": layer}


def _tool(step_id: str, tool: str, **settings: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": "tool", "tool": tool, "settings": settings}


#: Bus, rail and ferry stops merged in two steps into one catchment's start
#: points.
MERGED_STOPS = _chain(
    [
        _dataset("bus"),
        _dataset("rail"),
        _dataset("ferry"),
        _tool("land", "merge"),
        _tool("all", "merge"),
        _tool("walk", "catchment_area_v2", routing_mode="walking", max_cost=5),
    ],
    [
        ("bus", "land", "input_path_1"),
        ("rail", "land", "input_path_2"),
        ("land", "all", "input_path_1"),
        ("ferry", "all", "input_path_2"),
        ("all", "walk", "starting_points"),
    ],
)


def test_start_points_through_merges_are_the_sum_of_their_datasets() -> None:
    counts = {"bus": 1900, "rail": 300, "ferry": 113}
    [issue] = starting_point_issues(MERGED_STOPS, counts, {"walk": "Walk"})
    assert (issue.code, issue.level) == ("too_many_starting_points", "error")
    assert issue.steps == ["walk", "bus", "rail", "ferry"]
    assert issue.message.startswith("Walk starts from 2,313 points")
    assert "at most 1,000" in issue.message
    assert counted_steps(MERGED_STOPS) == ["bus", "rail", "ferry"]


def test_merged_start_points_within_the_limit_are_fine() -> None:
    counts = {"bus": 600, "rail": 300, "ferry": 100}
    assert starting_point_issues(MERGED_STOPS, counts, {}) == []


def test_a_merge_with_an_uncounted_dataset_is_not_counted() -> None:
    """A count that failed leaves its sum unknown, never reported low."""
    counts = {"bus": 1900, "rail": 300}
    assert starting_point_issues(MERGED_STOPS, counts, {}) == []


def test_a_centroid_has_one_start_point_per_feature() -> None:
    draft = _chain(
        [
            _dataset("districts", 33),
            _tool("middle", "centroid"),
            _tool("walk", "catchment_area_v2", routing_mode="walking"),
        ],
        [
            ("districts", "middle", "input_layer_id"),
            ("middle", "walk", "starting_points"),
        ],
    )
    [issue] = starting_point_issues(draft, {"districts": 1200}, {})
    assert issue.steps == ["walk", "districts"]
    assert "1,200 points" in issue.message


def test_a_chain_through_another_tool_is_not_counted() -> None:
    """A buffer's result has as many rows as its input, or one when it
    dissolves: only merge and centroid are followed."""
    draft = _chain(
        [
            _dataset("bus"),
            _dataset("rail"),
            _tool("ring", "buffer", distances=[100]),
            _tool("all", "merge"),
            _tool("walk", "catchment_area_v2", routing_mode="walking"),
        ],
        [
            ("bus", "ring", "input_layer_id"),
            ("ring", "all", "input_path_1"),
            ("rail", "all", "input_path_2"),
            ("all", "walk", "starting_points"),
        ],
    )
    assert starting_point_issues(draft, {"bus": 5000, "rail": 5000}, {}) == []
    assert counted_steps(draft) == []


def test_a_merge_with_one_input_left_unconnected_is_not_counted() -> None:
    draft = _chain(
        [
            _dataset("bus"),
            _tool("all", "merge"),
            _tool("walk", "catchment_area_v2", routing_mode="walking"),
        ],
        [("bus", "all", "input_path_1"), ("all", "walk", "starting_points")],
    )
    assert starting_point_issues(draft, {"bus": 5000}, {}) == []


def test_steps_that_read_from_each_other_are_not_counted() -> None:
    """A loop is processes' issue; the count only must not run forever."""
    draft = _chain(
        [
            _dataset("bus"),
            _tool("all", "merge"),
            _tool("middle", "centroid"),
            _tool("walk", "catchment_area_v2", routing_mode="walking"),
        ],
        [
            ("bus", "all", "input_path_1"),
            ("middle", "all", "input_path_2"),
            ("all", "middle", "input_layer_id"),
            ("all", "walk", "starting_points"),
        ],
    )
    assert starting_point_issues(draft, {"bus": 5000}, {}) == []


def test_a_chain_of_self_merges_is_counted_at_once() -> None:
    """Each merge reads the step before on both inputs, so the start points
    double at every step: as many steps as a draft takes are counted by
    multiplicity, not walked once per path."""
    merges = MAX_STEPS - 2
    steps = [_dataset("stops")]
    connections: list[tuple[str, str, str]] = []
    previous = "stops"
    for index in range(merges):
        steps.append(_tool(f"m{index}", "merge"))
        connections += [
            (previous, f"m{index}", "input_path_1"),
            (previous, f"m{index}", "input_path_2"),
        ]
        previous = f"m{index}"
    steps.append(_tool("walk", "catchment_area_v2", routing_mode="walking"))
    connections.append((previous, "walk", "starting_points"))
    draft = _chain(steps, connections)

    started = time.monotonic()
    [issue] = starting_point_issues(draft, {"stops": 1}, {"walk": "Walk"})
    assert counted_steps(draft) == ["stops"]
    assert time.monotonic() - started < 1

    assert issue.message.startswith(f"Walk starts from {2**merges:,} points")
    assert issue.steps == ["walk", "stops"]


#: Residential areas' centroids to the workplaces of two layers, merged.
MATRIX = _chain(
    [
        _dataset("homes", 33),
        _dataset("industry", 34),
        _dataset("offices", 34),
        _tool("middle", "centroid"),
        _tool("targets", "merge"),
        _tool("times", "travel_cost_matrix", routing_mode="pt"),
    ],
    [
        ("homes", "middle", "input_layer_id"),
        ("industry", "targets", "input_path_1"),
        ("offices", "targets", "input_path_2"),
        ("middle", "times", "origin_layer_id"),
        ("targets", "times", "destination_layer_id"),
    ],
)


def test_a_matrix_over_the_pair_cap_is_an_error() -> None:
    counts = {"homes": 559, "industry": 200, "offices": 113}
    [issue] = matrix_pair_issues(MATRIX, counts, {"times": "Travel times"})
    assert (issue.code, issue.level) == ("too_many_matrix_pairs", "error")
    assert issue.steps == ["times", "homes", "industry", "offices"]
    message = issue.message
    assert message.startswith("Travel times pairs 559 origins with 313 destinations")
    assert "174,967 pairs" in message and "at most 10,000" in message
    # The larger side first: areas to larger areas, or a filter; only the
    # kind of destination asked about.
    assert "Make the larger side smaller, here the origins" in message
    assert "larger areas first, one centroid each" in message
    assert "filter" in message
    # Every kind the question names stays in (SKILL.md).
    assert "only the kinds the question asks about" in message
    assert "the one kind" not in message
    # By public transport, area centroids go on the destination side.
    assert "area centroids belong on the destination side" in message
    assert "the reversed matrix" in message
    # A heatmap when every place matters.
    assert "heatmap" in message
    assert counted_steps(MATRIX) == ["homes", "industry", "offices"]


def test_a_reversed_matrix_names_its_destinations_as_the_larger_side() -> None:
    """From a few stops to many area centroids, the destinations are what
    to make fewer; the verdict itself does not depend on the direction."""
    counts = {"homes": 3, "industry": 4000, "offices": 1000}
    [issue] = matrix_pair_issues(MATRIX, counts, {"times": "Travel times"})
    assert "15,000 pairs" in issue.message
    assert "Make the larger side smaller, here the destinations" in issue.message


def test_a_matrix_within_the_pair_cap_is_fine() -> None:
    counts = {"homes": 50, "industry": 100, "offices": 100}
    assert matrix_pair_issues(MATRIX, counts, {}) == []


def test_a_matrix_with_one_side_unknown_is_not_reported() -> None:
    assert matrix_pair_issues(MATRIX, {"homes": 559, "industry": 200}, {}) == []
    assert matrix_pair_issues(MATRIX, {"industry": 9000, "offices": 9000}, {}) == []


def _with_notes(count: int) -> Draft:
    return Draft.model_validate(
        {
            "name": "Notes",
            "steps": [_dataset("schools")],
            "notes": [
                {"id": f"note{index}", "text": "What it answers."}
                for index in range(count)
            ],
        }
    )


def test_more_than_one_note_is_a_warning() -> None:
    [issue] = note_issues(_with_notes(3))
    assert (issue.code, issue.level, issue.steps) == (
        "more_than_one_note",
        "warning",
        [],
    )
    assert issue.message.startswith("The draft has 3 notes.")
    assert "one note per workflow unless the user asked for more" in issue.message


def test_one_note_or_none_is_fine() -> None:
    assert note_issues(_with_notes(1)) == []
    assert note_issues(_with_notes(0)) == []


#: A city's boundary layers, a country's census points, and NUTS regions: one
#: of the same name as a part of the city that lies mostly beyond it, the
#: city itself, its state, and the region beyond the city's border.
CITY = (8.41, 53.40, 10.33, 53.96)
COUNTRY = (5.87, 47.27, 15.04, 55.06)
AREA_LAYERS = {
    81: ProjectLayer(
        81,
        "e2000000-0000-0000-0000-000000000081",
        "City districts",
        "feature",
        "polygon",
        CITY,
    ),
    82: ProjectLayer(
        82,
        "e2000000-0000-0000-0000-000000000082",
        "City quarters",
        "feature",
        "polygon",
        CITY,
    ),
    83: ProjectLayer(
        83,
        "e2000000-0000-0000-0000-000000000083",
        "Census points",
        "feature",
        "point",
        COUNTRY,
    ),
}


def _region(
    nuts_id: str, name: str, west: float, south: float, east: float, north: float
) -> Region:
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    return Region(nuts_id, name, {"type": "Polygon", "coordinates": [ring]})


REGIONS = {
    region.nuts_id: region
    for region in (
        _region("DE933", "Harburg", 9.56, 53.13, 10.47, 53.50),
        _region("DE600", "Hamburg", 8.42, 53.40, 10.32, 53.96),
        _region("DE9", "Niedersachsen", 6.65, 51.29, 11.60, 53.89),
        _region("DE93", "Lüneburg", 8.61, 52.61, 11.60, 53.60),
    )
}


def _area_draft(*areas: str, residents_where: bool = False) -> Draft:
    """Residents counted per district of the city: the residents' dataset
    steps take ``areas`` (several on the same layer are merged first)."""
    residents = [
        {
            "id": f"residents{index}",
            "kind": "dataset",
            "label": f"Residents {index}",
            "layer": 83,
            "filter": {"area": area},
        }
        for index, area in enumerate(areas)
    ]
    merged = len(residents) > 1
    return Draft.model_validate(
        {
            "name": "Residents per district",
            "steps": [
                {
                    "id": "district",
                    "kind": "dataset",
                    "label": "District",
                    "layer": 81,
                    "filter": {"where": [{"field": "name", "op": "=", "value": "x"}]},
                },
                {"id": "quarters", "kind": "dataset", "layer": 82},
                *residents,
                *([{"id": "merge", "kind": "tool", "tool": "merge"}] if merged else []),
                {"id": "clip", "kind": "tool", "tool": "clip"},
                {"id": "count", "kind": "tool", "tool": "aggregate_points"},
                {"id": "save", "kind": "export", "name": "Residents per quarter"},
            ],
            "connections": [
                {"from": "quarters", "to": "clip", "input": "input_layer_id"},
                {"from": "district", "to": "clip", "input": "overlay_layer_id"},
                {"from": "clip", "to": "count", "input": "area_layer_id"},
                *(
                    [
                        *(
                            {"from": r["id"], "to": "merge", "input": f"input_path_{n}"}
                            for n, r in enumerate(residents, start=1)
                        ),
                        {"from": "merge", "to": "count", "input": "source_layer_id"},
                    ]
                    if merged
                    else [
                        {
                            "from": residents[0]["id"],
                            "to": "count",
                            "input": "source_layer_id",
                        }
                    ]
                ),
                {"from": "count", "to": "save"},
            ],
        }
    )


def _area_issues(
    draft: Draft, layers: dict[int, ProjectLayer] = AREA_LAYERS
) -> list[DraftIssue]:
    converted = to_config(draft, layers=layers, regions=REGIONS, titles={})
    return area_issues(draft, converted, layers, REGIONS)


def test_an_area_mostly_outside_the_layers_it_is_combined_with_is_a_warning() -> None:
    """Live pass 8 (Q32): a part of a city filtered the census points with a
    same-named NUTS district of another state, which barely overlaps the city.
    The check compares the region's box with the extents of the layers the
    step is combined with, and warns."""
    [issue] = _area_issues(_area_draft("DE933"))
    assert (issue.code, issue.level, issue.steps) == (
        AREA_OUTSIDE_CODE,
        "warning",
        ["residents0"],
    )
    message = issue.message
    assert message.startswith("Residents 0: the area of filter.area (Harburg, DE933)")
    assert "lies mostly outside the extent of the layers it is combined with" in message
    assert "(District, City quarters)" in message
    assert "check its parents (catalog_find_region) against the place" in message
    assert "in the city's own boundary layer" in message


@pytest.mark.parametrize(
    "areas",
    [("DE600",), ("DE9",), ("DE600", "DE93")],
    ids=["inside", "containing-it", "with-the-margin-beyond-the-border"],
)
def test_an_area_inside_or_around_the_layers_is_fine(areas: tuple[str, ...]) -> None:
    """A region inside the area, the region one level up around it, or the
    place and the region beyond its border merged (the skill's destinations)
    are no reason to warn."""
    assert _area_issues(_area_draft(*areas)) == []


def test_an_area_is_not_judged_without_every_extent_it_is_combined_with() -> None:
    unknown = {**AREA_LAYERS, 82: replace(AREA_LAYERS[82], extent=None)}
    assert _area_issues(_area_draft("DE933"), unknown) == []
    alone = Draft.model_validate(
        {
            "name": "Residents",
            "steps": [
                {
                    "id": "residents",
                    "kind": "dataset",
                    "layer": 83,
                    "filter": {"area": "DE933"},
                },
                {"id": "district", "kind": "dataset", "layer": 81},
                {"id": "save", "kind": "export", "name": "Residents"},
            ],
            "connections": [{"from": "residents", "to": "save"}],
        }
    )
    assert _area_issues(alone) == []


def test_an_area_beside_a_step_left_open_is_not_judged() -> None:
    draft = _area_draft("DE933").model_dump(by_alias=True)
    draft["steps"][1] = {
        "id": "quarters",
        "kind": "dataset",
        "label": "Quarters",
        "layer": None,
    }
    assert _area_issues(Draft.model_validate(draft)) == []
