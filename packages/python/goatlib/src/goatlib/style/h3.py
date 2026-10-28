"""H3 hexagons (the specification's section 8.3): which resolution a zoom draws,
how far around a tile its points are read, and the per-cell values.

geoapi draws the hexagon tiles with `cell_values_sql`; processes computes the
classes from the same cells (`cell_sql`, rolled up to coarser resolutions). The
SQL needs DuckDB's h3 community extension on the connection.
"""

import math
from typing import Any

#: The resolutions "auto" draws, finest last.
AUTO_RESOLUTIONS: tuple[int, ...] = (5, 6, 7, 8, 9, 10)

#: From which zoom each auto resolution draws: the finest whose hexagons are at
#: least about 20 pixels wide at the zoom's start in central Europe (up to about
#: 50 at its end). Published to the web in the schema (`x-h3-auto`).
AUTO_FROM_ZOOM: tuple[tuple[int, int], ...] = (
    (0, 5),
    (8, 6),
    (10, 7),
    (11, 8),
    (13, 9),
    (14, 10),
)

#: Average hexagon edge length per resolution in km (h3_get_hexagon_edge_length_avg).
EDGE_KM: dict[int, float] = {
    5: 9.85409099,
    6: 3.724532667,
    7: 1.406475763,
    8: 0.53141401,
    9: 0.200786148,
    10: 0.075863783,
}

_KM_PER_DEGREE = 111.32
#: Hexagon edges vary around their average; reading two edges beyond a tile
#: reaches every point of a cell that touches the tile.
_MARGIN_EDGES = 2


def quote_identifier(name: str) -> str:
    """A SQL identifier, embedded double quotes doubled (importing the statistics
    helpers would load DuckDB with `goatlib.style`)."""
    return '"' + name.replace('"', '""') + '"'


def auto_resolution(zoom: int) -> int:
    """The resolution "auto" draws at a tile zoom."""
    resolution = AUTO_FROM_ZOOM[0][1]
    for from_zoom, res in AUTO_FROM_ZOOM:
        if zoom >= from_zoom:
            resolution = res
    return resolution


def resolutions_of(render: dict[str, Any]) -> tuple[int, ...]:
    """The resolutions an H3 render draws: its fixed one, or every auto one."""
    resolution = render.get("resolution", "auto")
    if isinstance(resolution, int) and not isinstance(resolution, bool):
        return (resolution,)
    return AUTO_RESOLUTIONS


def tile_margin_degrees(resolution: int, latitude: float) -> tuple[float, float]:
    """How far beyond a tile its points are read, in degrees of latitude and
    longitude at `latitude`."""
    km = EDGE_KM[resolution] * _MARGIN_EDGES
    lat = km / _KM_PER_DEGREE
    cos = max(math.cos(math.radians(min(abs(latitude), 85.0))), 0.01)
    return lat, lat / cos


def value_sql(op: str, field: str | None) -> str:
    """The aggregate of a cell's points: their count, or the sum or mean of a field."""
    if op == "count" or not field:
        return "CAST(count(*) AS DOUBLE)"
    column = f"CAST({quote_identifier(field)} AS DOUBLE)"
    return f"{'avg' if op == 'mean' else 'sum'}({column})"


def cell_sql(geometry: str, resolution: int) -> str:
    """A point's cell: the parent of its cell at the finest auto resolution. H3
    children do not nest exactly in their parent, so the cell holding a point at
    a coarse resolution can differ from its fine cell's parent; reading every
    resolution through the finest lets processes roll fine cells up and still
    match geoapi's tiles."""
    point = f"ST_Centroid({quote_identifier(geometry)})"
    finest = f"h3_latlng_to_cell(ST_Y({point}), ST_X({point}), {AUTO_RESOLUTIONS[-1]})"
    return f"h3_cell_to_parent({finest}, {int(resolution)})"


def cell_values_sql(
    relation: str,
    geometry: str,
    op: str,
    field: str | None,
    resolution: int,
    where: str = "TRUE",
) -> str:
    """`(cell, value, count)` per cell of `resolution` over the points of
    `relation` that pass `where`; cells without a value (a sum or mean over
    empty fields) are left out."""
    return f"""
        SELECT cell, value, n FROM (
            SELECT {cell_sql(geometry, resolution)} AS cell,
                   {value_sql(op, field)} AS value,
                   count(*) AS n
            FROM {relation}
            WHERE {quote_identifier(geometry)} IS NOT NULL AND ({where})
            GROUP BY cell
        ) WHERE value IS NOT NULL
    """
