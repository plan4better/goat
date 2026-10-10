"""Optimized Parquet/GeoParquet writing utilities.

This module provides functions for creating optimized Parquet files with:
1. Parquet V2 format - better compression with modern encodings
2. Hilbert spatial sorting - groups nearby features in the same row groups (geo only)
3. Bounding box columns - enables fast row group pruning during spatial queries (geo only)
4. Proper row group sizing - balances I/O efficiency with memory usage

For spatial data, these optimizations can provide 3-10x speedup for spatial queries
by enabling DuckDB/Parquet readers to skip entire row groups based on bbox statistics.

Usage:
    from goatlib.io.geoparquet import write_optimized_parquet

    # Write with automatic optimization (detects geometry)
    write_optimized_parquet(
        con,
        "SELECT * FROM my_table",
        "/path/to/output.parquet",
        geometry_column="geometry"  # optional, for geo data
    )

Why Hilbert Sorting?
    Hilbert curves preserve spatial locality - points close in 2D space
    remain close in 1D order. This means features in the same geographic
    area end up in the same Parquet row groups, enabling:
    - Efficient bbox-based row group pruning
    - Better compression (similar geometries compress better)
    - Reduced I/O for spatial queries

Why Bounding Box Columns?
    Parquet stores min/max statistics per row group. With explicit bbox
    columns (xmin, ymin, xmax, ymax), spatial queries can use these
    statistics to skip row groups without reading geometry data.

    IMPORTANT: Bbox values must be LITERAL constants in WHERE clauses
    for row group pruning to work. Using ST_XMax(geom) in WHERE prevents
    pruning because DuckDB can't push function results to the parquet reader.
"""

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from goatlib.io.bbox_columns import BBOX_COLUMN, star_excluding, stray_bbox_columns
from goatlib.io.config import (
    PARQUET_COMPRESSION,
    PARQUET_ROW_GROUP_SIZE,
)

if TYPE_CHECKING:
    import duckdb

logger = logging.getLogger(__name__)

# Re-export for backward compatibility
DEFAULT_ROW_GROUP_SIZE = PARQUET_ROW_GROUP_SIZE
DEFAULT_COMPRESSION = PARQUET_COMPRESSION


def write_optimized_parquet(
    con: "duckdb.DuckDBPyConnection",
    source: str,
    output_path: str | Path,
    geometry_column: str = "geometry",
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE,
    compression: str = DEFAULT_COMPRESSION,
    add_bbox: bool = True,
    hilbert_sort: bool = True,
) -> int:
    """Write an optimized Parquet file with V2 format and spatial optimizations.

    This function creates a Parquet file optimized for queries:
    - Always uses Parquet V2 for better compression (DELTA_BINARY_PACKED, etc.)
    - For spatial data: adds bbox columns and Hilbert sorting for fast queries
    - For non-spatial data: writes plain optimized Parquet

    Args:
        con: DuckDB connection (with spatial extension if writing geo data)
        source: Source table name or SQL query (will be wrapped if needed)
        output_path: Path to output Parquet file
        geometry_column: Name of the geometry column (default: "geometry")
        row_group_size: Number of rows per row group (default: 75000)
        compression: Compression codec (default: "ZSTD")
        add_bbox: Whether to add bbox struct column for geo data (default: True)
        hilbert_sort: Whether to sort by Hilbert curve for geo data (default: True)

    Returns:
        Number of rows written

    Example:
        >>> con = duckdb.connect()
        >>> con.execute("LOAD spatial")
        >>> write_optimized_parquet(
        ...     con,
        ...     "my_table",
        ...     "/tmp/output.parquet",
        ...     geometry_column="geometry"
        ... )
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Normalize source to a query
    source_query = _normalize_source(source)

    # Check if geometry column exists and has data
    has_geometry = _check_geometry_column(con, source_query, geometry_column)

    if not has_geometry:
        # No geometry - write optimized plain parquet (V2 format)
        logger.debug(
            "No geometry column '%s' found, writing plain parquet V2", geometry_column
        )
        return _write_plain_parquet(
            con, source_query, output_path, row_group_size, compression
        )

    # Build optimized query with bbox and Hilbert sort
    optimized_query = _build_optimized_query(
        source_query,
        geometry_column,
        add_bbox=add_bbox,
        hilbert_sort=hilbert_sort,
        exclude_columns=_bbox_columns_to_drop(con, source_query, add_bbox),
    )

    # Execute COPY with optimization
    # Use PARQUET_VERSION V2 for better compression (DELTA_BINARY_PACKED, etc.)
    copy_sql = f"""
        COPY ({optimized_query})
        TO '{output_path}'
        (FORMAT PARQUET, COMPRESSION {compression}, ROW_GROUP_SIZE {row_group_size}, PARQUET_VERSION V2)
    """

    logger.debug("Writing optimized GeoParquet: %s", output_path)
    con.execute(copy_sql)

    # Get row count for return value
    try:
        count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{output_path}')"
        ).fetchone()[0]
    except Exception:
        count = 0

    logger.info(
        "Wrote optimized Parquet: %s (%d rows, bbox=%s, hilbert=%s)",
        output_path,
        count,
        add_bbox,
        hilbert_sort,
    )
    return count


# Alias for backward compatibility
write_optimized_geoparquet = write_optimized_parquet


def _normalize_source(source: str) -> str:
    """Normalize source to a query string.

    Handles:
    - Table names: "my_table" -> "SELECT * FROM my_table"
    - Queries: "SELECT * FROM ..." -> unchanged
    - read_parquet: "read_parquet(...)" -> "SELECT * FROM read_parquet(...)"
    """
    source = source.strip()
    source_upper = source.upper()

    # Already a SELECT query
    if source_upper.startswith("SELECT"):
        return source

    # Function call like read_parquet(...) or ST_Read(...)
    if "(" in source and ")" in source:
        return f"SELECT * FROM {source}"

    # Plain table name
    return f"SELECT * FROM {source}"


def _bbox_columns_to_drop(
    con: "duckdb.DuckDBPyConnection",
    source_query: str,
    add_bbox: bool,
) -> list[str]:
    """Bounding-box columns of the source that must not reach the output.

    Stray copies (``bbox_1``, GDAL's ``geometry_bbox``, see
    ``goatlib.io.bbox_columns``) always; an inherited ``bbox`` when a fresh one
    replaces it, since DuckDB would otherwise rename the new one to ``bbox_1``.
    """
    try:
        rows = con.execute(f"DESCRIBE {source_query}").fetchall()
    except Exception as e:
        logger.debug("bbox column check failed: %s", e)
        return []
    drop = stray_bbox_columns(rows)
    if add_bbox and any(r[0] == BBOX_COLUMN for r in rows):
        drop.append(BBOX_COLUMN)
    return drop


def _check_geometry_column(
    con: "duckdb.DuckDBPyConnection",
    source_query: str,
    geometry_column: str,
) -> bool:
    """Check if the source has a valid geometry column with data."""
    try:
        # Check if column exists and has geometry type
        result = con.execute(
            f"""
            SELECT COUNT(*) FROM ({source_query}) t
            WHERE "{geometry_column}" IS NOT NULL
            LIMIT 1
            """
        ).fetchone()
        return result is not None and result[0] > 0
    except Exception as e:
        logger.debug("Geometry column check failed: %s", e)
        return False


def _build_optimized_query(
    source_query: str,
    geometry_column: str,
    add_bbox: bool = True,
    hilbert_sort: bool = True,
    exclude_columns: Sequence[str] = (),
) -> str:
    """Build query with bbox columns and Hilbert sorting.

    The output includes:
    - All original columns
    - bbox struct with {xmin, ymin, xmax, ymax} for row group pruning
    - ORDER BY Hilbert curve for spatial clustering

    Args:
        source_query: Source SELECT query
        geometry_column: Name of geometry column
        add_bbox: Whether to add bbox struct
        hilbert_sort: Whether to sort by Hilbert curve

    Returns:
        Optimized SQL query string
    """
    geom_expr = f'"{geometry_column}"'

    # Build bbox expression
    # Using a struct for GeoParquet 1.1 compatibility
    bbox_expr = ""
    if add_bbox:
        bbox_expr = f""",
            {{
                'xmin': ST_XMin({geom_expr}),
                'ymin': ST_YMin({geom_expr}),
                'xmax': ST_XMax({geom_expr}),
                'ymax': ST_YMax({geom_expr})
            }} AS bbox"""

    # Build ORDER BY for Hilbert sorting
    # ST_Hilbert creates a Hilbert curve index from geometry
    # This groups spatially nearby features together in row groups
    order_by = ""
    if hilbert_sort:
        # ST_Hilbert(geometry) computes Hilbert index for the geometry
        order_by = f"ORDER BY ST_Hilbert({geom_expr})"

    # Leave out the source's bounding-box columns (see _bbox_columns_to_drop).
    star = star_excluding(exclude_columns)

    # Combine into final query
    return f"""
        SELECT {star}{bbox_expr}
        FROM ({source_query}) AS _src
        {order_by}
    """


def _write_plain_parquet(
    con: "duckdb.DuckDBPyConnection",
    source_query: str,
    output_path: Path,
    row_group_size: int,
    compression: str,
) -> int:
    """Write plain parquet with V2 format (no spatial optimization)."""
    # Use PARQUET_VERSION V2 for better compression (DELTA_BINARY_PACKED, etc.)
    copy_sql = f"""
        COPY ({source_query})
        TO '{output_path}'
        (FORMAT PARQUET, COMPRESSION {compression}, ROW_GROUP_SIZE {row_group_size}, PARQUET_VERSION V2)
    """
    con.execute(copy_sql)

    try:
        count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{output_path}')"
        ).fetchone()[0]
    except Exception:
        count = 0

    return count


def verify_geoparquet_optimization(
    con: "duckdb.DuckDBPyConnection",
    parquet_path: str | Path,
) -> dict:
    """Verify that a GeoParquet file has the expected optimizations.

    Checks:
    - bbox struct column exists
    - Row groups have reasonable min/max statistics
    - Data appears to be spatially sorted

    Args:
        con: DuckDB connection
        parquet_path: Path to GeoParquet file

    Returns:
        Dict with verification results:
        {
            "has_bbox": bool,
            "row_count": int,
            "row_group_count": int,
            "is_sorted": bool,  # Approximate check
            "bbox_stats": {"xmin": (min, max), ...}  # Per row group ranges
        }
    """
    parquet_path = str(parquet_path)
    result = {
        "has_bbox": False,
        "row_count": 0,
        "row_group_count": 0,
        "is_sorted": False,
        "bbox_stats": None,
    }

    try:
        # Check for bbox column
        schema = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
        ).fetchall()
        column_names = [row[0] for row in schema]
        result["has_bbox"] = "bbox" in column_names

        # Get row count
        result["row_count"] = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{parquet_path}')"
        ).fetchone()[0]

        # Get parquet metadata for row groups
        try:
            metadata = con.execute(
                f"SELECT * FROM parquet_metadata('{parquet_path}')"
            ).fetchall()
            if metadata:
                result["row_group_count"] = len(
                    set(row[0] for row in metadata)  # row_group_id
                )
        except Exception:
            pass

        # Check spatial sorting by comparing adjacent bbox values
        if result["has_bbox"] and result["row_count"] > 100:
            # Sample check: are nearby rows also nearby spatially?
            # This is a heuristic - true verification would need Hilbert values
            sample = con.execute(
                f"""
                SELECT
                    bbox.xmin, bbox.ymin,
                    LEAD(bbox.xmin) OVER () as next_xmin,
                    LEAD(bbox.ymin) OVER () as next_ymin
                FROM read_parquet('{parquet_path}')
                LIMIT 1000
                """
            ).fetchall()

            # Calculate average distance to next row
            if sample:
                distances = []
                for row in sample:
                    if row[2] is not None and row[3] is not None:
                        dx = abs(row[2] - row[0])
                        dy = abs(row[3] - row[1])
                        distances.append((dx**2 + dy**2) ** 0.5)
                if distances:
                    avg_dist = sum(distances) / len(distances)
                    # Sorted data should have low average distance
                    # This is a rough heuristic
                    result["is_sorted"] = avg_dist < 1.0  # ~1 degree threshold

    except Exception as e:
        logger.warning("GeoParquet verification failed: %s", e)

    return result
