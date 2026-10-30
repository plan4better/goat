"""Lines through the stops, for GTFS trips without a shape.

Shapes are optional in GTFS, and many feeds have none, or have them for some
trips only. A trip without a usable shape — its ``shape_id`` empty, or naming
no shape with two drawable points — is drawn as a line through its stops,
and that line takes the place of the shape it lacks: in the bundle's
``shape_lines`` member, and as the trip's shape in the Explorer's snapshot.

One rule, which the importer applies here and the snapshot in SQL
(``goatlib.bundles.explorer.snapshot``), so both name the same line:

- **The stops:** the trip's stop times whose stop exists and whose
  ``stop_sequence`` is set, in ``stop_sequence`` order.
- **The id:** ``STOP_CHAIN_PREFIX`` + the MD5 of their stop ids joined by
  U+001F. Trips calling at the same stops in the same order share one line.
- **The line:** each stop's position, or its parent station's where it has
  none; stops with neither are left out, and fewer than two points make no
  line.
"""

import hashlib
import os
import struct
from typing import Dict, List, Optional, Set, Tuple

from goatlib.bundles.importers.base import bound_duckdb

STOP_CHAIN_PREFIX = "stops-"
#: Joins the stop ids hashed into a line's id: a character no id holds.
STOP_ID_SEPARATOR = "\x1f"


def stop_chain_id(stop_ids: List[str]) -> str:
    """The id of the line through ``stop_ids``, in order."""
    digest = hashlib.md5(STOP_ID_SEPARATOR.join(stop_ids).encode("utf-8")).hexdigest()
    return STOP_CHAIN_PREFIX + digest


def _sql_path(path: str) -> str:
    return path.replace("'", "''")


def stop_chain_lines_parquet(
    trips_path: str,
    stop_times_path: str,
    stops_path: str,
    drawn_shape_ids: Set[str],
    out_path: str,
) -> int:
    """Write ``(shape_id, wkb)`` rows, one per distinct stop sequence of the
    trips without a drawn shape, to ``out_path``; returns how many lines.

    Reads the typed trips, stop times and stops tables. DuckDB sorts the stop
    times of those trips, spilling to disk under the import's memory bound;
    the stop sequences are then read one trip at a time as the sorted rows
    stream past, so memory holds the distinct sequences, not the stop times.
    """
    import duckdb
    import pyarrow as pa
    import pyarrow.parquet as pq

    schema = pa.schema([("shape_id", pa.string()), ("wkb", pa.binary())])
    con = bound_duckdb(duckdb.connect(), os.path.dirname(os.path.abspath(out_path)))
    try:
        con.register(
            "drawn",
            pa.table({"shape_id": pa.array(sorted(drawn_shape_ids), pa.string())}),
        )
        trips, stop_times, stops = (
            _sql_path(trips_path),
            _sql_path(stop_times_path),
            _sql_path(stops_path),
        )

        def columns(path: str) -> Set[str]:
            return {
                str(row[0])
                for row in con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{path}')"
                ).fetchall()
            }

        stop_columns, trip_columns = columns(stops), columns(trips)
        # Each stop's position, or its station's. Optional columns: a feed
        # may leave out the station, or (for some stops) the position.
        position: Dict[str, Tuple[float, float]] = {}
        if {"stop_lon", "stop_lat"} <= stop_columns:
            own = "s.stop_lon, s.stop_lat"
            station = ""
            if "parent_station" in stop_columns:
                own = (
                    "coalesce(s.stop_lon, p.stop_lon), coalesce(s.stop_lat, p.stop_lat)"
                )
                station = f"LEFT JOIN read_parquet('{stops}') p ON p.stop_id = s.parent_station"
            for stop_id, lon, lat in con.execute(
                f"SELECT s.stop_id, {own} FROM read_parquet('{stops}') s {station} "
                "WHERE s.stop_id IS NOT NULL"
            ).fetchall():
                if lon is not None and lat is not None:
                    position[stop_id] = (lon, lat)
        shape_id = (
            "NULLIF(shape_id, '')"
            if "shape_id" in trip_columns
            else "CAST(NULL AS VARCHAR)"
        )
        cursor = con.execute(
            f"""
            WITH t AS (
                SELECT trip_id, {shape_id} AS shape_id
                FROM read_parquet('{trips}')
                WHERE trip_id IS NOT NULL
                QUALIFY row_number() OVER (PARTITION BY trip_id) = 1
            ),
            shapeless AS (
                SELECT trip_id FROM t
                WHERE shape_id IS NULL OR shape_id NOT IN (SELECT shape_id FROM drawn)
            )
            SELECT st.trip_id, st.stop_id
            FROM read_parquet('{stop_times}') st
            JOIN shapeless USING (trip_id)
            JOIN (SELECT DISTINCT stop_id FROM read_parquet('{stops}')) s USING (stop_id)
            WHERE st.stop_sequence IS NOT NULL
            ORDER BY st.trip_id, st.stop_sequence
            """
        )
        seen: Set[str] = set()
        written = 0
        ids: List[str] = []
        wkbs: List[bytes] = []
        with pq.ParquetWriter(out_path, schema) as writer:

            def finish(stop_ids: List[str]) -> None:
                nonlocal written
                key = stop_chain_id(stop_ids)
                if key in seen:
                    return
                seen.add(key)
                coords: List[float] = []
                for stop_id in stop_ids:
                    at = position.get(stop_id)
                    if at is not None:
                        coords += at
                n = len(coords) // 2
                if n < 2:
                    return
                # WKB LineString, little-endian: byte order, type 2, count.
                ids.append(key)
                written += 1
                wkbs.append(struct.pack(f"<BII{2 * n}d", 1, 2, n, *coords))
                if len(ids) >= 1000:
                    flush()

            def flush() -> None:
                if ids:
                    writer.write_table(
                        pa.table({"shape_id": ids, "wkb": wkbs}, schema=schema)
                    )
                    ids.clear()
                    wkbs.clear()

            current: Optional[str] = None
            stop_ids: List[str] = []
            while rows := cursor.fetchmany(10_000):
                for trip_id, stop_id in rows:
                    if trip_id != current and stop_ids:
                        finish(stop_ids)
                        stop_ids = []
                    current = trip_id
                    stop_ids.append(stop_id)
            if stop_ids:
                finish(stop_ids)
            flush()
        return written
    finally:
        con.close()
