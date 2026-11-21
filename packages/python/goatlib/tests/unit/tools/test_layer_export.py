"""Unit tests for LayerExport tool.

Tests the layer export functionality including:
- Parameter validation
- Export format handling
- CRS transformation
- CQL2 filter conversion
- Column filtering (excluding unsupported types)
"""

from unittest.mock import MagicMock, patch

import duckdb
import pytest
from goatlib.tools.layer_export import (
    FORMAT_MAP,
    LayerExportOutput,
    LayerExportParams,
    LayerExportRunner,
)
from pydantic import ValidationError


class TestLayerExportParams:
    """Test parameter validation."""

    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "layer_id": "00000000-0000-0000-0000-000000000002",
        "file_name": "test_export",
    }

    def test_valid_gpkg_export(self):
        """Valid params for GeoPackage export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="gpkg",
        )
        assert params.file_type == "gpkg"
        assert params.crs is None
        assert params.query is None

    def test_valid_geojson_export(self):
        """Valid params for GeoJSON export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="geojson",
        )
        assert params.file_type == "geojson"

    def test_valid_csv_export(self):
        """Valid params for CSV export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="csv",
        )
        assert params.file_type == "csv"

    def test_valid_xlsx_export(self):
        """Valid params for Excel export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="xlsx",
        )
        assert params.file_type == "xlsx"

    def test_valid_parquet_export(self):
        """Valid params for Parquet export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="parquet",
        )
        assert params.file_type == "parquet"

    def test_valid_shapefile_export(self):
        """Valid params for Shapefile export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="shp",
        )
        assert params.file_type == "shp"

    def test_valid_kml_export(self):
        """Valid params for KML export."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="kml",
        )
        assert params.file_type == "kml"

    def test_with_crs_transformation(self):
        """Valid params with CRS transformation."""
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="gpkg",
            crs="EPSG:3857",
        )
        assert params.crs == "EPSG:3857"

    def test_text_query_is_refused(self):
        """The filter is a CQL2 object: text would reach the query as SQL."""
        with pytest.raises(ValidationError):
            LayerExportParams(
                **self.BASE_PARAMS,
                file_type="geojson",
                query="status = 'active'",
            )

    def test_with_cql2_dict_filter(self):
        """Valid params with CQL2 dict filter."""
        cql2_filter = {
            "op": "=",
            "args": [{"property": "status"}, "active"],
        }
        params = LayerExportParams(
            **self.BASE_PARAMS,
            file_type="geojson",
            query=cql2_filter,
        )
        assert params.query == cql2_filter

    def test_layer_id_required(self):
        """layer_id is required."""
        with pytest.raises(ValueError):
            LayerExportParams(
                user_id="00000000-0000-0000-0000-000000000001",
                file_type="gpkg",
                file_name="test",
            )

    def test_file_type_required(self):
        """file_type is required."""
        with pytest.raises(ValueError):
            LayerExportParams(
                user_id="00000000-0000-0000-0000-000000000001",
                layer_id="00000000-0000-0000-0000-000000000002",
                file_name="test",
            )

    def test_file_name_required(self):
        """file_name is required."""
        with pytest.raises(ValueError):
            LayerExportParams(
                user_id="00000000-0000-0000-0000-000000000001",
                layer_id="00000000-0000-0000-0000-000000000002",
                file_type="gpkg",
            )


class TestLayerExportOutput:
    """Test output schema."""

    def test_successful_output(self):
        """Test successful export output."""
        output = LayerExportOutput(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            name="Test Export",
            folder_id="00000000-0000-0000-0000-000000000003",
            s3_key="users/xxx/exports/test.zip",
            download_url="https://s3.example.com/presigned-url",
            file_name="test.gpkg",
            file_size_bytes=1024,
            format="gpkg",
        )
        assert output.error is None
        assert output.download_url is not None
        assert output.file_size_bytes == 1024

    def test_error_output(self):
        """Test error output."""
        output = LayerExportOutput(
            user_id="00000000-0000-0000-0000-000000000001",
            layer_id="00000000-0000-0000-0000-000000000002",
            name="",
            folder_id="",
            error="Layer not found",
        )
        assert output.error == "Layer not found"
        assert output.download_url is None


class TestFormatMap:
    """Test FORMAT_MAP covers all expected formats."""

    def test_gpkg_mapping(self):
        """GeoPackage maps to GPKG driver."""
        assert FORMAT_MAP["gpkg"] == "GPKG"
        assert FORMAT_MAP["geopackage"] == "GPKG"

    def test_geojson_mapping(self):
        """GeoJSON maps correctly."""
        assert FORMAT_MAP["geojson"] == "GeoJSON"
        assert FORMAT_MAP["json"] == "GeoJSON"

    def test_shapefile_mapping(self):
        """Shapefile maps to ESRI Shapefile."""
        assert FORMAT_MAP["shp"] == "ESRI Shapefile"
        assert FORMAT_MAP["shapefile"] == "ESRI Shapefile"

    def test_csv_mapping(self):
        """CSV maps correctly."""
        assert FORMAT_MAP["csv"] == "CSV"

    def test_xlsx_mapping(self):
        """XLSX maps correctly."""
        assert FORMAT_MAP["xlsx"] == "XLSX"

    def test_kml_mapping(self):
        """KML maps correctly."""
        assert FORMAT_MAP["kml"] == "KML"

    def test_parquet_mapping(self):
        """Parquet maps correctly."""
        assert FORMAT_MAP["parquet"] == "Parquet"


def _catalog_returns(runner, schema):
    """Make the mocked connection answer the schema lookup with `schema`."""
    runner._duckdb_con.execute.return_value.fetchone.return_value = (schema,)


class TestLayerExportRunner:
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
        return settings

    @pytest.fixture
    def runner(self, mock_settings):
        """Create runner with mocked settings."""
        runner = LayerExportRunner()
        runner.settings = mock_settings
        runner._duckdb_con = MagicMock()
        return runner

    def test_get_table_name_own_layer(self, runner):
        """Test table name for own layer."""
        with patch.object(
            runner,
            "get_layer_owner_id_sync",
            return_value="00000000-0000-0000-0000-000000000001",
        ):
            _catalog_returns(runner, "user_00000000000000000000000000000001")
            table_name = runner._get_table_name(
                "00000000-0000-0000-0000-000000000002",
                "00000000-0000-0000-0000-000000000001",
            )
            assert (
                table_name
                == "lake.user_00000000000000000000000000000001.t_00000000000000000000000000000002"
            )

    def test_get_table_name_shared_layer(self, runner):
        """Test table name for shared layer (owner differs from user)."""
        # Layer is owned by user 99, not user 01
        with patch.object(
            runner,
            "get_layer_owner_id_sync",
            return_value="00000000-0000-0000-0000-000000000099",
        ):
            _catalog_returns(runner, "user_00000000000000000000000000000099")
            table_name = runner._get_table_name(
                "00000000-0000-0000-0000-000000000002",
                "00000000-0000-0000-0000-000000000001",  # Requesting user
            )
            # Should use actual owner's schema
            assert "user_00000000000000000000000000000099" in table_name

    def test_get_table_name_owner_lookup_fails(self, runner):
        """Test table name when owner lookup fails (fallback to user_id)."""
        with patch.object(runner, "get_layer_owner_id_sync", return_value=None):
            # Catalog has no such table, so the computed path is the answer.
            runner._duckdb_con.execute.return_value.fetchone.return_value = None
            table_name = runner._get_table_name(
                "00000000-0000-0000-0000-000000000002",
                "00000000-0000-0000-0000-000000000001",
            )
            # No table in the catalog, so the answer is where a new one would
            # go — the flat schema, which no longer encodes an owner.
            assert table_name == "lake.main.t_00000000000000000000000000000002"

    def test_get_exportable_columns_filters_struct(self, runner):
        """Test that STRUCT columns are excluded."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "VARCHAR"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
            ("metadata", "STRUCT(a VARCHAR, b INTEGER)"),
            ("tags", "VARCHAR[]"),
        ]

        names = [
            col for col, _ in runner._get_exportable_columns("lake.user_xxx.t_yyy")
        ]

        assert "id" in names
        assert "name" in names
        assert "geometry" in names
        assert "tags" in names
        assert "metadata" not in names  # STRUCT excluded

    def test_get_exportable_columns_filters_map(self, runner):
        """Test that MAP columns are excluded."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "VARCHAR"),
            ("properties", "MAP(VARCHAR, VARCHAR)"),
            ("geometry", "GEOMETRY"),
        ]

        names = [
            col for col, _ in runner._get_exportable_columns("lake.user_xxx.t_yyy")
        ]

        assert "id" in names
        assert "geometry" in names
        assert "properties" not in names  # MAP excluded

    def test_has_geometry_column_true(self, runner):
        """Test geometry column detection - has geometry."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "BIGINT", "YES", None, None, None),
            ("geometry", "GEOMETRY", "YES", None, None, None),
        ]

        result = runner._has_geometry_column("lake.user_xxx.t_yyy")

        assert result is True

    def test_has_geometry_column_false(self, runner):
        """Test geometry column detection - no geometry."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "BIGINT", "YES", None, None, None),
        ]

        result = runner._has_geometry_column("lake.user_xxx.t_yyy")

        assert result is False

    def test_convert_cql2_to_sql_refuses_text(self, runner):
        """Text never becomes part of the query, whoever passes it."""
        with pytest.raises(ValueError):
            runner._convert_cql2_to_sql("status = 'active'", "lake.user_xxx.t_yyy")

    def test_convert_cql2_to_sql_none(self, runner):
        """Test that None query returns None."""
        result = runner._convert_cql2_to_sql(None, "lake.user_xxx.t_yyy")

        assert result is None

    def test_convert_cql2_to_sql_dict(self, runner):
        """Test CQL2 dict conversion."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("status", "VARCHAR"),
            ("name", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]

        cql2_filter = {
            "op": "=",
            "args": [{"property": "status"}, "active"],
        }

        result = runner._convert_cql2_to_sql(cql2_filter, "lake.user_xxx.t_yyy")

        assert result == "(\"status\" = 'active')"


class TestLayerExportCRS:
    """Test CRS transformation logic."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked DuckDB connection."""
        runner = LayerExportRunner()
        runner.settings = MagicMock()
        runner._duckdb_con = MagicMock()
        return runner

    def test_export_builds_transform_sql_for_crs(self, runner):
        """Test that CRS transformation SQL is built correctly."""
        runner._duckdb_con.execute.return_value.fetchall.return_value = [
            ("id", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]
        runner._duckdb_con.execute.return_value.fetchone.return_value = ("geometry",)

        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.gpkg",
                output_format="GPKG",
                crs="EPSG:3857",
            )

            # Verify SQL contains ST_Transform with always_xy
            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "ST_Transform" in sql
            assert "EPSG:4326" in sql  # Source CRS
            assert "EPSG:3857" in sql  # Target CRS
            assert "always_xy := true" in sql  # Ensure correct coordinate order

    def test_export_no_transform_without_crs(self, runner):
        """Test that no transformation happens when CRS is None."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.gpkg",
                output_format="GPKG",
                crs=None,
            )

            # Verify SQL does NOT contain ST_Transform
            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "ST_Transform" not in sql

    def test_csv_export_transforms_to_wkt(self, runner):
        """Test CSV export converts geometry to WKT."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.csv",
                output_format="CSV",
                crs=None,
            )

            # Verify SQL contains ST_AsText for WKT conversion
            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "ST_AsText" in sql
            assert "FORMAT CSV" in sql

    def test_csv_export_with_crs_transforms_then_wkt(self, runner):
        """Test CSV export with CRS transforms first, then converts to WKT."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.csv",
                output_format="CSV",
                crs="EPSG:3857",
            )

            # Verify SQL contains both ST_Transform with always_xy and ST_AsText
            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "ST_AsText" in sql
            assert "ST_Transform" in sql
            assert "EPSG:3857" in sql
            assert "always_xy := true" in sql  # Ensure correct coordinate order


class TestLayerExportFormats:
    """Test different export format handling."""

    @pytest.fixture
    def runner(self):
        """Create runner with mocked DuckDB connection."""
        runner = LayerExportRunner()
        runner.settings = MagicMock()
        runner._duckdb_con = MagicMock()
        return runner

    def test_parquet_uses_native_format(self, runner):
        """Test Parquet export uses native DuckDB format."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.parquet",
                output_format="Parquet",
            )

            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "FORMAT PARQUET" in sql

    def test_gpkg_uses_gdal_driver(self, runner):
        """Test GeoPackage export uses GDAL driver."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.gpkg",
                output_format="GPKG",
            )

            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "FORMAT GDAL" in sql
            assert "DRIVER 'GPKG'" in sql

    def test_xlsx_uses_gdal_driver(self, runner):
        """Test XLSX export uses GDAL driver with WKT geometry."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("geometry", "GEOMETRY")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=True),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.xlsx",
                output_format="XLSX",
            )

            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "ST_AsText" in sql  # Geometry as WKT
            assert "FORMAT GDAL" in sql
            assert "DRIVER 'XLSX'" in sql

    def test_non_spatial_falls_back_to_csv(self, runner):
        """Test non-spatial table export falls back to CSV."""
        with (
            patch.object(runner, "_get_table_name", return_value="lake.user_xxx.t_yyy"),
            patch.object(
                runner,
                "_get_exportable_columns",
                return_value=[("id", "VARCHAR"), ("name", "VARCHAR")],
            ),
            patch.object(runner, "_has_geometry_column", return_value=False),
            patch.object(runner, "_convert_cql2_to_sql", return_value=None),
        ):
            runner._export_to_file(
                layer_id="xxx",
                user_id="yyy",
                output_path="/tmp/test.gpkg",  # Requested GPKG
                output_format="GPKG",
            )

            call_args = runner._duckdb_con.execute.call_args_list[-1]
            sql = call_args[0][0]
            assert "FORMAT CSV" in sql  # Falls back to CSV


class TestGeoPackageWithFidColumn:
    """A dataset with its own `fid` column, common in data that came from a
    GeoPackage or QGIS, exports to GeoPackage with that column intact."""

    @pytest.fixture
    def runner(self, tmp_path):
        geojson = tmp_path / "stops.geojson"
        geojson.write_text(
            '{"type": "FeatureCollection", "features": ['
            + ", ".join(
                f'{{"type": "Feature", "properties": {{"fid": {fid}, "name": "s{fid}"}},'
                f' "geometry": {{"type": "Point", "coordinates": [11.5, 48.{fid}]}}}}'
                for fid in (7, 3, 42)
            )
            + "]}"
        )
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial")
        # The relation shape DuckLake layers have: lake.<schema>.<table>.
        con.execute("ATTACH ':memory:' AS lake")
        con.execute(
            "CREATE TABLE lake.main.t_stops AS SELECT fid, name, geom AS geometry"
            f" FROM ST_Read('{geojson}')"
        )
        runner = LayerExportRunner()
        runner._duckdb_con = con
        yield runner
        con.close()

    def test_the_fid_column_survives_a_geopackage_export(self, runner, tmp_path):
        output = tmp_path / "stops.gpkg"
        with patch.object(runner, "_get_table_name", return_value="lake.main.t_stops"):
            runner._export_to_file(
                layer_id="00000000-0000-0000-0000-000000000001",
                user_id="00000000-0000-0000-0000-000000000002",
                output_path=str(output),
                output_format="GPKG",
            )

        rows = runner._duckdb_con.execute(
            f"SELECT fid, name FROM ST_Read('{output}') ORDER BY name"
        ).fetchall()
        assert rows == [(3, "s3"), (42, "s42"), (7, "s7")]
