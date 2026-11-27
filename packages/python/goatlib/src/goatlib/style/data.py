"""What a style needs to know about its data, read from DuckDB.

`describe` builds the `DataContext` the data checks read; `compute_stats`
computes what `compute.needed_stats` names, and `compute_into` writes it into a
style. Both compose the shared statistics
functions (`goatlib.analysis.statistics`), so a style's classes are the ones the
statistics processes return. The only part of `goatlib.style` that does IO, used
by processes; it reads the relation it is given and never filters it (12: scope
is the whole dataset).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_FLOOR, Context, Decimal
from typing import Any, Literal, cast

import duckdb

from goatlib.analysis.schemas.statistics import ClassBreakMethod, SortOrder
from goatlib.analysis.statistics import (
    calculate_class_breaks,
    calculate_feature_count,
    calculate_unique_values,
)
from goatlib.analysis.statistics.class_breaks import calculate_class_breaks_by_count
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.style.compute import (
    STABLE_DIGITS,
    Breaks,
    Presence,
    StatKey,
    StatResults,
    apply_computed,
    breaks_for_classes,
    needed_stats,
    settled_class_keys,
    stable,
)
from goatlib.style.context import DataContext, FieldInfo, FieldType
from goatlib.style.cql import as_text
from goatlib.style.h3 import value_sql
from goatlib.style.issues import Issue
from goatlib.utils.column_types import column_types, type_class

#: Fields with more distinct values than this have no value list (unknown_category
#: is not checked against them).
MAX_KNOWN_VALUES = 100

_METHODS = {
    "quantile": ClassBreakMethod.quantile,
    "equal_interval": ClassBreakMethod.equal_interval,
    "natural_breaks": ClassBreakMethod.natural_breaks,
    "std_dev": ClassBreakMethod.standard_deviation,
    "heads_and_tails": ClassBreakMethod.heads_and_tails,
    "geometric_interval": ClassBreakMethod.geometric_interval,
}
#: Methods that make fewer classes than asked by their definition (5.8): breaks
#: outside the data, a head that stops shrinking, geometric intervals over values
#: at or below 0. Only equal breaks count as merged.
_FEWER_BY_DESIGN = {"std_dev", "heads_and_tails", "geometric_interval"}
#: The values a scale can map: sqrt from 0, log above 0 (5.8).
_SCALE_WHERE = {"sqrt": "{} >= 0", "log": "{} > 0"}
_FIELD_TYPES = ("integer", "number", "boolean", "date", "datetime", "string")


def _field_types(con: duckdb.DuckDBPyConnection, relation: str) -> dict[str, FieldType]:
    """Field name to field type; time, geometry and object columns are not fields."""
    return {
        name: cast(FieldType, cls)
        for name, t in column_types(con, relation).items()
        if (cls := type_class(t)) in _FIELD_TYPES
    }


def _min_max(
    con: duckdb.DuckDBPyConnection, relation: str, field: str, where: str = "TRUE"
) -> tuple[float | None, float | None]:
    result = calculate_class_breaks(
        con, relation, field, num_breaks=0, where_clause=where
    )
    return stable(result.min), stable(result.max)


def describe(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    *,
    geometry: Literal["point", "line", "polygon"] | None,
    fields_used: set[str],
) -> DataContext:
    """The dataset as validation sees it. Only the fields a style uses
    (`data_check.referenced_fields`) get values (text and booleans) or a minimum
    and maximum (numbers); the others are described by type."""
    fields: dict[str, FieldInfo] = {}
    for name, ftype in _field_types(con, relation).items():
        info = FieldInfo(name=name, type=ftype)
        if name in fields_used and ftype in ("string", "boolean"):
            uv = calculate_unique_values(
                con, relation, name, limit=MAX_KNOWN_VALUES + 1
            )
            if uv.total <= MAX_KNOWN_VALUES:
                values = tuple(v.value for v in uv.values)
                info = FieldInfo(name=name, type=ftype, values=values)
        elif name in fields_used and ftype in ("integer", "number"):
            low, high = _min_max(con, relation, name)
            info = FieldInfo(name=name, type=ftype, min=low, max=high)
        fields[name] = info
    return DataContext(
        kind="vector",
        geometry=geometry,
        feature_count=calculate_feature_count(con, relation).count,
        fields=fields,
    )


def _category_value(value: str, ftype: str) -> Any:
    """A top value as category classes store it (5.1): text and whole numbers as
    they are, everything else as text the way the compiler compares it."""
    if ftype == "string":
        return value
    if ftype == "integer":
        return int(value)
    if ftype == "number":
        return as_text(float(value))
    return value


def _geometry_column(con: duckdb.DuckDBPyConnection, relation: str) -> str | None:
    return next(
        (
            n
            for n, t in column_types(con, relation).items()
            if type_class(t) == "geometry"
        ),
        None,
    )


def load_h3(con: duckdb.DuckDBPyConnection) -> None:
    """DuckDB's h3 community extension: baked into the images, installed from the
    community repository in local development."""
    try:
        con.execute("LOAD h3")
    except duckdb.Error:
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")


def _h3_stats(
    con: duckdb.DuckDBPyConnection, relation: str, keys: list[StatKey]
) -> dict[StatKey, Breaks | tuple[float | None, float | None]]:
    """The cell values of H3 keys sharing one value (op and field), per resolution:
    breaks for a method, else their range; none for a relation without geometry.

    The points' locations and values are read once; each resolution then groups
    them by the cell that contains each point (as `cell_sql`, which geoapi's
    tiles use). A coarse cell is no sum of its children's cells: they do not
    nest. The cells of a resolution are a table, as the class methods read
    them more than once."""
    geometry = _geometry_column(con, relation)
    if geometry is None:
        return {key: (None, None) for key in keys}
    _, op, field = keys[0][:3]
    load_h3(con)
    column = f"CAST({quote_identifier(field)} AS DOUBLE)" if field else "NULL"
    point = f"ST_Centroid({quote_identifier(geometry)})"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE goat_h3_base AS
        SELECT ST_Y({point}) AS lat, ST_X({point}) AS lng, {column} AS v
        FROM {relation}
        WHERE {quote_identifier(geometry)} IS NOT NULL
    """)
    out: dict[StatKey, Breaks | tuple[float | None, float | None]] = {}
    try:
        for key in keys:
            resolution, method, count = int(key[3]), key[4], key[5]
            con.execute(f"""
                CREATE OR REPLACE TEMP TABLE goat_h3_cells AS
                SELECT value FROM (
                    SELECT h3_latlng_to_cell(lat, lng, {resolution}) AS cell,
                           {value_sql(op, "v" if field else None)} AS value
                    FROM goat_h3_base GROUP BY cell
                ) WHERE value IS NOT NULL
            """)
            if method in _METHODS:
                n = int(count)
                result = calculate_class_breaks(
                    con, "goat_h3_cells", "value", _METHODS[method], num_breaks=n - 1
                )
                expected = len(result.breaks) + 1 if method in _FEWER_BY_DESIGN else n
                out[key] = breaks_for_classes(
                    result.breaks, result.min, result.max, expected
                )
            else:
                out[key] = _min_max(con, "goat_h3_cells", "value")
    finally:
        con.execute("DROP TABLE IF EXISTS goat_h3_cells")
        con.execute("DROP TABLE IF EXISTS goat_h3_base")
    return out


def compute_stats(
    con: duckdb.DuckDBPyConnection, relation: str, keys: list[StatKey]
) -> StatResults:
    """The statistics `keys` name, each once, over the whole relation. Keys whose
    field is missing or of the wrong type are left out: the data checks report
    those (`unknown_field`, `field_type_mismatch`)."""
    types = _field_types(con, relation)
    out: dict[StatKey, Any] = {}
    h3: dict[tuple[str, ...], list[StatKey]] = {}
    # How many different values a field has, where the most frequent were asked.
    distinct: dict[str, int] = {}
    for key in dict.fromkeys(keys):
        if key[0] == "presence":
            continue
        if key[0] == "h3":
            # A sum or mean over a field the data lacks or holds as text is left
            # to the checks.
            if not key[2] or types.get(key[2]) in ("integer", "number"):
                h3.setdefault(key[1:3], []).append(key)
            continue
        kind, field = key[0], key[1]
        ftype = types.get(field)
        numeric = ftype in ("integer", "number")
        if kind == "breaks" and numeric and key[4:5] == ("fit",):
            out[key] = fitted_breaks(
                con, relation, field, int(key[3]), centre=key[5:6] == ("centre",)
            )
        elif kind == "breaks" and numeric and key[2] in _METHODS:
            count = int(key[3])
            result = calculate_class_breaks(
                con, relation, field, _METHODS[key[2]], num_breaks=count - 1
            )
            expected = len(result.breaks) + 1 if key[2] in _FEWER_BY_DESIGN else count
            out[key] = breaks_for_classes(
                result.breaks, result.min, result.max, expected
            )
        elif kind == "top" and ftype is not None:
            uv = calculate_unique_values(
                con, relation, field, order=SortOrder.descendent, limit=int(key[2])
            )
            out[key] = [(_category_value(v.value, ftype), v.count) for v in uv.values]
            distinct[field] = uv.total
        elif kind == "range" and numeric:
            where = "TRUE"
            if len(key) > 2 and key[2] in _SCALE_WHERE:
                where = _SCALE_WHERE[key[2]].format(quote_identifier(field))
            out[key] = _min_max(con, relation, field, where)
    for group in h3.values():
        out.update(_h3_stats(con, relation, group))
    for key in dict.fromkeys(keys):
        ftype = types.get(key[1]) if key[0] == "presence" else None
        if ftype is not None:
            out[key] = _presence(con, relation, key, ftype, distinct)
    return out


_FLOOR = Context(prec=STABLE_DIGITS, rounding=ROUND_FLOOR)


def _held(value: float) -> float:
    """A break on a data value, `stable`, and never above the value: rounded up,
    it would leave the value's features in the class below."""
    rounded = stable(value)
    return rounded if rounded <= value else float(_FLOOR.plus(Decimal(value)))


def _cuts(values: Any, low: float) -> tuple[float, ...]:
    """Breaks on data `values` (`_held`), sorted, each once, above the minimum
    `low`: values that read alike to 12 digits are one."""
    return tuple(sorted({b for b in map(_held, values) if b > low}))


@dataclass(frozen=True)
class _Fitted:
    """Fitted classes of the values on one side: their breaks, the values'
    minimum and maximum, and whether the first class holds the minimum alone."""

    breaks: tuple[float, ...]
    min: float | None
    max: float | None
    first_alone: bool = False


def _fit(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    n: int,
    side: str = "TRUE",
) -> _Fitted:
    """At most `n` quantile classes over the field's finite values that meet
    `side`, each holding a feature (the specification's 5.2, "Fit to the
    data"). One class per value where there are at most `n` values. Otherwise
    a value on which quantile classes would lose a class gets a class of its
    own (`_own_values`), and the other values take quantile breaks moved up
    onto their next value (`_fitted_rest`). Where those make more than `n`
    classes in all, the least frequent own value gives its class back."""
    column = quote_identifier(field)
    value = f"CAST({column} AS DOUBLE)"
    rows = f"{column} IS NOT NULL AND isfinite({column}) AND ({side})"
    distinct, low, high, after_low, top = con.execute(
        f"""WITH f AS (
                SELECT {value} AS v, count(*) AS n FROM {relation}
                WHERE {rows} GROUP BY 1)
            SELECT (SELECT count(*) FROM f), (SELECT min(v) FROM f),
                   (SELECT max(v) FROM f),
                   (SELECT min(v) FROM f WHERE v > (SELECT min(v) FROM f)),
                   (SELECT list(v) FROM (SELECT v FROM f ORDER BY n DESC, v LIMIT ?))""",
        [n + 1],
    ).fetchone()
    if not distinct:
        return _Fitted((), None, None)
    if distinct <= n:
        breaks = _cuts(top, low)
        return _Fitted(breaks, low, high, bool(breaks))
    own = _own_values(con, relation, field, side, n)
    while True:
        breaks = _fitted_rest(con, relation, field, side, own, n, low, high)
        if breaks is not None:
            alone = bool(breaks) and breaks[0] == _held(after_low)
            return _Fitted(breaks, low, high, alone)
        rows_of = dict(
            con.execute(
                f"SELECT {value}, count(*) FROM {relation} WHERE {rows} "
                f"AND {value} IN ({', '.join('?' for _ in own)}) GROUP BY 1",
                own,
            ).fetchall()
        )
        own.remove(min(own, key=lambda v: (rows_of.get(v, 0), -v)))


#: A quantile break interpolated between two equal values can miss them in
#: the last digits: a break this close (relative) below a value moves onto it.
_NEAR = 1e-12


def _others(field: str, side: str, own: list[float]) -> str:
    """The rows of `side` without the `own` values (their `?` in order)."""
    value = f"CAST({quote_identifier(field)} AS DOUBLE)"
    marks = ", ".join("?" for _ in own)
    return f"({side}) AND {value} NOT IN ({marks})" if own else f"({side})"


def _own_values(
    con: duckdb.DuckDBPyConnection, relation: str, field: str, side: str, n: int
) -> list[float]:
    """The values on which quantile classes would lose a class: with k classes
    left for the values not yet taken, a quantile break on their lowest or
    highest value or two breaks on one value. Each round asks one quantile
    over the values left and takes every such value; the rounds go on while
    one finds a value and at least 2 classes are left."""
    own: list[float] = []
    while (k := n - len(own)) >= 2:
        result = calculate_class_breaks_by_count(
            con,
            relation,
            field,
            ClassBreakMethod.quantile,
            [k - 1],
            where_clause=_others(field, side, own),
            params=own or None,
        )[k - 1]
        if result.min is None or result.min == result.max:
            break
        # A break interpolated between two equal values can miss them in the
        # last digits: breaks compare as `stable` numbers.
        raw = [stable(float(b)) for b in result.breaks]
        ends = {stable(float(v)): float(v) for v in (result.min, result.max)}
        lost = {ends.get(b, b) for b in raw if b in ends or raw.count(b) > 1}
        inner = sorted(b for b in lost if b not in ends.values())
        if inner:
            # Each break's nearest value, the lower of two as near, so the
            # order of the rows never decides.
            value = f"CAST({quote_identifier(field)} AS DOUBLE)"
            on = dict(
                con.execute(
                    f"""SELECT b, first(v ORDER BY abs(v - b), v) FROM (
                            SELECT DISTINCT {value} AS v FROM {relation}
                            WHERE {_others(field, side, own)}
                              AND {value} IS NOT NULL AND isfinite({value})),
                        (SELECT unnest(?::DOUBLE[]) AS b) GROUP BY b""",
                    [*own, inner],
                ).fetchall()
            )
            lost = {on.get(b, b) if b in inner else b for b in lost}
        new = sorted(lost - set(own))
        if not new:
            break
        own.extend(new)
    return own


def _fitted_rest(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    side: str,
    own: list[float],
    n: int,
    low: float,
    high: float,
) -> tuple[float, ...] | None:
    """The breaks of `_fit` around the `own` values' classes: each own value
    and the value after it, and the quantile breaks of the other values for kk
    classes, moved up onto their next value; of every kk from 1 to `n`, the one
    with the most classes in all that are at most `n`, then the kk nearest to
    the classes left beside the own values, then the smaller. None where no kk
    gives at most `n`. One call for the quantiles of every count, one query for
    the values they move onto and the value after each own one."""
    column = quote_identifier(field)
    value = f"CAST({column} AS DOUBLE)"
    quantiles = calculate_class_breaks_by_count(
        con,
        relation,
        field,
        ClassBreakMethod.quantile,
        [kk - 1 for kk in range(1, n + 1)],
        where_clause=_others(field, side, own),
        params=own or None,
    )
    wanted = sorted({float(b) for r in quantiles.values() for b in r.breaks})
    found = con.execute(
        f"""WITH v AS (
                SELECT DISTINCT {value} AS v FROM {relation}
                WHERE {column} IS NOT NULL AND isfinite({column}) AND ({side})),
            b AS (SELECT unnest(?::DOUBLE[]) AS b),
            w AS (SELECT unnest(?::DOUBLE[]) AS w)
            SELECT 'b', b.b, min(v.v) FROM b JOIN v ON v.v >= b.b - abs(b.b) * ?
            WHERE NOT list_contains(?::DOUBLE[], v.v) GROUP BY b.b
            UNION ALL
            SELECT 'w', w.w, min(v.v) FROM w JOIN v ON v.v > w.w GROUP BY w.w""",
        [wanted, own, _NEAR, own],
    ).fetchall()
    moved = {at: to for kind, at, to in found if kind == "b"}
    fixed = {*own, *(to for kind, _, to in found if kind == "w")}
    left = n - len(own)
    best: tuple[tuple[int, int, int], tuple[float, ...]] | None = None
    for kk in range(1, n + 1):
        cuts = {moved.get(float(b)) for b in quantiles[kk - 1].breaks} | fixed
        breaks = _cuts((b for b in cuts if b is not None and b <= high), low)
        if len(breaks) + 1 > n:
            continue
        rank = (len(breaks), -abs(kk - left), -kk)
        if best is None or rank > best[0]:
            best = (rank, breaks)
    return best[1] if best is not None else None


def fitted_breaks(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    count: int,
    *,
    centre: bool = False,
) -> Breaks:
    """Quantile classes fitted to the data (`fit`, the specification's 5.2): at
    most `count`, every class holding a feature (`_fit`). With `centre` (a
    diverging palette) and values on both sides of 0, the values below 0 and
    those from 0 up are fitted apart, each into at most `count // 2` classes;
    0 is a break, and each class's place in the palette (`Breaks.positions`)
    gives the classes below 0 the colors before the middle one, a class that
    holds 0 alone the middle one, and the classes above 0 those after it."""
    half = count // 2
    if centre and half >= 1:
        column = f"CAST({quote_identifier(field)} AS DOUBLE)"
        below = _fit(con, relation, field, half, f"{column} < 0")
        above = _fit(con, relation, field, half, f"{column} >= 0")
        if below.min is not None and above.max is not None and above.max > 0:
            a = len(below.breaks) + 1
            zero = above.min == 0 and above.first_alone
            b = len(above.breaks) + 1 - zero
            return Breaks(
                (*below.breaks, 0.0, *above.breaks),
                stable(below.min),
                stable(above.max),
                False,
                (
                    *range(half - a, half),
                    *((half,) if zero else ()),
                    *range(half + 1, half + 1 + b),
                ),
            )
    whole = _fit(con, relation, field, count)
    return Breaks(whole.breaks, stable(whole.min), stable(whole.max), False)


def _presence(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    key: StatKey,
    ftype: str,
    distinct: dict[str, int],
) -> Presence:
    """Whether the field has rows without a value, and for categories whether it
    has values beside the listed ones (`("presence", field, "in", *values)`) or
    more values than the most frequent asked for (`"top", count`): one count
    over the field, the number of its values taken from the top values' query."""
    field, rest = key[1], key[2:]
    column = quote_identifier(field)
    gaps = f"count(*) - count({column})"
    if rest[:1] == ("in",):
        numeric = ftype in ("integer", "number")
        listed: list[Any] = []
        for text in rest[1:]:
            if not numeric:
                listed.append(text)
                continue
            try:
                listed.append(float(text))
            except ValueError:
                pass
        value = f"CAST({column} AS DOUBLE)" if numeric else f"CAST({column} AS VARCHAR)"
        marks = ", ".join("?" for _ in listed)
        beside = (
            f"count(*) FILTER (WHERE {column} IS NOT NULL AND {value} NOT IN ({marks}))"
            if listed
            else f"count({column})"
        )
        row = con.execute(f"SELECT {gaps}, {beside} FROM {relation}", listed).fetchone()
        return Presence(no_data=row[0] > 0, other=row[1] > 0)
    row = con.execute(f"SELECT {gaps} FROM {relation}").fetchone()
    if rest[:1] == ("top",):
        values = distinct.get(field)
        if values is None:
            values = con.execute(
                f"SELECT count(DISTINCT {column}) FROM {relation}"
            ).fetchone()[0]
        return Presence(no_data=row[0] > 0, other=values > int(rest[1]))
    return Presence(no_data=row[0] > 0)


def compute_into(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    document: dict[str, Any],
    *,
    geometry: str | None,
    fingerprint: str,
) -> tuple[dict[str, Any], list[Issue]]:
    """A copy of `document` with the values the server computes (classes,
    domains) written in from the relation's data and stamped with `fingerprint`,
    and the notes (12). The relation is read only when the style needs values;
    what the server wrote into parts that need none any more is removed."""
    settled = settled_class_keys(document, fingerprint)
    keys = [key for key in needed_stats(document) if key not in settled]
    return apply_computed(
        document,
        compute_stats(con, relation, keys) if keys else {},
        geometry=geometry,
        fingerprint=fingerprint,
        at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
