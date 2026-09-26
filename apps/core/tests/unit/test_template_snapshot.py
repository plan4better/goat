"""Pure-Python template snapshot logic (T5/T7): detect, strip, kind, freeze, bind."""

import copy
from uuid import UUID

import pytest
from core.schemas.template import DetectedInput, TemplateInput
from core.templates.snapshot import (
    bind_workflow_config,
    detect_workflow_inputs,
    freeze_workflow_config,
    kinds_for,
    layout_page_mm,
    strip_layout_bindings,
)

LAYER_ID = "11111111-1111-1111-1111-111111111111"
NEW_LAYER_ID = "22222222-2222-2222-2222-222222222222"


def _workflow_config() -> dict:
    """A dataset node (layerId + projectLayerId), a tool node whose config
    references the dataset's projectLayerId, and an edge between them."""
    return {
        "nodes": [
            {
                "id": "n1",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "dataset",
                    "label": "Buildings",
                    "projectLayerId": 42,
                    "layerId": LAYER_ID,
                    "layerName": "Buildings",
                    "geometryType": "polygon",
                    "layerType": "feature",
                },
            },
            {
                "id": "n2",
                "type": "tool",
                "position": {"x": 100, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "label": "Buffer",
                    "config": {"input_layer_id": 42, "distance": 100},
                },
            },
        ],
        "edges": [
            {
                "id": "e1",
                "source": "n1",
                "target": "n2",
                "targetHandle": "input_layer_id",
            }
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


def _layout_config() -> dict:
    """A map element with two bound layers and a chart element bound via
    both `config.setup.layer_project_id` and bare `config.layer_project_id`,
    plus an atlas feature-coverage bound to a layer."""
    return {
        "page": {"size": "a4"},
        "layout": {"columns": 12},
        "elements": [
            {
                "id": "el1",
                "type": "map",
                "position": {"x": 0, "y": 0, "w": 1, "h": 1},
                "config": {
                    "viewState": {"latitude": 48.1, "longitude": 11.5, "zoom": 12},
                    "lock_layers": True,
                    "lock_styles": True,
                    "locked_layer_ids": [3, 4],
                    "locked_layer_styles": {"3": {"color": "#f00"}},
                    "locked_basemap_url": "https://tiles.example/streets.json",
                    "show_labels": True,
                },
                "style": {},
                "map_config": {
                    "layers": [3, 4],
                    "basemap": "streets",
                    "show_labels": True,
                },
            },
            {
                "id": "el2",
                "type": "histogram_chart",
                "position": {"x": 0, "y": 1, "w": 1, "h": 1},
                "config": {"setup": {"layer_project_id": 3, "title": "Chart"}},
                "style": {},
            },
            {
                "id": "el3",
                "type": "table",
                "position": {"x": 0, "y": 2, "w": 1, "h": 1},
                "config": {"layer_project_id": 4, "columns": ["name"]},
                "style": {},
            },
        ],
        "theme": None,
        "atlas": {
            "enabled": True,
            "coverage": {"type": "feature", "layer_project_id": 3, "sort_order": "asc"},
            "page_label": {"enabled": True, "template": "Page {page_number}"},
        },
    }


def _node(config: dict, node_id: str) -> dict:
    return next(n for n in config["nodes"] if n["id"] == node_id)


# ---------------------------------------------------------------------------
# detect_workflow_inputs
# ---------------------------------------------------------------------------


def test_detect_workflow_inputs_finds_the_bound_dataset_node() -> None:
    config = _workflow_config()
    detected = detect_workflow_inputs(config)
    assert len(detected) == 1
    only = detected[0]
    assert only.key == "node:n1"
    assert only.label == "Buildings"
    assert only.layer_id == UUID(LAYER_ID)
    assert only.project_layer_id == 42
    assert only.layer_type == "feature"
    assert only.geometry_type == "polygon"


def test_detect_workflow_inputs_skips_dataset_nodes_with_no_layer() -> None:
    config = _workflow_config()
    config["nodes"].append(
        {
            "id": "n3",
            "type": "dataset",
            "position": {"x": 0, "y": 0},
            "data": {"type": "dataset", "label": "Unbound"},
        }
    )
    detected = detect_workflow_inputs(config)
    assert [d.key for d in detected] == ["node:n1"]


@pytest.mark.parametrize(
    "stored,expected",
    [
        ("feature", "feature"),
        ("table", "table"),
        ("raster", "raster"),
        # Nodes saved before the web narrowed the field to the three types.
        ("layer", None),
        # The web writes the three lowercase, so a different case is unknown.
        ("FEATURE", None),
        (None, None),
        ("", None),
        (7, None),
        ({"kind": "feature"}, None),
    ],
)
def test_detect_workflow_inputs_only_keeps_known_layer_types(
    stored: object, expected: str | None
) -> None:
    config = _workflow_config()
    config["nodes"][0]["data"]["layerType"] = stored
    detected = detect_workflow_inputs(config)
    assert [d.key for d in detected] == ["node:n1"]
    assert detected[0].layer_type == expected


def test_detect_workflow_inputs_tolerates_a_missing_layer_type() -> None:
    config = _workflow_config()
    del config["nodes"][0]["data"]["layerType"]
    detected = detect_workflow_inputs(config)
    assert detected[0].layer_type is None


@pytest.mark.parametrize("stored", ["layer", "FEATURE", "", 7, {"kind": "feature"}])
def test_input_schemas_read_an_unknown_layer_type_as_none(stored: object) -> None:
    """No stored config can raise here: both input models coerce a layer type
    they do not know to None instead of rejecting the value."""
    assert (
        DetectedInput(
            key="node:n1", label="Buildings", layer_id=UUID(LAYER_ID), layer_type=stored
        ).layer_type
        is None
    )
    assert (
        TemplateInput(
            key="node:n1", label="Buildings", mode="ship", layer_type=stored
        ).layer_type
        is None
    )


# ---------------------------------------------------------------------------
# strip_layout_bindings
# ---------------------------------------------------------------------------


def test_strip_layout_bindings_removes_every_binding() -> None:
    config = _layout_config()
    original = copy.deepcopy(config)

    stripped = strip_layout_bindings(config)

    map_el = next(e for e in stripped["elements"] if e["id"] == "el1")
    chart_el = next(e for e in stripped["elements"] if e["id"] == "el2")
    table_el = next(e for e in stripped["elements"] if e["id"] == "el3")

    assert map_el["map_config"]["layers"] == []
    assert "layer_project_id" not in chart_el["config"]["setup"]
    assert "layer_project_id" not in table_el["config"]

    assert stripped["atlas"]["coverage"]
    assert "layer_project_id" not in stripped["atlas"]["coverage"]

    # Input is untouched (pure function, deep copy).
    assert config == original


def test_strip_layout_bindings_drops_the_map_view_and_lock_snapshot() -> None:
    """The author's viewport and locked-layer snapshot are that project's data:
    the ids are layer_project ids of the source project, and the view is where
    the author happened to be. Using the template elsewhere must start from
    the target project's own map; only the lock *intent* travels."""
    stripped = strip_layout_bindings(_layout_config())
    map_el = next(e for e in stripped["elements"] if e["id"] == "el1")

    for key in (
        "viewState",
        "locked_layer_ids",
        "locked_layer_styles",
        "locked_basemap_url",
    ):
        assert key not in map_el["config"], key
    assert map_el["config"]["lock_layers"] is True
    assert map_el["config"]["lock_styles"] is True
    assert map_el["config"]["show_labels"] is True


def test_strip_layout_bindings_keeps_everything_else_identical() -> None:
    config = _layout_config()
    stripped = strip_layout_bindings(config)

    map_el = next(e for e in stripped["elements"] if e["id"] == "el1")
    chart_el = next(e for e in stripped["elements"] if e["id"] == "el2")

    assert map_el["map_config"]["basemap"] == "streets"
    assert map_el["map_config"]["show_labels"] is True
    assert chart_el["config"]["setup"]["title"] == "Chart"
    assert stripped["page"] == {"size": "a4"}
    assert stripped["layout"] == {"columns": 12}
    assert stripped["atlas"]["coverage"]["sort_order"] == "asc"
    assert stripped["atlas"]["page_label"] == {
        "enabled": True,
        "template": "Page {page_number}",
    }


# ---------------------------------------------------------------------------
# kinds_for
# ---------------------------------------------------------------------------


def test_kinds_for_workflow_payload_is_always_just_workflow() -> None:
    assert kinds_for(
        "workflow", has_builder=True, has_workflows=True, has_layouts=True
    ) == ["workflow"]


def test_kinds_for_layout_payload_is_always_just_layout() -> None:
    assert kinds_for(
        "layout", has_builder=True, has_workflows=True, has_layouts=True
    ) == ["layout"]


def test_kinds_for_project_payload_combines_in_fixed_order() -> None:
    assert kinds_for(
        "project", has_builder=True, has_workflows=True, has_layouts=True
    ) == ["project", "dashboard", "workflow", "layout"]
    assert kinds_for(
        "project", has_builder=False, has_workflows=True, has_layouts=False
    ) == ["project", "workflow"]
    assert kinds_for(
        "project", has_builder=False, has_workflows=False, has_layouts=True
    ) == ["project", "layout"]


def test_kinds_for_bare_project_payload_is_just_project() -> None:
    assert kinds_for(
        "project", has_builder=False, has_workflows=False, has_layouts=False
    ) == ["project"]


# ---------------------------------------------------------------------------
# freeze_workflow_config
# ---------------------------------------------------------------------------


def test_freeze_ship_keeps_layer_and_records_source_project_layer_id() -> None:
    config = _workflow_config()
    original = copy.deepcopy(config)
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode="ship",
            layer_id=UUID(LAYER_ID),
            layer_type="feature",
            geometry_type="polygon",
        )
    ]

    frozen = freeze_workflow_config(config, inputs)

    data = _node(frozen, "n1")["data"]
    assert data["layerId"] == LAYER_ID
    assert "projectLayerId" not in data
    assert data["templateSourceProjectLayerId"] == 42
    assert data["templateInput"] == "node:n1"
    assert "unresolved" not in data

    # Ship: the tool param referencing the old projectLayerId is left alone,
    # bind_workflow_config remaps it once the new one is known.
    tool_data = _node(frozen, "n2")["data"]
    assert tool_data["config"]["input_layer_id"] == 42
    assert tool_data["config"]["distance"] == 100

    # Input is untouched (pure function, deep copy).
    assert config == original


def test_freeze_ask_clears_layer_and_nulls_out_tool_params() -> None:
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode="ask",
            layer_type="feature",
            geometry_type="polygon",
        )
    ]

    frozen = freeze_workflow_config(config, inputs)

    data = _node(frozen, "n1")["data"]
    assert "layerId" not in data
    assert "layerName" not in data
    assert "projectLayerId" not in data
    assert data["templateInput"] == "node:n1"
    assert data["unresolved"] is True

    tool_data = _node(frozen, "n2")["data"]
    assert tool_data["config"]["input_layer_id"] is None
    assert tool_data["config"]["distance"] == 100


# ---------------------------------------------------------------------------
# bind_workflow_config
# ---------------------------------------------------------------------------


def test_bind_resolves_ship_input_and_rewrites_tool_param() -> None:
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode="ship",
            layer_id=UUID(LAYER_ID),
            layer_type="feature",
            geometry_type="polygon",
        )
    ]
    frozen = freeze_workflow_config(config, inputs)

    bound, unresolved = bind_workflow_config(frozen, {"node:n1": (UUID(LAYER_ID), 99)})

    assert unresolved == []
    data = _node(bound, "n1")["data"]
    assert data["layerId"] == LAYER_ID
    assert data["projectLayerId"] == 99
    assert "unresolved" not in data
    assert "templateSourceProjectLayerId" not in data

    tool_data = _node(bound, "n2")["data"]
    assert tool_data["config"]["input_layer_id"] == 99
    assert tool_data["config"]["distance"] == 100


def test_bind_resolves_ask_input_with_a_new_layer() -> None:
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1", label="Buildings", mode="ask", layer_type="feature"
        )
    ]
    frozen = freeze_workflow_config(config, inputs)

    bound, unresolved = bind_workflow_config(
        frozen, {"node:n1": (UUID(NEW_LAYER_ID), 55)}
    )

    assert unresolved == []
    data = _node(bound, "n1")["data"]
    assert data["layerId"] == NEW_LAYER_ID
    assert data["projectLayerId"] == 55
    assert "unresolved" not in data


def test_bind_reports_unresolved_keys_when_no_binding_is_supplied() -> None:
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1", label="Buildings", mode="ask", layer_type="feature"
        )
    ]
    frozen = freeze_workflow_config(config, inputs)

    bound, unresolved = bind_workflow_config(frozen, {})

    assert unresolved == ["node:n1"]
    data = _node(bound, "n1")["data"]
    assert data["unresolved"] is True
    assert "layerId" not in data


def test_bind_does_not_mutate_the_frozen_config() -> None:
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode="ship",
            layer_id=UUID(LAYER_ID),
            layer_type="feature",
        )
    ]
    frozen = freeze_workflow_config(config, inputs)
    original_frozen = copy.deepcopy(frozen)

    bind_workflow_config(frozen, {"node:n1": (UUID(LAYER_ID), 99)})

    assert frozen == original_frozen


def test_bind_drops_a_ship_layer_reference_it_could_not_rebind() -> None:
    """A "ship" input keeps the source project's `layerId` through the
    freeze. If the Use flow hands back no binding for it, that id names a
    layer the destination project does not hold — an unresolved node must
    not keep pointing at another project's layer, and neither may the tool
    params that referenced its projectLayerId."""
    config = _workflow_config()
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode="ship",
            layer_id=UUID(LAYER_ID),
            layer_type="feature",
            geometry_type="polygon",
        )
    ]
    frozen = freeze_workflow_config(config, inputs)
    assert _node(frozen, "n1")["data"]["layerId"] == LAYER_ID

    bound, unresolved = bind_workflow_config(frozen, {"node:n1": (None, None)})

    assert unresolved == ["node:n1"]
    data = _node(bound, "n1")["data"]
    assert data["unresolved"] is True
    assert "layerId" not in data
    assert "projectLayerId" not in data
    assert _node(bound, "n2")["data"]["config"]["input_layer_id"] is None
    assert _node(bound, "n2")["data"]["config"]["distance"] == 100


def test_bind_never_rewrites_a_tool_param_twice() -> None:
    """Two ship inputs where the first's NEW projectLayerId is the second's
    OLD one (7 -> 8, 8 -> 9): applied one after the other, the first node's
    7 would be carried on to 9. Every pair must land exactly once."""
    config = {
        "nodes": [
            {
                "id": "a",
                "type": "dataset",
                "data": {"layerId": LAYER_ID, "projectLayerId": 7},
            },
            {
                "id": "b",
                "type": "dataset",
                "data": {"layerId": NEW_LAYER_ID, "projectLayerId": 8},
            },
            {
                "id": "t",
                "type": "tool",
                "data": {"config": {"first": 7, "second": 8, "distance": 100}},
            },
        ],
        "edges": [],
    }
    inputs = [
        TemplateInput(key="node:a", label="A", mode="ship", layer_id=UUID(LAYER_ID)),
        TemplateInput(
            key="node:b", label="B", mode="ship", layer_id=UUID(NEW_LAYER_ID)
        ),
    ]
    frozen = freeze_workflow_config(config, inputs)

    bound, unresolved = bind_workflow_config(
        frozen,
        {"node:a": (UUID(LAYER_ID), 8), "node:b": (UUID(NEW_LAYER_ID), 9)},
    )

    assert unresolved == []
    assert _node(bound, "t")["data"]["config"] == {
        "first": 8,
        "second": 9,
        "distance": 100,
    }


class TestLayoutPageMm:
    """The millimetres a layout template's card shows: read off the frozen
    config so a Custom page is as well described as a named one."""

    def test_custom_page_reads_its_own_sides(self) -> None:
        config = {
            "page": {
                "size": "Custom",
                "orientation": "portrait",
                "width": 500,
                "height": 300,
            }
        }
        assert layout_page_mm(config) == (500.0, 300.0)

    def test_named_page_is_turned_by_its_orientation(self) -> None:
        assert layout_page_mm({"page": {"size": "A3", "orientation": "landscape"}}) == (
            420.0,
            297.0,
        )
        assert layout_page_mm({"page": {"size": "A1", "orientation": "portrait"}}) == (
            594.0,
            841.0,
        )

    def test_unknown_or_missing_page_gives_nothing(self) -> None:
        assert layout_page_mm({"page": {"size": "Poster"}}) is None
        assert (
            layout_page_mm({"page": {"size": "Custom", "width": 10, "height": 300}})
            is None
        )
        assert layout_page_mm({}) is None
        assert layout_page_mm(None) is None


# ---------------------------------------------------------------------------
# One dataset in several nodes
# ---------------------------------------------------------------------------


def _same_dataset_twice() -> dict:
    """The workflow config with a second dataset node on the same layer,
    filtered differently, as when one dataset feeds two branches."""
    config = _workflow_config()
    first = _node(config, "n1")
    first["data"]["filter"] = {"op": "<", "args": [{"property": "area"}, 500]}
    second = copy.deepcopy(first)
    second["id"] = "n3"
    second["data"]["filter"] = {"op": ">=", "args": [{"property": "area"}, 500]}
    config["nodes"].append(second)
    return config


def test_detect_lists_a_dataset_once_however_many_nodes_use_it() -> None:
    detected = detect_workflow_inputs(_same_dataset_twice())

    assert [d.key for d in detected] == ["node:n1"]
    assert detected[0].layer_id == UUID(LAYER_ID)


@pytest.mark.parametrize("mode", ["ship", "ask"])
def test_freeze_marks_every_node_of_a_dataset_with_its_one_input(mode: str) -> None:
    inputs = [
        TemplateInput(
            key="node:n1",
            label="Buildings",
            mode=mode,  # type: ignore[arg-type]
            layer_id=UUID(LAYER_ID) if mode == "ship" else None,
            layer_type="feature",
        )
    ]

    frozen = freeze_workflow_config(_same_dataset_twice(), inputs)

    for node_id in ("n1", "n3"):
        data = _node(frozen, node_id)["data"]
        assert data["templateInput"] == "node:n1"
        assert ("unresolved" in data) is (mode == "ask")


def test_bind_fills_every_node_of_a_dataset_and_keeps_each_filter() -> None:
    config = _same_dataset_twice()
    inputs = [
        TemplateInput(
            key="node:n1", label="Buildings", mode="ask", layer_type="feature"
        )
    ]
    frozen = freeze_workflow_config(config, inputs)

    bound, unresolved = bind_workflow_config(
        frozen, {"node:n1": (UUID(NEW_LAYER_ID), 55)}
    )

    assert unresolved == []
    for node_id in ("n1", "n3"):
        data = _node(bound, node_id)["data"]
        assert data["layerId"] == NEW_LAYER_ID
        assert data["projectLayerId"] == 55
        assert data["filter"] == _node(config, node_id)["data"]["filter"]
