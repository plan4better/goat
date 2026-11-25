import json
import math
from typing import Any

import pytest
from goatlib.style.catalog import palette_colors
from goatlib.style.colors import (
    DEFAULT_CLASSIFY_PALETTE,
    alpha,
    contrast_ratio,
    default_range,
    halo_against,
    hex_to_rgb,
    is_none,
    label_pair,
    on_color,
    opaque,
    parse_color,
    range_values,
    readable_shade,
    rgb_to_hex,
    sample_colors,
    shade,
)

from .conftest import FIXTURES

#: Palette samples the web's `paletteSteps` must also give (lib/style/__tests__/palettes.test.ts):
#: class colors the server writes and the ones the browser picks before it does agree. Each row's
#: `colors` is `sample_colors(palette, count, kind=, reverse=)`; an intended change of the sampling
#: rewrites the `colors` of every row.
PALETTE_SAMPLES: list[dict[str, Any]] = json.loads(
    (FIXTURES / "palette_samples.json").read_text()
)
#: The color rules derived colors are made of (spec 3.1), which the web's `shade`,
#: `contrastRatio`, `readableShade` and `onColor` must also give (lib/style/__tests__/colors.test.ts):
#: inputs and expected outputs by function, malformed inputs included (`null` is None; a
#: contrast ratio of `null` is NaN).
COLOR_RULES: dict[str, list[dict[str, Any]]] = json.loads(
    (FIXTURES / "color_rules.json").read_text()
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


@pytest.mark.parametrize(
    "row",
    PALETTE_SAMPLES,
    ids=lambda r: f"{r['palette']}-{r['count']}{'-reversed' if r.get('reverse') else ''}",
)
def test_shared_palette_samples(row: dict[str, Any]) -> None:
    assert (
        sample_colors(
            row["palette"],
            row["count"],
            kind=row.get("kind"),
            reverse=row.get("reverse", False),
        )
        == row["colors"]
    )


@pytest.mark.parametrize("row", COLOR_RULES["shade"], ids=lambda r: str(r["color"]))
def test_shared_shades(row: dict[str, Any]) -> None:
    assert shade(row["color"]) == row["expected"]


def test_the_shade_rounds_exact_halves_up() -> None:
    # 15 x 0.7 is 10.5 exactly, though 10.499... in floating point.
    assert shade("#0f0f0f") == "#0b0b0b"


@pytest.mark.parametrize(
    "row", COLOR_RULES["contrast_ratio"], ids=lambda r: f"{r['a']}-{r['b']}"
)
def test_shared_contrast_ratios(row: dict[str, Any]) -> None:
    got = contrast_ratio(row["a"], row["b"])
    if row["expected"] is None:
        assert math.isnan(got)
    else:
        assert got == pytest.approx(row["expected"], abs=5e-5)


@pytest.mark.parametrize(
    "row", COLOR_RULES["readable_shade"], ids=lambda r: f"{r['color']}-{r['against']}"
)
def test_shared_readable_shades(row: dict[str, Any]) -> None:
    assert readable_shade(row["color"], row["against"]) == row["expected"]


def test_a_readable_shade_meets_the_floor_where_it_can() -> None:
    for row in COLOR_RULES["readable_shade"]:
        got = readable_shade(row["color"], row["against"])
        hexes = all(
            isinstance(c, str) and len(c) in (7, 9) and c.startswith("#")
            for c in (row["color"], row["against"])
        )
        if (
            hexes
            and not math.isnan(contrast_ratio(got, row["against"]))
            and shade(got) != got
        ):
            assert contrast_ratio(got, row["against"]) >= 4.5


@pytest.mark.parametrize("row", COLOR_RULES["on_color"], ids=lambda r: str(r["color"]))
def test_shared_on_colors(row: dict[str, Any]) -> None:
    assert on_color(row["color"]) == row["expected"]


@pytest.mark.parametrize("row", COLOR_RULES["alpha"], ids=lambda r: str(r["color"]))
def test_shared_alphas(row: dict[str, Any]) -> None:
    assert alpha(row["color"]) == row["expected"]


@pytest.mark.parametrize("row", COLOR_RULES["is_none"], ids=lambda r: str(r["color"]))
def test_shared_none_colors(row: dict[str, Any]) -> None:
    assert is_none(row["color"]) is row["expected"]


@pytest.mark.parametrize("row", COLOR_RULES["opaque"], ids=lambda r: str(r["color"]))
def test_shared_opaque_colors(row: dict[str, Any]) -> None:
    assert opaque(row["color"]) == row["expected"]


@pytest.mark.parametrize(
    "row", COLOR_RULES["label_pair"], ids=lambda r: f"{r['color']}-{r['tone']}"
)
def test_shared_label_pairs(row: dict[str, Any]) -> None:
    assert label_pair(row["color"], row["tone"]) == {
        "text": row["text"],
        "halo": row["halo"],
    }


def test_a_label_pair_meets_the_floor_for_every_color_on_both_tones() -> None:
    colors = [*palette_colors("carto:Bold"), "#f2b701", "#ffffff", "#000000"]
    colors += ["#2bb381", "#808080", "#ffff00"]
    for color in colors:
        for tone in ("light", "dark"):
            pair = label_pair(color, tone)
            assert contrast_ratio(pair["text"], pair["halo"]) >= 4.5, (color, tone)


@pytest.mark.parametrize(
    "row", COLOR_RULES["halo_against"], ids=lambda r: str(r["text"])
)
def test_shared_halos_against_a_text(row: dict[str, Any]) -> None:
    assert halo_against(row["text"]) == row["expected"]


def test_a_halo_against_a_text_meets_the_floor_for_every_grey() -> None:
    for v in range(256):
        text = f"#{v:02x}{v:02x}{v:02x}"
        assert contrast_ratio(text, halo_against(text)) >= 4.5, text
