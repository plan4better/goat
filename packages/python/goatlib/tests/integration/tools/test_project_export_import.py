"""Integration tests for project export/import round-trip.

Tests the full cycle:
1. Create a project with layers, a workflow, and a layer group
2. Export via ProjectExportRunner (real DuckLake + S3)
3. Verify the exported ZIP contents (manifest, parquet, workflow JSON)
4. Import via ProjectImportRunner (as a different user)
5. Verify the imported project in PG and DuckLake (including ID remapping)
6. Clean up all created resources

Note: These tests require running Docker containers (PostgreSQL, MinIO, DuckLake).
"""

import asyncio
import io
import json
import logging
import uuid
import zipfile
from typing import Any

import duckdb
import pytest
import pytest_asyncio
from goatlib.tools.base import ToolSettings
from goatlib.tools.project_export import ProjectExportParams, ProjectExportRunner
from goatlib.tools.project_import import ProjectImportParams, ProjectImportRunner
from goatlib.utils.layer import layer_schema_name

from .conftest import TEST_CUSTOMER_SCHEMA

logger = logging.getLogger(__name__)

pytestmark = pytest.mark.integration


# ============================================================================
# Fixtures
# ============================================================================


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def extended_test_schemas(postgres_pool: Any, test_schemas: None) -> None:
    """Add tables needed for project export/import tests.

    Creates: user_project, layer_project_group, workflow, report_layout.
    Also adds columns to existing tables that the import runner expects.
    """
    async with postgres_pool.acquire() as conn:
        # user_project
        await conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {TEST_CUSTOMER_SCHEMA}.user_project (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                project_id UUID NOT NULL
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                initial_view_state JSONB NOT NULL,
                UNIQUE(user_id, project_id)
            )
        """)

        # layer_project_group
        await conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {TEST_CUSTOMER_SCHEMA}.layer_project_group (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                "order" INTEGER NOT NULL DEFAULT 0,
                properties JSONB,
                project_id UUID NOT NULL
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                parent_id INTEGER
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.layer_project_group(id)
            )
        """)

        # Add layer_project_group_id FK to layer_project
        await conn.execute(f"""
            DO $$ BEGIN
                ALTER TABLE {TEST_CUSTOMER_SCHEMA}.layer_project
                ADD COLUMN IF NOT EXISTS layer_project_group_id INTEGER
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.layer_project_group(id);
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # Add missing columns to layer_project
        for col_name, col_type in [("query", "JSONB"), ("charts", "JSONB")]:
            await conn.execute(f"""
                DO $$ BEGIN
                    ALTER TABLE {TEST_CUSTOMER_SCHEMA}.layer_project
                    ADD COLUMN IF NOT EXISTS {col_name} {col_type};
                EXCEPTION WHEN others THEN NULL;
                END $$;
            """)

        # workflow
        await conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {TEST_CUSTOMER_SCHEMA}.workflow (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                is_default BOOLEAN DEFAULT FALSE,
                config JSONB,
                thumbnail_url TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # report_layout
        await conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {TEST_CUSTOMER_SCHEMA}.report_layout (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL
                    REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                is_default BOOLEAN DEFAULT FALSE,
                is_predefined BOOLEAN DEFAULT FALSE,
                config JSONB,
                thumbnail_url TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Add missing columns to project
        for col_def in [
            ("basemap", "TEXT"),
            ("custom_basemaps", "JSONB"),
            ("max_extent", "FLOAT[]"),
            ("builder_config", "JSONB"),
        ]:
            col_name, col_type = col_def
            await conn.execute(f"""
                DO $$ BEGIN
                    ALTER TABLE {TEST_CUSTOMER_SCHEMA}.project
                    ADD COLUMN IF NOT EXISTS {col_name} {col_type};
                EXCEPTION WHEN others THEN NULL;
                END $$;
            """)

        # Add missing columns to layer that the import needs
        layer_cols = [
            ("url", "TEXT"),
            ("field_config", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
        ]
        for col_name, col_type in layer_cols:
            await conn.execute(f"""
                DO $$ BEGIN
                    ALTER TABLE {TEST_CUSTOMER_SCHEMA}.layer
                    ADD COLUMN IF NOT EXISTS {col_name} {col_type};
                EXCEPTION WHEN others THEN NULL;
                END $$;
            """)

    logger.info("Extended test schemas created for project export/import tests")


@pytest.fixture
def export_runner(
    tool_settings: ToolSettings,
    ducklake_connection: duckdb.DuckDBPyConnection,
) -> ProjectExportRunner:
    """Create a ProjectExportRunner wired to the test DuckLake and S3."""
    runner = ProjectExportRunner()
    runner.settings = tool_settings
    runner._duckdb_con = ducklake_connection
    runner._s3_client = tool_settings.get_s3_client()
    return runner


def _create_import_duckdb_connection(
    tool_settings: ToolSettings,
) -> duckdb.DuckDBPyConnection:
    """Create a fresh DuckDB connection for the import runner.

    The import runner writes new tables, so it needs its own connection
    (not the shared session-scoped one used for reads).
    """
    con = duckdb.connect()

    for ext in ["spatial", "httpfs", "postgres", "ducklake"]:
        con.execute(f"INSTALL {ext}; LOAD {ext};")

    if tool_settings.s3_endpoint_url:
        con.execute(f"""
            SET s3_endpoint = '{tool_settings.s3_endpoint_url}';
            SET s3_access_key_id = '{tool_settings.s3_access_key_id or ""}';
            SET s3_secret_access_key = '{tool_settings.s3_secret_access_key or ""}';
            SET s3_url_style = 'path';
            SET s3_use_ssl = false;
        """)

    storage_path = tool_settings.ducklake_data_dir
    con.execute(f"""
        ATTACH 'ducklake:postgres:{tool_settings.ducklake_postgres_uri}' AS lake (
            DATA_PATH '{storage_path}',
            METADATA_SCHEMA '{tool_settings.ducklake_catalog_schema}',
            OVERRIDE_DATA_PATH true
        )
    """)

    return con


# ============================================================================
# Round-trip test
# ============================================================================


@pytest.mark.asyncio(loop_scope="session")
async def test_export_import_round_trip(
    export_runner: ProjectExportRunner,
    tool_settings: ToolSettings,
    ducklake_connection: duckdb.DuckDBPyConnection,
    postgres_pool: Any,
    test_user: dict[str, Any],
    test_folder: dict[str, Any],
    extended_test_schemas: None,
    create_test_layer_in_ducklake: Any,
    create_test_layer_metadata: Any,
) -> None:
    """Full round-trip: create project -> export -> verify ZIP -> import -> verify."""

    # ------------------------------------------------------------------
    # 1. Create project data
    # ------------------------------------------------------------------
    project_id = str(uuid.uuid4())
    layer_id_1 = str(uuid.uuid4())  # internal feature layer
    layer_id_2 = str(uuid.uuid4())  # external WMS layer (no DuckLake data)
    workflow_id = str(uuid.uuid4())
    group_id_str = str(uuid.uuid4())  # portable group ID for the archive

    user_id = test_user["id"]
    folder_id = test_folder["id"]

    # Insert project in PG
    async with postgres_pool.acquire() as conn:
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.project
                (id, user_id, folder_id, name, description, basemap)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            uuid.UUID(project_id),
            uuid.UUID(user_id),
            uuid.UUID(folder_id),
            "Test Export Project",
            "A project for testing export/import",
            "mapbox_streets",
        )

        # user_project
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.user_project
                (user_id, project_id, initial_view_state)
            VALUES ($1, $2, $3)
            """,
            uuid.UUID(user_id),
            uuid.UUID(project_id),
            json.dumps({"zoom": 10, "latitude": 48.1, "longitude": 11.5}),
        )

        # layer_project_group
        group_serial_id = await conn.fetchval(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer_project_group
                (name, "order", project_id)
            VALUES ($1, $2, $3)
            RETURNING id
            """,
            "Data Layers",
            0,
            uuid.UUID(project_id),
        )

    # Create internal DuckLake layer
    create_test_layer_in_ducklake(
        layer_id=layer_id_1,
        data=[
            {"id": 1, "name": "Munich", "geometry": "POINT(11.576 48.137)"},
            {"id": 2, "name": "Berlin", "geometry": "POINT(13.405 52.520)"},
            {"id": 3, "name": "Hamburg", "geometry": "POINT(9.993 53.551)"},
        ],
        geometry_type="POINT",
    )

    # Create layer metadata in PG (internal layer)
    await create_test_layer_metadata(
        layer_id=layer_id_1,
        name="German Cities",
        geometry_type="point",
        feature_layer_type="standard",
    )

    # A formula column on the internal layer: its definition lives in
    # customer.layer.field_config, so it only survives the round-trip if
    # both the export and the import carry that column.
    field_config = {
        "name_length": {
            "kind": "formula",
            "formula": "length(name)",
            "depends_on": ["name"],
            "is_computed": True,
            "output_kind": "number",
            "display_config": {"decimals": 0},
        }
    }

    # Create external layer metadata in PG (WMS, no DuckLake table)
    async with postgres_pool.acquire() as conn:
        await conn.execute(
            f"""
            UPDATE {TEST_CUSTOMER_SCHEMA}.layer
            SET field_config = $2::jsonb
            WHERE id = $1
            """,
            uuid.UUID(layer_id_1),
            json.dumps(field_config),
        )

        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer
                (id, user_id, folder_id, name, type, data_type, url)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            uuid.UUID(layer_id_2),
            uuid.UUID(user_id),
            uuid.UUID(folder_id),
            "External WMS",
            "feature",
            "wms",
            "https://example.com/wms?SERVICE=WMS",
        )

        # layer_project links for both layers
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer_project
                (layer_id, project_id, name, "order", layer_project_group_id)
            VALUES ($1, $2, $3, $4, $5)
            """,
            uuid.UUID(layer_id_1),
            uuid.UUID(project_id),
            "German Cities",
            0,
            group_serial_id,
        )
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer_project
                (layer_id, project_id, name, "order", layer_project_group_id)
            VALUES ($1, $2, $3, $4, $5)
            """,
            uuid.UUID(layer_id_2),
            uuid.UUID(project_id),
            "External WMS",
            1,
            group_serial_id,
        )

        # Workflow that references layer_id_1 in a dataset node
        workflow_config = {
            "nodes": [
                {
                    "id": "node-1",
                    "type": "dataset",
                    "data": {
                        "type": "dataset",
                        "layerId": layer_id_1,
                        "name": "German Cities",
                    },
                    "position": {"x": 100, "y": 100},
                },
                {
                    "id": "node-2",
                    "type": "buffer",
                    "data": {"type": "buffer", "distance": 500},
                    "position": {"x": 300, "y": 100},
                },
            ],
            "edges": [
                {
                    "id": "edge-1",
                    "source": "node-1",
                    "target": "node-2",
                }
            ],
        }
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.workflow
                (id, project_id, name, is_default, config)
            VALUES ($1, $2, $3, $4, $5)
            """,
            uuid.UUID(workflow_id),
            uuid.UUID(project_id),
            "Test Workflow",
            True,
            json.dumps(workflow_config),
        )

    # ------------------------------------------------------------------
    # 2. Build export params (simulating what gather_export_metadata produces)
    # ------------------------------------------------------------------
    export_params = ProjectExportParams(
        user_id=user_id,
        project_id=project_id,
        project_metadata={
            "name": "Test Export Project",
            "description": "A project for testing export/import",
            "basemap": "mapbox_streets",
            "initial_view_state": {"zoom": 10, "latitude": 48.1, "longitude": 11.5},
        },
        layers=[
            {
                "id": layer_id_1,
                "name": "German Cities",
                "type": "feature",
                "feature_layer_type": "standard",
                "feature_layer_geometry_type": "point",
                "user_id": user_id,
            },
            {
                "id": layer_id_2,
                "name": "External WMS",
                "type": "feature",
                "data_type": "wms",
                "url": "https://example.com/wms?SERVICE=WMS",
                "user_id": user_id,
            },
        ],
        layer_project_links={
            layer_id_1: {
                "name": "German Cities",
                "order": 0,
                "group_id": group_id_str,
            },
            layer_id_2: {
                "name": "External WMS",
                "order": 1,
                "group_id": group_id_str,
            },
        },
        layer_groups=[
            {
                "id": group_id_str,
                "name": "Data Layers",
                "order": 0,
            }
        ],
        workflows=[
            {
                "id": workflow_id,
                "name": "Test Workflow",
                "is_default": True,
                "config": workflow_config,
            }
        ],
        reports=[],
        assets=[],
        asset_s3_keys=[],
    )

    # ------------------------------------------------------------------
    # 3. Run export
    # ------------------------------------------------------------------
    export_result = await asyncio.to_thread(export_runner.run, export_params)

    # ------------------------------------------------------------------
    # 4. Verify export result
    # ------------------------------------------------------------------
    assert "s3_key" in export_result
    assert "presigned_url" in export_result
    assert export_result["file_size"] > 0

    export_s3_key = export_result["s3_key"]
    import_con: duckdb.DuckDBPyConnection | None = None

    try:
        # ------------------------------------------------------------------
        # 5. Download and inspect the ZIP
        # ------------------------------------------------------------------
        zip_bytes = io.BytesIO()
        s3 = tool_settings.get_s3_client()
        s3.download_fileobj(
            Bucket=tool_settings.s3_bucket_name,
            Key=export_s3_key,
            Fileobj=zip_bytes,
        )
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as zf:
            names = zf.namelist()

            # Core files
            assert "manifest.json" in names
            assert "project.json" in names
            assert "layer_groups.json" in names
            assert "layer_project_links.json" in names

            # Internal layer has data.parquet
            assert f"layers/{layer_id_1}/data.parquet" in names
            assert f"layers/{layer_id_1}/metadata.json" in names

            # External layer has metadata but no parquet
            assert f"layers/{layer_id_2}/metadata.json" in names
            assert f"layers/{layer_id_2}/data.parquet" not in names

            # Workflow
            assert f"workflows/{workflow_id}.json" in names

            # Manifest structure
            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["format_version"] == "1.2"
            assert manifest["project_name"] == "Test Export Project"
            assert manifest["layer_count"] == 2
            assert manifest["internal_layer_count"] == 1
            assert manifest["external_layer_count"] == 1
            assert manifest["workflow_count"] == 1

            # Project metadata
            project_json = json.loads(zf.read("project.json"))
            assert project_json["name"] == "Test Export Project"

            # Formula column definition travels with the layer metadata
            internal_meta = json.loads(zf.read(f"layers/{layer_id_1}/metadata.json"))
            assert internal_meta["field_config"] == field_config

            # Workflow config preserved
            wf_json = json.loads(zf.read(f"workflows/{workflow_id}.json"))
            assert wf_json["name"] == "Test Workflow"
            wf_nodes = wf_json["config"]["nodes"]
            dataset_node = next(
                n for n in wf_nodes if n["data"].get("layerId") == layer_id_1
            )
            assert dataset_node is not None

        # ------------------------------------------------------------------
        # 6. Upload the ZIP for import (simulate frontend upload)
        # ------------------------------------------------------------------
        import_s3_key = f"imports/test/{uuid.uuid4()}/import.zip"
        zip_bytes.seek(0)
        s3.put_object(
            Bucket=tool_settings.s3_bucket_name,
            Key=import_s3_key,
            Body=zip_bytes.read(),
        )

        # ------------------------------------------------------------------
        # 7. Create second test user for import
        # ------------------------------------------------------------------
        import_user_id = str(uuid.uuid4())
        async with postgres_pool.acquire() as conn:
            await conn.execute(
                f"""
                INSERT INTO {TEST_CUSTOMER_SCHEMA}.user (id, firstname, lastname, avatar)
                VALUES ($1, $2, $3, $4)
                """,
                uuid.UUID(import_user_id),
                "Import",
                "User",
                None,
            )

        # ------------------------------------------------------------------
        # 8. Run import (needs its own DuckDB connection for writes)
        # ------------------------------------------------------------------
        import_con = _create_import_duckdb_connection(tool_settings)

        import_runner = ProjectImportRunner()
        import_runner.settings = tool_settings
        import_runner._duckdb_con = import_con
        import_runner._s3_client = tool_settings.get_s3_client()

        import_params = ProjectImportParams(
            user_id=import_user_id,
            s3_key=import_s3_key,
            target_folder_id=folder_id,
        )
        import_result = await asyncio.to_thread(import_runner.run, import_params)

        # ------------------------------------------------------------------
        # 9. Verify import result
        # ------------------------------------------------------------------
        assert "project_id" in import_result
        assert import_result["project_name"] == "Test Export Project"
        assert import_result["layer_count"] == 2
        assert import_result["workflow_count"] == 1

        new_project_id = import_result["project_id"]

        # ------------------------------------------------------------------
        # 10. Verify imported data in PostgreSQL
        # ------------------------------------------------------------------
        async with postgres_pool.acquire() as conn:
            # Project
            row = await conn.fetchrow(
                f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.project WHERE id = $1",
                uuid.UUID(new_project_id),
            )
            assert row is not None, "Imported project should exist in PG"
            assert row["name"] == "Test Export Project"
            assert row["user_id"] == uuid.UUID(import_user_id)
            assert row["folder_id"] == uuid.UUID(folder_id)

            # user_project
            up_row = await conn.fetchrow(
                f"""
                SELECT * FROM {TEST_CUSTOMER_SCHEMA}.user_project
                WHERE project_id = $1 AND user_id = $2
                """,
                uuid.UUID(new_project_id),
                uuid.UUID(import_user_id),
            )
            assert up_row is not None, "user_project link should exist"

            # Layers (should be 2: one internal, one external)
            layers = await conn.fetch(
                f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE user_id = $1",
                uuid.UUID(import_user_id),
            )
            assert len(layers) == 2, f"Expected 2 imported layers, got {len(layers)}"

            layer_names = {r["name"] for r in layers}
            assert "German Cities" in layer_names
            assert "External WMS" in layer_names

            # The formula column definition is restored on the new layer row.
            imported_internal = next(r for r in layers if r["name"] == "German Cities")
            imported_field_config = imported_internal["field_config"]
            if isinstance(imported_field_config, str):
                imported_field_config = json.loads(imported_field_config)
            assert imported_field_config == field_config

            # layer_project links
            links = await conn.fetch(
                f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer_project WHERE project_id = $1",
                uuid.UUID(new_project_id),
            )
            assert len(links) == 2, f"Expected 2 layer_project links, got {len(links)}"

            # layer_project_group
            groups = await conn.fetch(
                f"""
                SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer_project_group
                WHERE project_id = $1
                """,
                uuid.UUID(new_project_id),
            )
            assert len(groups) == 1, "Should have one imported layer group"
            assert groups[0]["name"] == "Data Layers"

            # Workflow with remapped layer IDs
            workflows = await conn.fetch(
                f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.workflow WHERE project_id = $1",
                uuid.UUID(new_project_id),
            )
            assert len(workflows) == 1, "Should have one imported workflow"
            assert workflows[0]["name"] == "Test Workflow"

            wf_config_raw = workflows[0]["config"]
            wf_config = (
                json.loads(wf_config_raw)
                if isinstance(wf_config_raw, str)
                else wf_config_raw
            )
            dataset_nodes = [
                n
                for n in wf_config.get("nodes", [])
                if n.get("data", {}).get("layerId")
            ]
            for node in dataset_nodes:
                assert (
                    node["data"]["layerId"] != layer_id_1
                ), "Layer ID should be remapped to a new UUID, not the original"

        # ------------------------------------------------------------------
        # 11. Verify DuckLake data for the imported internal layer
        # ------------------------------------------------------------------
        internal_layer = next(r for r in layers if r["name"] == "German Cities")
        new_internal_id = str(internal_layer["id"])
        user_schema = layer_schema_name()
        table_name = f"t_{new_internal_id.replace('-', '')}"

        count = ducklake_connection.execute(
            f"SELECT COUNT(*) FROM lake.{user_schema}.{table_name}"
        ).fetchone()[0]
        assert count == 3, f"Imported layer should have 3 features, got {count}"

        # External layer should NOT have a DuckLake table
        external_layer = next(r for r in layers if r["name"] == "External WMS")
        new_external_id = str(external_layer["id"])
        ext_schema = layer_schema_name()
        ext_table = f"t_{new_external_id.replace('-', '')}"
        ext_exists = ducklake_connection.execute(
            f"""
            SELECT COUNT(*) FROM information_schema.tables
            WHERE table_catalog = 'lake'
            AND table_schema = '{ext_schema}'
            AND table_name = '{ext_table}'
            """
        ).fetchone()[0]
        assert ext_exists == 0, "External WMS layer should have no DuckLake table"

    finally:
        # ------------------------------------------------------------------
        # 12. Cleanup
        # ------------------------------------------------------------------

        # Clean up imported DuckLake tables
        try:
            imported_layers: list[Any] = []
            async with postgres_pool.acquire() as conn:
                imported_layers = await conn.fetch(
                    f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE user_id = $1",
                    uuid.UUID(import_user_id),
                )
            for layer_row in imported_layers:
                lid = str(layer_row["id"])
                tbl = f"lake.{layer_schema_name()}.t_{lid.replace('-', '')}"
                try:
                    ducklake_connection.execute(f"DROP TABLE IF EXISTS {tbl}")
                except Exception:
                    pass
        except Exception as exc:
            logger.warning("Failed to clean up imported DuckLake tables: %s", exc)

        # Clean up imported PG records (cascade from project handles most)
        try:
            async with postgres_pool.acquire() as conn:
                if "new_project_id" in dir():
                    for tbl in [
                        "layer_project",
                        "workflow",
                        "layer_project_group",
                        "user_project",
                    ]:
                        await conn.execute(
                            f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.{tbl} WHERE project_id = $1",
                            uuid.UUID(new_project_id),
                        )
                    await conn.execute(
                        f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.project WHERE id = $1",
                        uuid.UUID(new_project_id),
                    )
                    for layer_row in imported_layers:
                        await conn.execute(
                            f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE id = $1",
                            layer_row["id"],
                        )
        except Exception as exc:
            logger.warning("Failed to clean up imported PG records: %s", exc)

        # Clean up source project PG records
        try:
            async with postgres_pool.acquire() as conn:
                for tbl in [
                    "layer_project",
                    "workflow",
                    "layer_project_group",
                    "user_project",
                ]:
                    await conn.execute(
                        f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.{tbl} WHERE project_id = $1",
                        uuid.UUID(project_id),
                    )
                await conn.execute(
                    f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.project WHERE id = $1",
                    uuid.UUID(project_id),
                )
                # layer_id_1 is cleaned up by create_test_layer_in_ducklake fixture
                # but we still need to clean the PG metadata if present
                await conn.execute(
                    f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE id = $1",
                    uuid.UUID(layer_id_2),
                )
        except Exception as exc:
            logger.warning("Failed to clean up source PG records: %s", exc)

        # Clean up import user
        try:
            async with postgres_pool.acquire() as conn:
                await conn.execute(
                    f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.user WHERE id = $1",
                    uuid.UUID(import_user_id),
                )
        except Exception as exc:
            logger.warning("Failed to clean up import user: %s", exc)

        # Clean up S3 objects
        try:
            s3 = tool_settings.get_s3_client()
            s3.delete_object(
                Bucket=tool_settings.s3_bucket_name,
                Key=export_s3_key,
            )
        except Exception:
            pass
        try:
            s3.delete_object(
                Bucket=tool_settings.s3_bucket_name,
                Key=import_s3_key,
            )
        except Exception:
            pass

        # Close import DuckDB connection
        if import_con is not None:
            try:
                import_con.close()
            except Exception:
                pass
