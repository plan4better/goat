# src/goatlib/io/converter.py
import json
import logging
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterator, Self
from urllib.parse import urlparse

import duckdb
from pyproj import CRS
from pyproj.exceptions import CRSError

from goatlib.config import settings
from goatlib.io.formats import (
    ALL_EXTS,
    FileFormat,
    allowed_drivers_sql,
    refuse_unsupported_format,
)
from goatlib.io.parquet import write_optimized_parquet
from goatlib.io.sql import sql_identifier, sql_literal
from goatlib.io.utils import detect_path_type, download_if_remote, geometry_type_crs
from goatlib.models.io import DatasetMetadata
from goatlib.storage.s3_config import apply_duckdb_s3_settings

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

ColumnMapping = dict[str, str]

_GEOJSON_CRS_KEY = re.compile(r'"crs"\s*:\s*')

# A CRS named by its authority and code (`EPSG:4326`), the form ST_Read gives
# a layer whose CRS GDAL identified.
_AUTH_CODE = re.compile(r"^[A-Za-z][\w.]*:[\w.]+$")

# Text tables DuckDB's own CSV reader takes, sniffing the delimiter.
_TEXT_TABLES = (
    FileFormat.CSV.value,
    FileFormat.TSV.value,
    FileFormat.TXT.value,
    FileFormat.DSV.value,
)


@dataclass
class SourceInfo:
    """Container for source file information."""

    path: str
    is_remote: bool
    path_obj: Path | None
    layer_name: str | None = None


@dataclass
class GeometryInfo:
    """Container for geometry-related information."""

    has_geometry: bool = False
    source_column: str | None = None
    output_column: str | None = None
    srid: str | None = None
    is_wkt: bool = False  # True if geometry is WKT text that needs conversion


class IOConverter:
    """
    Core converter: any input → Parquet/GeoParquet or COG GeoTIFF.
    Works locally, over HTTP, and on S3.
    """

    def __init__(self: Self) -> None:
        self.con = duckdb.connect(database=":memory:")
        self._setup_duckdb_extensions()

    def _setup_duckdb_extensions(self: Self) -> None:
        """Configure DuckDB with necessary extensions and settings."""
        self.con.execute("INSTALL spatial; LOAD spatial;")
        self.con.execute("INSTALL httpfs; LOAD httpfs;")

        io = settings.io
        apply_duckdb_s3_settings(
            self.con,
            endpoint_url=io.s3_endpoint_url,
            access_key=io.s3_access_key_id,
            secret_key=io.s3_secret_access_key,
            region=io.s3_region,
            provider=io.s3_provider,
            force_path_style=io.s3_force_path_style,
        )

    # ------------------------------------------------------------------
    # Vector/Tabular → Parquet / GeoParquet
    # ------------------------------------------------------------------
    def to_parquet(
        self: Self,
        src_path: str,
        out_path: str | Path,
        geometry_col: str | None = None,
        target_crs: str | None = None,
        column_mapping: ColumnMapping | None = None,
        timeout: int | None = None,
        has_header: bool | None = None,
        sheet_name: str | None = None,
    ) -> DatasetMetadata:
        """
        Convert any vector/tabular dataset to Parquet/GeoParquet.

        Args:
            src_path: Source path (file, URL, or virtual dataset)
            out_path: Output path for Parquet file
            geometry_col: Geometry column name for spatial data
            target_crs: Target CRS for reprojection
            column_mapping: Dictionary for column renaming
            timeout: Timeout for HTTP requests
            has_header: Whether first row is a header (True/False/None=auto)
            sheet_name: Worksheet name for XLSX files (None=first sheet)

        Returns:
            DatasetMetadata with conversion results
        """
        logger.info("Starting conversion: %s", src_path)

        try:
            # Preprocess source
            src_info = self._preprocess_source(src_path, timeout)
            # Before any reader is built: GDAL picks a driver by a file's
            # content, so only a format with a reader here is read at all.
            refuse_unsupported_format(src_info.path)
            out = Path(out_path)
            out.parent.mkdir(parents=True, exist_ok=True)

            # GeoJSON whose legacy `crs` member PROJ can't resolve: DuckDB's
            # ST_Read fails hard on it, so convert a copy without the member.
            sanitized = self._strip_unresolvable_geojson_crs(src_info)
            if sanitized:
                try:
                    return self.to_parquet(
                        str(sanitized),
                        out,
                        geometry_col=geometry_col,
                        target_crs=target_crs,
                        column_mapping=column_mapping,
                        timeout=timeout,
                    )
                finally:
                    shutil.rmtree(sanitized.parent, ignore_errors=True)

            # Handle archive formats
            if self._is_archive_format(src_info):
                return self._handle_archive_conversion(
                    src_info,
                    out,
                    geometry_col,
                    target_crs,
                    column_mapping,
                    timeout,
                )

            # Convert single file
            return self._convert_single_file(
                src_info,
                out,
                geometry_col,
                target_crs,
                column_mapping,
                has_header=has_header,
                sheet_name=sheet_name,
            )

        except Exception as e:
            logger.error("Conversion failed for %s: %s", src_path, e)
            raise

    def _preprocess_source(
        self: Self, src_path: str, timeout: int | None
    ) -> SourceInfo:
        """Preprocess source path and extract information."""
        logger.debug("Preprocessing source: %s", src_path)

        # Download HTTP sources
        downloaded_path = download_if_remote(src_path, timeout)

        # Parse virtual dataset syntax
        base_path, layer_name = self._parse_virtual_dataset(downloaded_path)

        # Check if it's a local file
        path_obj = (
            Path(base_path)
            if urlparse(base_path).scheme not in {"http", "https"}
            else None
        )

        return SourceInfo(
            path=base_path,
            is_remote=path_obj is None,
            path_obj=path_obj,
            layer_name=layer_name,
        )

    def _parse_virtual_dataset(self: Self, path: str) -> tuple[str, str | None]:
        """Parse virtual dataset syntax '<file>::<layer>'."""
        if "::" in path:
            base, layer_name = path.split("::", 1)
            return base, layer_name
        return path, None

    def _strip_unresolvable_geojson_crs(
        self: Self, src_info: SourceInfo
    ) -> Path | None:
        """Copy a GeoJSON without its `crs` member when PROJ can't resolve it.

        RFC 7946 dropped `crs` (coordinates are always WGS84 lon/lat), but GDAL
        still honours it, and DuckDB turns GDAL's "crs not found" into a hard
        error. A resolvable member is kept, so legacy projected files still
        reproject. An unresolvable one is dropped, provided the coordinates
        really are lon/lat; otherwise the file is rejected rather than
        imported at the wrong place.

        Returns the sanitized copy (in its own temp dir), or None to convert
        the source as is.
        """
        path = src_info.path_obj
        if (
            path is None
            or path.suffix.lower()
            not in (FileFormat.GEOJSON.value, FileFormat.JSON.value)
            or not path.is_file()
        ):
            return None

        # Writers put `crs` ahead of `features`; only look there, so a property
        # that happens to be called "crs" is never mistaken for the member.
        with open(path, "rb") as f:
            # surrogateescape round-trips any byte, so char offsets map back exactly.
            head = f.read(64 * 1024).decode("utf-8", errors="surrogateescape")
        match = _GEOJSON_CRS_KEY.search(head)
        features_at = head.find('"features"')
        if not match or (features_at != -1 and match.start() > features_at):
            return None
        try:
            crs_obj, end = json.JSONDecoder().raw_decode(head, match.end())
        except ValueError:
            return None
        props = crs_obj.get("properties") if isinstance(crs_obj, dict) else None
        name = props.get("name") if isinstance(props, dict) else None
        if not isinstance(name, str) or not name:
            return None
        try:
            CRS.from_user_input(name)
            return None
        except CRSError:
            pass

        logger.warning(
            "GeoJSON %s declares an unresolvable CRS %r; reading it as WGS84 (RFC 7946)",
            path,
            name,
        )
        # Drop `"crs": {...}` plus its trailing comma, then stream the rest.
        rest = head[end:]
        if rest.lstrip().startswith(","):
            end += len(rest) - len(rest.lstrip()) + 1
        start_b = len(head[: match.start()].encode("utf-8", errors="surrogateescape"))
        end_b = len(head[:end].encode("utf-8", errors="surrogateescape"))
        tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_geojson_"))
        dest = tmp_dir / path.name
        with open(path, "rb") as src, open(dest, "wb") as dst:
            dst.write(src.read(start_b))
            src.seek(end_b)
            shutil.copyfileobj(src, dst)

        bbox = self.con.execute(
            f"SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) "
            f"FROM (SELECT ST_Extent_Agg(geom) AS e "
            f"FROM ST_Read(?, {allowed_drivers_sql(dest.suffix)}))",
            [str(dest)],
        ).fetchone()
        if bbox and all(v is not None for v in bbox):
            min_x, min_y, max_x, max_y = bbox
            if min_x < -180 or max_x > 180 or min_y < -90 or max_y > 90:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                raise ValueError(
                    f"The file declares an unknown coordinate system ({name}) and its "
                    f"coordinates are not WGS84 longitude/latitude (extent "
                    f"[{min_x:.2f}, {min_y:.2f}, {max_x:.2f}, {max_y:.2f}]). Fix the "
                    f'file\'s "crs" entry or export it as WGS84 (EPSG:4326).'
                )
        return dest

    def _is_archive_format(self: Self, src_info: SourceInfo) -> bool:
        """Check if source is an archive format that needs extraction."""
        if not src_info.path_obj:
            return False
        return src_info.path_obj.suffix.lower() in {
            FileFormat.ZIP.value,
            FileFormat.KMZ.value,
        }

    def _handle_archive_conversion(
        self: Self,
        src_info: SourceInfo,
        out_path: Path,
        geometry_col: str | None,
        target_crs: str | None,
        column_mapping: ColumnMapping | None,
        timeout: int | None,
    ) -> DatasetMetadata:
        """Handle conversion of archive formats (ZIP, KMZ)."""
        logger.info(
            "Processing %s archive: %s", src_info.path_obj.suffix.upper(), src_info.path
        )

        if src_info.path_obj.suffix.lower() == FileFormat.ZIP.value:
            return self._handle_zip_conversion(
                src_info.path,
                out_path,
                geometry_col,
                target_crs,
                column_mapping,
                timeout,
            )
        else:  # KMZ
            return self._handle_kmz_conversion(
                src_info.path,
                out_path,
                geometry_col,
                target_crs,
                column_mapping,
                timeout,
            )

    def _handle_zip_conversion(
        self: Self,
        zip_path: str,
        out_path: Path,
        geometry_col: str | None = None,
        target_crs: str | None = None,
        column_mapping: ColumnMapping | None = None,
        timeout: int | None = None,
    ) -> DatasetMetadata:
        """Handle ZIP archive conversion."""
        for extracted in self._extract_supported_from_zip(zip_path):
            try:
                return self.to_parquet(
                    str(extracted),
                    out_path,
                    geometry_col=geometry_col,
                    target_crs=target_crs,
                    column_mapping=column_mapping,
                    timeout=timeout,
                )
            finally:
                if extracted.parent.name.startswith("goatlib_zip_"):
                    shutil.rmtree(extracted.parent, ignore_errors=True)
        raise ValueError(f"No convertible dataset found in {zip_path}")

    def _handle_kmz_conversion(
        self: Self,
        kmz_path: str,
        out_path: Path,
        geometry_col: str | None = None,
        target_crs: str | None = None,
        column_mapping: ColumnMapping | None = None,
        timeout: int | None = None,
    ) -> DatasetMetadata:
        """Handle KMZ archive conversion."""
        tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_kmz_"))
        try:
            with zipfile.ZipFile(kmz_path) as zf:
                for name in zf.namelist():
                    if name.lower().endswith(".kml"):
                        dest = tmp_dir / Path(name).name
                        with zf.open(name) as src, open(dest, "wb") as dst:
                            dst.write(src.read())
                        logger.info("Extracted KML %s from KMZ %s", dest, kmz_path)
                        return self.to_parquet(
                            str(dest),
                            out_path,
                            geometry_col=geometry_col,
                            target_crs=target_crs,
                            column_mapping=column_mapping,
                            timeout=timeout,
                        )
                raise ValueError(f"No .kml found inside KMZ {kmz_path}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _convert_single_file(
        self: Self,
        src_info: SourceInfo,
        out_path: Path,
        geometry_col: str | None,
        target_crs: str | None,
        column_mapping: ColumnMapping | None,
        has_header: bool | None = None,
        sheet_name: str | None = None,
    ) -> DatasetMetadata:
        """Convert a single file to Parquet/GeoParquet."""
        logger.debug("Analyzing source format: %s", src_info.path)

        # Build source reader
        st_read = self._build_source_reader(
            src_info, has_header=has_header, sheet_name=sheet_name
        )

        # Detect geometry information
        geom_info = self._detect_geometry_info(src_info, st_read, geometry_col)

        # Build conversion query
        query = self._build_conversion_query(
            st_read, geom_info, target_crs, column_mapping
        )

        # Strip empty rows for tabular formats (e.g. Excel files with
        # cell formatting extending beyond actual data).
        if self._is_tabular_format(src_info):
            query = self._wrap_strip_empty_rows(query)

        # Validate query returns data
        self._validate_query_returns_data(query)

        # Execute conversion
        logger.info("Writing Parquet file: %s", out_path)
        self._execute_parquet_conversion(
            query,
            out_path,
            geom_info.has_geometry,
            geometry_column=geom_info.output_column or "geometry",
        )

        # Build metadata
        logger.debug("Finalizing metadata for: %s", out_path)
        return self._build_parquet_metadata(
            out_path,
            src_info.path,
            geom_info,
            target_crs,
            self._output_geometry_column(geom_info, target_crs, column_mapping),
        )

    def _build_source_reader(
        self: Self,
        src_info: SourceInfo,
        has_header: bool | None = None,
        sheet_name: str | None = None,
    ) -> str:
        """Build appropriate source reader SQL fragment.

        The fragment goes into several statements, so the path and the layer
        are written in as literals (`sql_literal`), not bound.
        """
        path = sql_literal(src_info.path)
        # CSV/TSV/TXT/DSV: use read_csv_auto with header param
        if src_info.path_obj and src_info.path_obj.suffix.lower() in _TEXT_TABLES:
            header_val = "True" if has_header is not False else "False"
            return f"read_csv_auto({path}, header={header_val})"

        if (
            src_info.path_obj
            and src_info.path_obj.suffix.lower() == FileFormat.PARQUET.value
        ):
            return f"read_parquet({path})"

        # XLSX or other ST_Read formats
        effective_layer = sheet_name or src_info.layer_name
        is_xlsx = (
            src_info.path_obj
            and src_info.path_obj.suffix.lower() == FileFormat.XLSX.value
        )

        if is_xlsx and has_header is not None:
            return self._build_xlsx_reader(src_info.path, effective_layer, has_header)

        # Default ST_Read (no explicit header control), with the drivers of the
        # source's format only.
        drivers = allowed_drivers_sql(Path(src_info.path).suffix)
        if effective_layer:
            layer = sql_literal(effective_layer)
            reader = f"ST_Read({path}, layer={layer}, {drivers})"
        else:
            reader = f"ST_Read({path}, {drivers})"
        # XLSX auto-detect path also surfaces GDAL's synthetic OGC_FID column.
        if is_xlsx:
            reader = self._strip_ogc_fid(reader)
        return reader

    def _build_xlsx_reader(
        self: Self, path: str, layer: str | None, has_header: bool
    ) -> str:
        """Build XLSX reader with reliable header handling.

        GDAL's HEADERS=FORCE open_option is unreliable for non-first sheets.
        When has_header=True, we read with HEADERS=DISABLE and manually
        extract column names from the first row via SQL.
        """
        layer_arg = f", layer={sql_literal(layer)}" if layer else ""
        drivers = allowed_drivers_sql(Path(path).suffix)
        base_read = self._strip_ogc_fid(
            f"ST_Read({sql_literal(path)}{layer_arg}, "
            f"open_options=ARRAY['HEADERS=DISABLE'], {drivers})"
        )

        if not has_header:
            return base_read

        # has_header=True: read first row to get column names, then build
        # a query that renames columns and skips the header row.
        first_row = self.con.execute(f"SELECT * FROM {base_read} LIMIT 1").fetchone()
        if not first_row:
            return base_read

        raw_cols = [
            c[0]
            for c in self.con.execute(f"SELECT * FROM {base_read} LIMIT 0").description
        ]

        # Build column aliases: "Field1" AS "actual_name"
        # Escape double quotes in cell values to prevent SQL injection.
        aliases = ", ".join(
            f"{sql_identifier(raw)} AS {sql_identifier(val)}"
            for raw, val in zip(raw_cols, first_row)
        )
        return (
            f"(SELECT {aliases} FROM ("
            f"SELECT *, ROW_NUMBER() OVER () AS __rn "
            f"FROM {base_read}) WHERE __rn > 1)"
        )

    def _strip_ogc_fid(self: Self, read_fragment: str) -> str:
        """Drop GDAL's synthetic OGC_FID column from an XLSX ST_Read.

        duckdb spatial >= 1.5 surfaces an OGC_FID feature-id column for XLSX
        that 1.4.x did not. It is not real spreadsheet data: it pollutes the
        has_header=False column set and, being populated on every row
        (including formatted-but-blank ones), defeats trailing-empty-row
        stripping. Select only the real columns. No-op if OGC_FID is absent.
        """
        try:
            cols = [
                c[0]
                for c in self.con.execute(
                    f"SELECT * FROM {read_fragment} LIMIT 0"
                ).description
            ]
        except Exception:
            return read_fragment
        data_cols = [c for c in cols if c.upper() != "OGC_FID"]
        if len(data_cols) == len(cols):
            return read_fragment
        col_list = ", ".join(map(sql_identifier, data_cols))
        return f"(SELECT {col_list} FROM {read_fragment})"

    @staticmethod
    def _is_tabular_format(src_info: SourceInfo) -> bool:
        """Check if source is a tabular format that may have trailing empty rows."""
        if not src_info.path_obj:
            return False
        return src_info.path_obj.suffix.lower() in (
            FileFormat.XLSX.value,
            *_TEXT_TABLES,
        )

    def _wrap_strip_empty_rows(self: Self, query: str) -> str:
        """Wrap a query to exclude rows where every column is NULL or empty.

        Handles Excel files where cell formatting (e.g. background color)
        extends the used range far beyond actual data.
        """
        try:
            col_info = self.con.execute(f"SELECT * FROM ({query}) LIMIT 0").description
            cols = [c[0] for c in col_info]
        except Exception:
            return query

        if not cols:
            return query

        # Build condition: at least one column must be non-null and non-empty
        conditions = " OR ".join(
            f"({sql_identifier(col)} IS NOT NULL "
            f"AND CAST({sql_identifier(col)} AS VARCHAR) != '')"
            for col in cols
        )
        return f"SELECT * FROM ({query}) WHERE {conditions}"

    def _detect_geometry_info(
        self: Self, src_info: SourceInfo, st_read: str, user_geometry_col: str | None
    ) -> GeometryInfo:
        """Detect geometry column and CRS information."""
        geom_info = GeometryInfo()

        # For CSV/tabular reads, check for WKT geometry columns
        if st_read.startswith("read_csv") or st_read.startswith("read_parquet"):
            return self._detect_tabular_geometry(st_read, user_geometry_col)

        # Check if this is a tabular format read via ST_Read (XLSX, etc.)
        # that might have WKT geometry columns
        if src_info.path_obj and src_info.path_obj.suffix.lower() in (
            FileFormat.XLSX.value,
            FileFormat.CSV.value,
            FileFormat.TSV.value,
            FileFormat.TXT.value,
        ):
            # Try to detect WKT geometry in tabular format
            tabular_geom = self._detect_tabular_geometry(st_read, user_geometry_col)
            if tabular_geom.has_geometry:
                return tabular_geom
            # If no WKT found, continue with ST_Read detection

        # Only detect geometry for spatial reads
        if not st_read.startswith("ST_Read("):
            return geom_info

        # From the reader itself, which names the drivers of the source's format
        # (and its layer). Not ST_Read_Meta: it takes no driver list, so GDAL
        # would pick a driver by the file's content.
        try:
            columns = self.con.execute(f"DESCRIBE SELECT * FROM {st_read}").fetchall()
        except Exception as e:
            # The conversion reads with this same reader, and GDAL reports a
            # second failed open of a file only as a recursive call: this is the
            # error worth showing.
            raise ValueError(f"Failed to execute query: {e}") from e
        geom_column = next(
            (
                (name, col_type)
                for name, col_type, *_ in columns
                if col_type.upper().startswith("GEOMETRY")
            ),
            None,
        )
        if geom_column is None:
            return geom_info
        name, col_type = geom_column
        geom_info.has_geometry = True
        geom_info.source_column = user_geometry_col or name
        geom_info.output_column = "geometry"  # Standardize output name

        # DuckDB carries the layer's CRS in the column type, GEOMETRY('EPSG:4326');
        # taken when it names an authority and code, as GDAL's metadata did.
        # The geometry type is read from the output (`_build_parquet_metadata`).
        crs = geometry_type_crs(col_type)
        if crs and _AUTH_CODE.match(crs):
            geom_info.srid = crs

        return geom_info

    def _detect_tabular_geometry(
        self: Self, st_read: str, user_geometry_col: str | None
    ) -> GeometryInfo:
        """Detect WKT geometry column in tabular data (CSV, XLSX, TSV, etc.).

        Looks for columns named 'geometry', 'geom', 'wkt', 'wkt_geom', 'the_geom'
        that contain WKT text representations.

        Raises:
            ValueError: If geometry coordinates are outside WGS84 bounds
                (longitude: -180 to 180, latitude: -90 to 90).
        """
        geom_info = GeometryInfo()

        # Known WKT geometry column names (case-insensitive)
        wkt_column_names = {"geometry", "geom", "wkt", "wkt_geom", "the_geom"}

        try:
            # Get column info from CSV
            col_info = self.con.execute(f"SELECT * FROM {st_read} LIMIT 0").description
            all_cols = [c[0] for c in col_info]

            # Find geometry column
            geom_col = None
            if user_geometry_col:
                # User specified geometry column
                if user_geometry_col in all_cols:
                    geom_col = user_geometry_col
            else:
                # Auto-detect by name
                for col in all_cols:
                    if col.lower() in wkt_column_names:
                        geom_col = col
                        break

            if not geom_col:
                logger.debug("No WKT geometry column found in tabular data")
                return geom_info

            # Verify it contains WKT by checking first non-null value
            try:
                geom = sql_identifier(geom_col)
                sample = self.con.execute(
                    f"SELECT {geom} FROM {st_read} WHERE {geom} IS NOT NULL LIMIT 1"
                ).fetchone()
                if sample and sample[0]:
                    val = str(sample[0]).strip().upper()
                    # Check if it looks like WKT
                    wkt_prefixes = (
                        "POINT",
                        "LINESTRING",
                        "POLYGON",
                        "MULTIPOINT",
                        "MULTILINESTRING",
                        "MULTIPOLYGON",
                        "GEOMETRYCOLLECTION",
                    )
                    if val.startswith(wkt_prefixes):
                        # Validate coordinates are within WGS84 bounds
                        self._validate_wgs84_bounds(st_read, geom_col)

                        geom_info.has_geometry = True
                        geom_info.source_column = geom_col
                        geom_info.output_column = "geometry"
                        geom_info.srid = "EPSG:4326"  # Assume WGS84 for WKT
                        geom_info.is_wkt = True  # Mark as WKT for conversion
                        logger.info("Detected WKT geometry column: %s", geom_col)
            except ValueError:
                # Re-raise validation errors
                raise
            except Exception as e:
                logger.debug("Could not verify WKT column %s: %s", geom_col, e)

        except ValueError:
            # Re-raise validation errors from bounds check
            raise
        except Exception as e:
            logger.debug("Tabular geometry detection failed: %s", e)

        return geom_info

    def _validate_wgs84_bounds(self: Self, st_read: str, geom_col: str) -> None:
        """Validate that WKT geometry coordinates are within WGS84 bounds.

        For CSV/tabular files, we assume coordinates should be in WGS84
        (EPSG:4326). This validation rejects files with coordinates outside
        valid WGS84 bounds which likely indicates the data is in a projected
        coordinate system (e.g., EPSG:3857).

        Args:
            st_read: The DuckDB source reader expression
            geom_col: Name of the WKT geometry column

        Raises:
            ValueError: If coordinates are outside WGS84 bounds
                (longitude: -180 to 180, latitude: -90 to 90)
        """
        # WGS84 bounds
        MIN_LON, MAX_LON = -180.0, 180.0
        MIN_LAT, MAX_LAT = -90.0, 90.0

        try:
            # Calculate bounding box of all geometries
            # ST_GeomFromText converts WKT to geometry, ST_Extent gets bbox
            bbox = self.con.execute(
                f"""
                SELECT
                    ST_XMin(ST_Extent_Agg(geom)) as min_x,
                    ST_YMin(ST_Extent_Agg(geom)) as min_y,
                    ST_XMax(ST_Extent_Agg(geom)) as max_x,
                    ST_YMax(ST_Extent_Agg(geom)) as max_y
                FROM (
                    SELECT ST_GeomFromText({sql_identifier(geom_col)}) as geom
                    FROM {st_read}
                    WHERE {sql_identifier(geom_col)} IS NOT NULL
                )
                """
            ).fetchone()

            if bbox and all(v is not None for v in bbox):
                min_x, min_y, max_x, max_y = bbox

                # Check if any coordinate is outside WGS84 bounds
                out_of_bounds = (
                    min_x < MIN_LON
                    or max_x > MAX_LON
                    or min_y < MIN_LAT
                    or max_y > MAX_LAT
                )

                if out_of_bounds:
                    raise ValueError(
                        f"CSV geometry coordinates are outside WGS84 bounds. "
                        f"Detected extent: [{min_x:.2f}, {min_y:.2f}, {max_x:.2f}, {max_y:.2f}]. "
                        f"WGS84 bounds are [{MIN_LON}, {MIN_LAT}, {MAX_LON}, {MAX_LAT}]. "
                        f"CSV files must contain coordinates in WGS84 (EPSG:4326). "
                        f"Please convert your data to WGS84 before uploading."
                    )

                logger.debug(
                    "WGS84 bounds validation passed. Extent: [%.2f, %.2f, %.2f, %.2f]",
                    min_x,
                    min_y,
                    max_x,
                    max_y,
                )

        except ValueError:
            # Re-raise validation errors
            raise
        except Exception as e:
            logger.warning("Could not validate WGS84 bounds: %s", e)
            # Don't fail if we can't validate - let conversion proceed

    def _build_conversion_query(
        self: Self,
        st_read: str,
        geom_info: GeometryInfo,
        target_crs: str | None,
        column_mapping: ColumnMapping | None,
    ) -> str:
        """Build the conversion query with proper column handling."""
        # The source's columns as selected (renamed by column_mapping), or None
        # to select them all as they are.
        select_parts = self._build_select_parts(st_read, column_mapping)

        # Handle geometry conversion/transformation if needed
        if geom_info.has_geometry and geom_info.source_column:
            from_crs = sql_literal(geom_info.srid or "EPSG:4326")
            to_crs = sql_literal(target_crs or "")
            source = sql_identifier(geom_info.source_column)
            output = sql_identifier(geom_info.output_column)

            # Build geometry expression: WKT text → geometry, optionally transform.
            # always_xy keeps a consistent X,Y (lon,lat) axis order: many WFS
            # services return lat,lon.
            if geom_info.is_wkt:
                geom_expr = f"ST_GeomFromText({source})"
                if target_crs and target_crs != (geom_info.srid or "EPSG:4326"):
                    geom_expr = (
                        f"ST_Transform({geom_expr}, {from_crs}, {to_crs}, "
                        f"always_xy := true)"
                    )
                geom_expr = f"{geom_expr} AS {output}"
            elif target_crs:
                # Already geometry, just transform
                geom_expr = (
                    f"ST_Transform({source}, {from_crs}, {to_crs}, "
                    f"always_xy := true) AS {output}"
                )
            else:
                # No transformation needed
                geom_expr = None

            if geom_expr:
                if select_parts is None:
                    return f"SELECT * EXCLUDE ({source}), {geom_expr} FROM {st_read}"
                # Replace the original geometry column with the converted one
                parts = [
                    part
                    for column, part in select_parts
                    if column != geom_info.source_column
                ]
                return f"SELECT {', '.join([*parts, geom_expr])} FROM {st_read}"

        if select_parts is None:
            return f"SELECT * FROM {st_read}"
        return f"SELECT {', '.join(part for _, part in select_parts)} FROM {st_read}"

    @staticmethod
    def _output_geometry_column(
        geom_info: GeometryInfo,
        target_crs: str | None,
        column_mapping: ColumnMapping | None,
    ) -> str | None:
        """The output column holding the geometry `_build_conversion_query`
        selected: the converted one, else the source column under its
        (possibly mapped) name."""
        if not geom_info.has_geometry or not geom_info.source_column:
            return None
        if geom_info.is_wkt or target_crs:
            return geom_info.output_column
        return (column_mapping or {}).get(
            geom_info.source_column, geom_info.source_column
        )

    def _build_select_parts(
        self: Self, st_read: str, column_mapping: ColumnMapping | None
    ) -> list[tuple[str, str]] | None:
        """Each source column with its SELECT item, renamed by `column_mapping`;
        None (select all as they are) without a mapping or columns to read."""
        if not column_mapping:
            return None

        try:
            col_info = self.con.execute(f"SELECT * FROM {st_read} LIMIT 0").description
        except Exception as e:
            logger.warning("Could not introspect source columns for renaming: %s", e)
            return None

        parts = []
        for col in (c[0] for c in col_info):
            part = sql_identifier(col)
            if col in column_mapping:
                part = f"{part} AS {sql_identifier(column_mapping[col])}"
            parts.append((col, part))
        return parts

    def _validate_query_returns_data(self: Self, query: str) -> None:
        """Validate that the query returns at least one row."""
        try:
            result = self.con.execute(f"{query} LIMIT 1").fetchone()
            if result is None:
                raise ValueError("Source dataset is empty")
        except Exception as e:
            raise ValueError(f"Failed to execute query: {e}")

    def _execute_parquet_conversion(
        self: Self,
        query: str,
        out_path: Path,
        has_geometry: bool,
        geometry_column: str = "geometry",
    ) -> None:
        """Execute the conversion query and save to Parquet.

        Uses optimized Parquet V2 format. For spatial data, also adds:
        - Hilbert spatial sorting for locality
        - Bounding box columns for fast row group pruning
        """
        logger.debug("DuckDB COPY start: %s", out_path)

        # write_optimized_parquet handles both geo and non-geo cases
        # - Always uses Parquet V2 for better compression
        # - For geo: adds bbox columns and Hilbert sorting
        write_optimized_parquet(
            self.con,
            query,
            out_path,
            geometry_column=geometry_column,
        )

    def _build_parquet_metadata(
        self: Self,
        out_path: Path,
        src_path: str,
        geom_info: GeometryInfo,
        target_crs: str | None,
        geometry_column: str | None,
    ) -> DatasetMetadata:
        """Build metadata for Parquet conversion result."""
        try:
            count = self.con.execute(
                "SELECT COUNT(*) FROM read_parquet(?)", [str(out_path)]
            ).fetchone()[0]
        except Exception:
            count = 0

        return DatasetMetadata(
            path=str(out_path),
            source_type="vector" if geom_info.has_geometry else "tabular",
            format="parquet",
            storage_backend=detect_path_type(str(out_path)),
            geometry_type=(
                self._output_geometry_type(out_path, geometry_column)
                if geometry_column
                else None
            ),
            crs=target_crs or geom_info.srid or None,
            feature_count=count,
        )

    def _output_geometry_type(self: Self, out_path: Path, column: str) -> str | None:
        """The type of the first geometry in `column` of the output, as
        ST_GeometryType names it (`POINT`, `MULTIPOLYGON`), read from the parquet
        just written rather than from the source a second time."""
        try:
            geom = sql_identifier(column)
            first = self.con.execute(
                f"SELECT ST_GeometryType({geom}) FROM read_parquet(?) "
                f"WHERE {geom} IS NOT NULL LIMIT 1",
                [str(out_path)],
            ).fetchone()
        except Exception as e:
            logger.debug("Reading the geometry type of %s failed: %s", out_path, e)
            return None
        return first[0] if first else None

    # ------------------------------------------------------------------
    # Raster → COG TIFF
    # ------------------------------------------------------------------

    def to_cog(
        self: Self,
        src_path: str,
        out_path: str | Path,
        target_crs: str | None = None,
    ) -> DatasetMetadata:
        """Convert any raster to a Cloud-Optimized GeoTIFF (COG)."""
        from osgeo import gdal

        logger.info("Converting raster to COG: %s", src_path)

        out = Path(out_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        # The GeoTIFF drivers only: as for ST_Read, GDAL would otherwise pick
        # the driver by the file's content.
        ds = gdal.OpenEx(
            str(src_path), gdal.OF_RASTER, allowed_drivers=["GTiff", "COG"]
        )
        if ds is None:
            raise FileNotFoundError(f"Cannot open raster {src_path}")

        try:
            proj_wkt = ds.GetProjectionRef() or ds.GetProjection() or None

            options = {"format": "COG", "creationOptions": ["COMPRESS=LZW"]}

            if target_crs:
                logger.info("Reprojecting raster to %s: %s", target_crs, src_path)
                with tempfile.TemporaryDirectory(prefix="goatlib_cog_") as tmp_dir:
                    tmp_reproj = Path(tmp_dir) / f"{out.stem}_tmp.tif"
                    warp_opts = gdal.WarpOptions(dstSRS=target_crs)
                    gdal.Warp(str(tmp_reproj), ds, options=warp_opts)

                    logger.info("Creating COG: %s", out_path)
                    translate_opts = gdal.TranslateOptions(**options)
                    gdal.Translate(str(out), str(tmp_reproj), options=translate_opts)
            else:
                logger.info("Creating COG: %s", out_path)
                translate_opts = gdal.TranslateOptions(**options)
                gdal.Translate(str(out), ds, options=translate_opts)

            logger.info("COG conversion complete: %s", out_path)

            return DatasetMetadata(
                path=str(out_path),
                source_type="raster",
                format="tif",
                crs=target_crs or proj_wkt or None,
                storage_backend=detect_path_type(src_path),
            )

        finally:
            ds = None

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------
    def _extract_supported_from_zip(self: Self, zip_path: str) -> Iterator[Path]:
        """Extract all files from a ZIP archive, then yield supported ones.

        Extracts everything first so that companion/sidecar files (e.g. .dbf,
        .shx, .prj for shapefiles) are available when GDAL opens the main file.
        """
        tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_zip_"))
        try:
            with zipfile.ZipFile(zip_path) as z:
                # Extract all files into a flat directory
                for m in z.namelist():
                    if m.endswith("/"):
                        continue
                    dest = tmp_dir / Path(m).name
                    with z.open(m) as src, open(dest, "wb") as dst:
                        dst.write(src.read())

            # Yield only the files with supported extensions
            supported = [f for f in tmp_dir.iterdir() if f.suffix.lower() in ALL_EXTS]
            if not supported:
                raise ValueError(f"No supported files found in {zip_path}")

            yield from supported
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise
