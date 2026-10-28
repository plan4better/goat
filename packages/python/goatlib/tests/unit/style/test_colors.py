import pytest
from goatlib.style.catalog import palette_colors
from goatlib.style.colors import (
    DEFAULT_CLASSIFY_PALETTE,
    default_range,
    hex_to_rgb,
    parse_color,
    range_values,
    rgb_to_hex,
    sample_colors,
)


def test_colorbrewer_counts_use_the_exact_scheme() -> None:
    assert sample_colors("colorbrewer:OrRd", 5) == [
        "#fef0d9",
        "#fdcc8a",
        "#fc8d59",
        "#e34a33",
        "#b30000",
    ]


def test_lab_blend_and_single_class() -> None:
    assert sample_colors(["#000000", "#ffffff"], 3) == ["#000000", "#777777", "#ffffff"]
    assert sample_colors(["#000000", "#ffffff"], 1) == ["#777777"]
    assert sample_colors(["#000000", "#ffffff"], 2, reverse=True) == [
        "#ffffff",
        "#000000",
    ]
    assert sample_colors(["#000000", "#ffffff"], 0) == []


def test_more_classes_than_stops_blend_between_the_nearest_two() -> None:
    colors = sample_colors(["#ff0000", "#00ff00", "#0000ff"], 5)
    assert colors[0] == "#ff0000" and colors[2] == "#00ff00" and colors[4] == "#0000ff"
    assert len(set(colors)) == 5


def test_qualitative_palettes_repeat_in_order() -> None:
    set2 = palette_colors("colorbrewer:Set2")
    nine = sample_colors("colorbrewer:Set2", 9)
    assert nine[: len(set2)] == set2[:9] and nine[8] == set2[8 % len(set2)]
    assert sample_colors(["#111111", "#222222"], 3, kind="qualitative") == [
        "#111111",
        "#222222",
        "#111111",
    ]


def test_ranges_round_like_the_spec() -> None:
    assert range_values(0.5, 4, 4) == [0.5, 1.7, 2.8, 4.0]
    assert range_values(0.2, 1, 3, opacity=True) == [0.2, 0.6, 1.0]
    assert range_values(0.2, 1, 4, opacity=True) == [0.2, 0.47, 0.73, 1.0]
    assert range_values(3, 9, 1) == [3]


def test_color_parsing_lives_in_one_place() -> None:
    assert parse_color([230, 85, 13]) == "#e6550d"
    assert parse_color("red") is None and parse_color("#ABCDEF") == "#abcdef"
    assert parse_color("#abcdef80") == "#abcdef80"
    assert parse_color("#-12345") is None and parse_color("#12_456") is None
    assert parse_color([300, 0, 0]) is None and parse_color([True, 0, 0]) is None
    assert (
        hex_to_rgb("#9e0142") == [158, 1, 66] and rgb_to_hex([158, 1, 66]) == "#9e0142"
    )


def test_classification_defaults() -> None:
    assert DEFAULT_CLASSIFY_PALETTE == {
        "numeric": "goat:green",
        "categories": "colorbrewer:Set2",
    }
    assert default_range("marker.size") == (4, 24)
    assert default_range("label.size") == (10, 18)
    assert default_range("line.width") == (0.5, 6)
    assert default_range("fill.opacity") == (0.2, 1)
    assert default_range("label.max_width") == (60, 240)
    with pytest.raises(KeyError):
        default_range("fill.color")
