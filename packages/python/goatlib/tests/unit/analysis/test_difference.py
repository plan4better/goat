"""Simple test for DifferenceTool to verify functionality."""

from pathlib import Path

import duckdb
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoprocessing.difference import DifferenceTool
from goatlib.analysis.schemas.geoprocessing import DifferenceParams
from goatlib.tools.difference import DifferenceToolParams, DifferenceToolRunner


def test_difference_polygons() -> None:
    """Test difference operation on polygon geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    polygons = str(test_data_dir / "overlay_polygons.parquet")
    boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_difference_polygons_minus_boundary.parquet")

    # Test basic difference
    params = DifferenceParams(
        input_path=polygons, overlay_path=boundary, output_path=output_path
    )

    tool = DifferenceTool()
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

    # Verify we have all original features (some modified, some unchanged)
    original_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{polygons}')"
    ).fetchone()[0]
    assert (
        row_count == original_count
    ), "Result should have same number of features as input"

    print(f"✓ DifferenceTool polygon test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")

    check_tool_style(
        DifferenceToolRunner,
        tool_params(DifferenceToolParams, params, input_layer_id=U, overlay_layer_id=U),
        result_path,
    )


def test_difference_lines() -> None:
    """Test difference operation on line geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    lines = str(test_data_dir / "overlay_lines.parquet")
    boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_difference_lines_minus_boundary.parquet")

    params = DifferenceParams(
        input_path=lines, overlay_path=boundary, output_path=output_path
    )

    tool = DifferenceTool()
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

    # Check that we have features (lines outside or partially outside boundary)
    original_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{lines}')"
    ).fetchone()[0]
    assert row_count > 0, "Result should have at least one line feature"
    assert (
        row_count <= original_count
    ), "Result should have equal or fewer features than input"

    print(
        f"✓ DifferenceTool line test passed. Result has {row_count} features (from {original_count} original)."
    )
    print(f"✓ Output saved to: {output_path}")


def test_difference_points() -> None:
    """Test difference operation on point geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points = str(test_data_dir / "overlay_points.parquet")
    boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_difference_points_minus_boundary.parquet")

    params = DifferenceParams(
        input_path=points, overlay_path=boundary, output_path=output_path
    )

    tool = DifferenceTool()
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

    # Points outside the boundary should remain
    original_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{points}')"
    ).fetchone()[0]
    assert row_count > 0, "Result should have at least one point outside boundary"
    assert (
        row_count < original_count
    ), "Result should have fewer points than input (some removed by difference)"

    print(
        f"✓ DifferenceTool point test passed. Result has {row_count} features (from {original_count} original, points outside boundary)."
    )
    print(f"✓ Output saved to: {output_path}")


if __name__ == "__main__":
    test_difference_polygons()
    test_difference_lines()
    test_difference_points()
    print("\n✅ All DifferenceTool tests passed!")
