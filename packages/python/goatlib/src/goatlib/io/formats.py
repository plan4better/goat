from enum import StrEnum
from pathlib import PurePath
from types import MappingProxyType
from typing import FrozenSet, Mapping

from goatlib.io.sql import sql_literal


class FileFormat(StrEnum):
    """Canonical enumeration of atomic file extensions (lower‑case)."""

    CSV = ".csv"
    XLSX = ".xlsx"
    TSV = ".tsv"
    TXT = ".txt"
    DSV = ".dsv"
    GEOJSON = ".geojson"
    JSON = ".json"
    GPKG = ".gpkg"
    SHP = ".shp"
    ZIP = ".zip"
    KML = ".kml"
    KMZ = ".kmz"
    GPX = ".gpx"
    PARQUET = ".parquet"
    TIF = ".tif"
    TIFF = ".tiff"


# -------------------------------------------------------------------------
# Grouped extension sets, reusing Enum members
# -------------------------------------------------------------------------
VECTOR_EXTS: FrozenSet[str] = frozenset(
    {
        FileFormat.GEOJSON,
        FileFormat.JSON,
        FileFormat.GPKG,
        FileFormat.SHP,
        FileFormat.ZIP,
        FileFormat.KML,
        FileFormat.KMZ,
        FileFormat.GPX,
        FileFormat.PARQUET,
    }
)

TABULAR_EXTS: FrozenSet[str] = frozenset(
    {
        FileFormat.CSV,
        FileFormat.XLSX,
        FileFormat.TXT,
        FileFormat.PARQUET,
        FileFormat.TSV,
        FileFormat.DSV,
    }
)
RASTER_EXTS: FrozenSet[str] = frozenset({FileFormat.TIF, FileFormat.TIFF})
ALL_EXTS: FrozenSet[str] = VECTOR_EXTS | TABULAR_EXTS | RASTER_EXTS

# -------------------------------------------------------------------------
# How each accepted format is read
# -------------------------------------------------------------------------
# `ALL_EXTS` is what an upload may be: core presigns only those names, the
# import refuses any other suffix before downloading, and the converter reads
# each with the GDAL drivers below, with a reader of its own
# (`NON_GDAL_EXTS`), or as a raster. A unit test keeps the three in step.
#
# GDAL picks a driver by a file's content, not its name. Every `ST_Read` of a
# user file therefore names the drivers of its suffix, so the file is read as
# the format it is named or not at all.
READ_DRIVERS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        FileFormat.GEOJSON: ("GeoJSON", "GeoJSONSeq"),
        # A `.json` may also be ESRI JSON or TopoJSON.
        FileFormat.JSON: ("GeoJSON", "GeoJSONSeq", "ESRIJSON", "TopoJSON"),
        FileFormat.GPKG: ("GPKG",),
        FileFormat.SHP: ("ESRI Shapefile",),
        FileFormat.KML: ("KML",),
        FileFormat.GPX: ("GPX",),
        FileFormat.XLSX: ("XLSX",),
    }
)

#: Read without GDAL: text tables (the delimiter sniffed, so `.dsv` too) and
#: parquet by DuckDB's own readers, archives by unpacking their members.
NON_GDAL_EXTS: FrozenSet[str] = frozenset(
    {
        FileFormat.CSV,
        FileFormat.TSV,
        FileFormat.TXT,
        FileFormat.DSV,
        FileFormat.PARQUET,
        FileFormat.ZIP,
        FileFormat.KMZ,
    }
)


def _unsupported(suffix: str) -> ValueError:
    return ValueError(f"Unsupported file format: {suffix or 'no file extension'}")


def allowed_drivers_sql(suffix: str) -> str:
    """The `allowed_drivers` argument of an `ST_Read` of a user file with
    `suffix`, e.g. `allowed_drivers=ARRAY['GPKG']`.

    Raises `ValueError("Unsupported file format: <suffix>")` for a suffix
    without drivers, so no such file is handed to GDAL.
    """
    suffix = suffix.lower()
    drivers = READ_DRIVERS.get(suffix)
    if not drivers:
        raise _unsupported(suffix)
    return "allowed_drivers=ARRAY[{}]".format(", ".join(map(sql_literal, drivers)))


def refuse_unsupported_format(name: str) -> None:
    """Raise `ValueError("Unsupported file format: <suffix>")` (or `...: no
    file extension`) unless the file `name` has a suffix in `ALL_EXTS`. The
    converter's refusal, and an upload's before it is stored or downloaded."""
    suffix = PurePath(name).suffix.lower()
    if suffix not in ALL_EXTS:
        raise _unsupported(suffix)
