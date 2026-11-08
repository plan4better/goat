"""The area a fetch reads, shared by the mirror and the street network."""

import json
from typing import Any


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
