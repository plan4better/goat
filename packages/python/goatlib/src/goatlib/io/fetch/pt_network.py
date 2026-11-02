"""GOAT's public transport network, cut to an area as a GTFS bundle's layers.

Lines are kept whole: every line serving a stop in the area keeps all its
trips, with every stop they call at, inside the area or not, so a trip still
runs from its first stop to its last. A stop counts with its station: a
platform just outside the area is in it when its station is, and the other
way round. An operator's other lines are not kept.

What the kept trips need comes with them: their services, shapes and stops,
each stop's parent station and a kept station's entrances, nodes and boarding
areas. Every other table keeps a row only where each id it names — by the
column's GTFS name — is kept, so no reference is left dangling: a transfer
between a kept and a dropped stop goes, a feed-wide row (feed_info, a fare
product) stays. The lines drawn for the map are drawn again from the cut, as
the import draws them.

The tables cut from are the GTFS importer's own output
(``goatlib.bundles.importers.pt_network.store``), and so is what this writes.
"""

import logging
import os
from typing import Any, Dict, List

from goatlib.bundles.importers.base import ExtractedLayer
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter
from goatlib.bundles.importers.pt_network.store import read_store, store_layers
from goatlib.io.fetch import street_network
from goatlib.io.fetch.area import area_table
from goatlib.io.fetch.street_network import MAX_CELLS, area_cells

logger = logging.getLogger(__name__)

TOO_LARGE = (
    "This area is too large for a public transport network (max. about 1,000 km²)."
)

#: Columns naming an id a cut can drop, by their GTFS name, and the kept set
#: they must be in. A reference column not listed here names something every
#: cut keeps whole (a level, a network, a fare product).
_REFERENCES: Dict[str, str] = {
    "agency_id": "agency",
    "route_id": "routes",
    "from_route_id": "routes",
    "to_route_id": "routes",
    "trip_id": "trips",
    "from_trip_id": "trips",
    "to_trip_id": "trips",
    "stop_id": "stops",
    "from_stop_id": "stops",
    "to_stop_id": "stops",
    "parent_station": "stops",
    "service_id": "services",
    "shape_id": "shapes",
    # fare_rules name fare zones, which stops carry.
    "origin_id": "zones",
    "destination_id": "zones",
    "contains_id": "zones",
    "fare_id": "fares",
}

#: A table whose own key is a kept set it fills itself (see _cut_table).
_OWN_KEY: Dict[str, str] = {"fare_attributes": "fare_id"}

#: translations name a row by ``table_name`` and ``record_id``.
_TRANSLATED: Dict[str, str] = {
    "agency": "agency",
    "stops": "stops",
    "routes": "routes",
    "trips": "trips",
    "stop_times": "trips",
}

#: Kept stations' own parts, kept with them though no trip calls at them.
_STATION_PARTS = (2, 3, 4)


def size(con: Any, area: dict) -> dict:
    """The area's size as the fetch form asks it, in the mirror-values shape.

    The street network's answer: a cut is limited to the same areas, and the
    network itself is on the workers' disks, not readable from here.
    """
    return street_network.size(con, area)


def _q(value: str) -> str:
    return value.replace("'", "''")


def _columns(con: Any, relation: str) -> List[str]:
    return [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()]


def _kept(column: str, keep: str) -> str:
    """A row's reference is empty or kept."""
    return (
        f"(coalesce(CAST(\"{column}\" AS VARCHAR), '') = '' "
        f'OR CAST("{column}" AS VARCHAR) IN (SELECT id FROM keep_{keep}))'
    )


def _select_lines(con: Any, src: Dict[str, str]) -> int:
    """keep_routes: the lines serving a stop in the area or its station."""
    stops = src["stops"]
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE area_stations AS
        SELECT DISTINCT coalesce(nullif(s.parent_station, ''), s.stop_id) AS id
        FROM {stops} s, fetch_area a
        WHERE s.geometry IS NOT NULL AND ST_Intersects(s.geometry, a.geom)
    """)
    (hits,) = con.execute("SELECT count(*) FROM area_stations").fetchone()
    if not hits:
        raise ValueError("The GOAT public transport network has no stops in this area.")
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE keep_routes AS
        SELECT DISTINCT t.route_id AS id
        FROM {src["stop_times"]} st
        JOIN {src["trips"]} t USING (trip_id)
        WHERE st.stop_id IN (
            SELECT stop_id FROM {stops}
            WHERE stop_id IN (SELECT id FROM area_stations)
               OR parent_station IN (SELECT id FROM area_stations))
    """)
    (lines,) = con.execute("SELECT count(*) FROM keep_routes").fetchone()
    if not lines:
        raise ValueError(
            "The GOAT public transport network has no service in this area."
        )
    return int(lines)


def _close(con: Any, src: Dict[str, str]) -> None:
    """The kept sets the kept lines need: trips, services, shapes, stops,
    agencies, fare zones."""
    trips = src["trips"]
    trip_cols = _columns(con, trips)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE keep_trips AS
        SELECT trip_id AS id, service_id,
               {"shape_id" if "shape_id" in trip_cols else "CAST(NULL AS VARCHAR)"} AS shape_id
        FROM {trips} WHERE route_id IN (SELECT id FROM keep_routes)
    """)
    con.execute(
        "CREATE OR REPLACE TEMP TABLE keep_services AS "
        "SELECT DISTINCT service_id AS id FROM keep_trips"
    )
    con.execute(
        "CREATE OR REPLACE TEMP TABLE keep_shapes AS "
        "SELECT DISTINCT shape_id AS id FROM keep_trips WHERE shape_id IS NOT NULL"
    )

    # The stops the trips call at, then up to their stations (a boarding area's
    # platform's station is two up), then down to the stations' own parts.
    stops = src["stops"]
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE keep_stops AS
        SELECT DISTINCT stop_id AS id FROM {src["stop_times"]}
        WHERE trip_id IN (SELECT id FROM keep_trips)
    """)
    for _ in range(2):
        con.execute(f"""
            INSERT INTO keep_stops
            SELECT DISTINCT parent_station FROM {stops}
            WHERE stop_id IN (SELECT id FROM keep_stops)
              AND coalesce(parent_station, '') <> ''
              AND parent_station NOT IN (SELECT id FROM keep_stops)
        """)
    stop_cols = _columns(con, stops)
    if "location_type" in stop_cols:
        parts = ", ".join(str(t) for t in _STATION_PARTS)
        con.execute(f"""
            INSERT INTO keep_stops
            SELECT stop_id FROM {stops}
            WHERE coalesce(location_type, 0) IN ({parts})
              AND parent_station IN (SELECT id FROM keep_stops)
              AND stop_id NOT IN (SELECT id FROM keep_stops)
        """)
    zone = "zone_id" if "zone_id" in stop_cols else "CAST(NULL AS VARCHAR)"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE keep_zones AS
        SELECT DISTINCT {zone} AS id FROM {stops}
        WHERE stop_id IN (SELECT id FROM keep_stops) AND {zone} IS NOT NULL
    """)

    # An operator's other lines are not kept, and so neither is an operator
    # none of the kept lines names. A kept line naming none runs for the
    # feed's only operator, which is then kept whatever it is called.
    routes = src["routes"]
    named = "agency_id" in _columns(con, routes)
    unnamed = (
        con.execute(
            f"SELECT count(*) FROM {routes} WHERE route_id IN "
            f"(SELECT id FROM keep_routes) AND coalesce(agency_id, '') = ''"
        ).fetchone()[0]
        if named
        else 1
    )
    if named and not unnamed:
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE keep_agency AS
            SELECT DISTINCT agency_id AS id FROM {routes}
            WHERE route_id IN (SELECT id FROM keep_routes)
        """)
    elif "agency" in src and "agency_id" in _columns(con, src["agency"]):
        con.execute(
            f"CREATE OR REPLACE TEMP TABLE keep_agency AS "
            f"SELECT agency_id AS id FROM {src['agency']}"
        )
    else:
        con.execute("CREATE OR REPLACE TEMP TABLE keep_agency (id VARCHAR)")
    # Filled once fare_attributes is cut (see _cut_table).
    con.execute("CREATE OR REPLACE TEMP TABLE keep_fares (id VARCHAR)")


def _row_filter(con: Any, role: str, relation: str) -> str:
    columns = _columns(con, relation)
    conditions = [
        _kept(c, _REFERENCES[c])
        for c in columns
        if c in _REFERENCES and _OWN_KEY.get(role) != c
    ]
    if role == "translations" and {"table_name", "record_id"} <= set(columns):
        named = " ".join(
            f"WHEN table_name = '{t}' THEN record_id IN (SELECT id FROM keep_{k})"
            for t, k in _TRANSLATED.items()
        )
        conditions.append(
            f"(coalesce(record_id, '') = '' OR CASE {named} ELSE TRUE END)"
        )
    return " AND ".join(conditions) or "TRUE"


def _cut_table(con: Any, table: Dict[str, Any], relation: str, workdir: str) -> str:
    """Write ``table``'s kept rows to ``workdir``; return the file."""
    role = table["role"]
    out_path = os.path.join(workdir, f"{role}.parquet")
    select = f"SELECT * FROM {relation} WHERE {_row_filter(con, role, relation)}"
    if table["geometry_type"]:
        from goatlib.io.geoparquet import write_optimized_parquet

        # The writer the import writes a feature table with.
        write_optimized_parquet(con, select, out_path)
    else:
        con.execute(f"COPY ({select}) TO '{_q(out_path)}' (FORMAT parquet)")
    if role == "fare_attributes":
        con.execute(
            f"INSERT INTO keep_fares SELECT fare_id FROM read_parquet('{_q(out_path)}')"
        )
    return out_path


def export_pt_network(
    con: Any, *, area: dict, store_dir: str, workdir: str
) -> List[ExtractedLayer]:
    """Cut the network in ``store_dir`` to ``area``; return the bundle's layers,
    written to ``workdir``."""
    con.execute("INSTALL spatial; LOAD spatial;")
    if area_cells(con, area) > MAX_CELLS:
        raise ValueError(TOO_LARGE)
    area_table(con, area)
    info = read_store(store_dir)
    src = {t["role"]: f"read_parquet('{_q(t['path'])}')" for t in info["tables"]}
    missing = {"stops", "routes", "trips", "stop_times"} - src.keys()
    if missing:
        raise ValueError(f"The network's tables lack {', '.join(sorted(missing))}.")

    lines = _select_lines(con, src)
    _close(con, src)

    # fare_rules name fares: cut after fare_attributes, which says which stay.
    tables = sorted(
        (t for t in info["tables"] if t["role"] != "shape_lines"),
        key=lambda t: t["role"] == "fare_rules",
    )
    paths = {t["role"]: _cut_table(con, t, src[t["role"]], workdir) for t in tables}
    layers = store_layers(info, paths)
    # Drawn again from the cut, as the import draws them.
    drawn = GtfsImporter().lines_layer(paths, workdir)
    if drawn is not None:
        layers.append(drawn)

    (trips,) = con.execute("SELECT count(*) FROM keep_trips").fetchone()
    (stops,) = con.execute("SELECT count(*) FROM keep_stops").fetchone()
    logger.info(
        "cut %d line(s), %d trip(s) and %d stop(s) from the public transport network",
        lines,
        trips,
        stops,
    )
    return layers
