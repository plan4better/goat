"""Operations on a stored workflow config: each one changes what it names and
writes what the editor writes; everything else stays byte for byte."""

import json
import signal
from collections.abc import Collection, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from goatlib.workflows.ops import OperationError, apply

pytestmark = pytest.mark.unit

FIXTURE = (
    Path(__file__).resolve().parents[6]
    / "apps/assistant/tests/fixtures/workflow_drafts.json"
)


def _stored() -> dict[str, Any]:
    """A config as the editor and the assistant store it: a note first (the
    editor draws notes first), steps with run state, a dataset step moved by
    hand (float position), keys the operations do not know, a variable and a
    top-level key of a later version."""
    return {
        "nodes": [
            {
                "id": "text-1",
                "type": "textAnnotation",
                "position": {"x": 720, "y": -340},
                "zIndex": -1000,
                "data": {
                    "type": "textAnnotation",
                    "text": "<p>Counts the residents near schools.</p>",
                    "backgroundColor": "#F2CE58",
                    "width": 320,
                    "height": 300,
                },
            },
            {
                "id": "dataset-1",
                "type": "dataset",
                "position": {"x": 0, "y": -100},
                "data": {
                    "type": "dataset",
                    "label": "Schools",
                    "projectLayerId": 31,
                    "layerId": "e2000000-0000-0000-0000-000000000031",
                    "layerName": "Schulen",
                    "filterInitialized": True,
                    "geometryType": "point",
                    "layerType": "feature",
                },
            },
            {
                "id": "dataset-2",
                "type": "dataset",
                "position": {"x": 0.5, "y": 100.25},
                "style": {"opacity": 0.5},
                "data": {
                    "type": "dataset",
                    "label": "Einwohner Raster",
                    "projectLayerId": 33,
                    "layerId": "e2000000-0000-0000-0000-000000000033",
                    "layerName": "Einwohner Raster",
                    "laterKey": {"kept": [1, 2]},
                },
            },
            {
                "id": "tool-1",
                "type": "tool",
                "position": {"x": 360, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "catchment_area_v2",
                    "label": "15 minutes on foot",
                    "config": {
                        "routing_mode": "walking",
                        "cost_type": "time",
                        "max_cost": 15,
                        "steps": 1,
                    },
                    "status": "completed",
                    "outputLayerId": "a1000000-0000-0000-0000-000000000001",
                },
            },
            {
                "id": "tool-2",
                "type": "tool",
                "position": {"x": 720, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "aggregate_polygon",
                    "label": "Aggregate Polygons",
                    "config": {
                        "area_type": "polygon",
                        "column_statistics": [
                            {"operation": "sum", "field": "einwohner"}
                        ],
                    },
                    "status": "idle",
                },
            },
            {
                "id": "if-1",
                "type": "if",
                "position": {"x": 1080, "y": 0},
                "data": {
                    "type": "if",
                    "label": "Enough residents",
                    "mode": "simple",
                    "customExpression": "",
                    "status": "idle",
                },
            },
            {
                "id": "export-1",
                "type": "export",
                "position": {"x": 1440, "y": 0},
                "data": {
                    "type": "export",
                    "label": "Residents within 15 minutes",
                    "datasetName": "Residents within 15 minutes",
                    "addToProject": True,
                    "overwritePrevious": False,
                },
            },
        ],
        "edges": [
            {
                "id": "edge-a",
                "source": "dataset-1",
                "target": "tool-1",
                "targetHandle": "starting_points",
            },
            {
                "id": "edge-b",
                "source": "tool-1",
                "sourceHandle": "output",
                "target": "tool-2",
                "targetHandle": "area_layer_id",
            },
            {
                "id": "edge-c",
                "source": "dataset-2",
                "target": "tool-2",
                "targetHandle": "source_layer_id",
            },
            {
                "id": "edge-d",
                "source": "tool-2",
                "sourceHandle": "output",
                "target": "if-1",
                "targetHandle": "input",
            },
            {
                "id": "edge-e",
                "source": "if-1",
                "sourceHandle": "true",
                "target": "export-1",
                "targetHandle": "input",
            },
        ],
        "viewport": {"x": 40.0, "y": 210.0, "zoom": 0.5},
        "variables": [
            {
                "id": "variable-1",
                "name": "minutes",
                "type": "number",
                "order": 0,
                "defaultValue": 15,
            }
        ],
        "laterTopLevel": {"kept": True},
    }


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _node(config: dict[str, Any], node_id: str) -> dict[str, Any]:
    found = [node for node in config["nodes"] if node["id"] == node_id]
    assert len(found) == 1, node_id
    node: dict[str, Any] = found[0]
    return node


def _ids(items: list[dict[str, Any]]) -> list[str]:
    return [item["id"] for item in items]


def _assert_untouched(
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    changed: Collection[str] = (),
    same_edges: bool = True,
) -> None:
    """Every node but `changed`, the viewport, the variables and the unknown
    top-level keys are the same JSON text; so are the edges, unless the
    operation changes them (`same_edges=False`, checked by the test)."""
    after_nodes = {node["id"]: node for node in after["nodes"]}
    for node in before["nodes"]:
        if node["id"] in changed:
            continue
        assert _dump(after_nodes[node["id"]]) == _dump(node), node["id"]
    for key in before:
        if key == "edges" and not same_edges:
            continue
        if key != "nodes":
            assert _dump(after[key]) == _dump(before[key]), key


# --- apply ------------------------------------------------------------------


def test_no_operations_return_an_equal_config() -> None:
    config = _stored()
    result = apply(config, [])
    assert _dump(result) == _dump(config)


def test_the_given_config_is_never_changed() -> None:
    config = _stored()
    before = _dump(config)
    apply(config, [{"op": "remove_node", "node_id": "tool-2"}])
    assert _dump(config) == before


def test_a_damaged_config_is_refused() -> None:
    damaged = {"nodes": [{"type": "tool", "data": {}}], "edges": []}
    with pytest.raises(OperationError) as raised:
        apply(damaged, [{"op": "remove_node", "node_id": "tool-1"}])
    message = str(raised.value)
    assert "damaged" in message
    assert "The step at index 0 has no id." in message
    assert raised.value.index is None


def test_an_unknown_operation_is_refused_with_the_known_ones() -> None:
    with pytest.raises(OperationError) as raised:
        apply(_stored(), [{"op": "explode", "node_id": "tool-1"}])
    message = str(raised.value)
    assert message.startswith("operation 0 (explode): ")
    assert "remove_node" in message and "connect" in message
    assert raised.value.index == 0
    assert raised.value.op == "explode"


def test_an_operation_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(OperationError, match=r"^operation 0: "):
        apply(_stored(), ["remove_node"])


def test_operations_must_be_a_list() -> None:
    with pytest.raises(OperationError, match="list"):
        apply(_stored(), {"op": "remove_node", "node_id": "tool-1"})


def test_an_unknown_field_of_an_operation_is_refused() -> None:
    with pytest.raises(OperationError) as raised:
        apply(_stored(), [{"op": "remove_node", "id": "tool-1"}])
    message = str(raised.value)
    assert "'id'" in message and "node_id" in message


def test_a_failing_operation_applies_none_of_the_others() -> None:
    config = _stored()
    before = _dump(config)
    with pytest.raises(OperationError) as raised:
        apply(
            config,
            [
                {"op": "remove_node", "node_id": "tool-2"},
                {"op": "remove_node", "node_id": "tool-9"},
            ],
        )
    assert raised.value.index == 1
    assert _dump(config) == before


# --- remove_node ------------------------------------------------------------


def test_remove_node_removes_the_step_and_its_connections() -> None:
    config = _stored()
    result = apply(config, [{"op": "remove_node", "node_id": "tool-2"}])
    assert "tool-2" not in _ids(result["nodes"])
    assert _ids(result["edges"]) == ["edge-a", "edge-e"]
    assert result["edges"] == [config["edges"][0], config["edges"][4]]
    _assert_untouched(config, result, changed={"tool-2"}, same_edges=False)
    assert _ids(result["nodes"]) == [
        node_id for node_id in _ids(config["nodes"]) if node_id != "tool-2"
    ]


def test_remove_node_removes_a_note() -> None:
    config = _stored()
    result = apply(config, [{"op": "remove_node", "node_id": "text-1"}])
    assert "text-1" not in _ids(result["nodes"])
    assert result["edges"] == config["edges"]
    _assert_untouched(config, result, changed={"text-1"})


def test_remove_node_of_an_unknown_id_names_it() -> None:
    with pytest.raises(OperationError) as raised:
        apply(_stored(), [{"op": "remove_node", "node_id": "tool-9"}])
    message = str(raised.value)
    assert message.startswith("operation 0 (remove_node): ")
    assert "'tool-9'" in message
    # The ids that do exist, so the model can pick the right one.
    assert "tool-2" in message and "export-1" in message


def test_remove_node_needs_the_id() -> None:
    with pytest.raises(OperationError, match="node_id"):
        apply(_stored(), [{"op": "remove_node"}])


def test_remove_node_on_the_assistant_built_config() -> None:
    if not FIXTURE.exists():
        pytest.skip("the assistant's fixture is not in this checkout")
    config = json.loads(FIXTURE.read_text())["cases"][0]["config"]
    aggregate = next(
        node["id"]
        for node in config["nodes"]
        if node["data"].get("processId") == "aggregate_polygon"
    )
    result = apply(config, [{"op": "remove_node", "node_id": aggregate}])
    assert all(
        aggregate not in (edge["source"], edge["target"]) for edge in result["edges"]
    )
    assert len(result["edges"]) == len(config["edges"]) - 3
    _assert_untouched(config, result, changed={aggregate}, same_edges=False)


# --- connect ----------------------------------------------------------------


def _new_edges(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    known = set(_ids(before["edges"]))
    return [edge for edge in after["edges"] if edge["id"] not in known]


def test_connect_from_a_tool_writes_the_editor_edge() -> None:
    config = _stored()
    config["edges"] = config["edges"][:3]  # tool-2 feeds nothing now
    result = apply(
        config,
        [{"op": "connect", "source": "tool-2", "target": "export-1"}],
    )
    (edge,) = _new_edges(config, result)
    # The keys and their order of `reactFlowToConfig`; no React Flow `type`.
    assert list(edge) == ["id", "source", "sourceHandle", "target", "targetHandle"]
    assert edge["id"].startswith("edge-")
    assert (edge["source"], edge["sourceHandle"]) == ("tool-2", "output")
    assert (edge["target"], edge["targetHandle"]) == ("export-1", "input")
    assert result["edges"][:3] == config["edges"]
    _assert_untouched(config, result, same_edges=False)


def test_connect_from_a_dataset_has_no_source_handle() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "connect",
                "source": "dataset-2",
                "target": "tool-1",
                "target_handle": "barriers",
            }
        ],
    )
    (edge,) = _new_edges(config, result)
    assert list(edge) == ["id", "source", "target", "targetHandle"]
    assert edge["targetHandle"] == "barriers"


def test_connect_ids_are_stable() -> None:
    operation = {
        "op": "connect",
        "source": "dataset-2",
        "target": "tool-1",
        "target_handle": "barriers",
    }
    first = apply(_stored(), [operation])
    second = apply(_stored(), [operation])
    assert first == second


def test_connect_from_an_if_takes_its_branch() -> None:
    config = _stored()
    config["nodes"].append(_buffer(position={"x": 1440, "y": 400}))
    result = apply(
        config,
        [
            {
                "op": "connect",
                "source": "if-1",
                "source_handle": "false",
                "target": "tool-new",
                "target_handle": "input_layer_id",
            }
        ],
    )
    (edge,) = _new_edges(config, result)
    assert edge["sourceHandle"] == "false"


@pytest.mark.parametrize("handle", [None, "output", "maybe"])
def test_connect_from_an_if_without_a_branch_is_refused(handle: str | None) -> None:
    operation: dict[str, Any] = {
        "op": "connect",
        "source": "if-1",
        "target": "tool-1",
        "target_handle": "barriers",
    }
    if handle is not None:
        operation["source_handle"] = handle
    with pytest.raises(OperationError, match="'true' or 'false'"):
        apply(_stored(), [operation])


def test_connect_into_a_tool_needs_its_input() -> None:
    with pytest.raises(OperationError, match="target_handle"):
        apply(_stored(), [{"op": "connect", "source": "dataset-2", "target": "tool-1"}])


@pytest.mark.parametrize(
    ("source", "target", "needle"),
    [
        ("export-1", "tool-1", "nothing reads from it"),
        ("text-1", "tool-1", "note"),
        ("tool-1", "dataset-2", "reads from nothing"),
        ("tool-1", "text-1", "note"),
        ("tool-1", "tool-1", "itself"),
    ],
)
def test_connect_refuses_ends_without_a_handle(
    source: str, target: str, needle: str
) -> None:
    operation = {
        "op": "connect",
        "source": source,
        "target": target,
        "target_handle": "input_layer_id",
    }
    with pytest.raises(OperationError, match=needle):
        apply(_stored(), [operation])


def test_connect_refuses_another_handle_into_an_if() -> None:
    operation = {
        "op": "connect",
        "source": "tool-1",
        "target": "if-1",
        "target_handle": "input_layer_id",
    }
    with pytest.raises(OperationError, match="'input'"):
        apply(_stored(), [operation])


def test_connect_refuses_a_source_handle_a_tool_does_not_have() -> None:
    operation = {
        "op": "connect",
        "source": "tool-1",
        "source_handle": "true",
        "target": "tool-2",
        "target_handle": "other_layer_id",
    }
    with pytest.raises(OperationError, match="'output'"):
        apply(_stored(), [operation])


def test_connect_into_an_input_already_fed_names_its_source() -> None:
    operation = {
        "op": "connect",
        "source": "dataset-1",
        "target": "tool-2",
        "target_handle": "source_layer_id",
    }
    with pytest.raises(OperationError) as raised:
        apply(_stored(), [operation])
    message = str(raised.value)
    assert "'dataset-2'" in message and "disconnect" in message


def test_connect_counts_an_edge_without_a_handle_as_the_default_input() -> None:
    config = _stored()
    del config["edges"][4]["targetHandle"]  # if-1 -> export-1, as older configs
    operation = {"op": "connect", "source": "tool-1", "target": "export-1"}
    with pytest.raises(OperationError, match="'if-1'"):
        apply(config, [operation])


def test_connect_names_an_unknown_step() -> None:
    operation = {
        "op": "connect",
        "source": "tool-1",
        "target": "tool-9",
        "target_handle": "input_layer_id",
    }
    with pytest.raises(OperationError, match="'tool-9'"):
        apply(_stored(), [operation])


# --- disconnect -------------------------------------------------------------


def test_disconnect_removes_the_connection() -> None:
    config = _stored()
    result = apply(
        config, [{"op": "disconnect", "source": "dataset-2", "target": "tool-2"}]
    )
    assert _ids(result["edges"]) == ["edge-a", "edge-b", "edge-d", "edge-e"]
    _assert_untouched(config, result, same_edges=False)


def test_disconnect_by_input_keeps_the_other_inputs() -> None:
    config = _stored()
    config["edges"].append(
        {
            "id": "edge-f",
            "source": "dataset-2",
            "target": "tool-1",
            "targetHandle": "barriers",
        }
    )
    config["edges"].append(
        {
            "id": "edge-g",
            "source": "dataset-2",
            "target": "tool-1",
            "targetHandle": "other",
        }
    )
    result = apply(
        config,
        [
            {
                "op": "disconnect",
                "source": "dataset-2",
                "target": "tool-1",
                "target_handle": "barriers",
            }
        ],
    )
    assert "edge-f" not in _ids(result["edges"])
    assert "edge-g" in _ids(result["edges"])


def test_disconnect_without_an_input_removes_every_connection_between_them() -> None:
    config = _stored()
    config["edges"].append(
        {
            "id": "edge-f",
            "source": "dataset-1",
            "target": "tool-1",
            "targetHandle": "barriers",
        }
    )
    result = apply(
        config, [{"op": "disconnect", "source": "dataset-1", "target": "tool-1"}]
    )
    assert "edge-a" not in _ids(result["edges"])
    assert "edge-f" not in _ids(result["edges"])


def test_disconnect_matches_an_edge_without_a_handle_by_the_default_input() -> None:
    config = _stored()
    del config["edges"][4]["targetHandle"]
    result = apply(
        config,
        [
            {
                "op": "disconnect",
                "source": "if-1",
                "target": "export-1",
                "target_handle": "input",
            }
        ],
    )
    assert "edge-e" not in _ids(result["edges"])


def test_disconnect_without_such_a_connection_says_what_feeds_the_step() -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [{"op": "disconnect", "source": "dataset-1", "target": "tool-2"}],
        )
    message = str(raised.value)
    assert "no connection" in message
    assert "'tool-1' into 'area_layer_id'" in message
    assert "'dataset-2' into 'source_layer_id'" in message


def test_disconnect_quotes_the_input_it_was_given() -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [
                {
                    "op": "disconnect",
                    "source": "dataset-1",
                    "target": "tool-2",
                    "target_handle": "area_layer_id",
                }
            ],
        )
    assert "from 'dataset-1' to 'tool-2' into 'area_layer_id'." in str(raised.value)


def test_disconnect_names_an_unknown_step() -> None:
    with pytest.raises(OperationError, match="'tool-9'"):
        apply(_stored(), [{"op": "disconnect", "source": "tool-9", "target": "tool-2"}])


# --- set_settings -----------------------------------------------------------


def test_set_settings_merges_into_the_tool_settings() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "set_settings",
                "node_id": "tool-1",
                "settings": {"max_cost": 20, "speed": 5, "steps": None},
            }
        ],
    )
    node = _node(result, "tool-1")
    # Changed in place, a new setting last, a null one gone.
    assert node["data"]["config"] == {
        "routing_mode": "walking",
        "cost_type": "time",
        "max_cost": 20,
        "speed": 5,
    }
    assert list(node["data"]["config"]) == [
        "routing_mode",
        "cost_type",
        "max_cost",
        "speed",
    ]
    # Everything else of the step as stored, run state included.
    before = _node(config, "tool-1")
    assert _dump({**node, "data": {**node["data"], "config": None}}) == _dump(
        {**before, "data": {**before["data"], "config": None}}
    )
    _assert_untouched(config, result, changed={"tool-1"})


def test_set_settings_replaces_a_list_setting_whole() -> None:
    statistics = [{"operation": "mean", "field": "einwohner"}]
    result = apply(
        _stored(),
        [
            {
                "op": "set_settings",
                "node_id": "tool-2",
                "settings": {"column_statistics": statistics},
            }
        ],
    )
    assert _node(result, "tool-2")["data"]["config"]["column_statistics"] == statistics


def test_set_settings_removing_a_missing_setting_changes_nothing() -> None:
    config = _stored()
    result = apply(
        config,
        [{"op": "set_settings", "node_id": "tool-1", "settings": {"nothing": None}}],
    )
    assert _dump(result) == _dump(config)


def test_set_settings_gives_a_tool_without_settings_its_first() -> None:
    config = _stored()
    del _node(config, "tool-2")["data"]["config"]
    result = apply(
        config,
        [{"op": "set_settings", "node_id": "tool-2", "settings": {"area_type": "h3"}}],
    )
    assert _node(result, "tool-2")["data"]["config"] == {"area_type": "h3"}


@pytest.mark.parametrize("node_id", ["dataset-1", "export-1", "if-1", "text-1"])
def test_set_settings_on_a_step_without_tool_settings_is_refused(node_id: str) -> None:
    with pytest.raises(OperationError, match="only a tool step"):
        apply(
            _stored(),
            [{"op": "set_settings", "node_id": node_id, "settings": {"a": 1}}],
        )


@pytest.mark.parametrize(
    ("node_id", "said"),
    [("text-1", "'text-1' is a note;"), ("if-1", "'if-1' is an If step;")],
)
def test_refusals_name_kinds_as_the_model_reads_them(node_id: str, said: str) -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [{"op": "set_settings", "node_id": node_id, "settings": {"a": 1}}],
        )
    assert said in str(raised.value)
    assert "textAnnotation" not in str(raised.value)


def test_set_settings_needs_an_object() -> None:
    with pytest.raises(OperationError, match="settings must be an object"):
        apply(
            _stored(),
            [{"op": "set_settings", "node_id": "tool-1", "settings": [1, 2]}],
        )


def test_set_settings_names_an_unknown_step() -> None:
    with pytest.raises(OperationError, match="'tool-9'"):
        apply(
            _stored(),
            [{"op": "set_settings", "node_id": "tool-9", "settings": {"a": 1}}],
        )


# --- rename_node ------------------------------------------------------------


@pytest.mark.parametrize("node_id", ["dataset-1", "tool-1", "if-1", "export-1"])
def test_rename_node_sets_the_label(node_id: str) -> None:
    config = _stored()
    result = apply(
        config,
        [{"op": "rename_node", "node_id": node_id, "label": "  Walk to school "}],
    )
    node = _node(result, node_id)
    assert node["data"]["label"] == "Walk to school"
    before = _node(config, node_id)
    assert list(node["data"]) == list(before["data"])
    assert {k: v for k, v in node["data"].items() if k != "label"} == {
        k: v for k, v in before["data"].items() if k != "label"
    }
    _assert_untouched(config, result, changed={node_id})


def test_rename_node_refuses_a_note() -> None:
    with pytest.raises(OperationError, match="set_note_text"):
        apply(
            _stored(),
            [{"op": "rename_node", "node_id": "text-1", "label": "About"}],
        )


def test_rename_node_refuses_an_empty_label() -> None:
    with pytest.raises(OperationError, match="label must be a non-empty string"):
        apply(_stored(), [{"op": "rename_node", "node_id": "tool-1", "label": "  "}])


def test_rename_node_names_an_unknown_step() -> None:
    with pytest.raises(OperationError, match="'tool-9'"):
        apply(_stored(), [{"op": "rename_node", "node_id": "tool-9", "label": "A"}])


# --- set_note_text ----------------------------------------------------------


def test_set_note_text_keeps_the_note_size_and_colour() -> None:
    config = _stored()
    html = "<p>Residents near schools.</p><ul><li><p>15 minutes</p></li></ul>"
    result = apply(config, [{"op": "set_note_text", "node_id": "text-1", "text": html}])
    note = _node(result, "text-1")
    assert note["data"]["text"] == html
    before = _node(config, "text-1")
    assert _dump({**note, "data": {**note["data"], "text": ""}}) == _dump(
        {**before, "data": {**before["data"], "text": ""}}
    )
    _assert_untouched(config, result, changed={"text-1"})


def test_set_note_text_takes_a_new_size_for_a_longer_text() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "set_note_text",
                "node_id": "text-1",
                "text": "<p>A longer text.</p>",
                "height": 360,
            }
        ],
    )
    data = _node(result, "text-1")["data"]
    assert (data["width"], data["height"]) == (320, 360)
    assert list(data) == list(_node(config, "text-1")["data"])


@pytest.mark.parametrize("size", [0, -20, "300", True, float("inf")])
def test_set_note_text_refuses_a_size_that_is_not_a_positive_number(size: Any) -> None:
    with pytest.raises(OperationError, match="width must be a positive number"):
        apply(
            _stored(),
            [
                {
                    "op": "set_note_text",
                    "node_id": "text-1",
                    "text": "<p>Hi</p>",
                    "width": size,
                }
            ],
        )


def test_set_note_text_refuses_a_step() -> None:
    with pytest.raises(OperationError, match="not a note"):
        apply(
            _stored(),
            [{"op": "set_note_text", "node_id": "tool-1", "text": "<p>Hi</p>"}],
        )


def test_set_note_text_refuses_an_empty_text() -> None:
    with pytest.raises(OperationError, match="text must be a non-empty string"):
        apply(_stored(), [{"op": "set_note_text", "node_id": "text-1", "text": ""}])


def test_set_note_text_names_an_unknown_note() -> None:
    with pytest.raises(OperationError, match="'text-9'"):
        apply(
            _stored(),
            [{"op": "set_note_text", "node_id": "text-9", "text": "<p>Hi</p>"}],
        )


# --- move_node --------------------------------------------------------------


def test_move_node_sets_the_position() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "move_node",
                "node_id": "dataset-2",
                "position": {"x": -40, "y": 300.5},
            }
        ],
    )
    node = _node(result, "dataset-2")
    assert node["position"] == {"x": -40, "y": 300.5}
    assert list(node) == list(_node(config, "dataset-2"))
    _assert_untouched(config, result, changed={"dataset-2"})


@pytest.mark.parametrize(
    "position",
    [
        {"x": 1},
        {"x": "1", "y": 2},
        {"x": True, "y": 2},
        [1, 2],
        {"x": float("nan"), "y": 0},
    ],
)
def test_move_node_refuses_a_position_that_is_not_two_numbers(position: Any) -> None:
    with pytest.raises(OperationError, match="position"):
        apply(
            _stored(),
            [{"op": "move_node", "node_id": "tool-1", "position": position}],
        )


def test_move_node_names_an_unknown_step() -> None:
    with pytest.raises(OperationError, match="'tool-9'"):
        apply(
            _stored(),
            [{"op": "move_node", "node_id": "tool-9", "position": {"x": 0, "y": 0}}],
        )


# --- add_node ---------------------------------------------------------------


def _buffer(node_id: str = "tool-new", **extra: Any) -> dict[str, Any]:
    """A tool node as the assistant's draft converter builds one."""
    return {
        "id": node_id,
        "type": "tool",
        **extra,
        "data": {
            "type": "tool",
            "processId": "buffer",
            "label": "Buffer",
            "config": {"distance": 500},
            "status": "idle",
        },
    }


def test_add_node_appends_the_node_as_given() -> None:
    config = _stored()
    node = _buffer(position={"x": 2000, "y": 40})
    result = apply(config, [{"op": "add_node", "node": node}])
    assert _ids(result["nodes"]) == [*_ids(config["nodes"]), "tool-new"]
    assert _dump(result["nodes"][-1]) == _dump(node)
    assert result["edges"] == config["edges"]
    _assert_untouched(config, result)


def test_add_node_keeps_no_reference_to_the_given_node() -> None:
    node = _buffer(position={"x": 2000, "y": 40})
    result = apply(_stored(), [{"op": "add_node", "node": node}])
    node["data"]["config"]["distance"] = 1
    assert _node(result, "tool-new")["data"]["config"] == {"distance": 500}


def test_add_node_puts_a_note_first_like_the_editor() -> None:
    note = {
        "id": "text-2",
        "type": "textAnnotation",
        "position": {"x": 0, "y": -400},
        "zIndex": -1000,
        "data": {
            "type": "textAnnotation",
            "text": "<p>Inputs</p>",
            "backgroundColor": "#5297DA",
            "width": 320,
            "height": 200,
        },
    }
    config = _stored()
    result = apply(config, [{"op": "add_node", "node": note}])
    assert _ids(result["nodes"]) == ["text-2", *_ids(config["nodes"])]
    _assert_untouched(config, result)


def test_add_node_without_a_position_is_placed_right_of_its_source() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {"op": "add_node", "node": _buffer()},
            {
                "op": "connect",
                "source": "tool-2",
                "target": "tool-new",
                "target_handle": "input_layer_id",
            },
        ],
    )
    node = _node(result, "tool-new")
    # One column right of tool-2 (720, 0), below if-1 already there.
    assert node["position"] == {"x": 1080, "y": 200}
    # Where the editor keeps it: after the type.
    assert list(node) == ["id", "type", "position", "data"]
    _assert_untouched(config, result, same_edges=False)


def test_add_node_without_a_position_is_placed_left_of_what_it_feeds() -> None:
    dataset = {
        "id": "dataset-new",
        "type": "dataset",
        "data": {"type": "dataset", "label": "Rivers"},
    }
    result = apply(
        _stored(),
        [
            {"op": "add_node", "node": dataset},
            {
                "op": "connect",
                "source": "dataset-new",
                "target": "tool-1",
                "target_handle": "barriers",
            },
        ],
    )
    # One column left of tool-1 (360, 0), below dataset-1 and dataset-2.
    assert _node(result, "dataset-new")["position"] == {"x": 0, "y": 400}


def test_add_node_places_a_chain_of_new_steps() -> None:
    export = {
        "id": "export-new",
        "type": "export",
        "data": {
            "type": "export",
            "label": "Buffered",
            "datasetName": "Buffered",
            "addToProject": True,
            "overwritePrevious": False,
        },
    }
    result = apply(
        _stored(),
        [
            {"op": "add_node", "node": export},
            {"op": "add_node", "node": _buffer()},
            {"op": "connect", "source": "tool-new", "target": "export-new"},
            {
                "op": "connect",
                "source": "tool-2",
                "target": "tool-new",
                "target_handle": "input_layer_id",
            },
        ],
    )
    assert _node(result, "tool-new")["position"] == {"x": 1080, "y": 200}
    assert _node(result, "export-new")["position"] == {"x": 1440, "y": 200}


def test_add_node_without_connections_goes_right_of_the_workflow() -> None:
    result = apply(_stored(), [{"op": "add_node", "node": _buffer()}])
    # export-1 ends at 1440 + 360; the top is the note's.
    assert _node(result, "tool-new")["position"] == {"x": 1840, "y": -340}


def test_add_node_into_an_empty_workflow_starts_at_the_origin() -> None:
    result = apply({"nodes": [], "edges": []}, [{"op": "add_node", "node": _buffer()}])
    assert result["nodes"][0]["position"] == {"x": 0, "y": 0}


def test_add_node_then_move_node_keeps_the_given_position() -> None:
    result = apply(
        _stored(),
        [
            {"op": "add_node", "node": _buffer()},
            {"op": "move_node", "node_id": "tool-new", "position": {"x": 5, "y": 6}},
        ],
    )
    assert _node(result, "tool-new")["position"] == {"x": 5, "y": 6}


def test_add_node_then_remove_node_leaves_nothing() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {"op": "add_node", "node": _buffer()},
            {"op": "remove_node", "node_id": "tool-new"},
        ],
    )
    assert _dump(result) == _dump(config)


def test_add_node_twice_after_a_remove_is_placed_once() -> None:
    result = apply(
        _stored(),
        [
            {"op": "add_node", "node": _buffer()},
            {"op": "remove_node", "node_id": "tool-new"},
            {"op": "add_node", "node": _buffer()},
        ],
    )
    assert _node(result, "tool-new")["position"] == {"x": 1840, "y": -340}


def test_add_node_refuses_an_id_in_use() -> None:
    with pytest.raises(OperationError, match="'tool-1' is already"):
        apply(_stored(), [{"op": "add_node", "node": _buffer("tool-1")}])


@pytest.mark.parametrize(
    ("node", "needle"),
    [
        ("tool", "node must be an object"),
        ({"type": "tool", "data": {"type": "tool"}}, "id must be a non-empty string"),
        (
            {"id": "n", "type": "chart", "data": {"type": "chart"}},
            "unknown type 'chart'",
        ),
        (
            {"id": "n", "type": "tool", "data": {"type": "export"}},
            "data.type must be 'tool'",
        ),
        ({"id": "n", "type": "tool", "data": []}, "data must be an object"),
        (
            {"id": "n", "type": "tool", "position": {"x": 1}, "data": {"type": "tool"}},
            "position must be",
        ),
    ],
)
def test_add_node_refuses_a_node_the_editor_cannot_draw(node: Any, needle: str) -> None:
    with pytest.raises(OperationError, match=needle) as raised:
        apply(_stored(), [{"op": "add_node", "node": node}])
    assert str(raised.value).startswith("operation 0 (add_node): ")


# --- bounds -----------------------------------------------------------------


@contextmanager
def _within(seconds: float) -> Iterator[None]:
    """Fails the block when it runs longer than `seconds` instead of hanging."""

    def stop(signum: int, frame: Any) -> None:
        raise TimeoutError(f"took longer than {seconds} s")

    previous = signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@pytest.mark.parametrize(
    "position",
    [
        {"x": 1_000_001, "y": 0},
        {"x": 0, "y": -1e7},
        {"x": 1e300, "y": 0},
        {"x": 10**400, "y": 0},
        {"x": 0, "y": -(10**400)},
    ],
)
def test_move_node_refuses_a_position_out_of_bounds(position: Any) -> None:
    with pytest.raises(OperationError, match="between -1000000 and 1000000"):
        apply(
            _stored(),
            [{"op": "move_node", "node_id": "tool-1", "position": position}],
        )


def test_move_node_takes_the_bounds_themselves() -> None:
    result = apply(
        _stored(),
        [
            {
                "op": "move_node",
                "node_id": "tool-1",
                "position": {"x": -1_000_000, "y": 1_000_000},
            }
        ],
    )
    assert _node(result, "tool-1")["position"] == {"x": -1_000_000, "y": 1_000_000}


def test_add_node_refuses_a_position_out_of_bounds() -> None:
    with pytest.raises(OperationError, match="between -1000000 and 1000000"):
        apply(
            _stored(),
            [{"op": "add_node", "node": _buffer(position={"x": 10**400, "y": 0})}],
        )


@pytest.mark.parametrize("size", [10_001, 1e300, 10**400])
def test_set_note_text_refuses_a_size_out_of_bounds(size: Any) -> None:
    with pytest.raises(
        OperationError, match="height must be a positive number up to 10000"
    ):
        apply(
            _stored(),
            [
                {
                    "op": "set_note_text",
                    "node_id": "text-1",
                    "text": "<p>Hi</p>",
                    "height": size,
                }
            ],
        )


@pytest.mark.parametrize("size", [0, 10**400, float("nan"), "300"])
def test_add_node_refuses_a_note_size_out_of_bounds(size: Any) -> None:
    note = {
        "id": "text-2",
        "type": "textAnnotation",
        "position": {"x": 0, "y": -400},
        "data": {"type": "textAnnotation", "text": "<p>Hi</p>", "width": size},
    }
    with pytest.raises(
        OperationError, match="width must be a positive number up to 10000"
    ):
        apply(_stored(), [{"op": "add_node", "node": note}])


def test_a_huge_note_set_by_operations_is_refused_quickly() -> None:
    """The review's probe: a note under the new step's spot made very tall."""
    with _within(2), pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [
                {
                    "op": "move_node",
                    "node_id": "text-1",
                    "position": {"x": 1080, "y": 150},
                },
                {
                    "op": "set_note_text",
                    "node_id": "text-1",
                    "text": "<p>Tall</p>",
                    "height": 1e300,
                },
                {"op": "add_node", "node": _buffer()},
                {
                    "op": "connect",
                    "source": "tool-2",
                    "target": "tool-new",
                    "target_handle": "input_layer_id",
                },
            ],
        )
    assert raised.value.index == 1


def test_a_huge_stored_note_counts_with_the_default_size_when_placing() -> None:
    """Core checks only a config's shape, so a stored note may hold any size."""
    config = _stored()
    note = _node(config, "text-1")
    note["position"] = {"x": 1080, "y": 150}
    note["data"]["height"] = 1e300
    with _within(2):
        result = apply(
            config,
            [
                {"op": "add_node", "node": _buffer()},
                {
                    "op": "connect",
                    "source": "tool-2",
                    "target": "tool-new",
                    "target_handle": "input_layer_id",
                },
            ],
        )
    # Below if-1 (to 160) and the note at its default height (150 to 350).
    assert _node(result, "tool-new")["position"] == {"x": 1080, "y": 400}


def test_a_stored_position_out_of_bounds_is_left_out_when_placing() -> None:
    config = _stored()
    _node(config, "export-1")["position"] = {"x": 10**400, "y": 0}
    with _within(2):
        result = apply(config, [{"op": "add_node", "node": _buffer()}])
    # Right of if-1, the rightmost node left; export-1 as stored.
    assert _node(result, "tool-new")["position"] == {"x": 1480, "y": -340}
    assert _node(result, "export-1")["position"] == {"x": 10**400, "y": 0}


def test_placement_goes_below_a_tall_column() -> None:
    config = _stored()
    # A thousand steps stacked under if-1's spot, each a row below the last.
    for row in range(1000):
        config["nodes"].append(
            {
                "id": f"stack-{row}",
                "type": "dataset",
                "position": {"x": 1080, "y": 200 * (row + 1)},
                "data": {"type": "dataset", "label": f"Stack {row}"},
            }
        )
    with _within(2):
        result = apply(
            config,
            [
                {"op": "add_node", "node": _buffer()},
                {
                    "op": "connect",
                    "source": "tool-2",
                    "target": "tool-new",
                    "target_handle": "input_layer_id",
                },
            ],
        )
    assert _node(result, "tool-new")["position"] == {"x": 1080, "y": 200_200}


# --- connect: both branches of one If ---------------------------------------


def _tool(node_id: str, x: int, y: int) -> dict[str, Any]:
    return _buffer(node_id, position={"x": x, "y": y})


def _edge(
    edge_id: str,
    source: str,
    target: str,
    handle: str = "input_layer_id",
    source_handle: str | None = None,
) -> dict[str, Any]:
    edge: dict[str, Any] = {"id": edge_id, "source": source}
    if source_handle is not None:
        edge["sourceHandle"] = source_handle
    edge.update({"target": target, "targetHandle": handle})
    return edge


def _branched() -> dict[str, Any]:
    """The stored config with if-1's branches spelled out: tool-t on true
    feeds export-1 and tool-c; tool-f on false, tool-f2 after it; tool-m
    after both; a second If, if-2, whose false branch is tool-g; and if-3,
    fed by tool-t."""
    config = _stored()
    config["edges"] = [edge for edge in config["edges"] if edge["id"] != "edge-e"]
    config["nodes"] += [
        _tool("tool-t", 1440, -200),
        _tool("tool-f", 1440, 200),
        _tool("tool-f2", 1800, 200),
        _tool("tool-c", 2160, 0),
        _tool("tool-m", 1800, 600),
        _tool("tool-g", 1440, 800),
        {
            "id": "if-2",
            "type": "if",
            "position": {"x": 1080, "y": 800},
            "data": {"type": "if", "label": "Other", "mode": "simple"},
        },
        {
            "id": "if-3",
            "type": "if",
            "position": {"x": 2160, "y": 400},
            "data": {"type": "if", "label": "Third", "mode": "simple"},
        },
    ]
    config["edges"] += [
        _edge("e-t", "if-1", "tool-t", source_handle="true"),
        _edge("e-f", "if-1", "tool-f", source_handle="false"),
        _edge("e-f2", "tool-f", "tool-f2", source_handle="output"),
        _edge("e-te", "tool-t", "export-1", "input", "output"),
        _edge("e-tc", "tool-t", "tool-c", source_handle="output"),
        _edge("e-tm", "tool-t", "tool-m", "a_layer_id", "output"),
        _edge("e-fm", "tool-f", "tool-m", "b_layer_id", "output"),
        _edge("e-2", "dataset-1", "if-2", "input"),
        _edge("e-g", "if-2", "tool-g", source_handle="false"),
        _edge("e-t3", "tool-t", "if-3", "input", "output"),
    ]
    return config


@pytest.mark.parametrize(
    ("source", "target", "handle"),
    [
        ("tool-f", "export-1", None),
        ("tool-f2", "export-1", None),
        ("tool-f", "tool-c", "input_layer_id"),
        ("tool-f2", "tool-c", "input_layer_id"),
    ],
)
def test_connect_lets_the_other_branch_of_an_if_feed_the_same_input(
    source: str, target: str, handle: str | None
) -> None:
    config = _branched()
    operation: dict[str, Any] = {"op": "connect", "source": source, "target": target}
    if handle is not None:
        operation["target_handle"] = handle
    result = apply(config, [operation])
    (edge,) = _new_edges(config, result)
    assert (edge["source"], edge["target"]) == (source, target)
    _assert_untouched(config, result, same_edges=False)


_OTHER_BRANCH_ONLY = "only the two branches of one If step may feed the same input"


def test_connect_refuses_both_handles_of_an_if_into_one_export() -> None:
    """A run reads an If's output on every connection from it, whichever
    branch it took: a direct connection is on no branch."""
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [
                {
                    "op": "connect",
                    "source": "if-1",
                    "source_handle": "false",
                    "target": "export-1",
                }
            ],
        )
    assert "already fed by 'if-1'" in str(raised.value)
    assert _OTHER_BRANCH_ONLY in str(raised.value)


def test_connect_refuses_a_branch_step_beside_a_direct_if_connection_into_an_export() -> (
    None
):
    """The re-review's export probe: if-1 (true) feeds export-1 directly;
    tool-f on the false branch would join it."""
    config = _stored()
    config["nodes"].append(_tool("tool-f", 1440, 200))
    config["edges"].append(_edge("e-f", "if-1", "tool-f", source_handle="false"))
    with pytest.raises(OperationError) as raised:
        apply(config, [{"op": "connect", "source": "tool-f", "target": "export-1"}])
    assert "already fed by 'if-1'" in str(raised.value)
    assert _OTHER_BRANCH_ONLY in str(raised.value)


def test_connect_refuses_a_direct_if_connection_beside_a_branch_step_into_a_tool() -> (
    None
):
    """The re-review's tool input probe: tool-f on the false branch feeds
    tool-c; if-1 (true) would feed the same input directly."""
    config = _branched()
    config["edges"] = [
        _edge("e-fc", "tool-f", "tool-c", source_handle="output")
        if edge["id"] == "e-tc"
        else edge
        for edge in config["edges"]
    ]
    with pytest.raises(OperationError) as raised:
        apply(
            config,
            [
                {
                    "op": "connect",
                    "source": "if-1",
                    "source_handle": "true",
                    "target": "tool-c",
                    "target_handle": "input_layer_id",
                }
            ],
        )
    assert "already fed by 'tool-f'" in str(raised.value)
    assert _OTHER_BRANCH_ONLY in str(raised.value)


@pytest.mark.parametrize(
    ("source", "feeder"),
    [
        ("tool-g", "tool-t"),  # the branch of another If
        ("dataset-2", "tool-t"),  # a step that always runs
        ("tool-m", "tool-t"),  # a step both branches reach
        ("tool-c", "tool-t"),  # the same branch
    ],
)
def test_connect_refuses_a_second_feeder_not_on_the_other_branch(
    source: str, feeder: str
) -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _branched(),
            [{"op": "connect", "source": source, "target": "export-1"}],
        )
    message = str(raised.value)
    assert f"already fed by '{feeder}'" in message
    assert "only the two branches of one If step may feed the same input" in message


def test_connect_refuses_a_third_feeder_on_another_if() -> None:
    with pytest.raises(OperationError, match="already fed by 'tool-t'") as raised:
        apply(
            _branched(),
            [
                {"op": "connect", "source": "tool-f", "target": "export-1"},
                {"op": "connect", "source": "tool-g", "target": "export-1"},
            ],
        )
    assert raised.value.index == 1


def test_connect_refuses_a_second_input_into_an_if_even_from_the_other_branch() -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _branched(),
            [{"op": "connect", "source": "tool-f", "target": "if-3"}],
        )
    assert "takes exactly one input" in str(raised.value)


# --- connect: loops ---------------------------------------------------------


def test_connect_refuses_a_connection_that_closes_a_loop() -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [
                {
                    "op": "connect",
                    "source": "tool-2",
                    "target": "tool-1",
                    "target_handle": "barriers",
                }
            ],
        )
    assert (
        "connecting 'tool-2' to 'tool-1' would make a loop: 'tool-1' -> 'tool-2'."
        in str(raised.value)
    )


def test_connect_names_the_whole_path_of_a_loop() -> None:
    with pytest.raises(OperationError) as raised:
        apply(
            _stored(),
            [
                {
                    "op": "connect",
                    "source": "if-1",
                    "source_handle": "false",
                    "target": "tool-1",
                    "target_handle": "barriers",
                }
            ],
        )
    assert "'tool-1' -> 'tool-2' -> 'if-1'." in str(raised.value)


def test_connect_works_beside_a_loop_already_stored() -> None:
    config = _stored()
    config["nodes"] += [_tool("tool-x", 0, 600), _tool("tool-y", 360, 600)]
    config["edges"] += [
        _edge("e-xy", "tool-x", "tool-y", source_handle="output"),
        _edge("e-yx", "tool-y", "tool-x", source_handle="output"),
    ]
    result = apply(
        config,
        [
            {
                "op": "connect",
                "source": "dataset-2",
                "target": "tool-1",
                "target_handle": "barriers",
            }
        ],
    )
    assert len(result["edges"]) == len(config["edges"]) + 1


# --- set_data ---------------------------------------------------------------


def _set_data(node_id: str, data: Any) -> dict[str, Any]:
    return {"op": "set_data", "node_id": node_id, "data": data}


def test_set_data_merges_into_an_export_step() -> None:
    config = _stored()
    result = apply(
        config,
        [
            _set_data(
                "export-1",
                {
                    "datasetName": "Residents, 20 minutes",
                    "overwritePrevious": True,
                    "destination": "new",
                    "outputStyle": {"color": [1, 2, 3]},
                },
            )
        ],
    )
    data = _node(result, "export-1")["data"]
    assert data == {
        "type": "export",
        "label": "Residents within 15 minutes",
        "datasetName": "Residents, 20 minutes",
        "addToProject": True,
        "overwritePrevious": True,
        "destination": "new",
        "outputStyle": {"color": [1, 2, 3]},
    }
    # Stored keys keep their place; new ones come last.
    assert list(data)[:5] == list(_node(config, "export-1")["data"])
    _assert_untouched(config, result, changed={"export-1"})


def test_set_data_merges_into_an_if_step() -> None:
    config = _stored()
    condition = {"op": "and", "expressions": [{"id": "c1", "kind": "statistic"}]}
    result = apply(
        config,
        [
            _set_data(
                "if-1",
                {
                    "mode": "custom",
                    "customExpression": "count > 5",
                    "condition": condition,
                },
            )
        ],
    )
    data = _node(result, "if-1")["data"]
    assert (data["mode"], data["customExpression"]) == ("custom", "count > 5")
    assert data["condition"] == condition
    assert data["status"] == "idle"
    _assert_untouched(config, result, changed={"if-1"})


def test_set_data_null_removes_a_key() -> None:
    config = _stored()
    _node(config, "export-1")["data"]["targetLayerName"] = "Old"
    result = apply(config, [_set_data("export-1", {"targetLayerName": None})])
    assert "targetLayerName" not in _node(result, "export-1")["data"]


def test_set_data_changes_a_dataset_filter_on_the_same_layer() -> None:
    config = _stored()
    layer_filter = {"op": "and", "expressions": [{"id": "x", "type": "logical"}]}
    result = apply(config, [_set_data("dataset-1", {"filter": layer_filter})])
    data = _node(result, "dataset-1")["data"]
    assert data["filter"] == layer_filter
    assert data["projectLayerId"] == 31
    _assert_untouched(config, result, changed={"dataset-1"})


def test_set_data_swaps_a_dataset_layer_as_one_group() -> None:
    config = _stored()
    _node(config, "dataset-1")["data"]["filter"] = {"op": "and", "expressions": []}
    _node(config, "dataset-1")["data"]["unresolved"] = True
    result = apply(
        config,
        [
            _set_data(
                "dataset-1",
                {
                    "layerId": "e2000000-0000-0000-0000-000000000099",
                    "layerName": "Kitas",
                    "geometryType": "polygon",
                },
            )
        ],
    )
    data = _node(result, "dataset-1")["data"]
    # The stale project layer, layer type and filter go with the old layer;
    # the label follows the new layer's name, as the editor's picker sets it.
    assert data == {
        "type": "dataset",
        "label": "Kitas",
        "layerId": "e2000000-0000-0000-0000-000000000099",
        "layerName": "Kitas",
        "filterInitialized": True,
        "geometryType": "polygon",
        "unresolved": False,
    }


def test_set_data_swap_keeps_a_label_and_project_layer_given_with_it() -> None:
    result = apply(
        _stored(),
        [
            _set_data(
                "dataset-1",
                {
                    "layerId": "e2000000-0000-0000-0000-000000000034",
                    "projectLayerId": 34,
                    "layerName": "Supermärkte",
                    "label": "Shops",
                    "layerType": "feature",
                },
            )
        ],
    )
    data = _node(result, "dataset-1")["data"]
    assert (data["label"], data["projectLayerId"], data["layerType"]) == (
        "Shops",
        34,
        "feature",
    )


def test_set_data_layer_null_leaves_the_step_open() -> None:
    result = apply(_stored(), [_set_data("dataset-1", {"layerId": None})])
    assert _node(result, "dataset-1")["data"] == {
        "type": "dataset",
        "label": "Schools",
        "filterInitialized": True,
    }


@pytest.mark.parametrize(
    ("node_id", "key"),
    [
        ("export-1", "exportedLayerId"),
        ("export-1", "status"),
        ("if-1", "activeHandle"),
        ("if-1", "error"),
        ("dataset-1", "jobId"),
        ("dataset-1", "outputLayerId"),
    ],
)
def test_set_data_refuses_run_state(node_id: str, key: str) -> None:
    with pytest.raises(OperationError, match=f"{key} is written by a run"):
        apply(_stored(), [_set_data(node_id, {key: "x"})])


@pytest.mark.parametrize(
    ("key", "needle"),
    [
        ("type", "type cannot change"),
        ("config", "use set_settings"),
        ("processId", "only a tool step has a processId"),
    ],
)
def test_set_data_refuses_the_keys_of_the_kind(key: str, needle: str) -> None:
    with pytest.raises(OperationError, match=needle):
        apply(_stored(), [_set_data("export-1", {key: "tool"})])


def test_set_data_refuses_an_unknown_key_naming_the_kind_keys() -> None:
    with pytest.raises(OperationError) as raised:
        apply(_stored(), [_set_data("export-1", {"dataset_name": "x"})])
    message = str(raised.value)
    assert "'dataset_name'" in message
    assert "datasetName" in message and "overwritePrevious" in message
    assert "customExpression" not in message


@pytest.mark.parametrize(
    ("node_id", "needle"),
    [("tool-1", "use set_settings"), ("text-1", "use set_note_text")],
)
def test_set_data_points_tools_and_notes_to_their_operations(
    node_id: str, needle: str
) -> None:
    with pytest.raises(OperationError, match=needle):
        apply(_stored(), [_set_data(node_id, {"label": "A"})])


@pytest.mark.parametrize(
    ("node_id", "data", "needle"),
    [
        ("export-1", {"addToProject": "yes"}, "addToProject must be true or false"),
        (
            "export-1",
            {"destination": "maybe"},
            "destination must be one of: new, existing",
        ),
        ("if-1", {"mode": "fancy"}, "mode must be one of: simple, custom"),
        (
            "dataset-1",
            {"layerId": "l", "layerType": "vector"},
            "layerType must be one of",
        ),
        ("dataset-1", {"filter": "category = 1"}, "filter must be an object"),
        ("if-1", {"condition": []}, "condition must be an object"),
        ("export-1", {"label": "  "}, "label must be a non-empty string"),
        ("export-1", {"label": None}, "label cannot be removed"),
        ("export-1", {"datasetName": ""}, "datasetName must be a non-empty string"),
        ("if-1", {"customExpression": 5}, "customExpression must be a string"),
        (
            "dataset-1",
            {"layerId": "l", "projectLayerId": True},
            "projectLayerId must be",
        ),
        ("dataset-1", {"layerId": "l", "projectLayerId": 0}, "projectLayerId must be"),
        ("dataset-1", {"layerName": "Kitas"}, "give layerId with it"),
        ("dataset-1", {"projectLayerId": 34}, "give layerId with it"),
        (
            "dataset-1",
            {"layerId": None, "filter": {"op": "and"}},
            "left open takes no filter",
        ),
    ],
)
def test_set_data_checks_the_values(node_id: str, data: Any, needle: str) -> None:
    with pytest.raises(OperationError, match=needle):
        apply(_stored(), [_set_data(node_id, data)])


def test_set_data_needs_an_object() -> None:
    with pytest.raises(OperationError, match="data must be an object"):
        apply(_stored(), [_set_data("export-1", ["datasetName"])])


def test_set_data_names_an_unknown_step() -> None:
    with pytest.raises(OperationError, match="'export-9'"):
        apply(_stored(), [_set_data("export-9", {"datasetName": "x"})])


# --- review minors ----------------------------------------------------------


def test_disconnect_refuses_an_empty_input_name() -> None:
    with pytest.raises(
        OperationError, match="target_handle must be a non-empty string"
    ):
        apply(
            _stored(),
            [
                {
                    "op": "disconnect",
                    "source": "dataset-1",
                    "target": "tool-1",
                    "target_handle": "",
                }
            ],
        )


def test_connect_names_a_feeder_that_no_longer_exists() -> None:
    config = _stored()
    config["edges"][4] = _edge("edge-z", "gone", "export-1", "input")
    with pytest.raises(OperationError) as raised:
        apply(config, [{"op": "connect", "source": "tool-2", "target": "export-1"}])
    assert (
        "input 'input' of 'export-1' is already fed by 'gone' (a connection from "
        "a step that no longer exists)" in str(raised.value)
    )


def test_disconnect_removes_a_connection_from_a_step_that_no_longer_exists() -> None:
    config = _stored()
    config["edges"][4] = _edge("edge-z", "gone", "export-1", "input")
    result = apply(
        config, [{"op": "disconnect", "source": "gone", "target": "export-1"}]
    )
    assert "edge-z" not in _ids(result["edges"])


def test_connect_refuses_the_editor_placeholder_input_of_a_tool() -> None:
    with pytest.raises(OperationError, match="for example input_layer_id"):
        apply(
            _stored(),
            [
                {
                    "op": "connect",
                    "source": "dataset-2",
                    "target": "tool-1",
                    "target_handle": "input",
                }
            ],
        )


def test_move_node_puts_a_new_position_after_the_type() -> None:
    result = apply(
        _stored(),
        [
            {"op": "add_node", "node": _buffer()},
            {"op": "move_node", "node_id": "tool-new", "position": {"x": 5, "y": 6}},
        ],
    )
    assert list(_node(result, "tool-new")) == ["id", "type", "position", "data"]


def test_set_settings_gives_a_tool_with_null_settings_its_first() -> None:
    config = _stored()
    _node(config, "tool-2")["data"]["config"] = None
    result = apply(
        config,
        [{"op": "set_settings", "node_id": "tool-2", "settings": {"area_type": "h3"}}],
    )
    assert _node(result, "tool-2")["data"]["config"] == {"area_type": "h3"}


def test_set_note_text_takes_a_colour() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "set_note_text",
                "node_id": "text-1",
                "text": "<p>Blue</p>",
                "color": "#5297DA",
            }
        ],
    )
    data = _node(result, "text-1")["data"]
    assert data["backgroundColor"] == "#5297DA"
    assert list(data) == list(_node(config, "text-1")["data"])


@pytest.mark.parametrize("color", ["blue", "#5297D", "#5297DAFF", 5])
def test_set_note_text_refuses_a_colour_that_is_not_hex(color: Any) -> None:
    with pytest.raises(OperationError, match="color must be a colour like #F2CE58"):
        apply(
            _stored(),
            [
                {
                    "op": "set_note_text",
                    "node_id": "text-1",
                    "text": "<p>Hi</p>",
                    "color": color,
                }
            ],
        )


def test_placement_jumps_below_what_it_overlaps_instead_of_stepping_row_by_row() -> (
    None
):
    """Ninety notes of the largest size stacked under the new step's spot,
    after five thousand steps elsewhere: one pass per note, where stepping a
    row at a time would scan the steps elsewhere at each of the 4500 rows
    down."""
    config = _stored()
    config["nodes"] += [
        {
            "id": f"aside-{index}",
            "type": "dataset",
            "position": {
                "x": -400_000 + 400 * (index % 1000),
                "y": 200 * (index // 1000),
            },
            "data": {"type": "dataset", "label": f"Aside {index}"},
        }
        for index in range(5000)
    ]
    config["nodes"] += [
        {
            "id": f"tall-{row}",
            "type": "textAnnotation",
            "position": {"x": 1080, "y": 150 + 10_000 * row},
            "data": {
                "type": "textAnnotation",
                "text": "<p>Tall</p>",
                "backgroundColor": "#F2CE58",
                "width": 320,
                "height": 10_000,
            },
        }
        for row in range(90)
    ]
    with _within(1):
        result = apply(
            config,
            [
                {"op": "add_node", "node": _buffer()},
                {
                    "op": "connect",
                    "source": "tool-2",
                    "target": "tool-new",
                    "target_handle": "input_layer_id",
                },
            ],
        )
    assert _node(result, "tool-new")["position"] == {"x": 1080, "y": 900_200}


def test_connect_stores_the_input_without_surrounding_spaces() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "connect",
                "source": "dataset-2",
                "target": "tool-1",
                "target_handle": " barriers ",
            }
        ],
    )
    (edge,) = _new_edges(config, result)
    assert edge["targetHandle"] == "barriers"


def test_disconnect_matches_an_input_given_with_spaces() -> None:
    config = _stored()
    result = apply(
        config,
        [
            {
                "op": "disconnect",
                "source": "dataset-1",
                "target": "tool-1",
                "target_handle": " starting_points ",
            }
        ],
    )
    assert "edge-a" not in _ids(result["edges"])


def test_set_data_swap_with_the_layer_id_alone_keeps_the_label() -> None:
    """Without layerName the new layer's name is unknown here, so the label
    stays; with it, the label follows (see the swap test above)."""
    result = apply(
        _stored(),
        [_set_data("dataset-1", {"layerId": "e2000000-0000-0000-0000-000000000099"})],
    )
    data = _node(result, "dataset-1")["data"]
    assert data["label"] == "Schools"
    assert "layerName" not in data and "projectLayerId" not in data
