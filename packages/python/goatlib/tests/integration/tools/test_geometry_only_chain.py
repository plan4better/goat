"""A dissolve without group fields feeding an overlay tool.

The dissolved layer holds a geometry and no attribute column; a workflow passes
it straight to intersection or union with a second layer. Runs both runners on
real DuckLake layers, as a workflow's steps do.
"""

import asyncio
from pathlib import Path
from typing import Any

import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
from goatlib.tools.intersection import IntersectionToolParams, IntersectionToolRunner
from goatlib.tools.union import UnionToolParams, UnionToolRunner

from .conftest import TEST_FOLDER_ID, TEST_USER_ID, get_full_table_path

pytestmark = pytest.mark.integration


def _runner(cls: type, tool_settings: ToolSettings) -> Any:
    runner = cls()
    runner.init(tool_settings)
    return runner


def _columns(ducklake_connection: Any, layer_id: str) -> list[str]:
    rows = ducklake_connection.execute(
        f"DESCRIBE {get_full_table_path(TEST_USER_ID, layer_id)}"
    ).fetchall()
    return [
        name for name, data_type, *_ in rows if not str(data_type).startswith("STRUCT")
    ]


@pytest.mark.asyncio(loop_scope="session")
class TestGeometryOnlyChain:
    @pytest.fixture
    async def layers(
        self,
        tool_settings: ToolSettings,
        create_layer_from_parquet: Any,
        create_test_layer_metadata: Any,
        verify_output_layer: Any,
        cleanup_output_layer: Any,
        vector_data_dir: Path,
    ) -> Any:
        polygons = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_polygons.parquet"
        )
        await create_test_layer_metadata(
            layer_id=polygons, name="Polygons", geometry_type="polygon"
        )
        districts = create_layer_from_parquet(
            parquet_path=vector_data_dir / "overlay_boundary.parquet"
        )
        await create_test_layer_metadata(
            layer_id=districts, name="Districts", geometry_type="polygon"
        )
        result = await asyncio.to_thread(
            _runner(DissolveToolRunner, tool_settings).run,
            DissolveToolParams(
                user_id=TEST_USER_ID,
                folder_id=TEST_FOLDER_ID,
                input_layer_id=polygons,
                result_layer_name="Dissolved",
            ),
        )
        dissolved = await verify_output_layer(
            result=result, expected_name="Dissolved", min_features=1
        )
        yield dissolved, districts
        await cleanup_output_layer(dissolved)

    async def test_intersect_the_dissolved_layer(
        self,
        layers: Any,
        tool_settings: ToolSettings,
        ducklake_connection: Any,
        verify_output_layer: Any,
        cleanup_output_layer: Any,
    ) -> None:
        dissolved, districts = layers
        assert _columns(ducklake_connection, dissolved) == ["geometry"]
        result = await asyncio.to_thread(
            _runner(IntersectionToolRunner, tool_settings).run,
            IntersectionToolParams(
                user_id=TEST_USER_ID,
                folder_id=TEST_FOLDER_ID,
                input_layer_id=dissolved,
                overlay_layer_id=districts,
                overlay_fields=["boundary_id", "boundary_name"],
                overlay_fields_prefix="bezirk_",
                result_layer_name="Per district",
            ),
        )
        output = await verify_output_layer(
            result=result, expected_name="Per district", min_features=1
        )
        try:
            assert {"bezirk_boundary_id", "bezirk_boundary_name", "geometry"} <= set(
                _columns(ducklake_connection, output)
            )
        finally:
            await cleanup_output_layer(output)

    async def test_union_the_dissolved_layer(
        self,
        layers: Any,
        tool_settings: ToolSettings,
        ducklake_connection: Any,
        verify_output_layer: Any,
        cleanup_output_layer: Any,
    ) -> None:
        dissolved, districts = layers
        result = await asyncio.to_thread(
            _runner(UnionToolRunner, tool_settings).run,
            UnionToolParams(
                user_id=TEST_USER_ID,
                folder_id=TEST_FOLDER_ID,
                input_layer_id=dissolved,
                overlay_layer_id=districts,
                overlay_fields_prefix="b_",
                result_layer_name="Union",
            ),
        )
        output = await verify_output_layer(
            result=result, expected_name="Union", min_features=1
        )
        try:
            assert {"b_boundary_id", "b_boundary_name", "geometry"} <= set(
                _columns(ducklake_connection, output)
            )
        finally:
            await cleanup_output_layer(output)
