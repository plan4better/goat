"""Colors: parsing, palette sampling and ranges over classes (the specification's 5.8).

The Python implementation is the reference: the server stores the colors and
numbers a classification resolves to, and the compiler and legend read them.
"""

import re
from typing import Any

from goatlib.style.catalog import palettes
from goatlib.style.ops import round_half_up

#: Palettes a classification uses when it names none (18.4).
DEFAULT_CLASSIFY_PALETTE = {"numeric": "goat:green", "categories": "colorbrewer:Set2"}

#: Output ranges for numbers spread over classes when a classification gives no
#: `range`, by target (`marker.size`) or by its last key (`width`).
DEFAULT_RANGES: dict[str, tuple[float, float]] = {
    "marker.size": (4, 24),
    "label.size": (10, 18),
    "arrows.size": (6, 16),
    "width": (0.5, 6),
    "pattern_spacing": (6, 20),
    "pattern_width": (1, 4),
    "opacity": (0.2, 1),
    "blur": (0, 4),
    "offset": (0, 8),
    "rotation": (0, 360),
    "max_width": (60, 240),
}

_HEX = re.compile(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")

# sRGB (D65) to CIE XYZ and back, and the D65 white point.
_TO_XYZ = (
    (0.4124564, 0.3575761, 0.1804375),
    (0.2126729, 0.7151522, 0.0721750),
    (0.0193339, 0.1191920, 0.9503041),
)
_FROM_XYZ = (
    (3.2404542, -1.5371385, -0.4985314),
    (-0.9692660, 1.8760108, 0.0415560),
    (0.0556434, -0.2040259, 1.0572252),
)
_WHITE = (0.95047, 1.0, 1.08883)
_DELTA = 6 / 29


def parse_color(value: Any) -> str | None:
    """`#rrggbb` or `#rrggbbaa` in lowercase, from either form or an RGB list of
    three or more numbers 0 to 255 (a fourth is ignored); anything else None."""
    if isinstance(value, str):
        return value.lower() if _HEX.fullmatch(value) else None
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        rgb = value[:3]
        if all(
            not isinstance(c, bool) and isinstance(c, (int, float)) and 0 <= c <= 255
            for c in rgb
        ):
            return rgb_to_hex([round_half_up(c) for c in rgb])
    return None


def hex_to_rgb(hex_color: str) -> list[int]:
    """`#9e0142` as `[158, 1, 66]`."""
    hex_color = hex_color.lstrip("#")
    return [int(hex_color[i : i + 2], 16) for i in (0, 2, 4)]


def rgb_to_hex(rgb: list[int]) -> str:
    """`[158, 1, 66]` as `#9e0142`."""
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def _lab(hex_color: str) -> tuple[float, float, float]:
    linear = [
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        for c in (v / 255 for v in hex_to_rgb(hex_color))
    ]
    xyz = [
        sum(m * c for m, c in zip(row, linear)) / w for row, w in zip(_TO_XYZ, _WHITE)
    ]
    fx, fy, fz = (
        t ** (1 / 3) if t > _DELTA**3 else t / (3 * _DELTA**2) + 4 / 29 for t in xyz
    )
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def _from_lab(lab: tuple[float, float, float]) -> str:
    lightness, a, b = lab
    fy = (lightness + 16) / 116
    xyz = [
        w * (t**3 if t > _DELTA else 3 * _DELTA**2 * (t - 4 / 29))
        for t, w in zip((fy + a / 500, fy, fy - b / 200), _WHITE)
    ]
    rgb = []
    for row in _FROM_XYZ:
        c = sum(m * v for m, v in zip(row, xyz))
        c = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        rgb.append(round_half_up(min(1.0, max(0.0, c)) * 255))
    return rgb_to_hex(rgb)


def sample_colors(
    palette: str | list[str],
    n: int,
    *,
    kind: str | None = None,
    reverse: bool = False,
) -> list[str]:
    """`n` colors from a palette id or an inline list.

    A palette with a scheme for exactly `n` classes (ColorBrewer) uses it.
    Qualitative palettes repeat their colors in order. Any other palette spreads
    its colors evenly over t = 0 to 1 and blends in Lab between the two nearest;
    one class takes the middle.
    """
    if n <= 0:
        return []
    if isinstance(palette, str):
        entry = palettes().get(palette)
        if entry is None:
            raise ValueError(f"Unknown palette {palette!r}.")
        kind = kind or entry.kind
        stops = list(entry.variants.get(n) or entry.colors)
    else:
        stops = [c.lower() for c in palette]
    if not stops:
        return []
    if reverse:
        stops.reverse()
    if len(stops) == n:
        return stops
    if kind == "qualitative":
        return [stops[i % len(stops)] for i in range(n)]
    if len(stops) == 1:
        return stops * n
    # Position of class i among the stops as an exact fraction, so a class that
    # falls on a stop takes that stop's color unchanged.
    positions = [(1, 2)] if n == 1 else [(i, n - 1) for i in range(n)]
    out = []
    for num, den in positions:
        j, rem = divmod(num * (len(stops) - 1), den)
        if rem == 0:
            out.append(stops[j])
            continue
        frac = rem / den
        start, end = _lab(stops[j]), _lab(stops[j + 1])
        out.append(_from_lab(tuple(s + (e - s) * frac for s, e in zip(start, end))))
    return out


def range_values(r0: float, r1: float, n: int, *, opacity: bool = False) -> list[float]:
    """Class i of n gets r0 + i x (r1 - r0) / (n - 1), rounded to 0.1 (0.01 for
    opacities); one class gets r0."""
    scale = 100 if opacity else 10
    if n <= 0:
        return []
    values = [r0] if n == 1 else [r0 + i * (r1 - r0) / (n - 1) for i in range(n)]
    return [round_half_up(v * scale) / scale for v in values]


def default_range(target: str) -> tuple[float, float]:
    """The output range for a numeric target without one; KeyError for targets
    that take no numbers."""
    if target in DEFAULT_RANGES:
        return DEFAULT_RANGES[target]
    return DEFAULT_RANGES[target.rsplit(".", 1)[-1]]
