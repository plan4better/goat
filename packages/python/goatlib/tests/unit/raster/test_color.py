"""The service's coloring is the browser's of before the switch: these are the cases of the web's
`raster-color.test.ts`, with the same inputs and expected colors."""

from typing import Any

import numpy as np
import pytest
from goatlib.raster.color import bands_needed, colorize, image_bands
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


def classes(**extra: Any):
    base = {
        "kind": "classes",
        "band": 1,
        "classes": [
            {"to": 10, "color": "#ff0000"},
            {"from": 10, "to": 20, "color": "#00ff00"},
            {"from": 20, "color": "#0000ff"},
        ],
    }
    return coloring(**{**base, **extra})


def test_classes_hide_the_cells_beyond_their_range_as_a_ramp_does() -> None:
    """Open first and last classes end at the range (the domain, else the
    band's): beyond it the end colors draw by default, nothing with hide. The
    last class holds its end, as a ramp's range does."""
    hide = classes(domain=[0, 30], outside="hide")
    assert paint(hide, -1)[3] == 0
    assert paint(hide, 0) == [255, 0, 0, 255]
    assert paint(hide, 30) == [0, 0, 255, 255]
    assert paint(hide, 30.5)[3] == 0
    clamp = classes(domain=[0, 30], outside="clamp")
    assert paint(clamp, -1) == [255, 0, 0, 255]
    assert paint(clamp, 99) == [0, 0, 255, 255]
    # Without a domain the band's range stands in, as for a ramp.
    open_range = classes(outside="hide")
    assert paint(open_range, 4, band_range=(5, 25))[3] == 0
    assert paint(open_range, 25, band_range=(5, 25)) == [0, 0, 255, 255]
    assert paint(open_range, 26, band_range=(5, 25))[3] == 0
    # Neither known: nothing is cut.
    assert paint(open_range, -500) == [255, 0, 0, 255]


def test_classes_with_their_own_outer_ends_hide_beyond_them_or_take_the_end_colors() -> (
    None
):
    own = [
        {"from": 2, "to": 10, "color": "#ff0000"},
        {"from": 10, "to": 20, "color": "#00ff00"},
        {"from": 20, "to": 28, "color": "#0000ff"},
    ]
    hide = classes(classes=own, domain=[0, 30], outside="hide")
    # The classes' own ends come before the range.
    assert paint(hide, 1)[3] == 0
    assert paint(hide, 2) == [255, 0, 0, 255]
    assert paint(hide, 28) == [0, 0, 255, 255]
    assert paint(hide, 29)[3] == 0
    clamp = classes(classes=own, outside="clamp")
    assert paint(clamp, 1) == [255, 0, 0, 255]
    assert paint(clamp, 50) == [0, 0, 255, 255]
    # A hidden end class stays hidden beyond its end too.
    first_hidden = [{**own[0], "color": None}, *own[1:]]
    assert paint(classes(classes=first_hidden), -9)[3] == 0


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


def test_256_categories_each_draw_their_color() -> None:
    """A full 8-bit band as categories: every code its own color, through the URL token."""
    classes = [{"value": v, "color": f"#{v:02x}{255 - v:02x}{(v * 7) % 256:02x}"} for v in range(256)]
    c = coloring(kind="categories", band=1, classes=classes, other=None)
    values = np.arange(256, dtype="uint8").reshape(16, 16)
    out = colorize(c, {1: values}, file_no_data=None)
    for v in range(256):
        assert out[v // 16, v % 16].tolist() == [v, 255 - v, (v * 7) % 256, 255]


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
    ("spec", "bands", "expected"),
    [
        ({"kind": "rgb", "bands": None}, (1, 2, 3, 4), (1, 2, 3)),
        ({"kind": "rgb", "bands": None}, (1,), (1,)),
        # An alpha band first: the image is the three value bands after it.
        ({"kind": "rgb", "bands": None}, (2, 3, 4), (2, 3, 4)),
        ({"kind": "rgb", "bands": [4, 1, 2]}, (1, 2, 3, 4), (1, 2, 4)),
        (
            {
                "kind": "stops",
                "band": "(b4 - b1) / b2",
                "stops": [{"value": 0, "color": "#000"}],
            },
            (1, 2, 3, 4),
            (1, 2, 4),
        ),
        (
            {"kind": "classes", "band": 3, "classes": [{"color": "#000"}]},
            (1, 2, 3, 4),
            (3,),
        ),
    ],
)
def test_the_bands_a_coloring_reads(spec: dict, bands: tuple, expected: tuple) -> None:
    assert bands_needed(coloring(**spec), bands) == expected


IMAGE = {"kind": "rgb", "bands": None}


@pytest.mark.parametrize(
    ("spec", "bands", "interp", "drawn"),
    [
        # A BGR file marked blue, green, red: red is band 3.
        (IMAGE, (1, 2, 3), ("blue", "green", "red"), (3, 2, 1)),
        # No markings, or not all three: the first three value bands.
        (IMAGE, (1, 2, 3), ("gray", "undefined", "undefined"), (1, 2, 3)),
        (IMAGE, (1, 2, 3), ("red", "undefined", "undefined"), (1, 2, 3)),
        (IMAGE, (1, 2, 3), (), (1, 2, 3)),
        # An RGBA file: its alpha band is no value band.
        (IMAGE, (1, 2, 3), ("red", "green", "blue", "alpha"), (1, 2, 3)),
        (IMAGE, (2, 3, 4), ("alpha", "red", "green", "blue"), (2, 3, 4)),
        # One band: its grey or its color table.
        (IMAGE, (1,), ("palette",), (1,)),
        # The style's own bands win.
        (
            {"kind": "rgb", "bands": [1, 2, 3]},
            (1, 2, 3),
            ("blue", "green", "red"),
            (1, 2, 3),
        ),
    ],
)
def test_an_image_draws_the_bands_its_file_marks_red_green_and_blue(
    spec: dict, bands: tuple, interp: tuple, drawn: tuple
) -> None:
    c = coloring(**spec)
    assert image_bands(c, bands, interp) == drawn
    # It reads them (in band order) and draws them in that order.
    assert bands_needed(c, bands, interp) == tuple(sorted(set(drawn)))
    if len(drawn) == 3:
        values = {i: np.array([[10 * i]], dtype="uint8") for i in sorted(set(drawn))}
        rgba = colorize(c, values, bits=(8,) * 4, color_interp=interp)[0, 0].tolist()
        assert rgba == [10 * i for i in drawn] + [255]


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


@pytest.mark.parametrize(
    "spec",
    [
        {"kind": "rgb", "bands": None},
        {"kind": "rgb", "bands": [3, 1, 2], "noData": [0]},
        {"kind": "rgb", "bands": None, "noData": [7.0, 300]},
    ],
)
def test_an_8_bit_image_is_painted_from_its_bytes_as_before(spec: dict) -> None:
    """Three 8 bit bands are the colors already: no float copy of a 512 px
    tile (about 20 ms each), and the same pixels as the float path, which a
    16 bit file of the same values at 8 bits still takes."""
    import tracemalloc

    rng = np.random.default_rng(5)
    shape = (512, 512)
    data = [rng.integers(0, 12, shape, dtype="uint8") * 23 for _ in range(3)]
    masked = rng.random(shape) < 0.05
    bands = {
        i: np.ma.masked_array(d, mask=masked if i == 2 else np.ma.nomask)
        for i, d in enumerate(data, 1)
    }
    wide = {i: b.astype("uint16") for i, b in bands.items()}
    c = coloring(**spec)
    out = colorize(c, bands, bits=(8, 8, 8))
    assert out.dtype == np.uint8 and out.shape == (*shape, 4)
    assert np.array_equal(out, colorize(c, wide, bits=(8, 8, 8)))
    assert (out[masked, 3] == 0).all() and (out[masked, :3] == 0).all()
    if spec.get("noData"):
        return
    tracemalloc.start()
    colorize(c, bands, bits=(8, 8, 8))
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    # The RGBA tile (1 MiB) and a few masks; the float path took over 20 MiB.
    assert peak < 4 * 1024 * 1024
