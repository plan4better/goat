"""Unit tests for MergeTool to verify functionality."""

from pathlib import Path

import duckdb
import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.data_management.merge import MergeTool
from goatlib.analysis.schemas.data_management import MergeInputLayer, MergeParams
from goatlib.tools.merge import MergeToolParams, MergeToolRunner


def _layers(*paths: str) -> list[MergeInputLayer]:
    return [MergeInputLayer(input_path=p) for p in paths]


def test_merge_two_point_layers() -> None:
    """Test basic merge of two point layers."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points_1 = str(test_data_dir / "merge_points_1.parquet")
    points_2 = str(test_data_dir / "merge_points_2.parquet")
    output_path = str(result_dir / "unit_merge_two_point_layers.parquet")

    params = MergeParams(
        input_paths=_layers(points_1, points_2),
        output_path=output_path,
    )

    tool = MergeTool()
    results = tool.run(params)

    assert len(results) == 1
    result_path, metadata = results[0]
    assert Path(result_path).exists()

    # Validate result
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
    ).fetchone()[0]
    assert row_count == 5, "Should have 5 features (3 + 2)"

    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{result_path}')"
    ).fetchall()
    column_names = [col[0] for col in columns]

    # Should have layer_source field
    assert "layer_source" in column_names

    # Check source values
    source_values = con.execute(
        f"SELECT DISTINCT layer_source FROM read_parquet('{result_path}') ORDER BY layer_source"
    ).fetchall()
    assert [v[0] for v in source_values] == [0, 1]

    # Same-name columns are merged into one (no _1/_2 suffixes)
    assert "id" in column_names
    assert "name" in column_names
    assert "id_1" not in column_names
    assert "name_1" not in column_names

    con.close()
    print(f"✓ Merge test passed. Result has {row_count} features.")

    check_tool_style(
        MergeToolRunner,
        tool_params(MergeToolParams, params, input_paths=_layers(U, U)),
        result_path,
    )


def test_merge_without_source_field() -> None:
    """Test merge without source tracking field."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points_1 = str(test_data_dir / "merge_points_1.parquet")
    points_2 = str(test_data_dir / "merge_points_2.parquet")
    output_path = str(result_dir / "unit_merge_no_source.parquet")

    params = MergeParams(
        input_paths=_layers(points_1, points_2),
        output_path=output_path,
        add_source_column=False,
    )

    tool = MergeTool()
    results = tool.run(params)

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    columns = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{results[0][0]}')"
    ).fetchall()
    column_names = [col[0] for col in columns]

    assert "layer_source" not in column_names
    con.close()
    print("✓ Merge without source field test passed.")


def test_merge_incompatible_geometries_raises_error() -> None:
    """Test that merging incompatible geometry types raises error."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points = str(test_data_dir / "merge_points_1.parquet")
    lines = str(test_data_dir / "merge_lines.parquet")
    output_path = str(result_dir / "unit_merge_should_fail.parquet")

    params = MergeParams(
        input_paths=_layers(points, lines),
        output_path=output_path,
        validate_geometry_types=True,
    )

    tool = MergeTool()

    with pytest.raises(ValueError, match="Incompatible geometry types"):
        tool.run(params)

    print("✓ Incompatible geometry validation test passed.")


def test_merge_incompatible_geometries_with_validation_disabled() -> None:
    """Test that validation can be disabled to allow mixed geometries."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    result_dir = Path(__file__).parent.parent.parent / "result"

    points = str(test_data_dir / "merge_points_1.parquet")
    lines = str(test_data_dir / "merge_lines.parquet")
    output_path = str(result_dir / "unit_merge_mixed_geoms.parquet")

    params = MergeParams(
        input_paths=_layers(points, lines),
        output_path=output_path,
        validate_geometry_types=False,
    )

    tool = MergeTool()
    results = tool.run(params)

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{results[0][0]}')"
    ).fetchone()[0]

    assert row_count == 5, "Should have 5 features (3 points + 2 lines)"
    con.close()
    print("✓ Mixed geometry merge test passed.")


def test_merge_less_than_two_layers_raises_error() -> None:
    """Test that merging less than 2 layers raises validation error."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"
    points = str(test_data_dir / "merge_points_1.parquet")

    with pytest.raises(Exception):  # Pydantic ValidationError
        MergeParams(input_paths=_layers(points))

    print("✓ Single layer validation test passed.")


def test_merge_with_auto_output_path() -> None:
    """Test that output path is auto-generated if not provided."""
    test_data_dir = Path(__file__).parent.parent.parent / "data" / "vector"

    points_1 = str(test_data_dir / "merge_points_1.parquet")
    points_2 = str(test_data_dir / "merge_points_2.parquet")

    params = MergeParams(
        input_paths=_layers(points_1, points_2),
    )

    tool = MergeTool()
    results = tool.run(params)

    output_file, metadata = results[0]
    assert output_file.exists()
    assert "_merged" in output_file.name

    # Clean up auto-generated file
    output_file.unlink()
    print("✓ Auto output path test passed.")
