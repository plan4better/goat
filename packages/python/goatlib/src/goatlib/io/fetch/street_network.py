"""GOAT's routing network, cut to an area as a street network bundle's two layers.

Every edge touching the area is kept whole, never cut at the boundary, so ids and
slope stay those of the network; the nodes are the kept edges' endpoints.
"""

import glob
import logging
import os
from typing import Any

from goatlib.io.fetch.area import area_boxes, area_table
from goatlib.io.parquet import write_optimized_parquet
from goatlib.tasks.sync_base_data import h3_3_cells_for_bbox

logger = logging.getLogger(__name__)

#: H3-6 cells an area may touch, counted from the area alone, without the network.
MAX_CELLS = 44

#: Smaller pieces the cut leaves behind (roads leaving the area and returning) are
#: islands that snapped points cannot route from, so they are dropped.
MIN_COMPONENT_SHARE = 0.01

# Measured, not 44 x 36 km²: the cells an area only touches at its edge count too,
# so a compact area reaches 44 cells at 940-1,120 km² in Germany.
TOO_LARGE = "This area is too large for a street network (max. about 1,000 km²)."


def _quote(value: str) -> str:
    return value.replace("'", "''")


def area_cells(con: Any, area: dict) -> int:
    """H3-6 cells the area overlaps, over all its parts."""
    table = area_table(con, area)
    # An H3-6 cell is at most about 45 km², so an area larger than the limit's
    # worth is refused from its size alone, before a continent's cells are listed.
    (km2,) = con.execute(
        f"SELECT sum(ST_Area_Spheroid(ST_FlipCoordinates(geom))) / 1e6 FROM {table}"
    ).fetchone()
    if km2 > MAX_CELLS * 45:
        return MAX_CELLS + 1
    con.execute("INSTALL h3 FROM community; LOAD h3;")
    (cells,) = con.execute(f"""
        SELECT count(DISTINCT cell) FROM (
            SELECT unnest(h3_polygon_wkt_to_cells_experimental(
                ST_AsText(part), 6, 'overlap')) AS cell
            FROM (SELECT unnest(ST_Dump(geom)).geom AS part FROM {table}))
    """).fetchone()
    return int(cells)


def size(con: Any, area: dict) -> dict:
    """The area's size as the fetch form asks it, in the mirror-values shape.

    No attributes to list, and its size is the area's cells: the network
    itself is on the workers' disks, not readable from here.
    """
    cells = area_cells(con, area)
    return {
        "key": None,
        "total": 0,
        "complete": True,
        "estimate": None,
        "cells": cells,
        "too_large": cells > MAX_CELLS,
        "values": [],
    }


def check_area(con: Any, area: dict) -> None:
    """Refuse an area over the cell limit, before anything is read."""
    if area_cells(con, area) > MAX_CELLS:
        raise ValueError(TOO_LARGE)


def _drop_islands(con: Any) -> None:
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        root = x
        while parent.setdefault(root, root) != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    pairs = con.execute(
        "SELECT id, source_node, target_node FROM network_edges"
    ).fetchall()
    for _, a, b in pairs:
        parent[find(a)] = find(b)
    size: dict[str, int] = {}
    for _, a, _b in pairs:
        root = find(a)
        size[root] = size.get(root, 0) + 1
    biggest = max(size, key=size.__getitem__)
    keep = {r for r, n in size.items() if n >= len(pairs) * MIN_COMPONENT_SHARE}
    keep.add(biggest)
    dropped = [i for i, a, _b in pairs if find(a) not in keep]
    if dropped:
        con.execute(
            "DELETE FROM network_edges WHERE id IN (SELECT unnest(?::VARCHAR[]))",
            [dropped],
        )
    logger.info(
        "dropped %d island(s) with %d edge(s) of %d components",
        len(size) - len(keep),
        len(dropped),
        len(size),
    )


def _partition_files(base: str, cells: set[int]) -> list[str]:
    return sorted(
        f
        for cell in cells
        for f in glob.glob(os.path.join(base, f"h3_3={cell}", "*.parquet"))
    )


def export_network(
    con: Any, *, area: dict, edges_base: str, nodes_base: str, workdir: str
) -> dict[str, str]:
    """Write the area's edges and nodes in the street_network role contract."""
    con.execute("INSTALL spatial; LOAD spatial;")
    check_area(con, area)
    # Part by part: two towns far apart are two small reads, not the box between them.
    boxes = area_boxes(con, area_table(con, area))
    # One ring around the area's cells: an edge is filed under one cell but can
    # reach into the next, and so can the node at its far end.
    cells = set().union(*(h3_3_cells_for_bbox(list(box), ring=1) for box in boxes))
    edge_files = _partition_files(edges_base, cells)
    node_files = _partition_files(nodes_base, cells)
    if not edge_files or not node_files:
        raise ValueError("The GOAT routing network does not cover this area.")

    near_parts = " OR ".join(
        f"(list_min(list_transform(coordinates_3857, c -> c[1])) <= {x1}"
        f" AND list_max(list_transform(coordinates_3857, c -> c[1])) >= {x0}"
        f" AND list_min(list_transform(coordinates_3857, c -> c[2])) <= {y1}"
        f" AND list_max(list_transform(coordinates_3857, c -> c[2])) >= {y0})"
        for x0, y0, x1, y1 in con.execute(
            """SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) FROM (
                 SELECT ST_Extent(ST_Transform(part, 'EPSG:4326', 'EPSG:3857',
                                               always_xy := true)) AS e
                 FROM (SELECT unnest(ST_Dump(geom)).geom AS part FROM fetch_area))"""
        ).fetchall()
    )
    edge_list = ", ".join(f"'{_quote(f)}'" for f in edge_files)
    node_list = ", ".join(f"'{_quote(f)}'" for f in node_files)
    read = (
        f"read_parquet([{edge_list}], hive_partitioning = false, union_by_name = true)"
    )
    columns = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {read}").fetchall()}
    has_slope = {"impedance_slope", "impedance_slope_reverse"} <= columns
    slope = (
        "coalesce(l.impedance_slope, 0)::DOUBLE AS impedance_slope, "
        "coalesce(l.impedance_slope_reverse, 0)::DOUBLE AS impedance_slope_reverse,"
        if has_slope
        else "0.0::DOUBLE AS impedance_slope, 0.0::DOUBLE AS impedance_slope_reverse,"
    )

    # The network's surface penalty too, so the cut routes as the network does.
    surface = (
        "l.impedance_surface::FLOAT AS impedance_surface,"
        if "impedance_surface" in columns
        else ""
    )

    # The coordinates' own box first, which is arithmetic; the line is only
    # built and tested against the area for edges that can reach it.
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE network_edges AS
        WITH near AS (
            SELECT * FROM {read}
            WHERE {near_parts}
        ), lines AS (
            SELECT *, ST_Transform(
                ST_MakeLine(list_transform(coordinates_3857, c -> ST_Point(c[1], c[2]))),
                'EPSG:3857', 'EPSG:4326', always_xy := true) AS geometry
            FROM near
        )
        SELECT
            CAST(l.id AS VARCHAR) AS id,
            CAST(NULL AS VARCHAR) AS name,
            l.class_ AS class,
            CAST(NULL AS VARCHAR) AS subclass,
            l.length_m,
            CAST(NULL AS VARCHAR) AS surface,
            CAST(l.maxspeed_forward AS INTEGER) AS speed_limit_kph_forward,
            CAST(l.maxspeed_backward AS INTEGER) AS speed_limit_kph_backward,
            CAST(l.source AS VARCHAR) AS source_node,
            CAST(l.target AS VARCHAR) AS target_node,
            {slope}
            {surface}
            CAST(NULL AS VARCHAR) AS other,
            CAST(NULL AS VARCHAR) AS original_id,
            l.geometry
        FROM lines l, fetch_area a
        WHERE ST_Intersects(l.geometry, a.geom)
        -- An edge in a newer and an older partition keeps the copy with slope.
        QUALIFY row_number() OVER (
            PARTITION BY l.id ORDER BY {"l.impedance_slope IS NULL" if has_slope else "l.id"}) = 1
    """)
    count = con.execute("SELECT count(*) FROM network_edges").fetchone()[0]
    if not count:
        raise ValueError("The GOAT routing network has no streets in this area.")

    _drop_islands(con)

    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE network_nodes AS
        SELECT CAST(id AS VARCHAR) AS id,
               ST_Transform(ST_Point(x_3857, y_3857), 'EPSG:3857', 'EPSG:4326',
                            always_xy := true) AS geometry
        FROM read_parquet([{node_list}], hive_partitioning = false, union_by_name = true)
        WHERE CAST(id AS VARCHAR) IN (
            SELECT source_node FROM network_edges
            UNION SELECT target_node FROM network_edges)
        QUALIFY row_number() OVER (PARTITION BY id ORDER BY id) = 1
    """)

    paths = {}
    for role, table in (("edges", "network_edges"), ("nodes", "network_nodes")):
        path = os.path.join(workdir, f"{role}.parquet")
        write_optimized_parquet(con, table, path, geometry_column="geometry")
        paths[role] = path
    logger.info(
        "cut %d edge(s) from the routing network (%d cell(s))", count, len(cells)
    )
    return paths
