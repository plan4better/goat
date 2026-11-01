"""I/O utilities for GOAT data processing.

This module provides:
- IOConverter: Convert various formats to Parquet/GeoParquet
- Optimized Parquet writing with V2 format
- Optimized GeoParquet writing with Hilbert sorting and bbox columns
- File format detection and discovery
"""

from typing import TYPE_CHECKING

# Imported on demand. Importing any submodule runs this __init__, and core and
# geoapi import goatlib.io.config at startup without goatlib's `full` extra:
# eager imports here pulled the converters (pyproj, duckdb) and S3 discovery
# (boto3) into both and stopped them from starting. PMTiles needs the pmtiles
# package, which the print worker does not install.
if TYPE_CHECKING:
    from goatlib.io.config import (
        PARQUET_COMPRESSION,
        PARQUET_ROW_GROUP_SIZE,
        PARQUET_VERSION,
    )
    from goatlib.io.converter import IOConverter
    from goatlib.io.ingest import convert_any
    from goatlib.io.parquet import (
        verify_geoparquet_optimization,
        write_optimized_geoparquet,
        write_optimized_parquet,
    )
    from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

_LAZY: dict[str, str] = {
    "IOConverter": "goatlib.io.converter",
    "convert_any": "goatlib.io.ingest",
    "write_optimized_parquet": "goatlib.io.parquet",
    "write_optimized_geoparquet": "goatlib.io.parquet",
    "verify_geoparquet_optimization": "goatlib.io.parquet",
    "PMTilesConfig": "goatlib.io.pmtiles",
    "PMTilesGenerator": "goatlib.io.pmtiles",
    "PARQUET_COMPRESSION": "goatlib.io.config",
    "PARQUET_ROW_GROUP_SIZE": "goatlib.io.config",
    "PARQUET_VERSION": "goatlib.io.config",
}


def __getattr__(name: str) -> object:
    """Resolve an export to its module the first time it is asked for."""
    module_path = _LAZY.get(name)
    if module_path is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    import importlib

    value = getattr(importlib.import_module(module_path), name)
    globals()[name] = value  # subsequent lookups skip __getattr__
    return value


def __dir__() -> list[str]:
    return sorted(__all__)


__all__ = [
    "IOConverter",
    "convert_any",
    "write_optimized_parquet",
    "write_optimized_geoparquet",  # alias for backward compatibility
    "verify_geoparquet_optimization",
    # PMTiles generation
    "PMTilesConfig",
    "PMTilesGenerator",
    # Config constants
    "PARQUET_COMPRESSION",
    "PARQUET_ROW_GROUP_SIZE",
    "PARQUET_VERSION",
]
