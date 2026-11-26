"""The facts an issue's message names, carried as `params` for clients that word
the message in another language (the style panel does, by code and case)."""

from dataclasses import replace
from typing import Any

from goatlib.style.catalog import palettes
from goatlib.style.compute import Breaks, apply_computed
from goatlib.style.validate import validate

V = {"version": "1.0.0", "kind": "vector"}


def params(doc: dict[str, Any], ctx: Any, code: str) -> list[Any]:
    return [i.params for i in validate(doc, ctx) if i.code == code]


def classify(**c: Any) -> dict[str, Any]:
    return {**V, "classify": [{"field": "population", **c}]}


def test_a_field_the_data_does_not_have_names_it(contexts: dict) -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": {"field": "gone", "palette": "d3:viridis"}}},
    }
    assert params(doc, contexts["districts"], "unknown_field") == [{"field": "gone"}]
    # A stored style a data change broke keeps them on its damaged issue.
    [damaged] = [
        i
        for i in validate(doc, contexts["districts"], stored=True)
        if i.code == "unknown_field"
    ]
    assert (damaged.level, damaged.params) == ("damaged", {"field": "gone"})


def test_too_many_classes_and_categories_name_the_number_and_the_limit(
    contexts: dict,
) -> None:
    ctx = contexts["districts"]
    assert params(classify(method="quantile", count=8), ctx, "too_many_classes") == [
        {"classes": 8, "limit": 7}
    ]
    doc = {**V, "classify": [{"field": "name", "method": "categories", "count": 13}]}
    assert params(doc, ctx, "too_many_categories") == [{"categories": 13, "limit": 12}]


def test_a_palette_of_the_other_kind_names_the_palette_and_the_case(
    contexts: dict,
) -> None:
    ctx = contexts["districts"]
    doc = {
        **V,
        "classify": [
            {"field": "name", "method": "categories", "palette": "d3:viridis"}
        ],
    }
    assert params(doc, ctx, "palette_kind_mismatch") == [
        {"case": "ordered", "palette": palettes()["d3:viridis"].name}
    ]
    doc = classify(method="quantile", count=5, palette="colorbrewer:Dark2")
    assert params(doc, ctx, "palette_kind_mismatch") == [
        {"case": "qualitative", "palette": "Dark2"}
    ]


def test_an_inline_palette_too_short_names_both_numbers(contexts: dict) -> None:
    doc = classify(method="quantile", count=5, palette=["#000000", "#ffffff"])
    assert params(doc, contexts["districts"], "palette_too_short") == [
        {"classes": 5, "colors": 2}
    ]


def test_a_domain_that_misses_the_data_names_the_data_range(contexts: dict) -> None:
    color = {"field": "population", "palette": "d3:viridis", "domain": [0, 10]}
    doc = {**V, "symbol": {"fill": {"color": color}}}
    assert params(doc, contexts["districts"], "domain_outside_data") == [
        {"min": 3440, "max": 25580}
    ]


def test_clusters_over_the_limit_name_the_limit_and_the_features(
    contexts: dict,
) -> None:
    ctx = replace(contexts["schools"], feature_count=100_001)
    assert params(
        {**V, "render": {"type": "cluster"}}, ctx, "too_many_features_for_render"
    ) == [{"limit": ctx.cluster_feature_limit, "features": 100_001}]


def test_categories_no_feature_or_cell_has_list_the_values(contexts: dict) -> None:
    classes = [{"values": ["Atlantis", "Altstadt", "Lemuria"]}]
    doc = {
        **V,
        "classify": [{"field": "name", "method": "categories", "classes": classes}],
    }
    assert params(doc, contexts["districts"], "unknown_category") == [
        {"values": ["Atlantis", "Lemuria"], "count": 2}
    ]
    render = {
        "type": "categorical",
        "classes": [{"value": v, "color": "#000000"} for v in (1, 2, 3, 4, 5, 6, 9)],
    }
    doc = {"version": "1.0.0", "kind": "raster", "render": render}
    assert params(doc, contexts["landcover"], "unknown_category") == [
        {"case": "cell", "values": [9], "count": 1}
    ]


def test_raster_values_without_a_class_are_listed(contexts: dict) -> None:
    render = {"type": "categorical", "classes": [{"value": 1, "color": "#000000"}]}
    doc = {"version": "1.0.0", "kind": "raster", "render": render}
    assert params(doc, contexts["landcover"], "unclassified_values") == [
        {"values": [2, 3, 4, 5, 6]}
    ]


def test_a_field_or_band_without_values_says_which() -> None:
    doc = classify(method="quantile", count=5)
    _, notes = apply_computed(
        doc,
        {("breaks", "population", "quantile", "5"): Breaks((), None, None, False)},
        geometry="polygon",
        fingerprint="f",
        at="t",
    )
    assert [(n.code, n.params) for n in notes] == [
        ("no_values", {"field": "population"})
    ]
    raster = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "continuous", "palette": "goat:elevation"},
    }
    _, notes = apply_computed(
        raster, {("range", "b1"): (None, None)}, geometry=None, fingerprint="f", at="t"
    )
    assert [(n.code, n.params) for n in notes] == [("no_values", {"case": "band"})]


def test_a_blend_that_draws_nothing_names_why(contexts: dict) -> None:
    doc = {**V, "blend": "multiply", "render": {"type": "heatmap"}}
    assert params(doc, contexts["schools"], "blend_not_drawn") == [
        {"reason": "heatmap"}
    ]
    raster = {
        "version": "1.0.0",
        "kind": "raster",
        "blend": "screen",
        "render": {"type": "hillshade"},
    }
    assert params(raster, contexts["elevation"], "blend_not_drawn") == [
        {"reason": "hillshade"}
    ]


def test_a_blend_on_an_image_or_a_map_service_is_valid_and_not_reported(
    contexts: dict,
) -> None:
    for target in ("wms", "tiles", "satellite"):
        for render in ({}, {"render": {"type": "image"}}):
            doc = {"version": "1.0.0", "kind": "raster", "blend": "multiply", **render}
            issues = validate(doc, contexts[target])
            assert [(i.code, i.level) for i in issues] == [], (target, issues)


def test_a_blend_on_an_image_of_a_file_with_a_color_table_is_not_reported(
    contexts: dict,
) -> None:
    # The image may draw the file's color table and then not mix (spec 4.7); the
    # check does not report it, also where the context knows the file has a table.
    assert contexts["landcover"].color_table is True
    for render in ({}, {"render": {"type": "image"}}):
        doc = {"version": "1.0.0", "kind": "raster", "blend": "multiply", **render}
        issues = validate(doc, contexts["landcover"])
        assert [(i.code, i.level) for i in issues] == [], issues
