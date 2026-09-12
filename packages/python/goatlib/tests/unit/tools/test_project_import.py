"""Unit tests for ProjectImport tool.

Tests the project import functionality including:
- Parameter validation
- Manifest validation
- Checksum verification
- ID mapping generation
- Workflow/report config remapping
- Cleanup on failure
- Full import run
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools.project_import import (
    ImportCleanupTracker,
    ProjectImportParams,
    ProjectImportRunner,
)
from goatlib.tools.project_schemas import ExportManifest


class TestProjectImportParams:
    """Test parameter validation."""

    def test_valid_params(self) -> None:
        """Basic param construction works."""
        params = ProjectImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            s3_key="imports/test.zip",
            target_folder_id="00000000-0000-0000-0000-ffffffffffff",
        )
        assert params.user_id == "00000000-0000-0000-0000-000000000001"
        assert params.s3_key == "imports/test.zip"
        assert params.target_folder_id == "00000000-0000-0000-0000-ffffffffffff"


class TestProjectImportRunner:
    """Test the runner logic with mocks."""

    @pytest.fixture()
    def mock_settings(self) -> MagicMock:
        """Create mock settings."""
        settings = MagicMock()
        settings.customer_schema = "customer"
        settings.s3_bucket_name = "test-bucket"
        settings.max_upload_dataset_file_size = 5 * 1024 * 1024 * 1024
        settings.s3_endpoint_url = "http://localhost:9000"
        settings.s3_provider = "minio"
        settings.s3_region_name = "us-east-1"
        settings.s3_access_key_id = "minioadmin"
        settings.s3_secret_access_key = "minioadmin"
        settings.ducklake_postgres_uri = "postgresql://localhost/test"
        settings.ducklake_catalog_schema = "ducklake"
        settings.ducklake_data_dir = "/tmp/ducklake"
        settings.postgres_server = "localhost"
        settings.postgres_port = 5432
        settings.postgres_user = "postgres"
        settings.postgres_password = "postgres"
        settings.postgres_db = "test"
        return settings

    @pytest.fixture()
    def runner(self, mock_settings: MagicMock) -> ProjectImportRunner:
        """Create runner with mocked settings."""
        runner = ProjectImportRunner()
        runner.settings = mock_settings
        runner._duckdb_con = MagicMock()
        runner._s3_client = MagicMock()
        runner._s3_client.head_object.return_value = {"ContentLength": 1}
        return runner

    def test_validate_manifest_valid(self, runner: ProjectImportRunner) -> None:
        """Valid manifest passes validation."""
        manifest_data = {
            "format_version": "1.0",
            "exported_at": "2025-01-01T00:00:00Z",
            "project_name": "Test",
            "layer_count": 1,
            "internal_layer_count": 1,
            "external_layer_count": 0,
        }
        manifest = runner._validate_manifest(manifest_data)
        assert manifest.format_version == "1.0"
        assert manifest.project_name == "Test"

    def test_validate_manifest_incompatible_version(
        self, runner: ProjectImportRunner
    ) -> None:
        """Major version mismatch raises ValueError."""
        manifest_data = {
            "format_version": "2.0",
            "exported_at": "2025-01-01T00:00:00Z",
            "project_name": "Test",
        }
        with pytest.raises(ValueError, match="Incompatible format version"):
            runner._validate_manifest(manifest_data)

    def test_verify_checksums_valid(self, runner: ProjectImportRunner) -> None:
        """Matching checksums pass without error."""
        with tempfile.TemporaryDirectory() as tmp:
            archive_dir = Path(tmp)
            test_file = archive_dir / "project.json"
            test_file.write_text('{"name": "test"}')

            h = hashlib.sha256(test_file.read_bytes()).hexdigest()
            manifest = ExportManifest(
                format_version="1.0",
                exported_at="2025-01-01T00:00:00Z",
                project_name="Test",
                checksums={"project.json": f"sha256:{h}"},
            )

            # Should not raise
            runner._verify_checksums(manifest, archive_dir)

    def test_verify_checksums_mismatch(self, runner: ProjectImportRunner) -> None:
        """Mismatched checksum raises ValueError."""
        with tempfile.TemporaryDirectory() as tmp:
            archive_dir = Path(tmp)
            test_file = archive_dir / "project.json"
            test_file.write_text('{"name": "test"}')

            manifest = ExportManifest(
                format_version="1.0",
                exported_at="2025-01-01T00:00:00Z",
                project_name="Test",
                checksums={"project.json": "sha256:0000000000000000"},
            )

            with pytest.raises(ValueError, match="Checksum mismatch"):
                runner._verify_checksums(manifest, archive_dir)

    def test_generate_id_mapping(self, runner: ProjectImportRunner) -> None:
        """Creates new UUIDs for all entities."""
        with tempfile.TemporaryDirectory() as tmp:
            archive_dir = Path(tmp)

            # Create layers/index.json
            layers_dir = archive_dir / "layers"
            layers_dir.mkdir()
            index = {
                "layers": [
                    {"id": "layer-1", "name": "L1", "type": "feature"},
                    {"id": "layer-2", "name": "L2", "type": "feature"},
                ]
            }
            (layers_dir / "index.json").write_text(json.dumps(index))

            # Create layer_groups.json
            groups = {
                "groups": [
                    {"id": "group-1", "name": "G1", "order": 0},
                ]
            }
            (archive_dir / "layer_groups.json").write_text(json.dumps(groups))

            # Create workflows
            wf_dir = archive_dir / "workflows"
            wf_dir.mkdir()
            wf = {
                "id": "wf-1",
                "name": "Workflow 1",
                "config": {"nodes": [], "edges": []},
            }
            (wf_dir / "wf-1.json").write_text(json.dumps(wf))

            # Create reports
            rpt_dir = archive_dir / "reports"
            rpt_dir.mkdir()
            rpt = {
                "id": "rpt-1",
                "name": "Report 1",
                "config": {"sections": []},
            }
            (rpt_dir / "rpt-1.json").write_text(json.dumps(rpt))

            id_map = runner._generate_id_mapping(archive_dir)

        assert "layer-1" in id_map
        assert "layer-2" in id_map
        assert "group-1" in id_map
        assert "wf-1" in id_map
        assert "rpt-1" in id_map
        # All new IDs should be unique
        new_ids = list(id_map.values())
        assert len(new_ids) == len(set(new_ids))
        # New IDs should differ from old
        for old, new in id_map.items():
            assert old != new

    def test_remap_workflow_config(self, runner: ProjectImportRunner) -> None:
        """Remaps layerId in dataset nodes, clears export state."""
        id_map = {"old-layer-id": "new-layer-id"}
        config = {
            "nodes": [
                {
                    "id": "n1",
                    "data": {
                        "type": "dataset",
                        "layerId": "old-layer-id",
                        "exportedLayerId": "some-export-id",
                        "jobId": "job-123",
                        "status": "completed",
                    },
                },
                {
                    "id": "n2",
                    "data": {
                        "type": "tool",
                        "processId": "buffer",
                    },
                },
            ],
            "edges": [{"source": "n1", "target": "n2"}],
        }

        result = runner._remap_workflow_config(config, id_map)

        # Layer ID remapped
        assert result["nodes"][0]["data"]["layerId"] == "new-layer-id"
        # Export state cleared
        assert result["nodes"][0]["data"]["exportedLayerId"] is None
        assert result["nodes"][0]["data"]["jobId"] is None
        assert result["nodes"][0]["data"]["status"] is None
        # Non-dataset node untouched
        assert result["nodes"][1]["data"]["processId"] == "buffer"
        # Original not mutated
        assert config["nodes"][0]["data"]["layerId"] == "old-layer-id"

    def test_remap_layer_other_properties_workflow_export(
        self, runner: ProjectImportRunner
    ) -> None:
        """Workflow_export stamp's workflow_id is remapped via id_map.

        Layers persisted by a 'Save as Dataset' node carry a stamp that
        the overwrite-on-rerun lookup matches against. The workflow row
        gets a new UUID on import, so the stamp must follow.
        """
        old_wf = "old-workflow-id"
        new_wf = "new-workflow-id"
        id_map = {old_wf: new_wf}
        other_properties = {
            "workflow_export": {
                "workflow_id": old_wf,
                "export_node_id": "n_export_1",
            }
        }

        result = runner._remap_layer_other_properties(other_properties, id_map)

        assert result is not None
        assert result["workflow_export"]["workflow_id"] == new_wf
        assert result["workflow_export"]["export_node_id"] == "n_export_1"
        # Original not mutated
        assert other_properties["workflow_export"]["workflow_id"] == old_wf

    def test_remap_layer_other_properties_handles_missing_stamp(
        self, runner: ProjectImportRunner
    ) -> None:
        """Layers without a workflow_export stamp pass through untouched."""
        assert runner._remap_layer_other_properties(None, {}) is None
        assert runner._remap_layer_other_properties({}, {}) == {}
        assert runner._remap_layer_other_properties({"foo": "bar"}, {"x": "y"}) == {
            "foo": "bar"
        }

    def test_remap_layer_other_properties_orphan_workflow(
        self, runner: ProjectImportRunner
    ) -> None:
        """Stamp pointing to a workflow not in id_map is left as-is.

        Happens when the layer is exported but its source workflow was
        excluded. Better to leave the stale stamp than guess.
        """
        other_properties = {
            "workflow_export": {
                "workflow_id": "orphan-wf",
                "export_node_id": "n1",
            }
        }
        result = runner._remap_layer_other_properties(other_properties, {})
        assert result == other_properties

    def test_remap_report_config(self, runner: ProjectImportRunner) -> None:
        """Replaces old UUIDs with new in config JSON."""
        old_uuid_1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        new_uuid_1 = "11111111-2222-3333-4444-555555555555"
        old_uuid_2 = "f0e1d2c3-b4a5-9687-fedc-ba0987654321"
        new_uuid_2 = "66666666-7777-8888-9999-aaaaaaaaaaaa"
        id_map = {
            old_uuid_1: new_uuid_1,
            old_uuid_2: new_uuid_2,
        }
        config = {
            "sections": [
                {"layerId": old_uuid_1, "title": "Section 1"},
                {"layerId": old_uuid_2, "title": "Section 2"},
            ]
        }

        result = runner._remap_report_config(config, id_map)

        assert result["sections"][0]["layerId"] == new_uuid_1
        assert result["sections"][1]["layerId"] == new_uuid_2

    def test_remap_builder_config_remaps_group_icon_keys(
        self, runner: ProjectImportRunner
    ) -> None:
        """Group IDs embedded in widget config keys must be remapped.

        Regression: `group_icon_<old_group_id>` keys and `group_info` keys
        survived import unchanged, so after import they pointed at group IDs
        from the source project that no longer exist. Result: custom group
        icons silently fell back to the generic LAYERS icon, and group_info
        descriptions appeared on no group.
        """
        lp_id_map: dict[int, int] = {}
        group_id_map: dict[int, int] = {220: 69, 222: 71, 223: 68, 227: 70}

        config = {
            "interface": [
                {
                    "widgets": [
                        {
                            "config": {
                                "type": "layers",
                                "setup": {
                                    "title": "",
                                    "group_info": {
                                        "220": "Parking description",
                                        "227": "Charging description",
                                        "999": "Stale description",
                                    },
                                },
                                "options": {
                                    "group_icon_110": {"url": "stale.svg"},
                                    "group_icon_220": {"url": "parking.svg"},
                                    "group_icon_222": {"url": "road.svg"},
                                    "group_icon_223": {"url": "warn.svg"},
                                    "group_icon_227": {"url": "ev.svg"},
                                },
                            }
                        }
                    ]
                }
            ]
        }

        result = runner._remap_builder_config(config, lp_id_map, group_id_map)

        widget = result["interface"][0]["widgets"][0]["config"]
        opts = widget["options"]
        info = widget["setup"]["group_info"]

        # Known groups get remapped to their new IDs.
        assert opts["group_icon_69"] == {"url": "parking.svg"}, opts
        assert opts["group_icon_71"] == {"url": "road.svg"}, opts
        assert opts["group_icon_68"] == {"url": "warn.svg"}, opts
        assert opts["group_icon_70"] == {"url": "ev.svg"}, opts

        # Stale keys (no mapping) are left untouched so the operation is
        # lossless — frontend will silently ignore them, same as before.
        assert opts["group_icon_110"] == {"url": "stale.svg"}, opts

        # Old keys must NOT linger after remap.
        for old_gid in group_id_map:
            assert (
                f"group_icon_{old_gid}" not in opts
            ), f"group_icon_{old_gid} should have been renamed: {opts}"

        # group_info: known keys remapped, unknown left as-is.
        assert info["69"] == "Parking description", info
        assert info["70"] == "Charging description", info
        assert info["999"] == "Stale description", info
        assert "220" not in info, info
        assert "227" not in info, info

    def test_remap_basemap_layer_config_remaps_targets(
        self, runner: ProjectImportRunner
    ) -> None:
        """Vector-basemap layer_config targets must be remapped to new link IDs.

        Regression: custom_basemaps were dropped entirely on export/import, and
        once restored their per-layer `target` still pointed at source-project
        layer_project link IDs. A non-"all" target must be rewritten via the
        link map; an unmapped target falls back to "all"; "all" is preserved.
        Solid basemaps (no layer_config) pass through untouched.
        """
        lp_id_map: dict[int, int] = {66: 201, 67: 202}
        custom_basemaps = [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "type": "vector",
                "name": "Streets",
                "layer_config": {
                    "roads": {"visible": True, "relation": "below", "target": "66"},
                    "labels": {"visible": True, "relation": "above", "target": "all"},
                    "orphan": {"visible": True, "relation": "below", "target": "999"},
                },
            },
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "type": "solid",
                "name": "Grey",
                "color": "#cccccc",
            },
        ]

        result = runner._remap_basemap_layer_config(custom_basemaps, lp_id_map)

        cfg = result[0]["layer_config"]
        assert cfg["roads"]["target"] == "201", cfg
        assert cfg["labels"]["target"] == "all", cfg
        # Unmapped non-"all" target falls back to "all".
        assert cfg["orphan"]["target"] == "all", cfg
        # Non-target settings preserved.
        assert cfg["roads"]["relation"] == "below"
        # Solid basemap (no layer_config) untouched.
        assert result[1] == custom_basemaps[1]

    def test_export_project_metadata_preserves_custom_basemaps(self) -> None:
        """project.json contract must carry custom_basemaps end-to-end.

        Regression: ExportProjectMetadata had no custom_basemaps field and
        `extra="ignore"` silently dropped it, so imported projects always got
        an empty basemap library even when the archive contained one.
        """
        from goatlib.tools.project_schemas import ExportProjectMetadata

        basemaps = [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "type": "raster",
                "name": "Aerial",
                "url": "https://tiles.example.com/{z}/{x}/{y}.png",
            }
        ]
        meta = ExportProjectMetadata.model_validate(
            {"name": "P", "custom_basemaps": basemaps}
        )
        assert meta.custom_basemaps == basemaps

    def test_cleanup_on_failure(self, runner: ProjectImportRunner) -> None:
        """DuckLake tables dropped, S3 objects deleted."""
        tracker = ImportCleanupTracker()
        tracker.ducklake_tables = [
            "lake.user_abc.t_layer1",
            "lake.user_abc.t_layer2",
        ]
        tracker.s3_keys = ["assets/user/file1.png", "assets/user/file2.png"]

        runner._cleanup_on_failure(tracker)

        # Verify DuckDB DROP TABLE calls
        drop_calls = [
            c
            for c in runner._duckdb_con.execute.call_args_list
            if "DROP TABLE" in str(c)
        ]
        assert len(drop_calls) == 2

        # Verify S3 delete_object calls
        assert runner._s3_client.delete_object.call_count == 2
        runner._s3_client.delete_object.assert_any_call(
            Bucket="test-bucket", Key="assets/user/file1.png"
        )
        runner._s3_client.delete_object.assert_any_call(
            Bucket="test-bucket", Key="assets/user/file2.png"
        )

    def test_run_full_import(self, runner: ProjectImportRunner) -> None:
        """Full import run with a real ZIP file."""
        user_id = "00000000-0000-0000-0000-000000000001"
        folder_id = "00000000-0000-0000-0000-ffffffffffff"
        layer_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

        # Build a real ZIP file matching the export format
        with tempfile.TemporaryDirectory() as build_dir:
            zip_path = Path(build_dir) / "export.zip"

            # Prepare archive contents
            project_data = {"name": "Imported Project", "description": "test"}
            layer_meta = {
                "id": layer_id,
                "name": "Test Layer",
                "type": "feature",
                "data_type": None,
            }
            layer_index = {"layers": [layer_meta]}
            layer_link = {"name": "Test Layer", "order": 0}
            layer_groups = {
                "groups": [
                    {"id": "grp-1", "name": "Group A", "order": 0},
                ]
            }
            workflow = {
                "id": "wf-1",
                "name": "Test WF",
                "config": {
                    "nodes": [
                        {
                            "id": "n1",
                            "data": {
                                "type": "dataset",
                                "layerId": layer_id,
                            },
                        }
                    ],
                    "edges": [],
                },
            }

            # Compute checksums
            checksums: dict[str, str] = {}

            def _checksum(data: bytes) -> str:
                return f"sha256:{hashlib.sha256(data).hexdigest()}"

            project_bytes = json.dumps(project_data, indent=2).encode()
            checksums["project.json"] = _checksum(project_bytes)

            index_bytes = json.dumps(layer_index, indent=2).encode()
            checksums["layers/index.json"] = _checksum(index_bytes)

            meta_bytes = json.dumps(layer_meta, indent=2).encode()
            checksums[f"layers/{layer_id}/metadata.json"] = _checksum(meta_bytes)

            link_bytes = json.dumps(layer_link, indent=2).encode()
            checksums[f"layers/{layer_id}/project_link.json"] = _checksum(link_bytes)

            groups_bytes = json.dumps(layer_groups, indent=2).encode()
            checksums["layer_groups.json"] = _checksum(groups_bytes)

            wf_bytes = json.dumps(workflow, indent=2).encode()
            checksums["workflows/wf-1.json"] = _checksum(wf_bytes)

            manifest = {
                "format_version": "1.0",
                "exported_at": "2025-06-01T00:00:00Z",
                "project_name": "Imported Project",
                "checksums": checksums,
                "layer_count": 1,
                "internal_layer_count": 1,
                "external_layer_count": 0,
                "workflow_count": 1,
                "report_count": 0,
            }

            # Create the ZIP
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("project.json", project_bytes)
                zf.writestr("layers/index.json", index_bytes)
                zf.writestr(f"layers/{layer_id}/metadata.json", meta_bytes)
                zf.writestr(f"layers/{layer_id}/project_link.json", link_bytes)
                # Create a dummy parquet file for the internal layer
                zf.writestr(f"layers/{layer_id}/data.parquet", b"FAKE_PARQUET")
                zf.writestr("layer_groups.json", groups_bytes)
                zf.writestr("workflows/wf-1.json", wf_bytes)
                zf.writestr(
                    "manifest.json",
                    json.dumps(manifest, indent=2).encode(),
                )

            zip_bytes = zip_path.read_bytes()

        params = ProjectImportParams(
            user_id=user_id,
            s3_key="imports/test-export.zip",
            target_folder_id=folder_id,
        )

        # Mock S3 download_file to copy our test ZIP
        def mock_download_file(**kwargs: object) -> None:
            dest = str(kwargs["Filename"])
            Path(dest).write_bytes(zip_bytes)

        runner._s3_client.download_file.side_effect = mock_download_file

        # Mock DuckDB for layer import
        mock_con = runner._duckdb_con
        mock_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        # Mock asyncpg connection
        mock_asyncpg_conn = AsyncMock()
        # For RETURNING id on group insert (fetchval)
        mock_asyncpg_conn.fetchval.return_value = 1
        mock_asyncpg_conn.set_type_codec = AsyncMock()
        # transaction() must return an async context manager (not a coroutine)
        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=mock_txn)
        mock_txn.__aexit__ = AsyncMock(return_value=False)
        mock_asyncpg_conn.transaction = MagicMock(return_value=mock_txn)

        # Track execute calls for assertion
        execute_calls_log: list[str] = []
        original_execute = mock_asyncpg_conn.execute

        async def tracking_execute(query: str, *args: object) -> None:
            execute_calls_log.append(query)
            return await original_execute(query, *args)

        mock_asyncpg_conn.execute = AsyncMock(side_effect=tracking_execute)

        async def tracking_fetchval(query: str, *args: object) -> int:
            execute_calls_log.append(query)
            return 1

        mock_asyncpg_conn.fetchval = AsyncMock(side_effect=tracking_fetchval)

        with patch("goatlib.tools.project_import.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=mock_asyncpg_conn)
            result = runner.run(params)

        # Verify output structure
        assert "project_id" in result
        assert result["project_name"] == "Imported Project"
        assert result["layer_count"] == 1
        assert result["workflow_count"] == 1
        assert result["report_count"] == 0

        # Verify DuckLake table creation was attempted
        # Should have CREATE SCHEMA and CREATE TABLE calls
        duckdb_calls = [str(c) for c in mock_con.execute.call_args_list]
        create_schema_calls = [c for c in duckdb_calls if "CREATE SCHEMA" in c]
        create_table_calls = [
            c for c in duckdb_calls if "CREATE TABLE" in c and "lake." in c
        ]
        assert len(create_schema_calls) >= 1
        assert len(create_table_calls) >= 1

        # Verify PostgreSQL INSERT statements were executed via asyncpg
        insert_calls = [q for q in execute_calls_log if "INSERT" in q]
        # Should have inserts for: project, user_project, layer_project_group,
        # layer, layer_project, workflow
        assert len(insert_calls) >= 5

        # Verify S3 download was called (ZIP fetch)
        runner._s3_client.download_file.assert_called_once()
        dl_kwargs = runner._s3_client.download_file.call_args.kwargs
        assert dl_kwargs["Bucket"] == "test-bucket"
        assert dl_kwargs["Key"] == "imports/test-export.zip"
        assert isinstance(dl_kwargs["Filename"], str)

    def test_import_preserves_link_group_membership(
        self, runner: ProjectImportRunner
    ) -> None:
        """A 1.1 archive carrying `layer_project_group_id` per link must
        produce layer_project rows with that group remapped to the new
        serial id — not NULL.

        Regression: ExportLayerProjectLinkEntry had no field for
        `layer_project_group_id`, and `extra="ignore"` silently dropped it
        during validation, so every imported link ended up with NULL group.
        """
        user_id = "00000000-0000-0000-0000-000000000001"
        folder_id = "00000000-0000-0000-0000-ffffffffffff"
        layer_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

        with tempfile.TemporaryDirectory() as build_dir:
            zip_path = Path(build_dir) / "export.zip"

            project_data = {"name": "Grouped Project"}
            layer_meta = {
                "id": layer_id,
                "name": "Charging",
                "type": "feature",
                "data_type": None,
            }
            layer_index = {"layers": [layer_meta]}
            layer_groups = {
                "groups": [{"id": 76, "name": "Laden", "order": 0, "parent_id": None}]
            }
            # Two links to the same layer, both attached to group 76 in the
            # source. The import must remap 76 -> new serial and stamp it on
            # both links.
            links_payload = {
                "links": [
                    {
                        "id": 575,
                        "layer_id": layer_id,
                        "layer_project_group_id": 76,
                        "name": "Locations",
                        "order": 0,
                    },
                    {
                        "id": 576,
                        "layer_id": layer_id,
                        "layer_project_group_id": 76,
                        "name": "Status",
                        "order": 1,
                    },
                ]
            }

            def _cs(b: bytes) -> str:
                return f"sha256:{hashlib.sha256(b).hexdigest()}"

            checksums: dict[str, str] = {}
            project_bytes = json.dumps(project_data, indent=2).encode()
            checksums["project.json"] = _cs(project_bytes)
            index_bytes = json.dumps(layer_index, indent=2).encode()
            checksums["layers/index.json"] = _cs(index_bytes)
            meta_bytes = json.dumps(layer_meta, indent=2).encode()
            checksums[f"layers/{layer_id}/metadata.json"] = _cs(meta_bytes)
            groups_bytes = json.dumps(layer_groups, indent=2).encode()
            checksums["layer_groups.json"] = _cs(groups_bytes)
            links_bytes = json.dumps(links_payload, indent=2).encode()
            checksums["layer_project_links.json"] = _cs(links_bytes)

            manifest = {
                "format_version": "1.1",
                "exported_at": "2025-06-01T00:00:00Z",
                "project_name": "Grouped Project",
                "checksums": checksums,
                "layer_count": 1,
                "internal_layer_count": 1,
                "external_layer_count": 0,
                "workflow_count": 0,
                "report_count": 0,
            }

            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("project.json", project_bytes)
                zf.writestr("layers/index.json", index_bytes)
                zf.writestr(f"layers/{layer_id}/metadata.json", meta_bytes)
                zf.writestr(f"layers/{layer_id}/data.parquet", b"FAKE_PARQUET")
                zf.writestr("layer_groups.json", groups_bytes)
                zf.writestr("layer_project_links.json", links_bytes)
                zf.writestr("manifest.json", json.dumps(manifest, indent=2).encode())

            zip_bytes = zip_path.read_bytes()

        params = ProjectImportParams(
            user_id=user_id,
            s3_key="imports/grouped.zip",
            target_folder_id=folder_id,
        )

        def mock_download_file(**kwargs: object) -> None:
            Path(str(kwargs["Filename"])).write_bytes(zip_bytes)

        runner._s3_client.download_file.side_effect = mock_download_file
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        # Capture the parameters passed to layer_project inserts.
        lp_insert_args: list[tuple[object, ...]] = []
        next_serial = [1000]
        # First fetchval call is the layer_project_group insert -> returns
        # a deterministic new serial we can assert against later.
        new_group_serial = 9000

        mock_asyncpg_conn = AsyncMock()
        mock_asyncpg_conn.set_type_codec = AsyncMock()
        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=mock_txn)
        mock_txn.__aexit__ = AsyncMock(return_value=False)
        mock_asyncpg_conn.transaction = MagicMock(return_value=mock_txn)
        mock_asyncpg_conn.execute = AsyncMock(return_value=None)

        async def tracking_fetchval(query: str, *args: object) -> int:
            if "INSERT INTO customer.layer_project_group" in query:
                return new_group_serial
            if "INSERT INTO customer.layer_project\n" in query:
                lp_insert_args.append(args)
                next_serial[0] += 1
                return next_serial[0]
            return next_serial[0]

        mock_asyncpg_conn.fetchval = AsyncMock(side_effect=tracking_fetchval)

        with patch("goatlib.tools.project_import.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=mock_asyncpg_conn)
            runner.run(params)

        # Layer_project insert signature (see _insert_pg_records):
        # (layer_uuid, project_uuid, name, order, properties,
        #  other_properties, query, charts, group_serial)
        assert (
            len(lp_insert_args) == 2
        ), f"Expected 2 layer_project inserts, got {len(lp_insert_args)}"
        for args in lp_insert_args:
            group_serial = args[8]
            assert group_serial == new_group_serial, (
                f"Link must be assigned to remapped group {new_group_serial},"
                f" got {group_serial!r}. Full args: {args}"
            )

    def test_import_restores_field_config(self, runner: ProjectImportRunner) -> None:
        """An archive carrying `field_config` restores it on the new layer row.

        Regression: formula columns (and the other computed kinds) live in
        `customer.layer.field_config`. The importer's layer INSERT omitted
        the column, so imported layers lost their formulas and the values
        stopped being recomputed on edit.
        """
        user_id = "00000000-0000-0000-0000-000000000001"
        folder_id = "00000000-0000-0000-0000-ffffffffffff"
        layer_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

        field_config = {
            "risk_score": {
                "kind": "formula",
                "formula": "(CASE WHEN broken THEN 1 ELSE 0 END) * 3000",
                "depends_on": ["broken"],
                "is_computed": True,
                "output_kind": "number",
                "display_config": {"decimals": 2},
            }
        }

        with tempfile.TemporaryDirectory() as build_dir:
            zip_path = Path(build_dir) / "export.zip"

            project_data = {"name": "Formula Project"}
            layer_meta = {
                "id": layer_id,
                "name": "Stops",
                "type": "feature",
                "data_type": None,
                "field_config": field_config,
            }
            layer_index = {"layers": [layer_meta]}
            layer_project_links = {
                "links": [
                    {"id": 101, "layer_id": layer_id, "name": "Stops", "order": 0}
                ]
            }

            checksums: dict[str, str] = {}

            def _cs(b: bytes) -> str:
                return f"sha256:{hashlib.sha256(b).hexdigest()}"

            project_bytes = json.dumps(project_data, indent=2).encode()
            checksums["project.json"] = _cs(project_bytes)

            index_bytes = json.dumps(layer_index, indent=2).encode()
            checksums["layers/index.json"] = _cs(index_bytes)

            meta_bytes = json.dumps(layer_meta, indent=2).encode()
            checksums[f"layers/{layer_id}/metadata.json"] = _cs(meta_bytes)

            links_bytes = json.dumps(layer_project_links, indent=2).encode()
            checksums["layer_project_links.json"] = _cs(links_bytes)

            manifest = {
                "format_version": "1.1",
                "exported_at": "2025-06-01T00:00:00Z",
                "project_name": "Formula Project",
                "checksums": checksums,
                "layer_count": 1,
                "internal_layer_count": 1,
                "external_layer_count": 0,
                "workflow_count": 0,
                "report_count": 0,
            }

            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("project.json", project_bytes)
                zf.writestr("layers/index.json", index_bytes)
                zf.writestr(f"layers/{layer_id}/metadata.json", meta_bytes)
                zf.writestr(f"layers/{layer_id}/data.parquet", b"FAKE_PARQUET")
                zf.writestr("layer_project_links.json", links_bytes)
                zf.writestr("manifest.json", json.dumps(manifest, indent=2).encode())

            zip_bytes = zip_path.read_bytes()

        params = ProjectImportParams(
            user_id=user_id,
            s3_key="imports/formula.zip",
            target_folder_id=folder_id,
        )

        def mock_download_file(**kwargs: object) -> None:
            Path(str(kwargs["Filename"])).write_bytes(zip_bytes)

        runner._s3_client.download_file.side_effect = mock_download_file
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("risk_score", "DOUBLE"),
            ("geometry", "GEOMETRY"),
        ]

        layer_insert_calls: list[tuple[str, tuple[object, ...]]] = []

        mock_asyncpg_conn = AsyncMock()
        mock_asyncpg_conn.set_type_codec = AsyncMock()
        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=mock_txn)
        mock_txn.__aexit__ = AsyncMock(return_value=False)
        mock_asyncpg_conn.transaction = MagicMock(return_value=mock_txn)

        async def tracking_execute(query: str, *args: object) -> None:
            if "INSERT INTO customer.layer\n" in query:
                layer_insert_calls.append((query, args))
            return None

        mock_asyncpg_conn.execute = AsyncMock(side_effect=tracking_execute)
        mock_asyncpg_conn.fetchval = AsyncMock(return_value=1)

        with patch("goatlib.tools.project_import.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=mock_asyncpg_conn)
            runner.run(params)

        assert (
            len(layer_insert_calls) == 1
        ), f"Expected 1 layer insert, got {len(layer_insert_calls)}"
        query, args = layer_insert_calls[0]
        assert "field_config" in query, (
            "layer INSERT must write field_config, got:\n" + query
        )
        assert (
            field_config in args
        ), f"field_config value not passed to the layer INSERT: {args}"

    def test_import_sets_space_id_on_project_and_layer(
        self, runner: ProjectImportRunner
    ) -> None:
        """The imported project and its layers must carry the target
        folder's `space_id` (Task 9): without it both rows would be
        unreachable through any space-scoped listing or grant."""
        import uuid as uuid_module

        user_id = "00000000-0000-0000-0000-000000000001"
        folder_id = "00000000-0000-0000-0000-ffffffffffff"
        layer_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        folder_space_id = uuid_module.UUID("11111111-1111-1111-1111-111111111111")

        with tempfile.TemporaryDirectory() as build_dir:
            zip_path = Path(build_dir) / "export.zip"

            project_data = {"name": "Spaced Project"}
            layer_meta = {
                "id": layer_id,
                "name": "Stops",
                "type": "feature",
                "data_type": None,
            }
            layer_index = {"layers": [layer_meta]}
            layer_link = {"name": "Stops", "order": 0}

            checksums: dict[str, str] = {}

            def _cs(b: bytes) -> str:
                return f"sha256:{hashlib.sha256(b).hexdigest()}"

            project_bytes = json.dumps(project_data, indent=2).encode()
            checksums["project.json"] = _cs(project_bytes)

            index_bytes = json.dumps(layer_index, indent=2).encode()
            checksums["layers/index.json"] = _cs(index_bytes)

            meta_bytes = json.dumps(layer_meta, indent=2).encode()
            checksums[f"layers/{layer_id}/metadata.json"] = _cs(meta_bytes)

            link_bytes = json.dumps(layer_link, indent=2).encode()
            checksums[f"layers/{layer_id}/project_link.json"] = _cs(link_bytes)

            manifest = {
                "format_version": "1.0",
                "exported_at": "2025-06-01T00:00:00Z",
                "project_name": "Spaced Project",
                "checksums": checksums,
                "layer_count": 1,
                "internal_layer_count": 1,
                "external_layer_count": 0,
                "workflow_count": 0,
                "report_count": 0,
            }

            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("project.json", project_bytes)
                zf.writestr("layers/index.json", index_bytes)
                zf.writestr(f"layers/{layer_id}/metadata.json", meta_bytes)
                zf.writestr(f"layers/{layer_id}/project_link.json", link_bytes)
                zf.writestr(f"layers/{layer_id}/data.parquet", b"FAKE_PARQUET")
                zf.writestr("manifest.json", json.dumps(manifest, indent=2).encode())

            zip_bytes = zip_path.read_bytes()

        params = ProjectImportParams(
            user_id=user_id,
            s3_key="imports/spaced.zip",
            target_folder_id=folder_id,
        )

        def mock_download_file(**kwargs: object) -> None:
            Path(str(kwargs["Filename"])).write_bytes(zip_bytes)

        runner._s3_client.download_file.side_effect = mock_download_file
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("geometry", "GEOMETRY"),
        ]

        project_insert_calls: list[tuple[str, tuple[object, ...]]] = []
        layer_insert_calls: list[tuple[str, tuple[object, ...]]] = []

        mock_asyncpg_conn = AsyncMock()
        mock_asyncpg_conn.set_type_codec = AsyncMock()
        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=mock_txn)
        mock_txn.__aexit__ = AsyncMock(return_value=False)
        mock_asyncpg_conn.transaction = MagicMock(return_value=mock_txn)

        async def tracking_execute(query: str, *args: object) -> None:
            if "INSERT INTO customer.project\n" in query:
                project_insert_calls.append((query, args))
            elif "INSERT INTO customer.layer\n" in query:
                layer_insert_calls.append((query, args))
            return None

        async def tracking_fetchval(query: str, *args: object) -> object:
            if "SELECT space_id FROM customer.folder" in query:
                return folder_space_id
            return 1  # group/link RETURNING id elsewhere in the import

        mock_asyncpg_conn.execute = AsyncMock(side_effect=tracking_execute)
        mock_asyncpg_conn.fetchval = AsyncMock(side_effect=tracking_fetchval)

        with patch("goatlib.tools.project_import.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=mock_asyncpg_conn)
            runner.run(params)

        assert len(project_insert_calls) == 1
        project_query, project_args = project_insert_calls[0]
        assert "space_id" in project_query, (
            "project INSERT must write space_id, got:\n" + project_query
        )
        assert (
            folder_space_id in project_args
        ), f"target folder's space_id not passed to the project INSERT: {project_args}"

        assert len(layer_insert_calls) == 1
        layer_query, layer_args = layer_insert_calls[0]
        assert "space_id" in layer_query, (
            "layer INSERT must write space_id, got:\n" + layer_query
        )
        assert (
            folder_space_id in layer_args
        ), f"target folder's space_id not passed to the layer INSERT: {layer_args}"

    def test_import_duplicate_layer_links(self, runner: ProjectImportRunner) -> None:
        """A 1.1 archive with 2 links to the same layer creates 2 layer_project rows.

        Regression: previously the import iterated the layer index and inserted
        one layer_project row per layer. The unique dataset must be inserted
        once, but each link in layer_project_links.json must produce its own
        layer_project row.
        """
        user_id = "00000000-0000-0000-0000-000000000001"
        folder_id = "00000000-0000-0000-0000-ffffffffffff"
        layer_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

        with tempfile.TemporaryDirectory() as build_dir:
            zip_path = Path(build_dir) / "export.zip"

            project_data = {"name": "Dup Project"}
            layer_meta = {
                "id": layer_id,
                "name": "Shared Dataset",
                "type": "feature",
                "data_type": None,
            }
            layer_index = {"layers": [layer_meta]}
            layer_project_links = {
                "links": [
                    {
                        "id": 101,
                        "layer_id": layer_id,
                        "name": "View A",
                        "order": 0,
                    },
                    {
                        "id": 102,
                        "layer_id": layer_id,
                        "name": "View B",
                        "order": 1,
                    },
                ]
            }

            checksums: dict[str, str] = {}

            def _cs(b: bytes) -> str:
                return f"sha256:{hashlib.sha256(b).hexdigest()}"

            project_bytes = json.dumps(project_data, indent=2).encode()
            checksums["project.json"] = _cs(project_bytes)

            index_bytes = json.dumps(layer_index, indent=2).encode()
            checksums["layers/index.json"] = _cs(index_bytes)

            meta_bytes = json.dumps(layer_meta, indent=2).encode()
            checksums[f"layers/{layer_id}/metadata.json"] = _cs(meta_bytes)

            links_bytes = json.dumps(layer_project_links, indent=2).encode()
            checksums["layer_project_links.json"] = _cs(links_bytes)

            manifest = {
                "format_version": "1.1",
                "exported_at": "2025-06-01T00:00:00Z",
                "project_name": "Dup Project",
                "checksums": checksums,
                "layer_count": 1,
                "internal_layer_count": 1,
                "external_layer_count": 0,
                "workflow_count": 0,
                "report_count": 0,
            }

            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("project.json", project_bytes)
                zf.writestr("layers/index.json", index_bytes)
                zf.writestr(f"layers/{layer_id}/metadata.json", meta_bytes)
                zf.writestr(f"layers/{layer_id}/data.parquet", b"FAKE_PARQUET")
                zf.writestr("layer_project_links.json", links_bytes)
                zf.writestr("manifest.json", json.dumps(manifest, indent=2).encode())

            zip_bytes = zip_path.read_bytes()

        params = ProjectImportParams(
            user_id=user_id,
            s3_key="imports/dup.zip",
            target_folder_id=folder_id,
        )

        def mock_download_file(**kwargs: object) -> None:
            Path(str(kwargs["Filename"])).write_bytes(zip_bytes)

        runner._s3_client.download_file.side_effect = mock_download_file
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        # Track INSERT statements per target table.
        layer_inserts = 0
        layer_project_inserts = 0
        execute_log: list[str] = []

        mock_asyncpg_conn = AsyncMock()
        mock_asyncpg_conn.set_type_codec = AsyncMock()
        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=mock_txn)
        mock_txn.__aexit__ = AsyncMock(return_value=False)
        mock_asyncpg_conn.transaction = MagicMock(return_value=mock_txn)

        async def tracking_execute(query: str, *args: object) -> None:
            nonlocal layer_inserts
            execute_log.append(query)
            if "INSERT INTO customer.layer\n" in query or query.lstrip().startswith(
                "INSERT INTO customer.layer "
            ):
                layer_inserts += 1
            return None

        # asyncpg's INSERT INTO customer.layer query in source is multi-line.
        # Use a simpler matcher: any insert mentioning customer.layer but not
        # layer_project or layer_project_group.
        async def tracking_execute_strict(query: str, *args: object) -> None:
            execute_log.append(query)
            return None

        mock_asyncpg_conn.execute = AsyncMock(side_effect=tracking_execute_strict)

        # layer_project insert returns id via fetchval; track those too.
        next_link_id = [1000]

        async def tracking_fetchval(query: str, *args: object) -> int:
            nonlocal layer_project_inserts
            execute_log.append(query)
            if "INSERT INTO customer.layer_project\n" in query or (
                "INSERT INTO customer.layer_project " in query
                and "layer_project_group" not in query
            ):
                layer_project_inserts += 1
            next_link_id[0] += 1
            return next_link_id[0]

        mock_asyncpg_conn.fetchval = AsyncMock(side_effect=tracking_fetchval)

        with patch("goatlib.tools.project_import.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=mock_asyncpg_conn)
            result = runner.run(params)

        # Count actual inserts via execute_log. The trailing whitespace after
        # the table name disambiguates layer vs layer_project vs
        # layer_project_group (each followed by a newline + column list).
        layer_inserts = sum(
            1 for q in execute_log if "INSERT INTO customer.layer\n" in q
        )
        layer_project_inserts = sum(
            1 for q in execute_log if "INSERT INTO customer.layer_project\n" in q
        )

        assert result["layer_count"] == 1
        # Unique dataset inserted once.
        assert layer_inserts == 1, (
            f"Expected 1 layer insert, got {layer_inserts}. " f"Queries: {execute_log}"
        )
        # Both layer_project links inserted.
        assert layer_project_inserts == 2, (
            f"Expected 2 layer_project inserts, got {layer_project_inserts}. "
            f"Queries: {execute_log}"
        )
