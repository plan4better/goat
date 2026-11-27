"""Integration tests for AggregatePointsToolRunner.

Tests the complete AggregatePointsToolRunner workflow with real PostgreSQL and DuckLake,
specifically testing custom result column names.

Run with:
    pytest tests/integration/tools/test_aggregate_points_runner.py -v
"""

import asyncio
from pathlib import Path

import pytest
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.base import ToolSettings
from goatlib.tools.style_contract import Expectation, assert_tool_style

from .conftest import (
    TEST_FOLDER_ID,
    TEST_USER_ID,
    get_full_table_path,
)

pytestmark = pytest.mark.integration


@pytest.mark.asyncio(loop_scope="session")
class TestAggregatePointsToolRunner:
    """Integration tests for AggregatePointsToolRunner."""

    @pytest.fixture
    def runner(self, tool_settings: ToolSettings) -> AggregatePointsToolRunner:
        """Create an AggregatePointsToolRunner with test settings."""
        runner = AggregatePointsToolRunner()
        runner.init(tool_settings)
        return runner

    async def test_aggregate_with_custom_result_name_count(
        self,
        runner: AggregatePointsToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        cleanup_output_layer,
        ducklake_connection,
        vector_data_dir: Path,
    ):
        """Test aggregate points with count operation and custom result_name."""
        # Setup - create input layer
        input_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=input_layer_id,
            name="Input Points",
            geometry_type="point",
        )

        # Run with count operation and custom result_name (single dict, like frontend sends)
        params = AggregatePointsToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            source_layer_id=input_layer_id,
            area_type="h3_grid",
            h3_resolution=8,
            column_statistics={
                "operation": "count",
                "result_name": "my_point_count",
            },
            result_layer_name="Aggregate Count Output",
        )
        result = await asyncio.to_thread(runner.run, params)

        # Verify result structure
        assert "layer_id" in result, "Result should contain layer_id"
        output_layer_id = result["layer_id"]

        # Get the output table and check columns directly
        output_table = get_full_table_path(TEST_USER_ID, output_layer_id)

        # Verify output has features
        count_result = ducklake_connection.execute(
            f"SELECT COUNT(*) FROM {output_table}"
        ).fetchone()
        assert (
            count_result[0] >= 1
        ), f"Expected at least 1 feature, got {count_result[0]}"

        # Verify the custom column name exists in the output
        columns_result = ducklake_connection.execute(
            f"DESCRIBE {output_table}"
        ).fetchall()
        column_names = [col[0] for col in columns_result]

        # Check custom column name is present
        assert (
            "my_point_count" in column_names
        ), f"Custom column 'my_point_count' not found. Columns: {column_names}"
        # Default 'count' column should NOT be present
        assert (
            "count" not in column_names
        ), f"Default column 'count' should not exist when custom name is set. Columns: {column_names}"

        # The tool's default style keeps the style contract on the saved table
        # (one point per cell: one value, drawn in one color).
        assert_tool_style(runner, params, output_table)

        # Cleanup
        await cleanup_output_layer(output_layer_id)

    async def test_aggregate_with_custom_result_name_sum(
        self,
        runner: AggregatePointsToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        cleanup_output_layer,
        ducklake_connection,
        vector_data_dir: Path,
    ):
        """Test aggregate points with sum operation and custom result_name."""
        # Setup - create input layer with numeric field
        input_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=input_layer_id,
            name="Input Points",
            geometry_type="point",
        )

        # Run with sum operation and custom result_name (single dict)
        # Use 'capacity' field which is a BIGINT column in overlay_points.parquet
        params = AggregatePointsToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            source_layer_id=input_layer_id,
            area_type="h3_grid",
            h3_resolution=8,
            column_statistics={
                "operation": "sum",
                "field": "capacity",
                "result_name": "total_capacity",
            },
            result_layer_name="Aggregate Sum Output",
        )
        result = await asyncio.to_thread(runner.run, params)

        # Verify result structure
        assert "layer_id" in result, "Result should contain layer_id"
        output_layer_id = result["layer_id"]

        # Get the output table and check columns directly
        output_table = get_full_table_path(TEST_USER_ID, output_layer_id)

        # Verify output has features
        count_result = ducklake_connection.execute(
            f"SELECT COUNT(*) FROM {output_table}"
        ).fetchone()
        assert (
            count_result[0] >= 1
        ), f"Expected at least 1 feature, got {count_result[0]}"

        # Verify the custom column name exists in the output
        columns_result = ducklake_connection.execute(
            f"DESCRIBE {output_table}"
        ).fetchall()
        column_names = [col[0] for col in columns_result]

        # Check custom column name is present
        assert (
            "total_capacity" in column_names
        ), f"Custom column 'total_capacity' not found. Columns: {column_names}"
        # Default 'capacity_sum' column should NOT be present
        assert (
            "capacity_sum" not in column_names
        ), f"Default column 'capacity_sum' should not exist when custom name is set. Columns: {column_names}"

        # The tool's default style keeps the style contract on the saved table.
        assert_tool_style(
            runner,
            params,
            output_table,
            expect=Expectation(field="total_capacity"),
        )

        # Cleanup
        await cleanup_output_layer(output_layer_id)
