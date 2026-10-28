"""goatlib's writers give every layer they create style rows (spec 10): a
dataset default, and an active "Default" for every project layer."""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import asyncpg
import pytest
from goatlib.catalog import promote as promote_module
from goatlib.style.fingerprint import advance_data_snapshots_sql
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.base import ToolSettings
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.finalize_layer import FinalizeLayerRunner
from goatlib.tools.layer_copy import insert_copy_layer

from .conftest import (
    TEST_CUSTOMER_SCHEMA,
    TEST_FOLDER_ID,
    TEST_PROJECT_ID,
    TEST_USER_ID,
)

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]

S = TEST_CUSTOMER_SCHEMA
RED = {"version": 1, "kind": "vector", "symbol": {"marker": {"color": "#aa0000"}}}


async def default_of(pool: asyncpg.Pool, layer_id: str) -> list[Any]:
    rows = await pool.fetch(
        f"SELECT name, document FROM {S}.layer_style WHERE layer_id = $1",
        uuid.UUID(layer_id),
    )
    return [(r["name"], json.loads(r["document"])) for r in rows]


async def active_of(pool: asyncpg.Pool, link_id: int) -> Any:
    return await pool.fetchrow(
        f"""
        SELECT s.name, s.position, s.revision, s.document,
               (SELECT count(*) FROM {S}.layer_style_revision r
                WHERE r.style_id = s.id) AS revisions
        FROM {S}.layer_project lp JOIN {S}.layer_style s ON s.id = lp.active_style_id
        WHERE lp.id = $1 AND s.layer_project_id = lp.id
        """,
        link_id,
    )


async def new_layer(
    db: ToolDatabaseService, *, layer_type: str = "feature", **kwargs: Any
) -> tuple[str, dict[str, Any] | None]:
    layer_id = str(uuid.uuid4())
    doc = await db.create_layer(
        layer_id=layer_id,
        user_id=TEST_USER_ID,
        folder_id=TEST_FOLDER_ID,
        name="Points",
        layer_type=layer_type,
        feature_layer_type="tool" if layer_type == "feature" else None,
        geometry_type="POINT" if layer_type == "feature" else None,
        **kwargs,
    )
    return layer_id, doc


async def test_every_created_dataset_has_one_default_row_and_every_link_one_active_default(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
) -> None:
    layer_id, doc = await new_layer(db_service)
    assert doc is not None and doc["symbol"]["marker"]
    assert await default_of(postgres_pool, layer_id) == [("Default", doc)]
    link_id = await db_service.add_to_project(
        layer_id=layer_id, project_id=TEST_PROJECT_ID, name="Points"
    )
    active = await active_of(postgres_pool, link_id)
    assert (active["name"], active["position"], active["revision"]) == ("Default", 0, 1)
    assert active["revisions"] == 1
    assert json.loads(active["document"]) == doc


async def test_a_given_style_becomes_the_default_and_a_table_gets_none(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
) -> None:
    layer_id, doc = await new_layer(db_service, style=RED, data_snapshot=42)
    assert doc == RED and await default_of(postgres_pool, layer_id) == [
        ("Default", RED)
    ]
    snapshot = await postgres_pool.fetchval(
        f"SELECT data_snapshot FROM {S}.layer WHERE id = $1", uuid.UUID(layer_id)
    )
    assert snapshot == 42
    table_id, table_doc = await new_layer(db_service, layer_type="table")
    assert table_doc is None and await default_of(postgres_pool, table_id) == []
    link_id = await db_service.add_to_project(
        layer_id=table_id, project_id=TEST_PROJECT_ID, name="Table"
    )
    assert await active_of(postgres_pool, link_id) is None


async def test_an_overwrites_bare_link_gets_a_style(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
    tool_settings: Any,
) -> None:
    layer_id, doc = await new_layer(db_service)
    runner = FinalizeLayerRunner()
    runner.settings = tool_settings
    link_id = await runner._get_or_create_project_link(
        layer_id=layer_id, project_id=TEST_PROJECT_ID, name="Result"
    )
    active = await active_of(postgres_pool, link_id)
    assert active is not None and json.loads(active["document"]) == doc


async def test_a_filtered_copy_takes_the_source_links_active_style(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
) -> None:
    layer_id, _ = await new_layer(db_service)
    link_id = await db_service.add_to_project(
        layer_id=layer_id, project_id=TEST_PROJECT_ID, name="Points"
    )
    await postgres_pool.execute(
        f"""
        WITH s AS (
            INSERT INTO {S}.layer_style (layer_project_id, name, position, document)
            VALUES ($1, 'Red', 1, $2::jsonb) RETURNING id
        )
        UPDATE {S}.layer_project SET active_style_id = (SELECT id FROM s) WHERE id = $1
        """,
        link_id,
        json.dumps(RED),
    )
    got = await db_service.get_active_style(link_id, layer_id, TEST_USER_ID)
    assert got == RED
    stranger = str(uuid.uuid4())
    assert await db_service.get_active_style(link_id, layer_id, stranger) is None
    other_layer = str(uuid.uuid4())
    assert await db_service.get_active_style(link_id, other_layer, TEST_USER_ID) is None


async def test_a_layer_copy_carries_the_sources_default(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
) -> None:
    source_id, _ = await new_layer(db_service, style=RED)
    copy_id = str(uuid.uuid4())
    async with postgres_pool.acquire() as conn, conn.transaction():
        await insert_copy_layer(
            conn,
            S,
            source_layer_id=source_id,
            layer_id=copy_id,
            user_id=TEST_USER_ID,
            folder_id=TEST_FOLDER_ID,
            space_id=None,
            other_properties={},
            copy_content=True,
            extent_wkt=None,
            size=0,
            job_id=None,
        )
    assert await default_of(postgres_pool, copy_id) == [("Default", RED)]


async def test_a_tool_result_gets_its_computed_style_stamped_with_its_snapshot(
    postgres_pool: asyncpg.Pool,
    test_project: dict[str, Any],
    tool_settings: ToolSettings,
    create_layer_from_parquet: Any,
    create_test_layer_metadata: Any,
    cleanup_output_layer: Any,
    vector_data_dir: Path,
) -> None:
    """Its first map load finds nothing stale: the computed classes name the
    snapshot that wrote the table, which is the layer's data_snapshot."""
    source_id = create_layer_from_parquet(
        parquet_path=vector_data_dir / "overlay_points.parquet"
    )
    await create_test_layer_metadata(
        layer_id=source_id, name="Points", geometry_type="point"
    )
    runner = AggregatePointsToolRunner()
    runner.init(tool_settings)
    params = AggregatePointsToolParams(
        user_id=TEST_USER_ID,
        folder_id=TEST_FOLDER_ID,
        project_id=TEST_PROJECT_ID,
        source_layer_id=source_id,
        area_type="h3_grid",
        h3_resolution=8,
        column_statistics={"operation": "count"},
        result_layer_name="Counts",
    )
    result = await asyncio.to_thread(runner.run, params)
    layer_id = result["layer_id"]
    try:
        snapshot = await postgres_pool.fetchval(
            f"SELECT data_snapshot FROM {S}.layer WHERE id = $1", uuid.UUID(layer_id)
        )
        [(name, doc)] = await default_of(postgres_pool, layer_id)
        [c] = doc["classify"]
        assert snapshot is not None
        assert c["computed"]["data"] == f"ducklake:{snapshot}"
        # The tracker, catching up over the whole change log, agrees.
        await postgres_pool.execute(
            advance_data_snapshots_sql(S, tool_settings.ducklake_catalog_schema)
        )
        assert snapshot == await postgres_pool.fetchval(
            f"SELECT data_snapshot FROM {S}.layer WHERE id = $1", uuid.UUID(layer_id)
        )
        assert c["field"] == "count" and c["classes"]
        active = await active_of(postgres_pool, result["layer_project_id"])
        assert json.loads(active["document"]) == doc
    finally:
        await cleanup_output_layer(layer_id)


async def test_promotion_writes_a_default_row_from_a_version_0_and_a_version_1_asset(
    postgres_pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    v0 = {"color": [0, 170, 0], "filled": True, "opacity": 0.5}
    assets = {"styles/v0.json": v0, "styles/v1.json": RED}
    monkeypatch.setattr(
        promote_module,
        "_read_catalog_object",
        lambda key: json.dumps(assets[key]).encode(),
    )
    docs = {}
    for name in ("v0", "v1"):
        item = {
            "id": f"src:{name}",
            "version": "2024",
            "title": name,
            "goat:geometryType": "point",
            "assets": {"style": {"href": f"../../../styles/{name}.json"}},
        }
        async with postgres_pool.acquire() as conn:
            out = await promote_module.promote(
                conn, item["id"], mirror_items_path="unused", schema=S, item=item
            )
        [(default_name, docs[name])] = await default_of(postgres_pool, out["layer_id"])
        assert default_name == "Default"
    assert docs["v0"]["version"] == 1
    assert docs["v0"]["symbol"]["marker"]["color"] == "#00aa00"
    assert docs["v1"] == RED
