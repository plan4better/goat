"""Simple test for ClipTool to verify functionality."""

from pathlib import Path

import duckdb
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoprocessing.clip import ClipTool
from goatlib.analysis.schemas.geoprocessing import ClipParams
from goatlib.tools.clip import ClipToolParams, ClipToolRunner


def test_clip_polygons() -> None:
    """Test clipping polygon geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    polygons = str(test_data_dir / "overlay_polygons.parquet")
    clip_boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_clip_polygons_by_boundary.parquet")

    # Test basic clipping
    params = ClipParams(
        input_path=polygons, overlay_path=clip_boundary, output_path=output_path
    )

    tool = ClipTool()
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

    print(f"✓ ClipTool polygon test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")

    check_tool_style(
        ClipToolRunner,
        tool_params(ClipToolParams, params, input_layer_id=U, overlay_layer_id=U),
        result_path,
    )


def test_clip_lines() -> None:
    """Test clipping line geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    lines = str(test_data_dir / "overlay_lines.parquet")
    clip_boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_clip_lines_by_boundary.parquet")

    params = ClipParams(
        input_path=lines, overlay_path=clip_boundary, output_path=output_path
    )

    tool = ClipTool()
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

    print(f"✓ ClipTool line test passed. Result has {row_count} features.")
    print(f"✓ Output saved to: {output_path}")


def test_clip_points() -> None:
    """Test clipping point geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points = str(test_data_dir / "overlay_points.parquet")
    clip_boundary = str(test_data_dir / "overlay_boundary.parquet")
    output_path = str(result_dir / "unit_clip_points_by_boundary.parquet")

    params = ClipParams(
        input_path=points, overlay_path=clip_boundary, output_path=output_path
    )

    tool = ClipTool()
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

    # Check that we have fewer or equal points (only those within boundary)
    original_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{points}')"
    ).fetchone()[0]
    assert row_count <= original_count, "Result should have equal or fewer points"
    assert row_count > 0, "Result should have at least one point"

    print(
        f"✓ ClipTool point test passed. Result has {row_count} features (from {original_count} original)."
    )
    print(f"✓ Output saved to: {output_path}")


if __name__ == "__main__":
    test_clip_polygons()
    test_clip_lines()
    test_clip_points()
    print("\n✅ All ClipTool tests passed!")
