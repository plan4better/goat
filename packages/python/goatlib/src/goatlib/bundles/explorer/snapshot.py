"""The Explorer snapshot: a GTFS bundle as compact, indexed Parquet.

The Explorer loads a whole bundle into DuckDB-WASM in the browser. A city's
member tables are too large for that as stored — text ids repeated on every
stop time — so this writes them once per bundle revision in the form the
browser works with:

- every entity gets a dense integer index (``trip_idx``, ``stop_idx``, …) and
  keeps its GTFS id next to it, so each table doubles as the map back to the
  ids a later edit is written in;
- times are seconds since the start of the service day (GTFS times run past
  24:00), dates are dates;
- stop times are sorted by trip and sequence, trips by route, direction,
  pattern and first departure, so a route is one contiguous range of trips
  (``routes.trip_lo``/``trip_hi``) and of stop times;
- the few things that need a scan of every stop time are computed here once:
  each trip's pattern (its ordered stops), first departure, last arrival and
  length.

Nothing here is specific to where the tables live: ``relation_for_role``
names a relation per GTFS role (a DuckLake table pinned at a snapshot, a
``read_parquet`` call in a test), and the connection does the rest.

Data the feed contradicts — a stop time naming a trip or stop that does not
exist — is left out and counted in the manifest's ``warnings``; the bundle
itself is not touched.
"""

import json
import math
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from goatlib.bundles.importers.pt_network.stop_chains import STOP_CHAIN_PREFIX
from goatlib.io.config import parquet_copy_options

#: Bumped when a file's columns or meaning change; part of the files' URLs,
#: so a browser never mixes files of two versions.
SCHEMA_VERSION = 3

#: GTFS ``shape_dist_traveled`` has no fixed unit. The feed's unit is the one
#: of these (metres per unit) nearest to what its stops' straight-line
#: distances suggest.
_DIST_UNITS = {"m": 1.0, "km": 1000.0, "ft": 0.3048, "mi": 1609.344}

_PARQUET_OPTIONS = ("COMPRESSION zstd", "COMPRESSION_LEVEL 3", "ROW_GROUP_SIZE 122880")

#: The tables written, in the order a browser should load them: what lists the
#: routes first, the large stop times last.
FILES = (
    "agencies",
    "routes",
    "services",
    "calendar_dates",
    "stops",
    "patterns",
    "trips",
    "frequencies",
    "shapes_meta",
    "shape_points",
    "pattern_shape_stops",
    "shape_route",
    "stop_time_extras",
    "stop_times",
)

#: Shapes are simplified to this tolerance, in metres: finer than a vehicle
#: marker at any zoom, and less than half the points of a typical feed.
SHAPE_TOLERANCE_M = 2.0
#: Metres per degree of latitude, for the shapes' local planar frame.
_M_PER_DEG = 111_195.0
#: Shapes simplified per statement: a whole feed's at once overruns the build's
#: memory (an ordered list per shape); a thousand at a time stays small.
_SHAPE_BATCH = 1000

#: The roles the snapshot reads.
ROLES = (
    "agency",
    "stops",
    "routes",
    "trips",
    "stop_times",
    "calendar",
    "calendar_dates",
    "frequencies",
    "shapes",
    "shape_lines",
)

_WEEKDAYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

_TEMP_TABLES = (
    "x_agencies",
    "x_stops",
    "x_routes0",
    "x_services",
    "x_calendar_dates",
    "x_st0",
    "x_trips0",
    "x_trip_stops",
    "x_patterns0",
    "x_trips",
    "x_shapes_meta",
    "x_shape_lines",
    "x_shape_points",
    "x_chain_patterns",
    "x_chain_shapes",
    "x_pattern_shape_stops",
)


def _columns(con: Any, relation: str) -> List[str]:
    return [
        str(r[0]) for r in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
    ]


def _col(
    present: List[str], name: str, cast: str, default: str = "NULL", alias: str = ""
) -> str:
    """``name`` cast as ``cast`` when the file has the column, else ``default``.

    Optional columns are common in GTFS, so every one is read through this
    rather than assumed. ``alias`` qualifies the column (``st``)."""
    if name in present:
        ref = f'{alias}."{name}"' if alias else f'"{name}"'
        return f"CAST({ref} AS {cast})"
    return f"CAST({default} AS {cast})"


def _seconds(present: List[str], name: str, alias: str = "") -> str:
    """A GTFS time column as seconds since the start of the service day."""
    if name not in present:
        return "CAST(NULL AS INTEGER)"
    ref = f'{alias}."{name}"' if alias else f'"{name}"'
    return f"CAST(epoch({ref}) AS INTEGER)"


def build_snapshot(
    con: Any,
    relation_for_role: Callable[[str], Optional[str]],
    out_dir: str,
) -> Dict[str, Any]:
    """Write the snapshot's Parquet files into ``out_dir``; return the manifest.

    ``con`` is a DuckDB connection, already bounded in memory by the caller.
    ``relation_for_role(role)`` returns a SQL relation for a GTFS role
    (``stops``, ``stop_times``, …) of typed member data, or None when the
    bundle has no such member. ``out_dir`` must exist and be empty.

    The manifest lists each file with its row count and size; ``manifest.json``
    is not written here (see ``write_manifest``), so the caller decides when
    the snapshot is complete.
    """
    rel = {role: relation_for_role(role) for role in ROLES}
    for required in ("stops", "routes", "trips", "stop_times"):
        if rel[required] is None:
            raise ValueError(f"The bundle has no {required} layer")
    present = {role: _columns(con, r) for role, r in rel.items() if r is not None}
    warnings: Dict[str, int] = {}
    con.execute(
        """
        CREATE OR REPLACE TEMP MACRO _hav_m(lat1, lon1, lat2, lon2) AS
            2 * 6371008.8 * asin(sqrt(
                pow(sin(radians(lat2 - lat1) / 2), 2)
                + cos(radians(lat1)) * cos(radians(lat2))
                  * pow(sin(radians(lon2 - lon1) / 2), 2)))
        """
    )
    try:
        _agencies(con, rel, present)
        _stops(con, rel, present)
        _routes(con, rel, present)
        _services(con, rel, present)
        _stop_times(con, rel, present, warnings)
        _trips0(con, rel, present, warnings)
        _trip_stops(con, warnings)
        scale, unit = _distance_scale(con)
        _shapes(con, rel, present)
        lines_role = _shape_lines(con, rel, present)
        _patterns_and_trips(con, scale)
        _stop_chain_shapes(con)
        _pattern_shape_stops(con)

        files = []
        for name in FILES:
            path = os.path.join(out_dir, f"{name}.parquet")
            query = _QUERIES.get(name) or _OPTIONAL[name](rel, present)
            con.execute(
                f"COPY ({query}) TO '{path}' {parquet_copy_options(*_PARQUET_OPTIONS)}"
            )
            rows = con.execute(
                f"SELECT count(*) FROM read_parquet('{path}')"
            ).fetchone()
            files.append(
                {"name": name, "rows": int(rows[0]), "bytes": os.path.getsize(path)}
            )
        window = con.execute(
            "SELECT min(start_date), max(end_date) FROM x_services"
        ).fetchone()
    finally:
        for table in _TEMP_TABLES:
            con.execute(f"DROP TABLE IF EXISTS {table}")
    return {
        "schema_version": SCHEMA_VERSION,
        "files": files,
        "warnings": warnings,
        "shape_dist_unit": unit,
        # The member whose features are the shapes as lines, for the map to
        # draw the network from: shape_lines, or an older import's shapes.
        "shape_lines_role": lines_role,
        "service_window": [d.isoformat() if d else None for d in window],
    }


def write_manifest(out_dir: str, manifest: Dict[str, Any]) -> None:
    """Write ``manifest.json`` last: its presence marks the snapshot complete."""
    path = os.path.join(out_dir, "manifest.json")
    tmp = f"{path}.tmp"
    with open(tmp, "w") as fh:
        json.dump(manifest, fh)
    os.replace(tmp, path)


Rel = Dict[str, Optional[str]]
Present = Dict[str, List[str]]


def _agencies(con: Any, rel: Rel, present: Present) -> None:
    if rel["agency"] is None:
        con.execute(
            """
            CREATE OR REPLACE TEMP TABLE x_agencies AS
            SELECT 0 AS agency_idx, '' AS agency_id,
                   CAST(NULL AS VARCHAR) AS name, CAST(NULL AS VARCHAR) AS timezone
            """
        )
        return
    a = present["agency"]
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_agencies AS
        SELECT CAST(row_number() OVER (ORDER BY agency_id) - 1 AS INTEGER)
                   AS agency_idx, *
        FROM (
            -- A feed with one agency may leave agency_id out; '' stands for it.
            SELECT coalesce({_col(a, "agency_id", "VARCHAR")}, '') AS agency_id,
                   {_col(a, "agency_name", "VARCHAR")} AS name,
                   {_col(a, "agency_timezone", "VARCHAR")} AS timezone
            FROM {rel["agency"]}
            QUALIFY row_number() OVER (PARTITION BY agency_id) = 1
        )
        """
    )


def _stops(con: Any, rel: Rel, present: Present) -> None:
    s = present["stops"]
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_stops AS
        WITH src AS (
            SELECT "stop_id" AS stop_id,
                   {_col(s, "stop_name", "VARCHAR")} AS name,
                   {_col(s, "stop_lat", "DOUBLE")} AS lat,
                   {_col(s, "stop_lon", "DOUBLE")} AS lon,
                   CAST(coalesce({_col(s, "location_type", "INTEGER")}, 0) AS UTINYINT)
                       AS location_type,
                   NULLIF({_col(s, "parent_station", "VARCHAR")}, '') AS parent_station,
                   {_col(s, "platform_code", "VARCHAR")} AS platform_code,
                   {_col(s, "wheelchair_boarding", "UTINYINT")} AS wheelchair
            FROM {rel["stops"]}
            WHERE "stop_id" IS NOT NULL
            QUALIFY row_number() OVER (PARTITION BY "stop_id") = 1
        ),
        indexed AS (
            SELECT CAST(row_number() OVER (ORDER BY stop_id) - 1 AS INTEGER)
                       AS stop_idx, *
            FROM src
        )
        SELECT i.stop_idx, i.stop_id, i.name, i.lat, i.lon, i.location_type,
               p.stop_idx AS parent_idx, i.platform_code, i.wheelchair
        FROM indexed i LEFT JOIN indexed p ON p.stop_id = i.parent_station
        """
    )


def _routes(con: Any, rel: Rel, present: Present) -> None:
    r = present["routes"]
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_routes0 AS
        WITH src AS (
            SELECT "route_id" AS route_id,
                   coalesce({_col(r, "agency_id", "VARCHAR")}, '') AS agency_id,
                   {_col(r, "route_short_name", "VARCHAR")} AS short_name,
                   {_col(r, "route_long_name", "VARCHAR")} AS long_name,
                   {_col(r, "route_type", "SMALLINT")} AS route_type,
                   {_col(r, "route_color", "VARCHAR")} AS color,
                   {_col(r, "route_text_color", "VARCHAR")} AS text_color,
                   {_col(r, "route_sort_order", "INTEGER")} AS sort_order
            FROM {rel["routes"]}
            WHERE "route_id" IS NOT NULL
            QUALIFY row_number() OVER (PARTITION BY "route_id") = 1
        ),
        joined AS (
            -- A route naming no agency (or one the feed lacks) belongs to the
            -- feed's first, which is its only one when agency_id is optional.
            SELECT s.*, coalesce(a.agency_idx, 0) AS agency_idx
            FROM src s LEFT JOIN x_agencies a ON a.agency_id = s.agency_id
        )
        SELECT CAST(row_number() OVER (
                   ORDER BY agency_idx, sort_order NULLS LAST,
                            short_name NULLS LAST, long_name NULLS LAST, route_id
               ) - 1 AS INTEGER) AS route_idx,
               route_id, CAST(agency_idx AS INTEGER) AS agency_idx, short_name,
               long_name, route_type, color, text_color, sort_order
        FROM joined
        """
    )


def _services(con: Any, rel: Rel, present: Present) -> None:
    """``x_services`` (one row per service id, weekday bitmask Mon=1…Sun=64)
    and ``x_calendar_dates``. A service only calendar_dates names has no
    bitmask and takes its range from its dates."""
    parts = []
    if rel["calendar"] is not None:
        c = present["calendar"]
        days = " + ".join(
            f"coalesce({_col(c, day, 'INTEGER')}, 0) * {1 << i}"
            for i, day in enumerate(_WEEKDAYS)
        )
        parts.append(
            f"""SELECT "service_id" AS service_id, CAST({days} AS UTINYINT) AS days,
                       {_col(c, "start_date", "DATE")} AS start_date,
                       {_col(c, "end_date", "DATE")} AS end_date
                FROM {rel["calendar"]}"""
        )
    if rel["calendar_dates"] is not None:
        parts.append(
            f"""SELECT "service_id" AS service_id, CAST(NULL AS UTINYINT) AS days,
                       min("date") AS start_date, max("date") AS end_date
                FROM {rel["calendar_dates"]} GROUP BY "service_id" """
        )
    if not parts:
        raise ValueError("The bundle has neither a calendar nor calendar_dates layer")
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_services AS
        SELECT CAST(row_number() OVER (ORDER BY service_id) - 1 AS INTEGER)
                   AS service_idx, *
        FROM (
            -- calendar.txt's bitmask where it has the service, and the widest
            -- range either file gives it.
            SELECT service_id, max(days) AS days, min(start_date) AS start_date,
                   max(end_date) AS end_date
            FROM ({" UNION ALL ".join(parts)})
            WHERE service_id IS NOT NULL
            GROUP BY service_id
        )
        """
    )
    if rel["calendar_dates"] is None:
        con.execute(
            """
            CREATE OR REPLACE TEMP TABLE x_calendar_dates AS
            SELECT CAST(NULL AS INTEGER) AS service_idx, CAST(NULL AS DATE) AS date,
                   CAST(NULL AS UTINYINT) AS exception_type
            WHERE false
            """
        )
        return
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_calendar_dates AS
        SELECT s.service_idx, cd."date" AS date,
               CAST(cd."exception_type" AS UTINYINT) AS exception_type
        FROM {rel["calendar_dates"]} cd
        JOIN x_services s ON s.service_id = cd."service_id"
        WHERE cd."date" IS NOT NULL AND cd."exception_type" IN (1, 2)
        """
    )


def _stop_times(con: Any, rel: Rel, present: Present, warnings: Dict[str, int]) -> None:
    """``x_st0``: the stop times whose stop exists, with its position."""
    st = present["stop_times"]
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_st0 AS
        SELECT st."trip_id" AS trip_id,
               CAST(st."stop_sequence" AS INTEGER) AS stop_sequence,
               s.stop_idx,
               {_seconds(st, "arrival_time", "st")} AS arrival_s,
               {_seconds(st, "departure_time", "st")} AS departure_s,
               {_col(st, "shape_dist_traveled", "DOUBLE", alias="st")} AS shape_dist,
               s.lat, s.lon
        FROM {rel["stop_times"]} st
        JOIN x_stops s ON s.stop_id = st."stop_id"
        WHERE st."stop_sequence" IS NOT NULL
        """
    )
    total = con.execute(f"SELECT count(*) FROM {rel['stop_times']}").fetchone()[0]
    kept = con.execute("SELECT count(*) FROM x_st0").fetchone()[0]
    if total - kept:
        warnings["stop_times_without_stop"] = int(total - kept)


def _trips0(con: Any, rel: Rel, present: Present, warnings: Dict[str, int]) -> None:
    """``x_trips0``: the trips whose route and service exist."""
    t = present["trips"]
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_trips0 AS
        SELECT t."trip_id" AS trip_id, r.route_idx, sv.service_idx,
               NULLIF({_col(t, "shape_id", "VARCHAR", alias="t")}, '') AS shape_id,
               NULLIF({_col(t, "block_id", "VARCHAR", alias="t")}, '') AS block_id,
               {_col(t, "direction_id", "UTINYINT", alias="t")} AS direction_id,
               {_col(t, "trip_headsign", "VARCHAR", alias="t")} AS headsign,
               {_col(t, "trip_short_name", "VARCHAR", alias="t")} AS short_name
        FROM {rel["trips"]} t
        JOIN x_routes0 r ON r.route_id = t."route_id"
        JOIN x_services sv ON sv.service_id = t."service_id"
        WHERE t."trip_id" IS NOT NULL
        QUALIFY row_number() OVER (PARTITION BY t."trip_id") = 1
        """
    )
    total = con.execute(f"SELECT count(*) FROM {rel['trips']}").fetchone()[0]
    kept = con.execute("SELECT count(*) FROM x_trips0").fetchone()[0]
    if total - kept:
        warnings["trips_without_route_or_service"] = int(total - kept)


def _trip_stops(con: Any, warnings: Dict[str, int]) -> None:
    """``x_trip_stops``: per trip with stop times, a fingerprint of its ordered
    stops, its first departure, last arrival, stop-to-stop length and the shape
    distance it covers.

    The stops themselves are not listed per trip: an ordered ``list()`` per
    group cannot spill to disk, and a city's stop times outgrow the memory
    bound with it. A trip's pattern is its route, its stop count and two
    independent sums over (stop, position) — a collision between two
    different stop orders is out of the question in practice — and the list
    is built once per pattern instead (``_patterns_and_trips``)."""
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_trip_stops AS
        WITH seq AS (
            SELECT st.trip_id, st.stop_idx, st.arrival_s, st.departure_s,
                   st.shape_dist, st.stop_sequence, t.route_idx,
                   row_number() OVER w AS pos,
                   _hav_m(lag(st.lat) OVER w, lag(st.lon) OVER w, st.lat, st.lon)
                       AS hop_m
            FROM x_st0 st JOIN x_trips0 t USING (trip_id)
            WINDOW w AS (PARTITION BY st.trip_id ORDER BY st.stop_sequence)
        )
        SELECT trip_id, any_value(route_idx) AS route_idx,
               CAST(count(*) AS INTEGER) AS n_stops,
               sum(CAST(hash(stop_idx, pos) AS HUGEINT)) AS h1,
               sum(CAST(hash(pos, stop_idx, 'pattern') AS HUGEINT)) AS h2,
               -- The times at the trip's first and last stop, or none: a trip
               -- whose end has no time (a GTFS-Flex window, say) has no
               -- schedule to run, and arg_min/arg_max would skip to the
               -- nearest stop that has one.
               arg_min_null(coalesce(departure_s, arrival_s), stop_sequence)
                   AS first_dep_s,
               arg_max_null(coalesce(arrival_s, departure_s), stop_sequence)
                   AS last_arr_s,
               coalesce(sum(hop_m), 0) AS chain_m,
               max(shape_dist) - min(shape_dist) AS dist_delta
        FROM seq GROUP BY trip_id
        """
    )
    missing = con.execute(
        "SELECT count(*) FROM x_trips0 ANTI JOIN x_trip_stops USING (trip_id)"
    ).fetchone()[0]
    if missing:
        warnings["trips_without_stop_times"] = int(missing)


def _distance_scale(con: Any) -> Tuple[Optional[float], Optional[str]]:
    """Metres per ``shape_dist_traveled`` unit, from the trips that give one.

    The straight line between stops is a little shorter than the path, so the
    ratio is snapped to the nearest plausible unit rather than used as is."""
    row = con.execute(
        """
        SELECT median(chain_m / dist_delta) FROM x_trip_stops
        WHERE dist_delta > 0 AND chain_m > 0
        """
    ).fetchone()
    ratio = row[0] if row else None
    if not ratio or ratio <= 0:
        return None, None
    unit = min(_DIST_UNITS, key=lambda u: abs(math.log(ratio / _DIST_UNITS[u])))
    return _DIST_UNITS[unit], unit


def _shapes(con: Any, rel: Rel, present: Present) -> None:
    """``x_shapes_meta``: every shape id trips name, indexed, with the length
    of its points where the bundle has them."""
    lengths = (
        "SELECT CAST(NULL AS VARCHAR) AS shape_id, CAST(NULL AS DOUBLE) AS length_m "
        "WHERE false"
    )
    if rel["shapes"] is not None and {
        "shape_pt_lat",
        "shape_pt_lon",
        "shape_pt_sequence",
    } <= set(present["shapes"]):
        lengths = f"""
            SELECT shape_id, sum(hop) AS length_m FROM (
                SELECT "shape_id" AS shape_id,
                       _hav_m(lag("shape_pt_lat") OVER w, lag("shape_pt_lon") OVER w,
                              "shape_pt_lat", "shape_pt_lon") AS hop
                FROM {rel["shapes"]}
                WHERE "shape_pt_lat" IS NOT NULL AND "shape_pt_lon" IS NOT NULL
                WINDOW w AS (PARTITION BY "shape_id" ORDER BY "shape_pt_sequence")
            ) GROUP BY shape_id
        """
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_shapes_meta AS
        WITH ids AS (
            SELECT DISTINCT shape_id FROM x_trips0 WHERE shape_id IS NOT NULL
        )
        SELECT CAST(row_number() OVER (ORDER BY i.shape_id) - 1 AS INTEGER)
                   AS shape_idx,
               i.shape_id, CAST(l.length_m AS REAL) AS length_m
        FROM ids i LEFT JOIN ({lengths}) l USING (shape_id)
        """
    )


def _patterns_and_trips(con: Any, scale: Optional[float]) -> None:
    """``x_patterns0`` (one per route and ordered stop list) and ``x_trips``,
    indexed in the order that keeps a route's trips together."""
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_patterns0 AS
        WITH grouped AS (
            SELECT route_idx, n_stops, h1, h2, CAST(count(*) AS INTEGER) AS n_trips,
                   min(trip_id) AS sample_trip
            FROM x_trip_stops GROUP BY route_idx, n_stops, h1, h2
        ),
        -- The stop list of one trip per pattern: few enough to list in memory.
        listed AS (
            SELECT g.*, list(st.stop_idx ORDER BY st.stop_sequence) AS stops
            FROM grouped g JOIN x_st0 st ON st.trip_id = g.sample_trip
            GROUP BY ALL
        )
        SELECT CAST(row_number() OVER (
                   ORDER BY route_idx, n_trips DESC, sample_trip
               ) - 1 AS INTEGER) AS pattern_idx, *
        FROM listed
        """
    )
    dist_m = f"ts.dist_delta * {scale}" if scale else "CAST(NULL AS DOUBLE)"
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_trips AS
        WITH j AS (
            SELECT t.*, ts.first_dep_s, ts.last_arr_s, p.pattern_idx, sh.shape_idx,
                   sh.length_m AS shape_m, ts.chain_m, {dist_m} AS dist_m
            FROM x_trips0 t
            JOIN x_trip_stops ts USING (trip_id)
            JOIN x_patterns0 p ON p.route_idx = ts.route_idx AND p.n_stops = ts.n_stops
                 AND p.h1 = ts.h1 AND p.h2 = ts.h2
            LEFT JOIN x_shapes_meta sh ON sh.shape_id = t.shape_id
        ),
        sourced AS (
            -- Length: the feed's own distance along the shape where it gives
            -- one, else the shape's length when it is plausible for the trip
            -- (a short turn drawn on the full route's shape is not), else the
            -- straight line from stop to stop.
            SELECT *, CASE
                WHEN dist_m > 0 THEN 1
                WHEN shape_m BETWEEN chain_m AND 2 * chain_m THEN 2
                ELSE 3 END AS length_src
            FROM j
        )
        SELECT CAST(row_number() OVER (
                   ORDER BY route_idx, direction_id NULLS LAST, pattern_idx,
                            first_dep_s NULLS LAST, trip_id
               ) - 1 AS INTEGER) AS trip_idx,
               trip_id, route_idx, service_idx, shape_idx,
               CASE WHEN block_id IS NOT NULL THEN
                   CAST(dense_rank() OVER (ORDER BY block_id NULLS LAST) - 1 AS INTEGER)
               END AS block_idx,
               direction_id, headsign, short_name, pattern_idx, first_dep_s,
               last_arr_s,
               CAST(CASE length_src WHEN 1 THEN dist_m WHEN 2 THEN shape_m
                    ELSE chain_m END AS REAL) AS length_m,
               CAST(length_src AS UTINYINT) AS length_src
        FROM sourced
        """
    )


def _geometry_column(con: Any, relation: str) -> Optional[str]:
    """The relation's geometry column, if it has one."""
    for name, kind, *_ in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall():
        if str(kind).upper().startswith("GEOMETRY"):
            return str(name)
    return None


def _shape_lines(con: Any, rel: Rel, present: Present) -> Optional[str]:
    """``x_shape_lines`` (each shape trips use, simplified, in a local planar
    frame) and ``x_shape_points`` (its vertices, with the distance along it);
    returns the role the map can draw the shapes as lines from.

    Bundles keep shapes as lines (a ``shape_lines`` member, or an older
    import's ``shapes`` of one line per shape) or as GTFS points (``shapes``
    with ``shape_pt_*``); whichever there is is read, a thousand shapes at a
    time so the build stays within its memory. A shape is drawn in a frame of
    its own — longitude scaled by the cosine of its mean latitude, both in
    degrees of latitude — so simplification, distances and where a stop
    falls on the line all use one measure.
    """
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_shape_lines (
            shape_idx INTEGER, k DOUBLE, g GEOMETRY)
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_shape_points (
            shape_idx INTEGER, i INTEGER, lon FLOAT, lat FLOAT, d FLOAT)
        """
    )
    # Where the vertices come from: (relation, how to read them, role drawn).
    source: Optional[Tuple[str, str, Optional[str]]] = None
    for role in ("shape_lines", "shapes"):
        r = rel.get(role)
        if r is None or "shape_id" not in present.get(role, []):
            continue
        geom = _geometry_column(con, r)
        if geom and not {"shape_pt_lat", "shape_pt_lon"} <= set(present[role]):
            source = (r, f'"{geom}"', role)
            break
    if (
        source is None
        and rel["shapes"] is not None
        and {
            "shape_id",
            "shape_pt_lat",
            "shape_pt_lon",
            "shape_pt_sequence",
        }
        <= set(present["shapes"])
    ):
        source = (rel["shapes"], "", None)
    if source is None:
        return None
    relation, geom, lines_role = source
    con.execute("LOAD spatial")
    n = con.execute("SELECT count(*) FROM x_shapes_meta").fetchone()[0]
    tol = SHAPE_TOLERANCE_M / _M_PER_DEG
    for lo in range(0, n, _SHAPE_BATCH):
        hi = lo + _SHAPE_BATCH
        batch = f"m.shape_idx >= {lo} AND m.shape_idx < {hi}"
        if geom:
            # A line's vertices, in order (a multi-line merged into one
            # first); one line per shape, should a shape appear twice.
            pts = f"""
                SELECT shape_idx, struct_extract(d, 'path')[1] AS seq,
                       ST_X(struct_extract(d, 'geom')) AS lon,
                       ST_Y(struct_extract(d, 'geom')) AS lat
                FROM (
                    SELECT shape_idx, UNNEST(ST_Dump(ST_Points(ST_LineMerge(g)))) AS d
                    FROM (
                        SELECT m.shape_idx, any_value(s.{geom}) AS g
                        FROM {relation} s JOIN x_shapes_meta m ON m.shape_id = s."shape_id"
                        WHERE {batch} AND s.{geom} IS NOT NULL
                        GROUP BY m.shape_idx
                    )
                )
            """
        else:
            pts = f"""
                SELECT m.shape_idx, CAST(s."shape_pt_sequence" AS INTEGER) AS seq,
                       CAST(s."shape_pt_lon" AS DOUBLE) AS lon,
                       CAST(s."shape_pt_lat" AS DOUBLE) AS lat
                FROM {relation} s JOIN x_shapes_meta m ON m.shape_id = s."shape_id"
                WHERE {batch}
                  AND s."shape_pt_lat" IS NOT NULL AND s."shape_pt_lon" IS NOT NULL
            """
        con.execute(
            f"""
            INSERT INTO x_shape_lines
            WITH pts AS ({pts}),
            frame AS (SELECT shape_idx, cos(radians(avg(lat))) AS k FROM pts GROUP BY shape_idx)
            SELECT p.shape_idx, f.k,
                   ST_Simplify(ST_MakeLine(list(ST_Point(p.lon * f.k, p.lat)
                                                ORDER BY p.seq)), {tol})
            FROM pts p JOIN frame f USING (shape_idx)
            GROUP BY p.shape_idx, f.k
            HAVING count(*) >= 2
            """
        )
    con.execute(
        f"""
        INSERT INTO x_shape_points
        WITH v AS (
            SELECT shape_idx, k, UNNEST(ST_Dump(ST_Points(g)), recursive := true)
            FROM x_shape_lines
        ),
        xy AS (
            SELECT shape_idx, k, ST_X(geom) AS x, ST_Y(geom) AS y, path[1] - 1 AS i FROM v
        )
        SELECT shape_idx, CAST(i AS INTEGER), CAST(x / k AS FLOAT), CAST(y AS FLOAT),
               CAST({_M_PER_DEG} * coalesce(sum(hop) OVER (
                   PARTITION BY shape_idx ORDER BY i
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS FLOAT)
        FROM (
            SELECT *, sqrt(pow(x - lag(x) OVER w, 2) + pow(y - lag(y) OVER w, 2)) AS hop
            FROM xy WINDOW w AS (PARTITION BY shape_idx ORDER BY i)
        )
        """
    )
    # A shape's length where its points gave none: the line's.
    con.execute(
        """
        UPDATE x_shapes_meta m SET length_m = l.length_m
        FROM (SELECT shape_idx, CAST(max(d) AS REAL) AS length_m
              FROM x_shape_points GROUP BY shape_idx) l
        WHERE l.shape_idx = m.shape_idx AND m.length_m IS NULL
        """
    )
    return lines_role


def _stop_chain_shapes(con: Any) -> None:
    """A line through the stops as the shape of each trip without one: its
    ``shape_id`` empty, or naming no line (``x_shape_lines``).

    The rule is ``stop_chains``': the same id the importer gives the line in
    the bundle's ``shape_lines`` member (so the map's tiles draw it), the same
    stops and positions. Built here from the stops all the same, so a bundle
    imported without those lines still plays and measures. Listed per pattern,
    not per trip: a trip's pattern is its ordered stops (``_trip_stops``).

    Its points are the stops themselves, and the distance along it is the
    stop-to-stop distance, so each stop's place on it (``x_pattern_shape_stops``)
    is exact rather than projected. A trip's length is left as it was: from the
    stop-to-stop distance already (``length_src`` 3)."""
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_pattern_shape_stops (
            pattern_idx INTEGER, shape_idx INTEGER, i INTEGER, d FLOAT)
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE x_chain_patterns AS
        WITH shapeless AS (
            SELECT DISTINCT pattern_idx FROM x_trips
            WHERE shape_idx IS NULL
               OR shape_idx NOT IN (SELECT shape_idx FROM x_shape_lines)
        ),
        calls AS (
            SELECT p.pattern_idx, UNNEST(p.stops) AS stop_idx,
                   UNNEST(range(len(p.stops))) AS i
            FROM x_patterns0 p JOIN shapeless USING (pattern_idx)
        )
        SELECT c.pattern_idx,
               '{STOP_CHAIN_PREFIX}' || md5(string_agg(s.stop_id, chr(31) ORDER BY c.i))
                   AS shape_id
        FROM calls c JOIN x_stops s USING (stop_idx)
        GROUP BY c.pattern_idx
        """
    )
    # One shape per distinct stop list, indexed after the feed's own.
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE x_chain_shapes AS
        SELECT CAST((SELECT coalesce(max(shape_idx) + 1, 0) FROM x_shapes_meta)
                    + row_number() OVER (ORDER BY shape_id) - 1 AS INTEGER) AS shape_idx,
               shape_id, min(pattern_idx) AS pattern_idx
        FROM x_chain_patterns GROUP BY shape_id
        """
    )
    # Each pattern's stops with a position (its station's where it has none),
    # and how far along the line each lies.
    placed = """
        WITH calls AS (
            SELECT {key}, UNNEST(p.stops) AS stop_idx, UNNEST(range(len(p.stops))) AS i
            FROM {pairs} JOIN x_patterns0 p USING (pattern_idx)
        ),
        pos AS (
            SELECT c.*, coalesce(s.lon, ps.lon) AS lon, coalesce(s.lat, ps.lat) AS lat
            FROM calls c JOIN x_stops s USING (stop_idx)
            LEFT JOIN x_stops ps ON ps.stop_idx = s.parent_idx
            WHERE coalesce(s.lon, ps.lon) IS NOT NULL
              AND coalesce(s.lat, ps.lat) IS NOT NULL
        )
        SELECT *, coalesce(sum(hop) OVER (PARTITION BY {part} ORDER BY i
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS d,
               row_number() OVER (PARTITION BY {part} ORDER BY i) - 1 AS j,
               count(*) OVER (PARTITION BY {part}) AS n
        FROM (SELECT *, _hav_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS hop
              FROM pos WINDOW w AS (PARTITION BY {part} ORDER BY i))
    """
    con.execute(
        f"""
        INSERT INTO x_shape_points
        SELECT shape_idx, CAST(j AS INTEGER), CAST(lon AS FLOAT), CAST(lat AS FLOAT),
               CAST(d AS FLOAT)
        FROM ({placed.format(key="cs.shape_idx", pairs="x_chain_shapes cs", part="shape_idx")})
        WHERE n >= 2
        """
    )
    con.execute(
        """
        INSERT INTO x_shapes_meta
        SELECT cs.shape_idx, cs.shape_id, CAST(max(pt.d) AS REAL)
        FROM x_chain_shapes cs JOIN x_shape_points pt USING (shape_idx)
        GROUP BY ALL
        """
    )
    # The trips take it, where it could be drawn (two stops with a position).
    con.execute(
        """
        UPDATE x_trips t SET shape_idx = m.shape_idx
        FROM x_chain_patterns cp JOIN x_shapes_meta m USING (shape_id)
        WHERE cp.pattern_idx = t.pattern_idx
          AND (t.shape_idx IS NULL
               OR t.shape_idx NOT IN (SELECT shape_idx FROM x_shape_lines))
        """
    )
    con.execute(
        f"""
        INSERT INTO x_pattern_shape_stops
        SELECT pattern_idx, shape_idx, CAST(i AS INTEGER), CAST(d AS FLOAT)
        FROM ({placed.format(
            key="cp.pattern_idx, m.shape_idx",
            pairs="x_chain_patterns cp JOIN x_shapes_meta m USING (shape_id)",
            part="pattern_idx",
        )})
        WHERE n >= 2
        """
    )


def _pattern_shape_stops(con: Any) -> None:
    """``x_pattern_shape_stops``: how far along its shape each stop of a
    pattern lies, for every pattern and shape trips use together.

    A stop is placed where it projects onto the line, never before the stop
    ahead of it: a loop or a stop beside the line must not send a vehicle
    backwards; a loop's last stop, which projects to where it began, is the
    line's end."""
    n = con.execute("SELECT count(*) FROM x_shapes_meta").fetchone()[0]
    for lo in range(0, n, _SHAPE_BATCH):
        hi = lo + _SHAPE_BATCH
        con.execute(
            f"""
            INSERT INTO x_pattern_shape_stops
            WITH pairs AS (
                SELECT DISTINCT pattern_idx, shape_idx FROM x_trips
                WHERE shape_idx >= {lo} AND shape_idx < {hi}
            ),
            calls AS (
                SELECT pr.pattern_idx, pr.shape_idx,
                       UNNEST(p.stops) AS stop_idx,
                       UNNEST(range(len(p.stops))) AS i
                FROM pairs pr JOIN x_patterns0 p USING (pattern_idx)
            ),
            placed AS (
                -- A stop without a position takes its station's.
                SELECT c.pattern_idx, c.shape_idx, c.i,
                       ST_LineLocatePoint(l.g, ST_Point(coalesce(s.lon, ps.lon) * l.k,
                                                        coalesce(s.lat, ps.lat)))
                         * ST_Length(l.g) * {_M_PER_DEG} AS d,
                       ST_Length(l.g) * {_M_PER_DEG} AS length_m
                FROM calls c JOIN x_shape_lines l USING (shape_idx)
                JOIN x_stops s ON s.stop_idx = c.stop_idx
                LEFT JOIN x_stops ps ON ps.stop_idx = s.parent_idx
                WHERE coalesce(s.lon, ps.lon) IS NOT NULL
            )
            SELECT pattern_idx, shape_idx, CAST(i AS INTEGER),
                   CAST(CASE
                       WHEN i = max(i) OVER pat AND d < max(d) OVER prior
                            AND d < 0.05 * length_m THEN length_m
                       ELSE greatest(d, coalesce(max(d) OVER prior, 0))
                   END AS FLOAT)
            FROM placed
            WINDOW pat AS (PARTITION BY pattern_idx, shape_idx),
                   prior AS (PARTITION BY pattern_idx, shape_idx ORDER BY i
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
            """
        )


_QUERIES: Dict[str, str] = {
    "agencies": "SELECT * FROM x_agencies ORDER BY agency_idx",
    "routes": """
        SELECT r.*, CAST(min(t.trip_idx) AS INTEGER) AS trip_lo,
               CAST(max(t.trip_idx) AS INTEGER) AS trip_hi
        FROM x_routes0 r LEFT JOIN x_trips t USING (route_idx)
        GROUP BY ALL ORDER BY r.route_idx
    """,
    "services": "SELECT * FROM x_services ORDER BY service_idx",
    "calendar_dates": "SELECT * FROM x_calendar_dates ORDER BY service_idx, date",
    "stops": "SELECT * FROM x_stops ORDER BY stop_idx",
    "patterns": """
        SELECT p.pattern_idx, p.route_idx, p.stops, p.n_stops, p.n_trips,
               CAST(median(t.length_m) AS REAL) AS length_m
        FROM x_patterns0 p JOIN x_trips t USING (pattern_idx)
        GROUP BY ALL ORDER BY p.pattern_idx
    """,
    "trips": "SELECT * FROM x_trips ORDER BY trip_idx",
    "shapes_meta": (
        "SELECT shape_idx, shape_id, length_m FROM x_shapes_meta ORDER BY shape_idx"
    ),
    "shape_points": "SELECT * FROM x_shape_points ORDER BY shape_idx, i",
    "pattern_shape_stops": (
        "SELECT * FROM x_pattern_shape_stops ORDER BY pattern_idx, shape_idx, i"
    ),
    "shape_route": """
        SELECT DISTINCT shape_idx, route_idx FROM x_trips
        WHERE shape_idx IS NOT NULL ORDER BY shape_idx, route_idx
    """,
    "stop_times": """
        SELECT t.trip_idx, st.stop_sequence, st.stop_idx, st.arrival_s,
               st.departure_s, CAST(st.shape_dist AS REAL) AS shape_dist
        FROM x_st0 st JOIN x_trips t USING (trip_id)
        ORDER BY t.trip_idx, st.stop_sequence
    """,
}


def _frequencies_query(rel: Rel, present: Present) -> str:
    if rel["frequencies"] is None:
        return """
            SELECT CAST(NULL AS INTEGER) AS trip_idx, CAST(NULL AS INTEGER) AS start_s,
                   CAST(NULL AS INTEGER) AS end_s, CAST(NULL AS INTEGER) AS headway_s,
                   CAST(NULL AS UTINYINT) AS exact_times WHERE false
        """
    f = present["frequencies"]
    return f"""
        SELECT t.trip_idx, {_seconds(f, "start_time", "f")} AS start_s,
               {_seconds(f, "end_time", "f")} AS end_s,
               CAST(f."headway_secs" AS INTEGER) AS headway_s,
               CAST(coalesce({_col(f, "exact_times", "INTEGER", alias="f")}, 0)
                    AS UTINYINT) AS exact_times
        FROM {rel["frequencies"]} f JOIN x_trips t ON t.trip_id = f."trip_id"
        WHERE f."headway_secs" > 0
        ORDER BY t.trip_idx, start_s
    """


def _extras_query(rel: Rel, present: Present) -> str:
    """Per-stop-time fields that are rarely set, only where they are set."""
    st = present["stop_times"]
    fields = {
        "stop_headsign": ("VARCHAR", "NULLIF(\"stop_headsign\", '')"),
        "pickup_type": ("UTINYINT", 'NULLIF("pickup_type", 0)'),
        "drop_off_type": ("UTINYINT", 'NULLIF("drop_off_type", 0)'),
        "timepoint": ("UTINYINT", 'NULLIF("timepoint", 1)'),
    }
    select = [
        f"CAST({expr} AS {cast}) AS {name}"
        if name in st
        else f"CAST(NULL AS {cast}) AS {name}"
        for name, (cast, expr) in fields.items()
    ]
    any_set = " OR ".join(f"x.{name} IS NOT NULL" for name in fields)
    return f"""
        SELECT t.trip_idx, x.stop_sequence, {", ".join(f"x.{n}" for n in fields)}
        FROM (
            SELECT "trip_id" AS trip_id,
                   CAST("stop_sequence" AS INTEGER) AS stop_sequence,
                   {", ".join(select)}
            FROM {rel["stop_times"]}
        ) x JOIN x_trips t USING (trip_id)
        WHERE {any_set}
        ORDER BY t.trip_idx, x.stop_sequence
    """


_OPTIONAL: Dict[str, Callable[[Rel, Present], str]] = {
    "frequencies": _frequencies_query,
    "stop_time_extras": _extras_query,
}
