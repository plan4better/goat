import json
import logging
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from duckdb import DuckDBPyConnection
from pydantic import BaseModel, Field
from pyproj import CRS

from goatlib.io.formats import allowed_drivers_sql
from goatlib.io.sql import sql_identifier

logger = logging.getLogger(__name__)


PathType = Literal["local", "s3", "http"]


def detect_path_type(path: str) -> PathType:
    """
    Detect the type of the given path: local, s3, or http.
    """
    scheme = urlparse(path).scheme.lower()
    if scheme in {"s3"}:
        return "s3"
    if scheme in {"http", "https"}:
        return "http"
    return "local"


def download_if_remote(src_path: str, timeout: int | None = None) -> str:
    """
    Download HTTP/HTTPS sources to a local temp file.
    Returns the local path. If the path is local, returns it unchanged.
    """
    path_type = detect_path_type(src_path)
    if path_type == "local":
        return src_path
    if path_type != "http":
        return src_path  # Only handle HTTP/HTTPS

    effective_timeout = timeout if timeout is not None else 120
    logger.info("Downloading remote file: %s", src_path)

    try:
        req = urllib.request.Request(src_path, headers={"User-Agent": "goatlib/1.0"})
        with urllib.request.urlopen(req, timeout=effective_timeout) as response:
            tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_http_"))
            filename = Path(urlparse(src_path).path).name or "downloaded_file"
            tmp_file = tmp_dir / filename

            with open(tmp_file, "wb") as f:
                while chunk := response.read(8192):
                    f.write(chunk)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP error {e.code}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"URL error: {e.reason}") from e

    logger.info("Downloaded %s → %s", src_path, tmp_file)
    return str(tmp_file)


class ColumnMeta(BaseModel):
    name: str
    type: str
    nullable: bool


class Metadata(BaseModel):
    geometry_column: str | None = Field(
        None, description="Name of the geometry column."
    )
    geometry_type: str | None = Field(
        None, description="Geometry type, e.g. 'Polygon', 'MultiPolygon'."
    )
    crs: Any | None = Field(None, description="CRS object or None.")
    columns: list[ColumnMeta] = Field(
        default_factory=list, description="List of columns with name, type, nullable."
    )
    raw_meta: Any | None = Field(None, description="Raw metadata dict.")


_GEOMETRY_TYPE = re.compile(r"^GEOMETRY\('(.*)'\)$", re.IGNORECASE | re.DOTALL)


def geometry_type_crs(column_type: str) -> str | None:
    """The CRS DuckDB names in a geometry column's type, `GEOMETRY('EPSG:4326')`
    gives `EPSG:4326`; None for a type without one."""
    match = _GEOMETRY_TYPE.match(column_type.strip())
    return match.group(1).replace("''", "'") if match else None


def get_metadata(con: DuckDBPyConnection, input_path: str) -> Metadata:
    """
    Extract unified metadata for a Parquet/GeoParquet file, or for a file of a
    format GDAL reads with the drivers `READ_DRIVERS` (`goatlib.io.formats`)
    lists for its suffix: GeoJSON, GeoPackage, Shapefile, KML, GPX, XLSX. Any
    other suffix raises `ValueError("Unsupported file format: ...")`.
    Returns a Metadata object with geometry_column, geometry_type, crs, columns, raw_meta.
    """
    input_path_str = str(input_path)
    suffix = Path(input_path_str).suffix.lower()

    meta = Metadata(
        geometry_column=None,
        geometry_type=None,
        crs=None,
        columns=[],
        raw_meta=None,
    )

    def is_unknown_geometry_type(geom_type: str | None) -> bool:
        """Check if geometry type is unknown/any."""
        if not geom_type:
            return True
        geom_type_lower = geom_type.lower()
        return any(unknown in geom_type_lower for unknown in ["unknown", "any"])

    # ----------------------------------------------------------------------
    # CASE 1: Parquet or GeoParquet
    # ----------------------------------------------------------------------
    if suffix == ".parquet":
        try:
            rows = con.execute(
                "SELECT * FROM parquet_kv_metadata(?) WHERE key = 'geo'",
                [input_path_str],
            ).fetchall()
        except Exception:
            rows = []

        if rows:
            try:
                geo_json = (
                    rows[0][2].decode() if isinstance(rows[0][2], bytes) else rows[0][2]
                )
                geo = json.loads(geo_json)
                meta.raw_meta = geo

                primary = geo.get("primary_column")
                columns = geo.get("columns", {})
                geom_info = columns.get(primary, {}) if primary else {}

                meta.geometry_column = primary

                # --- Unified geometry type extraction ---
                geom_types = geom_info.get("geometry_types")
                if geom_types:
                    # Always use the first type, normalized (e.g. "MultiPolygon")
                    if isinstance(geom_types, list) and geom_types:
                        meta.geometry_type = geom_types[0].title().replace(" ", "")
                    elif isinstance(geom_types, str):
                        meta.geometry_type = geom_types.title().replace(" ", "")

                if geom_info.get("crs"):
                    meta.crs = CRS.from_user_input(geom_info["crs"])

            except Exception as e:
                logger.warning("Failed to parse GeoParquet metadata: %s", e)
                meta.raw_meta = {"error": str(e)}

        # --- DuckDB-side column introspection
        try:
            cols = con.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [input_path_str]
            ).fetchall()
            meta.columns = [
                ColumnMeta(name=c[0], type=c[1], nullable=c[2] == "YES") for c in cols
            ]
        except Exception as e:
            logger.warning("DESCRIBE failed for Parquet: %s", e)
            meta.columns = [ColumnMeta(name="error", type=str(e), nullable=True)]

        # --- Fallback geometry detection
        if not meta.geometry_column:
            geom_candidates = [
                c.name
                for c in meta.columns
                if "WKB" in c.type.upper() or "GEOMETRY" in c.type.upper()
            ]
            if geom_candidates:
                meta.geometry_column = geom_candidates[0]

        # --- Last resort: Detect geometry type from first row using ST_GeometryType
        if meta.geometry_column and is_unknown_geometry_type(meta.geometry_type):
            try:
                geom = sql_identifier(meta.geometry_column)
                geom_type_result = con.execute(
                    f"SELECT ST_GeometryType({geom}) FROM read_parquet(?) "
                    f"WHERE {geom} IS NOT NULL LIMIT 1",
                    [input_path_str],
                ).fetchone()

                if geom_type_result and geom_type_result[0]:
                    # ST_GeometryType returns like 'ST_MULTIPOLYGON', 'ST_POINT', etc.
                    # Remove 'ST_' prefix and normalize
                    geom_type_str = geom_type_result[0]
                    if geom_type_str.startswith("ST_"):
                        geom_type_str = geom_type_str[3:]
                    meta.geometry_type = geom_type_str.title().replace(" ", "")
                    logger.debug(
                        "Detected geometry type via ST_GeometryType: %s",
                        meta.geometry_type,
                    )

            except Exception as e:
                logger.debug("ST_GeometryType fallback failed for Parquet: %s", e)

    # ----------------------------------------------------------------------
    # CASE 2: Spatial formats via ST_Read() (e.g., GeoJSON, Shapefile)
    # ----------------------------------------------------------------------
    else:
        # Every read names the drivers of the input's format: GDAL picks a
        # driver by a file's content, and ST_Read_Meta, which takes no driver
        # list, is not used for that reason.
        reader = f"ST_Read(?, {allowed_drivers_sql(suffix)})"

        # --- Get native DuckDB schema using DESCRIBE
        try:
            cols = con.execute(
                f"DESCRIBE SELECT * FROM {reader}", [input_path_str]
            ).fetchall()
            column_defs = [
                ColumnMeta(name=c[0], type=c[1], nullable=c[2] == "YES") for c in cols
            ]
        except Exception as e:
            logger.warning("DESCRIBE failed for ST_Read: %s", e)
            column_defs = [ColumnMeta(name="error", type=str(e), nullable=True)]

        # --- The geometry column, and the CRS DuckDB gives its type:
        # GEOMETRY('EPSG:4326')
        geom_def = next((c for c in column_defs if "GEOMETRY" in c.type.upper()), None)
        crs = None
        crs_text = geometry_type_crs(geom_def.type) if geom_def else None
        if crs_text:
            try:
                crs = CRS.from_user_input(crs_text)
            except Exception as e:
                logger.warning("Failed to parse CRS from metadata: %s", e)

        # --- Merge metadata
        meta.geometry_column = geom_def.name if geom_def else None
        meta.geometry_type = None
        meta.crs = crs
        meta.columns = column_defs
        meta.raw_meta = {}

        # --- Last resort: Detect geometry type from first row using ST_GeometryType
        if meta.geometry_column and is_unknown_geometry_type(meta.geometry_type):
            try:
                geom = sql_identifier(meta.geometry_column)
                geom_type_result = con.execute(
                    f"SELECT ST_GeometryType({geom}) FROM {reader} "
                    f"WHERE {geom} IS NOT NULL LIMIT 1",
                    [input_path_str],
                ).fetchone()

                if geom_type_result and geom_type_result[0]:
                    # ST_GeometryType returns like 'ST_MULTIPOLYGON', 'ST_POINT', etc.
                    # Remove 'ST_' prefix and normalize
                    geom_type_str = geom_type_result[0]
                    if geom_type_str.startswith("ST_"):
                        geom_type_str = geom_type_str[3:]
                    meta.geometry_type = geom_type_str.title().replace(" ", "")
                    logger.debug(
                        "Detected geometry type via ST_GeometryType: %s",
                        meta.geometry_type,
                    )

            except Exception as e:
                logger.debug("ST_GeometryType fallback failed for spatial file: %s", e)

    # ----------------------------------------------------------------------
    # GLOBAL FALLBACK: Default to WGS84 if CRS is missing but geometry exists
    # ----------------------------------------------------------------------
    # This handles layers exported from DuckLake which don't preserve CRS metadata
    # Since all DuckLake layers are stored in WGS84, this is a safe assumption
    if meta.geometry_column and meta.crs is None:
        logger.info(
            "No CRS information found for %s, defaulting to WGS84 (EPSG:4326)",
            input_path_str,
        )
        meta.crs = CRS.from_epsg(4326)

    return meta
