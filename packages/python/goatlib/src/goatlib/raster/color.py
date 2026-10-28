"""Cells to colors: a coloring (`goatlib.raster.token`) applied to band arrays.

The semantics are the browser's before the service existed, vectorized: a ramp
is a 256-color lookup interpolated in RGB between the palette's colors, stops
blend linearly or take the nearest stop, classes are `[from, to)` with the first
match winning, categories match the rounded value. No-data (the file's value
with its float32 rounding, NaN, masked cells and the style's values) is
transparent. Opacity and image adjustments stay paint properties in the browser.
"""

from collections.abc import Mapping, Sequence

import numpy as np

from goatlib.raster.token import Categories, Classes, Ramp, Rgb, Stops

Coloring = Ramp | Stops | Classes | Categories | Rgb
#: Colors (H x W x 3, floats) and the cells drawn transparent.
Painted = tuple[np.ndarray, np.ndarray]
ColorTable = Mapping[int, Sequence[int]]

LUT_SIZE = 256


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _js_round(x: np.ndarray) -> np.ndarray:
    """Math.round: halves round up."""
    return np.floor(x + 0.5)


def _to_byte(x: np.ndarray) -> np.ndarray:
    """A Uint8ClampedArray store: rounded to nearest, halves to even, clamped."""
    return np.clip(np.rint(x), 0, 255).astype("uint8")


def bands_needed(coloring: Coloring, count: int) -> tuple[int, ...]:
    """The bands a coloring reads from a file of `count` bands."""
    if isinstance(coloring, Rgb):
        if coloring.bands is None:
            return (1, 2, 3) if count >= 3 else (1,)
        return tuple(sorted(set(coloring.bands)))
    return coloring.formula.bands


def _invalid(values: np.ndarray, file_no_data: float | None) -> np.ndarray:
    data = np.ma.getdata(values)
    bad = np.ma.getmaskarray(values).copy()
    if np.issubdtype(data.dtype, np.floating):
        bad |= np.isnan(data)
    if file_no_data is not None and not np.isnan(file_no_data):
        bad |= data == file_no_data
        if np.issubdtype(data.dtype, np.floating):
            bad |= data == np.float32(file_no_data)
    return bad


def _style_no_data(values: np.ndarray, no_data: Sequence[float]) -> np.ndarray:
    hidden = np.zeros(values.shape, dtype=bool)
    for x in no_data:
        hidden |= np.abs(values - x) <= 1e-6 * max(1.0, abs(x))
    return hidden


def _lut(colors: Sequence[str]) -> np.ndarray:
    """256 RGB colors, the palette's colors spread evenly over 0..255 and
    interpolated linearly in between (d3's scaleLinear, as the browser did)."""
    points = np.array([_rgb(c) for c in colors], dtype="float64")
    at = np.linspace(0, LUT_SIZE - 1, len(points))
    i = np.arange(LUT_SIZE, dtype="float64")
    return np.stack([np.interp(i, at, points[:, k]) for k in range(3)], axis=-1)


def _ramp(c: Ramp, v: np.ndarray, band_range: tuple[float, float] | None) -> Painted:
    d0, d1 = c.domain or band_range or (0.0, 1.0)
    span = (d1 - d0) or 1.0
    t = (v - d0) / span
    hidden = (t < 0) | (t > 1) if c.outside == "hide" else np.zeros(v.shape, bool)
    index = _js_round(np.clip(np.nan_to_num(t), 0, 1) * (LUT_SIZE - 1)).astype("int64")
    return _lut(c.colors)[index], hidden


def _stops(c: Stops, v: np.ndarray) -> Painted:
    values = np.array([s.value for s in c.stops], dtype="float64")
    colors = np.array([_rgb(s.color) for s in c.stops], dtype="float64")
    outside = (v < values[0]) | (v > values[-1])
    hidden = outside if c.outside == "hide" else np.zeros(v.shape, bool)
    if c.interpolate == "nearest":
        # The first of the closest stops, as the browser's loop kept it: a value on
        # the midpoint between two stops takes the lower one.
        midpoints = (values[1:] + values[:-1]) / 2
        return colors[np.searchsorted(midpoints, v, side="left")], hidden
    out = np.stack([np.interp(v, values, colors[:, k]) for k in range(3)], axis=-1)
    return out, hidden


def _classes(c: Classes, v: np.ndarray) -> Painted:
    out = np.zeros(v.shape + (3,), dtype="float64")
    hidden = np.ones(v.shape, dtype=bool)
    taken = np.zeros(v.shape, dtype=bool)
    for k in c.classes:
        lo = -np.inf if k.from_ is None else k.from_
        hi = np.inf if k.to is None else k.to
        match = ~taken & (v >= lo) & (v < hi)
        taken |= match
        if k.color is not None:
            out[match] = _rgb(k.color)
            hidden[match] = False
    return out, hidden


def _categories(c: Categories, v: np.ndarray) -> Painted:
    key = _js_round(v)
    out = np.zeros(v.shape + (3,), dtype="float64")
    hidden = np.ones(v.shape, dtype=bool)
    matched = np.zeros(v.shape, dtype=bool)
    for k in c.classes:
        match = ~matched & (key == k.value)
        matched |= match
        if k.color is not None:
            out[match] = _rgb(k.color)
            hidden[match] = False
    if c.other is not None:
        out[~matched] = _rgb(c.other)
        hidden[~matched] = False
    return out, hidden


def _table(values: np.ndarray, invalid: np.ndarray, table: ColorTable) -> np.ndarray:
    """The file's own colors; a value the table does not list is transparent."""
    size = max(table) + 1
    lut = np.zeros((size, 4), dtype="uint8")
    for value, color in table.items():
        rgba = tuple(color) + (255,) * (4 - len(color))
        lut[value] = rgba[:4]
    data = np.nan_to_num(np.ma.getdata(values).astype("float64"), nan=-1)
    keys = data.astype("int64")
    listed = ~invalid & (keys >= 0) & (keys < size) & (data == keys)
    out = np.zeros(values.shape + (4,), dtype="uint8")
    out[listed] = lut[keys[listed]]
    return out


def _scale(bits: Sequence[int], band: int) -> float:
    b = bits[band - 1] if len(bits) >= band else 8
    return 255 / (2**b - 1) if b > 8 else 1.0


def _rgba(rgb: np.ndarray, hidden: np.ndarray) -> np.ndarray:
    out = np.zeros(hidden.shape + (4,), dtype="uint8")
    out[..., :3] = _to_byte(rgb)
    out[..., 3] = np.where(hidden, 0, 255)
    out[hidden, :3] = 0
    return out


def colorize(
    coloring: Coloring,
    bands: Mapping[int, np.ndarray],
    *,
    file_no_data: float | None = None,
    bits: Sequence[int] = (),
    color_table: ColorTable | None = None,
    band_range: tuple[float, float] | None = None,
) -> np.ndarray:
    """RGBA bytes (H x W x 4) for band arrays of one shape (band index to
    values, masked arrays allowed), already scaled by the file's scale and
    offset. `band_range` (the band's or formula's minimum and maximum) stands in
    for a missing domain and stretches a one-band image."""
    invalid = {i: _invalid(a, file_no_data) for i, a in bands.items()}
    if isinstance(coloring, Rgb):
        return _image(coloring, bands, invalid, bits, color_table, band_range)
    if isinstance(coloring, Categories) and not coloring.classes:
        return _image(
            Rgb(v=1, noData=coloring.no_data, kind="rgb"),
            bands,
            invalid,
            bits,
            color_table,
            band_range,
        )
    formula = coloring.formula
    bad = np.zeros(next(iter(bands.values())).shape, dtype=bool)
    for i in formula.bands:
        bad |= invalid[i]
    v = formula.evaluate({i: np.ma.getdata(bands[i]) for i in formula.bands}).astype(
        "float64"
    )
    bad |= np.isnan(v)
    v = np.where(bad, 0.0, v)
    bad |= _style_no_data(v, coloring.no_data)
    if isinstance(coloring, Ramp):
        rgb, hidden = _ramp(coloring, np.where(bad, np.nan, v), band_range)
    elif isinstance(coloring, Stops):
        rgb, hidden = _stops(coloring, v)
    elif isinstance(coloring, Classes):
        rgb, hidden = _classes(coloring, v)
    else:
        rgb, hidden = _categories(coloring, v)
    return _rgba(rgb, hidden | bad)


def _image(
    c: Rgb,
    bands: Mapping[int, np.ndarray],
    invalid: Mapping[int, np.ndarray],
    bits: Sequence[int],
    color_table: ColorTable | None,
    band_range: tuple[float, float] | None,
) -> np.ndarray:
    if c.bands is None and color_table:
        out = _table(bands[1], invalid[1], color_table)
        hide = _style_no_data(np.ma.getdata(bands[1]).astype("float64"), c.no_data)
        out[hide] = 0
        return out
    picked = c.bands or ((1, 2, 3) if len(bands) >= 3 else None)
    if picked is None:
        # One band without a color table: grey from its lowest to its highest value.
        v = np.ma.getdata(bands[1]).astype("float64")
        bad = invalid[1] | _style_no_data(v, c.no_data)
        lo, hi = band_range or (0.0, 2.0 ** (bits[0] if bits else 8) - 1)
        grey = np.clip((v - lo) / ((hi - lo) or 1.0), 0, 1) * 255
        return _rgba(np.stack([grey] * 3, axis=-1), bad)
    r, g, b = picked
    data = [np.ma.getdata(bands[i]).astype("float64") for i in picked]
    bad = invalid[r] | invalid[g] | invalid[b]
    # The style's no data hides a pixel only when all three bands hold it: a black border, not every pure red.
    bad |= np.logical_and.reduce([_style_no_data(d, c.no_data) for d in data])
    rgb = np.stack([d * _scale(bits, i) for d, i in zip(data, picked)], axis=-1)
    return _rgba(rgb, bad)
