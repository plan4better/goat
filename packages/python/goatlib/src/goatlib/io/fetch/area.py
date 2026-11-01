"""The area a fetch reads, shared by the mirror and the street network."""

import json
from typing import Any


def _group_rows(groups: list[tuple], envelope: tuple, column: int = 2) -> int:
    """Features (or, with column 7, geometry bytes) in the envelope, by each row group's share inside."""
    xmin, ymin, xmax, ymax = envelope
    total = 0.0
    for g in groups:
        n, (gx0, gy0, gx1, gy1) = g[column], g[3:7]
        if gx0 is None:
            continue
        w = min(xmax, gx1) - max(xmin, gx0)
        h = min(ymax, gy1) - max(ymin, gy0)
        if w < 0 or h < 0:
            continue
        area = (gx1 - gx0) * (gy1 - gy0)
        total += n if area <= 0 else n * max(w, 0) * max(h, 0) / area
    return int(total)


def area_geom_column(con: "Any", area_table: str) -> str:
    """The reference layer's geometry column.

    Detected, not assumed: the mirror names it `geom` and a GOAT layer names it
    `geometry`, and this reads a GOAT layer.
    """
    described = con.execute(f"DESCRIBE SELECT * FROM {area_table}").fetchall()
    for row in described:
        if "GEOMETRY" in str(row[1]).upper():
            return str(row[0])
    raise ValueError("The area has no geometry column, so there is no area to read.")


def area_boxes(con: "Any", area_table: str) -> list[tuple]:
    """Each separate part's bounding box: regions far apart are not one big box."""
    geom = area_geom_column(con, area_table)
    return [
        tuple(r)
        for r in con.execute(
            f"SELECT ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g) FROM "
            f'(SELECT unnest(ST_Dump("{geom}")).geom AS g FROM {area_table})'
        ).fetchall()
    ]


def _area_rows(groups: list[tuple], boxes: list[tuple], column: int = 2) -> int:
    """Features (or geometry bytes) in the area, part by part."""
    return sum(_group_rows(groups, b, column) for b in boxes)


def area_envelope(con: "Any", area_table: str) -> tuple:
    """The reference area's bounding box."""
    geom = area_geom_column(con, area_table)
    bounds = con.execute(
        f"SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) FROM "
        f'(SELECT ST_Extent(ST_Union_Agg("{geom}")) AS e FROM {area_table})'
    ).fetchone()
    if not bounds or bounds[0] is None:
        raise ValueError("The area holds no geometry, so there is no area to read.")
    return tuple(bounds)


def area_table(con: "Any", area: dict) -> str:
    """The area as a one-row table, so it is read like a layer."""
    con.execute(
        "CREATE OR REPLACE TEMP TABLE fetch_area AS SELECT ST_GeomFromGeoJSON(?) AS geom",
        [json.dumps(area)],
    )
    row = con.execute(
        "SELECT ST_GeometryType(geom)::VARCHAR FROM fetch_area"
    ).fetchone()
    if not row or row[0] not in ("POLYGON", "MULTIPOLYGON"):
        raise ValueError("The area has to be a polygon.")
    return "fetch_area"
