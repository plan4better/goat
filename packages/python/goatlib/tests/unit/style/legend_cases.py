"""The legend test cases: GOAT Style documents over a made-up dataset.

A table of style dimensions is expanded into a small set of cases that holds
every pair of values that can occur together (all-pairs). Each case is a layer
style; the values the server computes (classes, domains) are written in by
`apply_computed` from the made-up table, as on a real dataset, and every
document is validated. The web's legend tests read the result from
`fixtures/legend_cases.json` (`test_legend_cases.py` keeps the file current).

No field name, value, title or caption comes from a real dataset.
"""

import copy
import itertools
from typing import Any, Callable

import duckdb
from goatlib.style.compute import apply_computed, needed_stats
from goatlib.style.data import compute_stats, describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.validate import validate

RELATION = "legend_synthetic"
FINGERPRINT = "synthetic-v1"
AT = "2026-01-01T00:00:00Z"

LONG = [f"{word} " * 40 for word in ("alpha", "beta", "gamma", "delta")]
LONG = [text.strip() for text in LONG]

#: Field name and type, as the web's compiler takes them.
FIELDS = {
    "category": "string",
    "amount": "number",
    "rate": "number",
    "flag": "boolean",
    "year": "integer",
    "constant": "number",
    "empty_number": "number",
    "empty_text": "string",
    "long_text": "string",
    "partial": "number",
    "partial_text": "string",
}


def synthetic(con: duckdb.DuckDBPyConnection) -> None:
    """The made-up table: 140 points on a grid, each field one kind of data."""
    con.execute("INSTALL spatial; LOAD spatial;")
    long_sql = ", ".join(f"'{text}'" for text in LONG)
    con.execute(f"""
        CREATE OR REPLACE TABLE {RELATION} AS
        SELECT
            i AS id,
            chr(65 + (i % 14)::INTEGER) AS category,
            ((i * 37) % 140) * 65.0 AS amount,
            ((i * 53) % 101) - 50.0 AS rate,
            (i % 3 = 0) AS flag,
            (2015 + i % 10)::INTEGER AS year,
            5.0 AS constant,
            NULL::DOUBLE AS empty_number,
            NULL::VARCHAR AS empty_text,
            ([{long_sql}])[1 + (i % 4)::INTEGER] AS long_text,
            CASE WHEN i % 5 = 0 THEN NULL ELSE ((i * 37) % 140) * 65.0 END AS partial,
            CASE WHEN i % 5 = 0 THEN NULL ELSE chr(65 + (i % 14)::INTEGER) END AS partial_text,
            ST_Point(11.0 + (i % 14) * 0.01, 48.0 + (i // 14) * 0.01) AS geom
        FROM range(140) r(i)
    """)


# --- dimensions ---------------------------------------------------------------------------------

Values = dict[str, str]

DIMENSIONS: dict[str, list[str]] = {
    "geometry": [
        "point_circle",
        "point_pin",
        "point_icon",
        "line",
        "polygon",
        "polygon_raised",
    ],
    "render": [
        "features",
        "heatmap",
        "heatmap_then_points",
        "cluster",
        "h3",
        "h3_then_points",
        "h3_classes",
        "h3_raised",
    ],
    "method": [
        "none",
        "categories",
        "categories_many",
        "categories_top",
        "quantile",
        "manual",
    ],
    "target": [
        "none",
        "color",
        "outline_color",
        "size",
        "opacity",
        "icon",
        "pattern",
        "dash",
        "height",
    ],
    "data": [
        "normal",
        "gaps",
        "negatives",
        "all_equal",
        "no_values",
        "field_missing",
        "long_text",
        "numbers",
        "boolean",
    ],
    "other": ["no", "yes"],
    "no_data": ["no", "yes"],
    "hidden_class": ["no", "yes"],
    "class_off_legend": ["no", "yes"],
    "names": ["no", "yes"],
    "unit": ["no", "yes"],
    "format": ["no", "yes"],
    "base": ["fixed", "by_zoom", "palette", "range"],
    "zoom": ["12", "8", "16", "4", "20"],
    "rules": ["none", "named", "off_legend", "hides"],
    "title": ["no", "yes"],
    "caption": ["no", "yes"],
    "second": ["none", "same_field", "other_field"],
}

POINTS = {"point_circle", "point_pin", "point_icon"}
POLYGONS = {"polygon", "polygon_raised"}
NUMERIC = {"quantile", "manual"}
CATEGORICAL = {"categories", "categories_many", "categories_top"}
#: Targets whose values are picked from a list: a palette or a range cannot make them.
CHOICES = {"icon", "pattern", "dash"}

Pair = Callable[[str, str], bool]

#: Value pairs that never go together, by the two dimensions (in `DIMENSIONS` order).
RULES: dict[tuple[str, str], Pair] = {
    # Heatmaps, clusters and H3 hexagons are ways to draw points.
    ("geometry", "render"): lambda g, r: r == "features" or g in POINTS,
    ("geometry", "target"): lambda g, t: not (
        (t == "icon" and g not in POINTS)
        or (t == "pattern" and g != "polygon")
        or (t == "dash" and g in POINTS)
        or (t == "height" and g != "polygon_raised")
        # A raised polygon has one opacity for the whole layer, and no outline.
        or (g == "polygon_raised" and t in ("opacity", "outline_color", "size", "dash"))
        # An icon alone has no outline.
        or (g == "point_icon" and t == "outline_color")
    ),
    ("method", "target"): lambda m, t: (m == "none") == (t == "none")
    and not (t in CHOICES and m in ("quantile", "categories_top"))
    and not (m == "categories_top" and t not in ("color", "outline_color")),
    ("method", "data"): lambda m, d: not (
        (m == "none" and d != "normal")
        or (m in CATEGORICAL and d in ("negatives", "all_equal"))
        or (m in NUMERIC and d in ("long_text", "numbers", "boolean"))
        # The server picks the top values: without values there are none to pick.
        or (m == "categories_top" and d in ("no_values", "field_missing"))
    ),
    **{
        ("method", flag): (lambda m, v: not (m == "none" and v == "yes"))
        for flag in (
            "other",
            "no_data",
            "hidden_class",
            "class_off_legend",
            "names",
            "unit",
        )
    },
    ("method", "format"): lambda m, f: not (f == "yes" and m not in NUMERIC),
    ("method", "second"): lambda m, s: not (m == "none" and s != "none"),
    ("geometry", "base"): lambda g, b: not (g == "polygon_raised" and b == "range"),
    ("target", "base"): lambda t, b: not (
        (b == "palette" and t == "color") or (b == "range" and t == "size")
    ),
    ("base", "second"): lambda b, s: not (b in ("palette", "range") and s != "none"),
    ("geometry", "second"): lambda g, s: not (g == "polygon_raised" and s != "none"),
    ("target", "second"): lambda t, s: not (t == "height" and s != "none"),
}


def compatible(values: Values) -> bool:
    """Whether no two of the assigned values exclude each other."""
    return all(
        rule(values[a], values[b])
        for (a, b), rule in RULES.items()
        if a in values and b in values
    )


def _fill(
    values: Values, open_pairs: set[tuple[tuple[str, str], tuple[str, str]]]
) -> Values | None:
    """`values` completed to a full compatible case, each open dimension taking the
    value that covers the most open pairs first; None when there is no such case."""
    name = next((d for d in DIMENSIONS if d not in values), None)
    if name is None:
        return values

    def gain(value: str) -> int:
        return sum(
            1
            for other, chosen in values.items()
            if _pair((name, value), (other, chosen)) in open_pairs
        )

    options = sorted(DIMENSIONS[name], key=lambda v: -gain(v))
    for value in options:
        candidate = {**values, name: value}
        if not compatible(candidate):
            continue
        done = _fill(candidate, open_pairs)
        if done is not None:
            return done
    return None


def _pair(
    a: tuple[str, str], b: tuple[str, str]
) -> tuple[tuple[str, str], tuple[str, str]]:
    return (a, b) if a < b else (b, a)


def all_pairs() -> tuple[list[Values], list[tuple[tuple[str, str], tuple[str, str]]]]:
    """Cases that hold every pair of values some case can hold, and the pairs no
    case can hold (their values exclude each other, alone or through a third)."""
    names = list(DIMENSIONS)
    open_pairs = {
        _pair((a, x), (b, y))
        for a, b in itertools.combinations(names, 2)
        for x in DIMENSIONS[a]
        for y in DIMENSIONS[b]
    }
    cases: list[Values] = []
    impossible = []
    for pair in sorted(open_pairs):
        if pair not in open_pairs:
            continue
        seed = dict(pair)
        case = _fill(seed, open_pairs) if compatible(seed) else None
        if case is None:
            impossible.append(pair)
            open_pairs.discard(pair)
            continue
        ordered = {name: case[name] for name in names}
        cases.append(ordered)
        for a, b in itertools.combinations(names, 2):
            open_pairs.discard(_pair((a, ordered[a]), (b, ordered[b])))
    return cases, impossible


# --- from a case to a style ----------------------------------------------------------------------

COLORS = [
    "#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d",
    "#1f78b4", "#b2df8a", "#fb9a99", "#cab2d6", "#ffff99", "#8dd3c7", "#bebada",
]  # fmt: skip
ICONS = [
    "goat:museum",
    "goat:park",
    "goat:swimming",
    "goat:hospital",
    "goat:playground",
]
PATTERNS = ["hatch_45", "hatch_135", "vertical", "horizontal", "cross", "grid", "dots"]
DASHES = ["solid", "dashed", "dotted", "dash_dot"]

GEOMETRY = {
    "point_circle": "point",
    "point_pin": "point",
    "point_icon": "point",
    "line": "line",
    "polygon": "polygon",
    "polygon_raised": "polygon",
}
MAIN = {"point": "marker", "line": "line", "polygon": "fill"}


#: The zoom the points of a heatmap or of H3 hexagons show from, where they do: between the cases' zooms.
POINTS_FROM = 14

#: How points are drawn other than as features. The hexagons are coarse enough to hold several points each.
RENDERS: dict[str, dict[str, Any]] = {
    "heatmap": {"type": "heatmap"},
    "heatmap_then_points": {"type": "heatmap", "points_from_zoom": POINTS_FROM},
    "cluster": {"type": "cluster"},
    "h3": {"type": "h3", "resolution": 6},
    "h3_then_points": {"type": "h3", "resolution": 6, "points_from_zoom": POINTS_FROM},
    "h3_classes": {
        "type": "h3",
        "resolution": 6,
        "value": {"op": "sum", "field": "amount"},
        "classify": {"method": "quantile", "count": 3},
    },
    "h3_raised": {
        "type": "h3",
        "resolution": 6,
        "value": {"op": "mean", "field": "amount"},
        "extrude": {"tallest": 800},
    },
}


def _symbol(kind: str) -> dict[str, Any]:
    if kind == "point_circle":
        return {
            "marker": {"shape": "circle", "color": "#3366cc", "size": 10},
            "outline": {"color": "#ffffff", "width": 1},
        }
    if kind == "point_pin":
        return {
            "marker": {
                "shape": "pin",
                "color": "#3366cc",
                "size": 24,
                "icon": "goat:park",
            },
            "outline": {"color": "#1a1a1a", "width": 1},
        }
    if kind == "point_icon":
        return {
            "marker": {
                "shape": "icon",
                "icon": "goat:park",
                "color": "#3366cc",
                "size": 18,
            }
        }
    if kind == "line":
        return {
            "line": {"color": "#3366cc", "width": 3},
            "casing": {"color": "#ffffff", "width": 1},
        }
    symbol: dict[str, Any] = {
        "fill": {"color": "#3366cc", "opacity": 0.8},
        "outline": {"color": "#555555", "width": 1},
    }
    if kind == "polygon_raised":
        symbol = {"fill": {"color": "#3366cc"}, "extrude": {"height": 20}}
    return symbol


def _target(target: str, geometry: str) -> str:
    """The property path a target names on a geometry."""
    main = MAIN[geometry]
    return {
        "color": f"{main}.color",
        "outline_color": "casing.color" if geometry == "line" else "outline.color",
        "size": {
            "point": "marker.size",
            "line": "line.width",
            "polygon": "outline.width",
        }[geometry],
        "opacity": f"{main}.opacity",
        "icon": "marker.icon",
        "pattern": "fill.pattern",
        "dash": "line.dash" if geometry == "line" else "outline.dash",
        "height": "extrude.height",
    }[target]


def _value(path: str, i: int, n: int) -> Any:
    """The value class `i` of `n` gives the property at `path`."""
    key = path.split(".")[1]
    share = i / max(n - 1, 1)
    if key == "color":
        return COLORS[i % len(COLORS)]
    if key == "icon":
        return ICONS[i % len(ICONS)]
    if key == "pattern":
        return PATTERNS[i % len(PATTERNS)]
    if key == "dash":
        return DASHES[i % len(DASHES)]
    if key == "opacity":
        return round(0.3 + 0.7 * share, 2)
    if key == "height":
        return 10 + 20 * i
    if path == "marker.size":
        return 6 + 2 * i
    return round(0.5 + i, 1)


def _range(path: str) -> list[float]:
    return {
        "marker.size": [4, 20],
        "line.width": [1, 8],
        "outline.width": [0.5, 4],
        "extrude.height": [5, 200],
    }.get(path, [0.2, 1])


def _record(path: str, value: Any) -> dict[str, Any]:
    part, key = path.split(".")
    return {part: {key: value}}


def _field(method: str, data: str) -> str:
    if data == "field_missing":
        return "missing_field"
    if method in NUMERIC:
        return {
            "normal": "amount",
            "gaps": "partial",
            "negatives": "rate",
            "all_equal": "constant",
            "no_values": "empty_number",
        }[data]
    return {
        "normal": "category",
        "gaps": "partial_text",
        "no_values": "empty_text",
        "long_text": "long_text",
        "numbers": "year",
        "boolean": "flag",
    }[data]


def _category_values(data: str, many: bool) -> list[list[Any]]:
    """The values of each written class; the second class holds two."""
    if data == "long_text":
        return [[LONG[0]], [LONG[1], LONG[2]], [LONG[3]]]
    if data == "numbers":
        years = [[2015], [2016, 2017], [2018]]
        return years + [[y] for y in range(2019, 2025)] if many else years
    if data == "boolean":
        return [[True], [False]]
    letters = [chr(65 + i) for i in range(14)]
    if many:
        return [[letter] for letter in letters]
    return [["A"], ["B", "C"], ["D"]]


def _breaks(data: str) -> list[float]:
    return [-20, 0, 20] if data == "negatives" else [2000, 4000, 6000]


def _classification(
    values: Values, geometry: str, target: str, field: str
) -> dict[str, Any]:
    method, data = values["method"], values["data"]
    path = _target(target, geometry)
    c: dict[str, Any] = {"field": field, "method": method}
    if target != "color":
        c["target"] = path
    if method in ("categories", "categories_many"):
        c["method"] = "categories"
        groups = _category_values(data, method == "categories_many")
        c["classes"] = [
            {"values": group, **_record(path, _value(path, i, len(groups)))}
            for i, group in enumerate(groups)
        ]
    elif method == "categories_top":
        c["method"] = "categories"
        c["count"] = 5
    elif method == "manual":
        breaks = _breaks(data)
        bounds = [None, *breaks, None]
        c["classes"] = [
            {
                **({"from": bounds[i]} if bounds[i] is not None else {}),
                **({"to": bounds[i + 1]} if bounds[i + 1] is not None else {}),
                **_record(path, _value(path, i, len(bounds) - 1)),
            }
            for i in range(len(bounds) - 1)
        ]
    else:
        c["count"] = 5
        if path.endswith("color"):
            c["palette"] = "colorbrewer:OrRd"
        else:
            c["range"] = _range(path)
    if values["other"] == "yes":
        c["other"] = _record(path, _value(path, 12, 14))
    if values["no_data"] == "yes":
        c["no_data"] = _record(path, _value(path, 13, 14))
    if values["unit"] == "yes":
        c["unit"] = "units"
    if values["format"] == "yes":
        c["format"] = {"decimals": 1, "thousands_separator": False}
    return c


def _second(values: Values, geometry: str, first_field: str) -> dict[str, Any] | None:
    """A second classification: of the same field (its classes as the first's) or
    of another, on a property the first does not set."""
    if values["second"] == "none":
        return None
    target = "color" if values["target"] != "color" else "size"
    if values["second"] == "same_field":
        c = _classification(
            {**values, "unit": "no", "format": "no"}, geometry, target, first_field
        )
        return {"id": "second", **c}
    path = _target(target, geometry)
    return {
        "id": "second",
        "field": "flag",
        "method": "categories",
        **({"target": path} if target != "color" else {}),
        "classes": [
            {"values": [True], **_record(path, _value(path, 4, 6))},
            {"values": [False], **_record(path, _value(path, 5, 6))},
        ],
    }


def _base(symbol: dict[str, Any], values: Values, geometry: str) -> None:
    """The base symbol's value form: fixed, by zoom, or by attribute."""
    main = symbol[MAIN[geometry]]
    size_path = _target("size", geometry)
    part, key = size_path.split(".")
    base = values["base"]
    if base == "by_zoom":
        main["color"] = {"zoom": [[8, "#fee8c8"], [16, "#e34a33"]]}
        if part in symbol:
            low, high = _range(size_path)
            symbol[part][key] = {"zoom": [[8, low], [16, high]]}
    elif base == "palette":
        main["color"] = {"field": "amount", "palette": "d3:viridis", "title": "Amount"}
    elif base == "range":
        symbol.setdefault(part, {})[key] = {
            "field": "amount",
            "range": _range(size_path),
            "scale": "sqrt",
        }


def _rules(values: Values, geometry: str) -> list[dict[str, Any]]:
    kind = values["rules"]
    if kind == "none":
        return []
    main = MAIN[geometry]
    if kind == "hides":
        return [
            {
                "id": "low",
                "name": "Low amounts",
                "when": {"op": "<", "args": [{"property": "amount"}, 100]},
                "visible": False,
            }
        ]
    return [
        {
            "id": "flagged",
            "name": "Flagged",
            **({"legend": False} if kind == "off_legend" else {}),
            "when": {"op": "=", "args": [{"property": "flag"}, True]},
            main: {"color": "#d7191c"},
        }
    ]


def to_style(values: Values) -> dict[str, Any]:
    """The style document of a case, before the server's values."""
    geometry = GEOMETRY[values["geometry"]]
    symbol = _symbol(values["geometry"])
    _base(symbol, values, geometry)
    doc: dict[str, Any] = {"version": 1, "kind": "vector", "symbol": symbol}
    if values["render"] != "features":
        doc["render"] = copy.deepcopy(RENDERS[values["render"]])
    if values["method"] != "none":
        field = _field(values["method"], values["data"])
        first = {
            "id": "first",
            **_classification(values, geometry, values["target"], field),
        }
        second = _second(values, geometry, field)
        doc["classify"] = [first, *([second] if second else [])]
    rules = _rules(values, geometry)
    if rules:
        doc["rules"] = rules
    legend = {
        **({"title": "Legend title"} if values["title"] == "yes" else {}),
        **(
            {"caption": "A caption under the title"}
            if values["caption"] == "yes"
            else {}
        ),
    }
    if legend:
        doc["legend"] = legend
    return doc


def _edit_classes(doc: dict[str, Any], values: Values) -> None:
    """What an author changes on the classes once they exist: names, a class hidden
    with the eye, a class left out of the legend."""
    for c in doc.get("classify", [])[:1]:
        classes = c.get("classes") or []
        if values["names"] == "yes":
            for i, k in enumerate(classes):
                k["name"] = f"Class {i + 1}"
        if values["hidden_class"] == "yes" and len(classes) > 1:
            classes[1]["visible"] = False
        if values["class_off_legend"] == "yes" and len(classes) > 2:
            classes[2]["legend"] = False


def build(con: duckdb.DuckDBPyConnection, values: Values) -> dict[str, Any]:
    """A case's style as it is stored: the server's values written in."""
    doc = to_style(values)
    geometry = GEOMETRY[values["geometry"]]
    keys = needed_stats(doc)
    doc, _notes = apply_computed(
        doc,
        compute_stats(con, RELATION, keys) if keys else {},
        geometry=geometry,
        fingerprint=FINGERPRINT,
        at=AT,
    )
    _edit_classes(doc, values)
    return doc


def issues(
    con: duckdb.DuckDBPyConnection, doc: dict[str, Any], geometry: str
) -> list[str]:
    """The errors validation answers for a case's style over the made-up table
    (warnings, as for more than 12 categories, leave a style valid)."""
    ctx = describe(con, RELATION, geometry=geometry, fields_used=referenced_fields(doc))
    found = validate(copy.deepcopy(doc), ctx)
    return sorted(f"{i.code} {i.path}" for i in found if i.level == "error")


def legend_cases(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """The fixture the web reads: the made-up fields and every case."""
    cases, _ = all_pairs()
    out = []
    for n, values in enumerate(cases, start=1):
        out.append(
            {
                "id": f"v{n:03d}",
                "values": values,
                "geometry": GEOMETRY[values["geometry"]],
                "zoom": int(values["zoom"]),
                "style": build(con, values),
            }
        )
    return {"fields": FIELDS, "cases": out}
