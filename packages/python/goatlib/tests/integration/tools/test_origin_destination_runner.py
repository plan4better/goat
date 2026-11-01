"""Integration test for OriginDestinationToolRunner outside a workflow.

An origin-destination run saves two layers: the lines and the destination
points. Inside a workflow it writes only the lines, so the points layer is
saved only here, with real PostgreSQL and DuckLake. On a matrix whose rows
name no zone of the layer neither layer has rows, and each is saved as a
feature layer of its own geometry type.

Run on a throwaway database (see chains/conftest.py):
    POSTGRES_DB=goat_chains_test DUCKLAKE_DATA_DIR="$(mktemp -d)" uv run --no-sync --env-file ../../../.env pytest tests/integration/tools/test_origin_destination_runner.py -v
"""

import asyncio
import uuid
from typing import Any

import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.origin_destination import (
    OriginDestinationToolParams,
    OriginDestinationToolRunner,
)

from .conftest import (
    TEST_CUSTOMER_SCHEMA,
    TEST_FOLDER_ID,
    TEST_USER_ID,
    get_pg_connection,
)

pytestmark = pytest.mark.integration


def _run_in_thread(
    runner: OriginDestinationToolRunner, params: OriginDestinationToolParams
) -> dict[str, Any]:
    """The runner's `run()` drives its database calls on the thread's event
    loop, which a worker thread lacks until one is set."""
    asyncio.set_event_loop(asyncio.new_event_loop())
    return runner.run(params)


@pytest.mark.asyncio(loop_scope="session")
async def test_an_empty_run_saves_a_line_layer_and_a_point_layer(
    tool_settings: ToolSettings,
    create_test_layer_in_ducklake: Any,
    create_test_layer_metadata: Any,
    cleanup_output_layer: Any,
) -> None:
    zones_id = str(uuid.uuid4())
    matrix_id = str(uuid.uuid4())
    create_test_layer_in_ducklake(
        layer_id=zones_id,
        data=[
            {"zone": "a", "geometry": "POINT(11.5 48.1)"},
            {"zone": "b", "geometry": "POINT(11.6 48.2)"},
        ],
    )
    await create_test_layer_metadata(
        layer_id=zones_id, name="Zones", geometry_type="point"
    )
    create_test_layer_in_ducklake(
        layer_id=matrix_id,
        data=[{"origin": "x", "destination": "y", "weight": 3}],
    )
    runner = OriginDestinationToolRunner()
    runner.init(tool_settings)
    params = OriginDestinationToolParams(
        user_id=TEST_USER_ID,
        folder_id=TEST_FOLDER_ID,
        geometry_layer_id=zones_id,
        matrix_layer_id=matrix_id,
        unique_id_column="zone",
        origin_column="origin",
        destination_column="destination",
        weight_column="weight",
        lines_layer_name="Lines",
        points_layer_name="Points",
    )

    result = await asyncio.to_thread(_run_in_thread, runner, params)
    points = result["secondary_layers"][0]
    try:
        conn = await get_pg_connection(tool_settings)
        try:
            rows = {
                name: await conn.fetchrow(
                    f"SELECT type, feature_layer_geometry_type, properties "
                    f"FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE id = $1",
                    uuid.UUID(layer_id),
                )
                for name, layer_id in (
                    ("lines", result["layer_id"]),
                    ("points", points["layer_id"]),
                )
            }
        finally:
            await conn.close()

        assert (result["feature_count"], points["feature_count"]) == (0, 0)
        assert (
            rows["lines"]["type"],
            rows["lines"]["feature_layer_geometry_type"],
        ) == ("feature", "line")
        assert (
            rows["points"]["type"],
            rows["points"]["feature_layer_geometry_type"],
        ) == ("feature", "point")
        assert rows["points"]["properties"] is not None
    finally:
        await cleanup_output_layer(result["layer_id"])
        await cleanup_output_layer(points["layer_id"])
