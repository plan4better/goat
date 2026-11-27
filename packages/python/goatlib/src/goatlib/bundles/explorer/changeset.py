"""Saving the Explorer's edits: a change set of GTFS rows, applied to a bundle.

The Explorer edits a bundle in the browser, on its own copy (the snapshot).
On save it sends what changed as rows of the bundle's GTFS tables, keyed by
GTFS ids — never by the snapshot's indexes, which are only valid within one
build. This module applies such a change set to the member tables, in the
caller's transaction, and keeps the bundle whole:

- **Values are GTFS text**, typed by the importer's own rules
  (``importers.pt_network.gtfs_schema``): a time ``25:10:00``, a date
  ``20261012``, numbers as numbers. A value that does not parse is refused.
- **Operations on one row are squashed** first: an insert later updated is
  one insert, an insert later deleted is nothing. Updating a row inserted in
  the same DuckLake transaction leaves it a transaction-local row id, which
  breaks the tiles drawn from it, so no row is written twice.
- **What the bundle derives is kept in step**: a stop's ``geometry`` from its
  coordinates, and ``shape_lines`` — the lines the map draws — for every shape
  and every shapeless trip the change touches (``importers.pt_network
  .stop_chains`` is the rule for the latter).
- **Integrity is checked on what the change touches**, with the MobilityData
  validator's notice codes. Only problems the change introduces count: a row
  that was already wrong before is not this change's to answer for. Any new
  ERROR refuses the whole change set (``ChangeSetIntegrityError``); the caller rolls
  back.

Nothing here knows where the tables live: ``tables`` maps each role to a SQL
table name (a DuckLake table in geoapi, a plain DuckDB table in tests).
"""

import json
import logging
import math
import re
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Literal,
    Mapping,
    Optional,
    Sequence,
    Set,
    Tuple,
    Union,
)

from pydantic import BaseModel, Field, model_validator

from goatlib.bundles.importers.pt_network.gtfs_schema import SCHEMA, SQL_TYPE
from goatlib.bundles.importers.pt_network.stop_chains import STOP_CHAIN_PREFIX

try:
    import pyarrow as pa
except ImportError:  # pragma: no cover - goatlib depends on it
    pa = None

logger = logging.getLogger(__name__)


class _Phases:
    """How long each step of a save took: logged once, so a slow save says
    where its time went."""

    def __init__(self) -> None:
        self.start = self.last = time.monotonic()
        self.took: List[str] = []

    def __call__(self, name: str) -> None:
        now = time.monotonic()
        self.took.append(f"{name} {now - self.last:.1f}s")
        # Each as it ends, too: a save stopped part way says how far it got.
        logger.info("Change set: %s", self.took[-1])
        self.last = now

    def log(self) -> None:
        logger.info(
            "Change set applied in %.1fs: %s",
            time.monotonic() - self.start,
            ", ".join(self.took),
        )


#: The roles a change set may write, each with its GTFS primary key.
ROLE_KEYS: Dict[str, Tuple[str, ...]] = {
    "agency": ("agency_id",),
    "stops": ("stop_id",),
    "routes": ("route_id",),
    "trips": ("trip_id",),
    "stop_times": ("trip_id", "stop_sequence"),
    "calendar": ("service_id",),
    "calendar_dates": ("service_id", "date"),
    "frequencies": ("trip_id", "start_time"),
    "shapes": ("shape_id", "shape_pt_sequence"),
}

#: Optional fields a feed may leave out that the Explorer sets: the column is
#: added the first time a value is written to it. Any other column a table
#: lacks is refused; an empty value for a column it lacks is no value.
ADDABLE_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "stops": (
        "stop_code",
        "wheelchair_boarding",
        "location_type",
        "parent_station",
        "platform_code",
    ),
    "trips": ("trip_headsign",),
    "routes": (
        "agency_id",
        "route_desc",
        "route_color",
        "route_text_color",
    ),
}

#: Tables the Explorer does not edit whose rows name a stop: a stop deleted
#: takes them with it (01-editing-operations 2.3; the browser holds none).
STOP_REFERENCES: Dict[str, Tuple[str, ...]] = {
    "transfers": ("from_stop_id", "to_stop_id"),
    "pathways": ("from_stop_id", "to_stop_id"),
    "stop_areas": ("stop_id",),
}

#: Likewise the rows naming a route or a trip: a line deleted takes them
#: with it (1.5).
ROUTE_REFERENCES: Dict[str, Tuple[str, ...]] = {
    "fare_rules": ("route_id",),
    "attributions": ("route_id",),
    "transfers": ("from_route_id", "to_route_id"),
}
TRIP_REFERENCES: Dict[str, Tuple[str, ...]] = {
    "attributions": ("trip_id",),
    "transfers": ("from_trip_id", "to_trip_id"),
}
#: Per role a change set deletes from: the tables whose rows go with it.
REFERENCES: Dict[str, Dict[str, Tuple[str, ...]]] = {
    "stops": STOP_REFERENCES,
    "routes": ROUTE_REFERENCES,
    "trips": TRIP_REFERENCES,
}

#: Columns a client never writes: the bundle derives them.
DERIVED_COLUMNS = frozenset({"geometry", "bbox", "xmin", "ymin", "xmax", "ymax"})

Value = Union[str, int, float, None]
Severity = Literal["ERROR", "WARNING", "INFO"]

#: Spliced into a write: ``(role, table columns, geometry SQL)`` → the
#: columns the layer derives from its geometry (bbox, computed columns), each
#: as ``(column, SQL)``. geoapi supplies it from the layer's field config.
Derived = Callable[[str, Sequence[str], str], List[Tuple[str, str]]]


class ChangeSetError(ValueError):
    """The change set itself is malformed: an unknown role or column, a value
    that does not parse, a row it updates that is not there."""


class RowOp(BaseModel):
    """One row written: inserted whole, updated in the columns given, or
    deleted. ``key`` names the row by its GTFS primary key."""

    role: str
    op: Literal["insert", "update", "delete"]
    key: Dict[str, Value]
    values: Dict[str, Value] = Field(default_factory=dict)
    #: An insert copying a row of the same table: the columns ``values`` does
    #: not name are taken from it, as the bundle has it when the change is
    #: saved. The browser holds only the columns the Explorer reads, so a trip
    #: copied (4.1, a departure added) keeps its stop times' other fields, its
    #: wheelchair and bike flags and any column of the feed's own. The row is
    #: read as the save finds it after the change set's updates and before
    #: its deletes and inserts: one the same change set deletes or replaces is
    #: copied as it was, one it inserts gives nothing.
    copy_of: Optional[Dict[str, Value]] = None

    @model_validator(mode="after")
    def _shape(self) -> "RowOp":
        keys = ROLE_KEYS.get(self.role)
        if keys is None:
            raise ValueError(f"{self.role} is not a table the Explorer edits")
        if set(self.key) != set(keys):
            raise ValueError(f"a {self.role} row is keyed by {', '.join(keys)}")
        if self.copy_of is not None:
            if self.op != "insert":
                raise ValueError("only an insert copies a row")
            if set(self.copy_of) != set(keys):
                raise ValueError(f"a {self.role} row is copied by {', '.join(keys)}")
        if self.op == "delete" and self.values:
            raise ValueError("a delete carries no values")
        if self.op == "update" and not self.values:
            raise ValueError("an update names the columns it sets")
        named = set(self.values)
        if named & set(keys):
            raise ValueError(
                "a key column is changed by deleting and inserting the row"
            )
        if named & DERIVED_COLUMNS:
            raise ValueError(
                f"{', '.join(sorted(named & DERIVED_COLUMNS))} is derived, never written"
            )
        return self


class Stretch(BaseModel):
    """A stretch of a shape drawn anew: from and to as shares of its length
    (none: its start or end), straight through ``points`` (lon, lat). The
    moved stop is ``points[stop_point]``: the first, or, where the stretch
    follows the streets to it, wherever the route reaches it."""

    model_config = {"populate_by_name": True}

    start: Optional[float] = Field(None, alias="from", ge=0, le=1)
    end: Optional[float] = Field(None, alias="to", ge=0, le=1)
    #: Where the stop drawn through was on the shape, as a share: its stop
    #: times move on by as far as its new point lies past it.
    at: Optional[float] = Field(None, ge=0, le=1)
    points: List[Tuple[float, float]] = Field(..., min_length=1, max_length=10_000)
    stop_point: int = Field(0, ge=0)

    @model_validator(mode="after")
    def _stop_on_it(self) -> "Stretch":
        if self.stop_point >= len(self.points):
            raise ValueError("stop_point is past the stretch's points")
        return self


class ShapeReshape(BaseModel):
    """A shape redrawn through a moved stop (01-editing-operations 2.2): the
    points of ``source`` with each stretch replaced, written as
    ``key.shape_id`` (the same shape, or a copy some trips were given). The
    trips on it keep their distances in step, ``through`` at its new place."""

    role: Literal["shapes"]
    op: Literal["reshape"]
    key: Dict[str, Value]
    source: str
    #: The stop the stretches are drawn through (a moved or added stop);
    #: none for a path rerouted between two stops (1.2): then every stop time
    #: past a stretch moves on by as far as the shape did there.
    through: Optional[str] = None
    #: Metres per ``shape_dist_traveled`` unit, as the Explorer found the
    #: feed's: for stop times measured along a shape that gives no distances.
    metres_per_unit: Optional[float] = Field(None, gt=0)
    stretches: List[Stretch] = Field(..., min_length=1, max_length=1_000)
    #: The trips whose distances follow, as the Explorer had them on the
    #: shape when it was redrawn: a later edit in the same set may move some
    #: onto a copy, and their rows no longer say this shape by then.
    trips: Optional[List[str]] = Field(None, max_length=500_000)

    @model_validator(mode="after")
    def _shape(self) -> "ShapeReshape":
        if set(self.key) != {"shape_id"} or not self.key["shape_id"]:
            raise ValueError("a reshape is keyed by shape_id")
        return self


class StopTimesShift(BaseModel):
    """Room made in a trip for a stop added to it (01-editing-operations
    3.1): every stop time of ``key.trip_id`` past ``after`` numbered one on.
    Rows named before it in the change set are named as they were then, those
    after it as they are after it; the save numbers both alike."""

    role: Literal["stop_times"]
    op: Literal["shift"]
    key: Dict[str, Value]
    after: int

    @model_validator(mode="after")
    def _shape(self) -> "StopTimesShift":
        if set(self.key) != {"trip_id"} or not self.key["trip_id"]:
            raise ValueError("a shift is keyed by trip_id")
        return self


class ChangeSet(BaseModel):
    """The rows a session changed, in the order it changed them."""

    ops: List[Union[RowOp, ShapeReshape, StopTimesShift]] = Field(
        ..., min_length=1, max_length=500_000
    )


@dataclass(frozen=True)
class Notice:
    """One finding, as the MobilityData validator names it."""

    code: str
    severity: Severity
    role: str
    key: Tuple[Tuple[str, Any], ...]
    field: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "role": self.role,
            "key": {k: _jsonable(v) for k, v in self.key},
            "field": self.field,
        }


class ChangeSetIntegrityError(Exception):
    """The change set would leave the bundle with an ERROR."""

    def __init__(self, notices: List[Notice]) -> None:
        super().__init__(
            f"{len(notices)} problem(s): "
            + "; ".join(f"{n.code} in {n.role}" for n in notices[:5])
        )
        self.notices = notices


@dataclass
class Applied:
    """What a change set did: rows per role, and the warnings it brought."""

    rows: Dict[str, Dict[str, int]] = field(default_factory=dict)
    warnings: List[Notice] = field(default_factory=list)


# --------------------------------------------------------------------------
# Values


_INT = re.compile(r"-?[0-9]+")
_DATE = re.compile(r"[0-9]{8}")
_TIME = re.compile(r"([0-9]{1,3}):([0-9]{1,2}):([0-9]{1,2})")


def _typed(role: str, column: str, value: Value) -> Any:
    """``value`` as the column stores it; empty is no value."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None
    spec = SCHEMA.get(role, {}).get(column)
    kind = spec.kind if spec else "text"
    text = value.strip() if isinstance(value, str) else value
    try:
        if kind == "integer":
            if isinstance(text, bool):
                raise ValueError
            if isinstance(text, int):
                return text
            if isinstance(text, str) and _INT.fullmatch(text):
                return int(text)
            raise ValueError
        if kind == "double":
            number = float(text)  # type: ignore[arg-type]
            if number != number or number in (float("inf"), float("-inf")):
                raise ValueError
            return number
        if kind == "date":
            if not isinstance(text, str) or not _DATE.fullmatch(text):
                raise ValueError
            return date(int(text[:4]), int(text[4:6]), int(text[6:]))
        if kind == "time":
            m = _TIME.fullmatch(text) if isinstance(text, str) else None
            if not m or int(m[2]) > 59 or int(m[3]) > 59:
                raise ValueError
            return timedelta(hours=int(m[1]), minutes=int(m[2]), seconds=int(m[3]))
    except (TypeError, ValueError):
        raise ChangeSetError(
            f"{role}.{column}: {value!r} is not a valid GTFS {kind}"
        ) from None
    if not isinstance(text, str):
        raise ChangeSetError(f"{role}.{column}: {value!r} is text in GTFS")
    return text


def _jsonable(value: Any) -> Any:
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    if isinstance(value, timedelta):
        s = int(value.total_seconds())
        return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"
    return value


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


# --------------------------------------------------------------------------
# Squashing


@dataclass
class _Net:
    """The net effect of a change set on one row."""

    kind: Literal["insert", "update", "delete", "replace"]
    values: Dict[str, Any]
    #: The row an insert copies its other columns from (``RowOp.copy_of``).
    copy_of: Optional[Tuple[Any, ...]] = None


#: A row written, as parsed: ``(role, op, key, values, copy_of)``.
_Parsed = Tuple[str, str, Tuple[Any, ...], Dict[str, Any], Optional[Tuple[Any, ...]]]


def _squash(ops: Iterable[_Parsed]) -> Dict[str, Dict[Tuple[Any, ...], _Net]]:
    """One net write per row, from the rows written in order."""
    out: Dict[str, Dict[Tuple[Any, ...], _Net]] = {}
    for role, op, key, values, copy_of in ops:
        rows = out.setdefault(role, {})
        prev = rows.get(key)
        where = f"{role} {dict(zip(ROLE_KEYS[role], key))}"
        if prev is None:
            rows[key] = _Net(op, dict(values), copy_of)  # type: ignore[arg-type]
        elif op == "insert":
            if prev.kind != "delete":
                raise ChangeSetError(f"{where} is inserted while it exists")
            rows[key] = _Net("replace", dict(values), copy_of)
        elif op == "update":
            if prev.kind == "delete":
                raise ChangeSetError(f"{where} is updated after it was deleted")
            prev.values.update(values)
        elif prev.kind == "insert":  # delete after insert: nothing at all
            del rows[key]
        elif prev.kind == "delete":
            raise ChangeSetError(f"{where} is deleted twice")
        else:  # delete after update or replace
            rows[key] = _Net("delete", {})
    return out


# --------------------------------------------------------------------------
# Applying


class _Tables:
    """The tables written, with their columns, read once."""

    def __init__(self, con: Any, tables: Mapping[str, str]) -> None:
        self.con = con
        self.names = dict(tables)
        self._columns: Dict[str, List[str]] = {}

    def has(self, role: str) -> bool:
        return role in self.names

    def name(self, role: str) -> str:
        if role not in self.names:
            raise ChangeSetError(f"the bundle has no {role} table")
        return self.names[role]

    def columns(self, role: str) -> List[str]:
        if role not in self._columns:
            self._columns[role] = [
                str(r[0])
                for r in self.con.execute(f"DESCRIBE {self.name(role)}").fetchall()
            ]
        return self._columns[role]

    def forget_columns(self, role: str) -> None:
        self._columns.pop(role, None)

    def types(self, role: str) -> Dict[str, str]:
        return {
            str(r[0]): str(r[1]).upper()
            for r in self.con.execute(f"DESCRIBE {self.name(role)}").fetchall()
        }


def _shift_stop_times(t: _Tables, changeset: ChangeSet) -> ChangeSet:
    """Make the room each shift asks for in the feed's trips, in order, and
    name every stop time the change set writes as it is numbered once all of
    them are made: the change set, its shifts gone."""
    shifts = [
        (k, str(op.key["trip_id"]), op.after)
        for k, op in enumerate(changeset.ops)
        if isinstance(op, StopTimesShift)
    ]
    if not shifts:
        return changeset
    if t.has("stop_times"):
        _make_room(t, [(trip_id, after) for _, trip_id, after in shifts])

    def renumbered(k: int, key: Dict[str, Value]) -> Dict[str, Value]:
        trip_id = str(key["trip_id"])
        seq = int(_typed("stop_times", "stop_sequence", key["stop_sequence"]))
        # Moved on by every shift after it in the same trip.
        for at, shifted, after in shifts:
            if at > k and shifted == trip_id and seq > after:
                seq += 1
        return {**key, "stop_sequence": seq}

    ops: List[Union[RowOp, ShapeReshape, StopTimesShift]] = []
    for k, op in enumerate(changeset.ops):
        if isinstance(op, StopTimesShift):
            continue
        if isinstance(op, RowOp) and op.role == "stop_times":
            # The row it copies is named as it was then, too.
            update: Dict[str, Any] = {"key": renumbered(k, op.key)}
            if op.copy_of is not None:
                update["copy_of"] = renumbered(k, op.copy_of)
            op = op.model_copy(update=update)
        ops.append(op)
    return ChangeSet.model_construct(ops=ops)


def _make_room(t: _Tables, shifts: List[Tuple[str, int]]) -> None:
    """Each shift, in order, moves the stop times of its trip past ``after``
    on by one: done in one statement, not one per shift (a scan of the
    network's stop times each). A shift's ``after`` is in the numbering the
    shifts before it in its trip left; turned into the trip's numbering as it
    is (``past``), a stop time moves on by as many shifts as it lies past."""
    by_trip: Dict[str, List[int]] = {}
    for trip_id, after in shifts:
        by_trip.setdefault(trip_id, []).append(int(after))
    thresholds: List[Tuple[str, int]] = []
    for trip_id, afters in by_trip.items():

        def moved(seq: int, upto: int) -> int:
            # Where ``seq`` is after the trip's first ``upto`` shifts.
            for a in afters[:upto]:
                if seq > a:
                    seq += 1
            return seq

        for k, after in enumerate(afters):
            # The last sequence the k-th shift leaves where it is, counted
            # as the trip is numbered now: at most ``after``, at least
            # ``after - k`` (each shift before it moves a row by one).
            past = after
            while past > after - k - 1 and moved(past, k) > after:
                past -= 1
            thresholds.append((trip_id, past))
    times = t.name("stop_times")
    staged = _stage(t, "stop_times", ("trip_id", "stop_sequence"), thresholds)
    types = t.types("stop_times")
    x_seq, p_seq = (_key_sql(types, "stop_times", "stop_sequence", a) for a in "xp")
    # Counted per numbered place, not per row: a trip with two rows at one
    # place moves both by the shifts past it, once.
    t.con.execute(
        f"UPDATE {times} SET stop_sequence = {times}.stop_sequence + m.n FROM ("
        f"SELECT x.trip_id, x.stop_sequence, count(*) AS n FROM ("
        f"SELECT DISTINCT trip_id, stop_sequence FROM {times} "
        f"WHERE trip_id IN (SELECT trip_id FROM {staged})) x "
        f"JOIN {staged} p ON p.trip_id = x.trip_id AND {x_seq} > {p_seq} "
        f"GROUP BY x.trip_id, x.stop_sequence) m "
        f"WHERE {times}.trip_id = m.trip_id AND {times}.stop_sequence = m.stop_sequence"
    )


def _parse_ops(t: _Tables, changeset: ChangeSet) -> List[_Parsed]:
    parsed: List[_Parsed] = []
    for op in changeset.ops:
        if isinstance(op, (ShapeReshape, StopTimesShift)):
            continue
        missing = set(op.values) - set(t.columns(op.role))
        unknown = sorted(missing - set(ADDABLE_COLUMNS.get(op.role, ())))
        if unknown:
            raise ChangeSetError(f"{op.role} has no column {', '.join(unknown)}")
        key = tuple(_typed(op.role, k, op.key[k]) for k in ROLE_KEYS[op.role])
        if any(k is None for k in key):
            raise ChangeSetError(f"a {op.role} key is empty")
        values = {c: _typed(op.role, c, v) for c, v in op.values.items()}
        for column in sorted(missing):
            if values[column] is None:
                del values[column]
            else:
                _add_column(t, op.role, column)
        if op.op == "update" and not values:
            continue
        copy_of = (
            tuple(_typed(op.role, k, op.copy_of[k]) for k in ROLE_KEYS[op.role])
            if op.copy_of is not None
            else None
        )
        parsed.append((op.role, op.op, key, values, copy_of))
    return parsed


def _add_column(t: _Tables, role: str, column: str) -> None:
    """Give ``role``'s table an optional GTFS column it did not have, typed as
    an import types it."""
    if column in t.columns(role):
        return
    spec = SCHEMA.get(role, {}).get(column)
    sql_type = SQL_TYPE[spec.kind] if spec else "VARCHAR"
    t.con.execute(f"ALTER TABLE {t.name(role)} ADD COLUMN {_ident(column)} {sql_type}")
    t.forget_columns(role)


# A row's own statements (``_where``, ``_insert``, ``_update``, ``_delete``)
# write the stops only (``_ROW_BY_ROW``); every other table is written a
# statement per kind (``_write_rows``).


def _where(role: str, key: Tuple[Any, ...], params: Dict[str, Any]) -> str:
    parts = []
    for i, (col, value) in enumerate(zip(ROLE_KEYS[role], key)):
        params[f"k{i}"] = value
        parts.append(f"{_ident(col)} = $k{i}")
    return " AND ".join(parts)


def _geometry_sql(role: str, set_exprs: Mapping[str, str]) -> Optional[str]:
    """The geometry a stop takes from its coordinates, spelled from what the
    statement sets (``set_exprs``) or else the row's own columns."""
    if role != "stops":
        return None
    lon = set_exprs.get("stop_lon", '"stop_lon"')
    lat = set_exprs.get("stop_lat", '"stop_lat"')
    return (
        f"CASE WHEN {lon} IS NOT NULL AND {lat} IS NOT NULL "
        f"THEN ST_Point({lon}, {lat}) END"
    )


def _derived_exprs(
    t: _Tables, role: str, geom: str, derived: Optional[Derived]
) -> List[Tuple[str, str]]:
    columns = t.columns(role)
    exprs = [("geometry", geom)] if "geometry" in columns else []
    if derived and exprs:
        exprs += derived(role, columns, f"({geom})")
    return exprs


def _insert(
    t: _Tables,
    role: str,
    key: Tuple[Any, ...],
    values: Mapping[str, Any],
    derived: Optional[Derived],
) -> None:
    params: Dict[str, Any] = {}
    cols, exprs = [], []
    given = list(zip(ROLE_KEYS[role], key)) + list(values.items())
    for i, (col, value) in enumerate(given):
        params[f"v{i}"] = value
        cols.append(col)
        exprs.append(f"$v{i}")
    if role == "stops":
        # A new row has no columns of its own to fall back on.
        given = dict(zip(cols, exprs))
        geom = _geometry_sql(
            role,
            {c: given.get(c, "CAST(NULL AS DOUBLE)") for c in ("stop_lon", "stop_lat")},
        )
        assert geom is not None
        for col, sql in _derived_exprs(t, role, geom, derived):
            cols.append(col)
            exprs.append(sql)
    t.con.execute(
        f"INSERT INTO {t.name(role)} ({', '.join(_ident(c) for c in cols)}) "
        f"VALUES ({', '.join(exprs)})",
        params,
    )


def _update(
    t: _Tables,
    role: str,
    key: Tuple[Any, ...],
    values: Mapping[str, Any],
    derived: Optional[Derived],
) -> None:
    params: Dict[str, Any] = {}
    sets = []
    set_exprs: Dict[str, str] = {}
    for i, (col, value) in enumerate(values.items()):
        params[f"v{i}"] = value
        set_exprs[col] = f"$v{i}"
        sets.append(f"{_ident(col)} = $v{i}")
    if role == "stops" and {"stop_lon", "stop_lat"} & set(values):
        geom = _geometry_sql(role, set_exprs)
        assert geom is not None
        for col, sql in _derived_exprs(t, role, geom, derived):
            sets.append(f"{_ident(col)} = {sql}")
    t.con.execute(
        f"UPDATE {t.name(role)} SET {', '.join(sets)} "
        f"WHERE {_where(role, key, params)}",
        params,
    )


def _delete(t: _Tables, role: str, key: Tuple[Any, ...]) -> None:
    params: Dict[str, Any] = {}
    t.con.execute(
        f"DELETE FROM {t.name(role)} WHERE {_where(role, key, params)}", params
    )


# --------------------------------------------------------------------------
# What the change touches


@dataclass
class _Touched:
    keys: Dict[str, Set[Tuple[Any, ...]]]

    def ids(self, role: str, column: str) -> Set[Any]:
        i = ROLE_KEYS[role].index(column)
        return {k[i] for k in self.keys.get(role, set())}

    @property
    def trips(self) -> Set[Any]:
        return (
            self.ids("trips", "trip_id")
            | self.ids("stop_times", "trip_id")
            | self.ids("frequencies", "trip_id")
        )

    @property
    def services(self) -> Set[Any]:
        return self.ids("calendar", "service_id") | self.ids(
            "calendar_dates", "service_id"
        )


def _id_table(con: Any, name: str, ids: Iterable[Any]) -> str:
    """A temp table of ``ids`` (text), for joining against."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name} (id VARCHAR)")
    _ingest(con, name, [(str(i),) for i in ids], 1)
    return name


# --------------------------------------------------------------------------
# Integrity


#: Fields the GTFS reference requires without condition, per role (keys
#: aside: those are never empty). Conditionally required ones are checked
#: on their own below.
_REQUIRED: Dict[str, Tuple[str, ...]] = {
    "agency": ("agency_name", "agency_url", "agency_timezone"),
    "routes": ("route_type",),
    "trips": ("route_id", "service_id"),
    "stop_times": ("stop_id",),
    "calendar": (
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
    ),
    "calendar_dates": ("exception_type",),
    "frequencies": ("end_time", "headway_secs"),
    "shapes": ("shape_pt_lat", "shape_pt_lon"),
}


def _blank(column: str) -> str:
    col = _ident(column)
    return f"({col} IS NULL OR CAST({col} AS VARCHAR) = '')"


def _check_stop_locations(
    t: _Tables,
    cond: str,
    stops: str,
    keys: str,
    add: Callable[..., None],
) -> None:
    """The rules of ``stops.location_type`` on the stops written (``cond``, on
    alias ``x``) and on those naming one of them (``stops``, an id table) as
    their parent: a parent where one is required, none on a station, a parent
    of the right type, stop times only at stops or platforms."""
    con = t.con
    cols = set(t.columns("stops"))
    name = t.name("stops")
    kind = "coalesce(x.location_type, 0)" if "location_type" in cols else "0"
    if "parent_station" in cols:
        add(
            "location_without_parent_station",
            "ERROR",
            "stops",
            con.execute(
                f"SELECT {keys} FROM {name} x WHERE {cond} "
                f"AND {kind} IN (2, 3, 4) AND {_blank('parent_station')}"
            ).fetchall(),
            "parent_station",
        )
        add(
            "station_with_parent_station",
            "ERROR",
            "stops",
            con.execute(
                f"SELECT {keys} FROM {name} x WHERE {cond} "
                f"AND {kind} = 1 AND NOT {_blank('parent_station')}"
            ).fetchall(),
            "parent_station",
        )
        parent_kind = "coalesce(p.location_type, 0)" if "location_type" in cols else "0"
        add(
            "wrong_parent_location_type",
            "ERROR",
            "stops",
            con.execute(
                f"""
                SELECT {keys} FROM {name} x JOIN {name} p ON p.stop_id = x.parent_station
                WHERE ({cond} OR CAST(x.parent_station AS VARCHAR) IN (SELECT id FROM {stops}))
                  AND CASE WHEN {kind} = 4 THEN {parent_kind} <> 0
                           WHEN {kind} IN (0, 2, 3) THEN {parent_kind} <> 1
                           ELSE false END
                """
            ).fetchall(),
            "parent_station",
        )
    if "location_type" in cols and t.has("stop_times"):
        add(
            "location_with_unexpected_stop_time",
            "ERROR",
            "stops",
            con.execute(
                f"SELECT {keys} FROM {name} x WHERE {cond} AND {kind} <> 0 "
                f"AND EXISTS (SELECT 1 FROM {t.name('stop_times')} st WHERE st.stop_id = x.stop_id)"
            ).fetchall(),
            "location_type",
        )


def _check(t: _Tables, touched: _Touched) -> Set[Notice]:
    """The ERRORs and WARNINGs on what ``touched`` reaches: its rows, and the
    rows referring to them."""
    con = t.con
    notices: Set[Notice] = set()

    def add(
        code: str,
        severity: Severity,
        role: str,
        rows: Iterable[Sequence[Any]],
        field: Optional[str] = None,
    ) -> None:
        for row in rows:
            key = tuple(zip(ROLE_KEYS[role], row))
            notices.add(Notice(code, severity, role, key, field))

    trips = _id_table(con, "_cs_trips", touched.trips)
    stops = _id_table(con, "_cs_stops", touched.ids("stops", "stop_id"))
    routes = _id_table(con, "_cs_routes", touched.ids("routes", "route_id"))
    services = _id_table(con, "_cs_services", touched.services)
    shapes = _id_table(con, "_cs_shapes", touched.ids("shapes", "shape_id"))
    agencies = _id_table(con, "_cs_agencies", touched.ids("agency", "agency_id"))

    def keys_sql(role: str, alias: str = "x") -> str:
        return ", ".join(f"{alias}.{_ident(k)}" for k in ROLE_KEYS[role])

    def touched_rows(role: str) -> Optional[str]:
        """``role``'s touched rows, as a WHERE on alias ``x``."""
        keys = touched.keys.get(role)
        if not keys:
            return None
        cols = ROLE_KEYS[role]
        # Each key as a JSON array of its GTFS texts, matched column by column.
        name = _id_table(
            con,
            f"_cs_rows_{role}",
            (json.dumps([_jsonable(v) for v in k]) for k in keys),
        )
        match = " AND ".join(
            f"{_text(t, role, c, 'x')} = json_extract_string(id, '$[{i}]')"
            for i, c in enumerate(cols)
        )
        return f"EXISTS (SELECT 1 FROM {name} WHERE {match})"

    # Duplicate keys among the rows written.
    for role in touched.keys:
        if not t.has(role):
            continue
        cond = touched_rows(role)
        if cond is None:
            continue
        add(
            "duplicate_key",
            "ERROR",
            role,
            con.execute(
                f"SELECT {keys_sql(role)} FROM {t.name(role)} x WHERE {cond} "
                f"GROUP BY ALL HAVING count(*) > 1"
            ).fetchall(),
        )

    # Required fields on the rows written.
    for role, fields in _REQUIRED.items():
        cond = touched_rows(role) if t.has(role) else None
        if cond is None:
            continue
        cols = set(t.columns(role))
        for f in fields:
            if f not in cols:
                continue
            add(
                "missing_required_field",
                "ERROR",
                role,
                con.execute(
                    f"SELECT {keys_sql(role)} FROM {t.name(role)} x "
                    f"WHERE {cond} AND {_blank(f)}"
                ).fetchall(),
                f,
            )
    if t.has("stops") and (cond := touched_rows("stops")) is not None:
        cols = set(t.columns("stops"))
        kind = "coalesce(location_type, 0)" if "location_type" in cols else "0"
        for f in ("stop_name", "stop_lat", "stop_lon"):
            if f not in cols:
                continue
            add(
                "missing_required_field",
                "ERROR",
                "stops",
                con.execute(
                    f"SELECT {keys_sql('stops')} FROM {t.name('stops')} x "
                    f"WHERE {cond} AND {kind} IN (0, 1, 2) AND {_blank(f)}"
                ).fetchall(),
                f,
            )
    if t.has("stops") and (cond := touched_rows("stops")) is not None:
        _check_stop_locations(t, cond, stops, keys_sql("stops"), add)
    if t.has("routes") and (cond := touched_rows("routes")) is not None:
        cols = set(t.columns("routes"))
        short = _blank("route_short_name") if "route_short_name" in cols else "true"
        long = _blank("route_long_name") if "route_long_name" in cols else "true"
        add(
            "route_both_short_and_long_name_missing",
            "ERROR",
            "routes",
            con.execute(
                f"SELECT {keys_sql('routes')} FROM {t.name('routes')} x "
                f"WHERE {cond} AND {short} AND {long}"
            ).fetchall(),
        )

    # References, from the rows written and to them.
    def foreign(
        child: str,
        column: str,
        parents: Sequence[Tuple[str, str]],
        reach: Sequence[Tuple[str, str]],
    ) -> None:
        """Rows of ``child`` whose ``column`` names nothing in ``parents``
        ((role, column) pairs), among the rows written (``child``'s own) and
        those whose ``column`` (or other columns, ``reach``) points at a
        touched id table."""
        if not t.has(child) or column not in t.columns(child):
            return
        present = [(r, c) for r, c in parents if t.has(r) and c in t.columns(r)]
        if not present:
            return
        own = touched_rows(child)
        reached = [
            f"CAST(x.{_ident(c)} AS VARCHAR) IN (SELECT id FROM {table})"
            for c, table in reach
            if c in t.columns(child)
        ]
        conds = ([own] if own else []) + reached
        if not conds:
            return
        exists = " OR ".join(
            f"EXISTS (SELECT 1 FROM {t.name(r)} p WHERE p.{_ident(c)} = x.{_ident(column)})"
            for r, c in present
        )
        add(
            "foreign_key_violation",
            "ERROR",
            child,
            con.execute(
                f"SELECT {keys_sql(child)} FROM {t.name(child)} x "
                f"WHERE ({' OR '.join(conds)}) AND NOT {_blank(column)} "
                f"AND NOT ({exists})"
            ).fetchall(),
            column,
        )

    foreign("stop_times", "trip_id", [("trips", "trip_id")], [("trip_id", trips)])
    foreign(
        "stop_times",
        "stop_id",
        [("stops", "stop_id")],
        [("trip_id", trips), ("stop_id", stops)],
    )
    foreign(
        "trips",
        "route_id",
        [("routes", "route_id")],
        [("trip_id", trips), ("route_id", routes)],
    )
    foreign(
        "trips",
        "service_id",
        [("calendar", "service_id"), ("calendar_dates", "service_id")],
        [("trip_id", trips), ("service_id", services)],
    )
    foreign(
        "trips",
        "shape_id",
        [("shapes", "shape_id")],
        [("trip_id", trips), ("shape_id", shapes)],
    )
    foreign(
        "routes",
        "agency_id",
        [("agency", "agency_id")],
        [("route_id", routes), ("agency_id", agencies)],
    )
    foreign("frequencies", "trip_id", [("trips", "trip_id")], [("trip_id", trips)])
    foreign(
        "stops",
        "parent_station",
        [("stops", "stop_id")],
        [("stop_id", stops), ("parent_station", stops)],
    )

    # Each touched trip's stop times: in order, with their times consistent.
    if t.has("stop_times") and touched.trips:
        cols = set(t.columns("stop_times"))
        if {"arrival_time", "departure_time"} <= cols:
            types = t.types("stop_times")
            arr = _as_time("arrival_time", types)
            dep = _as_time("departure_time", types)
            rows = f"""
                SELECT trip_id, stop_sequence, {arr} AS arr, {dep} AS dep,
                       row_number() OVER w AS i, count(*) OVER (PARTITION BY trip_id) AS n,
                       max({dep}) OVER (PARTITION BY trip_id ORDER BY stop_sequence
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_dep
                FROM {t.name('stop_times')}
                WHERE CAST(trip_id AS VARCHAR) IN (SELECT id FROM {trips})
                WINDOW w AS (PARTITION BY trip_id ORDER BY stop_sequence)
            """
            add(
                "stop_time_with_only_arrival_or_departure_time",
                "ERROR",
                "stop_times",
                con.execute(
                    f"SELECT trip_id, stop_sequence FROM ({rows}) "
                    "WHERE (arr IS NULL) <> (dep IS NULL)"
                ).fetchall(),
            )
            add(
                "missing_trip_edge",
                "ERROR",
                "stop_times",
                con.execute(
                    f"SELECT trip_id, stop_sequence FROM ({rows}) "
                    "WHERE (i = 1 OR i = n) AND (arr IS NULL OR dep IS NULL)"
                ).fetchall(),
            )
            add(
                "stop_time_with_arrival_before_previous_departure_time",
                "ERROR",
                "stop_times",
                con.execute(
                    f"SELECT trip_id, stop_sequence FROM ({rows}) "
                    "WHERE arr < prev_dep"
                ).fetchall(),
            )
        if t.has("trips"):
            add(
                "unusable_trip",
                "WARNING",
                "trips",
                con.execute(
                    f"""
                    SELECT x.trip_id FROM {t.name('trips')} x
                    WHERE CAST(x.trip_id AS VARCHAR) IN (SELECT id FROM {trips})
                      AND (SELECT count(*) FROM {t.name('stop_times')} st
                           WHERE st.trip_id = x.trip_id) < 2
                    """
                ).fetchall(),
            )
    return notices


def _as_time(column: str, types: Mapping[str, str]) -> str:
    """A stop time's column as an interval, whether stored typed or as text
    (a bundle imported before typing)."""
    col = _ident(column)
    if types.get(column, "").startswith("INTERVAL"):
        return col
    return f"TRY_CAST(NULLIF(trim(CAST({col} AS VARCHAR)), '') AS INTERVAL)"


def _text(t: _Tables, role: str, column: str, alias: str) -> str:
    """``alias.column`` as the text ``_jsonable`` gives for it."""
    types = t.types(role)
    col = f"{alias}.{_ident(column)}"
    kind = types.get(column, "")
    if kind == "DATE":
        return f"strftime({col}, '%Y%m%d')"
    if kind.startswith("INTERVAL"):
        s = f"CAST(epoch({col}) AS BIGINT)"
        return f"printf('%02d:%02d:%02d', {s} // 3600, ({s} % 3600) // 60, {s} % 60)"
    return f"CAST({col} AS VARCHAR)"


# --------------------------------------------------------------------------
# shape_lines


def _real_lines(t: _Tables, shape_ids: Set[Any], derived: Optional[Derived]) -> None:
    """Redraw the lines of ``shape_ids`` from their points."""
    if not shape_ids or not t.has("shape_lines"):
        return
    con = t.con
    ids = _id_table(con, "_cs_line_shapes", shape_ids)
    con.execute(
        f"DELETE FROM {t.name('shape_lines')} "
        f"WHERE CAST(shape_id AS VARCHAR) IN (SELECT id FROM {ids})"
    )
    if not t.has("shapes"):
        return
    _insert_lines(
        t,
        f"""
        SELECT shape_id,
               ST_MakeLine(list(ST_Point(shape_pt_lon, shape_pt_lat)
                                ORDER BY shape_pt_sequence, shape_pt_lon, shape_pt_lat))
                   AS geometry
        FROM {t.name('shapes')}
        WHERE CAST(shape_id AS VARCHAR) IN (SELECT id FROM {ids})
          AND shape_pt_sequence IS NOT NULL
          AND shape_pt_lon IS NOT NULL AND shape_pt_lat IS NOT NULL
        GROUP BY shape_id
        HAVING count(*) >= 2
        """,
        derived,
    )


def _insert_lines(t: _Tables, select: str, derived: Optional[Derived]) -> None:
    """Insert ``select``'s ``(shape_id, geometry)`` rows into shape_lines,
    with the columns the layer derives from geometry."""
    exprs = [("shape_id", "shape_id"), ("geometry", "geometry")]
    if derived:
        exprs += derived("shape_lines", t.columns("shape_lines"), "geometry")
    cols = ", ".join(_ident(c) for c, _ in exprs)
    t.con.execute(
        f"INSERT INTO {t.name('shape_lines')} ({cols}) "
        f"SELECT {', '.join(sql for _, sql in exprs)} FROM ({select})"
    )


def _drawn(t: _Tables) -> str:
    """SQL for the shape ids with a line of their own (two drawable points)."""
    if not t.has("shapes"):
        return "SELECT NULL::VARCHAR AS shape_id WHERE false"
    return f"""
        SELECT CAST(shape_id AS VARCHAR) AS shape_id FROM {t.name('shapes')}
        WHERE shape_pt_sequence IS NOT NULL
          AND shape_pt_lon IS NOT NULL AND shape_pt_lat IS NOT NULL
        GROUP BY shape_id HAVING count(*) >= 2
    """


def _chains(t: _Tables, trips_sql: Optional[str]) -> str:
    """SQL for ``(trip_id, shape_id)``: the stop-chain line of each
    shapeless trip among ``trips_sql`` (all shapeless trips when None), by the
    rule in ``stop_chains``."""
    trip_cols = set(t.columns("trips"))
    shape = (
        "NULLIF(CAST(tr.shape_id AS VARCHAR), '')"
        if "shape_id" in trip_cols
        else "CAST(NULL AS VARCHAR)"
    )
    among = f"AND CAST(tr.trip_id AS VARCHAR) IN ({trips_sql})" if trips_sql else ""
    return f"""
        WITH shapeless AS (
            SELECT tr.trip_id FROM {t.name('trips')} tr
            WHERE ({shape} IS NULL OR {shape} NOT IN ({_drawn(t)})) {among}
        )
        SELECT st.trip_id,
               '{STOP_CHAIN_PREFIX}' || md5(string_agg(CAST(st.stop_id AS VARCHAR), chr(31)
                                                      ORDER BY st.stop_sequence)) AS shape_id
        FROM {t.name('stop_times')} st
        JOIN shapeless USING (trip_id)
        WHERE st.stop_sequence IS NOT NULL
          AND st.stop_id IN (SELECT stop_id FROM {t.name('stops')})
        GROUP BY st.trip_id
    """


def _chain_trips(t: _Tables, touched: _Touched) -> Optional[str]:
    """SQL listing the trips whose stop-chain line the change may move: the
    trips it touches, those calling at a stop it touches, and those on a
    shape it touches."""
    if not (t.has("trips") and t.has("stop_times") and t.has("stops")):
        return None
    con = t.con
    trips = _id_table(con, "_cs_chain_trips", touched.trips)
    stops = _id_table(con, "_cs_chain_stops", touched.ids("stops", "stop_id"))
    shapes = _id_table(con, "_cs_chain_shapes", touched.ids("shapes", "shape_id"))
    on_shape = (
        f"UNION SELECT CAST(trip_id AS VARCHAR) FROM {t.name('trips')} "
        f"WHERE CAST(shape_id AS VARCHAR) IN (SELECT id FROM {shapes})"
        if "shape_id" in t.columns("trips")
        else ""
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE _cs_chain_reach AS
        SELECT id FROM {trips}
        UNION SELECT CAST(trip_id AS VARCHAR) FROM {t.name('stop_times')}
              WHERE CAST(stop_id AS VARCHAR) IN (SELECT id FROM {stops})
        {on_shape}
        """
    )
    return "SELECT id FROM _cs_chain_reach"


def _chain_lines(
    t: _Tables, before: Set[str], reach: Optional[str], derived: Optional[Derived]
) -> None:
    """Redraw the stop-chain lines of the trips ``reach`` lists, and drop
    those of ``before`` no trip uses any more."""
    if reach is None or not t.has("shape_lines"):
        return
    con = t.con
    now = {
        str(r[0])
        for r in con.execute(
            f"SELECT DISTINCT shape_id FROM ({_chains(t, reach)})"
        ).fetchall()
    }
    gone = before - now
    if gone:
        # Still used by a trip the change did not reach?
        still = {
            str(r[0])
            for r in con.execute(
                f"SELECT DISTINCT shape_id FROM ({_chains(t, None)}) "
                f"WHERE shape_id IN (SELECT id FROM {_id_table(con, '_cs_gone', gone)})"
            ).fetchall()
        }
        gone -= still
    redraw = now | gone
    if not redraw:
        return
    ids = _id_table(con, "_cs_chain_ids", redraw)
    con.execute(
        f"DELETE FROM {t.name('shape_lines')} "
        f"WHERE CAST(shape_id AS VARCHAR) IN (SELECT id FROM {ids})"
    )
    if not now:
        return
    stop_cols = set(t.columns("stops"))
    if not {"stop_lon", "stop_lat"} <= stop_cols:
        return
    lon, lat, station = "s.stop_lon", "s.stop_lat", ""
    if "parent_station" in stop_cols:
        lon, lat = (
            "coalesce(s.stop_lon, p.stop_lon)",
            "coalesce(s.stop_lat, p.stop_lat)",
        )
        station = f"LEFT JOIN {t.name('stops')} p ON p.stop_id = s.parent_station"
    _insert_lines(
        t,
        f"""
        WITH c AS ({_chains(t, reach)}),
        one AS (SELECT shape_id, min(trip_id) AS trip_id FROM c GROUP BY shape_id),
        pts AS (
            SELECT one.shape_id, st.stop_sequence, {lon} AS lon, {lat} AS lat
            FROM one JOIN {t.name('stop_times')} st ON st.trip_id = one.trip_id
            JOIN {t.name('stops')} s ON s.stop_id = st.stop_id {station}
            WHERE st.stop_sequence IS NOT NULL
        )
        SELECT shape_id, ST_MakeLine(list(ST_Point(lon, lat) ORDER BY stop_sequence))
                   AS geometry
        FROM pts WHERE lon IS NOT NULL AND lat IS NOT NULL
        GROUP BY shape_id HAVING count(*) >= 2
        """,
        derived,
    )


# --------------------------------------------------------------------------


def apply_changeset(
    con: Any,
    tables: Mapping[str, str],
    changeset: ChangeSet,
    derived: Optional[Derived] = None,
) -> Applied:
    """Apply ``changeset`` to ``tables`` (role → table), in the caller's
    transaction. Raises ``ChangeSetError`` for a malformed change set and
    ``ChangeSetIntegrityError`` when it would bring an ERROR; the caller rolls back
    on either."""
    phase = _Phases()
    t = _Tables(con, tables)
    changeset = _shift_stop_times(t, changeset)
    net = _squash(_parse_ops(t, changeset))
    touched = _Touched({role: set(rows) for role, rows in net.items() if rows})
    phase(f"parse {sum(len(r) for r in net.values())} rows")

    before = _check(t, touched)
    phase("check before")
    reach = _chain_trips(t, touched)
    chains_before = (
        {
            str(r[0])
            for r in con.execute(
                f"SELECT DISTINCT shape_id FROM ({_chains(t, reach)})"
            ).fetchall()
        }
        if reach is not None
        else set()
    )

    # The shapes of the trips it deletes: dropped after, where no trip runs
    # them any more.
    freed = _shapes_of_deleted_trips(t, net)
    phase("chains and shapes before")

    applied = Applied()
    for role, rows in net.items():
        if not rows:
            continue
        applied.rows[role] = (
            _write_rows_one_by_one(t, role, rows, derived)
            if role in _ROW_BY_ROW
            else _write_rows(t, role, rows)
        )
        phase(f"write {role}")

    _cascade_references(t, net, applied)
    unused = _drop_unused_shapes(t, freed, applied)
    phase("references and shapes")
    reshaped: Set[str] = set()
    for op in changeset.ops:
        if isinstance(op, ShapeReshape):
            _reshape(t, op)
            reshaped.add(str(op.key["shape_id"]))
    if reshaped:
        counts = applied.rows.setdefault(
            "shapes", {"inserted": 0, "updated": 0, "deleted": 0}
        )
        counts["updated"] += len(reshaped)
    _real_lines(t, touched.ids("shapes", "shape_id") | reshaped | unused, derived)
    _chain_lines(t, chains_before, reach, derived)
    phase("lines")

    after = _check(t, touched)
    phase("check after")
    new = sorted(after - before, key=lambda n: (n.severity, n.code, n.role, str(n.key)))
    errors = [n for n in new if n.severity == "ERROR"]
    if errors:
        raise ChangeSetIntegrityError(errors)
    applied.warnings = [n for n in new if n.severity == "WARNING"]
    _drop_scratch(con)
    phase.log()
    return applied


# --------------------------------------------------------------------------
# Writing the rows

#: Written a row at a time: a stop's geometry, and the columns the layer
#: derives from it, are spelled from its own coordinates. A change set has
#: few of them; the trips and stop times are the many.
_ROW_BY_ROW = frozenset({"stops"})

_staged = 0


def _scratch(prefix: str) -> str:
    """A fresh name for a scratch table or view; ``_cs_`` ones are dropped by
    ``_drop_scratch``."""
    global _staged
    _staged += 1
    return f"{prefix}{_staged}"


def _arrow_rows(rows: Sequence[Tuple[Any, ...]], width: int) -> Any:
    """``rows`` as an Arrow table of ``width`` columns (``c0``, ...), or None
    where Arrow cannot hold them as a parameter would: a column of more than
    one Python type, say."""
    if pa is None:
        return None
    columns: Dict[str, Any] = {}
    try:
        for i in range(width):
            values = [row[i] for row in rows]
            if len({type(v) for v in values if v is not None}) > 1:
                return None
            if any(isinstance(v, timedelta) for v in values):
                # As DuckDB takes a timedelta parameter: its whole days apart
                # from the rest, so 25:10:00 is held, and printed, alike.
                columns[f"c{i}"] = pa.array(
                    [
                        None
                        if v is None
                        else (
                            0,
                            v.days,
                            (v.seconds * 1_000_000 + v.microseconds) * 1000,
                        )
                        for v in values
                    ],
                    pa.month_day_nano_interval(),
                )
            else:
                columns[f"c{i}"] = pa.array(values)
    except (pa.ArrowException, TypeError, ValueError, OverflowError):
        return None
    return pa.table(columns)


def _ingest(con: Any, name: str, rows: Sequence[Tuple[Any, ...]], width: int) -> None:
    """Put ``rows`` into the scratch table ``name``, each value cast to its
    column's type as a parameter is. Through Arrow, in one statement:
    ``executemany`` runs a statement per row, some 7 s for 20,000 of them."""
    if not rows:
        return
    table = _arrow_rows(rows, width)
    if table is None:
        con.executemany(f"INSERT INTO {name} VALUES ({', '.join('?' * width)})", rows)
        return
    view = _scratch("_cs_arrow_")
    con.register(view, table)
    try:
        con.execute(f"INSERT INTO {name} SELECT * FROM {view}")
    finally:
        con.unregister(view)


def _stage(
    t: _Tables,
    role: str,
    columns: Sequence[str],
    rows: List[Tuple[Any, ...]],
    extra: Sequence[Tuple[str, str]] = (),
) -> str:
    """A scratch table of ``columns``, typed as ``role``'s table types them,
    and of ``extra`` columns (name, SQL type), holding ``rows``: what one
    statement then writes for all of them."""
    name = _scratch("_cs_w_")
    picks = [_ident(c) for c in columns] + [
        f"CAST(NULL AS {ty}) AS {c}" for c, ty in extra
    ]
    t.con.execute(
        f"CREATE TEMP TABLE {name} AS SELECT {', '.join(picks)} FROM {t.name(role)} LIMIT 0"
    )
    _ingest(t.con, name, rows, len(columns) + len(extra))
    return name


def _key_sql(types: Mapping[str, str], role: str, column: str, alias: str) -> str:
    """``alias.column`` as a key is compared. A bundle imported before typing
    holds a time, date or number as text: compared in the type GTFS gives it
    (``6:00:00`` is ``06:00:00``), as a row's own statement against a typed
    value compares it."""
    col = f"{alias}.{_ident(column)}"
    spec = SCHEMA.get(role, {}).get(column)
    if spec is not None and types.get(column) == "VARCHAR":
        return f"CAST({col} AS {SQL_TYPE[spec.kind]})"
    return col


def _matches(t: _Tables, role: str, a: str, b: str) -> str:
    """``a``'s row and ``b``'s are the same row: their keys are equal."""
    types = t.types(role)
    return " AND ".join(
        f"{_key_sql(types, role, k, a)} = {_key_sql(types, role, k, b)}"
        for k in ROLE_KEYS[role]
    )


def _existing(t: _Tables, role: str, keys: List[Tuple[Any, ...]]) -> Set[int]:
    """Which of ``keys`` (by their place) ``role``'s table has, in one query;
    compared as a row's own statement compares them (``_key_sql``)."""
    staged = _stage(
        t,
        role,
        ROLE_KEYS[role],
        [k + (i,) for i, k in enumerate(keys)],
        [("_i", "INTEGER")],
    )
    return {
        int(r[0])
        for r in t.con.execute(
            f"SELECT DISTINCT k._i FROM {staged} k JOIN {t.name(role)} x ON {_matches(t, role, 'x', 'k')}"
        ).fetchall()
    }


def _check_exists(
    role: str, rows: Mapping[Tuple[Any, ...], Any], existing: Set[int]
) -> None:
    for i, (key, n) in enumerate(rows.items()):
        where = f"{role} {dict(zip(ROLE_KEYS[role], (_jsonable(k) for k in key)))}"
        if n.kind == "insert" and i in existing:
            raise ChangeSetError(f"{where} already exists")
        if n.kind in ("update", "delete", "replace") and i not in existing:
            raise ChangeSetError(f"{where} is not there")


def _copy_sources(t: _Tables, role: str, sources: List[Tuple[Any, ...]]) -> str:
    """A scratch table of the rows ``sources`` name, as the table has them
    now: one per source (the first found, where a key names two rows), by its
    place in ``sources`` (``_cs_k``), with the columns a copy may take."""
    staged = _stage(
        t,
        role,
        ROLE_KEYS[role],
        [k + (i,) for i, k in enumerate(sources)],
        [("_cs_k", "INTEGER")],
    )
    name = _scratch("_cs_src_")
    cols = ", ".join(
        f"x.{_ident(c)}" for c in t.columns(role) if c not in DERIVED_COLUMNS
    )
    t.con.execute(
        f"CREATE TEMP TABLE {name} AS SELECT k._cs_k, {cols} FROM {staged} k "
        f"JOIN {t.name(role)} x ON {_matches(t, role, 'x', 'k')} "
        "QUALIFY row_number() OVER (PARTITION BY k._cs_k) = 1"
    )
    return name


def _write_rows(
    t: _Tables, role: str, rows: Mapping[Tuple[Any, ...], Any]
) -> Dict[str, int]:
    """``role``'s rows written a statement per kind, not per row: on a
    network of millions of stop times, a row's own statement scans its table
    each time, and an edit of many trips took minutes. Updates and deletes
    first (never of the same row), then inserts: a replace is a delete and an
    insert, never an update of a row just inserted. The rows copied from are
    read between the updates and the deletes (``RowOp.copy_of``)."""
    keys = ROLE_KEYS[role]
    table = t.name(role)
    _check_exists(role, rows, _existing(t, role, list(rows)))
    counts = {"inserted": 0, "updated": 0, "deleted": 0}

    # Updates, by the columns they set.
    updates: Dict[Tuple[str, ...], List[Tuple[Any, ...]]] = {}
    for key, n in rows.items():
        if n.kind == "update":
            cols = tuple(n.values)
            updates.setdefault(cols, []).append(key + tuple(n.values[c] for c in cols))
            counts["updated"] += 1
    for cols, values in updates.items():
        staged = _stage(t, role, keys + cols, values)
        sets = ", ".join(f"{_ident(c)} = s.{_ident(c)}" for c in cols)
        t.con.execute(
            f"UPDATE {table} SET {sets} FROM {staged} s WHERE {_matches(t, role, 's', table)}"
        )

    # The rows copied from, before a delete takes one: each once.
    sources: Dict[Tuple[Any, ...], int] = {}
    for n in rows.values():
        if n.kind in ("insert", "replace") and n.copy_of is not None:
            sources.setdefault(n.copy_of, len(sources))
    copied_from = _copy_sources(t, role, list(sources)) if sources else None

    gone = [key for key, n in rows.items() if n.kind in ("delete", "replace")]
    if gone:
        staged = _stage(t, role, keys, gone)
        t.con.execute(
            f"DELETE FROM {table} WHERE EXISTS "
            f"(SELECT 1 FROM {staged} k WHERE {_matches(t, role, 'k', table)})"
        )
        for key in gone:
            counts["deleted" if rows[key].kind == "delete" else "updated"] += 1

    # Inserts, by the columns they give, and copies by the row they copy:
    # its columns the insert leaves out, but those the layer derives.
    plain: Dict[Tuple[str, ...], List[Tuple[Any, ...]]] = {}
    copies: Dict[Tuple[str, ...], List[Tuple[Any, ...]]] = {}
    for key, n in rows.items():
        if n.kind not in ("insert", "replace"):
            continue
        cols = tuple(c for c in n.values if c not in keys)
        values = key + tuple(n.values[c] for c in cols)
        if n.copy_of is None:
            plain.setdefault(cols, []).append(values)
        else:
            copies.setdefault(cols, []).append(values + (sources[n.copy_of],))
        if n.kind == "insert":
            counts["inserted"] += 1
    for cols, values in plain.items():
        staged = _stage(t, role, keys + cols, values)
        names = ", ".join(_ident(c) for c in keys + cols)
        t.con.execute(f"INSERT INTO {table} ({names}) SELECT {names} FROM {staged}")
    for cols, values in copies.items():
        given = keys + cols
        staged = _stage(t, role, given, values, [("_cs_k", "INTEGER")])
        copied = [
            c for c in t.columns(role) if c not in given and c not in DERIVED_COLUMNS
        ]
        names = ", ".join(_ident(c) for c in given + tuple(copied))
        picks = ", ".join(
            [f"s.{_ident(c)}" for c in given] + [f"x.{_ident(c)}" for c in copied]
        )
        t.con.execute(
            f"INSERT INTO {table} ({names}) SELECT {picks} FROM {staged} s "
            f"LEFT JOIN {copied_from} x ON x._cs_k = s._cs_k"
        )
    return counts


def _write_rows_one_by_one(
    t: _Tables,
    role: str,
    rows: Mapping[Tuple[Any, ...], Any],
    derived: Optional[Derived],
) -> Dict[str, int]:
    """``role``'s rows a statement each (``_ROW_BY_ROW``): deletes, then
    updates, then inserts. None of them is a copy: the Explorer copies trips
    and their stop times, never a stop."""
    if any(n.copy_of is not None for n in rows.values()):
        raise ChangeSetError(f"a {role} row is not copied")
    _check_exists(role, rows, _existing(t, role, list(rows)))
    counts = {"inserted": 0, "updated": 0, "deleted": 0}
    for key, n in rows.items():
        if n.kind in ("delete", "replace"):
            _delete(t, role, key)
            counts["deleted" if n.kind == "delete" else "updated"] += 1
    for key, n in rows.items():
        if n.kind == "update":
            _update(t, role, key, n.values, derived)
            counts["updated"] += 1
    for key, n in rows.items():
        if n.kind in ("insert", "replace"):
            _insert(t, role, key, n.values, derived)
            if n.kind == "insert":
                counts["inserted"] += 1
    return counts


_EARTH_M = 6371008.8


def _metres(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Metres between two (lon, lat) points, as the snapshot measures."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * _EARTH_M * math.asin(math.sqrt(min(1.0, h)))


def _along(
    pts: List[Tuple[float, float]], m: List[float], at: float
) -> Tuple[float, float]:
    """The point ``at`` metres along ``pts`` (``m``: metres at each)."""
    if at <= m[0]:
        return pts[0]
    for k in range(1, len(pts)):
        if at <= m[k]:
            f = (at - m[k - 1]) / (m[k] - m[k - 1]) if m[k] > m[k - 1] else 0.0
            p, q = pts[k - 1], pts[k]
            return (p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1]))
    return pts[-1]


def _value_at(m: List[float], v: List[float], at: float) -> float:
    """``v`` (one per point) interpolated ``at`` metres along."""
    if at <= m[0]:
        return v[0]
    for k in range(1, len(m)):
        if at <= m[k]:
            f = (at - m[k - 1]) / (m[k] - m[k - 1]) if m[k] > m[k - 1] else 0.0
            return v[k - 1] + f * (v[k] - v[k - 1])
    return v[-1]


def _reshape(t: _Tables, op: ShapeReshape) -> None:
    """Write ``op``'s shape: its source's points, every stretch drawn straight
    through its points; the shape's own distances and those of the stop
    times on it kept in the feed's unit (01-editing-operations 2.2)."""
    con = t.con
    shapes = t.name("shapes")
    cols = set(t.columns("shapes"))
    with_dist = "shape_dist_traveled" in cols
    rows = con.execute(
        f"SELECT shape_pt_lon, shape_pt_lat"
        f"{', shape_dist_traveled' if with_dist else ''} FROM {shapes} "
        "WHERE shape_id = $s AND shape_pt_lon IS NOT NULL AND shape_pt_lat IS NOT NULL "
        "ORDER BY shape_pt_sequence",
        {"s": op.source},
    ).fetchall()
    if len(rows) < 2:
        raise ChangeSetError(f"shape {op.source} has no line to redraw")
    pts = [(float(r[0]), float(r[1])) for r in rows]
    m = [0.0]
    for k in range(1, len(pts)):
        m.append(m[-1] + _metres(pts[k - 1], pts[k]))
    length = m[-1]
    dists = [r[2] for r in rows] if with_dist else []
    # The feed's unit per metre, where the shape gives its distances.
    unit: Optional[float] = None
    if with_dist and all(d is not None for d in dists) and length > 0:
        fd = [float(d) for d in dists]
        # Only distances that grow along the shape measure it: all zero, one
        # value, or going back are no unit, and the fallback below applies.
        if fd[-1] > fd[0] and all(x <= y for x, y in zip(fd, fd[1:])):
            unit = (fd[-1] - fd[0]) / length
            dists = fd
    shape_dists = unit is not None
    if unit is None and op.metres_per_unit:
        # The shape gives none: its stop times' unit, measured from its start.
        unit = 1 / op.metres_per_unit
        dists = [x * unit for x in m]
    out: List[Tuple[float, float, Optional[float]]] = []
    # Per stretch: the new segments' lengths, and how far the shape moved on.
    legs: List[Tuple[bool, float, float, float, float, Optional[float]]] = []
    # Per stretch: where it lies in the feed's unit, halfway (a trip that does
    # not call at the stop lies wholly before or after it), and how far the
    # shape moved on past it.
    middles: List[Tuple[float, float]] = []
    offset = 0.0
    cursor = -math.inf
    for st in sorted(op.stretches, key=lambda x: -1 if x.start is None else x.start):
        a = None if st.start is None else st.start * length
        b = None if st.end is None else st.end * length
        before = offset
        start: Optional[Tuple[float, float]] = None
        start_d = dists[0] if unit else None
        if a is not None:
            for k, p in enumerate(pts):
                if cursor < m[k] < a:
                    out.append((p[0], p[1], dists[k] + offset if unit else None))
            start = _along(pts, m, a)
            start_d = _value_at(m, dists, a) + offset if unit else None
            out.append((start[0], start[1], start_d))
        into = 0.0
        prev = start
        # How far the stop's stop times move on: from where it was on the
        # shape to its new point (``stop_point``), in the feed's unit.
        shift: Optional[float] = None
        to_stop = 0.0
        for n, q in enumerate(st.points):
            if prev is not None:
                into += _metres(prev, q)
            d = (start_d or 0.0) + into * unit if unit else None
            if n == st.stop_point:
                to_stop = into
                if d is not None and st.at is not None:
                    shift = d - _value_at(m, dists, st.at * length)
            out.append((q[0], q[1], d))
            prev = q
        through_m = into
        # Beyond the stop, to the stretch's last point.
        past_stop = through_m - to_stop
        if b is not None:
            end = _along(pts, m, b)
            out_m = _metres(prev, end) if prev else 0.0
            if unit:
                end_d = (start_d or 0.0) + (through_m + out_m) * unit
                offset = end_d - _value_at(m, dists, b)
            out.append((end[0], end[1], end_d if unit else None))
            cursor = b
            legs.append((a is None, to_stop, past_stop + out_m, before, offset, shift))
            if unit:
                lo = _value_at(m, dists, a) if a is not None else dists[0]
                middles.append(((lo + _value_at(m, dists, b)) / 2, offset))
        else:
            cursor = math.inf
            legs.append((a is None, to_stop, past_stop, before, before, shift))
    for k, p in enumerate(pts):
        if m[k] > cursor:
            out.append((p[0], p[1], dists[k] + offset if unit else None))

    con.execute(f"DELETE FROM {shapes} WHERE shape_id = $s", {"s": op.key["shape_id"]})
    with_dist = with_dist and shape_dists
    dist_col = ", shape_dist_traveled" if with_dist else ""
    con.executemany(
        f"INSERT INTO {shapes} (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence{dist_col}) "
        f"VALUES ($1, $2, $3, $4{', $5' if with_dist else ''})",
        [
            [op.key["shape_id"], lat, lon, k + 1, *([d] if with_dist else [])]
            for k, (lon, lat, d) in enumerate(out)
        ],
    )
    if (
        unit is None
        or not t.has("stop_times")
        or "shape_dist_traveled" not in t.columns("stop_times")
    ):
        return
    # The trips on it: the stop moved on as far as its new point lies past
    # where it was (from its neighbour where that is not known), the stops
    # past it as far as the shape moved on there.
    passed = " ".join(f"WHEN {k + 1} THEN {leg[4] * 1.0}" for k, leg in enumerate(legs))
    # A trip on the shape that does not call at the stop: moved on as far as
    # the shape did where it runs.
    beyond = " ".join(
        f"WHEN shape_dist_traveled >= {mid} THEN {after * 1.0}"
        for mid, after in sorted(middles, reverse=True)
    )
    here = " ".join(
        f"WHEN {k + 1} THEN "
        + (
            f"shape_dist_traveled + {shift}"
            if shift is not None
            else f"nxt + {after - out_m * unit}"
            if first
            else f"prev + {before + into * unit}"
        )
        for k, (first, into, out_m, before, after, shift) in enumerate(legs)
    )
    times = t.name("stop_times")
    trips = t.name("trips")
    # The trips the Explorer had on it, where it said; else those on it now.
    on_it = (
        "list_contains($trips, trip_id)"
        if op.trips is not None
        else f"trip_id IN (SELECT trip_id FROM {trips} WHERE shape_id = $s)"
    )
    con.execute(
        f"""
        UPDATE {times} SET shape_dist_traveled = x.nd FROM (
            SELECT trip_id, stop_sequence,
                   -- A neighbour without a distance leaves the stop's own as it was.
                   CASE WHEN here THEN COALESCE(CASE upto {here} END, shape_dist_traveled)
                        WHEN calls = 0 THEN shape_dist_traveled + {f"CASE {beyond} ELSE 0 END" if beyond else "0"}
                        ELSE shape_dist_traveled + CASE upto {passed} ELSE 0 END END AS nd
            FROM (
                SELECT trip_id, stop_sequence, shape_dist_traveled, stop_id = $through AS here,
                       -- The k-th call here: one right after another here is
                       -- the same stretch, counted with it.
                       sum(CASE WHEN stop_id = $through AND prev_stop IS DISTINCT FROM $through
                                THEN 1 ELSE 0 END) OVER (
                           PARTITION BY trip_id ORDER BY stop_sequence
                           ROWS UNBOUNDED PRECEDING) AS upto,
                       sum(CASE WHEN stop_id = $through THEN 1 ELSE 0 END) OVER (
                           PARTITION BY trip_id) AS calls,
                       lag(shape_dist_traveled) OVER w AS prev,
                       lead(shape_dist_traveled) OVER w AS nxt
                FROM (SELECT *, lag(stop_id) OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS prev_stop
                      FROM {times}) st
                WHERE {on_it}
                WINDOW w AS (PARTITION BY trip_id ORDER BY stop_sequence)
            )
        ) x
        WHERE {times}.trip_id = x.trip_id AND {times}.stop_sequence = x.stop_sequence
          AND {times}.shape_dist_traveled IS NOT NULL
        """,
        {
            "through": op.through,
            **(
                {"trips": op.trips}
                if op.trips is not None
                else {"s": op.key["shape_id"]}
            ),
        },
    )


def _cascade_references(
    t: _Tables, net: Mapping[str, Mapping[Tuple[Any, ...], _Net]], applied: Applied
) -> None:
    """Delete the rows of ``REFERENCES`` that name a stop, route or trip the
    change set deleted, counted with what it wrote."""
    for owner, references in REFERENCES.items():
        gone = [key[0] for key, n in net.get(owner, {}).items() if n.kind == "delete"]
        if not gone:
            continue
        for role, columns in references.items():
            present = [c for c in columns if t.has(role) and c in t.columns(role)]
            if not present:
                continue
            where = " OR ".join(
                f"{_ident(c)} IN (SELECT UNNEST($gone))" for c in present
            )
            (n,) = t.con.execute(
                f"SELECT count(*) FROM {t.name(role)} WHERE {where}", {"gone": gone}
            ).fetchone()
            if n:
                t.con.execute(
                    f"DELETE FROM {t.name(role)} WHERE {where}", {"gone": gone}
                )
                counts = applied.rows.setdefault(
                    role, {"inserted": 0, "updated": 0, "deleted": 0}
                )
                counts["deleted"] += int(n)


def _shapes_of_deleted_trips(
    t: _Tables, net: Mapping[str, Mapping[Tuple[Any, ...], _Net]]
) -> Set[str]:
    """The shapes the trips ``net`` deletes run, before they go."""
    gone = [key[0] for key, n in net.get("trips", {}).items() if n.kind == "delete"]
    if not gone or not t.has("trips") or "shape_id" not in t.columns("trips"):
        return set()
    return {
        str(r[0])
        for r in t.con.execute(
            f"SELECT DISTINCT shape_id FROM {t.name('trips')} "
            "WHERE trip_id IN (SELECT UNNEST($gone)) AND shape_id IS NOT NULL",
            {"gone": gone},
        ).fetchall()
    }


def _drop_unused_shapes(t: _Tables, freed: Set[str], applied: Applied) -> Set[str]:
    """Delete the shapes of ``freed`` no trip runs any more (a line deleted,
    1.5): a shape nothing runs is a line the map would still draw. Returns
    their ids, whose lines go with them."""
    if not freed or not t.has("shapes"):
        return set()
    shapes = t.name("shapes")
    unused = {
        str(r[0])
        for r in t.con.execute(
            f"SELECT DISTINCT shape_id FROM {shapes} "
            "WHERE CAST(shape_id AS VARCHAR) IN (SELECT UNNEST($freed)) "
            f"AND shape_id NOT IN (SELECT shape_id FROM {t.name('trips')} "
            "WHERE shape_id IS NOT NULL)",
            {"freed": sorted(freed)},
        ).fetchall()
    }
    if unused:
        t.con.execute(
            f"DELETE FROM {shapes} WHERE CAST(shape_id AS VARCHAR) IN (SELECT UNNEST($u))",
            {"u": sorted(unused)},
        )
        counts = applied.rows.setdefault(
            "shapes", {"inserted": 0, "updated": 0, "deleted": 0}
        )
        counts["deleted"] += len(unused)
    return unused


def _drop_scratch(con: Any) -> None:
    """Drop the temp tables the checks used. On a failure the caller's
    rollback drops them; on success they would stay on its connection."""
    for (name,) in con.execute(
        "SELECT table_name FROM duckdb_tables() "
        "WHERE temporary AND starts_with(table_name, '_cs_')"
    ).fetchall():
        con.execute(f"DROP TABLE IF EXISTS {_ident(name)}")
