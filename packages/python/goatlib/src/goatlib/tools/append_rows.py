"""Append rows to an existing layer: "Save as dataset" set to an existing
dataset.

The parts that do not need a tool runner: the column plan (the input's
columns must match the target's) and the DuckDB append itself. The per-layer
write lock lives in ``goatlib.utils.layer_lock``.
"""

from dataclasses import dataclass, field
from typing import Any

from goatlib.io.bbox_columns import BBOX_COLUMN, is_bbox_struct
from goatlib.utils.field_config import (
    allowed_value_columns,
    column_defaults,
    locked_column_names,
    parse_computed_columns,
)
from goatlib.utils.generated_fields import (
    SerialCounters,
    generated_fields,
)

#: Maintained by the storage, never written by the append (as in geoapi).
_STORAGE_COLUMNS = {"id", "rowid"}

GEOMETRY_COLUMN = "geometry"


class AppendError(ValueError):
    """An append that cannot go ahead; the message is shown to the user."""


@dataclass(frozen=True)
class ColumnPlan:
    """How the input's columns land in the target.

    ``columns[i]`` is filled by ``select_sql[i]``, an expression over the input
    whose ``?`` placeholders take ``params`` in order.
    """

    columns: list[str]
    select_sql: list[str]
    params: list[Any] = field(default_factory=list)
    cast_columns: dict[str, str] = field(default_factory=dict)
    #: Every target column the append may fill, name -> type (storage
    #: columns and the bbox left out), in the target's order.
    target_types: dict[str, str] = field(default_factory=dict)


_FAMILIES = {
    "point": "point",
    "multipoint": "point",
    "linestring": "line",
    "multilinestring": "line",
    "line": "line",
    "polygon": "polygon",
    "multipolygon": "polygon",
}


def geometry_family(geometry_type: str | None) -> str | None:
    """``"point"``, ``"line"``, ``"polygon"``, or None for a table."""
    if not geometry_type:
        return None
    return _FAMILIES.get(geometry_type.strip().lower(), geometry_type.strip().lower())


def input_geometry_types(con: Any, source_sql: str) -> set[str]:
    """Every geometry type in the input, as GOAT names layer types:
    ``"point"``, ``"line"``, ``"polygon"`` (single and multi alike), or the
    raw type for anything else (e.g. a geometry collection). Rows without a
    geometry add nothing."""
    from goatlib.tools.db import normalize_geometry_type

    found = con.execute(
        f"SELECT DISTINCT ST_GeometryType({_quote(GEOMETRY_COLUMN)}) "
        f"FROM ({source_sql}) AS src WHERE {_quote(GEOMETRY_COLUMN)} IS NOT NULL"
    ).fetchall()
    types: set[str] = set()
    for (raw,) in found:
        text = str(raw)
        normalized = normalize_geometry_type(text)
        # A collection holds any type; it is never one layer's own type.
        if "COLLECTION" in text.upper() or normalized is None:
            types.add(text.lower())
        else:
            types.add(normalized)
    return types


def check_same_geometry(input_types: set[str], target_geometry: str | None) -> None:
    """Refuse an input whose rows are not all of the target's geometry type."""
    want = geometry_family(target_geometry)
    wrong = sorted(t for t in input_types if t != want)
    if wrong:
        found = " and ".join(sorted(input_types))
        noun = "geometry" if len(input_types) == 1 else "geometries"
        raise AppendError(
            f"The input has {found} {noun}; the target layer has {want} geometry."
        )


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def plan_columns(
    input_cols: dict[str, str],
    *,
    target_cols: dict[str, str],
    field_config: dict[str, Any] | None,
    input_geometry: str | None,
    target_geometry: str | None,
) -> ColumnPlan:
    """Decide which target column each input column fills.

    Raises ``AppendError`` when the input cannot go into the target: another
    geometry family, or input columns the target lacks (columns must match;
    target columns the input lacks take their default, else stay empty).
    """
    have, want = geometry_family(input_geometry), geometry_family(target_geometry)
    if have != want:
        if want is None:
            raise AppendError("The target is a table; the input has geometry.")
        if have is None:
            raise AppendError(
                f"The input is a table; the target layer has {want} geometry."
            )
        raise AppendError(
            f"The input has {have} geometry; the target layer has {want} geometry."
        )

    generated = {f.name for f in generated_fields(field_config)}
    computed = {s.name for s in parse_computed_columns(field_config)}
    managed = (
        _STORAGE_COLUMNS | generated | computed | locked_column_names(field_config)
    )

    def is_bbox(name: str, type_: str) -> bool:
        return name == BBOX_COLUMN or is_bbox_struct(type_)

    data_inputs = [
        c
        for c, t in input_cols.items()
        if c != GEOMETRY_COLUMN and not is_bbox(c, t) and c not in managed
    ]
    unknown = [c for c in data_inputs if c not in target_cols]
    if unknown:
        raise AppendError(
            "The target layer has no column for: " + ", ".join(unknown) + "."
        )

    defaults = column_defaults(field_config)
    columns: list[str] = []
    select_sql: list[str] = []
    params: list[Any] = []
    cast_columns: dict[str, str] = {}
    geometry_in_target = want is not None and GEOMETRY_COLUMN in target_cols
    for name, type_ in target_cols.items():
        if name in managed:
            continue
        if name == GEOMETRY_COLUMN:
            if geometry_in_target:
                columns.append(name)
                select_sql.append(_quote(GEOMETRY_COLUMN))
            continue
        if is_bbox(name, type_):
            if name == BBOX_COLUMN and geometry_in_target:
                g = _quote(GEOMETRY_COLUMN)
                columns.append(name)
                select_sql.append(
                    f"struct_pack(xmin := ST_XMin({g}), ymin := ST_YMin({g}), "
                    f"xmax := ST_XMax({g}), ymax := ST_YMax({g}))"
                )
            continue
        if name in input_cols:
            columns.append(name)
            select_sql.append(f"CAST({_quote(name)} AS {type_})")
            cast_columns[name] = type_
        elif name in defaults:
            # Typed as the column, as the database types it when a row is
            # added by hand (geoapi inserts first): formulas and allowed
            # values then see a number, not the text it may be stored as.
            columns.append(name)
            select_sql.append(f"CAST(? AS {type_})")
            params.append(defaults[name])

    return ColumnPlan(
        columns=columns,
        select_sql=select_sql,
        params=params,
        cast_columns=cast_columns,
        target_types={
            n: t
            for n, t in target_cols.items()
            if n not in _STORAGE_COLUMNS and not is_bbox(n, t)
        },
    )


def _check_casts(con: Any, source_sql: str, casts: dict[str, str]) -> None:
    """Name the first column whose values do not fit the target's type.

    One read of the input for all columns (the layer is locked meanwhile).
    Only when that query cannot even be planned (a type that never converts,
    e.g. geometry into a number) are the columns tried one by one, to name it.
    """
    if not casts:
        return
    checks = [
        f"count(*) FILTER (WHERE {_quote(name)} IS NOT NULL "
        f"AND TRY_CAST({_quote(name)} AS {type_}) IS NULL)"
        for name, type_ in casts.items()
    ]
    try:
        counts = con.execute(
            f"SELECT {', '.join(checks)} FROM ({source_sql}) AS src"
        ).fetchone()
    except Exception:
        counts = None
        for name, type_ in casts.items():
            col = _quote(name)
            try:
                con.execute(
                    f"SELECT TRY_CAST({col} AS {type_}) FROM ({source_sql}) AS src "
                    "LIMIT 0"
                )
            except Exception as exc:
                raise AppendError(
                    f"Column '{name}' cannot be converted to {type_}."
                ) from exc
        raise
    for (name, type_), bad in zip(casts.items(), counts or (), strict=False):
        if bad:
            raise AppendError(
                f"Column '{name}': {bad} value(s) cannot be converted to {type_}."
            )


_STAGE = "__goat_append_stage"


def append_rows(
    con: Any,
    table: str,
    source_sql: str,
    plan: ColumnPlan,
    field_config: dict[str, Any] | None,
    counters: SerialCounters | None = None,
) -> int:
    """Append the rows of ``source_sql`` to ``table`` as ``plan`` says.

    Every value is settled in a local staging table first (casts, defaults,
    generated and computed columns, allowed values), and the rows
    then go into ``table`` with one INSERT. Rows are never updated after they
    were inserted: on a DuckLake table with geometry such an update leaves a
    transaction-local row id (around 1e18) on them for good.

    Runs inside the caller's transaction, and the caller holds the layer's
    write lock. Existing rows are never touched. Serial numbers continue after
    the larger of the column's maximum and its high-water mark in
    ``counters``; the numbers handed out are recorded there. Returns the
    number of rows appended.
    """
    _check_casts(con, source_sql, plan.cast_columns)
    counters = counters if counters is not None else SerialCounters()

    generated = [
        f for f in generated_fields(field_config) if f.name in plan.target_types
    ]
    computed = [
        s
        for s in parse_computed_columns(field_config, geom_column=GEOMETRY_COLUMN)
        if s.name in plan.target_types
    ]
    # The staging table holds every fillable target column, so computed
    # formulas can read any of them; only what the append sets is inserted.
    # Each planned expression keeps its own bound parameters.
    planned: dict[str, tuple[str, list[Any]]] = {}
    offset = 0
    for name, expr in zip(plan.columns, plan.select_sql, strict=True):
        n = expr.count("?")
        planned[name] = (expr, list(plan.params[offset : offset + n]))
        offset += n
    filled_later = {f.name for f in generated} | {c.name for c in computed}

    select: list[str] = []
    params: list[Any] = []
    insert: list[str] = []
    # Target order; the bbox (planned, but not a fillable column) comes along.
    names = {
        **plan.target_types,
        **{c: "" for c in plan.columns if c not in plan.target_types},
    }
    for name, type_ in names.items():
        if name in planned:
            expr, expr_params = planned[name]
            select.append(f"{expr} AS {_quote(name)}")
            params.extend(expr_params)
            insert.append(name)
        elif name in plan.target_types:
            select.append(f"CAST(NULL AS {type_}) AS {_quote(name)}")
            if name in filled_later:
                insert.append(name)

    con.execute(f"DROP TABLE IF EXISTS {_STAGE}")
    con.execute(
        f"CREATE TEMP TABLE {_STAGE} AS "
        f"SELECT {', '.join(select)} FROM ({source_sql}) AS src",
        params,
    )
    try:
        counted = con.execute(f"SELECT count(*) FROM {_STAGE}").fetchone()
        rows = int(counted[0]) if counted else 0
        if rows == 0:
            return 0
        # Rows that bring nothing of their own (no column, no geometry) would
        # only be empty rows with generated numbers: a silent no-op.
        if not plan.cast_columns and GEOMETRY_COLUMN not in plan.columns:
            raise AppendError(
                "The target layer has no column the input's rows could fill."
            )

        for gen in generated:
            column = _quote(gen.name)
            if gen.kind == "uuid":
                con.execute(
                    f"UPDATE {_STAGE} SET {column} = gen_random_uuid()::VARCHAR"
                )
                continue
            top = con.execute(f"SELECT max({column}) FROM {table}").fetchone()
            last = max(
                gen.start - 1,
                int(top[0]) if top and top[0] is not None else gen.start - 1,
                int(counters.high_water.get(gen.name, gen.start - 1)),
            )
            con.execute(
                f"UPDATE {_STAGE} SET {column} = numbered.value FROM ("
                f"SELECT rowid AS rid, {last} + row_number() OVER (ORDER BY rowid) "
                f"AS value FROM {_STAGE}) AS numbered "
                f"WHERE {_STAGE}.rowid = numbered.rid"
            )
            counters.record(gen.name, last + rows)

        for spec in computed:
            con.execute(f"UPDATE {_STAGE} SET {_quote(spec.name)} = {spec.compute_sql}")

        for name, allowed in allowed_value_columns(field_config).items():
            if name not in plan.target_types:
                continue
            placeholders = ", ".join("?" for _ in allowed)
            bad = con.execute(
                f"SELECT count(*) FROM {_STAGE} WHERE {_quote(name)} IS NOT NULL "
                f"AND {_quote(name)} NOT IN ({placeholders})",
                list(allowed),
            ).fetchone()
            if bad and bad[0]:
                accepted = ", ".join(str(v) for v in allowed)
                raise AppendError(
                    f"Column '{name}': {bad[0]} row(s) hold a value that is not "
                    f"accepted. Accepted: {accepted}."
                )

        columns = ", ".join(_quote(c) for c in insert)
        con.execute(
            f"INSERT INTO {table} ({columns}) "
            f"SELECT {columns} FROM {_STAGE} ORDER BY rowid"
        )
        return rows
    finally:
        # After a database error the transaction is aborted and even this DROP
        # fails; it must not replace the error that says what went wrong. The
        # caller's rollback discards the staging table then anyway.
        try:
            con.execute(f"DROP TABLE IF EXISTS {_STAGE}")
        except Exception:
            pass
