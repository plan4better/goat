import json

import pytest
from goatlib.style.parse import parse_for_write

from .conftest import codes_of, load_examples

STRUCTURE = {"unknown_key", "missing_required", "invalid_value"}


def test_parse_for_write_never_changes_the_document(spec_examples: list) -> None:
    doc = next(
        e["doc"]
        for e in spec_examples
        if e["target"] == "districts" and not e["expect"]
    )
    before = json.dumps(doc)
    parse_for_write(doc)
    assert json.dumps(doc) == before


def test_versions() -> None:
    assert codes_of(parse_for_write({"version": 2, "kind": "vector"})) == [
        "newer_version"
    ]
    assert codes_of(parse_for_write({"version": "1", "kind": "vector"})) == [
        "unknown_version"
    ]
    assert codes_of(parse_for_write({"kind": "vector"})) == ["missing_required"]


def test_kind_is_vector_or_raster() -> None:
    assert codes_of(parse_for_write({"version": 1, "kind": "tiles"})) == [
        "invalid_value"
    ]


def test_service_style_belongs_to_image_render() -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "image", "service_style": "grey"},
    }
    assert codes_of(parse_for_write(doc)) == []


def test_raster_palette_and_stops_are_exclusive_and_stops_ascend() -> None:
    stops = [{"value": 10, "color": "#000000"}, {"value": 5, "color": "#ffffff"}]
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "continuous", "stops": stops},
    }
    assert codes_of(parse_for_write(doc)) == ["stops_order"]
    both = {
        "version": 1,
        "kind": "raster",
        "render": {
            "type": "continuous",
            "palette": "goat:elevation",
            "stops": stops[:1],
        },
    }
    assert codes_of(parse_for_write(both)) == ["invalid_value"]


def test_h3_resolution_is_auto_or_5_to_10() -> None:
    doc = {"version": 1, "kind": "vector", "render": {"type": "h3", "resolution": 11}}
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]


def test_unknown_render_type() -> None:
    assert codes_of(
        parse_for_write({"version": 1, "kind": "vector", "render": {"type": "dots"}})
    ) == ["invalid_value"]


DATASET_EXAMPLES = [
    e for e in load_examples() if e["target"] not in ("map", "maplibre")
]


@pytest.mark.parametrize(
    "ex", DATASET_EXAMPLES, ids=lambda e: f"line{e['line']}-{e['target']}"
)
def test_spec_examples_have_valid_structure(ex: dict) -> None:
    got = set(codes_of(parse_for_write(ex["doc"])))
    assert not (got & STRUCTURE) or set(ex["expect"]) & STRUCTURE


def test_list_sizes_are_capped() -> None:
    c = {"field": "a", "method": "categories"}
    assert "invalid_value" in codes_of(
        parse_for_write({"version": 1, "kind": "vector", "classify": [c] * 51})
    )
    rule = {"when": {"op": "isNull", "args": [{"property": "a"}]}, "visible": False}
    assert "invalid_value" in codes_of(
        parse_for_write({"version": 1, "kind": "vector", "rules": [rule] * 201})
    )
    assert (
        codes_of(
            parse_for_write(
                {
                    "version": 1,
                    "kind": "vector",
                    "classify": [c] * 50,
                    "rules": [rule] * 200,
                }
            )
        )
        == []
    )


@pytest.mark.parametrize(
    "render",
    [
        {"type": "heatmap", "radius": 0},
        {"type": "heatmap", "radius": {"zoom": [[10, 0], [14, 20]]}},
        {"type": "heatmap", "weight": -1},
    ],
)
def test_heatmap_radius_and_weight_take_maplibres_minimums(render: dict) -> None:
    doc = {"version": 1, "kind": "vector", "render": render}
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]


@pytest.mark.parametrize(
    "render",
    [
        {"type": "terrain", "direction": 360},
        {"type": "terrain", "exaggeration": 1.5},
    ],
)
def test_terrain_direction_and_exaggeration_take_maplibres_maximums(
    render: dict,
) -> None:
    doc = {"version": 1, "kind": "raster", "render": render}
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]
