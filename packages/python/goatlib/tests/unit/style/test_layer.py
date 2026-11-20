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
    assert codes_of(parse_for_write({"version": "2.0.0", "kind": "vector"})) == [
        "newer_version"
    ]
    assert codes_of(parse_for_write({"version": 2, "kind": "vector"})) == [
        "unknown_version"
    ]
    assert codes_of(parse_for_write({"version": "1", "kind": "vector"})) == [
        "unknown_version"
    ]
    assert codes_of(parse_for_write({"kind": "vector"})) == ["missing_required"]


def test_kind_is_vector_or_raster() -> None:
    assert codes_of(parse_for_write({"version": "1.0.0", "kind": "tiles"})) == [
        "invalid_value"
    ]


def test_service_style_belongs_to_image_render() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "image", "service_style": "grey"},
    }
    assert codes_of(parse_for_write(doc)) == []


def test_raster_palette_and_stops_are_exclusive_and_stops_ascend() -> None:
    stops = [{"value": 10, "color": "#000000"}, {"value": 5, "color": "#ffffff"}]
    doc = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "continuous", "stops": stops},
    }
    assert codes_of(parse_for_write(doc)) == ["stops_order"]
    both = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {
            "type": "continuous",
            "palette": "goat:elevation",
            "stops": stops[:1],
        },
    }
    assert codes_of(parse_for_write(both)) == ["invalid_value"]


def test_h3_resolution_is_auto_or_5_to_10() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "render": {"type": "h3", "resolution": 11},
    }
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]


def test_unknown_render_type() -> None:
    assert codes_of(
        parse_for_write(
            {"version": "1.0.0", "kind": "vector", "render": {"type": "dots"}}
        )
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
        parse_for_write({"version": "1.0.0", "kind": "vector", "classify": [c] * 51})
    )
    rule = {"when": {"op": "isNull", "args": [{"property": "a"}]}, "visible": False}
    assert "invalid_value" in codes_of(
        parse_for_write({"version": "1.0.0", "kind": "vector", "rules": [rule] * 201})
    )
    assert (
        codes_of(
            parse_for_write(
                {
                    "version": "1.0.0",
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
    doc = {"version": "1.0.0", "kind": "vector", "render": render}
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]


@pytest.mark.parametrize(
    "render",
    [
        {"type": "hillshade", "direction": 360},
        {"type": "hillshade", "exaggeration": 1.5},
    ],
)
def test_hillshade_direction_and_exaggeration_take_maplibres_maximums(
    render: dict,
) -> None:
    doc = {"version": "1.0.0", "kind": "raster", "render": render}
    assert codes_of(parse_for_write(doc)) == ["invalid_value"]


@pytest.mark.parametrize("classes", ["all", "filter", "view"])
def test_legend_classes_shown_takes_all_filter_or_view(classes: str) -> None:
    doc = {"version": "1.0.0", "kind": "vector", "legend": {"classes": classes}}
    assert codes_of(parse_for_write(doc)) == []


def _issues_at(doc: dict, path: str) -> list[str]:
    return [i.code for i in parse_for_write(doc)[1] if i.path == path]


@pytest.mark.parametrize("classes", ["visible", "", "View", True, ["filter"]])
def test_legend_classes_shown_refuses_other_values(classes: object) -> None:
    doc = {"version": "1.0.0", "kind": "vector", "legend": {"classes": classes}}
    assert _issues_at(doc, "/legend/classes") == ["invalid_value"]


def test_legend_classes_shown_is_for_vector_layers() -> None:
    doc = {"version": "1.0.0", "kind": "raster", "legend": {"classes": "view"}}
    assert _issues_at(doc, "/legend/classes") == ["unknown_key"]


def test_legend_classes_shown_defaults_to_filter() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["legend.classes"] == "filter"


@pytest.mark.parametrize(
    "render",
    [
        {"type": "cluster", "look": "circle", "count": "center"},
        {"type": "cluster", "look": "points", "count": "badge"},
        {"type": "cluster", "look": "points", "count": "center"},
        {"type": "cluster", "look": "circle", "count": "badge"},
    ],
)
def test_clusters_are_drawn_as_circles_or_like_the_points(render: dict) -> None:
    doc = {"version": "1.0.0", "kind": "vector", "render": render}
    assert codes_of(parse_for_write(doc)) == []


@pytest.mark.parametrize(
    ("key", "value"),
    [("look", "icons"), ("look", ""), ("count", "corner"), ("count", True)],
)
def test_cluster_look_and_count_refuse_other_values(key: str, value: object) -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "render": {"type": "cluster", key: value},
    }
    assert _issues_at(doc, f"/render/{key}") == ["invalid_value"]


def test_cluster_look_and_count_belong_to_clusters() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "render": {"type": "heatmap", "look": "points"},
    }
    assert _issues_at(doc, "/render/look") == ["unknown_key"]


def test_clusters_default_to_a_circle_with_the_count_in_the_middle() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["cluster.look"] == "circle"
    assert REFERENCE_DEFAULTS["cluster.count"] == "center"


@pytest.mark.parametrize("op", ["count", "sum", "mean", "min", "max"])
def test_a_cluster_value_is_the_count_or_an_aggregate_of_a_field(op: str) -> None:
    value = {"op": op} if op == "count" else {"op": op, "field": "pupils"}
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "render": {"type": "cluster", "value": value},
    }
    assert codes_of(parse_for_write(doc)) == []


def test_a_cluster_aggregate_needs_a_field_and_a_known_op() -> None:
    def at(value: dict) -> list[str]:
        doc = {
            "version": "1.0.0",
            "kind": "vector",
            "render": {"type": "cluster", "value": value},
        }
        return [i.code for i in parse_for_write(doc)[1]]

    assert at({"op": "sum"}) == ["missing_required"]
    assert at({"op": "median", "field": "pupils"}) == ["invalid_value"]


def test_a_cluster_value_defaults_to_the_count() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["cluster.value"] == {"op": "count"}
