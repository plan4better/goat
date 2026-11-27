"""Integration tests for JoinToolRunner.

Tests the complete JoinToolRunner workflow with real PostgreSQL and DuckLake,
specifically testing custom result column names for field statistics.

Run with:
    pytest tests/integration/tools/test_join_runner.py -v
"""

import asyncio
from pathlib import Path

import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.join import (
    JoinToolParams,
    JoinToolRunner,
)
from goatlib.tools.style_contract import Expectation, assert_tool_style

from .conftest import (
    TEST_FOLDER_ID,
    TEST_USER_ID,
    get_full_table_path,
)

pytestmark = pytest.mark.integration


@pytest.mark.asyncio(loop_scope="session")
class TestJoinToolRunner:
    """Integration tests for JoinToolRunner."""

    @pytest.fixture
    def runner(self, tool_settings: ToolSettings) -> JoinToolRunner:
        """Create a JoinToolRunner with test settings."""
        runner = JoinToolRunner()
        runner.init(tool_settings)
        return runner

    async def test_join_with_custom_result_name_sum(
        self,
        runner: JoinToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        cleanup_output_layer,
        ducklake_connection,
        vector_data_dir: Path,
    ):
        """Test join with sum statistics and custom result_name."""
        # Setup - create target layer (polygons)
        target_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_polygons.parquet",
        )
        await create_test_layer_metadata(
            layer_id=target_layer_id,
            name="Target Polygons",
            geometry_type="polygon",
        )

        # Setup - create join layer (points with numeric capacity field)
        join_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=join_layer_id,
            name="Join Points",
            geometry_type="point",
        )

        # Run spatial join with sum statistics and custom result_name
        # Frontend sends column_statistics as a single dict
        params = JoinToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            target_layer_id=target_layer_id,
            join_layer_id=join_layer_id,
            use_spatial_relationship=True,
            use_attribute_relationship=False,
            spatial_relationship="intersects",
            join_type="left",
            join_operation="one_to_one",
            calculate_statistics=True,
            column_statistics={
                "operation": "sum",
                "field": "capacity",
                "result_name": "total_capacity",
            },
            result_layer_name="Join Sum Output",
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
        # Default name should NOT be present (would be capacity_sum)
        assert "capacity_sum" not in column_names, (
            f"Default column 'capacity_sum' should not exist when custom name is set. "
            f"Columns: {column_names}"
        )

        # The tool's default style keeps the style contract on the saved table.
        assert_tool_style(
            runner,
            params,
            output_table,
            expect=Expectation(field="total_capacity"),
        )

        # Cleanup
        await cleanup_output_layer(output_layer_id)

    async def test_join_with_custom_result_name_count(
        self,
        runner: JoinToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        cleanup_output_layer,
        ducklake_connection,
        vector_data_dir: Path,
    ):
        """Test join with count statistics and custom result_name."""
        # Setup - create target layer (polygons)
        target_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_polygons.parquet",
        )
        await create_test_layer_metadata(
            layer_id=target_layer_id,
            name="Target Polygons",
            geometry_type="polygon",
        )

        # Setup - create join layer (points)
        join_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=join_layer_id,
            name="Join Points",
            geometry_type="point",
        )

        # Run spatial join with count statistics and custom result_name
        params = JoinToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            target_layer_id=target_layer_id,
            join_layer_id=join_layer_id,
            use_spatial_relationship=True,
            use_attribute_relationship=False,
            spatial_relationship="intersects",
            join_type="left",
            join_operation="one_to_one",
            calculate_statistics=True,
            column_statistics={
                "operation": "count",
                "result_name": "matched_points",
            },
            result_layer_name="Join Count Output",
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
            "matched_points" in column_names
        ), f"Custom column 'matched_points' not found. Columns: {column_names}"
        # Default name should NOT be present
        assert "count" not in column_names, (
            f"Default column 'count' should not exist when custom name is set. "
            f"Columns: {column_names}"
        )

        # The tool's default style keeps the style contract on the saved table.
        assert_tool_style(
            runner,
            params,
            output_table,
            expect=Expectation(field="matched_points"),
        )

        # Cleanup
        await cleanup_output_layer(output_layer_id)
