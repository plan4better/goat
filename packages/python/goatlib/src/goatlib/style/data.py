"""What a style needs to know about its data, read from DuckDB.

`describe` builds the `DataContext` the data checks read; `compute_stats`
computes what `compute.needed_stats` names, and `compute_into` writes it into a
style. Both compose the shared statistics
functions (`goatlib.analysis.statistics`), so a style's classes are the ones the
statistics processes return. The only part of `goatlib.style` that does IO, used
by processes; it reads the relation it is given and never filters it (12: scope
is the whole dataset).
"""

from datetime import UTC, datetime
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
}
#: Methods that make fewer classes than asked by their definition (5.8): breaks
#: outside the data, a head that stops shrinking. Only equal breaks count as merged.
_FEWER_BY_DESIGN = {"std_dev", "heads_and_tails"}
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
        if kind == "breaks" and numeric and key[2] in _METHODS:
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
