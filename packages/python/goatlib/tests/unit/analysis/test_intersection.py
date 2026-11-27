"""Simple test for IntersectionTool to verify functionality."""

from pathlib import Path

import duckdb
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoprocessing.intersection import IntersectionTool
from goatlib.analysis.schemas.geoprocessing import IntersectionParams
from goatlib.tools.intersection import IntersectionToolParams, IntersectionToolRunner


def test_intersection_polygons() -> None:
    """Test intersection operation on polygon geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    polygons = str(test_data_dir / "overlay_polygons.parquet")
    boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_intersection_polygons_and_boundary.parquet")

    # Test basic intersection
    params = IntersectionParams(
        input_path=polygons, overlay_path=boundary, output_path=output_path
    )

    tool = IntersectionTool()
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

    # Check that geometry column exists
    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]
    assert "geometry" in column_names, "Result should have geometry column"

    # Check that we have attributes from both input and overlay
    # Overlay fields should have the prefix
    assert any(
        "intersection_" in col for col in column_names
    ), "Should have overlay attributes with intersection_ prefix"

    print(f"✓ IntersectionTool polygon test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")
    print(f"✓ Columns: {column_names}")

    check_tool_style(
        IntersectionToolRunner,
        tool_params(
            IntersectionToolParams, params, input_layer_id=U, overlay_layer_id=U
        ),
        result_path,
    )


def test_intersection_lines() -> None:
    """Test intersection operation on line geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    lines = str(test_data_dir / "overlay_lines.parquet")
    polygons = str(test_data_dir / "overlay_polygons.parquet")
    output_path = str(result_dir / "unit_intersection_lines_and_polygons.parquet")

    params = IntersectionParams(
        input_path=lines, overlay_path=polygons, output_path=output_path
    )

    tool = IntersectionTool()
    results = tool.run(params)

    # Check results
    assert len(results) == 1
    result_path, result_metadata = results[0]
    assert Path(result_path).exists()

    # Validate with DuckDB
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
    ).fetchone()[0]
    assert row_count > 0, "Result should have at least one line feature"

    # Check we have overlay attributes
    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]
    assert any(
        "intersection_" in col for col in column_names
    ), "Should have overlay attributes"

    print(f"✓ IntersectionTool line test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")


def test_intersection_points() -> None:
    """Test intersection operation on point geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points = str(test_data_dir / "overlay_points.parquet")
    polygons = str(test_data_dir / "overlay_polygons.parquet")
    output_path = str(result_dir / "unit_intersection_points_and_polygons.parquet")

    params = IntersectionParams(
        input_path=points, overlay_path=polygons, output_path=output_path
    )

    tool = IntersectionTool()
    results = tool.run(params)

    # Check results
    assert len(results) == 1
    result_path, result_metadata = results[0]
    assert Path(result_path).exists()

    # Validate with DuckDB
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
    ).fetchone()[0]

    # Check that we have points that intersect with polygons
    original_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{points}')"
    ).fetchone()[0]
    assert row_count <= original_count, "Result should have equal or fewer points"
    assert row_count > 0, "Result should have at least one point"

    # Check we have both input and overlay attributes
    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]
    assert any(
        "intersection_" in col for col in column_names
    ), "Should have overlay attributes"

    print(
        f"✓ IntersectionTool point test passed. Result has {row_count} features (from {original_count} original)."
    )
    print(f"✓ Output saved to: {output_path}")


if __name__ == "__main__":
    test_intersection_polygons()
    test_intersection_lines()
    test_intersection_points()
    print("\n✅ All IntersectionTool tests passed!")
