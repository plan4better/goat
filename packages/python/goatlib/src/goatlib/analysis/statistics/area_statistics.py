"""Area statistics calculation."""

import logging
from typing import Any

import duckdb

from goatlib.analysis.schemas.statistics import (
    AreaOperation,
    AreaStatisticsGroup,
    AreaStatisticsResult,
)
from goatlib.analysis.statistics.columns import quote_identifier, require_column

logger = logging.getLogger(__name__)

_AGGREGATES = {
    AreaOperation.sum: "SUM",
    AreaOperation.mean: "AVG",
    AreaOperation.min: "MIN",
    AreaOperation.max: "MAX",
}
_LON_LAT = {"EPSG:4326", "OGC:CRS84"}


def _area_expression(geom_col: str, source_crs: str) -> str:
    """Square metres on the WGS84 spheroid. ST_Area_Spheroid reads latitude
    first, so lon/lat geometries are flipped; a geometry in another CRS is
    brought to lon/lat first (``always_xy`` keeps that axis order)."""
    geometry = geom_col
    if source_crs.upper() not in _LON_LAT:
        geometry = (
            f"ST_Transform({geom_col}, '{source_crs}', 'EPSG:4326', always_xy := true)"
        )
    return f"ST_Area_Spheroid(ST_FlipCoordinates({geometry}))"


def calculate_area_statistics(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    geometry_column: str,
    operation: AreaOperation = AreaOperation.sum,
    where_clause: str = "TRUE",
    params: list[Any] | None = None,
    source_crs: str = "EPSG:4326",
    group_by_column: str | None = None,
    limit: int = 100,
) -> AreaStatisticsResult:
    """Area statistics of polygon features in square metres, measured on the
    spheroid, for the whole (filtered) table and, with ``group_by_column``,
    per value of that field (largest total area first, at most ``limit``).

    Raises:
        ValueError: If ``group_by_column`` is not a column of the table.
    """
    if group_by_column is not None:
        require_column(con, table_name, group_by_column, "group_by_column")
    area = _area_expression(quote_identifier(geometry_column), source_crs)
    aggregate = f"{_AGGREGATES.get(operation, 'SUM')}({area})"
    values = params or []
    query = f"""
        SELECT {aggregate} AS result, SUM({area}) AS total_area, COUNT(*) AS feature_count
        FROM {table_name}
        WHERE {where_clause}
    """
    logger.debug("Area statistics query: %s with params: %s", query, values)
    whole = con.execute(query, values).fetchone()
    result = AreaStatisticsResult(
        result=whole[0] if whole else None,
        total_area=whole[1] if whole else None,
        feature_count=whole[2] if whole else 0,
        unit="m²",
    )
    if group_by_column is None:
        return result
    group = f"CAST({quote_identifier(group_by_column)} AS VARCHAR)"
    rows = con.execute(
        f"""
        SELECT {group} AS grouped_value, {aggregate} AS result,
               SUM({area}) AS total_area, COUNT(*) AS feature_count,
               COUNT(*) OVER () AS total_groups
        FROM {table_name}
        WHERE {where_clause}
        GROUP BY 1
        ORDER BY total_area DESC NULLS LAST, grouped_value NULLS LAST
        LIMIT {int(limit)}
        """,
        values,
    ).fetchall()
    result.groups = [
        AreaStatisticsGroup(
            grouped_value=row[0], result=row[1], total_area=row[2], feature_count=row[3]
        )
        for row in rows
    ]
    result.total_groups = rows[0][4] if rows else 0
    return result
