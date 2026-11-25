import copy
from collections.abc import Iterator
from typing import Any

import pytest
from goatlib.style.summary import summarize

from .conftest import load_examples

V = {"version": "1.0.0", "kind": "vector"}
R = {"version": "1.0.0", "kind": "raster"}


def test_a_fixed_fill() -> None:
    doc = {**V, "symbol": {"fill": {"color": "#aaaaaa"}, "outline": {"width": 1}}}
    assert summarize(doc) == "fill #aaaaaa"


def test_a_classification_with_labels() -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}, "label": {"text": "{name}"}},
        "classify": [
            {
                "field": "density",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:Blues",
            }
        ],
    }
    assert (
        summarize(doc)
        == "fill by density, quantile, 5 classes, colorbrewer:Blues; labels name"
    )


def test_categories_with_the_rest() -> None:
    doc = {
        **V,
        "symbol": {"marker": {"shape": "circle", "color": "#9aa3ad"}},
        "classify": [
            {
                "field": "category",
                "method": "categories",
                "classes": [
                    {"values": [v], "marker": {"color": "#111111"}}
                    for v in ("a", "b", "c", "d", "e")
                ],
                "other": {"name": "Other", "marker": {"color": "#9aa3ad"}},
            }
        ],
    }
    assert summarize(doc) == "marker by category, 5 categories, rest grouped"


def test_a_smooth_ramp() -> None:
    doc = {
        **V,
        "symbol": {
            "line": {
                "color": {
                    "field": "frequency_per_hour",
                    "palette": "colorbrewer:YlOrRd",
                },
                "width": 3,
            }
        },
    }
    assert summarize(doc) == "line by frequency_per_hour, smooth, colorbrewer:YlOrRd"


def test_heatmap_clusters_hexagons() -> None:
    marker = {"marker": {"shape": "circle", "color": "#283593", "size": 8}}
    heatmap = {**V, "render": {"type": "heatmap", "palette": "d3:magma"}}
    clusters = {**V, "render": {"type": "cluster", "radius": 50}}
    hexagons = {**V, "render": {"type": "h3", "value": {"op": "count"}}}
    assert summarize({**heatmap, "symbol": marker}) == "heatmap"
    assert summarize({**clusters, "symbol": marker}) == "clusters"
    assert summarize({**hexagons, "symbol": marker}) == "hexagons"


def test_heights_and_rules() -> None:
    doc = {
        **V,
        "symbol": {
            "fill": {"color": "#d9d9d9"},
            "extrude": {"height": {"field": "floors", "range": [0, 300]}},
        },
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "name"}]},
                "visible": False,
            },
            {"when": {"op": "isNull", "args": [{"property": "x"}]}, "visible": False},
        ],
    }
    assert summarize(doc).endswith("height by floors; 2 rules")
    assert summarize(doc) == "fill #d9d9d9; height by floors; 2 rules"


def test_rasters() -> None:
    image = {**R, "render": {"type": "image", "bands": [1, 2, 3]}}
    ramp = {
        **R,
        "render": {"type": "continuous", "band": 1, "palette": "colorbrewer:Greens"},
    }
    shade = {**R, "render": {"type": "hillshade", "method": "standard"}}
    assert summarize(image) == "image"
    assert summarize(ramp) == "color range band 1, colorbrewer:Greens"
    assert summarize(shade) == "hillshade"


def test_every_spec_example_gets_a_summary() -> None:
    for ex in load_examples():
        doc = ex["doc"]
        got = summarize(doc)
        assert isinstance(got, str), ex["line"]
        assert len(got) <= 200, ex["line"]
        if isinstance(doc, dict) and ("symbol" in doc or "render" in doc):
            assert got, ex["line"]


def test_a_damaged_document_does_not_raise() -> None:
    assert summarize({}) == ""
    assert summarize({"symbol": 3}) == ""


# The cases below pin the wording of the less common shapes.


def test_singular_counts() -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [{"field": "a", "method": "manual", "classes": [{"fill": {}}]}],
        "rules": [{"when": {"op": "isNull", "args": [{"property": "a"}]}}],
    }
    assert summarize(doc) == "fill by a, manual, 1 class; 1 rule"
    doc["classify"] = [
        {"field": "a", "method": "categories", "classes": [{"values": ["x"]}]}
    ]
    assert summarize(doc) == "fill by a, 1 category; 1 rule"


def test_classes_count_from_the_list_else_from_count() -> None:
    computed = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "density",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:OrRd",
                "classes": [{"to": 1}, {"from": 1, "to": 2}, {"from": 2}],
            }
        ],
    }
    assert (
        summarize(computed) == "fill by density, quantile, 3 classes, colorbrewer:OrRd"
    )
    intent = {
        **V,
        "symbol": {"marker": {}},
        "classify": [{"field": "type", "method": "categories", "count": 8}],
    }
    assert summarize(intent) == "marker by type, 8 categories"


def test_custom_and_reversed_palettes() -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "population",
                "method": "heads_and_tails",
                "count": 3,
                "palette": ["#fee8c8", "#fdbb84", "#e34a33"],
            }
        ],
    }
    assert (
        summarize(doc)
        == "fill by population, heads_and_tails, 3 classes, custom colors"
    )
    doc["classify"][0]["palette"] = "colorbrewer:RdBu"
    doc["classify"][0]["reverse"] = True
    assert summarize(doc) == (
        "fill by population, heads_and_tails, 3 classes, colorbrewer:RdBu reversed"
    )


def test_the_last_classification_on_the_main_color_wins() -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "density",
                "method": "manual",
                "classes": [{"to": 1}, {"from": 1}],
            },
            {
                "field": "land_use",
                "method": "categories",
                "target": "fill.color",
                "classes": [{"values": ["green"]}],
                "other": {},
            },
        ],
    }
    assert summarize(doc) == "fill by land_use, 1 category, rest grouped"


def test_a_classification_that_covers_every_feature_wins_over_a_later_partial_one() -> (
    None
):
    doc = {
        **V,
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "density",
                "method": "manual",
                "classes": [
                    {"to": 1, "fill": {"color": "#fdcc8a"}},
                    {"from": 1, "fill": {"color": "#e34a33"}},
                ],
            },
            {
                "field": "land_use",
                "method": "categories",
                "classes": [{"values": ["green"], "fill": {"color": "#66c2a5"}}],
            },
        ],
    }
    assert summarize(doc) == "fill by density, manual, 2 classes"


def test_a_classification_without_target_that_leaves_the_main_color_alone() -> None:
    doc = {
        **V,
        "symbol": {
            "line": {"color": "#2166ac", "width": 3},
            "casing": {"color": "#ffffff"},
        },
        "classify": [
            {
                "field": "status",
                "method": "categories",
                "classes": [
                    {"values": ["existing"], "name": "Existing", "legend": False},
                    {
                        "values": ["planned"],
                        "min_zoom": 13,
                        "line": {"dash": "dashed", "opacity": 0.6, "min_zoom": 12},
                        "casing": False,
                    },
                ],
            }
        ],
    }
    assert (
        summarize(doc)
        == "line #2166ac; visibility, line dash, line opacity, casing by status"
    )
    doc["classify"][0]["classes"] = [{"values": ["green"], "extrude": False}]
    assert summarize(doc) == "line #2166ac; height by status"
    doc["classify"][0]["classes"] = [{"values": ["green"], "visible": False}]
    assert summarize(doc) == "line #2166ac; visibility by status"
    doc["classify"][0]["classes"] = [{"values": ["green"], "name": "Green"}]
    assert summarize(doc) == "line by status, 1 category"
    many = {"dash": "dashed", "opacity": 0.5, "width": 2, "blur": 1, "offset": 2}
    doc["classify"][0]["classes"] = [{"values": ["green"], "line": many}]
    assert summarize(doc) == (
        "line #2166ac; line dash, line opacity, line width, line blur by status"
    )


def test_classifications_and_value_forms_on_other_properties() -> None:
    doc = {
        **V,
        "symbol": {
            "line": {
                "color": "#2166ac",
                "width": {"field": "traffic", "range": [1, 8]},
                "opacity": {
                    "zoom": [
                        [10, {"field": "age", "range": [0.2, 1]}],
                        [14, {"field": "age", "range": [0.5, 1]}],
                    ]
                },
            },
            "label": {
                "text": "{name}",
                "priority": {"field": "traffic", "top": "largest"},
            },
        },
        "classify": [
            {
                "field": "frequency_per_hour",
                "method": "quantile",
                "count": 4,
                "target": "line.width",
                "range": [1, 6],
            },
            {
                "field": "status",
                "method": "categories",
                "target": "label.halo.color",
                "classes": [],
            },
        ],
    }
    assert summarize(doc) == (
        "line #2166ac; line width by frequency_per_hour; label halo color by status; "
        "line width by traffic; line opacity by age; labels name"
    )


def test_main_color_forms() -> None:
    def look(symbol: dict[str, Any]) -> str:
        return summarize({**V, "symbol": symbol})

    assert (
        look({"line": {"color": {"zoom": [[10, "#9ecae1"], [14, "#2166ac"]]}}})
        == "line by zoom"
    )
    assert (
        look(
            {
                "marker": {
                    "color": {
                        "zoom": [
                            [11, {"field": "pupils", "palette": "d3:viridis"}],
                            [16, {"field": "pupils", "palette": "d3:viridis"}],
                        ]
                    }
                }
            }
        )
        == "marker by pupils, smooth, d3:viridis"
    )
    assert look({"marker": {"shape": "icon", "icon": "goat:building"}}) == "marker"
    assert look({"fill": {"color": {"field": "hex"}}}) == "fill color from hex"
    assert look({"fill": False, "outline": {"color": "#3182bd"}}) == "no fill"


def test_geometry_names_the_main_part() -> None:
    doc = {
        **V,
        "geometry": "point",
        "symbol": {"fill": {"color": "#ffffff"}, "marker": {"color": "#000000"}},
    }
    assert summarize(doc) == "marker #000000"
    assert summarize({**V, "geometry": "line", "symbol": {}}) == "line"


def test_label_fields() -> None:
    def labels(text: Any) -> str:
        return summarize(
            {**V, "symbol": {"fill": {"color": "#ffffff"}, "label": {"text": text}}}
        )

    assert labels("{name}\n{lines} lines") == "fill #ffffff; labels name, lines"
    assert labels("Station") == "fill #ffffff; labels"
    assert (
        labels({"zoom": [[10, "{name}"], [14, "{name} {ref}"]], "interpolate": "step"})
        == "fill #ffffff; labels name, ref"
    )


def test_fixed_and_default_heights() -> None:
    doc = {**V, "symbol": {"fill": {"color": "#fdb462"}, "extrude": {"height": 20}}}
    assert summarize(doc) == "fill #fdb462; height 20 m"
    doc["symbol"]["extrude"] = {}
    assert summarize(doc) == "fill #fdb462; height"
    doc["symbol"]["extrude"] = False
    assert summarize(doc) == "fill #fdb462"
    doc["symbol"]["extrude"] = {"height": 10}
    doc["classify"] = [
        {
            "field": "floors",
            "method": "equal_interval",
            "count": 3,
            "target": "extrude.height",
        }
    ]
    assert summarize(doc) == "fill #fdb462; height by floors"


def test_what_stays_next_to_a_point_render() -> None:
    doc = {
        **V,
        "render": {"type": "heatmap", "points_from_zoom": 15},
        "symbol": {
            "marker": {
                "color": "#3f007d",
                "size": {"field": "visitors", "range": [2, 9]},
            },
            "label": {"text": "{name}"},
        },
        "rules": [{"when": {"op": "isNull", "args": [{"property": "name"}]}}],
    }
    assert summarize(doc) == "heatmap; marker size by visitors; labels name; 1 rule"


def test_raster_forms() -> None:
    def raster(render: Any) -> str:
        return summarize({**R, "render": render})

    assert (
        raster({"type": "continuous", "palette": "goat:elevation"})
        == "color range, goat:elevation"
    )
    assert (
        raster(
            {
                "type": "continuous",
                "band": {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"},
                "palette": "goat:green",
            }
        )
        == "color range band NDVI, goat:green"
    )
    assert (
        raster({"type": "continuous", "stops": [{"value": 1, "color": "#000000"}]})
        == "color range, custom colors"
    )
    assert (
        raster(
            {"type": "continuous", "band": 4, "palette": "d3:viridis", "reverse": True}
        )
        == "color range band 4, d3:viridis reversed"
    )
    assert (
        raster(
            {
                "type": "continuous",
                "band": 2,
                "palette": "goat:elevation",
                "classify": {"method": "quantile", "count": 5},
            }
        )
        == "5 classes band 2"
    )
    assert (
        raster(
            {
                "type": "continuous",
                "classify": {"method": "manual", "classes": [{"to": 1}, {"from": 1}]},
            }
        )
        == "2 classes"
    )
    assert (
        raster({"type": "categorical", "band": 1, "classes": [{"value": 1}]})
        == "categories"
    )
    assert (
        raster(
            {"type": "hillshade", "palette": "goat:elevation", "classify": {"count": 6}}
        )
        == "hillshade"
    )
    assert raster({"type": "image"}) == "image"
    assert summarize(R) == ""


def test_a_long_summary_is_cut_to_200_characters() -> None:
    field = "a_very_long_field_name_" * 6
    doc = {
        **V,
        "symbol": {
            "fill": {"color": "#cccccc"},
            "label": {"text": "{" + field + "1} {" + field + "2}"},
        },
        "classify": [
            {
                "field": field,
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:Blues",
            }
        ],
    }
    got = summarize(doc)
    assert len(got) == 200
    assert got.endswith("...")
    assert got.startswith("fill by a_very_long_field_name_")


def test_whitespace_in_names_is_flattened() -> None:
    doc = {
        **V,
        "symbol": {
            "fill": {"color": "#cccccc"},
            "label": {"text": "{Einwohner\n 2020}"},
        },
    }
    assert summarize(doc) == "fill #cccccc; labels Einwohner 2020"


def _damaged(node: Any) -> Iterator[Any]:
    """Copies of `node` with one nested value replaced by a wrong type at a time."""
    keys = (
        node
        if isinstance(node, dict)
        else range(len(node))
        if isinstance(node, list)
        else []
    )
    for key in keys:
        for bad in (None, 3, "x", [], {}, True):
            copied = copy.copy(node)
            copied[key] = bad
            yield copied
        for inner in _damaged(node[key]):
            copied = copy.copy(node)
            copied[key] = inner
            yield copied


@pytest.mark.parametrize(
    "ex", load_examples(), ids=lambda e: f"line{e['line']}-{e['target']}"
)
def test_no_damaged_spec_example_raises(ex: dict[str, Any]) -> None:
    for doc in _damaged(ex["doc"]):
        got = summarize(doc)
        assert isinstance(got, str) and len(got) <= 200


@pytest.mark.parametrize(
    "doc",
    [
        None,
        3,
        "x",
        [],
        [{}],
        {"kind": 3},
        {"render": "heatmap"},
        {"classify": {"field": "a"}},
    ],
)
def test_anything_that_is_not_a_document_gives_nothing(doc: Any) -> None:
    assert summarize(doc) == ""
