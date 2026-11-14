"""The area a fetch reads, shared by the mirror and the street network."""

import hashlib
import json
import threading
from collections import OrderedDict
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


#: Merged areas, as WKB, by the digest of the GeoJSON text they were sent as.
_merged: OrderedDict[bytes, bytes] = OrderedDict()
_merged_lock = threading.Lock()
_MERGED_KEPT = 32


def area_table(con: "Any", area: dict) -> str:
    """The area as a one-row table, so it is read like a layer.

    A client sends pieces side by side (a region and a circle over it). Parts
    that overlap make the area invalid and would be read twice by the per-part
    boxes and counts, so such an area is read as the union of its parts; one
    without overlaps is valid and read as it was sent, which costs no merge. A
    merged area is kept by the digest of its text (`_merged`): the size check
    and the value lists that follow it send the same area."""
    text = json.dumps(area)
    digest = hashlib.sha256(text.encode()).digest()
    with _merged_lock:
        known = _merged.get(digest)
        if known is not None:
            _merged.move_to_end(digest)
    if known is not None:
        con.execute(
            "CREATE OR REPLACE TEMP TABLE fetch_area AS SELECT ST_GeomFromWKB(?) AS geom",
            [known],
        )
    else:
        con.execute(
            "CREATE OR REPLACE TEMP TABLE fetch_area AS SELECT ST_GeomFromGeoJSON(?) AS geom",
            [text],
        )
        valid = con.execute("SELECT ST_IsValid(geom) FROM fetch_area").fetchone()
        if valid and not valid[0]:
            con.execute(
                """
                CREATE OR REPLACE TEMP TABLE fetch_area AS
                SELECT ST_Union_Agg(ST_MakeValid(part.geom)) AS geom
                FROM (SELECT unnest(ST_Dump(geom)).geom AS geom FROM fetch_area) part
                """
            )
            wkb = con.execute("SELECT ST_AsWKB(geom) FROM fetch_area").fetchone()
            if wkb and wkb[0] is not None:
                with _merged_lock:
                    _merged[digest] = bytes(wkb[0])
                    while len(_merged) > _MERGED_KEPT:
                        _merged.popitem(last=False)
    row = con.execute(
        "SELECT ST_GeometryType(geom)::VARCHAR FROM fetch_area"
    ).fetchone()
    if not row or row[0] not in ("POLYGON", "MULTIPOLYGON"):
        raise ValueError("The area has to be a polygon.")
    return "fetch_area"
