"""Integration tests for BufferToolRunner.

Tests the complete BufferToolRunner workflow with real PostgreSQL and DuckLake.

Unit tests for the buffer analysis logic itself are in tests/unit/analysis/test_buffer.py.

Run with:
    pytest tests/integration/tools/test_buffer_runner.py -v
"""

import asyncio
import uuid
from pathlib import Path

import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.buffer import BufferToolParams, BufferToolRunner
from goatlib.tools.style_contract import Expectation, assert_tool_style

from .conftest import (
    TEST_CUSTOMER_SCHEMA,
    TEST_FOLDER_ID,
    TEST_PROJECT_ID,
    TEST_USER_ID,
    get_full_table_path,
)

pytestmark = pytest.mark.integration


@pytest.mark.asyncio(loop_scope="session")
class TestBufferToolRunner:
    """Integration tests for BufferToolRunner."""

    @pytest.fixture
    def runner(self, tool_settings: ToolSettings) -> BufferToolRunner:
        """Create a BufferToolRunner with test settings."""
        runner = BufferToolRunner()
        runner.init(tool_settings)
        return runner

    async def test_creates_layer_in_ducklake_and_postgres(
        self,
        runner: BufferToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        verify_output_layer,
        cleanup_output_layer,
        vector_data_dir: Path,
    ):
        """Test BufferToolRunner creates output layer in DuckLake and PostgreSQL."""
        # Setup
        input_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=input_layer_id,
            name="Input Points",
            geometry_type="point",
        )

        # Run
        params = BufferToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            input_layer_id=input_layer_id,
            distances=[100.0],
            units="meters",
            dissolve=False,
            result_layer_name="Buffer Output",
        )
        result = await asyncio.to_thread(runner.run, params)

        # Verify
        output_layer_id = await verify_output_layer(
            result=result,
            expected_name="Buffer Output",
            min_features=1,
            expected_geometry_type="POLYGON",
        )
        # The tool's default style keeps the style contract on the saved table.
        assert_tool_style(
            runner,
            params,
            get_full_table_path(TEST_USER_ID, output_layer_id),
            expect=Expectation(field="buffer_distance", unit="m"),
        )

        # Cleanup
        await cleanup_output_layer(output_layer_id)

    async def test_links_layer_to_project(
        self,
        runner: BufferToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        cleanup_output_layer,
        vector_data_dir: Path,
        postgres_pool,
        test_project,
    ):
        """Test BufferToolRunner links output layer to project when project_id provided."""
        # Setup
        input_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_points.parquet",
        )
        await create_test_layer_metadata(
            layer_id=input_layer_id,
            name="Input Points",
            geometry_type="point",
        )

        # Run with project_id
        params = BufferToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            project_id=TEST_PROJECT_ID,
            input_layer_id=input_layer_id,
            distances=[100.0],
            units="meters",
            result_layer_name="Project Linked Output",
        )
        result = await asyncio.to_thread(runner.run, params)
        output_layer_id = result["layer_id"]

        # Verify layer_project link was created
        async with postgres_pool.acquire() as conn:
            link_row = await conn.fetchrow(
                f"""
                SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer_project
                WHERE layer_id = $1 AND project_id = $2
                """,
                uuid.UUID(output_layer_id),
                uuid.UUID(TEST_PROJECT_ID),
            )
            assert link_row is not None, "Layer should be linked to project"
            assert link_row["name"] == "Project Linked Output"

            project_row = await conn.fetchrow(
                f"SELECT layer_order FROM {TEST_CUSTOMER_SCHEMA}.project WHERE id = $1",
                uuid.UUID(TEST_PROJECT_ID),
            )
            assert project_row["layer_order"] is not None
            assert link_row["id"] in project_row["layer_order"]

        # Cleanup
        await cleanup_output_layer(
            output_layer_id,
            cleanup_project_link=True,
            project_id=TEST_PROJECT_ID,
        )
