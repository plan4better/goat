from goatlib.style.models.values import (
    ByAttributeColor,
    ByAttributeNumber,
    NumberFormat,
    ZoomStops,
)
from goatlib.style.parse import parse

from .conftest import codes


def test_zoom_stops_must_ascend_and_have_two_entries() -> None:
    assert codes(ZoomStops, {"zoom": [[10, 1], [14, 3]]}) == []
    assert codes(ZoomStops, {"zoom": [[14, 1], [10, 3]]}) == ["zoom_stops"]
    assert codes(ZoomStops, {"zoom": [[14, 1]]}) == ["zoom_stops"]


def test_exponential_base_defaults_to_1_6() -> None:
    m, _ = parse(ZoomStops, {"zoom": [[10, 1], [14, 3]], "interpolate": "exponential"})
    assert m.base == 1.6


def test_inline_palette_takes_2_to_12_hex_colors() -> None:
    ok = {"field": "density", "palette": ["#fef0d9", "#b30000"]}
    assert codes(ByAttributeColor, ok) == []
    assert codes(ByAttributeColor, {**ok, "palette": ["#fef0d9"] * 13}) == [
        "invalid_value"
    ]
    assert codes(ByAttributeColor, {**ok, "palette": ["red", "#b30000"]}) == [
        "invalid_value"
    ]


def test_range_and_domain_from_high_to_low_are_reported() -> None:
    assert codes(ByAttributeNumber, {"field": "pupils", "range": [20, 4]}) == [
        "range_invalid"
    ]
    assert codes(
        ByAttributeNumber, {"field": "pupils", "range": [4, 20], "domain": [900, 10]}
    ) == ["domain_invalid"]


def test_format_decimals_auto_or_0_to_10() -> None:
    assert codes(NumberFormat, {"decimals": "auto"}) == []
    assert codes(NumberFormat, {"decimals": 11}) == ["invalid_value"]


def test_zoom_inside_an_attribute_mapping_is_zoom_nesting() -> None:
    assert codes(
        ByAttributeNumber,
        {"field": "pupils", "range": {"zoom": [[1, [1, 2]], [2, [2, 3]]]}},
    ) == ["zoom_nesting"]


def test_log_scale_needs_a_domain_above_zero() -> None:
    assert codes(
        ByAttributeNumber,
        {"field": "traffic", "range": [1, 8], "scale": "log", "domain": [0, 100]},
    ) == ["domain_invalid"]
    assert (
        codes(
            ByAttributeNumber,
            {"field": "traffic", "range": [1, 8], "scale": "log", "domain": [1, 100]},
        )
        == []
    )


def test_colors_by_attribute_take_a_scale_and_log_needs_a_domain_above_zero() -> None:
    form = {"field": "density", "palette": "goat:green", "scale": "sqrt"}
    assert codes(ByAttributeColor, form) == []
    assert codes(ByAttributeColor, {**form, "scale": "cubic"}) == ["invalid_value"]
    assert codes(ByAttributeColor, {**form, "scale": "log", "domain": [0, 100]}) == [
        "domain_invalid"
    ]


def test_json_types_are_strict() -> None:
    from goatlib.style.models.parts import Fill, Marker, Outline

    assert codes(Fill, {"opacity": "0.5"}) == ["invalid_value"]
    assert codes(Outline, {"width": True}) == ["invalid_value"]
    assert codes(
        ByAttributeColor, {"field": "x", "palette": "d3:viridis", "reverse": "yes"}
    ) == ["invalid_value"]
    assert codes(Marker, {"allow_overlap": 1}) == ["invalid_value"]
    assert codes(Fill, {"opacity": float("nan")}) == ["invalid_value"]
    assert codes(Marker, {"size": float("inf")}) == ["invalid_value"]
    assert codes(ZoomStops, {"zoom": [["10", 1], ["14", 3]]}) != []
