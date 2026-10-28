"""GOAT Style documents for the layers tools create (spec 17).

Builders for the looks tools give their results, on top of `goatlib.style`: a
classification the server computes (`classified`), fixed categories
(`categories`), and the few looks tools and bundles always use. Classes of a
`classified` style are filled from the result data by the tool runner
(`BaseToolRunner.computed_style`), like any style the server computes.
"""

import copy
from typing import Any

from goatlib.style.check import MAIN_COLOR
from goatlib.style.colors import sample_colors
from goatlib.style.context import DataContext
from goatlib.style.defaults import default_style
from goatlib.style.ids import assign_ids

#: CARTO's sequential palettes, which goatlib's palette catalogue does not carry.
EMRLD = ["#d3f2a3", "#97e196", "#6cc08b", "#4c9b82", "#217a79", "#105965", "#074050"]
TEAL = ["#d1eeea", "#a8dbd9", "#85c4c9", "#68abb8", "#4f90a6", "#3b738f", "#2a5674"]
SUNSET = ["#f3e79b", "#fac484", "#f8a07e", "#eb7f86", "#ce6693", "#a059a0", "#5c53a5"]

#: Classes a heatmap-like result is split into.
CLASS_COUNT = 7


def _part(geometry: str | None) -> str:
    return MAIN_COLOR[geometry or "polygon"].split(".")[0]


def styled(
    geometry: str | None,
    symbol: dict[str, Any] | None = None,
    *,
    seed: str | None = None,
) -> dict[str, Any]:
    """The default style of the geometry with `symbol`'s parts merged over it
    (`False` turns a part off)."""
    doc = default_style(DataContext(kind="vector", geometry=geometry), seed=seed)
    for part, value in (symbol or {}).items():
        current = doc["symbol"].get(part)
        doc["symbol"][part] = (
            {**current, **value}
            if isinstance(current, dict) and isinstance(value, dict)
            else value
        )
    return doc


def classified(
    field: str,
    palette: str | list[str],
    geometry: str | None,
    *,
    method: str = "quantile",
    count: int = CLASS_COUNT,
    symbol: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A style whose main color is classified by `field`; the classes are computed
    from the data. The color without a class is the palette's middle."""
    middle = sample_colors(palette, 1)[0]
    doc = styled(geometry, {_part(geometry): {"color": middle}, **(symbol or {})})
    doc["classify"] = [
        {"field": field, "method": method, "count": count, "palette": palette}
    ]
    return assign_ids(doc)


def categories(
    field: str,
    values: list[Any],
    palette: str | list[str],
    geometry: str | None,
    *,
    symbol: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A style with one class per value of `field`, in the order given, colored
    along the palette. The classes are fixed: nothing is recomputed."""
    part = _part(geometry)
    colors = sample_colors(palette, len(values))
    middle = colors[len(colors) // 2] if colors else None
    doc = styled(geometry, {part: {"color": middle}, **(symbol or {})})
    classification: dict[str, Any] = {
        "field": field,
        "method": "categories",
        "classes": [
            {"values": [value], part: {"color": color}}
            for value, color in zip(values, colors)
        ],
    }
    # The palette new classes take in the editor; an inline one holds 2 to 12 colors.
    if isinstance(palette, str) or 2 <= len(palette) <= 12:
        classification["palette"] = palette
    doc["classify"] = [classification]
    return assign_ids(doc)


#: A network's bulk: mid grey, so it reads as the backdrop it is and whatever is
#: analysed on top of it keeps the colour. `#717171` is the same neutral the PT
#: service palette uses for "no service", so the two greys in the app are one
#: grey.
BUNDLE_BACKDROP_GREY = "#717171"

#: The part of a network worth picking out of that bulk: the nodes an edge
#: snaps to and splits at, the shapes a stop belongs to. Findable against the
#: grey without being a colour an analysis result would want.
BUNDLE_ACCENT_RED = "#e53935"

#: A halo, so a point stays a point wherever it lands: a grey stop sitting on
#: the red line it serves, or on a basemap the same value as itself, is only
#: separable from what is behind it by an outline. The same white the editor's
#: snapping indicator rings its vertices with.
BUNDLE_POINT_HALO_WHITE = "#ffffff"

#: The symbol of each bundle member, keyed by (bundle type, spec role).
#:
#: A bundle's members are one dataset drawn together, so a colour each (which
#: is what an ordinary upload gets, and reasonably: nothing is known about it)
#: makes a street network arrive as two unrelated layers. Thin and grey is also
#: what a network being *routed on* should look like: present, and not
#: competing with the result drawn over it.
BUNDLE_ROLE_SYMBOLS: dict[tuple[str, str], dict[str, Any]] = {
    # A street network is its edges, with the nodes picked out on top.
    ("street_network", "edges"): {"line": {"color": BUNDLE_BACKDROP_GREY, "width": 2}},
    ("street_network", "nodes"): {
        "marker": {"shape": "circle", "color": BUNDLE_ACCENT_RED, "size": 6}
    },
    # A PT network reads the other way round: the stops are the many, and the
    # shapes are the lines they sit along.
    ("pt_network_gtfs", "stops"): {
        "marker": {"shape": "circle", "color": BUNDLE_BACKDROP_GREY, "size": 8},
        "outline": {"color": BUNDLE_POINT_HALO_WHITE, "width": 2},
    },
    ("pt_network_gtfs", "shape_lines"): {
        "line": {"color": BUNDLE_ACCENT_RED, "width": 3}
    },
}


def bundle_role_style(
    bundle_type: Any, role: Any, geometry: str | None, *, seed: str | None = None
) -> dict[str, Any]:
    """The style a bundle member layer is created with: the role's symbol, or the
    geometry's default style for a role without one."""
    # `getattr(x, "value", x)`: a caller may hold the enum member or the raw
    # string, and `str()` on a `(str, Enum)` gives "BundleTypeName.x".
    key = (
        str(getattr(bundle_type, "value", bundle_type)),
        str(getattr(role, "value", role)),
    )
    symbol = BUNDLE_ROLE_SYMBOLS.get(key)
    if symbol is None:
        return default_style(DataContext(kind="vector", geometry=geometry), seed=seed)
    return {"version": 1, "kind": "vector", "symbol": copy.deepcopy(symbol)}


#: ÖV-Güteklassen: A (best) to F (worst).
OEV_GUETEKLASSEN_COLORS = {
    "A": "#199741",
    "B": "#8bcc62",
    "C": "#dcf09e",
    "D": "#ffdf9a",
    "E": "#f69053",
    "F": "#e4696a",
}

#: Classes beyond F darken from F's red towards this.
OEV_GUETEKLASSEN_LAST = "#9e0142"


def _alpha_label(value: int) -> str:
    """A 1-based integer as a label: A, ..., Z, AA, ..."""
    result = ""
    while value > 0:
        value -= 1
        result = chr(65 + value % 26) + result
        value //= 26
    return result


def oev_gueteklassen_style(
    class_count: int = len(OEV_GUETEKLASSEN_COLORS),
) -> dict[str, Any]:
    """The ÖV-Güteklassen polygons: one class per label, A to F in their
    established colors, later labels in darker reds."""
    labels = [_alpha_label(i) for i in range(1, max(1, class_count) + 1)]
    extra = [label for label in labels if label not in OEV_GUETEKLASSEN_COLORS]
    darker = sample_colors(
        [OEV_GUETEKLASSEN_COLORS["F"], OEV_GUETEKLASSEN_LAST], len(extra) + 1
    )[1:]
    colors = {**OEV_GUETEKLASSEN_COLORS, **dict(zip(extra, darker))}
    return categories(
        "pt_class_label", labels, [colors[label] for label in labels], "polygon"
    )


#: Station categories I to VII, and 999 for a station without service.
OEV_STATION_NO_SERVICE = 999


def oev_gueteklassen_stations_style() -> dict[str, Any]:
    """The stations of an ÖV-Güteklassen run: black, grey without service."""
    values = [*range(1, 8), OEV_STATION_NO_SERVICE]
    colors = ["#000000"] * 7 + [BUNDLE_BACKDROP_GREY]
    return categories(
        "station_category",
        values,
        colors,
        "point",
        symbol={"marker": {"color": "#000000", "size": 6}},
    )


def starting_points_style() -> dict[str, Any]:
    """The starting points of a catchment area: a map pin standing on the point."""
    return {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "marker": {
                "shape": "icon",
                "icon": "goat:foundation-marker",
                "color": "#000000",
                "size": 40,
                "anchor": "bottom",
                "allow_overlap": True,
            }
        },
    }
