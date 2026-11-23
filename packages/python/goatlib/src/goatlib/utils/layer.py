"""Layer ID utilities for GOAT services.

Provides shared layer ID normalization and schema lookup
used across geoapi and processes services.
"""

import logging
import os
import re
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from goatlib.utils.credentials import postgres_attach_target

if TYPE_CHECKING:
    from cachetools import TTLCache

logger = logging.getLogger(__name__)


class InvalidLayerIdError(ValueError):
    """Raised when a layer ID is invalid."""

    def __init__(
        self: "InvalidLayerIdError", layer_id: str, message: str | None = None
    ) -> None:
        self.layer_id = layer_id
        self.message = message or f"Invalid layer ID: {layer_id}. Expected UUID format."
        super().__init__(self.message)


class LayerNotFoundError(ValueError):
    """Raised when a layer is not found in the catalog."""

    def __init__(self: "LayerNotFoundError", layer_id: str) -> None:
        self.layer_id = layer_id
        super().__init__(f"Layer not found: {layer_id}")


class DuckDBConnection(Protocol):
    """Protocol for DuckDB connection objects."""

    def execute(
        self: "DuckDBConnection", query: str, parameters: list | None = None
    ) -> "DuckDBConnection": ...
    def fetchone(self: "DuckDBConnection") -> tuple | None: ...


class DuckLakeManagerProtocol(Protocol):
    """Protocol for DuckLake manager objects."""

    @property
    def postgres_uri(self: "DuckLakeManagerProtocol") -> str | None: ...
    @property
    def catalog_schema(self: "DuckLakeManagerProtocol") -> str | None: ...
    def connection(self: "DuckLakeManagerProtocol") -> DuckDBConnection: ...
    def reconnect(self: "DuckLakeManagerProtocol") -> None: ...


def normalize_layer_id(layer_id: str) -> str:
    """Normalize layer ID to standard UUID format with hyphens.

    Accepts:
    - 32-char hex: abc123def456...
    - UUID format: abc123de-f456-...

    Args:
        layer_id: Layer ID in any supported format

    Returns:
        Standard UUID format (lowercase, with hyphens)

    Raises:
        InvalidLayerIdError: If layer ID is not a valid UUID format
    """
    # Remove hyphens first to validate
    clean = layer_id.replace("-", "").lower()

    # Validate it's a valid hex string of correct length
    if len(clean) != 32 or not re.match(r"^[a-f0-9]+$", clean):
        raise InvalidLayerIdError(layer_id)

    # Return standard UUID format with hyphens
    return f"{clean[:8]}-{clean[8:12]}-{clean[12:16]}-{clean[16:20]}-{clean[20:]}"


def format_uuid(uuid_str: str) -> str:
    """Format a 32-char hex string as UUID with hyphens.

    Args:
        uuid_str: 32-character hex string or already-formatted UUID

    Returns:
        UUID string with hyphens
    """
    if len(uuid_str) == 32:
        return f"{uuid_str[:8]}-{uuid_str[8:12]}-{uuid_str[12:16]}-{uuid_str[16:20]}-{uuid_str[20:]}"
    return uuid_str


def layer_id_to_table_name(layer_id: str) -> str:
    """Convert layer ID (with hyphens) to DuckLake table name (no hyphens).

    Args:
        layer_id: Normalized layer ID (UUID format with hyphens)

    Returns:
        Table name in format t_<uuid_without_hyphens>
    """
    return f"t_{layer_id.replace('-', '')}"


# The schema every new layer table is created in. Its `path` in the DuckLake
# catalog is the DATA_PATH root, so a table's files land at
# DATA_PATH/t_<layer_id>/ with no directory in between. Named `main` because
# that is DuckDB's default schema and it never appears on disk.
LAYER_SCHEMA = "main"


def layer_schema_name() -> str:
    """The DuckLake schema a **newly created** layer table goes in.

    Answers only "where should a new table go". Where an *existing* table
    lives is a question for the catalog — `resolve_layer_schema` — because
    layers created before this naming changed are still in their old schema
    and are never moved by application code.

    Ownership is deliberately not an input: it lives on `customer.layer`, and
    encoding it in the storage path is what this replaced.
    """
    return LAYER_SCHEMA


def layer_table_path(layer_id: str) -> str:
    """Build the fully qualified DuckLake table path for a **new** layer table.

    For a table that already exists, use `resolve_layer_table_path` instead.

    Args:
        layer_id: Layer UUID, with or without hyphens

    Returns:
        Table path in format lake.<schema>.<table>
    """
    return f"lake.{layer_schema_name()}.{layer_id_to_table_name(layer_id)}"


# ---------------------------------------------------------------------------
# Promoted catalog layers
#
# A catalog layer is not a DuckLake table: it is one immutable parquet file,
# written by `catalog_materialize`, read through a view that adds `rowid`. Every
# service that touches one — the tool runners, geoapi, GC — must agree on where
# the file is and what the relation is called, so all of that lives here.
# ---------------------------------------------------------------------------

#: The DuckDB schema the per-layer views are created in.
CATALOG_SCHEMA = "catalog_layers"


def catalog_layers_dir() -> Path:
    """Where materialized catalog layers live.

    `CATALOG_LAYERS_DIR` wins; otherwise `DATA_DIR/catalog/layers`. The same
    derivation geoapi's settings use, so a deployment that overrides the
    directory moves the writer and every reader together.
    """
    override = os.environ.get("CATALOG_LAYERS_DIR")
    if override:
        return Path(override)
    return Path(os.environ.get("DATA_DIR", "/app/data")) / "catalog" / "layers"


def catalog_tiles_dir() -> Path:
    """Where a materialized catalog layer's PMTiles live.

    A sibling of `catalog_layers_dir`, not the same directory: the parquet is
    the layer's source of truth while the tiles are a cache derived from it, so
    the tiles can be wiped to force a rebuild without touching data that would
    otherwise have to be fetched from the catalog bucket again. It also leaves
    each free to sit on its own storage — tiles are range-read, bulk data is
    not.

    `CATALOG_TILES_DIR` wins; otherwise `DATA_DIR/catalog/tiles`.
    """
    override = os.environ.get("CATALOG_TILES_DIR")
    if override:
        return Path(override)
    return Path(os.environ.get("DATA_DIR", "/app/data")) / "catalog" / "tiles"


def catalog_layer_parquet(layer_id: str) -> Path | None:
    """The materialized file of a promoted catalog layer, or None.

    Existence of the file IS the signal — the same check geoapi's resolver
    makes — so tools and serving agree about what counts as a catalog layer.
    A strict UUID gate runs before the id becomes a filename: `is_layer_id`
    accepts any 36-char/4-hyphen string, so without it a crafted value with
    '/' or '.' would traverse out of the directory.
    """
    if ":" in layer_id:
        return None
    try:
        table = layer_id_to_table_name(normalize_layer_id(layer_id))
    except Exception:
        return None
    path = catalog_layers_dir() / f"{table}.parquet"
    return path if path.exists() else None


# Layer files are found here: the raster file GOAT stores for a layer.
def stored_raster_file(layer_id: str, layers_dir: Path | None = None) -> Path:
    """The raster file GOAT stores for a layer: `t_<id>.tif` beside the
    parquet copies (`layers_dir`, else `catalog_layers_dir`), written by the
    `catalog_materialize` job for a raster promoted from the catalog.

    A trusted location, unlike a layer's `url`, which is an address the user
    typed and opens only through the URL guard: it is named from the id alone
    (a strict UUID, raising `InvalidLayerIdError` otherwise), never from the
    layer's `url`. The catalog bucket is private, so the item's own href is no
    address a reader can open; the job writes here and geoapi, processes,
    core's heal check and the catalog GC look here.
    """
    table = layer_id_to_table_name(normalize_layer_id(layer_id))
    return (layers_dir or catalog_layers_dir()) / f"{table}.tif"


def catalog_layer_relation(layer_id: str) -> str:
    """The SQL relation a catalog layer is read through: `catalog_layers."t_…"`."""
    return f'{CATALOG_SCHEMA}."{layer_id_to_table_name(layer_id)}"'


def catalog_view_sql(layer_id: str, path: Path) -> list[str]:
    """The statements that create a catalog layer's view on a connection.

    `file_row_number` becomes `rowid`, so every rowid-based query — feature ids,
    edits, tile joins — works on a catalog layer exactly as on a DuckLake table.
    """
    table = layer_id_to_table_name(layer_id)
    return [
        f"CREATE SCHEMA IF NOT EXISTS {CATALOG_SCHEMA}",
        f'CREATE VIEW IF NOT EXISTS {CATALOG_SCHEMA}."{table}" AS '
        f"SELECT file_row_number AS rowid, * EXCLUDE (file_row_number) "
        f"FROM read_parquet('{path}', file_row_number=true)",
    ]


def is_catalog_relation(table_path: str) -> bool:
    """True for the relation `resolve_layer_table_path` returns for a catalog layer."""
    return table_path.startswith(f"{CATALOG_SCHEMA}.")


def table_path_parts(table_path: str) -> tuple[str, str]:
    """``(schema, table)`` for either relation shape a resolver can return.

    `lake.<schema>.<table>` for a DuckLake table, `catalog_layers."<table>"` for
    a catalog layer. Callers that used to `split(".", 2)` assumed the first
    shape only and blew up on the second.
    """
    if is_catalog_relation(table_path):
        table = table_path[len(CATALOG_SCHEMA) + 1 :].strip('"')
        return CATALOG_SCHEMA, table
    parts = table_path.split(".")
    if len(parts) == 3 and parts[0] == "lake":
        return parts[1].strip('"'), parts[2].strip('"')
    raise ValueError(f"not a layer relation: {table_path!r}")


def quoted_relation(table_path: str) -> str:
    """The relation, quoted for use in a statement, for either shape.

    `lake."schema"."table"` or `catalog_layers."table"` — the catalog schema is
    a plain DuckDB schema on the connection, not inside the `lake` catalog.
    """
    schema, table = table_path_parts(table_path)
    if schema == CATALOG_SCHEMA:
        return f'{CATALOG_SCHEMA}."{table}"'
    return f'lake."{schema}"."{table}"'


def resolve_layer_schema(
    con: "DuckDBConnection",
    layer_id: str,
    catalog_schema: str,
    postgres_uri: str,
) -> str | None:
    """Look up which schema actually holds a layer's table.

    Same indexed lookup as `get_schema_for_layer`, for callers that hold a
    DuckDB connection rather than a DuckLake manager (the goatlib tools).
    Queries the catalog's own Postgres tables rather than the attached lake's
    metadata, which on DuckLake 1.5.x would lazily load every table.

    Returns:
        The schema name, or None when the catalog has no such table — which
        is the normal answer for a layer whose table has not been created yet.
    """
    from goatlib.storage.ducklake import fetch_one

    target = postgres_attach_target(con, postgres_uri)
    con.execute(f"ATTACH IF NOT EXISTS 'postgres:{target}' AS pgmeta (READ_ONLY)")
    row = fetch_one(
        con,
        f"SELECT s.schema_name "
        f"FROM pgmeta.{catalog_schema}.ducklake_table t "
        f"JOIN pgmeta.{catalog_schema}.ducklake_schema s "
        f"ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL "
        f"WHERE t.table_name = ? AND t.end_snapshot IS NULL",
        [layer_id_to_table_name(layer_id)],
    )
    return row[0] if row else None


@cache
def _schema_cache() -> "TTLCache[str, str]":
    """Global schema cache, shared across service instances: 1 hour TTL, max
    10K entries. Created on first use: cachetools is in goatlib's `full`
    extra, and core imports this module for `stored_raster_file` without it."""
    from cachetools import TTLCache

    return TTLCache(maxsize=10000, ttl=3600)


def _is_connection_error(error: Exception) -> bool:
    """Check if error is a recoverable connection error."""
    error_msg = str(error).lower()
    return any(
        s in error_msg for s in ["ssl", "eof", "connection", "closed", "unsuccessful"]
    )


def get_schema_for_layer(
    layer_id: str,
    ducklake_manager: DuckLakeManagerProtocol,
    max_retries: int = 1,
) -> str:
    """Get schema name for a layer ID, with caching.

    Resolves via one indexed query on the DuckLake catalog's own Postgres
    tables (ducklake_table ⋈ ducklake_schema). Querying the attached lake
    catalog's metadata instead (information_schema / duckdb_tables) would
    lazily load every table in the catalog on DuckLake 1.5.x — ~45 s at
    12k tables (duckdb/ducklake#1269).

    Args:
        layer_id: Normalized layer ID (UUID format with hyphens)
        ducklake_manager: DuckLake manager instance for database access
        max_retries: Number of retry attempts on connection error

    Returns:
        Schema name (e.g., 'user_abc123...')

    Raises:
        LayerNotFoundError: If layer not found in catalog
    """
    # Check cache first
    schema_cache = _schema_cache()
    if layer_id in schema_cache:
        return schema_cache[layer_id]

    table_name = layer_id_to_table_name(layer_id)
    catalog_schema = ducklake_manager.catalog_schema
    query = (
        f"SELECT s.schema_name "
        f"FROM pgmeta.{catalog_schema}.ducklake_table t "
        f"JOIN pgmeta.{catalog_schema}.ducklake_schema s "
        f"ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL "
        f"WHERE t.table_name = ? AND t.end_snapshot IS NULL"
    )

    from goatlib.storage.ducklake import uri_with_application_name

    pg_uri = ducklake_manager.postgres_uri
    application_name = getattr(ducklake_manager, "application_name", None)
    if application_name:
        pg_uri = uri_with_application_name(pg_uri, application_name)

    last_error = None
    result = None

    for attempt in range(max_retries + 1):
        try:
            with ducklake_manager.connection() as con:
                target = postgres_attach_target(con, pg_uri)
                con.execute(
                    f"ATTACH IF NOT EXISTS 'postgres:{target}' AS pgmeta (READ_ONLY)"
                )
                result = con.execute(query, [table_name]).fetchone()
            break
        except Exception as e:
            last_error = e
            if attempt < max_retries and _is_connection_error(e):
                logger.warning("DuckLake connection error, reconnecting: %s", e)
                ducklake_manager.reconnect()
            else:
                raise

    if result is None and last_error is not None:
        raise last_error

    if not result:
        raise LayerNotFoundError(layer_id)

    schema_name = result[0]
    schema_cache[layer_id] = schema_name
    logger.debug("Cached schema for layer %s: %s", layer_id, schema_name)

    return schema_name


def clear_schema_cache() -> None:
    """Clear the schema cache. Useful for testing."""
    _schema_cache().clear()


__all__ = [
    "CATALOG_SCHEMA",
    "catalog_layers_dir",
    "catalog_layer_parquet",
    "stored_raster_file",
    "catalog_layer_relation",
    "catalog_view_sql",
    "is_catalog_relation",
    "table_path_parts",
    "quoted_relation",
    "InvalidLayerIdError",
    "LayerNotFoundError",
    "normalize_layer_id",
    "format_uuid",
    "layer_id_to_table_name",
    "LAYER_SCHEMA",
    "layer_schema_name",
    "layer_table_path",
    "get_schema_for_layer",
    "clear_schema_cache",
]
