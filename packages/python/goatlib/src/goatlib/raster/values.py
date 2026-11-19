"""Cell values as RGB: what a value tile holds, for MapLibre to color in the
browser (a `raster-dem` source with `encoding: "custom"` under `color-relief`
and `hillshade` layers).

A pixel holds a code `q = R * 65536 + G * 256 + B`. `q = 0` is no data (the
file's no data, NaN, masked cells); a valid cell is `base + q * step`, which is
MapLibre's custom unpack (`R * redFactor + G * greenFactor + B * blueFactor -
baseShift`) with the factors of `ValueEncoding.factors`. Alpha is 255
everywhere: a browser may premultiply an image's colors by its alpha when it
decodes it, which loses the RGB of any pixel below 255.
"""

import math
from dataclasses import dataclass

import numpy as np

#: The largest code (24 bits).
MAX_Q = 16_777_215
#: Joins every value tile's version, so a changed encoding never serves old tiles.
ENCODING_VERSION = "e1"

#: Whole-number types stored exactly, from their minimum.
_EXACT = {"uint8": 0, "int8": -128, "uint16": 0, "int16": -32768}
#: Whole-number types stored exactly when their range fits in the codes.
_WIDE = ("int32", "uint32")
#: Statistics come from an overview and may miss a band's extreme cells: the
#: codes keep room below a range, its span over `_BELOW` (on the exact path at
#: most the codes left), and on the float path its span over `_ABOVE` above it.
_BELOW = 10
_ABOVE = 100


@dataclass(frozen=True)
class ValueEncoding:
    #: Code `q` is the value `base + q * step`.
    base: float
    step: float
    #: Whether the codes hold whole numbers exactly (`step` is 1).
    integer: bool
    #: The band's (or the formula's) minimum and maximum as given, unwidened;
    #: None when unknown. A ramp without a domain spreads over it, as
    #: `colorize`'s `band_range`.
    range: tuple[float, float] | None

    def factors(self) -> dict[str, float]:
        """The `raster-dem` source options that decode the codes."""
        return {
            "redFactor": 65536 * self.step,
            "greenFactor": 256 * self.step,
            "blueFactor": self.step,
            "baseShift": -self.base,
        }

    def encode(self, values: np.ndarray) -> np.ndarray:
        """Cells (a masked array, or NaN or infinite for no data) as codes,
        H x W x 4 `uint8`; a cell beyond the codes takes the nearest end code."""
        data = np.ma.getdata(values).astype("float64")
        valid = ~np.ma.getmaskarray(values) & np.isfinite(data)
        q = np.zeros(data.shape, dtype="int64")
        q[valid] = np.clip(np.rint((data[valid] - self.base) / self.step), 1, MAX_Q)
        rgba = np.empty(data.shape + (4,), dtype="uint8")
        rgba[..., 0] = q >> 16
        rgba[..., 1] = (q >> 8) & 255
        rgba[..., 2] = q & 255
        rgba[..., 3] = 255
        return rgba

    def decode(self, rgba: np.ndarray) -> np.ndarray:
        """The values of codes (H x W x 3 or 4), float64; NaN where the code is 0."""
        rgb = rgba[..., :3].astype("int64")
        q = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
        return np.where(q == 0, np.nan, self.base + q * self.step)


def value_encoding(
    dtype: str,
    *,
    scaled: bool,
    value_range: tuple[float, float] | None,
    formula: bool = False,
) -> ValueEncoding:
    """How a band of `dtype` (or a formula over bands) is stored in value tiles.

    `value_range` is the band's (or the formula's sampled) minimum and maximum.
    Unscaled 8 and 16 bit whole numbers are stored exactly from their type's
    minimum; 32 bit ones too when their range fits in the codes, with room below
    it. Everything else (floats, scaled bands, formulas) widens the range, a
    tenth of its span below and a hundredth above, and steps by eight float32
    units at the range's magnitude, a power of two: what MapLibre's float32
    decoding still tells apart. The range then uses a share of the codes, and
    the codes above it hold larger values. A range beyond float32 spreads over
    all codes instead.
    """
    given = None
    if value_range is not None:
        given = (float(value_range[0]), float(value_range[1]))
    whole = not scaled and not formula
    if whole and dtype in _EXACT:
        return ValueEncoding(_EXACT[dtype] - 1.0, 1.0, True, given)
    if whole and dtype in _WIDE and given is not None:
        span = given[1] - given[0]
        if span <= MAX_Q - 2:
            room = min(math.ceil(span / _BELOW), MAX_Q - 2 - span)
            return ValueEncoding(given[0] - 1.0 - room, 1.0, True, given)
    lo, hi = given or (0.0, 1.0)
    if hi == lo:
        lo, hi = lo - 0.5, hi + 0.5
    span = hi - lo
    lo, hi = lo - span / _BELOW, hi + span / _ABOVE
    step = (hi - lo) / (MAX_Q - 1)
    with np.errstate(over="ignore"):
        size = np.float32(max(abs(lo), abs(hi)))
    if np.isfinite(size):
        step = max(step, 8 * float(np.spacing(size)))
    return ValueEncoding(lo - step, step, False, given)
