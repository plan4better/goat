"""The assistant's edits of a stored workflow, without services
(``assistant.workflows.edits``): the model's step-level operations become
goatlib's low-level ones, built with the draft converter's node builders;
the workflow as the model reads it; what an edit changed; and the viewport
after a new step was placed."""

import copy
from typing import Any

import pytest
from goatlib.workflows.ops import OperationError, apply
from pydantic import TypeAdapter, ValidationError

from assistant.workflows.draft import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    NOTE_COLORS,
    NOTE_HEIGHT,
    NOTE_WIDTH,
    DatasetStep,
    ProjectLayer,
    Region,
    ToolStep,
    node_id,
    note_html,
    step_data,
)
from assistant.workflows.edits import (
    MAX_OPERATIONS,
    EditContext,
    EditError,
    Operation,
    StepView,
    VariableView,
    changed_steps,
    note_text,
    plan,
    refit,
    workflow_view,
)

LAYERS = {
    31: ProjectLayer(
        31, "e2000000-0000-0000-0000-000000000031", "Schulen", "feature", "point"
    ),
    33: ProjectLayer(
        33,
        "e2000000-0000-0000-0000-000000000033",
        "Einwohner Raster",
        "feature",
        "polygon",
    ),
    35: ProjectLayer(
        35, "e2000000-0000-0000-0000-000000000035", "Spielplätze", "feature", "point"
    ),
}
TITLES = {"aggregate_polygon": "Aggregate Polygons", "buffer": "Buffer"}
LAYER_INPUTS = {
    "catchment_area_v2": frozenset({"starting_points", "point_grid_layer_id"}),
    "aggregate_polygon": frozenset({"source_layer_id", "area_layer_id"}),
    "buffer": frozenset({"input_layer_id"}),
}
REGION = Region(
    "DE212",
    "Region 212",
    {
        "type": "Polygon",
        "coordinates": [[[11.3, 48.0], [11.7, 48.0], [11.7, 48.2], [11.3, 48.0]]],
    },
)
STORED: dict[str, Any] = {
    "nodes": [
        {
            "id": "text-n1",
            "type": "textAnnotation",
            "position": {"x": 0, "y": -240},
            "data": {
                "type": "textAnnotation",
                "text": "<p>Walk from the schools.</p><ul><li><p>Bands &amp; more</p></li></ul>",
                "backgroundColor": "#F2CE58",
                "width": 320,
                "height": 200,
            },
        },
        {
            "id": "dataset-a",
            "type": "dataset",
            "position": {"x": 0, "y": 0},
            "data": {
                "type": "dataset",
                "label": "Schulen",
                "projectLayerId": 31,
                "layerId": "e2000000-0000-0000-0000-000000000031",
                "layerName": "Schulen",
                "geometryType": "point",
                "layerType": "feature",
                "filterInitialized": True,
                "filter": {
                    "op": "and",
                    "expressions": [
                        {
                            "id": "x1",
                            "type": "logical",
                            "attribute": "art",
                            "expression": "is",
                            "value": "GS",
                        }
                    ],
                },
            },
        },
        {
            "id": "tool-walk",
            "type": "tool",
            "position": {"x": 360, "y": 0},
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "15 Minuten zu Fuß",
                "config": {
                    "routing_mode": "walking",
                    "max_cost": "{{@minutes}}",
                    "steps": 3,
                    "_layer_cache": "e2000000-0000-0000-0000-000000000031",
                },
                "status": "completed",
                "outputLayerId": "f0000000-0000-0000-0000-000000000001",
            },
        },
        {
            "id": "if-big",
            "type": "if",
            "position": {"x": 720, "y": 0},
            "data": {
                "type": "if",
                "label": "Large?",
                "mode": "simple",
                "condition": {
                    "op": "and",
                    "expressions": [
                        {
                            "id": "c1",
                            "kind": "statistic",
                            "method": "count",
                            "operator": ">",
                            "value": 100,
                        },
                        {
                            "id": "c2",
                            "type": "logical",
                            "attribute": "art",
                            "expression": "is",
                            "value": "GS",
                        },
                    ],
                },
            },
        },
        {
            "id": "export-save",
            "type": "export",
            "position": {"x": 1080, "y": 0},
            "data": {
                "type": "export",
                "label": "Save",
                "datasetName": "Einzugsgebiete",
                "addToProject": True,
                "overwritePrevious": False,
            },
        },
    ],
    "edges": [
        {
            "id": "e1",
            "source": "dataset-a",
            "target": "tool-walk",
            "targetHandle": "starting_points",
        },
        {
            "id": "e2",
            "source": "tool-walk",
            "sourceHandle": "output",
            "target": "if-big",
            "targetHandle": "input",
        },
        {
            "id": "e3",
            "source": "if-big",
            "sourceHandle": "true",
            "target": "export-save",
            "targetHandle": "input",
        },
    ],
    "viewport": {"x": 40, "y": 300, "zoom": 0.5},
    "variables": [
        {
            "id": "v1",
            "name": "minutes",
            "type": "number",
            "defaultValue": 15,
            "order": 0,
        },
        {
            "id": "v2",
            "name": "kind",
            "type": "string",
            "defaultValue": "GS",
            "order": 1,
        },
    ],
}

OPERATIONS: TypeAdapter[list[Operation]] = TypeAdapter(list[Operation])


def _ops(*raw: dict[str, Any]) -> list[Operation]:
    return OPERATIONS.validate_python(list(raw))


def _context(**changes: Any) -> EditContext:
    values: dict[str, Any] = {
        "layers": LAYERS,
        "locked": {36: "Intern"},
        "regions": {"DE212": REGION},
        "titles": TITLES,
        "layer_inputs": LAYER_INPUTS,
        "toolbox": frozenset(LAYER_INPUTS),
        "salt": "s",
    }
    values.update(changes)
    return EditContext(**values)


def _node(config: dict[str, Any], node: str) -> dict[str, Any]:
    return next(item for item in config["nodes"] if item["id"] == node)


# -- add_step ---------------------------------------------------------------------


def test_add_step_builds_the_node_as_the_draft_converter_does() -> None:
    raw = {
        "id": "count",
        "kind": "tool",
        "tool": "aggregate_polygon",
        "settings": {"area_type": "polygon"},
    }
    planned = plan(STORED, _ops({"op": "add_step", "step": raw}), _context())
    step = ToolStep.model_validate(raw)
    new_id = node_id(step, "s")
    assert planned.new_ids == {"count": new_id}
    # No position: goatlib places it next to what it is connected to.
    assert planned.operations == [
        {
            "op": "add_node",
            "node": {
                "id": new_id,
                "type": "tool",
                "data": step_data(
                    step, layers=LAYERS, regions={}, titles=TITLES, salt="s"
                ),
            },
        }
    ]
    assert planned.operations[0]["node"]["data"]["label"] == "Aggregate Polygons"


def test_a_new_step_is_named_by_its_own_id_in_the_same_call() -> None:
    planned = plan(
        STORED,
        _ops(
            {"op": "add_step", "step": {"id": "grid", "kind": "dataset", "layer": 33}},
            {
                "op": "add_step",
                "step": {"id": "count", "kind": "tool", "tool": "aggregate_polygon"},
            },
            {
                "op": "connect",
                "from": "tool-walk",
                "to": "count",
                "input": "area_layer_id",
            },
            {
                "op": "connect",
                "from": "grid",
                "to": "count",
                "input": "source_layer_id",
            },
        ),
        _context(),
    )
    grid, count = planned.new_ids["grid"], planned.new_ids["count"]
    assert planned.operations[2:] == [
        {
            "op": "connect",
            "source": "tool-walk",
            "target": count,
            "target_handle": "area_layer_id",
        },
        {
            "op": "connect",
            "source": grid,
            "target": count,
            "target_handle": "source_layer_id",
        },
    ]
    after = apply(STORED, planned.operations)
    assert _node(after, grid)["data"]["layerName"] == "Einwohner Raster"
    assert _node(after, grid)["data"]["projectLayerId"] == 33


def test_a_new_dataset_step_takes_its_filter_and_region() -> None:
    planned = plan(
        STORED,
        _ops(
            {
                "op": "add_step",
                "step": {
                    "id": "parks",
                    "kind": "dataset",
                    "layer": 35,
                    "filter": {
                        "area": "DE212",
                        "where": [{"field": "art", "op": "=", "value": "Bolzplatz"}],
                    },
                },
            }
        ),
        _context(),
    )
    data = planned.operations[0]["node"]["data"]
    assert [e["type"] for e in data["filter"]["expressions"]] == ["spatial", "logical"]


@pytest.mark.parametrize(
    ("step", "message"),
    [
        (
            {"id": "x", "kind": "dataset", "layer": 36},
            "'Intern' is in the project, but the user has no access to its data",
        ),
        (
            {"id": "x", "kind": "dataset", "layer": 99},
            "there is no layer 99 in the project",
        ),
        (
            {
                "id": "x",
                "kind": "tool",
                "tool": "buffer",
                "settings": {"input_layer_id": "e2000000-0000-0000-0000-000000000031"},
            },
            "the settings set the layer input(s) input_layer_id of buffer",
        ),
        (
            {"id": "x", "kind": "dataset", "layer": 31, "filter": {"area": "DE300"}},
            "no boundary for region 'DE300'",
        ),
        (
            {"id": "x", "kind": "tool", "tool": "join"},
            "'join' is not in the user's toolbox",
        ),
    ],
)
def test_add_step_refuses_what_workflow_create_refuses(
    step: dict[str, Any], message: str
) -> None:
    with pytest.raises(EditError, match="^operation 0 \\(add_step\\): ") as error:
        plan(STORED, _ops({"op": "add_step", "step": step}), _context())
    assert message in str(error.value)


def test_a_new_id_that_is_taken_is_refused() -> None:
    with pytest.raises(EditError, match="already names a step or note"):
        plan(
            STORED,
            _ops(
                {
                    "op": "add_step",
                    "step": {"id": "tool-walk", "kind": "export", "name": "Copy"},
                }
            ),
            _context(),
        )
    with pytest.raises(EditError, match="operation 1 \\(add_step\\): .*'save'"):
        plan(
            STORED,
            _ops(
                {
                    "op": "add_step",
                    "step": {"id": "save", "kind": "export", "name": "A"},
                },
                {
                    "op": "add_step",
                    "step": {"id": "save", "kind": "export", "name": "B"},
                },
            ),
            _context(),
        )


# -- the dataset of a step ------------------------------------------------------------


def test_set_layer_swaps_the_whole_layer_reference() -> None:
    planned = plan(
        STORED, _ops({"op": "set_layer", "id": "dataset-a", "layer": 35}), _context()
    )
    assert planned.operations == [
        {
            "op": "set_data",
            "node_id": "dataset-a",
            "data": {
                "label": "Spielplätze",
                "projectLayerId": 35,
                "layerId": "e2000000-0000-0000-0000-000000000035",
                "layerName": "Spielplätze",
                "filterInitialized": True,
                "geometryType": "point",
                "layerType": "feature",
            },
        }
    ]
    data = _node(apply(STORED, planned.operations), "dataset-a")["data"]
    # The old layer's filter goes with it.
    assert "filter" not in data and data["layerName"] == "Spielplätze"


def test_set_layer_keeps_a_given_label_and_writes_a_filter() -> None:
    planned = plan(
        STORED,
        _ops(
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 31,
                "label": "Grundschulen",
                "filter": {"where": [{"field": "art", "op": "=", "value": "GS"}]},
            }
        ),
        _context(),
    )
    data = planned.operations[0]["data"]
    assert data["label"] == "Grundschulen"
    assert data["filter"]["expressions"][0]["attribute"] == "art"


def test_a_step_left_open_gets_a_label_naming_what_is_missing() -> None:
    planned = plan(
        STORED,
        _ops({"op": "set_layer", "id": "dataset-a", "layer": None, "label": "Kitas"}),
        _context(),
    )
    assert planned.operations == [
        {
            "op": "set_data",
            "node_id": "dataset-a",
            "data": {"layerId": None, "filterInitialized": None, "label": "Kitas"},
        }
    ]
    # As the draft converter writes a step left open.
    data = _node(apply(STORED, planned.operations), "dataset-a")["data"]
    assert data == {"type": "dataset", "label": "Kitas"}
    with pytest.raises(ValidationError, match="a step left open needs a label"):
        _ops({"op": "set_layer", "id": "dataset-a", "layer": None})
    with pytest.raises(ValidationError, match="a step left open takes no filter"):
        _ops(
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": None,
                "label": "Kitas",
                "filter": {"area": "DE212"},
            }
        )


def test_set_layer_refuses_a_locked_layer_and_a_step_of_another_kind() -> None:
    with pytest.raises(EditError, match="no access to its data"):
        plan(
            STORED,
            _ops({"op": "set_layer", "id": "dataset-a", "layer": 36}),
            _context(),
        )
    with pytest.raises(
        EditError, match="'tool-walk' is a tool step; set_layer changes a dataset step"
    ):
        plan(
            STORED,
            _ops({"op": "set_layer", "id": "tool-walk", "layer": 31}),
            _context(),
        )


def test_set_export_changes_the_saved_name_and_flags() -> None:
    planned = plan(
        STORED,
        _ops(
            {
                "op": "set_export",
                "id": "export-save",
                "name": "Catchments",
                "overwrite_previous": True,
            }
        ),
        _context(),
    )
    assert planned.operations == [
        {
            "op": "set_data",
            "node_id": "export-save",
            "data": {"datasetName": "Catchments", "overwritePrevious": True},
        }
    ]
    with pytest.raises(ValidationError, match="set_export changes nothing"):
        _ops({"op": "set_export", "id": "export-save"})
    with pytest.raises(EditError, match="'dataset-a' is a dataset step"):
        plan(
            STORED,
            _ops({"op": "set_export", "id": "dataset-a", "name": "X"}),
            _context(),
        )


# -- settings, names, connections ------------------------------------------------------


def test_set_settings_merges_and_refuses_a_layer_input() -> None:
    planned = plan(
        STORED,
        _ops(
            {
                "op": "set_settings",
                "id": "tool-walk",
                "settings": {"max_cost": 10, "steps": None},
            }
        ),
        _context(),
    )
    assert planned.operations == [
        {
            "op": "set_settings",
            "node_id": "tool-walk",
            "settings": {"max_cost": 10, "steps": None},
        }
    ]
    with pytest.raises(EditError, match="starting_points of catchment_area_v2"):
        plan(
            STORED,
            _ops(
                {
                    "op": "set_settings",
                    "id": "tool-walk",
                    "settings": {
                        "starting_points": "e2000000-0000-0000-0000-000000000036"
                    },
                }
            ),
            _context(),
        )


def test_rename_maps_to_rename_node() -> None:
    planned = plan(
        STORED, _ops({"op": "rename", "id": "if-big", "label": "Groß?"}), _context()
    )
    assert planned.operations == [
        {"op": "rename_node", "node_id": "if-big", "label": "Groß?"}
    ]


def test_connect_takes_the_branch_of_an_if_step() -> None:
    planned = plan(
        STORED,
        _ops(
            {"op": "disconnect", "from": "if-big", "to": "export-save"},
            {"op": "connect", "from": "if-big", "to": "export-save", "branch": "false"},
        ),
        _context(),
    )
    assert planned.operations == [
        {"op": "disconnect", "source": "if-big", "target": "export-save"},
        {
            "op": "connect",
            "source": "if-big",
            "target": "export-save",
            "source_handle": "false",
        },
    ]
    after = apply(STORED, planned.operations)
    assert [
        e.get("sourceHandle") for e in after["edges"] if e["source"] == "if-big"
    ] == ["false"]


# -- notes ------------------------------------------------------------------------------


def test_add_note_writes_the_editors_html() -> None:
    planned = plan(
        STORED,
        _ops(
            {
                "op": "add_note",
                "id": "how",
                "text": "Bands <5 & 10>\n- one",
                "color": "blue",
            }
        ),
        _context(),
    )
    [operation] = planned.operations
    node = operation["node"]
    assert node["type"] == "textAnnotation" and node["id"].startswith("text-")
    assert "position" not in node
    assert node["data"] == {
        "type": "textAnnotation",
        "text": note_html("Bands <5 & 10>\n- one"),
        "backgroundColor": NOTE_COLORS["blue"],
        "width": NOTE_WIDTH,
        "height": NOTE_HEIGHT,
    }
    assert "&lt;5 &amp; 10&gt;" in node["data"]["text"]
    assert planned.new_ids == {"how": node["id"]}


def test_set_note_text_escapes_the_text_and_grows_the_note_to_fit() -> None:
    long_text = "\n".join(f"- line {n} with a few words in it" for n in range(12))
    planned = plan(
        STORED,
        _ops(
            {
                "op": "set_note_text",
                "id": "text-n1",
                "text": long_text,
                "color": "green",
            }
        ),
        _context(),
    )
    [operation] = planned.operations
    assert operation["text"] == note_html(long_text)
    assert operation["color"] == NOTE_COLORS["green"]
    assert operation["height"] > 200
    short = plan(
        STORED,
        _ops({"op": "set_note_text", "id": "text-n1", "text": "Short."}),
        _context(),
    )
    # A short text keeps the note's size, which the user may have chosen.
    assert short.operations == [
        {"op": "set_note_text", "node_id": "text-n1", "text": "<p>Short.</p>"}
    ]


def test_note_text_is_validated_like_a_draft_note() -> None:
    with pytest.raises(ValidationError, match="the text is empty"):
        _ops({"op": "add_note", "id": "n", "text": "   "})
    with pytest.raises(ValidationError, match="more than the 1,000 a note takes"):
        _ops({"op": "set_note_text", "id": "text-n1", "text": "x" * 1001})


def test_the_operations_are_capped() -> None:
    from assistant.workflows.edits import UpdateInput

    rename = {"op": "rename", "id": "if-big", "label": "x"}
    UpdateInput.model_validate(
        {
            "workflow_id": "0b6f0000-0000-0000-0000-00000000f10f",
            "operations": [rename] * MAX_OPERATIONS,
        }
    )
    with pytest.raises(ValidationError, match="at most 30"):
        UpdateInput.model_validate(
            {
                "workflow_id": "0b6f0000-0000-0000-0000-00000000f10f",
                "operations": [rename] * (MAX_OPERATIONS + 1),
            }
        )


# -- goatlib's refusals in the model's terms -------------------------------------------


def _refusal(operations: list[Operation]) -> str:
    planned = plan(STORED, operations, _context())
    with pytest.raises(OperationError) as error:
        apply(STORED, planned.operations)
    return planned.explain(error.value)


def test_a_refusal_names_the_models_operation_and_fields() -> None:
    message = _refusal(
        _ops(
            {"op": "rename", "id": "if-big", "label": "x"},
            {"op": "connect", "from": "if-big", "to": "export-save"},
        )
    )
    assert message.startswith("operation 1 (connect): ")
    assert "branch must be 'true' or 'false'" in message
    assert "source_handle" not in message


def test_a_refusal_names_a_new_step_by_its_own_id() -> None:
    message = _refusal(
        _ops(
            {"op": "add_step", "step": {"id": "grid", "kind": "dataset", "layer": 33}},
            {"op": "connect", "from": "tool-walk", "to": "grid"},
        )
    )
    assert message == (
        "operation 1 (connect): 'grid' is a dataset step: it reads from nothing."
    )


STORED_IDS = "text-n1, dataset-a, tool-walk, if-big, export-save"
#: The draft ids of a workflow this conversation created -> its node ids.
DRAFT_IDS = {"about": "text-n1", "schools": "dataset-a", "walk": "tool-walk"}


def test_an_unknown_id_lists_the_ids() -> None:
    """A step added earlier in the call is listed by the id the model gave it."""
    with pytest.raises(EditError) as refused:
        plan(
            STORED,
            _ops(
                {
                    "op": "add_step",
                    "step": {"id": "grid", "kind": "dataset", "layer": 33},
                },
                {"op": "rename", "id": "tool-gone", "label": "x"},
            ),
            _context(),
        )
    assert str(refused.value) == (
        "operation 1 (rename): there is no step or note with the id 'tool-gone'. "
        f"The ids are: {STORED_IDS}, grid."
    )


def test_a_step_is_named_by_its_drafts_id_or_its_node_id() -> None:
    """The node ids of a created workflow are derived with a salt of the
    create's own, so the model may name its steps and notes by their draft
    ids too."""
    planned = plan(
        STORED,
        _ops(
            {"op": "rename", "id": "walk", "label": "Walk"},
            {"op": "set_note_text", "id": "about", "text": "Walk."},
            {"op": "rename", "id": "dataset-a", "label": "Schools"},
            {"op": "connect", "from": "schools", "to": "walk", "input": "x"},
        ),
        _context(draft_ids=DRAFT_IDS),
    )
    assert [op.get("node_id") or op.get("source") for op in planned.operations] == [
        "tool-walk",
        "text-n1",
        "dataset-a",
        "dataset-a",
    ]
    assert planned.operations[3]["target"] == "tool-walk"
    # A draft id names a node that exists: nothing counts as added.
    assert planned.new_ids == {}


def test_an_unknown_id_lists_the_drafts_ids_too() -> None:
    with pytest.raises(EditError) as refused:
        plan(
            STORED,
            _ops({"op": "rename", "id": "start", "label": "x"}),
            _context(draft_ids=DRAFT_IDS),
        )
    assert str(refused.value) == (
        "operation 0 (rename): there is no step or note with the id 'start'. "
        f"The ids are: {STORED_IDS}. The ids of its draft name them too: "
        "about, schools, walk."
    )


def test_a_draft_id_of_a_removed_step_is_unknown() -> None:
    """The user may have removed the step in the editor, or an earlier
    operation of the call removed it."""
    context = _context(draft_ids={**DRAFT_IDS, "gone": "tool-gone"})
    with pytest.raises(EditError) as refused:
        plan(STORED, _ops({"op": "rename", "id": "gone", "label": "x"}), context)
    message = str(refused.value)
    assert "there is no step or note with the id 'gone'" in message
    assert message.endswith("name them too: about, schools, walk.")
    with pytest.raises(EditError) as removed:
        plan(
            STORED,
            _ops(
                {"op": "remove", "id": "walk"},
                {"op": "rename", "id": "walk", "label": "x"},
            ),
            context,
        )
    assert str(removed.value).startswith(
        "operation 1 (rename): there is no step or note with the id 'walk'"
    )
    assert str(removed.value).endswith("name them too: about, schools.")


def test_a_new_step_cannot_take_a_drafts_id() -> None:
    with pytest.raises(EditError, match="'walk' already names a step or note"):
        plan(
            STORED,
            _ops(
                {
                    "op": "add_step",
                    "step": {"id": "walk", "kind": "dataset", "layer": 33},
                }
            ),
            _context(draft_ids=DRAFT_IDS),
        )


# -- the workflow as the model reads it ------------------------------------------------


def test_the_view_lists_steps_inputs_notes_and_variables() -> None:
    view = workflow_view(STORED)
    assert [step.model_dump(exclude_none=True) for step in view.steps] == [
        {
            "id": "dataset-a",
            "kind": "dataset",
            "name": "Schulen",
            "layer": 31,
            "layer_name": "Schulen",
            "filter": {"where": [{"field": "art", "op": "=", "value": "GS"}]},
            "inputs": [],
        },
        {
            "id": "tool-walk",
            "kind": "tool",
            "name": "15 Minuten zu Fuß",
            "tool": "catchment_area_v2",
            # Variables as references, ids and run state left out.
            "settings": {
                "routing_mode": "walking",
                "max_cost": "{{@minutes}}",
                "steps": 3,
            },
            "inputs": [{"from": "dataset-a", "input": "starting_points"}],
        },
        {
            "id": "if-big",
            "kind": "if",
            "name": "Large?",
            "mode": "simple",
            "condition": [
                {"method": "count", "op": ">", "value": 100},
                {"field": "art", "op": "=", "value": "GS"},
            ],
            "inputs": [{"from": "tool-walk"}],
        },
        {
            "id": "export-save",
            "kind": "export",
            "name": "Save",
            "saved_as": "Einzugsgebiete",
            "add_to_project": True,
            "overwrite_previous": False,
            "inputs": [{"from": "if-big", "branch": "true"}],
        },
    ]
    assert [note.model_dump() for note in view.notes] == [
        {
            "id": "text-n1",
            "text": "Walk from the schools.\n\n- Bands & more",
            "color": "yellow",
        }
    ]
    assert [v.model_dump(exclude_none=True) for v in view.variables] == [
        {"name": "minutes", "type": "number", "default": 15},
        {"name": "kind", "type": "string", "default": "GS"},
    ]


def test_an_open_dataset_step_reads_as_open() -> None:
    config = apply(
        STORED,
        [
            {
                "op": "set_data",
                "node_id": "dataset-a",
                "data": {"layerId": None, "label": "Kitas"},
            }
        ],
    )
    [step, *_] = workflow_view(config).steps
    assert step.model_dump(exclude_none=True) == {
        "id": "dataset-a",
        "kind": "dataset",
        "name": "Kitas",
        "open": True,
        "inputs": [],
    }


def test_note_text_reads_the_editors_html() -> None:
    assert (
        note_text(note_html("One\ntwo\n\n- a\n- b <c>")) == "One\ntwo\n\n- a\n- b <c>"
    )
    assert note_text("<p>x<script>alert(1)</script></p>") == "xalert(1)"


# -- what an edit changed, and the view after it -----------------------------------------


def test_changed_steps_names_added_changed_and_removed_ones() -> None:
    planned = plan(
        STORED,
        _ops(
            {"op": "remove", "id": "text-n1"},
            {"op": "set_settings", "id": "tool-walk", "settings": {"max_cost": 10}},
            {"op": "add_step", "step": {"id": "buf", "kind": "tool", "tool": "buffer"}},
            {
                "op": "connect",
                "from": "dataset-a",
                "to": "buf",
                "input": "input_layer_id",
            },
            {"op": "disconnect", "from": "if-big", "to": "export-save"},
        ),
        _context(),
    )
    after = apply(STORED, planned.operations)
    found = [
        step.model_dump(exclude_none=True)
        for step in changed_steps(STORED, after, planned.new_ids)
    ]
    assert found == [
        {
            "id": "tool-walk",
            "kind": "tool",
            "name": "15 Minuten zu Fuß",
            "change": "changed",
        },
        {"id": "export-save", "kind": "export", "name": "Save", "change": "changed"},
        {
            "id": planned.new_ids["buf"],
            "kind": "tool",
            "name": "Buffer",
            "change": "added",
            "given_id": "buf",
        },
        {"id": "text-n1", "kind": "note", "name": "note", "change": "removed"},
    ]


def test_refit_shows_a_new_step_placed_outside_the_view() -> None:
    planned = plan(
        STORED,
        _ops(
            {"op": "add_step", "step": {"id": "buf", "kind": "tool", "tool": "buffer"}}
        ),
        _context(),
    )
    after = apply(STORED, planned.operations)
    placed = _node(after, planned.new_ids["buf"])["position"]
    viewport = STORED["viewport"]
    # The stored view shows x from -80 to 1520 at zoom 0.5: the new step lies right of it.
    assert placed["x"] * viewport["zoom"] + viewport["x"] > CANVAS_WIDTH - 400
    fitted = refit(after, set(planned.new_ids.values()))
    zoom = fitted["viewport"]["zoom"]
    for node in fitted["nodes"]:
        x = node["position"]["x"] * zoom + fitted["viewport"]["x"]
        y = node["position"]["y"] * zoom + fitted["viewport"]["y"]
        assert 0 <= x and x + 360 * zoom <= CANVAS_WIDTH
        assert 0 <= y and y + 160 * zoom <= CANVAS_HEIGHT + 1
    assert fitted["nodes"] == after["nodes"] and fitted["edges"] == after["edges"]


def test_refit_keeps_a_view_that_shows_the_new_step() -> None:
    config = copy.deepcopy(STORED)
    config["viewport"] = {"x": 100, "y": 100, "zoom": 0.1}
    planned = plan(
        config,
        _ops({"op": "add_note", "id": "n", "text": "Hello"}),
        _context(),
    )
    after = apply(config, planned.operations)
    assert refit(after, set(planned.new_ids.values())) == after
    # Nothing added: the view stays whatever it shows.
    assert refit(STORED, set()) == STORED


def test_plan_and_view_leave_the_stored_config_as_it_was() -> None:
    stored = copy.deepcopy(STORED)
    planned = plan(
        STORED,
        _ops(
            {"op": "set_layer", "id": "dataset-a", "layer": 33},
            {
                "op": "add_step",
                "step": DatasetStep(id="g", kind="dataset", layer=31).model_dump(),
            },
        ),
        _context(),
    )
    workflow_view(STORED)
    changed_steps(STORED, apply(STORED, planned.operations), planned.new_ids)
    assert STORED == stored


def test_the_view_shows_a_filter_in_the_drafts_terms() -> None:
    """A filter is replaced whole: the model sees what it would replace."""
    config = apply(
        STORED,
        plan(
            STORED,
            _ops(
                {
                    "op": "set_layer",
                    "id": "dataset-a",
                    "layer": 31,
                    "filter": {
                        "area": "DE212",
                        "where": [
                            {"field": "art", "op": "in", "value": ["GS", "MS"]},
                            {"field": "name", "op": "contains", "value": "Nord"},
                        ],
                    },
                }
            ),
            _context(),
        ).operations,
    )
    data = _node(config, "dataset-a")["data"]
    data["filter"]["expressions"].append(
        {"id": "x9", "type": "temporal", "attribute": "t", "expression": "after"}
    )
    [step, *_] = workflow_view(config).steps
    assert step.model_dump(exclude_none=True)["filter"] == {
        "area": "Region 212",
        "where": [
            {"field": "art", "op": "in", "value": ["GS", "MS"]},
            {"field": "name", "op": "contains", "value": "Nord"},
        ],
        "other": 1,
    }


def test_set_layer_on_the_same_layer_keeps_the_steps_name() -> None:
    config = apply(
        STORED,
        [{"op": "rename_node", "node_id": "dataset-a", "label": "Grundschulen"}],
    )
    same = plan(
        config,
        _ops({"op": "set_layer", "id": "dataset-a", "layer": 31}),
        _context(),
    )
    # The same layer: nothing given, nothing changes.
    assert same.operations[0]["data"] == {}
    assert _node(apply(config, same.operations), "dataset-a") == _node(
        config, "dataset-a"
    )
    other = plan(
        config,
        _ops({"op": "set_layer", "id": "dataset-a", "layer": 35}),
        _context(),
    )
    assert other.operations[0]["data"]["label"] == "Spielplätze"


# -- fix round 1 ------------------------------------------------------------------------


def _filtered_config() -> dict[str, Any]:
    """STORED with an area and a condition on the dataset step."""
    return apply(
        STORED,
        plan(
            STORED,
            _ops(
                {
                    "op": "set_layer",
                    "id": "dataset-a",
                    "layer": 31,
                    "filter": {
                        "area": "DE212",
                        "where": [{"field": "art", "op": "=", "value": "GS"}],
                    },
                }
            ),
            _context(),
        ).operations,
    )


def test_set_layer_on_the_same_layer_keeps_the_filter_it_leaves_out() -> None:
    config = _filtered_config()
    kept = _node(config, "dataset-a")["data"]["filter"]
    planned = plan(
        config,
        _ops({"op": "set_layer", "id": "dataset-a", "layer": 31, "label": "Altstadt"}),
        _context(),
    )
    assert planned.operations == [
        {"op": "set_data", "node_id": "dataset-a", "data": {"label": "Altstadt"}}
    ]
    data = _node(apply(config, planned.operations), "dataset-a")["data"]
    assert data["filter"] == kept and data["label"] == "Altstadt"
    assert data["layerName"] == "Schulen"


def test_set_layer_on_another_layer_drops_the_filter() -> None:
    config = _filtered_config()
    planned = plan(
        config, _ops({"op": "set_layer", "id": "dataset-a", "layer": 35}), _context()
    )
    assert "filter" not in _node(apply(config, planned.operations), "dataset-a")["data"]


def test_a_filter_is_removed_only_when_asked() -> None:
    config = _filtered_config()
    planned = plan(
        config,
        _ops(
            {"op": "set_layer", "id": "dataset-a", "layer": 31, "remove_filter": True}
        ),
        _context(),
    )
    assert planned.operations == [
        {
            "op": "set_data",
            "node_id": "dataset-a",
            "data": {"filter": None, "filterInitialized": True},
        }
    ]
    data = _node(apply(config, planned.operations), "dataset-a")["data"]
    assert "filter" not in data and data["projectLayerId"] == 31
    with pytest.raises(ValidationError, match="remove_filter takes no filter"):
        _ops(
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 31,
                "remove_filter": True,
                "filter": {"area": "DE212"},
            }
        )


def test_a_new_filter_on_the_same_layer_replaces_the_old_one() -> None:
    config = _filtered_config()
    planned = plan(
        config,
        _ops(
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 31,
                "filter": {"where": [{"field": "art", "op": "=", "value": "MS"}]},
            }
        ),
        _context(),
    )
    [operation] = planned.operations
    assert set(operation["data"]) == {"filter", "filterInitialized"}
    data = _node(apply(config, planned.operations), "dataset-a")["data"]
    assert [e["value"] for e in data["filter"]["expressions"]] == ["MS"]


def test_a_layer_outside_the_project_is_named_by_the_models_id() -> None:
    with pytest.raises(EditError) as error:
        plan(
            STORED,
            _ops({"op": "set_layer", "id": "dataset-a", "layer": 99}),
            _context(),
        )
    assert str(error.value).startswith(
        "operation 0 (set_layer): there is no layer 99 in the project"
    )
    assert "'op0'" not in str(error.value)


def test_the_view_clips_long_names_and_values() -> None:
    config = copy.deepcopy(STORED)
    data = _node(config, "dataset-a")["data"]
    data["label"] = "x" * 300
    data["filter"]["expressions"][0].update(
        expression="includes", value=[f"v{n}" * 50 for n in range(40)]
    )
    [step, *_] = workflow_view(config).steps
    assert len(step.name) <= 80
    assert step.filter is not None and step.filter.where is not None
    [condition] = step.filter.where
    assert len(condition["value"]) <= 20
    assert all(len(value) <= 80 for value in condition["value"])


def test_the_view_names_the_settings_it_shortens() -> None:
    config = copy.deepcopy(STORED)
    _node(config, "tool-walk")["data"]["config"].update(
        step_sizes=[5, 10, 15], start_time=28800, note_text="y" * 200
    )
    step = workflow_view(config).steps[1]
    assert step.shortened == ["step_sizes", "start_time", "note_text"]


def test_the_restricted_view_withholds_literal_values() -> None:
    view = workflow_view(STORED)
    steps = [step.restricted() for step in view.steps]
    dataset, _, condition, _ = (s.model_dump(exclude_none=True) for s in steps)
    assert dataset["filter"] == {
        "where": [{"field": "art", "op": "="}],
        "values_withheld": True,
    }
    assert condition["condition"] == [
        {"method": "count", "op": ">"},
        {"field": "art", "op": "="},
    ]
    assert condition["values_withheld"] is True
    variables = [v.restricted().model_dump(exclude_none=True) for v in view.variables]
    assert variables == [
        {"name": "minutes", "type": "number", "default": 15},
        {"name": "kind", "type": "string", "default_withheld": True},
    ]
    # The view itself keeps them, for Standard.
    assert view.steps[0].filter is not None
    assert view.steps[0].filter.where == [{"field": "art", "op": "=", "value": "GS"}]
    assert isinstance(view.steps[0], StepView)
    assert isinstance(view.variables[1], VariableView)


def test_a_custom_if_expression_is_withheld_under_restricted() -> None:
    config = copy.deepcopy(STORED)
    _node(config, "if-big")["data"].update(
        mode="custom", customExpression="name = 'Jane Doe'"
    )
    step = workflow_view(config).steps[2]
    assert step.expression == "name = 'Jane Doe'"
    hidden = step.restricted()
    assert hidden.expression is None and hidden.values_withheld is True


def test_the_notes_of_a_workflow_are_capped_as_a_drafts() -> None:
    notes = [{"op": "add_note", "id": f"n{n}", "text": "x"} for n in range(4)]
    plan(STORED, _ops(*notes), _context())
    with pytest.raises(EditError, match="more than 5 notes"):
        plan(
            STORED,
            _ops(*notes, {"op": "add_note", "id": "n9", "text": "x"}),
            _context(),
        )
    many = copy.deepcopy(STORED)
    many["nodes"] = [
        {**copy.deepcopy(STORED["nodes"][0]), "id": f"text-{n}"} for n in range(6)
    ] + STORED["nodes"][1:]
    # A workflow with more notes keeps them; the assistant adds none.
    plan(many, _ops({"op": "set_note_text", "id": "text-1", "text": "y"}), _context())
    with pytest.raises(EditError, match="more than 5 notes"):
        plan(many, _ops({"op": "add_note", "id": "n", "text": "x"}), _context())


def test_the_schema_says_how_steps_are_named_once() -> None:
    from assistant.tools.workflow_edits import UPDATE

    # As the model sees it: titles are stripped (``ToolSpec.json_schema``).
    schema = UPDATE.json_schema()
    refs = [
        prop
        for shape in schema["$defs"].values()
        for name, prop in shape.get("properties", {}).items()
        if name in ("id", "from", "to")
        and "op" in shape.get("properties", {})
        and shape["properties"]["op"].get("const") != "add_note"
    ]
    assert refs and all(prop == {"type": "string"} for prop in refs)
    assert "workflow_get" in schema["properties"]["operations"]["description"]
    assert "label" not in schema["$defs"]["SetExport"]["properties"]
    with pytest.raises(ValidationError, match="at most 200 characters"):
        _ops({"op": "remove", "id": "x" * 201})
    with pytest.raises(ValidationError, match="at least 1 character"):
        _ops({"op": "remove", "id": ""})
