"""Download router for public layer exports."""

import logging
import os
import re
import shutil
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Annotated, Optional
from uuid import UUID

import duckdb
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse

from geoapi.config import settings
from geoapi.dependencies import LayerInfoDep
from geoapi.ducklake import ducklake_manager
from geoapi.middleware.credit_metering import charge_download
from geoapi.services.layer_service import layer_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Download"])

# Thread pool for blocking DuckDB export operations
_export_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="export")

# Map user-friendly format names to GDAL driver names
FORMAT_MAP: dict[str, str] = {
    "gpkg": "GPKG",
    "geojson": "GeoJSON",
    "kml": "KML",
    "shp": "ESRI Shapefile",
    "csv": "CSV",
    "xlsx": "XLSX",
    "parquet": "Parquet",
}

# Map format to file extension
FORMAT_EXTENSION: dict[str, str] = {
    "gpkg": "gpkg",
    "geojson": "geojson",
    "kml": "kml",
    "shp": "shp",
    "csv": "csv",
    "xlsx": "xlsx",
    "parquet": "parquet",
}

SUPPORTED_FORMATS = list(FORMAT_MAP.keys())

# The target CRS is inlined into the ST_Transform call and the GDAL SRS
# option of a `COPY (...) TO file` statement, so only an EPSG code passes.
_CRS_PATTERN = re.compile(r"epsg:(\d{4,6})", re.IGNORECASE)


def _normalize_crs(crs: str | None) -> str | None:
    """Canonical `EPSG:<code>` for a requested CRS, or None for no reprojection.

    Raises:
        ValueError: If the value is not an EPSG code.
    """
    if not crs:
        return None
    match = _CRS_PATTERN.fullmatch(crs.strip())
    if not match:
        raise ValueError(
            f"Unsupported crs: {crs}. Expected an EPSG code, e.g. EPSG:4326"
        )
    return f"EPSG:{match.group(1)}"


def _get_exportable_columns(
    con: duckdb.DuckDBPyConnection, table_name: str
) -> list[str]:
    """Get column names that can be exported to OGR formats.

    Excludes STRUCT, MAP, and other complex types not supported by GDAL/OGR.

    DESCRIBE loads only this table's metadata; information_schema.columns
    would lazily load every table in the catalog to answer.
    """
    result = con.execute(f"DESCRIBE {table_name}").fetchall()

    unsupported_prefixes = ("STRUCT", "MAP", "UNION")
    exportable = []
    for col_name, col_type, *_ in result:
        if not col_type.upper().startswith(unsupported_prefixes):
            exportable.append(col_name)

    return exportable


def _has_geometry_column(con: duckdb.DuckDBPyConnection, table_name: str) -> bool:
    """Check if table has a geometry column."""
    result = con.execute(f"DESCRIBE {table_name}").fetchall()
    return any(row[0] == "geometry" for row in result)


def _interval_columns(con: duckdb.DuckDBPyConnection, table_name: str) -> set[str]:
    """Columns stored as INTERVAL (a GTFS time such as 25:10:00)."""
    return {
        col_name
        for col_name, col_type, *_ in con.execute(f"DESCRIBE {table_name}").fetchall()
        if col_type.upper() == "INTERVAL"
    }


def _build_wkt_column_exprs(
    columns: list[str],
    has_geometry: bool,
    crs: str | None,
    source_crs: str,
    text_columns: set[str] | None = None,
) -> str:
    """Build column expressions converting geometry to WKT (for CSV/XLSX).

    ``text_columns`` are written as their text: GDAL has no interval type."""
    exprs = []
    for col in columns:
        if col in (text_columns or set()):
            exprs.append(f'CAST("{col}" AS VARCHAR) AS "{col}"')
        elif col == "geometry" and has_geometry:
            if crs:
                exprs.append(
                    f"ST_AsText(ST_Transform(\"geometry\", '{source_crs}', "
                    f"'{crs}', always_xy := true)) AS \"geometry\""
                )
            else:
                exprs.append('ST_AsText("geometry") AS "geometry"')
        else:
            exprs.append(f'"{col}"')
    return ", ".join(exprs)


def _export_layer_to_file(
    table_name: str,
    output_path: str,
    output_format: str,
    crs: str | None = None,
) -> None:
    """Export a layer from DuckLake to a file.

    Runs synchronously using the ducklake_manager connection (with lock).

    Args:
        table_name: Fully qualified, quoted relation (LayerInfo.sql_relation)
        output_path: Path for the output file
        output_format: GDAL driver name
        crs: Target CRS (e.g. "EPSG:4326")

    Raises:
        ValueError: If crs is not an EPSG code.
    """
    crs = _normalize_crs(crs)
    with ducklake_manager.connection() as con:
        full_table = table_name
        exportable_columns = _get_exportable_columns(con, table_name)

        if not exportable_columns:
            raise ValueError(f"No exportable columns found for table {table_name}")

        has_geometry = _has_geometry_column(con, table_name)

        source_crs = "EPSG:4326"
        column_exprs = []
        for col in exportable_columns:
            if col == "geometry" and crs and has_geometry:
                column_exprs.append(
                    f"ST_Transform(\"geometry\", '{source_crs}', '{crs}', "
                    f'always_xy := true) AS "geometry"'
                )
            else:
                column_exprs.append(f'"{col}"')
        columns_sql = ", ".join(column_exprs)

        logger.info(
            "Exporting layer: table=%s, format=%s, crs=%s",
            table_name,
            output_format,
            crs,
        )

        if output_format == "CSV":
            csv_columns_sql = _build_wkt_column_exprs(
                exportable_columns,
                has_geometry,
                crs,
                source_crs,
                _interval_columns(con, table_name),
            )
            con.execute(f"""
                COPY (
                    SELECT {csv_columns_sql} FROM {full_table}
                ) TO '{output_path}'
                WITH (FORMAT CSV, HEADER TRUE)
            """)
        elif output_format == "XLSX":
            xlsx_columns_sql = _build_wkt_column_exprs(
                exportable_columns,
                has_geometry,
                crs,
                source_crs,
                _interval_columns(con, table_name),
            )
            con.execute(f"""
                COPY (
                    SELECT {xlsx_columns_sql} FROM {full_table}
                ) TO '{output_path}'
                WITH (FORMAT GDAL, DRIVER 'XLSX')
            """)
        elif output_format == "Parquet":
            con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {full_table}
                ) TO '{output_path}'
                WITH (FORMAT PARQUET)
            """)
        elif not has_geometry:
            # Non-spatial table with spatial format requested: fall back to CSV
            logger.warning(
                "Table has no geometry, falling back to CSV instead of %s",
                output_format,
            )
            csv_output_path = output_path.rsplit(".", 1)[0] + ".csv"
            con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {full_table}
                ) TO '{csv_output_path}'
                WITH (FORMAT CSV, HEADER TRUE)
            """)
        else:
            srs_option = f", SRS '{crs}'" if crs else ""
            con.execute(f"""
                COPY (
                    SELECT {columns_sql} FROM {full_table}
                ) TO '{output_path}'
                WITH (FORMAT GDAL, DRIVER '{output_format}'{srs_option})
            """)

        logger.info("Export complete: %s", output_path)


def _create_zip_with_metadata(
    source_dir: str,
    zip_path: str,
    file_name: str,
    file_type: str,
    crs: str | None,
) -> None:
    """Create zip file with exported data and metadata."""
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

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for root, _dirs, files in os.walk(source_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, source_dir)
                zipf.write(file_path, arcname)


def _run_export(
    table_name: str,
    file_name: str,
    file_type: str,
    gdal_format: str,
    crs: str | None,
) -> str:
    """Run the full export pipeline synchronously. Returns path to zip file."""
    export_dir = tempfile.mkdtemp(prefix="goat_download_")
    try:
        output_dir = os.path.join(export_dir, file_name)
        os.makedirs(output_dir, exist_ok=True)

        ext = FORMAT_EXTENSION.get(file_type, file_type)
        output_path = os.path.join(output_dir, f"{file_name}.{ext}")

        _export_layer_to_file(
            table_name=table_name,
            output_path=output_path,
            output_format=gdal_format,
            crs=crs,
        )

        zip_path = os.path.join(export_dir, f"{file_name}.zip")
        _create_zip_with_metadata(
            source_dir=output_dir,
            zip_path=zip_path,
            file_name=file_name,
            file_type=file_type,
            crs=crs,
        )

        return zip_path

    except Exception:
        # Clean up on error
        if os.path.exists(export_dir):
            shutil.rmtree(export_dir, ignore_errors=True)
        raise


def _cleanup_export(zip_path: str) -> None:
    """Clean up temp export directory after response is sent."""
    export_dir = os.path.dirname(zip_path)
    if os.path.exists(export_dir):
        try:
            shutil.rmtree(export_dir)
        except Exception as e:
            logger.warning("Failed to cleanup export dir %s: %s", export_dir, e)


@router.get(
    "/collections/{collectionId}/download",
    summary="Download a public layer",
    responses={
        200: {
            "description": "Layer exported as zip file",
            "content": {"application/zip": {}},
        },
        403: {"description": "Layer is not in any public project"},
        404: {"description": "Layer not found"},
    },
)
async def download_layer(
    layer_info: LayerInfoDep,
    background_tasks: BackgroundTasks,
    format: Annotated[
        str,
        Query(
            description=f"Export format: {', '.join(SUPPORTED_FORMATS)}",
        ),
    ] = "gpkg",
    crs: Annotated[
        Optional[str],
        Query(
            description="Target CRS (e.g. EPSG:4326). Default: no reprojection",
        ),
    ] = None,
) -> FileResponse:
    """Download a layer as a file.

    Only layers that belong to a published (public) project can be downloaded
    via this endpoint. No authentication is required.
    """
    # Validate format
    format_lower = format.lower()
    gdal_format = FORMAT_MAP.get(format_lower)
    if not gdal_format:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format: {format}. "
            f"Supported: {', '.join(SUPPORTED_FORMATS)}",
        )

    # Validate CRS before any work: it is inlined into the export SQL.
    try:
        target_crs = _normalize_crs(crs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Check that this layer belongs to a public project
    layer_uuid = UUID(
        f"{layer_info.layer_id[:8]}-{layer_info.layer_id[8:12]}-"
        f"{layer_info.layer_id[12:16]}-{layer_info.layer_id[16:20]}-"
        f"{layer_info.layer_id[20:]}"
    )
    is_public = await layer_service.is_layer_in_public_project(layer_uuid)
    if not is_public:
        raise HTTPException(
            status_code=403,
            detail="This layer is not available for public download. "
            "Only layers in published projects can be downloaded.",
        )

    # Get layer name for the filename
    metadata = await layer_service.get_layer_metadata(layer_info)
    file_name = metadata.name if metadata else f"layer_{layer_info.layer_id}"
    # Sanitize filename
    file_name = "".join(
        c if c.isalnum() or c in (" ", "-", "_") else "_" for c in file_name
    ).strip()

    table_name = layer_info.sql_relation

    # Run export in thread pool (DuckDB is blocking)
    import asyncio
    import time

    loop = asyncio.get_event_loop()
    started = time.monotonic()
    try:
        zip_path = await loop.run_in_executor(
            _export_executor,
            _run_export,
            table_name,
            file_name,
            format_lower,
            gdal_format,
            target_crs,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Layer export failed: %s", e)
        raise HTTPException(status_code=500, detail="Export failed")

    export_seconds = time.monotonic() - started

    # Billing on: the layer owner's organization pays the export's run time
    # and the file, like a layer export job; charged after the response.
    org_id = getattr(metadata, "organization_id", None)
    if settings.BILLING_ENABLED and org_id:
        background_tasks.add_task(
            charge_download,
            str(org_id),
            getattr(metadata, "user_id", None),
            layer_info.layer_id,
            export_seconds,
            os.path.getsize(zip_path),
        )

    # Schedule cleanup after response is sent
    background_tasks.add_task(_cleanup_export, zip_path)

    return FileResponse(
        path=zip_path,
        media_type="application/zip",
        filename=f"{file_name}.zip",
    )
