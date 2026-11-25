"""LayerExport Tool - Export layers to various file formats.

This tool exports layers from DuckLake to file formats like:
- GPKG (GeoPackage)
- GeoJSON
- CSV
- KML
- Shapefile

The exported file is uploaded to S3 and a presigned download URL is returned.

Usage:
    from goatlib.tools.layer_export import LayerExportParams, main

    result = main(LayerExportParams(
        user_id="...",
        layer_id="...",
        file_type="gpkg",
        file_name="my_export",
    ))
"""

import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OPTIONS,
    SECTION_OUTPUT,
    ui_field,
    ui_sections,
)
from goatlib.tools.base import SimpleToolRunner
from goatlib.tools.schemas import ToolInputBase, ToolOutputBase
from goatlib.utils.layer import (
    quoted_relation,
)

logger = logging.getLogger(__name__)


# Map user-friendly format names to GDAL driver names
FORMAT_MAP = {
    "gpkg": "GPKG",
    "geopackage": "GPKG",
    "geojson": "GeoJSON",
    "json": "GeoJSON",
    "kml": "KML",
    "shp": "ESRI Shapefile",
    "shapefile": "ESRI Shapefile",
    "csv": "CSV",
    "xlsx": "XLSX",  # Handled specially, not via GDAL
    "parquet": "Parquet",
}


class LayerExportParams(ToolInputBase):
    """Parameters for LayerExport tool."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            SECTION_OUTPUT,
            SECTION_OPTIONS,
        )
    )

    layer_id: str = Field(
        ...,
        description="ID of the layer to export",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    file_type: str = Field(
        ...,
        description="Output file format (gpkg, geojson, csv, xlsx, kml, shp, parquet)",
        json_schema_extra=ui_field(
            section="output",
            field_order=1,
            widget="select",
            widget_options={
                "options": [
                    {"value": "gpkg", "label": "GeoPackage"},
                    {"value": "geojson", "label": "GeoJSON"},
                    {"value": "csv", "label": "CSV"},
                    {"value": "xlsx", "label": "Excel"},
                    {"value": "kml", "label": "KML"},
                    {"value": "shp", "label": "Shapefile"},
                    {"value": "parquet", "label": "Parquet"},
                ]
            },
        ),
    )
    file_name: str = Field(
        ...,
        description="Output filename (without extension)",
        json_schema_extra=ui_field(section="output", field_order=2),
    )
    crs: str | None = Field(
        None,
        description="Target CRS for reprojection (e.g., EPSG:4326)",
        json_schema_extra=ui_field(
            section="options",
            field_order=1,
            widget="crs-selector",
        ),
    )
    query: dict[str, Any] | None = Field(
        None,
        description="CQL2 filter to filter features",
        json_schema_extra=ui_field(
            section="options",
            field_order=2,
        ),
    )
    layer_owner_id: str | None = Field(
        None,
        description="Owner user ID of the layer (used for shared/catalog layers)",
        json_schema_extra=ui_field(section="output", field_order=95, hidden=True),
    )
    # user_id inherited from ToolInputBase


class LayerExportOutput(ToolOutputBase):
    """Output schema for LayerExport tool."""

    layer_id: str
    s3_key: str | None = None
    download_url: str | None = None
    file_name: str | None = None
    file_size_bytes: int | None = None
    format: str | None = None
    error: str | None = None


class LayerExportRunner(SimpleToolRunner):
    """Runner for LayerExport tool.

    Extends SimpleToolRunner for shared infrastructure (DuckDB, S3, settings, logging).
    """

    def _get_table_name(
        self: Self, layer_id: str, user_id: str, layer_owner_id: str | None = None
    ) -> str:
        """Build DuckLake table name for the layer owner.

        Uses layer_owner_id when provided (e.g., for shared/catalog layers).
        Falls back to a PostgreSQL lookup, then to user_id as last resort.

        Args:
            layer_id: Layer UUID string
            user_id: Fallback user UUID if owner cannot be determined
            layer_owner_id: Explicit owner UUID (skips PostgreSQL lookup)

        Returns:
            Fully qualified table name: lake.user_{owner_id}.t_{layer_id}
        """
        if layer_owner_id is None:
            layer_owner_id = self.get_layer_owner_id_sync(layer_id)
        if layer_owner_id is None:
            logger.warning(
                "Could not determine layer owner for layer %s, falling back to user_id %s",
                layer_id,
                user_id,
            )
            layer_owner_id = user_id

        return self.resolve_layer_table_path(layer_id)

    def _get_column_types(self: Self, table_name: str) -> dict[str, str]:
        """Get the column names of a table with their DuckDB types.

        DESCRIBE loads only this table's metadata; information_schema.columns
        would lazily load every table in the catalog to answer.
        """
        result = self.duckdb_con.execute(
            f"DESCRIBE {quoted_relation(table_name)}"
        ).fetchall()
        return {str(row[0]): str(row[1]) for row in result}

    def _get_exportable_columns(self: Self, table_name: str) -> list[tuple[str, str]]:
        """Get column names and types that can be exported to OGR formats.

        Excludes STRUCT and other complex types not supported by GDAL/OGR.

        Args:
            table_name: Full qualified table name (lake.schema.table)

        Returns:
            List of (column_name, data_type) tuples safe for OGR export
        """
        # Get columns with their types (DESCRIBE loads only this table's
        # metadata; information_schema would lazily load the whole catalog)
        result = self.duckdb_con.execute(
            f"DESCRIBE {quoted_relation(table_name)}"
        ).fetchall()

        # Filter out complex/binary types not supported by OGR
        unsupported_prefixes = (
            "STRUCT",
            "MAP",
            "UNION",
            "LIST",
            "ARRAY",
            "BLOB",
            "BIT",
        )
        exportable = []
        for col_name, col_type, *_ in result:
            if not col_type.upper().startswith(unsupported_prefixes):
                exportable.append((col_name, col_type.upper()))
            else:
                logger.debug(
                    "Excluding column '%s' with unsupported type '%s' from export",
                    col_name,
                    col_type,
                )

        return exportable

    @staticmethod
    def _cast_column_expr(col: str, col_type: str) -> str:
        """Return a SQL expression that casts unsupported OGR types.

        Args:
            col: Column name
            col_type: Uppercase DuckDB data type

        Returns:
            SQL column expression, with CAST if needed
        """
        if col_type.startswith("DECIMAL") or col_type.startswith("NUMERIC"):
            return f'CAST("{col}" AS DOUBLE) AS "{col}"'
        if col_type in ("HUGEINT", "UHUGEINT"):
            return f'CAST("{col}" AS BIGINT) AS "{col}"'
        if col_type in ("UUID", "INTERVAL") or col_type.startswith("JSON"):
            return f'CAST("{col}" AS VARCHAR) AS "{col}"'
        return f'"{col}"'

    def _convert_cql2_to_sql(
        self: Self, query: dict[str, Any] | None, table_name: str
    ) -> str | None:
        """Convert CQL2 filter dict to SQL WHERE clause.

        Args:
            query: CQL2 filter dict; text is refused, as it would reach the query as SQL
            table_name: Table name for column validation

        Returns:
            SQL WHERE clause string with parameters substituted, or None

        Raises:
            UnreadableFilterError: A CQL2 filter it cannot apply. Exported
                without it, the file would hold the whole layer.
        """
        if query is None:
            return None

        # Only a CQL2 object, which becomes a checked clause with its values as parameters.
        if not isinstance(query, dict):
            raise ValueError("The export filter must be a CQL2 object.")

        from goatlib.storage import checked_cql_filter, inline_params

        filters = checked_cql_filter(query, self._get_column_types(table_name))
        if not filters.clauses:
            return None
        # Inlined: COPY doesn't support parameterized queries
        return inline_params(filters.to_full_where(), filters.params)

    def _has_geometry_column(self: Self, table_name: str) -> bool:
        """Check if table has a geometry column.

        Args:
            table_name: Full qualified table name (lake.schema.table)

        Returns:
            True if table has a geometry column
        """
        result = self.duckdb_con.execute(
            f"DESCRIBE {quoted_relation(table_name)}"
        ).fetchall()
        return any(row[0] == "geometry" for row in result)

    def _export_to_file(
        self: Self,
        layer_id: str,
        user_id: str,
        output_path: str,
        output_format: str,
        crs: str | None = None,
        query: dict[str, Any] | None = None,
        layer_owner_id: str | None = None,
    ) -> None:
        """Export layer from DuckLake to file.

        Args:
            layer_id: Layer UUID
            user_id: User UUID (fallback if layer owner lookup fails)
            output_path: Path for output file
            output_format: GDAL driver name (GPKG, GeoJSON, etc.)
            crs: Target CRS for reprojection (e.g., "EPSG:4326")
            query: CQL2 filter dict
            layer_owner_id: Explicit owner UUID for shared/catalog layers
        """
        table_name = self._get_table_name(layer_id, user_id, layer_owner_id)

        # Get columns that can be exported to OGR formats
        # (excludes STRUCT, MAP, and other unsupported types)
        exportable_columns = self._get_exportable_columns(table_name)
        if not exportable_columns:
            raise ValueError(
                f"No exportable columns found for table '{table_name}'. "
                "The layer may not exist in DuckLake or the owner lookup failed."
            )

        # Check if table has geometry
        has_geometry = self._has_geometry_column(table_name)

        # Build column selection, applying CRS transformation to geometry if needed
        # DuckDB ST_Transform requires both source and target CRS
        # Data is stored in EPSG:4326
        # IMPORTANT: Use always_xy := true to ensure consistent coordinate ordering
        # Without this, EPSG:4326 (which has lat/lon axis order per standard) would
        # be interpreted incorrectly, causing coordinate swapping issues
        source_crs = "EPSG:4326"
        column_exprs = []
        for col, col_type in exportable_columns:
            if col == "geometry" and crs and has_geometry:
                # Transform geometry from source CRS to target CRS
                # always_xy ensures lon/lat (x/y) ordering regardless of CRS definition
                column_exprs.append(
                    f"ST_Transform(\"geometry\", '{source_crs}', '{crs}', always_xy := true) AS \"geometry\""
                )
            else:
                column_exprs.append(self._cast_column_expr(col, col_type))
        columns_sql = ", ".join(column_exprs)

        # Convert CQL2 filter to SQL if needed
        sql_query = self._convert_cql2_to_sql(query, table_name)
        where_clause = f"WHERE {sql_query}" if sql_query else ""

        logger.info(
            "Exporting layer: table=%s, format=%s, output=%s, crs=%s, has_geometry=%s",
            table_name,
            output_format,
            output_path,
            crs,
            has_geometry,
        )

        # For CSV/XLSX/Parquet formats, use DuckDB's native export
        # GDAL drivers don't handle non-spatial data or these formats well
        if output_format == "CSV":
            # For CSV, convert geometry to WKT string for readability
            csv_column_exprs = []
            for col, col_type in exportable_columns:
                if col == "geometry" and has_geometry:
                    if crs:
                        # Transform and convert to WKT
                        # always_xy ensures lon/lat (x/y) ordering
                        csv_column_exprs.append(
                            f"ST_AsText(ST_Transform(\"geometry\", '{source_crs}', '{crs}', always_xy := true)) AS \"geometry\""
                        )
                    else:
                        csv_column_exprs.append('ST_AsText("geometry") AS "geometry"')
                else:
                    csv_column_exprs.append(self._cast_column_expr(col, col_type))
            csv_columns_sql = ", ".join(csv_column_exprs)

            # Use native DuckDB CSV export
            self.duckdb_con.execute(f"""
                COPY (
                    SELECT {csv_columns_sql} FROM {table_name}
                    {where_clause}
                ) TO '{output_path}'
                WITH (FORMAT CSV, HEADER TRUE)
            """)
        elif output_format == "XLSX":
            # For XLSX, convert geometry to WKT string since GDAL XLSX driver
            # doesn't support geometry columns directly
            xlsx_column_exprs = []
            for col, col_type in exportable_columns:
                if col == "geometry" and has_geometry:
                    if crs:
                        # Transform and convert to WKT
                        # always_xy ensures lon/lat (x/y) ordering
                        xlsx_column_exprs.append(
                            f"ST_AsText(ST_Transform(\"geometry\", '{source_crs}', '{crs}', always_xy := true)) AS \"geometry\""
                        )
                    else:
                        xlsx_column_exprs.append('ST_AsText("geometry") AS "geometry"')
                else:
                    xlsx_column_exprs.append(self._cast_column_expr(col, col_type))
            xlsx_columns_sql = ", ".join(xlsx_column_exprs)

            # Use DuckDB's COPY TO with GDAL XLSX driver
            # The spatial extension provides XLSX export via GDAL
            self.duckdb_con.execute(f"""
                COPY (
                    SELECT {xlsx_columns_sql} FROM {table_name}
                    {where_clause}
                ) TO '{output_path}'
                WITH (FORMAT GDAL, DRIVER 'XLSX')
            """)
        elif output_format == "Parquet":
            # Use native DuckDB Parquet export
            self.duckdb_con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {table_name}
                    {where_clause}
                ) TO '{output_path}'
                WITH (FORMAT PARQUET)
            """)
        elif not has_geometry:
            # For non-spatial tables with spatial formats requested,
            # fall back to CSV export since GDAL requires geometry
            logger.warning(
                "Table has no geometry column, falling back to CSV export "
                "instead of %s",
                output_format,
            )
            # Change output path extension to .csv
            csv_output_path = output_path.rsplit(".", 1)[0] + ".csv"
            self.duckdb_con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {table_name}
                    {where_clause}
                ) TO '{csv_output_path}'
                WITH (FORMAT CSV, HEADER TRUE)
            """)
        else:
            # Build GDAL COPY options for spatial formats
            # SRS sets the spatial reference metadata in the output file
            srs_option = f", SRS '{crs}'" if crs else ""
            # A GeoPackage keeps its row id in a column named "fid" and refuses
            # a dataset column of that name whose values are not the ids it
            # assigns. Such a dataset gets a row id column of another name.
            column_names = {col.lower() for col, _ in exportable_columns}
            if output_format == "GPKG" and "fid" in column_names:
                row_id = "gpkg_fid"
                while row_id in column_names:
                    row_id = f"_{row_id}"
                srs_option += f", LAYER_CREATION_OPTIONS 'FID={row_id}'"

            # Use DuckDB's COPY TO with GDAL writer
            self.duckdb_con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {table_name}
                    {where_clause}
                ) TO '{output_path}'
                WITH (FORMAT GDAL, DRIVER '{output_format}'{srs_option})
            """)

        logger.info("Export complete: %s", output_path)

    def _create_zip_with_metadata(
        self: Self,
        source_dir: str,
        zip_path: str,
        file_name: str,
        file_type: str,
        crs: str | None,
    ) -> None:
        """Create zip file with exported data and metadata.

        Args:
            source_dir: Directory containing exported file(s)
            zip_path: Output zip file path
            file_name: Base filename
            file_type: Export format
            crs: CRS used for export
        """
        # Create metadata file
        metadata_path = os.path.join(source_dir, "metadata.txt")
        with open(metadata_path, "w") as f:
            f.write("=" * 60 + "\n")
            f.write(f"GOAT Layer Export: {file_name}\n")
            f.write("=" * 60 + "\n")
            f.write(f"Exported: {datetime.now().isoformat()}\n")
            f.write(f"Format: {file_type}\n")
            if crs:
                f.write(f"CRS: {crs}\n")
            f.write("=" * 60 + "\n")

        # Create zip
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(source_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, source_dir)
                    zipf.write(file_path, arcname)

    def _upload_to_s3(self: Self, file_path: str, user_id: str, file_name: str) -> str:
        """Upload file to S3 and return the S3 key.

        Args:
            file_path: Local file path
            user_id: User UUID for path prefix
            file_name: Filename for S3 key

        Returns:
            S3 key
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        s3_key = f"users/{user_id}/exports/{file_name}_{timestamp}.zip"

        logger.info("Uploading to S3: %s", s3_key)

        with open(file_path, "rb") as f:
            self.s3_client.upload_fileobj(
                f,
                self.settings.s3_bucket_name,
                s3_key,
                ExtraArgs={"ContentType": "application/zip"},
            )

        logger.info("Upload complete: %s", s3_key)
        return s3_key

    def _generate_presigned_url(self: Self, s3_key: str, file_name: str) -> str:
        """Generate presigned download URL.

        Args:
            s3_key: S3 object key
            file_name: Filename for Content-Disposition header

        Returns:
            Presigned URL (valid for 24 hours)
        """
        # Use public S3 client to generate URLs accessible from outside the cluster
        # The s3_public_client MUST be configured with the public endpoint URL
        # (e.g., localhost:9000) for the signature to be valid when accessed from browser
        url = self.s3_public_client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.settings.s3_bucket_name,
                "Key": s3_key,
                "ResponseContentDisposition": f'attachment; filename="{file_name}"',
            },
            ExpiresIn=86400,  # 24 hours
        )

        return url

    def run(self: Self, params: LayerExportParams) -> dict:
        """Run the layer export.

        Args:
            params: Export parameters

        Returns:
            LayerExportOutput as dict
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized. Call init_from_env() first.")

        logger.info(
            "Starting layer export: user=%s, layer=%s, format=%s",
            params.user_id,
            params.layer_id,
            params.file_type,
        )

        # Build wm_labels for Windmill job tracking
        wm_labels: list[str] = []
        if params.triggered_by_email:
            wm_labels.append(params.triggered_by_email)

        output = LayerExportOutput(
            layer_id=params.layer_id,
            name=params.file_name,
            folder_id="",
            user_id=params.user_id,
            format=params.file_type,
            wm_labels=wm_labels,
        )

        export_dir = None

        try:
            # Validate format
            gdal_format = FORMAT_MAP.get(params.file_type.lower())
            if not gdal_format:
                raise ValueError(
                    f"Unsupported format: {params.file_type}. "
                    f"Supported: {', '.join(FORMAT_MAP.keys())}"
                )

            # Create temp directory
            export_dir = tempfile.mkdtemp(prefix="goat_export_")
            output_dir = os.path.join(export_dir, params.file_name)
            os.makedirs(output_dir, exist_ok=True)

            # Export file
            output_path = os.path.join(
                output_dir, f"{params.file_name}.{params.file_type}"
            )
            self._export_to_file(
                layer_id=params.layer_id,
                user_id=params.user_id,
                output_path=output_path,
                output_format=gdal_format,
                crs=params.crs,
                query=params.query,
                layer_owner_id=params.layer_owner_id,
            )

            # Create zip
            zip_path = os.path.join(export_dir, f"{params.file_name}.zip")
            self._create_zip_with_metadata(
                source_dir=output_dir,
                zip_path=zip_path,
                file_name=params.file_name,
                file_type=params.file_type,
                crs=params.crs,
            )

            # Get file size
            file_size = os.path.getsize(zip_path)
            output.file_size_bytes = file_size

            # Upload to S3
            s3_key = self._upload_to_s3(
                file_path=zip_path,
                user_id=params.user_id,
                file_name=params.file_name,
            )
            output.s3_key = s3_key

            # Generate download URL
            download_url = self._generate_presigned_url(
                s3_key=s3_key,
                file_name=f"{params.file_name}.zip",
            )
            output.download_url = download_url
            output.file_name = f"{params.file_name}.zip"

            logger.info(
                "Layer export complete: layer=%s, size=%d bytes, s3_key=%s",
                params.layer_id,
                file_size,
                s3_key,
            )

        except Exception as e:
            output.error = str(e)
            logger.error("Layer export failed: %s", e)
            # Re-raise to mark job as failed in Windmill
            raise

        finally:
            # Cleanup temp files
            if export_dir and os.path.exists(export_dir):
                try:
                    shutil.rmtree(export_dir)
                except Exception as cleanup_error:
                    logger.warning("Failed to cleanup: %s", cleanup_error)

            self.cleanup()

        return output.model_dump()


def main(params: LayerExportParams) -> dict:
    """Windmill entry point for LayerExport.

    Args:
        params: Validated LayerExportParams

    Returns:
        LayerExportOutput as dict
    """
    runner = LayerExportRunner()
    runner.init_from_env()
    return runner.run(params)
