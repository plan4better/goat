"""Integration tests for DissolveToolRunner.

Tests the complete DissolveToolRunner workflow with real PostgreSQL and DuckLake.
DissolveToolRunner is a single-layer input tool that merges features.

Run with:
    pytest tests/integration/tools/test_dissolve_runner.py -v
"""

import asyncio
from pathlib import Path

import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
from goatlib.tools.style_contract import assert_tool_style

from .conftest import TEST_FOLDER_ID, TEST_USER_ID, get_full_table_path

pytestmark = pytest.mark.integration


@pytest.mark.asyncio(loop_scope="session")
class TestDissolveToolRunner:
    """Integration tests for DissolveToolRunner."""

    @pytest.fixture
    def runner(self, tool_settings: ToolSettings) -> DissolveToolRunner:
        """Create a DissolveToolRunner with test settings."""
        runner = DissolveToolRunner()
        runner.init(tool_settings)
        return runner

    async def test_dissolves_polygons_by_field(
        self,
        runner: DissolveToolRunner,
        create_layer_from_parquet,
        create_test_layer_metadata,
        verify_output_layer,
        cleanup_output_layer,
        vector_data_dir: Path,
    ):
        """Test DissolveToolRunner merges polygons by dissolve field."""
        # Setup
        input_layer_id = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_polygons.parquet",
        )
        await create_test_layer_metadata(
            layer_id=input_layer_id,
            name="Input Polygons",
            geometry_type="polygon",
        )

        # Run dissolve (merge all into single geometry)
        params = DissolveToolParams(
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            input_layer_id=input_layer_id,
            dissolve_fields=None,  # Dissolve all into one
            result_layer_name="Dissolved Polygons",
        )
        result = await asyncio.to_thread(runner.run, params)

        # Verify
        output_layer_id = await verify_output_layer(
            result=result,
            expected_name="Dissolved Polygons",
            min_features=1,
        )
        # The tool's default style keeps the style contract on the saved table.
        assert_tool_style(
            runner, params, get_full_table_path(TEST_USER_ID, output_layer_id)
        )

        # Cleanup
        await cleanup_output_layer(output_layer_id)
