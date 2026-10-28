"""The service's coloring is the browser's of before the switch: these are the cases of the web's
`raster-color.test.ts`, with the same inputs and expected colors."""

from typing import Any

import numpy as np
import pytest
from goatlib.raster.color import bands_needed, colorize
from goatlib.raster.token import decode_token, encode_token


def coloring(**spec: Any):
    return decode_token(encode_token({"v": 1, "noData": [], **spec}))


def ramp(**extra: Any):
    base = {
        "kind": "ramp",
        "band": 1,
        "colors": ["#000000", "#ffffff"],
        "domain": [0, 100],
        "outside": "clamp",
    }
    return coloring(**{**base, **extra})


def paint(c, *pixel: float, dtype: str = "float32", **kw: Any) -> list[int]:
    """The color one pixel gets (one value per band, from band 1)."""
    bands = {i + 1: np.array([[v]], dtype=dtype) for i, v in enumerate(pixel)}
    kw.setdefault("file_no_data", -9999)
    return colorize(c, bands, **kw)[0, 0].tolist()


def near(actual: list[int], expected: list[int]) -> None:
    assert all(abs(a - e) <= 1 for a, e in zip(actual, expected)), (actual, expected)


def test_a_ramp_blends_over_the_domain_and_outside_clamps_or_hides() -> None:
    near(paint(ramp(), 50), [128, 128, 128, 255])
    assert paint(ramp(), 150) == [255, 255, 255, 255]
    assert paint(ramp(outside="hide"), 150)[3] == 0
    assert paint(ramp(), -5) == [0, 0, 0, 255]


def test_a_ramp_is_the_browsers_256_color_lookup() -> None:
    three = ramp(colors=["#000000", "#ff0000", "#ffffff"], domain=[0, 255])
    assert paint(three, 0) == [0, 0, 0, 255]
    assert paint(three, 255) == [255, 255, 255, 255]
    # Index 64 of 0..255 between black (0) and red (127.5): 64 / 127.5 of the way.
    assert paint(three, 64) == [128, 0, 0, 255]
    assert paint(three, 191) == [255, 127, 127, 255]


def test_a_ramp_without_a_domain_spans_the_bands_range() -> None:
    c = ramp(domain=None)
    near(paint(c, 15, band_range=(10, 20)), [128, 128, 128, 255])


def test_stops_blend_linearly_or_take_the_nearest_stop() -> None:
    stops = [{"value": 0, "color": "#000000"}, {"value": 10, "color": "#ffffff"}]
    linear = coloring(
        kind="stops", band=1, stops=stops, interpolate="linear", outside="clamp"
    )
    near(paint(linear, 5), [128, 128, 128, 255])
    nearest = coloring(
        kind="stops", band=1, stops=stops, interpolate="nearest", outside="clamp"
    )
    assert paint(nearest, 4) == [0, 0, 0, 255]
    assert paint(nearest, 6) == [255, 255, 255, 255]
    assert paint(nearest, -3) == [0, 0, 0, 255]
    hide = coloring(
        kind="stops", band=1, stops=stops, interpolate="nearest", outside="hide"
    )
    assert paint(hide, 11)[3] == 0


def test_classes_a_value_at_a_class_end_falls_in_the_next_and_a_hidden_class_is_transparent() -> (
    None
):
    c = coloring(
        kind="classes",
        band=1,
        classes=[
            {"to": 10, "color": "#ff0000"},
            {"from": 10, "to": 20, "color": None},
            {"from": 20, "color": "#0000ff"},
        ],
    )
    assert paint(c, 5) == [255, 0, 0, 255]
    assert paint(c, 10)[3] == 0
    assert paint(c, 15)[3] == 0
    assert paint(c, 20) == [0, 0, 255, 255]
    assert paint(c, 99) == [0, 0, 255, 255]


def test_categories_by_rounded_value_hidden_ones_transparent_the_rest_in_the_other_color() -> (
    None
):
    classes = [{"value": 3, "color": "#00ff00"}, {"value": 6, "color": None}]
    c = coloring(kind="categories", band=1, classes=classes, other="#cccccc")
    assert paint(c, 3) == [0, 255, 0, 255]
    assert paint(c, 2.9999999) == [0, 255, 0, 255]
    assert paint(c, 6)[3] == 0
    assert paint(c, 9) == [204, 204, 204, 255]
    assert (
        paint(coloring(kind="categories", band=1, classes=classes, other=None), 9)[3]
        == 0
    )


def test_no_data_the_files_value_float32_rounding_nan_and_the_styles_values_are_transparent() -> (
    None
):
    assert paint(ramp(), -9999)[3] == 0
    assert paint(ramp(), np.nan)[3] == 0
    assert paint(ramp(noData=[0]), 0)[3] == 0
    assert paint(ramp(), -9999.1, file_no_data=-9999.1)[3] == 0
    assert paint(ramp(), 7, file_no_data=None)[3] == 255


def test_masked_cells_are_transparent() -> None:
    values = np.ma.masked_array([[5.0, 5.0]], mask=[[True, False]])
    out = colorize(ramp(), {1: values})
    assert out[0, 0, 3] == 0 and out[0, 1, 3] == 255


def test_a_palette_color_with_alpha_draws_without_its_alpha() -> None:
    assert paint(ramp(colors=["#ff000080", "#0000ffff"]), 0) == [255, 0, 0, 255]


def test_an_image_hides_a_pixel_whose_three_bands_all_hold_the_styles_no_data() -> None:
    rgb = coloring(kind="rgb", bands=[1, 2, 3], noData=[0])
    kw = {"file_no_data": None, "bits": (8, 8, 8), "dtype": "uint8"}
    assert paint(rgb, 0, 0, 0, **kw)[3] == 0
    assert paint(rgb, 255, 0, 0, **kw) == [255, 0, 0, 255]


def test_reads_its_band_and_three_bands_map_to_red_green_blue_by_bit_depth() -> None:
    near(paint(ramp(band=2), 0, 50), [128, 128, 128, 255])
    rgb = coloring(kind="rgb", bands=[4, 1, 2])
    assert paint(
        rgb, 10, 20, 30, 40, file_no_data=None, bits=(8,) * 4, dtype="uint8"
    ) == [40, 10, 20, 255]
    assert paint(
        rgb, 257, 514, 771, 65535, file_no_data=None, bits=(16,) * 4, dtype="uint16"
    ) == [255, 1, 2, 255]


def test_a_formulas_cells_are_colored_like_a_bands() -> None:
    c = coloring(
        kind="ramp",
        band="(b2 - b1) / (b2 + b1)",
        colors=["#000000", "#ffffff"],
        domain=[0, 1],
        outside="clamp",
    )
    near(paint(c, 10, 30), [128, 128, 128, 255])
    # 0 / 0 is no data.
    assert paint(c, 0, 0)[3] == 0
    # A band holding the file's no-data value hides the cell.
    assert paint(c, -9999, 30)[3] == 0


def test_an_image_without_bands_draws_the_color_table_three_bands_or_one_band_in_grey() -> (
    None
):
    plain = coloring(kind="rgb", bands=None)
    table = {1: (10, 20, 30, 255), 2: (40, 50, 60, 128)}
    assert paint(plain, 1, dtype="uint8", file_no_data=None, color_table=table) == [
        10,
        20,
        30,
        255,
    ]
    assert paint(plain, 2, dtype="uint8", file_no_data=None, color_table=table) == [
        40,
        50,
        60,
        128,
    ]
    assert paint(plain, 3, dtype="uint8", file_no_data=None, color_table=table)[3] == 0
    assert paint(plain, 1, 2, 3, dtype="uint8", file_no_data=None, bits=(8,) * 3) == [
        1,
        2,
        3,
        255,
    ]
    near(
        paint(plain, 150, file_no_data=None, band_range=(100, 200)),
        [128, 128, 128, 255],
    )


def test_categories_without_classes_draw_the_color_table() -> None:
    c = coloring(kind="categories", band=1, classes=[], other=None)
    assert paint(
        c, 1, dtype="uint8", file_no_data=None, color_table={1: (1, 2, 3, 255)}
    ) == [1, 2, 3, 255]


@pytest.mark.parametrize(
    ("spec", "count", "expected"),
    [
        ({"kind": "rgb", "bands": None}, 4, (1, 2, 3)),
        ({"kind": "rgb", "bands": None}, 1, (1,)),
        ({"kind": "rgb", "bands": [4, 1, 2]}, 4, (1, 2, 4)),
        (
            {
                "kind": "stops",
                "band": "(b4 - b1) / b2",
                "stops": [{"value": 0, "color": "#000"}],
            },
            4,
            (1, 2, 4),
        ),
        ({"kind": "classes", "band": 3, "classes": [{"color": "#000"}]}, 4, (3,)),
    ],
)
def test_the_bands_a_coloring_reads(spec: dict, count: int, expected: tuple) -> None:
    assert bands_needed(coloring(**spec), count) == expected


def test_nearest_stops_take_the_first_of_the_closest_without_a_cell_per_stop_copy() -> (
    None
):
    import tracemalloc

    stops = [
        {"value": float(i), "color": "#000000" if i % 2 else "#ffffff"}
        for i in range(256)
    ]
    c = coloring(
        kind="stops", band=1, stops=stops, interpolate="nearest", outside="clamp"
    )
    assert paint(c, 2.5) == [
        255,
        255,
        255,
        255,
    ]  # a tie takes the first stop (2, white)
    assert paint(c, 2.6) == [0, 0, 0, 255]
    values = {1: np.random.default_rng(0).uniform(0, 255, (256, 256)).astype("float32")}
    tracemalloc.start()
    colorize(c, values)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert peak < 40 * 1024 * 1024


def test_a_token_with_more_than_256_stops_is_refused() -> None:
    from goatlib.raster.token import TokenError

    stops = [{"value": float(i), "color": "#000000"} for i in range(257)]
    with pytest.raises(TokenError):
        coloring(
            kind="stops", band=1, stops=stops, interpolate="nearest", outside="clamp"
        )
