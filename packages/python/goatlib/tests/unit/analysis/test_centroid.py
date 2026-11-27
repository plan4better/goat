"""Simple test for CentroidTool to verify functionality."""

from pathlib import Path

import duckdb
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoprocessing.centroid import CentroidTool
from goatlib.analysis.schemas.geoprocessing import CentroidParams
from goatlib.tools.centroid import CentroidToolParams, CentroidToolRunner


def test_centroid_polygons() -> None:
    """Test computing centroid of polygon geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    # Ensure result directory exists
    result_dir.mkdir(parents=True, exist_ok=True)

    polygons = str(test_data_dir / "overlay_polygons.parquet")
    output_path = str(result_dir / "unit_centroid_polygons.parquet")

    # Test basic centroid
    params = CentroidParams(input_path=polygons, output_path=output_path)

    tool = CentroidTool()
    results = tool.run(params)

    # Check that we got results
    assert len(results) == 1
    result_path, result_metadata = results[0]

    # Check that output file was created
    assert Path(result_path).exists()

    # Validate the result using DuckDB
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    # Check that we can read the result and it has data
    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
    ).fetchone()[0]
    assert row_count > 0, "Result should have at least one feature"

    # Check that geometry column exists and is of type POINT
    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]
    assert "geometry" in column_names, "Result should have geometry column"

    # Check geometry type
    geom_type = con.execute(f"""
        SELECT ST_GeometryType(geometry)
        FROM read_parquet('{result_path}')
        LIMIT 1
    """).fetchone()[0]

    assert (
        "POINT" in geom_type.upper()
    ), f"Geometry type should be POINT, got {geom_type}"

    print(f"✓ CentroidTool polygon test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")

    check_tool_style(
        CentroidToolRunner,
        tool_params(CentroidToolParams, params, input_layer_id=U),
        result_path,
    )


def test_centroid_multipoints() -> None:
    """Test computing centroid of multipoint geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    # Ensure result directory exists
    result_dir.mkdir(parents=True, exist_ok=True)

    multipoints = str(test_data_dir / "multipoint.parquet")
    output_path = str(result_dir / "unit_centroid_multipoints.parquet")

    # Test basic centroid
    params = CentroidParams(input_path=multipoints, output_path=output_path)

    tool = CentroidTool()
    results = tool.run(params)

    # Check that we got results
    assert len(results) == 1
    result_path, result_metadata = results[0]

    # Check that output file was created
    assert Path(result_path).exists()

    # Validate the result using DuckDB
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    # Check that we can read the result and it has data
    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
    ).fetchone()[0]
    assert row_count == 2, "Result should have 2 features"

    # Check that geometry column exists and is of type POINT
    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]
    assert "geometry" in column_names, "Result should have geometry column"

    # Check geometry type
    geom_type = con.execute(f"""
        SELECT ST_GeometryType(geometry)
        FROM read_parquet('{result_path}')
        LIMIT 1
    """).fetchone()[0]

    assert (
        "POINT" in geom_type.upper()
    ), f"Geometry type should be POINT, got {geom_type}"

    # Verify centroid coordinates for the first feature (0 0, 10 10) -> (5 5)
    coords1 = con.execute(f"""
        SELECT ST_X(geometry), ST_Y(geometry)
        FROM read_parquet('{result_path}')
        WHERE id = 1
    """).fetchone()

    assert coords1[0] == 5.0
    assert coords1[1] == 5.0

    # Verify centroid coordinates for the second feature (0 0, 0 10, 10 0, 10 10) -> (5 5)
    coords2 = con.execute(f"""
        SELECT ST_X(geometry), ST_Y(geometry)
        FROM read_parquet('{result_path}')
        WHERE id = 2
    """).fetchone()

    assert coords2[0] == 5.0
    assert coords2[1] == 5.0

    # Confirm they are at the same location
    assert coords1 == coords2

    print(f"✓ CentroidTool multipoint test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")
