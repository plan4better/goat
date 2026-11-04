"""Parquet configuration constants for consistent settings across goatlib.

These settings are used by:
- goatlib.io.parquet.write_optimized_parquet()
- goatlib.tools.base._get_duckdb_connection() (DuckLake settings)
- every parquet COPY in goatlib (parquet_copy_options)

Row Group Size Rationale:
    75K rows is a good balance between:
    - I/O efficiency: Larger groups = fewer seeks, better compression
    - Memory usage: Smaller groups = less memory during processing
    - Query selectivity: Smaller groups = more can be skipped with predicates
    - For spatial data with Hilbert sorting, this groups ~75K nearby features

Compression Rationale:
    ZSTD provides ~20-30% better compression than Snappy with similar speed.
    It's now well-supported in all major Parquet implementations.

Parquet V2 Rationale:
    V2 enables advanced encodings that significantly improve compression:
    - DELTA_BINARY_PACKED: For integers (timestamps, IDs)
    - DELTA_LENGTH_BYTE_ARRAY: For strings and binary (geometry WKB)
    - BYTE_STREAM_SPLIT: For floating point (coordinates)

    These encodings can reduce file sizes by 20-40% for typical GIS data.
"""

# Default row group size for Parquet files
# 50K-100K rows is the recommended range
PARQUET_ROW_GROUP_SIZE = 75000

# Default compression algorithm
PARQUET_COMPRESSION = "zstd"

# Parquet format version (1 or 2)
# V2 enables better encodings
PARQUET_VERSION = "2"

# GeoParquet flavour of the parquet files goatlib writes with DuckDB, as
# `GEOPARQUET_VERSION '<value>'` in a COPY (see `parquet_copy_options`).
# "BOTH" writes the GeoParquet 1.0 `geo` metadata, as the default does, and
# also stores the column as Parquet's own GEOMETRY type. DuckDB writes the
# `geo` metadata only for a file with rows, and without it reads a geometry
# column back as plain BLOB; the Parquet type is in the file's schema, so a
# file without rows still reads back as GEOMETRY and the next tool finds its
# geometry column.
#
# The Parquet type carries the column's CRS as it was written, and DuckDB
# reads that type in preference to the `geo` metadata. A plain GEOMETRY
# column (every DuckLake table's, and an ST_Transform result's) therefore
# reads back as plain GEOMETRY, where the `geo` metadata alone gives
# GEOMETRY('OGC:CRS84'). Spatial predicates, UNION ALL and INSERT accept the
# two together; a call that compares CRSs (ST_CRS, a two-argument
# ST_Transform) sees none on such a column.
GEOPARQUET_VERSION = "BOTH"


def parquet_copy_options(*options: str) -> str:
    """The option list of a DuckDB `COPY ... TO` a parquet file: FORMAT
    PARQUET, then `options` (such as "COMPRESSION ZSTD"), then the GeoParquet
    version. Every parquet COPY in goatlib takes its options from here, so a
    file it writes keeps its geometry column a GEOMETRY also without rows;
    the option changes nothing in a file without a geometry column."""
    return (
        "("
        + ", ".join(
            ("FORMAT PARQUET", *options, f"GEOPARQUET_VERSION '{GEOPARQUET_VERSION}'")
        )
        + ")"
    )
