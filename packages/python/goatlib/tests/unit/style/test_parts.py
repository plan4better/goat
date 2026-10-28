from goatlib.style.models.parts import (
    PER_LAYER_KEYS,
    Arrows,
    Fill,
    Label,
    Line,
    Marker,
    Outline,
    Symbol,
)

from .conftest import codes


def test_by_attribute_is_not_allowed_on_dash() -> None:
    assert codes(Outline, {"dash": {"field": "status", "palette": "d3:viridis"}}) == [
        "value_form_not_allowed"
    ]


def test_choices_by_zoom_need_step() -> None:
    icons = {"zoom": [[10, "goat:circle-solid"], [14, "goat:star-solid"]]}
    assert codes(Marker, {"icon": icons}) == ["zoom_needs_step"]
    assert codes(Marker, {"icon": {**icons, "interpolate": "step"}}) == []


def test_zoom_stops_inside_an_attribute_mapping_are_refused() -> None:
    nested = {
        "field": "density",
        "palette": {"zoom": [[1, "d3:viridis"], [2, "d3:magma"]]},
    }
    assert codes(Fill, {"color": nested}) == ["zoom_nesting"]


def test_attribute_values_inside_zoom_stops_are_allowed() -> None:
    size = {
        "zoom": [
            [11, {"field": "pupils", "range": [3, 10], "scale": "sqrt"}],
            [16, {"field": "pupils", "range": [6, 20], "scale": "sqrt"}],
        ]
    }
    assert codes(Marker, {"shape": "circle", "size": size}) == []


def test_icons_are_lib_or_asset_refs() -> None:
    assert codes(Marker, {"shape": "icon", "icon": "https://x.org/a.svg"}) == [
        "invalid_value"
    ]
    assert codes(Marker, {"shape": "icon", "icon": "asset:7f3a"}) == []


def test_markers_are_shapes_pins_or_icons_alone() -> None:
    for shape in (
        "circle",
        "square",
        "diamond",
        "hexagon",
        "shield",
        "pin",
        "round_pin",
        "needle",
        "square_pin",
        "tag_pin",
        "flag",
        "icon",
    ):
        assert codes(Marker, {"shape": shape}) == []
    assert codes(Marker, {"shape": "triangle"}) != []


def test_patterns_are_lines_a_grid_or_dots() -> None:
    for pattern in (
        "none",
        "hatch_45",
        "hatch_135",
        "vertical",
        "horizontal",
        "cross",
        "grid",
        "dots",
    ):
        assert codes(Fill, {"pattern": pattern, "pattern_color": "#cb181d"}) == []
    assert codes(Fill, {"pattern": "zigzag"}) == ["unknown_pattern"]


def test_pattern_spacing_and_thickness_switch_by_zoom_and_take_classes() -> None:
    assert (
        codes(
            Fill, {"pattern": "vertical", "pattern_spacing": 12, "pattern_width": 1.5}
        )
        == []
    )
    stepped = {"zoom": [[10, 6], [14, 12]], "interpolate": "step"}
    assert codes(Fill, {"pattern_spacing": stepped, "pattern_width": stepped}) == []
    # Each value is its own image: a continuous mapping by attribute is not one of their forms.
    by_field = {"field": "area", "range": [1, 4]}
    assert codes(Fill, {"pattern_width": by_field}) == ["value_form_not_allowed"]


def test_label_offset_is_xy_and_lines_are_objects() -> None:
    assert codes(Label, {"text": "{name}", "offset": [0, -8]}) == []
    lines = [{"font": {"weight": "bold"}}, {"size": 10, "color": "#6b7280"}]
    assert (
        codes(
            Label,
            {
                "text": "{name}\n{area_km2} km²",
                "lines": lines,
                "priority": {"field": "area_km2", "top": "largest"},
            },
        )
        == []
    )
    assert codes(
        Label, {"text": "{name}", "priority": {"field": "a", "top": "biggest"}}
    ) == ["invalid_value"]


def test_outline_color_may_follow_the_fill() -> None:
    assert codes(Outline, {"color": "fill"}) == []
    assert codes(Outline, {"color": "blue"}) == ["invalid_value"]


def test_parts_switch_off_with_false_without_extra_issues() -> None:
    assert codes(Symbol, {"fill": False, "outline": {"width": 2}}) == []
    assert codes(Symbol, {"fill": {"color": 5}}) == ["invalid_value"]


def test_per_layer_keys_match_the_spec() -> None:
    assert PER_LAYER_KEYS == frozenset(
        {
            "marker.allow_overlap",
            "arrows.placement",
            "arrows.direction",
            "arrows.spacing",
            "label.placement",
            "label.lines",
            "label.priority",
            "label.allow_overlap",
            "label.format",
            "label.formats",
        }
    )


def test_markers_take_the_nine_anchors() -> None:
    assert codes(Marker, {"anchor": "top_left"}) == []
    assert codes(Marker, {"anchor": "top-left"}) == ["invalid_value"]


def test_a_marker_without_fill_is_hollow() -> None:
    assert codes(Marker, {"shape": "diamond", "fill": False}) == []
    assert codes(Marker, {"fill": True}) == []
    # A fixed switch only: not by zoom, not by attribute.
    assert codes(Marker, {"fill": {"zoom": [[10, True], [14, False]]}}) != []
    assert codes(Marker, {"fill": {"field": "open"}}) != []
    assert "marker.fill" not in PER_LAYER_KEYS


def test_a_line_offset_may_be_negative() -> None:
    assert codes(Line, {"offset": -3}) == []
    assert codes(Line, {"offset": {"zoom": [[10, -2], [14, 4]]}}) == []


def test_arrow_spacing_is_at_least_one_px() -> None:
    assert codes(Arrows, {"spacing": 1}) == []
    assert codes(Arrows, {"spacing": 0}) == ["invalid_value"]
    assert codes(Arrows, {"spacing": {"zoom": [[10, 0], [14, 80]]}}) == [
        "invalid_value"
    ]
