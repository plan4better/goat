"""Unit tests for ProjectExport tool.

Tests the project export functionality including:
- Parameter validation
- SHA-256 hash computation
- JSON writing
- Layer data export
- S3 asset fetching
- Full export run producing a valid ZIP
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools.project_export import (
    ProjectExportParams,
    ProjectExportRunner,
)


class TestProjectExportParams:
    """Test parameter validation."""

    def test_valid_params(self) -> None:
        """Basic param construction works with just project_id."""
        params = ProjectExportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            project_id="00000000-0000-0000-0000-000000000002",
        )
        assert params.user_id == "00000000-0000-0000-0000-000000000001"
        assert params.project_id == "00000000-0000-0000-0000-000000000002"

    def test_default_optional_fields(self) -> None:
        """Optional fields default correctly."""
        params = ProjectExportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            project_id="00000000-0000-0000-0000-000000000002",
        )
        assert params.source_instance is None


class TestProjectExportRunner:
    """Test runner methods."""

    @pytest.fixture()
    def runner(self) -> ProjectExportRunner:
        """Create runner with mocked settings."""
        runner = ProjectExportRunner()
        settings = MagicMock()
        settings.s3_bucket_name = "test-bucket"
        settings.customer_schema = "customer"
        settings.postgres_server = "localhost"
        settings.postgres_port = 5432
        settings.postgres_user = "test"
        settings.postgres_password = "test"
        settings.postgres_db = "test"
        runner.settings = settings
        runner._duckdb_con = MagicMock()
        runner._s3_client = MagicMock()
        return runner

    def test_compute_sha256(self, runner: ProjectExportRunner) -> None:
        """Verify hash computation on a real temp file."""
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp.write(b"hello world")
            tmp_path = Path(tmp.name)

        try:
            result = runner._compute_sha256(tmp_path)
            expected = hashlib.sha256(b"hello world").hexdigest()
            assert result == f"sha256:{expected}"
        finally:
            tmp_path.unlink()

    def test_write_json(self, runner: ProjectExportRunner) -> None:
        """Verify JSON writing to temp dir."""
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "subdir" / "test.json"
            data = {"key": "value", "number": 42}
            runner._write_json(data, out_path)

            assert out_path.exists()
            with open(out_path) as f:
                loaded = json.load(f)
            assert loaded == data

    def test_export_layer_data_table_not_found(
        self, runner: ProjectExportRunner
    ) -> None:
        """When DuckLake table doesn't exist, returns 0."""
        runner._duckdb_con.execute.return_value.fetchone.return_value = (0,)

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "data.parquet"
            row_count = runner._export_layer_data(
                layer_id="00000000-0000-0000-0000-000000000002",
                owner_id="00000000-0000-0000-0000-000000000001",
                output_path=output_path,
            )

        assert row_count == 0

    def test_fetch_s3_asset_success(self, runner: ProjectExportRunner) -> None:
        """Successful S3 download."""
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "asset.png"
            result = runner._fetch_s3_asset("assets/test.png", output_path)

        assert result is True
        runner._s3_client.download_file.assert_called_once_with(
            Bucket="test-bucket",
            Key="assets/test.png",
            Filename=str(output_path),
        )

    def test_fetch_s3_asset_failure(self, runner: ProjectExportRunner) -> None:
        """S3 download fails gracefully (returns False)."""
        runner._s3_client.download_file.side_effect = Exception("Network error")

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "asset.png"
            result = runner._fetch_s3_asset("assets/test.png", output_path)

        assert result is False

    def test_run_creates_valid_zip(self, runner: ProjectExportRunner) -> None:
        """Full run() produces a valid ZIP with expected structure."""
        layer_id = "00000000-0000-0000-0000-aaaaaaaaaaaa"
        user_id = "00000000-0000-0000-0000-000000000001"

        params = ProjectExportParams(
            user_id=user_id,
            project_id="00000000-0000-0000-0000-000000000099",
        )

        # Mock _gather_metadata to return test data (no real DB needed)
        mock_metadata = {
            "project_metadata": {"name": "Test Project", "description": "desc"},
            "layers": [
                {
                    "id": layer_id,
                    "name": "My Layer",
                    "type": "feature",
                    "user_id": user_id,
                }
            ],
            "layer_project_links": [
                {"layer_id": layer_id, "name": "My Layer", "order": 0},
            ],
            "layer_groups": [
                {"id": "g1", "name": "Group 1", "order": 0},
            ],
            "workflows": [],
            "reports": [],
            "assets": [],
            "asset_s3_keys": [],
            "thumbnail_s3_key": None,
        }

        # Mock DuckDB - table exists check
        mock_con = runner._duckdb_con
        mock_con.execute.return_value.fetchone.return_value = (1,)
        mock_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        # Mock write_optimized_parquet to create a dummy parquet file
        with (
            patch("goatlib.io.parquet.write_optimized_parquet") as mock_wp,
            patch.object(
                runner,
                "_gather_metadata",
                new_callable=AsyncMock,
                return_value=mock_metadata,
            ),
        ):

            def side_effect(
                con: MagicMock,
                source: str,
                output_path: str,
                geometry_column: str,
            ) -> int:
                Path(output_path).touch()
                return 10

            mock_wp.side_effect = side_effect

            # Mock S3 upload (capture the uploaded bytes)
            uploaded_data: dict[str, bytes] = {}

            def mock_put_object(**kwargs: object) -> None:
                body = kwargs["Body"]
                uploaded_data["zip"] = body.read()  # type: ignore[union-attr]

            runner._s3_client.put_object.side_effect = mock_put_object

            # Mock presigned URL generation
            mock_public_client = MagicMock()
            mock_public_client.generate_presigned_url.return_value = (
                "https://s3.example.com/presigned"
            )
            runner.settings.get_s3_public_client.return_value = mock_public_client

            result = runner.run(params)

        # Verify S3 upload was called with correct content type
        call_kwargs = runner._s3_client.put_object.call_args
        assert call_kwargs is not None
        assert call_kwargs.kwargs.get("ContentType") == "application/zip"
        assert call_kwargs.kwargs.get("Bucket") == "test-bucket"
        s3_key = call_kwargs.kwargs.get("Key")
        assert s3_key is not None
        assert s3_key.startswith(f"exports/{user_id}/")
        assert s3_key.endswith(".zip")

        # Verify presigned URL was generated
        mock_public_client.generate_presigned_url.assert_called_once()

        # Verify output
        assert "s3_key" in result
        assert "presigned_url" in result
        assert result["presigned_url"] == "https://s3.example.com/presigned"

        # Verify ZIP contents
        assert "zip" in uploaded_data
        import io

        with zipfile.ZipFile(io.BytesIO(uploaded_data["zip"])) as zf:
            names = zf.namelist()
            assert "manifest.json" in names
            assert "project.json" in names
            assert "layers/index.json" in names
            assert "layer_groups.json" in names
            assert "layer_project_links.json" in names
            assert f"layers/{layer_id}/metadata.json" in names
            # Format 1.1: per-layer project_link.json is no longer written
            assert f"layers/{layer_id}/project_link.json" not in names

            # Check manifest
            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["format_version"] == "1.2"
            assert manifest["project_name"] == "Test Project"
            assert manifest["layer_count"] == 1

    async def test_gather_metadata_includes_field_config(
        self, runner: ProjectExportRunner
    ) -> None:
        """Layer metadata carries `field_config` (formula/computed columns).

        Regression: the layer SELECT omitted `field_config`, so formula
        columns, computed kinds (area/perimeter/length) and per-field
        display config were dropped from the archive.
        """
        layer_id = uuid.UUID("00000000-0000-0000-0000-aaaaaaaaaaaa")
        project_id = uuid.UUID("00000000-0000-0000-0000-000000000099")
        user_id = uuid.UUID("00000000-0000-0000-0000-000000000001")

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

        layer_row: dict[str, Any] = {
            "id": layer_id,
            "name": "My Layer",
            "description": None,
            "type": "feature",
            "url": None,
            "data_type": None,
            "feature_layer_type": "standard",
            "feature_layer_geometry_type": "point",
            "tool_type": None,
            "job_id": None,
            "style": None,
            "other_properties": None,
            "size": None,
            "thumbnail_url": None,
            "tags": None,
            "public_read": False,
            "user_id": user_id,
            "folder_id": uuid.UUID("00000000-0000-0000-0000-ffffffffffff"),
            "field_config": field_config,
        }

        queries: list[str] = []

        async def fake_fetchrow(query: str, *args: object) -> dict[str, Any] | None:
            queries.append(query)
            if "FROM customer.project" in query:
                return {
                    "id": project_id,
                    "user_id": user_id,
                    "name": "Test Project",
                    "description": None,
                    "basemap": None,
                    "custom_basemaps": None,
                    "max_extent": None,
                    "builder_config": None,
                    "tags": None,
                    "thumbnail_url": None,
                }
            return None

        link_row: dict[str, Any] = {
            "id": 101,
            "layer_id": layer_id,
            "project_id": project_id,
            "layer_project_group_id": None,
            "order": 0,
            "name": "My Layer",
            "other_properties": None,
            "query": None,
            "charts": None,
            "styles": [],
            "visible": True,
            "position": "top",
            "time_value": None,
            "legend_expanded": True,
        }

        async def fake_fetch(query: str, *args: object) -> list[dict[str, Any]]:
            queries.append(query)
            if "FROM customer.layer_project lp\n" in query:
                return [link_row]
            if "FROM customer.layer l\n" in query:
                return [layer_row]
            return []

        conn = AsyncMock()
        conn.fetchrow = AsyncMock(side_effect=fake_fetchrow)
        conn.fetch = AsyncMock(side_effect=fake_fetch)
        conn.set_type_codec = AsyncMock()
        conn.close = AsyncMock()

        with patch("goatlib.tools.project_export.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=conn)
            metadata = await runner._gather_metadata(str(project_id), str(user_id))

        layer_select = next(q for q in queries if "FROM customer.layer l\n" in q)
        assert "field_config" in layer_select, (
            "layer SELECT must request field_config, got:\n" + layer_select
        )
        assert metadata["layers"][0]["field_config"] == field_config

    @pytest.mark.parametrize(
        ("thumbnail_url", "expected_key"),
        [
            ("thumbnails/projects/p_abc.png", "thumbnails/projects/p_abc.png"),
            ("/assets/img/goat_new_project_artwork.png", None),
            ("https://assets.example.org/img/goat_new_project_artwork.png", None),
            (None, None),
        ],
    )
    async def test_only_a_bucket_thumbnail_is_exported(
        self,
        runner: ProjectExportRunner,
        thumbnail_url: str | None,
        expected_key: str | None,
    ) -> None:
        """A URL or a root-relative artwork path is not an object in the bucket."""
        project_id = uuid.UUID("00000000-0000-0000-0000-000000000099")
        user_id = uuid.UUID("00000000-0000-0000-0000-000000000001")

        async def fake_fetchrow(query: str, *args: object) -> dict[str, Any] | None:
            if "FROM customer.project" in query:
                return {
                    "id": project_id,
                    "user_id": user_id,
                    "name": "Test Project",
                    "description": None,
                    "basemap": None,
                    "custom_basemaps": None,
                    "max_extent": None,
                    "builder_config": None,
                    "tags": None,
                    "thumbnail_url": thumbnail_url,
                }
            return None

        conn = AsyncMock()
        conn.fetchrow = AsyncMock(side_effect=fake_fetchrow)
        conn.fetch = AsyncMock(return_value=[])
        conn.set_type_codec = AsyncMock()
        conn.close = AsyncMock()

        with patch("goatlib.tools.project_export.asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = AsyncMock(return_value=conn)
            metadata = await runner._gather_metadata(str(project_id), str(user_id))

        assert metadata["thumbnail_s3_key"] == expected_key

    def test_run_preserves_multiple_links_for_same_layer(
        self, runner: ProjectExportRunner
    ) -> None:
        """A project with N layer_project links to the same dataset exports all N.

        Regression: previously the export deduplicated links by layer_id, so
        only one link survived. The archive must preserve every link.
        """
        layer_id = "00000000-0000-0000-0000-aaaaaaaaaaaa"
        user_id = "00000000-0000-0000-0000-000000000001"

        params = ProjectExportParams(
            user_id=user_id,
            project_id="00000000-0000-0000-0000-000000000099",
        )

        # Two layer_project rows pointing at the same layer with different
        # styling/query — the common "same dataset, two views" pattern.
        mock_metadata = {
            "project_metadata": {"name": "Dup Project"},
            "layers": [
                {
                    "id": layer_id,
                    "name": "Shared Dataset",
                    "type": "feature",
                    "user_id": user_id,
                }
            ],
            "layer_project_links": [
                {
                    "id": 101,
                    "layer_id": layer_id,
                    "name": "View A",
                    "order": 0,
                    "query": {"op": "=", "args": [{"property": "status"}, "active"]},
                },
                {
                    "id": 102,
                    "layer_id": layer_id,
                    "name": "View B",
                    "order": 1,
                    "query": {"op": "=", "args": [{"property": "status"}, "archived"]},
                },
            ],
            "layer_groups": [],
            "workflows": [],
            "reports": [],
            "assets": [],
            "asset_s3_keys": [],
            "thumbnail_s3_key": None,
        }

        mock_con = runner._duckdb_con
        mock_con.execute.return_value.fetchone.return_value = (1,)
        mock_con.execute.return_value.fetchall.return_value = [
            ("id", "INTEGER"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        uploaded: dict[str, bytes] = {}

        def mock_put_object(**kwargs: object) -> None:
            uploaded["zip"] = kwargs["Body"].read()  # type: ignore[union-attr]

        runner._s3_client.put_object.side_effect = mock_put_object
        mock_public_client = MagicMock()
        mock_public_client.generate_presigned_url.return_value = "https://x"
        runner.settings.get_s3_public_client.return_value = mock_public_client

        with (
            patch("goatlib.io.parquet.write_optimized_parquet") as mock_wp,
            patch.object(
                runner,
                "_gather_metadata",
                new_callable=AsyncMock,
                return_value=mock_metadata,
            ),
        ):

            def parquet_side_effect(
                con: MagicMock,
                source: str,
                output_path: str,
                geometry_column: str,
            ) -> int:
                Path(output_path).touch()
                return 5

            mock_wp.side_effect = parquet_side_effect
            runner.run(params)

        import io

        with zipfile.ZipFile(io.BytesIO(uploaded["zip"])) as zf:
            names = zf.namelist()

            # The new archive layout puts links in a single root file.
            assert (
                "layer_project_links.json" in names
            ), f"Expected layer_project_links.json in archive, got: {sorted(names)}"

            links_payload = json.loads(zf.read("layer_project_links.json"))
            links = links_payload["links"]

            # Both links must be present — not collapsed to one.
            assert (
                len(links) == 2
            ), f"Expected 2 layer_project links, got {len(links)}: {links}"

            # Each link carries its layer_id and unique fields.
            assert all(lk["layer_id"] == layer_id for lk in links)
            names_in_archive = {lk["name"] for lk in links}
            assert names_in_archive == {"View A", "View B"}

            # The unique dataset still appears once in the layer index.
            layer_index = json.loads(zf.read("layers/index.json"))
            assert len(layer_index["layers"]) == 1
            assert layer_index["layers"][0]["id"] == layer_id


def _project_row(project_id: uuid.UUID, owner_id: uuid.UUID) -> dict[str, Any]:
    return {
        "id": project_id,
        "user_id": owner_id,
        "name": "Shared Project",
        "description": None,
        "basemap": None,
        "custom_basemaps": None,
        "max_extent": None,
        "builder_config": None,
        "tags": None,
        "thumbnail_url": None,
    }


async def _gather_with_view_rows(
    runner: ProjectExportRunner,
    project_id: uuid.UUID,
    owner_id: uuid.UUID,
    exporter_id: uuid.UUID,
    view_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run `_gather_metadata` against a project with the given user_project rows."""

    async def fake_fetchrow(query: str, *args: object) -> dict[str, Any] | None:
        if "FROM customer.project" in query:
            return _project_row(project_id, owner_id)
        return None

    async def fake_fetch(query: str, *args: object) -> list[dict[str, Any]]:
        if "FROM customer.user_project" in query:
            wanted = set(args[1])  # type: ignore[arg-type]
            return [r for r in view_rows if r["user_id"] in wanted]
        return []

    conn = AsyncMock()
    conn.fetchrow = AsyncMock(side_effect=fake_fetchrow)
    conn.fetch = AsyncMock(side_effect=fake_fetch)
    conn.set_type_codec = AsyncMock()
    conn.close = AsyncMock()

    with patch("goatlib.tools.project_export.asyncpg") as mock_asyncpg:
        mock_asyncpg.connect = AsyncMock(return_value=conn)
        return await runner._gather_metadata(str(project_id), str(exporter_id))


class TestExportInitialViewState:
    """Which `user_project` row the archive's `initial_view_state` comes from.

    Regression: exporting a project the exporter did not own and had never
    opened wrote `initial_view_state: null`; the importer then inserted that
    into a NOT NULL column and the whole import rolled back.
    """

    project_id = uuid.UUID("00000000-0000-0000-0000-000000000099")
    owner_id = uuid.UUID("00000000-0000-0000-0000-000000000011")
    exporter_id = uuid.UUID("00000000-0000-0000-0000-000000000022")
    owner_view = {"zoom": 12, "latitude": 52.5, "longitude": 13.4}
    exporter_view = {"zoom": 9, "latitude": 48.1, "longitude": 11.6}

    @pytest.fixture()
    def runner(self) -> ProjectExportRunner:
        runner = ProjectExportRunner()
        settings = MagicMock()
        settings.customer_schema = "customer"
        runner.settings = settings
        return runner

    @pytest.mark.asyncio
    async def test_exporter_own_row_wins(self, runner: ProjectExportRunner) -> None:
        metadata = await _gather_with_view_rows(
            runner,
            self.project_id,
            self.owner_id,
            self.exporter_id,
            [
                {"user_id": self.owner_id, "initial_view_state": self.owner_view},
                {"user_id": self.exporter_id, "initial_view_state": self.exporter_view},
            ],
        )
        assert metadata["project_metadata"]["initial_view_state"] == self.exporter_view

    @pytest.mark.asyncio
    async def test_falls_back_to_owner_row(self, runner: ProjectExportRunner) -> None:
        metadata = await _gather_with_view_rows(
            runner,
            self.project_id,
            self.owner_id,
            self.exporter_id,
            [{"user_id": self.owner_id, "initial_view_state": self.owner_view}],
        )
        assert metadata["project_metadata"]["initial_view_state"] == self.owner_view

    @pytest.mark.asyncio
    async def test_no_row_at_all_omits_the_key(
        self, runner: ProjectExportRunner
    ) -> None:
        """No row anywhere: leave the key out so the importer applies its default."""
        metadata = await _gather_with_view_rows(
            runner, self.project_id, self.owner_id, self.exporter_id, []
        )
        assert "initial_view_state" not in metadata["project_metadata"]
