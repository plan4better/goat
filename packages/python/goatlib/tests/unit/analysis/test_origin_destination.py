from pathlib import Path

import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoanalysis import OriginDestinationTool
from goatlib.analysis.schemas.geoprocessing import OriginDestinationParams
from goatlib.tools.origin_destination import (
    OriginDestinationToolParams,
    OriginDestinationToolRunner,
)
from goatlib.tools.style_contract import Expectation

# Define paths to test data
# Root is 7 levels up from this file location in packages/python/goatlib/tests/unit/analysis/
# But we now use local test data in goatlib
TEST_DATA_DIR = Path(__file__).parents[2] / "data/vector"
GEOMETRY_PATH = TEST_DATA_DIR / "zipcode_point.parquet"
MATRIX_PATH = TEST_DATA_DIR / "origin_destination_matrix.parquet"

# Result directory
RESULT_DIR = Path(__file__).parents[2] / "result"


def test_origin_destination():
    """Test origin destination tool."""

    if not GEOMETRY_PATH.exists() or not MATRIX_PATH.exists():
        pytest.skip(f"Test data not found at {TEST_DATA_DIR}")

    # Ensure result directory exists
    RESULT_DIR.mkdir(exist_ok=True)

    output_lines = RESULT_DIR / "od_lines.parquet"
    output_points = RESULT_DIR / "od_points.parquet"

    # Clean up previous results
    if output_lines.exists():
        output_lines.unlink()
    if output_points.exists():
        output_points.unlink()

    params = OriginDestinationParams(
        geometry_path=str(GEOMETRY_PATH),
        matrix_path=str(MATRIX_PATH),
        unique_id_column="zipcode",
        origin_column="origin",
        destination_column="destination",
        weight_column="weight",
        output_path_lines=str(output_lines),
        output_path_points=str(output_points),
    )

    tool = OriginDestinationTool()
    results = tool.run(params)

    assert len(results) == 2
    assert output_lines.exists()
    assert output_points.exists()

    # Verify results using DuckDB
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    # Check lines
    lines_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{output_lines}')"
    ).fetchone()[0]
    assert lines_count > 0

    # Check points
    points_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{output_points}')"
    ).fetchone()[0]
    assert points_count > 0

    # Check schema
    lines_schema = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_lines}')"
    ).fetchall()
    columns = [col[0] for col in lines_schema]
    assert "geometry" in columns
    assert "origin" in columns
    assert "destination" in columns
    assert "weight" in columns

    points_schema = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{output_points}')"
    ).fetchall()
    columns = [col[0] for col in points_schema]
    assert "geometry" in columns
    assert "weight" in columns

    tool_params_od = tool_params(
        OriginDestinationToolParams,
        params,
        geometry_layer_id=U,
        matrix_layer_id=U,
    )
    check_tool_style(
        OriginDestinationToolRunner,
        tool_params_od,
        output_lines,
        expect=Expectation(field="weight"),
    )
    check_tool_style(
        OriginDestinationToolRunner,
        tool_params_od,
        output_points,
        document=OriginDestinationToolRunner().points_style(tool_params_od),
        expect=Expectation(field="weight"),
    )
