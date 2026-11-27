"""What a style needs to know about its data, read from DuckDB.

`describe` builds the `DataContext` the data checks read; `compute_stats`
computes what `compute.needed_stats` names, and `compute_into` writes it into a
style. Both compose the shared statistics
functions (`goatlib.analysis.statistics`), so a style's classes are the ones the
statistics processes return. The only part of `goatlib.style` that does IO, used
by processes; it reads the relation it is given and never filters it (12: scope
is the whole dataset).
"""

from collections.abc import Iterable
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
        elif kind == "single" and numeric:
            low, high = (float(b) if b else None for b in key[2:4])
            out[key] = class_singles(
                con, relation, field, [float(b) for b in key[4:]], low=low, high=high
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


def _zero(value: Any) -> Any:
    """`value` with a negative zero as 0: -0.0 and 0.0 are one value, and which
    one the data gives back depends on the order of its rows."""
    return 0.0 if value == 0 and isinstance(value, float) else value


def _held(value: float) -> float:
    """A break on a data value, `stable`, and never above the value: rounded up,
    it would leave the value's features in the class below."""
    rounded = _zero(stable(value))
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
    #: Every value, where the fit read them all (at most `n` values).
    values: tuple[float, ...] | None = None


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
    # The values are read only up to one more than `n`: all of them where
    # there are at most `n`.
    low, high, after_low, top = con.execute(
        f"""SELECT min(v), max(v),
                   min(v) FILTER (WHERE v > (
                       SELECT min({value}) FROM {relation} WHERE {rows})),
                   (SELECT list(v) FROM (
                       SELECT DISTINCT {value} AS v FROM {relation} WHERE {rows}
                       LIMIT ?))
            FROM (SELECT {value} AS v FROM {relation} WHERE {rows})""",
        [n + 1],
    ).fetchone()
    if low is None:
        return _Fitted((), None, None)
    if len(top) <= n:
        breaks = _cuts(top, low)
        return _Fitted(breaks, low, high, bool(breaks), tuple(top))
    own, known = _own_values(con, relation, field, side, n)
    rows_of: dict[float, int] | None = None
    while True:
        breaks = _fitted_rest(con, relation, field, side, own, n, low, high, known)
        if breaks is not None:
            alone = bool(breaks) and breaks[0] == _held(after_low)
            return _Fitted(breaks, low, high, alone)
        if rows_of is None:
            # Each own value's rows, read once: giving a class back changes
            # none of them.
            rows_of = dict(
                con.execute(
                    f"SELECT {value}, count(*) FROM {relation} WHERE {rows} "
                    f"AND {value} IN ({', '.join('?' for _ in own)}) GROUP BY 1",
                    own,
                ).fetchall()
            )
        counts = rows_of
        own.remove(min(own, key=lambda v: (counts.get(v, 0), -v)))
        known = None


@dataclass(frozen=True)
class _Quantiles:
    """Quantiles of one set of rows: their minimum and maximum (None without
    rows) and the quantile at each fraction asked."""

    min: float | None
    max: float | None
    at: dict[float, Any]

    def holds(self, count: int) -> bool:
        """Whether the quantile breaks of `count` breaks were asked."""
        return all(p in self.at for p in _fractions(count))

    def breaks(self, count: int) -> list[float]:
        """The quantile breaks of `count` breaks (`count + 1` classes)."""
        if self.min is None:
            return []
        return [float(self.at[p]) for p in _fractions(count) if self.at[p] is not None]


def _fractions(count: int) -> list[float]:
    """The fractions of `count` quantile breaks: 1/(count + 1) and on."""
    return [i / (count + 1) for i in range(1, count + 1)]


def _quantiles(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    where: str,
    params: list[float],
    counts: Iterable[int],
    known: _Quantiles | None = None,
) -> _Quantiles:
    """The quantile breaks of each number of breaks in `counts` over the
    field's finite values that meet `where` (its `?` are `params`), and their
    minimum and maximum: one query, one ordered-set aggregate over every
    fraction they need and `known` (quantiles of the same rows) lacks. Each
    fraction is a number literal cast to DOUBLE, read as
    `calculate_class_breaks` reads a fraction, so every break is the one that
    function gives."""
    column = quote_identifier(field)
    have = known.at if known is not None else {}
    wanted = sorted({p for c in counts for p in _fractions(c)} - have.keys())
    if known is not None and not wanted:
        return known
    terms = ", ".join(f"{p}::DOUBLE" for p in wanted)
    low, high, found = con.execute(
        f"""SELECT min({column}), max({column}),
                   {f"quantile_cont({column}, [{terms}])" if wanted else "NULL"}
            FROM {relation}
            WHERE ({where}) AND {column} IS NOT NULL AND isfinite({column})""",
        params,
    ).fetchone()
    at = {**have, **dict(zip(wanted, found or [None] * len(wanted)))}
    return _Quantiles(
        float(low) if low is not None else None,
        float(high) if high is not None else None,
        at,
    )


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
) -> tuple[list[float], _Quantiles | None]:
    """The values on which quantile classes would lose a class: with k classes
    left for the values not yet taken, a quantile break on their lowest or
    highest value or two breaks on one value. Each round asks one quantile
    over the values left and takes every such value; the rounds go on while
    one finds a value and at least 2 classes are left. Also the last round's
    quantiles where they are of the values left beside the values returned."""
    own: list[float] = []
    last: _Quantiles | None = None
    while (k := n - len(own)) >= 2:
        last = _quantiles(con, relation, field, _others(field, side, own), own, [k - 1])
        if last.min is None or last.min == last.max:
            break
        # A break interpolated between two equal values can miss them in the
        # last digits: breaks compare as `stable` numbers.
        raw = [stable(b) for b in last.breaks(k - 1)]
        ends = {stable(v): v for v in (last.min, last.max)}
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
        last = None
    return own, last


def _fitted_rest(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    side: str,
    own: list[float],
    n: int,
    low: float,
    high: float,
    known: _Quantiles | None = None,
) -> tuple[float, ...] | None:
    """The breaks of `_fit` around the `own` values' classes: each own value
    and the value after it, and the quantile breaks of the other values for kk
    classes, moved up onto their next value; of every kk from 1 to `n`, the one
    with the most classes in all that are at most `n`, then the kk nearest to
    the classes left beside the own values, then the smaller. None where no kk
    gives at most `n`.

    The kk of the classes left (`left`) that gives `n` classes in all ranks
    first, so where `known` (quantiles of the same values) holds that kk's
    quantiles and they give `n` classes, no other kk is asked. At most one
    query for the quantiles `known` lacks, every count's in one."""
    left = n - len(own)
    where = _others(field, side, own)
    moved: dict[float, float | None] = {}
    fixed: set[float] = set()

    def classes(kk: int, quantiles: _Quantiles) -> tuple[float, ...]:
        cuts = {moved.get(b) for b in quantiles.breaks(kk - 1)} | fixed
        return _cuts((b for b in cuts if b is not None and b <= high), low)

    shortcut = known is not None and 1 <= left <= n and known.holds(left - 1)
    if known is not None and shortcut:
        fixed = _moved(con, relation, field, side, own, known.breaks(left - 1), moved)
        if len(classes(left, known)) + 1 == n:
            return classes(left, known)
    quantiles = _quantiles(con, relation, field, where, own, range(n), known)
    wanted = {b for kk in range(1, n + 1) for b in quantiles.breaks(kk - 1)}
    if wanted - moved.keys() or not shortcut:
        fixed = _moved(
            con, relation, field, side, own, sorted(wanted - moved.keys()), moved
        )
    best: tuple[tuple[int, int, int], tuple[float, ...]] | None = None
    for kk in range(1, n + 1):
        breaks = classes(kk, quantiles)
        if len(breaks) + 1 > n:
            continue
        rank = (len(breaks), -abs(kk - left), -kk)
        if best is None or rank > best[0]:
            best = (rank, breaks)
    return best[1] if best is not None else None


def _moved(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    side: str,
    own: list[float],
    breaks: list[float],
    moved: dict[float, float | None],
) -> set[float]:
    """Each quantile break of the values beside the `own` values moved onto
    the next value at or above it (a break within `_NEAR` below a value moves
    onto it), written into `moved` (None where no value is), and the own
    values with the value after each: one query over the rows."""
    column = quote_identifier(field)
    value = f"CAST({column} AS DOUBLE)"
    found = con.execute(
        f"""WITH v AS (
                SELECT {value} AS v FROM {relation}
                WHERE {column} IS NOT NULL AND isfinite({column}) AND ({side})),
            b AS (SELECT unnest(?::DOUBLE[]) AS b),
            w AS (SELECT unnest(?::DOUBLE[]) AS w)
            SELECT 'b', b.b, min(v.v) FROM b JOIN v ON v.v >= b.b - abs(b.b) * ?
            WHERE NOT list_contains(?::DOUBLE[], v.v) GROUP BY b.b
            UNION ALL
            SELECT 'w', w.w, min(v.v) FROM w JOIN v ON v.v > w.w GROUP BY w.w""",
        [breaks, own, _NEAR, own],
    ).fetchall()
    moved.update(dict.fromkeys(breaks))
    moved.update({at: to for kind, at, to in found if kind == "b"})
    return {*own, *(to for kind, _, to in found if kind == "w")}


#: The share of the rows with a value other than 0 that each side of 0 holds at
#: least for classes to be centred at 0 (a diverging palette's middle): with
#: fewer on one side, the classes are those of the other side's data.
CENTRE_SHARE = 0.05


def centred(below: int, above: int) -> bool:
    """Whether rows below 0 (`below`) and above 0 (`above`) both hold a real
    share: at least `CENTRE_SHARE` of the rows with a value other than 0."""
    total = below + above
    return total > 0 and min(below, above) >= CENTRE_SHARE * total


def signed_rows(
    con: duckdb.DuckDBPyConnection, relation: str, field: str
) -> tuple[int, int]:
    """How many rows of `relation` hold a finite value of `field` below 0, and
    how many above 0."""
    column = quote_identifier(field)
    value = f"CAST({column} AS DOUBLE)"
    below, above = con.execute(
        f"""SELECT count(*) FILTER (WHERE {value} < 0),
                   count(*) FILTER (WHERE {value} > 0)
            FROM {relation} WHERE {column} IS NOT NULL AND isfinite({column})"""
    ).fetchone()
    return int(below), int(above)


def _one_side(
    n: int, below: int, above: int, singles: tuple[float | None, ...]
) -> tuple[tuple[int, ...], int]:
    """The places of `n` classes in a diverging palette that is not centred,
    and the palette's steps: the half on the side with more rows (`below`,
    `above`), the middle color only for a class that holds 0 alone, next to
    the half."""
    up = above >= below
    edge = singles[0] if up else singles[-1]
    zero = bool(singles) and edge == 0
    m = n - zero
    places = (
        (*((m,) if zero else ()), *range(m + 1, 2 * m + 1))
        if up
        else (*range(m), *((m,) if zero else ()))
    )
    return places, 2 * m + 1


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
    diverging palette) and a real share of the rows on both sides of 0
    (`centred`), the values below 0 and those from 0 up are fitted apart, each
    into at most `count // 2` classes; 0 is a break, and each class's place in
    the palette (`Breaks.positions`) gives the classes below 0 the colors before
    the middle one, a class that holds 0 alone the middle one, and the classes
    above 0 those after it. With `centre` and no such share, the classes are
    fitted as without it and take the half of the palette on the side that
    holds most rows (`_one_side`). Zero is never negative in what this
    returns."""
    half = count // 2
    below_rows, above_rows = signed_rows(con, relation, field) if centre else (0, 0)
    if centre and half >= 1 and centred(below_rows, above_rows):
        column = f"CAST({quote_identifier(field)} AS DOUBLE)"
        below = _fit(con, relation, field, half, f"{column} < 0")
        above = _fit(con, relation, field, half, f"{column} >= 0")
        if below.min is not None and above.max is not None and above.max > 0:
            a = len(below.breaks) + 1
            zero = above.min == 0 and above.first_alone
            b = len(above.breaks) + 1 - zero
            breaks = (*below.breaks, 0.0, *above.breaks)
            return Breaks(
                breaks,
                stable(below.min),
                stable(above.max),
                False,
                (
                    *range(half - a, half),
                    *((half,) if zero else ()),
                    *range(half + 1, half + 1 + b),
                ),
                class_singles(con, relation, field, breaks),
            )
    whole = _fit(con, relation, field, count)
    if whole.min is None:
        return Breaks((), None, None, False)
    singles = (
        _singles(
            [(_class_of(v, whole.breaks), v, v) for v in whole.values],
            len(whole.breaks) + 1,
        )
        if whole.values is not None
        else class_singles(con, relation, field, whole.breaks)
    )
    places, steps = (
        _one_side(len(whole.breaks) + 1, below_rows, above_rows, singles)
        if centre
        else ((), 0)
    )
    return Breaks(
        whole.breaks,
        _zero(stable(whole.min)),
        _zero(stable(whole.max)),
        False,
        places,
        singles,
        steps,
    )


def _class_of(value: float, breaks: tuple[float, ...]) -> int:
    """The class a value falls in: one past every break at or below it."""
    return sum(1 for b in breaks if b <= value)


def _singles(
    groups: list[tuple[int, float, float]], classes: int
) -> tuple[float | None, ...]:
    """Per class, the one value it holds (`stable`), from the lowest and
    highest value each group of a class holds; none where a class holds values
    that differ in their first 12 significant digits, or none at all."""
    lows: dict[int, float] = {}
    highs: dict[int, float] = {}
    for index, low, high in groups:
        lows[index] = min(low, lows.get(index, low))
        highs[index] = max(high, highs.get(index, high))
    return tuple(
        _zero(stable(lows[i]))
        if i in lows and stable(lows[i]) == stable(highs[i])
        else None
        for i in range(classes)
    )


def class_singles(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    field: str,
    breaks: tuple[float, ...] | list[float],
    *,
    low: float | None = None,
    high: float | None = None,
) -> tuple[float | None, ...]:
    """Per class of `breaks` (from inclusive, to exclusive), the one value it
    holds (`_singles`): one query over the field's finite values. A first class
    that starts at `low` and a last one that ends at `high` (exclusive) leave
    the values beyond them out: they are in no class."""
    column = quote_identifier(field)
    value = f"CAST({column} AS DOUBLE)"
    rows = con.execute(
        f"""SELECT len(list_filter(?::DOUBLE[], b -> b <= {value})) AS i,
                   min({value}), max({value})
            FROM {relation} WHERE {column} IS NOT NULL AND isfinite({column})
              AND (?::DOUBLE IS NULL OR {value} >= ?::DOUBLE)
              AND (?::DOUBLE IS NULL OR {value} < ?::DOUBLE)
            GROUP BY i""",
        [list(breaks), low, low, high, high],
    ).fetchall()
    return _singles(rows, len(breaks) + 1)


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
