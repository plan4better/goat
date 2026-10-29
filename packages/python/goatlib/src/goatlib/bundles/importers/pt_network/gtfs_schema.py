"""Column types for the GTFS files a bundle stores typed.

From the GTFS Schedule reference: a field the reference types as a time, date,
number or enum is stored as one; everything else — ids, names, codes, colours,
URLs — stays text, and so does any column the reference does not name (agency
extensions, vendor fields). Files the editor does not read (fares, pathways,
Flex) are not listed and stay text throughout.

Times are ``INTERVAL``: GTFS times run past midnight (``25:10:00`` is ten past
one the next morning), which a SQL ``TIME`` cannot hold, and an interval still
prints as ``HH:MM:SS`` and compares against a ``'08:00:00'`` literal.

Values are parsed strictly, with only the repairs that cannot change a value's
meaning: surrounding whitespace is trimmed, an empty string is no value, and a
time may leave out its leading zeros (``7:05:00``). Anything else that does not
parse is a failure. A failure in a field the reference requires makes the file
unreadable (see ``typed_select``); in an optional field the value is dropped
and counted.
"""

from dataclasses import dataclass
from typing import Dict, List, Literal, Mapping, Optional, Sequence, Tuple

Kind = Literal["integer", "double", "date", "time"]

#: The SQL type each kind is stored as.
SQL_TYPE: Dict[Kind, str] = {
    "integer": "INTEGER",
    "double": "DOUBLE",
    "date": "DATE",
    "time": "INTERVAL",
}


@dataclass(frozen=True)
class Column:
    kind: Kind
    #: Required by the reference without condition. A conditionally required
    #: field (a stop's coordinates, a stop time's times) is not: whether it may
    #: be empty depends on other fields, which is the validator's to judge.
    required: bool = False


def _enum(required: bool = False) -> Column:
    return Column("integer", required)


#: role -> column -> type. A role is the bundle role, which is the file name
#: without ``.txt`` (see ``_GTFS_FILE``).
SCHEMA: Mapping[str, Mapping[str, Column]] = {
    "stops": {
        "stop_lat": Column("double"),
        "stop_lon": Column("double"),
        "location_type": _enum(),
        "wheelchair_boarding": _enum(),
        "stop_access": _enum(),
    },
    "routes": {
        "route_type": _enum(required=True),
        "route_sort_order": Column("integer"),
        "continuous_pickup": _enum(),
        "continuous_drop_off": _enum(),
    },
    "trips": {
        "direction_id": _enum(),
        "wheelchair_accessible": _enum(),
        "bikes_allowed": _enum(),
        "cars_allowed": _enum(),
    },
    "stop_times": {
        "arrival_time": Column("time"),
        "departure_time": Column("time"),
        "stop_sequence": Column("integer", required=True),
        "pickup_type": _enum(),
        "drop_off_type": _enum(),
        "continuous_pickup": _enum(),
        "continuous_drop_off": _enum(),
        "shape_dist_traveled": Column("double"),
        "timepoint": _enum(),
    },
    "calendar": {
        **{
            day: _enum(required=True)
            for day in (
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            )
        },
        "start_date": Column("date", required=True),
        "end_date": Column("date", required=True),
    },
    "calendar_dates": {
        "date": Column("date", required=True),
        "exception_type": _enum(required=True),
    },
    # Required by the reference, but a point that does not parse costs only
    # that point — it is left out of the shape's line — so one bad row does not
    # take every route's geometry with it.
    "shapes": {
        "shape_pt_lat": Column("double"),
        "shape_pt_lon": Column("double"),
        "shape_pt_sequence": Column("integer"),
        "shape_dist_traveled": Column("double"),
    },
    "frequencies": {
        "start_time": Column("time", required=True),
        "end_time": Column("time", required=True),
        "headway_secs": Column("integer", required=True),
        "exact_times": _enum(),
    },
    "transfers": {
        "transfer_type": _enum(required=True),
        "min_transfer_time": Column("integer"),
    },
    "feed_info": {
        "feed_start_date": Column("date"),
        "feed_end_date": Column("date"),
    },
    "levels": {
        "level_index": Column("double", required=True),
    },
    "attributions": {
        "is_producer": _enum(),
        "is_operator": _enum(),
        "is_authority": _enum(),
    },
}


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _parse(column: str, kind: Kind) -> str:
    """SQL turning a text column into its type, or NULL if it does not parse.

    Strict on purpose: DuckDB's own casts accept more than GTFS allows — a
    ``1.0`` as an integer, a ``-1:00:00`` or ``07:05`` as a time, ``nan`` as a
    number — and each of those would be a silent change of meaning."""
    raw = f"NULLIF(trim({_ident(column)}), '')"
    if kind == "integer":
        return (
            f"CASE WHEN regexp_full_match({raw}, '-?[0-9]+') "
            f"THEN TRY_CAST({raw} AS INTEGER) END"
        )
    if kind == "double":
        return (
            f"CASE WHEN isfinite(TRY_CAST({raw} AS DOUBLE)) "
            f"THEN TRY_CAST({raw} AS DOUBLE) END"
        )
    if kind == "date":
        return (
            f"CASE WHEN regexp_full_match({raw}, '[0-9]{{8}}') "
            f"THEN CAST(TRY_STRPTIME({raw}, '%Y%m%d') AS DATE) END"
        )
    # A time: H:MM:SS or HH:MM:SS, hours past 23 allowed (and 3 digits for
    # feeds whose service day runs long), minutes and seconds below 60 — which
    # the cast itself enforces.
    return (
        f"CASE WHEN regexp_full_match({raw}, '[0-9]{{1,3}}:[0-9]{{1,2}}:[0-9]{{1,2}}') "
        f"THEN TRY_CAST({raw} AS INTERVAL) END"
    )


def typed_columns(role: str, columns: Sequence[str]) -> Dict[str, Column]:
    """The columns of ``columns`` that ``role`` stores typed."""
    known = SCHEMA.get(role, {})
    return {c: known[c] for c in columns if c in known}


def typed_select(
    role: str, columns: Sequence[str], parse: Optional[Sequence[str]] = None
) -> str:
    """The SELECT list storing ``columns`` of ``role`` typed, in their order.

    Columns the schema does not type are passed through as they are, and so
    is any column not in ``parse`` when it is given — a column already stored
    typed has no text to parse."""
    typed = typed_columns(role, parse if parse is not None else columns)
    parts = []
    for c in columns:
        spec = typed.get(c)
        parts.append(f"{_parse(c, spec.kind)} AS {_ident(c)}" if spec else _ident(c))
    return ", ".join(parts)


@dataclass(frozen=True)
class Failure:
    """Values of one column that did not parse as its type."""

    column: str
    kind: Kind
    required: bool
    count: int
    samples: Tuple[str, ...]

    def describe(self) -> str:
        examples = ", ".join(repr(s) for s in self.samples)
        return (
            f"{self.count} value(s) in {self.column} are not a valid GTFS "
            f"{self.kind} (e.g. {examples})"
        )


def find_failures(
    con: "object", role: str, relation: str, columns: Sequence[str]
) -> List[Failure]:
    """Every typed column of ``relation`` with values that do not parse.

    ``con`` is a DuckDB connection and ``relation`` a text-typed relation (a
    ``read_parquet(...)`` call or a table name). One scan of the relation."""
    typed = typed_columns(role, columns)
    if not typed:
        return []
    counts = []
    for c, spec in typed.items():
        bad = f"(NULLIF(trim({_ident(c)}), '') IS NOT NULL AND ({_parse(c, spec.kind)}) IS NULL)"
        counts.append(f"count(*) FILTER (WHERE {bad})")
        counts.append(f"(list(DISTINCT trim({_ident(c)})) FILTER (WHERE {bad}))[1:3]")
    row = con.execute(  # type: ignore[attr-defined]
        f"SELECT {', '.join(counts)} FROM {relation}"
    ).fetchone()
    failures: List[Failure] = []
    for i, (c, spec) in enumerate(typed.items()):
        count = int(row[2 * i] or 0)
        if count:
            samples: Optional[List[str]] = row[2 * i + 1]
            failures.append(
                Failure(c, spec.kind, spec.required, count, tuple(samples or ()))
            )
    return failures


def gtfs_text(column: str, sql_type: str) -> str:
    """SQL writing a stored column back as GTFS text.

    Dates go back to ``YYYYMMDD`` and times to ``HH:MM:SS`` — zero-padded,
    hours past 23 kept — rather than as DuckDB prints them. Everything else
    prints as GTFS reads it already: integers plainly, doubles in their
    shortest round-trip form, text as stored."""
    col = _ident(column)
    t = sql_type.upper()
    if t == "DATE":
        return f"strftime({col}, '%Y%m%d') AS {col}"
    if t == "INTERVAL":
        s = f"CAST(epoch({col}) AS BIGINT)"
        return (
            f"CASE WHEN {col} IS NOT NULL THEN printf('%02d:%02d:%02d', "
            f"{s} // 3600, ({s} % 3600) // 60, {s} % 60) END AS {col}"
        )
    return col
