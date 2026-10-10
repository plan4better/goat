"""Tests for Parquet/GeoParquet optimization utilities.

These tests verify that the optimized Parquet writer:
1. Uses Parquet V2 format for better compression
2. Adds bbox struct columns for row group pruning (geo data)
3. Sorts data by Hilbert curve for spatial locality (geo data)
4. Produces files that DuckDB can efficiently query with bbox filters
"""

from pathlib import Path
from typing import Generator

import duckdb
import pytest
from goatlib.io.parquet import (
    verify_geoparquet_optimization,
    write_optimized_geoparquet,
)


@pytest.fixture
def duckdb_con() -> Generator[duckdb.DuckDBPyConnection, None, None]:
    """Create a DuckDB connection with spatial extension."""
    con = duckdb.connect(":memory:")
    con.execute("INSTALL spatial; LOAD spatial;")
    yield con
    con.close()


@pytest.fixture
def sample_points_table(duckdb_con: duckdb.DuckDBPyConnection) -> str:
    """Create a table with random point geometries for testing."""
    duckdb_con.execute("""
        CREATE TABLE test_points AS
        SELECT
            i AS id,
            'Feature ' || i AS name,
            ST_Point(-180 + (i % 360), -90 + ((i * 7) % 180)) AS geometry
        FROM range(1000) t(i)
    """)
    return "test_points"


@pytest.fixture
def sample_polygons_table(duckdb_con: duckdb.DuckDBPyConnection) -> str:
    """Create a table with polygon geometries for testing."""
    duckdb_con.execute("""
        CREATE TABLE test_polygons AS
        SELECT
            i AS id,
            'Polygon ' || i AS name,
            ST_Buffer(ST_Point(-180 + (i % 360), -85 + ((i * 7) % 170)), 0.5) AS geometry
        FROM range(500) t(i)
    """)
    return "test_polygons"


# =====================================================================
#  BBOX COLUMN TESTS
# =====================================================================


def test_creates_file_with_bbox_column(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Optimized GeoParquet should have a bbox struct column."""
    output_path = tmp_path / "points.parquet"

    write_optimized_geoparquet(
        duckdb_con, sample_points_table, output_path, geometry_column="geometry"
    )

    assert output_path.exists()

    # Verify bbox column exists
    schema = duckdb_con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_path}')"
    ).fetchall()
    column_names = [row[0] for row in schema]
    assert "bbox" in column_names, "bbox column should be present"

    # Verify bbox has correct structure
    bbox_row = duckdb_con.execute(
        f"SELECT bbox FROM read_parquet('{output_path}') LIMIT 1"
    ).fetchone()
    assert bbox_row is not None
    bbox = bbox_row[0]
    assert "xmin" in bbox
    assert "ymin" in bbox
    assert "xmax" in bbox
    assert "ymax" in bbox


def test_preserves_all_original_columns(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Original columns should be preserved in output."""
    output_path = tmp_path / "points.parquet"

    write_optimized_geoparquet(duckdb_con, sample_points_table, output_path)

    schema = duckdb_con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_path}')"
    ).fetchall()
    column_names = [row[0] for row in schema]

    assert "id" in column_names
    assert "name" in column_names
    assert "geometry" in column_names


def test_row_count_matches(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Output should have same row count as input."""
    output_path = tmp_path / "points.parquet"

    row_count = write_optimized_geoparquet(duckdb_con, sample_points_table, output_path)

    assert row_count == 1000

    actual_count = duckdb_con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{output_path}')"
    ).fetchone()[0]
    assert actual_count == 1000


def test_can_disable_bbox(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Should be able to disable bbox column."""
    output_path = tmp_path / "no_bbox.parquet"

    write_optimized_geoparquet(
        duckdb_con, sample_points_table, output_path, add_bbox=False
    )

    schema = duckdb_con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_path}')"
    ).fetchall()
    column_names = [row[0] for row in schema]
    assert "bbox" not in column_names


def test_can_disable_hilbert_sort(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Should be able to disable Hilbert sorting."""
    output_path = tmp_path / "no_sort.parquet"

    write_optimized_geoparquet(
        duckdb_con, sample_points_table, output_path, hilbert_sort=False
    )

    assert output_path.exists()
    count = duckdb_con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{output_path}')"
    ).fetchone()[0]
    assert count == 1000


def test_handles_non_geometry_table(
    duckdb_con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    """Should handle tables without geometry column."""
    duckdb_con.execute("""
        CREATE TABLE non_spatial AS
        SELECT i AS id, 'Value ' || i AS value
        FROM range(100) t(i)
    """)

    output_path = tmp_path / "non_spatial.parquet"
    write_optimized_geoparquet(duckdb_con, "non_spatial", output_path)

    assert output_path.exists()

    schema = duckdb_con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_path}')"
    ).fetchall()
    column_names = [row[0] for row in schema]
    assert "bbox" not in column_names


def test_polygons_with_bbox(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_polygons_table: str,
    tmp_path: Path,
) -> None:
    """Should correctly compute bbox for polygon geometries."""
    output_path = tmp_path / "polygons.parquet"

    write_optimized_geoparquet(duckdb_con, sample_polygons_table, output_path)

    sample = duckdb_con.execute(
        f"""
        SELECT bbox.xmin, bbox.xmax, bbox.ymin, bbox.ymax
        FROM read_parquet('{output_path}') LIMIT 10
        """
    ).fetchall()

    for row in sample:
        xmin, xmax, ymin, ymax = row
        assert xmin < xmax, "Polygon bbox should have xmin < xmax"
        assert ymin < ymax, "Polygon bbox should have ymin < ymax"


# =====================================================================
#  VERIFICATION TESTS
# =====================================================================


def test_verify_detects_bbox_column(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Should detect presence of bbox column."""
    output_path = tmp_path / "with_bbox.parquet"
    write_optimized_geoparquet(duckdb_con, sample_points_table, output_path)

    result = verify_geoparquet_optimization(duckdb_con, output_path)
    assert result["has_bbox"] is True


def test_verify_detects_missing_bbox(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Should detect when bbox column is missing."""
    output_path = tmp_path / "no_bbox.parquet"
    write_optimized_geoparquet(
        duckdb_con, sample_points_table, output_path, add_bbox=False
    )

    result = verify_geoparquet_optimization(duckdb_con, output_path)
    assert result["has_bbox"] is False


# =====================================================================
#  QUERY CORRECTNESS TESTS
# =====================================================================


def test_bbox_filter_returns_correct_results(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Bbox filtering should return correct features."""
    output_path = tmp_path / "points.parquet"
    write_optimized_geoparquet(duckdb_con, sample_points_table, output_path)

    # Query with bbox filter using literal values (enables row group pruning)
    result = duckdb_con.execute(
        f"""
        SELECT COUNT(*) FROM read_parquet('{output_path}')
        WHERE bbox.xmin <= 10
          AND bbox.xmax >= 0
          AND bbox.ymin <= 10
          AND bbox.ymax >= 0
        """
    ).fetchone()[0]

    # Verify result matches ST_Intersects query
    expected = duckdb_con.execute(
        f"""
        SELECT COUNT(*) FROM read_parquet('{output_path}')
        WHERE ST_Intersects(geometry, ST_MakeEnvelope(0, 0, 10, 10))
        """
    ).fetchone()[0]

    assert result == expected


def test_uses_parquet_v2_encoding(
    duckdb_con: duckdb.DuckDBPyConnection,
    sample_points_table: str,
    tmp_path: Path,
) -> None:
    """Test that output uses Parquet V2 encoding for better compression."""
    import pyarrow.parquet as pq

    output_path = tmp_path / "points.parquet"
    write_optimized_geoparquet(duckdb_con, sample_points_table, output_path)

    # Check that V2 encodings are used (DELTA_BINARY_PACKED for integers)
    pf = pq.ParquetFile(output_path)
    rg = pf.metadata.row_group(0)

    # Find the 'id' column (integer) and check its encoding
    id_col_idx = None
    for i in range(pf.metadata.num_columns):
        if pf.schema_arrow.field(i).name == "id":
            id_col_idx = i
            break

    assert id_col_idx is not None, "Could not find 'id' column"

    # V2 uses DELTA_BINARY_PACKED for integers instead of PLAIN
    col = rg.column(id_col_idx)
    encodings = col.encodings
    assert "DELTA_BINARY_PACKED" in encodings, f"Expected V2 encoding, got: {encodings}"


def test_drops_inherited_and_stray_bbox_columns(
    duckdb_con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    """A source carrying bbox copies from older GOAT versions (bbox_1) and
    GDAL's covering column (geometry_bbox) gets exactly one fresh bbox; a
    user column whose name only contains 'bbox' stays."""
    duckdb_con.execute("""
        CREATE TABLE inherited AS
        SELECT
            i AS id,
            'note ' || i AS bbox_note,
            {'xmin': 0.0, 'ymin': 0.0, 'xmax': 1.0, 'ymax': 1.0} AS bbox,
            {'xmin': 0.0, 'ymin': 0.0, 'xmax': 1.0, 'ymax': 1.0} AS bbox_1,
            {'xmin': 0.0::FLOAT, 'ymin': 0.0::FLOAT, 'xmax': 1.0::FLOAT, 'ymax': 1.0::FLOAT}
                AS geometry_bbox,
            ST_Point(i, i) AS geometry
        FROM range(10) t(i)
    """)
    output_path = tmp_path / "inherited.parquet"

    write_optimized_geoparquet(duckdb_con, "inherited", output_path)

    columns = [
        r[0]
        for r in duckdb_con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{output_path}')"
        ).fetchall()
    ]
    assert sorted(columns) == ["bbox", "bbox_note", "geometry", "id"]
    xmax = duckdb_con.execute(
        f"SELECT bbox.xmax FROM read_parquet('{output_path}') WHERE id = 5"
    ).fetchone()
    assert xmax == (5.0,)
