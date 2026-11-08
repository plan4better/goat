"""Tests for LayerUpdate tool.

Tests the layer update functionality including:
- Parameter validation
- S3 import flow
- WFS refresh flow
- DuckLake table replacement
- PostgreSQL metadata updates
- Permission checks
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools.layer_update import (
    LayerUpdateOutput,
    LayerUpdateParams,
    LayerUpdateRunner,
)


class TestLayerUpdateParams:
    """Test parameter validation."""

    def test_valid_s3_update(self):
        """Valid params with s3_key."""
        params = LayerUpdateParams(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/test.gpkg",
        )
        assert params.s3_key == "uploads/test.gpkg"
        assert params.refresh_wfs is False

    def test_valid_wfs_refresh(self):
        """Valid params with refresh_wfs."""
        params = LayerUpdateParams(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            refresh_wfs=True,
        )
        assert params.refresh_wfs is True
        assert params.s3_key is None

    def test_invalid_no_source(self):
        """Must specify either s3_key or refresh_wfs."""
        with pytest.raises(ValueError, match="Either s3_key or refresh_wfs"):
            LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000001",
                layer_id="00000000-0000-0000-0000-000000000002",
            )

    def test_invalid_both_sources(self):
        """Cannot specify both s3_key and refresh_wfs."""
        with pytest.raises(ValueError, match="Cannot specify both"):
            LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000001",
                layer_id="00000000-0000-0000-0000-000000000002",
                s3_key="uploads/test.gpkg",
                refresh_wfs=True,
            )

    def test_layer_id_required(self):
        """layer_id is required."""
        with pytest.raises(ValueError):
            LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000001",
                s3_key="uploads/test.gpkg",
            )


class TestLayerUpdateOutput:
    """Test output schema."""

    def test_successful_output(self):
        """Test successful update output."""
        output = LayerUpdateOutput(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            updated=True,
            feature_count=100,
            size=1024,
            geometry_type="point",
        )
        assert output.updated is True
        assert output.error is None
        assert output.feature_count == 100

    def test_error_output(self):
        """Test error output."""
        output = LayerUpdateOutput(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            updated=False,
            error="Permission denied",
        )
        assert output.updated is False
        assert output.error == "Permission denied"


class TestLayerUpdateRunner:
    """Test the runner logic with mocks."""

    @pytest.fixture
    def mock_settings(self):
        """Create mock settings."""
        settings = MagicMock()
        settings.customer_schema = "customer"
        settings.s3_bucket_name = "test-bucket"
        settings.s3_endpoint_url = "http://localhost:9000"
        settings.s3_provider = "minio"
        settings.s3_region_name = "us-east-1"
        settings.postgres_server = "localhost"
        settings.postgres_port = 5432
        settings.postgres_user = "test"
        settings.postgres_password = "test"
        settings.postgres_db = "test"
        settings.ducklake_postgres_uri = "postgresql://localhost/test"
        settings.ducklake_catalog_schema = "ducklake"
        settings.ducklake_data_dir = "/tmp/ducklake"
        return settings

    @pytest.fixture
    def runner(self, mock_settings):
        """Create runner with mocked settings."""
        runner = LayerUpdateRunner()
        runner.settings = mock_settings
        return runner

    def test_import_from_s3_refuses_unknown_suffix(self, runner, tmp_path):
        """A format no reader takes is refused before the upload is fetched."""
        runner.download_uploaded_object = MagicMock()
        runner._converter = MagicMock()

        with pytest.raises(ValueError, match=r"^Unsupported file format: \.xml$"):
            runner._import_from_s3(
                s3_key="users/u/imports/uploads/data.xml",
                temp_dir=tmp_path,
                output_path=tmp_path / "output.parquet",
            )

        runner.download_uploaded_object.assert_not_called()
        runner._converter.to_parquet.assert_not_called()

    def test_get_table_info(self, runner):
        """Test _get_table_info extracts metadata correctly."""
        # Mock DuckDB connection
        mock_con = MagicMock()

        # Mock DESCRIBE result
        mock_con.execute.return_value.fetchall.side_effect = [
            # First call: DESCRIBE
            [("id", "VARCHAR"), ("name", "VARCHAR"), ("geometry", "GEOMETRY")],
            # Second call: COUNT
            [(50,)],
            # Third call: geometry type
            [("POINT",)],
            # Fourth call: extent
            [("BOX(10.0 20.0, 30.0 40.0)",)],
        ]
        mock_con.execute.return_value.fetchone.side_effect = [
            (50,),  # COUNT
            ("POINT",),  # geometry type
            ("BOX(10.0 20.0, 30.0 40.0)",),  # extent
        ]

        result = runner._get_table_info(mock_con, "lake.user_xxx.t_yyy")

        assert "columns" in result
        assert "feature_count" in result
        assert result["columns"]["geometry"] == "GEOMETRY"

    @pytest.mark.asyncio
    async def test_get_layer_full_info_not_found(self, runner):
        """Test error when layer not found."""
        mock_pool = AsyncMock()
        mock_pool.fetchrow.return_value = None

        with patch.object(runner, "get_postgres_pool", return_value=mock_pool):
            with pytest.raises(ValueError, match="Layer not found"):
                await runner._get_layer_full_info(
                    "00000000-0000-0000-0000-000000000001",
                    "00000000-0000-0000-0000-000000000002",
                )

    @pytest.mark.asyncio
    async def test_get_layer_full_info_permission_denied(self, runner):
        """Test error when user doesn't own layer."""
        import uuid

        mock_pool = AsyncMock()
        mock_pool.fetchrow.return_value = {
            "id": uuid.UUID("00000000-0000-0000-0000-000000000001"),
            "user_id": uuid.UUID(
                "00000000-0000-0000-0000-000000000099"
            ),  # Different owner
            "folder_id": uuid.UUID("00000000-0000-0000-0000-000000000003"),
            "name": "Test Layer",
            "type": "feature",
            "data_type": None,
            "feature_layer_type": "standard",
            "feature_layer_geometry_type": "point",
            "other_properties": {},
        }

        with patch.object(runner, "get_postgres_pool", return_value=mock_pool):
            with pytest.raises(PermissionError, match="cannot update layer"):
                await runner._get_layer_full_info(
                    "00000000-0000-0000-0000-000000000001",
                    "00000000-0000-0000-0000-000000000002",  # Different user
                )


class TestLayerUpdateIntegration:
    """Integration-style tests with more complete mocking."""

    @pytest.fixture
    def mock_settings(self):
        """Create mock settings."""
        settings = MagicMock()
        settings.customer_schema = "customer"
        settings.s3_bucket_name = "test-bucket"
        settings.s3_endpoint_url = "http://localhost:9000"
        settings.s3_provider = "minio"
        settings.s3_region_name = "us-east-1"
        settings.postgres_server = "localhost"
        settings.postgres_port = 5432
        settings.postgres_user = "test"
        settings.postgres_password = "test"
        settings.postgres_db = "test"
        settings.ducklake_postgres_uri = "postgresql://localhost/test"
        settings.ducklake_catalog_schema = "ducklake"
        settings.ducklake_data_dir = "/tmp/ducklake"
        settings.get_s3_client.return_value = MagicMock()
        return settings

    def test_run_s3_update_success(self, mock_settings, tmp_path):
        """Test successful S3-based update flow."""

        runner = LayerUpdateRunner()
        runner.settings = mock_settings

        # Create mock parquet file
        test_parquet = tmp_path / "test.parquet"
        test_parquet.write_bytes(b"mock parquet data")

        # Mock layer info
        layer_info = {
            "id": "00000000-0000-0000-0000-000000000001",
            "user_id": "00000000-0000-0000-0000-000000000002",
            "folder_id": "00000000-0000-0000-0000-000000000003",
            "name": "Test Layer",
            "type": "feature",
            "data_type": None,
            "feature_layer_type": "standard",
            "geometry_type": "point",
            "other_properties": {},
        }

        # Mock metadata
        from goatlib.models.io import DatasetMetadata

        mock_metadata = DatasetMetadata(
            path="/tmp/test.parquet",
            source_type="vector",
            feature_count=100,
            geometry_type="POINT",
            crs="EPSG:4326",
        )

        # Mock table info
        table_info = {
            "table_name": "lake.user_xxx.t_yyy",
            "feature_count": 100,
            "size": 1024,
            "geometry_type": "POINT",
            "extent_wkt": "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
            "columns": {"id": "VARCHAR", "geometry": "GEOMETRY"},
        }

        with (
            patch.object(
                runner, "_get_layer_full_info", new_callable=AsyncMock
            ) as mock_get_info,
            patch.object(runner, "_import_from_s3") as mock_import,
            patch.object(runner, "_replace_ducklake_table") as mock_replace,
            patch.object(
                runner, "_update_layer_metadata", new_callable=AsyncMock
            ) as mock_update,
        ):
            mock_get_info.return_value = layer_info
            mock_import.return_value = mock_metadata
            mock_replace.return_value = table_info

            params = LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000002",
                layer_id="00000000-0000-0000-0000-000000000001",
                s3_key="uploads/new_data.gpkg",
            )

            result = runner.run(params)

            assert result["updated"] is True
            assert result["layer_id"] == "00000000-0000-0000-0000-000000000001"
            assert result["feature_count"] == 100
            mock_import.assert_called_once()
            mock_replace.assert_called_once()
            mock_update.assert_called_once()

    def test_run_wfs_refresh_success(self, mock_settings):
        """Test successful WFS refresh flow."""
        runner = LayerUpdateRunner()
        runner.settings = mock_settings

        # Mock layer info with WFS properties
        layer_info = {
            "id": "00000000-0000-0000-0000-000000000001",
            "user_id": "00000000-0000-0000-0000-000000000002",
            "folder_id": "00000000-0000-0000-0000-000000000003",
            "name": "WFS Layer",
            "type": "feature",
            "data_type": "wfs",
            "feature_layer_type": "standard",
            "geometry_type": "polygon",
            "other_properties": {
                "url": "https://example.com/wfs",
                "layers": ["test_layer"],
            },
        }

        from goatlib.models.io import DatasetMetadata

        mock_metadata = DatasetMetadata(
            path="https://example.com/wfs",
            source_type="remote",
            feature_count=50,
            geometry_type="POLYGON",
            crs="EPSG:4326",
        )

        table_info = {
            "table_name": "lake.user_xxx.t_yyy",
            "feature_count": 50,
            "size": 2048,
            "geometry_type": "POLYGON",
            "extent_wkt": "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))",
            "columns": {"id": "VARCHAR", "geometry": "GEOMETRY", "name": "VARCHAR"},
        }

        with (
            patch.object(
                runner, "_get_layer_full_info", new_callable=AsyncMock
            ) as mock_get_info,
            patch.object(runner, "_import_from_wfs") as mock_import_wfs,
            patch.object(runner, "_replace_ducklake_table") as mock_replace,
            patch.object(runner, "_update_layer_metadata", new_callable=AsyncMock),
        ):
            mock_get_info.return_value = layer_info
            mock_import_wfs.return_value = mock_metadata
            mock_replace.return_value = table_info

            params = LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000002",
                layer_id="00000000-0000-0000-0000-000000000001",
                refresh_wfs=True,
            )

            result = runner.run(params)

            assert result["updated"] is True
            assert result["geometry_type"] == "polygon"
            mock_import_wfs.assert_called_once_with(
                wfs_url="https://example.com/wfs",
                layer_name="test_layer",
                temp_dir=mock_import_wfs.call_args[1]["temp_dir"],
                output_path=mock_import_wfs.call_args[1]["output_path"],
            )

    def test_run_wfs_refresh_missing_url(self, mock_settings):
        """Test error when WFS layer is missing URL."""
        runner = LayerUpdateRunner()
        runner.settings = mock_settings

        # Mock layer info without WFS URL
        layer_info = {
            "id": "00000000-0000-0000-0000-000000000001",
            "user_id": "00000000-0000-0000-0000-000000000002",
            "folder_id": "00000000-0000-0000-0000-000000000003",
            "name": "Not WFS Layer",
            "type": "feature",
            "data_type": None,
            "feature_layer_type": "standard",
            "geometry_type": "point",
            "other_properties": {},  # No URL!
        }

        with patch.object(
            runner, "_get_layer_full_info", new_callable=AsyncMock
        ) as mock_get_info:
            mock_get_info.return_value = layer_info

            params = LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000002",
                layer_id="00000000-0000-0000-0000-000000000001",
                refresh_wfs=True,
            )

            result = runner.run(params)

            assert result["updated"] is False
            assert "not a WFS layer" in result["error"]

    def test_run_permission_denied(self, mock_settings):
        """Test error when user doesn't own layer."""
        runner = LayerUpdateRunner()
        runner.settings = mock_settings

        with patch.object(
            runner, "_get_layer_full_info", new_callable=AsyncMock
        ) as mock_get_info:
            mock_get_info.side_effect = PermissionError("User X cannot update layer Y")

            params = LayerUpdateParams(
                user_id="00000000-0000-0000-0000-000000000002",
                layer_id="00000000-0000-0000-0000-000000000001",
                s3_key="uploads/test.gpkg",
            )

            result = runner.run(params)

            assert result["updated"] is False
            assert "Permission" in result["error"] or "cannot update" in result["error"]


class TestLayerUpdateRegistry:
    """Test that layer_update is properly registered."""

    def test_tool_in_registry(self):
        """Verify layer_update is in the tool registry."""
        from goatlib.tools.registry import get_tool

        tool = get_tool("layer_update")
        assert tool is not None
        assert tool.name == "layer_update"
        assert tool.module_path == "goatlib.tools.layer_update"
        assert tool.params_class_name == "LayerUpdateParams"
        assert tool.toolbox_hidden is True  # Should be hidden from toolbox UI

    def test_tool_params_class_loadable(self):
        """Verify the params class can be loaded."""
        from goatlib.tools.registry import get_tool

        tool = get_tool("layer_update")
        params_class = tool.get_params_class()
        assert params_class.__name__ == "LayerUpdateParams"

        # Verify required fields
        schema = params_class.model_json_schema()
        assert "layer_id" in schema["properties"]
        assert "s3_key" in schema["properties"]
        assert "refresh_wfs" in schema["properties"]
