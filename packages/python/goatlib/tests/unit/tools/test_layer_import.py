"""Unit tests for LayerImport tool.

Tests the layer import functionality including:
- Parameter validation
- S3 import path
- WFS import path
- Output name handling
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from goatlib.models.io import DatasetMetadata
from goatlib.tools.layer_import import (
    LayerImportParams,
    LayerImportRunner,
)


class TestLayerImportParams:
    """Test parameter validation."""

    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "folder_id": "00000000-0000-0000-0000-000000000002",
    }

    def test_valid_s3_import(self):
        """Valid params for S3 file import."""
        params = LayerImportParams(
            **self.BASE_PARAMS,
            s3_key="uploads/test.gpkg",
        )
        assert params.s3_key == "uploads/test.gpkg"
        assert params.wfs_url is None

    def test_valid_wfs_import(self):
        """Valid params for WFS import."""
        params = LayerImportParams(
            **self.BASE_PARAMS,
            wfs_url="https://wfs.example.com/wfs",
            wfs_layer_name="buildings",
        )
        assert params.wfs_url == "https://wfs.example.com/wfs"
        assert params.wfs_layer_name == "buildings"

    def test_with_metadata_fields(self):
        """Valid params with metadata fields."""
        params = LayerImportParams(
            **self.BASE_PARAMS,
            s3_key="uploads/test.gpkg",
            name="My Layer",
            description="Test layer description",
            tags=["test", "import"],
        )
        assert params.name == "My Layer"
        assert params.description == "Test layer description"
        assert params.tags == ["test", "import"]

    def test_with_wfs_options(self):
        """Valid params with WFS options."""
        params = LayerImportParams(
            **self.BASE_PARAMS,
            wfs_url="https://wfs.example.com/wfs",
            wfs_layer_name="buildings",
            data_type="mvt",
            other_properties={"min_zoom": 0, "max_zoom": 18},
        )
        assert params.data_type == "mvt"
        assert params.other_properties == {"min_zoom": 0, "max_zoom": 18}

    def test_user_id_required(self):
        """user_id is required."""
        with pytest.raises(ValueError):
            LayerImportParams(
                folder_id="00000000-0000-0000-0000-000000000002",
                s3_key="uploads/test.gpkg",
            )

    def test_folder_id_optional_with_s3(self):
        """folder_id is optional (can be derived from project_id)."""
        # This should NOT raise - folder_id is optional
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            s3_key="uploads/test.gpkg",
        )
        assert params.folder_id is None


class TestLayerImportRunner:
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
        settings.s3_access_key_id = "minioadmin"
        settings.s3_secret_access_key = "minioadmin"
        settings.postgres_server = "localhost"
        settings.postgres_port = 5432
        settings.postgres_user = "test"
        settings.postgres_password = "test"
        settings.postgres_db = "test"
        settings.ducklake_postgres_uri = "postgresql://localhost/test"
        settings.ducklake_catalog_schema = "ducklake"
        settings.ducklake_data_dir = "/tmp/ducklake"
        settings.get_s3_client = MagicMock()
        return settings

    @pytest.fixture
    def runner(self, mock_settings):
        """Create runner with mocked settings."""
        runner = LayerImportRunner()
        runner.settings = mock_settings
        runner._duckdb_con = MagicMock()
        return runner

    def test_get_feature_layer_type_is_standard(self, runner):
        """Feature layer type should be 'standard' for imports."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/test.gpkg",
        )

        result = runner.get_feature_layer_type(params)

        assert result == "standard"

    def test_default_output_name(self, runner):
        """Default output name should be set."""
        assert runner.default_output_name == "Imported Layer"


class TestLayerImportS3:
    """Test S3 import path."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked S3 client."""
        runner = LayerImportRunner()
        runner.settings = MagicMock()
        runner.settings.s3_bucket_name = "test-bucket"
        runner.settings.s3_endpoint_url = "http://localhost:9000"
        runner.settings.s3_provider = "minio"
        runner.settings.s3_region_name = "us-east-1"
        runner.settings.max_upload_dataset_file_size = 5 * 1024 * 1024 * 1024
        runner._s3_client = MagicMock()
        runner._s3_client.head_object.return_value = {"ContentLength": 1}
        runner._converter = MagicMock()
        return runner

    def test_import_from_s3_downloads_file(self, runner, tmp_path):
        """Test S3 file download."""
        output_path = tmp_path / "output.parquet"
        temp_dir = tmp_path / "temp"
        temp_dir.mkdir()

        def mock_download(**kwargs):
            Path(kwargs["Filename"]).touch()

        runner._s3_client.download_file.side_effect = mock_download

        # Mock converter with all required fields
        mock_metadata = DatasetMetadata(
            path="uploads/test.gpkg",
            source_type="vector",
            format="gpkg",
            crs="EPSG:4326",
            feature_count=100,
            geometry_type="Point",
        )
        runner._converter.to_parquet.return_value = mock_metadata

        result = runner._import_from_s3(
            s3_key="uploads/test.gpkg",
            temp_dir=temp_dir,
            output_path=output_path,
        )

        # Verify download was called
        runner._s3_client.download_file.assert_called_once()
        call_args = runner._s3_client.download_file.call_args
        assert call_args.kwargs["Bucket"] == "test-bucket"
        assert call_args.kwargs["Key"] == "uploads/test.gpkg"

        # Verify converter was called
        runner._converter.to_parquet.assert_called_once()

        assert result.feature_count == 100

    def test_import_from_s3_converts_to_wgs84(self, runner, tmp_path):
        """Test S3 import converts to EPSG:4326."""
        output_path = tmp_path / "output.parquet"
        temp_dir = tmp_path / "temp"
        temp_dir.mkdir()

        def mock_download(**kwargs):
            Path(kwargs["Filename"]).touch()

        runner._s3_client.download_file.side_effect = mock_download

        mock_metadata = DatasetMetadata(
            path="uploads/test.gpkg",
            source_type="vector",
            format="gpkg",
            crs="EPSG:4326",
            feature_count=50,
        )
        runner._converter.to_parquet.return_value = mock_metadata

        runner._import_from_s3(
            s3_key="uploads/test.gpkg",
            temp_dir=temp_dir,
            output_path=output_path,
        )

        # Verify target CRS is WGS84
        call_kwargs = runner._converter.to_parquet.call_args[1]
        assert call_kwargs["target_crs"] == "EPSG:4326"


class TestLayerImportWFS:
    """Test WFS import path."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked components."""
        runner = LayerImportRunner()
        runner.settings = MagicMock()
        return runner

    def test_import_from_wfs_calls_wfs_reader(self, runner, tmp_path):
        """Test WFS import calls from_wfs."""
        output_path = tmp_path / "output.parquet"
        temp_dir = tmp_path / "temp"
        temp_dir.mkdir()

        mock_parquet = temp_dir / "wfs_result.parquet"
        mock_parquet.touch()

        mock_metadata = DatasetMetadata(
            path="https://wfs.example.com/wfs",
            source_type="remote",
            format="wfs",
            crs="EPSG:4326",
            feature_count=200,
        )

        with patch("goatlib.io.remote_source.wfs.from_wfs") as mock_from_wfs:
            mock_from_wfs.return_value = (str(mock_parquet), mock_metadata)

            result = runner._import_from_wfs(
                wfs_url="https://wfs.example.com/wfs",
                layer_name="buildings",
                temp_dir=temp_dir,
                output_path=output_path,
            )

        mock_from_wfs.assert_called_once()
        call_kwargs = mock_from_wfs.call_args[1]
        assert call_kwargs["url"] == "https://wfs.example.com/wfs"
        assert call_kwargs["layer"] == "buildings"
        assert call_kwargs["target_crs"] == "EPSG:4326"

        assert result.feature_count == 200

    def test_import_from_wfs_raises_on_empty_result(self, runner, tmp_path):
        """Test WFS import raises on empty result."""
        output_path = tmp_path / "output.parquet"
        temp_dir = tmp_path / "temp"
        temp_dir.mkdir()

        with patch("goatlib.io.remote_source.wfs.from_wfs") as mock_from_wfs:
            mock_from_wfs.return_value = (None, None)

            with pytest.raises(ValueError, match="No data retrieved"):
                runner._import_from_wfs(
                    wfs_url="https://wfs.example.com/wfs",
                    layer_name="buildings",
                    temp_dir=temp_dir,
                    output_path=output_path,
                )


class TestLayerImportProcess:
    """Test the process method."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked components."""
        runner = LayerImportRunner()
        runner.settings = MagicMock()
        runner._import_from_s3 = MagicMock()
        runner._import_from_wfs = MagicMock()
        return runner

    def test_process_requires_source(self, runner, tmp_path):
        """Test process raises if no source provided."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            # No s3_key or wfs_url
        )

        with pytest.raises(
            ValueError, match="Either s3_key or wfs_url must be provided"
        ):
            runner.process(params, tmp_path)

    def test_process_uses_s3_for_s3_key(self, runner, tmp_path):
        """Test process uses S3 path when s3_key provided."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/test.gpkg",
        )

        mock_metadata = DatasetMetadata(
            path="uploads/test.gpkg",
            source_type="vector",
            format="gpkg",
            crs="EPSG:4326",
        )
        runner._import_from_s3.return_value = mock_metadata

        result_path, metadata = runner.process(params, tmp_path)

        runner._import_from_s3.assert_called_once()
        runner._import_from_wfs.assert_not_called()
        # Format is updated to original extension
        assert metadata.format == "gpkg"

    def test_process_uses_wfs_for_wfs_url(self, runner, tmp_path):
        """Test process uses WFS path when wfs_url provided."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            wfs_url="https://wfs.example.com/wfs",
            wfs_layer_name="buildings",
        )

        mock_metadata = DatasetMetadata(
            path="https://wfs.example.com/wfs",
            source_type="remote",
            format="original_format",
            crs="EPSG:4326",
        )
        runner._import_from_wfs.return_value = mock_metadata

        result_path, metadata = runner.process(params, tmp_path)

        runner._import_from_wfs.assert_called_once()
        runner._import_from_s3.assert_not_called()
        # Format is overridden to "wfs"
        assert metadata.format == "wfs"

    def test_process_extracts_format_from_s3_key(self, runner, tmp_path):
        """Test process extracts original format from S3 key."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/my-data.shp.zip",
        )

        mock_metadata = DatasetMetadata(
            path="uploads/my-data.shp.zip",
            source_type="vector",
            format="parquet",  # Initial format from converter
            crs="EPSG:4326",
        )
        runner._import_from_s3.return_value = mock_metadata

        result_path, metadata = runner.process(params, tmp_path)

        # Format should be updated to original extension
        assert metadata.format == "zip"

    def test_process_gets_wfs_layer_from_other_properties(self, runner, tmp_path):
        """Test WFS layer name from other_properties.layers."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            wfs_url="https://wfs.example.com/wfs",
            other_properties={"layers": ["buildings", "roads"]},
        )

        mock_metadata = DatasetMetadata(
            path="https://wfs.example.com/wfs",
            source_type="remote",
            format="wfs",
            crs="EPSG:4326",
        )
        runner._import_from_wfs.return_value = mock_metadata

        runner.process(params, tmp_path)

        # Should use first layer from other_properties.layers
        call_kwargs = runner._import_from_wfs.call_args[1]
        assert call_kwargs["layer_name"] == "buildings"


class TestLayerImportOutputName:
    """Test output name handling in run method."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked components."""
        runner = LayerImportRunner()
        runner.settings = MagicMock()
        runner.settings.customer_schema = "customer"
        return runner

    def test_output_name_from_s3_key(self, runner):
        """Test output name extracted from S3 key filename."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/my-layer-data.gpkg",
        )

        # `run` hands an upload to the multi-dataset path; the name derivation under test
        # happens before that.
        with patch.object(LayerImportRunner, "_run_multi", return_value={}):
            runner.run(params)

        assert params.output_name == "my-layer-data"

    def test_output_name_from_name_field(self, runner):
        """Test output name from explicit name field."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/test.gpkg",
            name="My Custom Name",
        )

        with patch.object(LayerImportRunner, "_run_multi", return_value={}):
            runner.run(params)

        assert params.output_name == "My Custom Name"

    def test_output_name_from_wfs_layer_name(self, runner):
        """Test output name from WFS layer name."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            wfs_url="https://wfs.example.com/wfs",
            wfs_layer_name="buildings",
        )

        with patch.object(LayerImportRunner.__bases__[0], "run", return_value={}):
            runner.run(params)

        assert params.output_name == "buildings"

    def test_output_name_wfs_fallback(self, runner):
        """Test WFS output name fallback to 'WFS Import'."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            wfs_url="https://wfs.example.com/wfs",
        )

        with patch.object(LayerImportRunner.__bases__[0], "run", return_value={}):
            runner.run(params)

        assert params.output_name == "WFS Import"

    def test_explicit_output_name_not_overridden(self, runner):
        """Test explicit output_name is not overridden."""
        params = LayerImportParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            s3_key="uploads/test.gpkg",
            output_name="Explicit Name",
        )

        with patch.object(LayerImportRunner, "_run_multi", return_value={}):
            runner.run(params)

        # Should keep explicit name
        assert params.output_name == "Explicit Name"
