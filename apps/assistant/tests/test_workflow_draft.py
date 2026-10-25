"""The draft and its conversion into the editor's config (spec §4.1, §4.2).

The shared fixture is read by the web's test as well, which runs the editor's
own rule (isDrawableWorkflowConfig) on every converted config."""

import json
import uuid
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import ValidationError

from assistant.workflows.draft import (
    CANVAS_HEIGHT,
    CANVAS_MARGIN,
    CANVAS_WIDTH,
    EXPRESSIONS,
    ID_NAMESPACE,
    MAX_NOTE_CHARS,
    MAX_NOTES,
    MIN_ZOOM,
    NODE_HEIGHT,
    NODE_WIDTH,
    NOTE_COLORS,
    NOTE_GAP,
    NOTE_HEIGHT,
    NOTE_WIDTH,
    ROW_SPACING,
    Condition,
    Draft,
    DraftError,
    DraftNote,
    NoteColor,
    ProjectLayer,
    Region,
    node_id,
    note_html,
    open_steps,
    region_from_feature,
    to_config,
)

FIXTURE = Path(__file__).parent / "fixtures" / "workflow_drafts.json"
SHARED: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
LAYERS = {row["layer_project_id"]: ProjectLayer(**row) for row in SHARED["layers"]}
TITLES: dict[str, str] = SHARED["titles"]
MUNICH = Region(
    "DE212",
    "München, Kreisfreie Stadt",
    {
        "type": "Polygon",
        "coordinates": [
            [
                [11.36, 48.06],
                [11.72, 48.06],
                [11.72, 48.25],
                [11.36, 48.25],
                [11.36, 48.06],
            ]
        ],
    },
)


def _draft(
    steps: list[dict[str, Any]], connections: list[dict[str, Any]] | None = None
) -> Draft:
    return Draft.model_validate(
        {"name": "Test", "steps": steps, "connections": connections or []}
    )


def _convert(draft: Draft, regions: dict[str, Region] | None = None) -> dict[str, Any]:
    return to_config(draft, layers=LAYERS, regions=regions or {}, titles=TITLES).config


def _shops(**changes: Any) -> dict[str, Any]:
    return {"id": "shops", "kind": "dataset", "layer": 34, **changes}


def _ring() -> dict[str, Any]:
    return {
        "id": "ring",
        "kind": "tool",
        "tool": "buffer",
        "settings": {"distances": [500]},
    }


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda case: case["note"][:40])
def test_the_shared_fixture_is_what_the_conversion_gives(case: dict[str, Any]) -> None:
    regions = {row["nuts_id"]: Region(**row) for row in case["regions"]}
    draft = Draft.model_validate(case["draft"])
    assert _convert(draft, regions) == case["config"]


def test_the_same_draft_gives_the_same_ids() -> None:
    draft = _draft(
        [_shops(), _ring()],
        [{"from": "shops", "to": "ring", "input": "input_layer_id"}],
    )
    first, second = _convert(draft), _convert(draft)
    assert first == second
    assert [node["id"] for node in first["nodes"]] == [
        f"dataset-{uuid.uuid5(ID_NAMESPACE, 'shops')}",
        f"tool-{uuid.uuid5(ID_NAMESPACE, 'ring')}",
    ]
    assert first["edges"][0]["id"].startswith("edge-")
    converted = to_config(draft, layers=LAYERS, regions={}, titles=TITLES)
    assert converted.node_ids == {
        "shops": first["nodes"][0]["id"],
        "ring": first["nodes"][1]["id"],
    }
    assert converted.step_of == {
        node: step for step, node in converted.node_ids.items()
    }
    assert converted.labels == {"shops": "Supermärkte", "ring": "Buffer"}


def _derived_ids(config: dict[str, Any]) -> list[str]:
    """Every id the conversion derives: steps, connections, filter
    conditions and variables."""
    ids = [node["id"] for node in config["nodes"]]
    ids += [edge["id"] for edge in config["edges"]]
    ids += [
        expression["id"]
        for node in config["nodes"]
        for expression in (node["data"].get("filter") or {}).get("expressions", [])
    ]
    ids += [variable["id"] for variable in config["variables"]]
    return ids


def test_a_salt_enters_every_derived_id() -> None:
    """Export node ids must be unique per workflow (goatlib's export target
    finds a result layer by them), so each salt gives ids of its own; the
    default salt keeps the ids of the shared fixture."""
    draft = Draft.model_validate(
        {
            "name": "Rings",
            "steps": [
                _shops(
                    filter={"where": [{"field": "kette", "op": "=", "value": "Edeka"}]}
                ),
                _ring(),
                {"id": "save", "kind": "export", "name": "Rings"},
            ],
            "connections": [
                {"from": "shops", "to": "ring", "input": "input_layer_id"},
                {"from": "ring", "to": "save"},
            ],
            "variables": [{"name": "minutes", "type": "number", "defaultValue": 15}],
        }
    )

    def convert(salt: str) -> Any:
        return to_config(draft, layers=LAYERS, regions={}, titles=TITLES, salt=salt)

    plain, first, second = convert(""), convert("a1"), convert("b2")
    assert plain.config == _convert(draft)
    assert len(_derived_ids(first.config)) == 7
    assert not set(_derived_ids(first.config)) & set(_derived_ids(second.config))
    assert not set(_derived_ids(first.config)) & set(_derived_ids(plain.config))
    assert convert("a1") == first
    assert first.node_ids == {step.id: node_id(step, "a1") for step in draft.steps}
    assert [node["id"] for node in first.config["nodes"]] == list(
        first.node_ids.values()
    )
    assert first.config["edges"][0]["source"] == first.node_ids["shops"]
    assert first.step_of == {node: step for step, node in first.node_ids.items()}


def test_edges_carry_the_editor_handles() -> None:
    draft = _draft(
        [_shops(), _ring(), {"id": "save", "kind": "export", "name": "Rings"}],
        [
            {"from": "shops", "to": "ring", "input": "input_layer_id"},
            {"from": "ring", "to": "save"},
        ],
    )
    into_tool, into_export = _convert(draft)["edges"]
    assert "sourceHandle" not in into_tool
    assert into_tool["targetHandle"] == "input_layer_id"
    assert (into_export["sourceHandle"], into_export["targetHandle"]) == (
        "output",
        "input",
    )


def test_a_dataset_step_takes_the_layer_from_the_project_list() -> None:
    [node] = _convert(_draft([_shops(label="Shops")]))["nodes"]
    assert node["type"] == "dataset"
    assert node["data"] == {
        "type": "dataset",
        "label": "Shops",
        "projectLayerId": 34,
        "layerId": "e2000000-0000-0000-0000-000000000034",
        "layerName": "Supermärkte",
        "filterInitialized": True,
        "geometryType": "point",
        "layerType": "feature",
    }


def test_an_open_step_gets_only_its_label() -> None:
    [node] = _convert(
        _draft(
            [{"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None}]
        )
    )["nodes"]
    assert node["data"] == {"type": "dataset", "label": "Toilets"}


def test_a_tool_step_is_named_by_its_label_else_the_tools_title_else_its_id() -> None:
    steps = [
        {"id": "a", "kind": "tool", "tool": "buffer", "label": "500 m rings"},
        {"id": "b", "kind": "tool", "tool": "buffer"},
        {"id": "c", "kind": "tool", "tool": "no_such_tool"},
    ]
    nodes = _convert(_draft(steps))["nodes"]
    assert [node["data"]["label"] for node in nodes] == [
        "500 m rings",
        "Buffer",
        "no_such_tool",
    ]
    assert nodes[0]["data"] == {
        "type": "tool",
        "processId": "buffer",
        "label": "500 m rings",
        "config": {},
        "status": "idle",
    }


def test_an_export_step_saves_into_the_project() -> None:
    [node] = _convert(_draft([{"id": "save", "kind": "export", "name": "Rings"}]))[
        "nodes"
    ]
    assert node["data"] == {
        "type": "export",
        "label": "Rings",
        "datasetName": "Rings",
        "addToProject": True,
        "overwritePrevious": False,
    }


def test_steps_go_left_to_right_by_depth_and_each_column_is_centred() -> None:
    draft = _draft(
        [
            _shops(),
            {"id": "people", "kind": "dataset", "layer": 33},
            {"id": "schools", "kind": "dataset", "layer": 31},
            _ring(),
            {"id": "count", "kind": "tool", "tool": "aggregate_polygon"},
            {"id": "save", "kind": "export", "name": "Counts"},
        ],
        [
            {"from": "shops", "to": "ring", "input": "input_layer_id"},
            {"from": "ring", "to": "count", "input": "area_layer_id"},
            {"from": "people", "to": "count", "input": "source_layer_id"},
            {"from": "count", "to": "save"},
        ],
    )
    positions = {node["id"]: node["position"] for node in _convert(draft)["nodes"]}
    at = {step.id: positions[node_id(step)] for step in draft.steps}
    assert at == {
        "shops": {"x": 0, "y": -200},
        "people": {"x": 0, "y": 0},
        "schools": {"x": 0, "y": 200},
        "ring": {"x": 360, "y": 0},
        "count": {"x": 720, "y": 0},
        "save": {"x": 1080, "y": 0},
    }


def test_a_loop_is_laid_out_after_the_steps_leading_into_it() -> None:
    draft = _draft(
        [_shops(), _ring(), {"id": "cut", "kind": "tool", "tool": "clip"}],
        [
            {"from": "shops", "to": "ring", "input": "input_layer_id"},
            {"from": "ring", "to": "cut", "input": "input_layer_id"},
            {"from": "cut", "to": "ring", "input": "overlay_layer_id"},
        ],
    )
    xs = [node["position"]["x"] for node in _convert(draft)["nodes"]]
    assert xs == [0, 360, 720]


def test_the_viewport_shows_every_step() -> None:
    one = _convert(_draft([_shops()]))
    assert one["viewport"] == {"x": CANVAS_MARGIN, "y": CANVAS_MARGIN, "zoom": 1.0}
    chain = [_shops()] + [
        {"id": f"t{n}", "kind": "tool", "tool": "buffer"} for n in range(12)
    ]
    connections = [{"from": "shops", "to": "t0", "input": "input_layer_id"}] + [
        {"from": f"t{n}", "to": f"t{n + 1}", "input": "input_layer_id"}
        for n in range(11)
    ]
    config = _convert(_draft(chain, connections))
    view = config["viewport"]
    assert MIN_ZOOM <= view["zoom"] < 1
    for node in config["nodes"]:
        x = node["position"]["x"] * view["zoom"] + view["x"]
        y = node["position"]["y"] * view["zoom"] + view["y"]
        assert x >= 0 and x + NODE_WIDTH * view["zoom"] <= CANVAS_WIDTH
        assert y >= 0 and y + NODE_HEIGHT * view["zoom"] <= CANVAS_HEIGHT


@pytest.mark.parametrize(
    ("op", "value"),
    [
        ("=", "Edeka"),
        ("!=", "Lidl"),
        ("<", 3),
        ("<=", 3.5),
        (">", 10),
        (">=", 0),
        ("in", ["Edeka", "Rewe"]),
        ("contains", "markt"),
    ],
)
def test_conditions_use_the_editors_expressions(op: str, value: Any) -> None:
    step = _shops(filter={"where": [{"field": "kette", "op": op, "value": value}]})
    [node] = _convert(_draft([step]))["nodes"]
    [expression] = node["data"]["filter"]["expressions"]
    assert node["data"]["filter"]["op"] == "and"
    assert expression == {
        "id": str(uuid.uuid5(ID_NAMESPACE, "shops:filter:1")),
        "type": "logical",
        "attribute": "kette",
        "expression": EXPRESSIONS[op],
        "value": value,
    }


def test_an_area_is_a_spatial_expression_with_the_regions_boundary() -> None:
    step = _shops(filter={"area": "DE212"})
    [node] = _convert(_draft([step]), {"DE212": MUNICH})["nodes"]
    [expression] = node["data"]["filter"]["expressions"]
    assert (expression["type"], expression["attribute"], expression["expression"]) == (
        "spatial",
        "geom",
        "s_intersects",
    )
    assert json.loads(expression["value"]) == {
        **MUNICH.geometry,
        "properties": {"type": "boundary", "label": "München, Kreisfreie Stadt"},
    }
    with pytest.raises(DraftError, match="no boundary for region 'DE212'"):
        _convert(_draft([step]))


def test_a_large_boundary_becomes_its_bounding_box() -> None:
    """Review Focus 5: a state's boundary is not stored in the workflow."""
    ring = [[round(11 + n / 1000, 3), round(48 + (n % 7) / 100, 2)] for n in range(400)]
    ring.append([11.0, 48.0])
    feature = {
        "type": "Feature",
        "properties": {"nuts_id": "DE2", "nuts_name": "Bayern"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    small = region_from_feature("DE2", feature)
    assert (small.name, small.as_box) == ("Bayern", False)
    assert small.geometry == feature["geometry"]
    boxed = region_from_feature("DE2", feature, max_bytes=1000)
    assert boxed.as_box
    assert boxed.geometry == {
        "type": "Polygon",
        "coordinates": [
            [[11.0, 48.0], [11.399, 48.0], [11.399, 48.06], [11.0, 48.06], [11.0, 48.0]]
        ],
    }
    with pytest.raises(DraftError, match="has no boundary"):
        region_from_feature("DE2", {"type": "Feature", "geometry": None})


def test_an_open_step_takes_no_filter() -> None:
    """Review Focus 2: choosing the layer in the editor would replace it."""
    with pytest.raises(ValidationError, match="a step left open takes no filter"):
        _draft(
            [
                {
                    "id": "toilets",
                    "kind": "dataset",
                    "label": "Toilets",
                    "layer": None,
                    "filter": {"area": "DE212"},
                }
            ]
        )


def test_an_open_step_is_named_for_what_is_missing() -> None:
    with pytest.raises(ValidationError, match="needs a label"):
        _draft([{"id": "toilets", "kind": "dataset", "layer": None}])
    with pytest.raises(ValidationError, match="Field required"):
        _draft([{"id": "toilets", "kind": "dataset", "label": "Toilets"}])


@pytest.mark.parametrize(
    ("steps", "connections", "message"),
    [
        ([_shops(), _shops()], [], "two steps have the id 'shops'"),
        (
            [_shops()],
            [{"from": "shops", "to": "ring", "input": "x"}],
            "unknown step 'ring'",
        ),
        (
            [{"id": "save", "kind": "export", "name": "S"}, _ring()],
            [{"from": "save", "to": "ring", "input": "input_layer_id"}],
            "nothing reads from it",
        ),
        ([_ring(), _shops()], [{"from": "ring", "to": "shops"}], "reads from nothing"),
        (
            [_ring(), {"id": "save", "kind": "export", "name": "S"}],
            [{"from": "ring", "to": "save", "input": "input"}],
            "has no input",
        ),
        (
            [_shops(), _ring()],
            [{"from": "shops", "to": "ring"}],
            "needs the input it feeds",
        ),
        (
            [_shops(), {"id": "people", "kind": "dataset", "layer": 33}, _ring()],
            [
                {"from": "shops", "to": "ring", "input": "input_layer_id"},
                {"from": "people", "to": "ring", "input": "input_layer_id"},
            ],
            "two connections feed 'ring' 'input_layer_id'",
        ),
    ],
)
def test_the_draft_graph_follows_the_editors_rules(
    steps: list[dict[str, Any]], connections: list[dict[str, Any]], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _draft(steps, connections)


@pytest.mark.parametrize(
    ("condition", "message"),
    [
        ({"field": "a", "op": "in", "value": "x"}, "non-empty list"),
        ({"field": "a", "op": "=", "value": ["x"]}, "only 'in' takes a list"),
        ({"field": "a", "op": "contains", "value": 3}, "'contains' takes text"),
        ({"field": "a", "op": ">", "value": True}, "yes/no value"),
    ],
)
def test_a_condition_value_fits_its_operator(
    condition: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        Condition.model_validate(condition)
    assert (
        Condition.model_validate({"field": "a", "op": "=", "value": True}).value is True
    )


def test_an_unknown_layer_is_a_draft_error() -> None:
    with pytest.raises(DraftError, match="no layer 99 in the project"):
        _convert(_draft([_shops(layer=99)]))


def test_open_steps_follow_the_connections() -> None:
    draft = _draft(
        [
            {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
            _shops(),
            {"id": "walk", "kind": "tool", "tool": "catchment_area_v2"},
            {"id": "count", "kind": "tool", "tool": "aggregate_points"},
            {"id": "other", "kind": "tool", "tool": "buffer"},
            {"id": "save", "kind": "export", "name": "S"},
        ],
        [
            {"from": "toilets", "to": "walk", "input": "starting_points"},
            {"from": "walk", "to": "count", "input": "area_layer_id"},
            {"from": "shops", "to": "count", "input": "source_layer_id"},
            {"from": "shops", "to": "other", "input": "input_layer_id"},
            {"from": "count", "to": "save"},
        ],
    )
    assert open_steps(draft) == {"toilets", "walk", "count", "save"}


def test_variables_get_the_editors_shape() -> None:
    draft = Draft.model_validate(
        {
            "name": "V",
            "steps": [_shops()],
            "variables": [
                {"name": "minutes", "type": "number", "defaultValue": 15},
                {
                    "name": "mode",
                    "type": "string",
                    "label": "Mode",
                    "description": "How people travel",
                },
            ],
        }
    )
    assert _convert(draft)["variables"] == [
        {
            "id": f"variable-{uuid.uuid5(ID_NAMESPACE, 'variable:minutes')}",
            "name": "minutes",
            "type": "number",
            "order": 0,
            "defaultValue": 15,
        },
        {
            "id": f"variable-{uuid.uuid5(ID_NAMESPACE, 'variable:mode')}",
            "name": "mode",
            "type": "string",
            "order": 1,
            "label": "Mode",
            "description": "How people travel",
        },
    ]
    with pytest.raises(ValidationError, match="two variables"):
        Draft.model_validate(
            {
                "name": "V",
                "steps": [_shops()],
                "variables": [{"name": "a", "type": "string"}] * 2,
            }
        )


@pytest.mark.parametrize("step_id", ["", "has space", "x" * 41, "ümlaut"])
def test_a_step_id_is_short_and_plain(step_id: str) -> None:
    with pytest.raises(ValidationError):
        _draft([_shops(id=step_id)])


# -- notes ---------------------------------------------------------------------


def _noted(
    notes: list[dict[str, Any]],
    steps: list[dict[str, Any]] | None = None,
    connections: list[dict[str, Any]] | None = None,
) -> Draft:
    return Draft.model_validate(
        {
            "name": "Test",
            "steps": steps or [_shops()],
            "connections": connections or [],
            "notes": notes,
        }
    )


def _note(note_id: str = "about", **changes: Any) -> dict[str, Any]:
    return {"id": note_id, "text": "Counts the shops.", **changes}


def test_a_note_becomes_the_editors_text_annotation() -> None:
    draft = _noted([_note(near=["shops"])])
    converted = to_config(draft, layers=LAYERS, regions={}, titles=TITLES)
    step, note = converted.config["nodes"]
    assert step["id"] == node_id(draft.steps[0])
    assert note == {
        "id": f"text-{uuid.uuid5(ID_NAMESPACE, 'about')}",
        "type": "textAnnotation",
        "position": note["position"],
        "zIndex": -1000,
        "data": {
            "type": "textAnnotation",
            "text": "<p>Counts the shops.</p>",
            "backgroundColor": NOTE_COLORS["yellow"],
            "width": NOTE_WIDTH,
            "height": NOTE_HEIGHT,
        },
    }
    assert NOTE_COLORS["yellow"] == "#F2CE58"
    # A note is no step: the issues of the check map to steps only.
    assert converted.node_ids == {"shops": step["id"]}
    assert converted.step_of == {step["id"]: "shops"}
    assert converted.labels == {"shops": "Supermärkte"}


def test_a_salt_enters_a_notes_id() -> None:
    draft = _noted([_note()])

    def note_id(salt: str) -> str:
        config = to_config(
            draft, layers=LAYERS, regions={}, titles=TITLES, salt=salt
        ).config
        return str(config["nodes"][1]["id"])

    assert note_id("a1") == note_id("a1")
    assert len({note_id(""), note_id("a1"), note_id("b2")}) == 3


@pytest.mark.parametrize(
    ("text", "html"),
    [
        ("Counts the shops.", "<p>Counts the shops.</p>"),
        (
            "Counts <b>shops</b> & more.",
            "<p>Counts &lt;b&gt;shops&lt;/b&gt; &amp; more.</p>",
        ),
        ("First.\n\nSecond.", "<p>First.</p><p>Second.</p>"),
        ("One line\nthe next line", "<p>One line<br>the next line</p>"),
        (
            "Bands:\n- 0 to 5 minutes\n- 5 to 10 minutes\n\nRead the export.",
            "<p>Bands:</p><ul><li><p>0 to 5 minutes</p></li>"
            "<li><p>5 to 10 minutes</p></li></ul><p>Read the export.</p>",
        ),
        (
            "  - indented item\n-not an item",
            "<ul><li><p>indented item</p></li></ul><p>-not an item</p>",
        ),
        ("\r\n  Text  \r\n\r\n\r\n", "<p>Text</p>"),
        # The editor collapses runs of spaces and writes a non-breaking space
        # as &nbsp;: a text it would rewrite on opening marks the workflow as
        # changed.
        ("a  b\tc d", "<p>a b c d</p>"),
        ("a\u00a0b \u00a0c", "<p>a b c</p>"),
        ("-\u00a0item", "<ul><li><p>item</p></li></ul>"),
    ],
)
def test_a_notes_text_becomes_the_editors_html(text: str, html: str) -> None:
    assert note_html(text) == html


@pytest.mark.parametrize("color", sorted(NOTE_COLORS))
def test_a_notes_color_is_one_the_editor_offers(color: str) -> None:
    config = _convert(_noted([_note(color=color)]))
    assert config["nodes"][1]["data"]["backgroundColor"] == NOTE_COLORS[color]
    assert NOTE_COLORS[color] == NOTE_COLORS[color].upper()


def test_every_note_color_has_a_swatch() -> None:
    assert set(get_args(NoteColor)) == set(NOTE_COLORS)


@pytest.mark.parametrize(
    ("notes", "message"),
    [
        ([_note(text="")], "at least 1 character"),
        ([_note(text=" \n\n ")], "note 'about': the text is empty"),
        ([_note(near=["shops"] * 11)], "at most 10 items"),
        ([_note(color="pink")], r"color\n  Input should be 'yellow'"),
        ([_note(note_id="has space")], r"id\n  String should match pattern"),
        ([_note(html="<p>x</p>")], r"html\n  Extra inputs are not permitted"),
        (
            [_note(f"n{index}") for index in range(MAX_NOTES + 1)],
            f"at most {MAX_NOTES} items",
        ),
        (
            [_note(near=["shops", "nowhere"])],
            "note 'about' names the unknown step 'nowhere'",
        ),
        ([_note("shops")], "note 'shops' has the id of a step"),
        ([_note(), _note()], "two notes have the id 'about'"),
        (
            [_note("first"), _note("second", near=["first"])],
            "note 'second' names the unknown step 'first'",
        ),
    ],
)
def test_a_note_follows_the_drafts_rules(
    notes: list[dict[str, Any]], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _noted(notes)


def test_an_over_long_note_is_refused_with_how_to_shorten_it() -> None:
    """The model shortens an over-long note itself; it never asks the user
    about a note."""
    assert _noted([_note(text="x" * MAX_NOTE_CHARS)]).notes[0].text
    with pytest.raises(ValidationError) as refused:
        _noted([_note(text="x" * (MAX_NOTE_CHARS + 1))])
    message = " ".join(refused.value.errors()[0]["msg"].split())
    assert "note 'about': the text has 1,001 characters, more than the 1,000" in message
    assert (
        "Shorten the note itself to what the workflow answers and how to read "
        "its results" in message
    )
    assert "never ask the user about a note" in message


def test_the_note_limit_stays_in_the_schema_the_model_reads() -> None:
    schema = DraftNote.model_json_schema()
    assert schema["properties"]["text"]["maxLength"] == MAX_NOTE_CHARS == 1000


def test_notes_are_optional() -> None:
    assert _draft([_shops()]).notes == []


def _box(node: dict[str, Any]) -> tuple[int, int, int, int]:
    """A node's left, top, right and bottom: a note by its size, a step by
    the largest size a step is drawn at."""
    x, y = node["position"]["x"], node["position"]["y"]
    if node["type"] == "textAnnotation":
        width, height = node["data"]["width"], node["data"]["height"]
    else:
        width, height = NODE_WIDTH, NODE_HEIGHT
    return x, y, x + width, y + height


def _overlap(first: dict[str, Any], second: dict[str, Any]) -> bool:
    a, b = _box(first), _box(second)
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _apart(first: dict[str, Any], second: dict[str, Any]) -> tuple[int, int]:
    """How far apart the two nodes are across and down; negative where they
    overlap on that axis."""
    a, b = _box(first), _box(second)
    return max(b[0] - a[2], a[0] - b[2]), max(b[1] - a[3], a[1] - b[3])


def _clear(first: dict[str, Any], second: dict[str, Any]) -> bool:
    """Two notes keep NOTE_GAP between them across or down; a note and a
    step keep it down when one lies above the other (steps of neighbouring
    columns touch at their widest)."""
    across, down = _apart(first, second)
    if "textAnnotation" == first["type"] == second["type"]:
        return across >= NOTE_GAP or down >= NOTE_GAP
    if "textAnnotation" in (first["type"], second["type"]):
        return across >= 0 or down >= NOTE_GAP
    return not _overlap(first, second)


#: Three datasets in the first column, a tool and an export after them.
_COLUMNS: dict[str, Any] = {
    "steps": [
        _shops(),
        {"id": "people", "kind": "dataset", "layer": 33},
        {"id": "schools", "kind": "dataset", "layer": 31},
        _ring(),
        {"id": "save", "kind": "export", "name": "Rings"},
    ],
    "connections": [
        {"from": "shops", "to": "ring", "input": "input_layer_id"},
        {"from": "ring", "to": "save"},
    ],
}


def test_a_note_sits_directly_above_the_step_it_explains() -> None:
    config = _convert(_noted([_note(near=["shops"])]))
    step, note = config["nodes"]
    gap = ROW_SPACING - NODE_HEIGHT
    assert note["position"] == {
        "x": step["position"]["x"],
        "y": step["position"]["y"] - gap - NOTE_HEIGHT,
    }


def test_notes_sit_beside_their_steps_and_overlap_nothing() -> None:
    draft = _noted(
        [
            _note("middle", near=["people"]),
            _note("again", near=["people"]),
            _note("tail", near=["ring", "save"]),
            _note("whole"),
            _note("more", text="A longer note. " * 60),
        ],
        **_COLUMNS,
    )
    config = _convert(draft)
    nodes = config["nodes"]
    by_id = {step.id: nodes[index] for index, step in enumerate(draft.steps)}
    notes = nodes[len(draft.steps) :]
    assert [node["type"] for node in notes] == ["textAnnotation"] * MAX_NOTES
    for index, node in enumerate(nodes):
        for other in nodes[index + 1 :]:
            assert _clear(node, other), (node["id"], other["id"])
    steps_right = max(_box(node)[2] for node in by_id.values())
    for note, node in zip(draft.notes, notes, strict=True):
        left, top, right, bottom = _box(node)
        if not note.near:
            # Right of the whole workflow.
            assert left > steps_right
            continue
        named = [_box(by_id[step_id]) for step_id in note.near]
        # Above the named steps, and level with them.
        assert bottom < min(box[1] for box in named)
        assert left < max(box[2] for box in named)
        assert right > min(box[0] for box in named)


def test_notes_above_neighbouring_columns_keep_the_gap_between_them() -> None:
    draft = _noted(
        [_note("first", near=["shops"]), _note("second", near=["ring"])],
        [_shops(), _ring()],
        [{"from": "shops", "to": "ring", "input": "input_layer_id"}],
    )
    _, _, first, second = _convert(draft)["nodes"]
    assert first["position"]["y"] == second["position"]["y"]
    assert _apart(first, second)[0] == NOTE_GAP


def test_a_long_note_grows_to_hold_its_text() -> None:
    config = _convert(_noted([_note(text="A longer note. " * 60, near=["shops"])]))
    step, note = config["nodes"]
    assert note["data"]["height"] > NOTE_HEIGHT
    assert note["data"]["width"] == NOTE_WIDTH
    assert not _overlap(step, note)


def test_the_viewport_shows_the_notes_too() -> None:
    draft = _noted([_note("tail", near=["save"]), _note("whole")], **_COLUMNS)
    config = _convert(draft)
    view = config["viewport"]
    for node in config["nodes"]:
        left, top, right, bottom = _box(node)
        assert left * view["zoom"] + view["x"] >= 0
        assert top * view["zoom"] + view["y"] >= 0
        assert right * view["zoom"] + view["x"] <= CANVAS_WIDTH
        assert bottom * view["zoom"] + view["y"] <= CANVAS_HEIGHT
