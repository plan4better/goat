"""Colors: parsing, palette sampling and ranges over classes (the specification's 5.8).

The Python implementation is the reference: the server stores the colors and
numbers a classification resolves to, and the compiler and legend read them.
"""

import json
import math
import re
from importlib import resources
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
    "extrude.height": (0, 50),
    "extrude.base": (0, 10),
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


#: The contrast a readable shade reaches (WCAG's 4.5 to 1), the relative luminance
#: from which an on-color is dark, and the light and dark colors it picks from.
CONTRAST_FLOOR = 4.5
ON_COLOR_LUMINANCE = 0.5
LIGHT = "#ffffff"
DARK = "#3a3541"


def _is_hex(value: Any) -> bool:
    """Whether `value` is a `#rrggbb` or `#rrggbbaa` color."""
    return isinstance(value, str) and _HEX.fullmatch(value) is not None


def shade(hex_color: Any) -> Any:
    """The darker shade `"auto"` draws (spec 3.1): red, green and blue each times
    0.7, rounded half up in whole numbers (so 15 gives 11, not 10.499...
    rounded), opaque whatever the color's alpha; lowercase. Anything but a
    six- or eight-digit hex color is returned as it is."""
    if not _is_hex(hex_color):
        return hex_color
    return rgb_to_hex([(7 * c + 5) // 10 for c in hex_to_rgb(hex_color)])


def _luminance(hex_color: str) -> float:
    """WCAG's relative luminance of the color's red, green and blue."""
    linear = [
        s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
        for s in (c / 255 for c in hex_to_rgb(hex_color))
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast_ratio(a: Any, b: Any) -> float:
    """WCAG's contrast ratio of two hex colors, 1 to 21, alpha ignored; NaN where
    either is not a six- or eight-digit hex color."""
    if not (_is_hex(a) and _is_hex(b)):
        return math.nan
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def readable_shade(hex_color: Any, against: Any, floor: float = CONTRAST_FLOOR) -> Any:
    """The shade of the color, shaded again until it contrasts with `against` by
    at least `floor`; where shading stops changing it (near black) first, that
    last shade. Against anything but a hex color, the shade alone; anything but
    a hex color is returned as it is."""
    if not _is_hex(hex_color):
        return hex_color
    color = shade(hex_color)
    # A NaN ratio (`against` no hex color) compares as False: the shade alone.
    while contrast_ratio(color, against) < floor:
        darker = shade(color)
        if darker == color:
            break
        color = darker
    return color


def on_color(hex_color: Any) -> str:
    """White where the color underneath has a relative luminance below 0.5, else
    GOAT's dark text color; white for anything but a hex color."""
    if not _is_hex(hex_color):
        return LIGHT
    return LIGHT if _luminance(hex_color) < ON_COLOR_LUMINANCE else DARK


#: A label's text and halo where no color can be read for them (spec 18.10): GOAT's
#: dark text in a light halo on a light basemap, white text in a dark halo on a dark one.
LABEL_FALLBACK: dict[str, dict[str, str]] = {
    "light": {"text": DARK, "halo": LIGHT},
    "dark": {"text": LIGHT, "halo": DARK},
}


def label_pair(hex_color: Any, tone: Any = "light") -> dict[str, str]:
    """A label's text and halo chosen together for the basemap's tone (spec 18.10),
    from the color of the feature the label belongs to, its alpha ignored. On a light
    basemap the text is the color's readable shade against white in a white halo; on
    a dark one (any tone but "dark" counts as light) the text is white in a halo of
    that shade. For anything but a hex color, `LABEL_FALLBACK`."""
    dark = tone == "dark"
    if not _is_hex(hex_color):
        return dict(LABEL_FALLBACK["dark" if dark else "light"])
    tinted = readable_shade(hex_color, LIGHT)
    return {"text": LIGHT, "halo": tinted} if dark else {"text": tinted, "halo": LIGHT}


def halo_against(text: Any) -> str:
    """The halo of a set text color (spec 18.10): the one of white and GOAT's dark
    text color that contrasts more with it, black where neither reaches the contrast
    floor (a mid-tone text), so the floor always holds; white for anything but a hex
    color."""
    if not _is_hex(text):
        return LIGHT
    light, dark = contrast_ratio(text, LIGHT), contrast_ratio(text, DARK)
    if max(light, dark) < CONTRAST_FLOOR:
        return "#000000"
    return LIGHT if light >= dark else DARK


def text_against(
    hex_color: Any, halo: Any, tone: Any = "light", text: Any = None
) -> str:
    """The text `"auto"` draws beside the halo the map draws (spec 18.10: a color the
    style sets, or the reference `#ffffff` where none is set), read without its alpha:
    `text` (by default the label pair's text for the tone) where it contrasts with the
    halo by at least the contrast floor; else the color's readable shade against the
    halo where it reaches the floor; else `halo_against` of the halo. A halo that is
    not a hex color or is "None" is no halo: `text`. For a color that is not a hex
    color the step of the readable shade is left out."""
    first = label_pair(hex_color, tone)["text"] if text is None else text
    if not _is_hex(halo) or is_none(halo):
        return first
    halo = opaque(halo)
    if contrast_ratio(first, halo) >= CONTRAST_FLOOR:
        return first
    tinted = readable_shade(hex_color, halo)
    if contrast_ratio(tinted, halo) >= CONTRAST_FLOOR:
        return tinted
    return halo_against(halo)


def alpha(hex_color: Any) -> int | None:
    """The color's alpha, 0 to 255: its last two digits, 255 without them; None
    for anything but a six- or eight-digit hex color."""
    if not _is_hex(hex_color):
        return None
    return int(hex_color[7:9], 16) if len(hex_color) == 9 else 255


def is_none(hex_color: Any) -> bool:
    """Whether the color is "None" (spec 4.6): a hex color at alpha 0, which draws
    nothing and keeps its hue."""
    return alpha(hex_color) == 0


def opaque(hex_color: Any) -> Any:
    """The color without its alpha, `#rrggbb` as written: the hue a color that is
    not set takes from the color it follows (spec 3.1 to 3.3). Anything but a
    six- or eight-digit hex color is returned as it is."""
    return hex_color[:7] if _is_hex(hex_color) else hex_color


#: The rules a color key's `"auto"` follows (spec 18.10).
AUTO_RULES = ("shade", "label_text", "label_halo", "on_color")

#: Every key that holds a color, a list of colors or a palette (spec 18.10), by
#: the table's name: `auto` is its rule (`AUTO_RULES`) or None where `"auto"` is
#: not offered; a rule has the color it `follows` and whether the models take
#: `"auto"` there yet (`accepted`). The web's derived colors are tested against it.
COLOR_KEYS: dict[str, dict[str, Any]] = json.loads(
    resources.files("goatlib.style")
    .joinpath("data", "color_keys.json")
    .read_text(encoding="utf-8")
)


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
    its colors evenly over t = 0 to 1 and blends in Lab between the two nearest,
    their alphas linearly (a blend with an alpha below 255 has eight digits);
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
        blend = _from_lab(tuple(s + (e - s) * frac for s, e in zip(start, end)))
        out.append(blend + _blend_alpha(stops[j], stops[j + 1], rem, den))
    return out


def _blend_alpha(start: str, end: str, rem: int, den: int) -> str:
    """The alpha `rem / den` of the way from `start`'s to `end`'s, rounded half
    up in whole numbers, as the two digits a hex color ends with; nothing where
    it is opaque."""
    a, b = alpha(start), alpha(end)
    a, b = 255 if a is None else a, 255 if b is None else b
    # (a + (b - a) x rem / den) rounded half up, in integers.
    value = (2 * (a * den + (b - a) * rem) + den) // (2 * den)
    return "" if value == 255 else f"{value:02x}"


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
