import time

from goatlib.style.models.classify import Classification, ColorClassification

from .conftest import codes

MANUAL = {
    "field": "density",
    "method": "manual",
    "classes": [
        {"id": "c1", "to": 2800},
        {"id": "c2", "from": 2800, "to": 3600},
        {"id": "c3", "from": 3600},
    ],
}


def test_numeric_classes_must_be_sorted_without_gaps_or_overlaps() -> None:
    assert codes(Classification, MANUAL) == []
    gap = {**MANUAL, "classes": [{"id": "c1", "to": 2800}, {"id": "c2", "from": 3000}]}
    assert codes(Classification, gap) == ["classes_invalid"]
    overlap = {
        **MANUAL,
        "classes": [{"to": 15000}, {"from": 10000, "to": 20000}, {"from": 20000}],
    }
    assert codes(Classification, overlap) == ["classes_invalid"]
    backwards = {**MANUAL, "classes": [{"from": 5, "to": 1}]}
    assert codes(Classification, backwards) == ["classes_invalid"]


def test_one_value_in_two_categories_is_a_duplicate() -> None:
    c = {
        "field": "land_use",
        "method": "categories",
        "classes": [{"values": ["green"]}, {"values": ["green", "water"]}],
    }
    assert codes(Classification, c) == ["category_duplicate"]


def test_categories_take_values_and_numeric_classes_take_ranges() -> None:
    assert codes(
        Classification,
        {"field": "type", "method": "categories", "classes": [{"from": 1}]},
    ) == ["invalid_value"]
    assert codes(Classification, {**MANUAL, "classes": [{"values": ["a"]}]}) == [
        "invalid_value"
    ]


def test_class_zooms_are_whole_numbers() -> None:
    c = {
        "field": "type",
        "method": "categories",
        "classes": [{"values": ["a"], "min_zoom": 12.5}],
    }
    assert codes(Classification, c) == ["zoom_not_whole"]


def test_computed_intent_and_server_values_parse() -> None:
    intent = {
        "title": "Inhabitants per km²",
        "field": "density",
        "method": "quantile",
        "count": 5,
        "palette": "colorbrewer:OrRd",
    }
    assert codes(Classification, intent) == []
    stored = {
        **intent,
        "id": "density",
        "classes": [
            {"id": "c1", "to": 2800, "fill": {"color": "#fef0d9"}},
            {"id": "c2", "from": 2800, "fill": {"color": "#b30000"}},
        ],
        "computed": {
            "at": "2026-10-23T10:00:00Z",
            "data": "sample-v1",
            "scope": "dataset",
        },
    }
    assert codes(Classification, stored) == []


def test_raster_and_h3_classes_take_colors() -> None:
    c = {
        "method": "equal_interval",
        "count": 3,
        "classes": [{"to": 1, "color": "#000000"}, {"from": 1, "color": "#ffffff"}],
    }
    assert codes(ColorClassification, c) == []
    assert codes(ColorClassification, {"method": "categories"}) == ["invalid_value"]


def test_five_thousand_classes_parse_quickly() -> None:
    c = {
        "field": "land_use",
        "method": "categories",
        "classes": [{"values": [f"v{n}"]} for n in range(5000)],
    }
    t = time.perf_counter()
    assert codes(Classification, c) == []
    assert time.perf_counter() - t < 2


def test_computed_methods_may_list_classes_by_position_without_bounds() -> None:
    c = {
        "method": "quantile",
        "count": 5,
        "classes": [
            {"name": "Valley floor"},
            {"color": "#2bb381"},
            {},
            {},
            {"visible": False},
        ],
    }
    assert codes(ColorClassification, c) == []
    v = {
        "field": "density",
        "method": "quantile",
        "count": 3,
        "classes": [{"name": "Low"}, {}, {"name": "High"}],
    }
    assert codes(Classification, v) == []
    manual = {"field": "density", "method": "manual", "classes": [{"name": "Low"}, {}]}
    assert codes(Classification, manual) == ["classes_invalid"]


def test_targets_name_real_properties() -> None:
    base = {"field": "type", "method": "categories"}
    assert codes(Classification, {**base, "target": "fill.colr"}) == ["invalid_value"]
    assert codes(Classification, {**base, "target": "label.halo.color"}) == []
    assert codes(Classification, {**base, "target": "outline.dash"}) == []


def test_category_values_are_text_numbers_or_booleans() -> None:
    base = {"field": "type", "method": "categories"}
    assert (
        codes(Classification, {**base, "classes": [{"values": ["a", 1, 2.5, True]}]})
        == []
    )
    assert codes(Classification, {**base, "classes": [{"values": [{"a": 1}]}]}) == [
        "invalid_value"
    ]
    assert codes(Classification, {**base, "classes": [{"values": [None]}]}) == [
        "invalid_value"
    ]
