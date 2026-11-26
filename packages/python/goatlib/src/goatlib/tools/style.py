"""GOAT Style documents for the layers tools create (spec 17).

Builders for the looks tools give their results, on top of `goatlib.style`: a
classification the server computes (`classified`), the default of a result
whose value is a number per feature (`numeric_default`), fixed categories
(`categories`), bands of a distance or travel cost (`bands`), and the few
looks tools and bundles always use. Classes of a `classified` style are
filled from the result data by the tool runner
(`BaseToolRunner.computed_style`), like any style the server computes, once
`fit_classes` has fitted the count it asks for to the result; `with_decimals`
then gives the tool's own classes the decimals they need.
"""

import copy
import logging
import math
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any, Iterable

import duckdb

from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.i18n import DEFAULT_LANGUAGE, get_translator
from goatlib.style.check import MAIN_COLOR
from goatlib.style.colors import sample_colors
from goatlib.style.compute import Breaks
from goatlib.style.context import DataContext
from goatlib.style.data import compute_stats
from goatlib.style.defaults import default_style
from goatlib.style.ids import assign_ids
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.utils.column_types import column_types, type_class

logger = logging.getLogger(__name__)

#: CARTO's sequential palettes, which goatlib's palette catalogue does not carry.
EMRLD = ["#d3f2a3", "#97e196", "#6cc08b", "#4c9b82", "#217a79", "#105965", "#074050"]
TEAL = ["#d1eeea", "#a8dbd9", "#85c4c9", "#68abb8", "#4f90a6", "#3b738f", "#2a5674"]
SUNSET = ["#f3e79b", "#fac484", "#f8a07e", "#eb7f86", "#ce6693", "#a059a0", "#5c53a5"]

#: Classes a heatmap-like result is split into.
CLASS_COUNT = 7

#: Features without a value: the grey the style panel gives a new color
#: classification.
NO_DATA_GREY = "#cccccc"

#: The most decimals a number format takes.
MAX_DECIMALS = 10


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
    # A tool's polygons draw no outline unless `symbol` gives one.
    if "outline" in doc["symbol"]:
        doc["symbol"]["outline"] = False
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
    from the data. The color without a class is the palette's middle, also where
    `symbol` gives the main part other properties."""
    part = _part(geometry)
    parts = {**(symbol or {})}
    parts[part] = {"color": sample_colors(palette, 1)[0], **parts.get(part, {})}
    doc = styled(geometry, parts)
    doc["classify"] = [
        {"field": field, "method": method, "count": count, "palette": palette}
    ]
    return assign_ids(doc)


def style_title(key: str, **values: str) -> str:
    """The legend title `key` of goatlib's translations (`style_titles`), in
    English, with each `{name}` replaced by its value."""
    text = get_translator(DEFAULT_LANGUAGE).resolve_key(f"style_titles.{key}") or key
    for name, value in values.items():
        text = text.replace("{" + name + "}", value)
    return text


def numeric_default(
    field: str,
    palette: str | list[str],
    geometry: str | None,
    title: str,
    *,
    reverse: bool = False,
    unit: str | None = None,
    count: int = CLASS_COUNT,
    symbol: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The default of a result whose value is a number per feature: quantile
    classes of `field` (`classified`), the ramp turned around with `reverse`,
    the legend's title and unit, and grey for features without a value. The
    number format follows from the computed classes (`with_decimals`)."""
    doc = classified(field, palette, geometry, count=count, symbol=symbol)
    c = doc["classify"][0]
    if reverse:
        c["reverse"] = True
    c["title"] = title
    if unit:
        c["unit"] = unit
    c["no_data"] = {_part(geometry): {"color": NO_DATA_GREY}}
    return doc


def statistic_title(stat: FieldStatistic, *, area_weighted: bool = False) -> str:
    """The legend title of a statistic: its custom result name as given, else
    the operation and the source field in words."""
    if stat.result_name:
        return stat.result_name
    title = style_title(stat.operation.value, field=stat.field or "")
    return style_title("area_weighted", title=title) if area_weighted else title


def only_negative(runner: Any, relation: str, field: str) -> bool:
    """Whether `field` holds a value below 0 and none above, read with the
    runner's connection; False where the result cannot be read, and without
    a warning where it has no such column (the run's style check reports
    that)."""
    column = quote_identifier(field)
    try:
        if field not in column_types(runner.duckdb_con, relation):
            return False
        low, high = runner.duckdb_con.execute(
            f"SELECT min({column}), max({column}) FROM {relation}"
        ).fetchone()
        return low is not None and low < 0 and high <= 0
    except Exception:  # the ramp as it is
        logger.warning("Reading the result's value range failed", exc_info=True)
        return False


def statistic_default(
    runner: Any,
    stat: FieldStatistic,
    field: str,
    palette: str | list[str],
    geometry: str | None,
    relation: str,
    *,
    area_weighted: bool = False,
    negative: bool | None = None,
) -> dict[str, Any]:
    """The default of a statistics tool: its first statistic's column `field`
    (`numeric_default`) in the tool's sequential palette, turned around where
    the column holds only negative values (`negative`, read from `relation`
    when not given), so the value farthest from 0 is the darkest."""
    reverse = stat.operation != StatisticOperation.count and (
        only_negative(runner, relation, field) if negative is None else negative
    )
    return numeric_default(
        field,
        palette,
        geometry,
        statistic_title(stat, area_weighted=area_weighted),
        reverse=reverse,
    )


#: Enough digits to round any float to `MAX_DECIMALS` decimals.
_ROUNDING = Context(prec=400)


def _rounded(value: float, decimals: int) -> Decimal:
    """`value` rounded half away from 0, as the legend prints it."""
    return Decimal(value).quantize(
        Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP, context=_ROUNDING
    )


def decimals_for(bounds: Iterable[Any]) -> int:
    """The fewest decimals, at most `MAX_DECIMALS`, at which the distinct finite
    `bounds` still read in increasing order and none other than 0 reads 0."""
    values = sorted(
        {
            float(b)
            for b in bounds
            if isinstance(b, (int, float)) and not isinstance(b, bool)
            if math.isfinite(b)
        }
    )
    for decimals in range(MAX_DECIMALS + 1):
        shown = [_rounded(v, decimals) for v in values]
        if all(a < b for a, b in zip(shown, shown[1:])) and all(
            s != 0 for v, s in zip(values, shown) if v != 0
        ):
            return decimals
    return MAX_DECIMALS


def with_decimals(document: dict[str, Any]) -> dict[str, Any]:
    """A computed style with a number format on each numeric classification
    that has classes and no format of its own: the decimals its domain's
    minimum, class breaks and domain's maximum need (`decimals_for`)."""
    classify = document.get("classify")
    if not isinstance(classify, list):
        return document
    out, changed = [], False
    for c in classify:
        domain = (
            (c.get("computed") or {}).get("domain") if isinstance(c, dict) else None
        )
        if (
            domain
            and c.get("method") in NUMERIC_METHODS
            and c.get("classes")
            and "format" not in c
        ):
            breaks = [k.get("from") for k in c["classes"] if isinstance(k, dict)]
            c = {**c, "format": {"decimals": decimals_for([*domain, *breaks])}}
            changed = True
        out.append(c)
    return _with_classify(document, out) if changed else document


def _asks_for_classes(c: Any) -> bool:
    """A numeric classification with a count: what `classified` asks for. Only
    the style a tool builds in its run is fitted (`BaseToolRunner.computed_style`
    with `fit`), so this does not tell a tool's style from anyone else's."""
    return (
        isinstance(c, dict)
        and c.get("method") in NUMERIC_METHODS
        and isinstance(c.get("field"), str)
        and isinstance(c.get("count"), int)
        and not isinstance(c.get("count"), bool)
    )


def _classes_drawn(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    c: dict[str, Any],
    counts: tuple[int, ...],
) -> dict[int, tuple[int, int]]:
    """Per count, the classes the shared break code makes that hold a feature
    (from inclusive, to exclusive) and those left empty, counted for all counts
    in one pass over the data."""
    breaks: dict[int, tuple[float, ...]] = {}
    for count in counts:
        key = ("breaks", c["field"], c["method"], str(count))
        found = compute_stats(con, relation, [key]).get(key)
        if isinstance(found, Breaks) and found.min is not None:
            breaks[count] = found.breaks
    if not breaks:
        return {count: (0, 0) for count in counts}
    column = quote_identifier(c["field"])
    held = ", ".join(
        "count(DISTINCT "
        + (" + ".join(f"({column} >= ?)::INTEGER" for _ in b) or "0")
        + ")"
        for b in breaks.values()
    )
    row = con.execute(
        f"SELECT {held} FROM {relation} WHERE {column} IS NOT NULL",
        [v for b in breaks.values() for v in b],
    ).fetchone()
    out = {count: (0, 0) for count in counts}
    for (count, b), holding in zip(breaks.items(), row):
        out[count] = (holding, len(b) + 1 - holding)
    return out


def _fitted_count(
    con: duckdb.DuckDBPyConnection, relation: str, c: dict[str, Any]
) -> int | None:
    """The count the classification stores: the count asked for while the field
    has at least as many distinct values. With fewer, of the count asked for and
    the number of values the one whose classes hold more features
    (`_classes_drawn`), then the one with fewer empty classes, then the smaller;
    1 when that holds a single class or the field has one value or none. Tied values may still draw fewer classes
    than the count, the same on every recompute. None where there is nothing to
    fit: a field that is not a number in the data (the checks report it), or no
    rows, whose classes are computed when data arrives."""
    field, wish = c["field"], c["count"]
    if type_class(column_types(con, relation).get(field, "")) not in (
        "integer",
        "number",
    ):
        return None
    column = quote_identifier(field)
    # The distinct values are counted only up to one more than the wish.
    rows, values = con.execute(
        f"""SELECT EXISTS (SELECT 1 FROM {relation}),
                   (SELECT count(*) FROM (
                       SELECT DISTINCT {column} FROM {relation}
                       WHERE {column} IS NOT NULL LIMIT {wish + 1}))"""
    ).fetchone()
    if not rows:
        return None
    if values >= wish:
        return wish
    if values <= 1:
        return 1
    drawn = _classes_drawn(con, relation, c, (wish, values))
    # More classes holding a feature, then fewer empty ones, then the smaller count.
    best = max(drawn, key=lambda k: (drawn[k][0], -drawn[k][1], -k))
    return best if drawn[best][0] > 1 else 1


def fit_classes(
    con: duckdb.DuckDBPyConnection, relation: str, document: dict[str, Any]
) -> dict[str, Any]:
    """The style a tool asks for in its run with the counts of its numeric
    classifications fitted to the result (`_fitted_count`); a classification
    left with one class is left out, so the layer draws in the style's own
    color."""
    classify = document.get("classify")
    if not isinstance(classify, list) or not any(map(_asks_for_classes, classify)):
        return document
    kept = []
    for c in classify:
        count = _fitted_count(con, relation, c) if _asks_for_classes(c) else None
        if count is None:
            kept.append(c)
        elif count > 1:
            kept.append({**c, "count": count})
    return _with_classify(document, kept)


def without_single_classes(document: dict[str, Any]) -> dict[str, Any]:
    """A fitted style, once computed, without the numeric classifications whose
    breaks all fell together into one class: the style's own color instead of a
    class list of one."""
    classify = document.get("classify")
    if not isinstance(classify, list):
        return document
    kept = [
        c
        for c in classify
        if not (_asks_for_classes(c) and len(c.get("classes") or []) == 1)
    ]
    return document if len(kept) == len(classify) else _with_classify(document, kept)


def _with_classify(document: dict[str, Any], classify: list[Any]) -> dict[str, Any]:
    out = {**document, "classify": classify}
    if not classify:
        del out["classify"]
    return out


def categories(
    field: str,
    values: list[Any],
    palette: str | list[str],
    geometry: str | None,
    *,
    symbol: dict[str, Any] | None = None,
    title: str | None = None,
    reverse: bool = False,
) -> dict[str, Any]:
    """A style with one class per value of `field`, in the order given, colored
    along the palette (from its end with `reverse`, as the server and the style
    panel color classes of a reversed palette), and the legend's `title` where
    given. The color without a class is the middle class's, also where
    `symbol` gives the main part other properties. The classes are fixed:
    nothing is recomputed."""
    part = _part(geometry)
    colors = sample_colors(palette, len(values), reverse=reverse)
    parts = {**(symbol or {})}
    parts[part] = {
        "color": colors[len(colors) // 2] if colors else None,
        **parts.get(part, {}),
    }
    doc = styled(geometry, parts)
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
        if reverse:
            classification["reverse"] = True
    if title:
        classification["title"] = title
    doc["classify"] = [classification]
    return assign_ids(doc)


def bands(
    field: str,
    steps: list[int],
    palette: str | list[str],
    geometry: str | None,
    title: str,
    unit: str,
    *,
    symbol: dict[str, Any] | None = None,
    reverse: bool = False,
) -> dict[str, Any]:
    """Bands of a distance or travel cost in whole `unit`s: one class per step
    (`categories`, the palette turned around with `reverse`), the legend's
    title and unit, no decimals, and the first step, the smallest, drawn on
    top."""
    doc = categories(
        field, steps, palette, geometry, symbol=symbol, title=title, reverse=reverse
    )
    c = doc["classify"][0]
    c["unit"] = unit
    c["format"] = {"decimals": 0}
    doc["order"] = {"by": "classes"}
    return doc


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
    if key[0] == "xplan":
        # Imported here: the bundles package imports this module.
        from goatlib.bundles.importers.xplan.styles import xplan_role_style

        doc = xplan_role_style(key[1], geometry, seed=seed)
        if doc is not None:
            return doc
    symbol = BUNDLE_ROLE_SYMBOLS.get(key)
    if symbol is None:
        return default_style(DataContext(kind="vector", geometry=geometry), seed=seed)
    return {"version": "1.0.0", "kind": "vector", "symbol": copy.deepcopy(symbol)}


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
        "pt_class_label",
        labels,
        [colors[label] for label in labels],
        "polygon",
        title=style_title("pt_class"),
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
        title=style_title("station_category"),
    )


def starting_points_style() -> dict[str, Any]:
    """The starting points of a catchment area: a map pin standing on the point."""
    return {
        "version": "1.0.0",
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
