"""Base class for Windmill tool scripts.

This module provides BaseToolRunner - an abstract base class that handles
the common workflow for all GOAT tools:

1. Run analysis (implemented by subclass)
2. Ingest results into DuckLake
3. Create layer metadata in PostgreSQL
4. Optionally link to a project
5. Return standardized output

Subclasses only need to implement:
- process() - the actual analysis logic
- tool_class - the analysis tool class
- output_geometry_type - "point", "line", "polygon", or None
- default_output_name - default layer name

Example:
    class BufferToolRunner(BaseToolRunner[BufferToolParams]):
        tool_class = BufferTool
        output_geometry_type = "polygon"
        default_output_name = "Buffer"

        def process(self, params, temp_dir):
            # Run buffer analysis
            # Return (output_path, metadata)
            ...

    # Windmill entry point
    def main(params: BufferToolParams):
        runner = BufferToolRunner()
        runner.init_from_env()
        return runner.run(params)
"""

import asyncio
import logging
import os
import tempfile
import uuid as uuid_module
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generic, Self, TypeVar

import asyncpg
import duckdb

from goatlib.bundles.artifacts.storage import resolve_artifact
from goatlib.io.config import (
    PARQUET_COMPRESSION,
    PARQUET_ROW_GROUP_SIZE,
    PARQUET_VERSION,
)
from goatlib.models.bundle import BundleArtifactState, artifact_state
from goatlib.models.io import DatasetMetadata
from goatlib.storage.s3_config import apply_duckdb_s3_settings, boto_client_kwargs
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.schemas import ToolInputBase, ToolOutputBase
from goatlib.utils.layer import (
    layer_id_to_table_name,
    layer_schema_name,
    layer_table_path,
    resolve_layer_schema,
)

logger = logging.getLogger(__name__)

TParams = TypeVar("TParams", bound=ToolInputBase)


def _catalog_layer_parquet(layer_id: str) -> "Path | None":
    """The materialized file of a promoted catalog layer, or None.

    One definition for every reader — see `goatlib.utils.layer`.
    """
    from goatlib.utils.layer import catalog_layer_parquet

    return catalog_layer_parquet(layer_id)


def _get_or_create_event_loop() -> asyncio.AbstractEventLoop:
    """Get the current event loop or create a new one if none exists.

    This is needed when running tools in thread pools or other contexts
    where there may not be a running event loop.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("Event loop is closed")
        return loop
    except RuntimeError:
        # No event loop in current thread, create a new one
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


@dataclass
class ToolSettings:
    """Settings for tool execution, loaded from environment."""

    # PostgreSQL connection (for layer metadata)
    postgres_server: str
    postgres_port: int
    postgres_user: str
    postgres_password: str
    postgres_db: str

    # DuckLake settings
    ducklake_postgres_uri: str
    ducklake_catalog_schema: str
    ducklake_data_dir: str

    # Tiles storage (separate from source data - cache/derived data)
    tiles_data_dir: str = "/app/data/tiles"

    # Bundle artifacts (derived, regenerable build products). Kept on the data
    # volume next to DuckLake and tiles rather than in object storage: they are
    # read by the routing engine as local files on the same volume.
    bundles_data_dir: str = "/app/data/bundles"

    # OD matrix / travel time matrices
    od_matrix_base_path: str = "/app/data/traveltime_matrices"

    # Local C++ routing backend paths
    street_network_edges_base_path: str = "/app/data/street_network/edges"
    street_network_nodes_base_path: str = "/app/data/street_network/nodes"
    pt_network_base_path: str = "/app/data/pt_network/gtfs.bin"

    # S3 settings (shared for DuckLake and uploads)
    s3_provider: str = "hetzner"  # hetzner, aws, minio, or any S3-compatible store
    s3_force_path_style: bool = False  # path-style addressing for on-prem stores
    s3_endpoint_url: str | None = None
    s3_public_endpoint_url: str | None = None  # Public URL for presigned URLs
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_region_name: str = "us-east-1"
    s3_bucket_name: str | None = None  # Bucket for user uploads/imports
    # Largest object a browser upload may be; checked before download.
    max_upload_dataset_file_size: int = 5 * 1024 * 1024 * 1024

    # Schema for customer tables
    customer_schema: str = "customer"

    # Routing settings (HTTP routing service is retired; in-process routing
    # uses street_network_*/pt_network_* paths in goatlib.config.base instead).
    # These fields remain as None for backward compatibility with any unreachable
    # v1 catchment_area code that may still reference them.
    goat_routing_url: str | None = None
    goat_routing_authorization: str | None = None
    r5_url: str | None = None
    r5_region_mapping_path: str | None = None

    # Geocoding settings
    geocoding_url: str | None = None
    geocoding_authorization: str | None = None

    # PMTiles generation settings
    pmtiles_enabled: bool = True  # Enable PMTiles generation for spatial layers
    pmtiles_min_zoom: int = 0
    pmtiles_max_zoom: int = 14  # Maximum zoom level for PMTiles generation

    def get_s3_client(self: Self) -> Any:
        """boto3 S3 client for the configured store."""
        import boto3

        return boto3.client(
            "s3",
            aws_access_key_id=self.s3_access_key_id,
            aws_secret_access_key=self.s3_secret_access_key,
            region_name=self.s3_region_name,
            **boto_client_kwargs(
                endpoint_url=self.s3_endpoint_url,
                provider=self.s3_provider,
                force_path_style=self.s3_force_path_style,
            ),
        )

    def get_s3_public_client(self: Self) -> Any:
        """boto3 S3 client that signs URLs for the public endpoint.

        Falls back to the internal endpoint when no public one is configured.
        """
        import boto3

        return boto3.client(
            "s3",
            aws_access_key_id=self.s3_access_key_id,
            aws_secret_access_key=self.s3_secret_access_key,
            region_name=self.s3_region_name,
            **boto_client_kwargs(
                endpoint_url=self.s3_public_endpoint_url or self.s3_endpoint_url,
                provider=self.s3_provider,
                force_path_style=self.s3_force_path_style,
            ),
        )

    @classmethod
    def _get_secret(cls: type[Self], name: str, default: str = "") -> str:
        """Get a secret value from Windmill or environment variable.

        First tries Windmill variable (for secrets stored in Windmill),
        then falls back to environment variable.
        """
        # Try Windmill variable first (path: f/goat/{name})
        try:
            import wmill

            path = f"f/goat/{name}"
            value = wmill.get_variable(path)
            if value:
                return value
        except Exception:
            pass  # wmill not available or variable doesn't exist

        # Fall back to environment variable
        return os.environ.get(name, default)

    @classmethod
    def from_env(cls: type[Self]) -> Self:
        """Load settings from environment variables and Windmill secrets.

        Non-sensitive config is read from environment variables.
        Sensitive values (passwords, keys) are read from Windmill secrets first,
        falling back to environment variables for local development.
        """
        # Get base connection info (try Windmill vars first, then env vars)
        pg_server = cls._get_secret("POSTGRES_SERVER", "db")
        pg_port = cls._get_secret("POSTGRES_PORT", "5432")
        pg_user = cls._get_secret("POSTGRES_USER", "postgres")
        pg_db = cls._get_secret("POSTGRES_DB", "goat")
        pg_password = cls._get_secret("POSTGRES_PASSWORD", "postgres")

        # Build default URI from components (uses db hostname, not localhost)
        default_uri = (
            f"postgresql://{pg_user}:{pg_password}@{pg_server}:{pg_port}/{pg_db}"
        )

        # DuckLake attaches hold idle-in-transaction sessions for the whole
        # job, which pins transaction-pooler slots for nothing. When
        # DUCKLAKE_POSTGRES_SERVER is set they connect straight to that host
        # (e.g. the CNPG primary); otherwise behavior is unchanged.
        ducklake_pg_server = cls._get_secret("DUCKLAKE_POSTGRES_SERVER", "")
        if ducklake_pg_server:
            ducklake_uri = (
                f"postgresql://{pg_user}:{pg_password}"
                f"@{ducklake_pg_server}:{pg_port}/{pg_db}"
            )
        else:
            ducklake_uri = cls._get_secret("POSTGRES_DATABASE_URI", default_uri)

        return cls(
            postgres_server=pg_server,
            postgres_port=int(pg_port),
            postgres_user=pg_user,
            postgres_password=pg_password,
            postgres_db=pg_db,
            ducklake_postgres_uri=ducklake_uri,
            ducklake_catalog_schema=cls._get_secret(
                "DUCKLAKE_CATALOG_SCHEMA", "ducklake"
            ),
            ducklake_data_dir=cls._get_secret(
                "DUCKLAKE_DATA_DIR", "/app/data/ducklake"
            ),
            tiles_data_dir=cls._get_secret("TILES_DATA_DIR", "/app/data/tiles"),
            bundles_data_dir=cls._get_secret("BUNDLES_DATA_DIR", "/app/data/bundles"),
            od_matrix_base_path=cls._get_secret(
                "OD_MATRIX_BASE_PATH", "/app/data/traveltime_matrices"
            ),
            street_network_edges_base_path=cls._get_secret(
                "STREET_NETWORK_EDGES_BASE_PATH", "/app/data/street_network/edges"
            ),
            street_network_nodes_base_path=cls._get_secret(
                "STREET_NETWORK_NODES_BASE_PATH", "/app/data/street_network/nodes"
            ),
            pt_network_base_path=cls._get_secret(
                "PT_NETWORK_BASE_PATH", "/app/data/pt_network/gtfs.bin"
            ),
            s3_provider=cls._get_secret("S3_PROVIDER", "hetzner").lower(),
            s3_endpoint_url=cls._get_secret("S3_ENDPOINT_URL", ""),
            s3_public_endpoint_url=cls._get_secret("S3_PUBLIC_ENDPOINT_URL", "")
            or None,
            s3_access_key_id=cls._get_secret("S3_ACCESS_KEY_ID", ""),
            s3_secret_access_key=cls._get_secret("S3_SECRET_ACCESS_KEY", ""),
            s3_region_name=cls._get_secret("S3_REGION", "us-east-1"),
            s3_force_path_style=cls._get_secret("S3_FORCE_PATH_STYLE", "false").lower()
            in ("1", "true", "yes"),
            s3_bucket_name=cls._get_secret("S3_BUCKET_NAME", ""),
            # `SCHEMA` is the canonical name (core's single data schema);
            # `CUSTOMER_SCHEMA` is accepted as a fallback for older deployments.
            max_upload_dataset_file_size=int(
                cls._get_secret(
                    "MAX_UPLOAD_DATASET_FILE_SIZE", str(5 * 1024 * 1024 * 1024)
                )
            ),
            customer_schema=cls._get_secret("SCHEMA", "")
            or cls._get_secret("CUSTOMER_SCHEMA", "customer"),
            geocoding_url=cls._get_secret("GEOCODING_URL", "") or None,
            geocoding_authorization=cls._get_secret("GEOCODING_AUTHORIZATION", "")
            or None,
            # PMTiles generation settings
            pmtiles_enabled=cls._get_secret("PMTILES_ENABLED", "true").lower()
            in ("true", "1", "yes"),
            pmtiles_min_zoom=int(cls._get_secret("PMTILES_MIN_ZOOM", "0")),
            pmtiles_max_zoom=int(cls._get_secret("PMTILES_MAX_ZOOM", "14")),
        )


class SimpleToolRunner:
    """Base class with shared infrastructure for all tool runners.

    Provides:
    - Settings loading from environment
    - Logging configuration for Windmill
    - DuckDB/DuckLake connection management
    - S3 client management
    - PostgreSQL connection pool

    Subclasses: BaseToolRunner (for analysis tools), LayerDeleteRunner, LayerExportRunner
    """

    def __init__(self: Self) -> None:
        """Initialize runner."""
        self.settings: ToolSettings | None = None
        self._duckdb_con: duckdb.DuckDBPyConnection | None = None
        #: layer_id -> parquet path of every catalog view resolved so far
        self._catalog_views: dict[str, Path] = {}
        self._s3_client: Any | None = None

    @staticmethod
    def _configure_logging_for_windmill() -> None:
        """Configure Python logging to output to stdout for Windmill."""
        import sys

        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)

        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)

        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(logging.INFO)
        handler.setFormatter(
            logging.Formatter("%(name)s - %(levelname)s - %(message)s")
        )
        root_logger.addHandler(handler)

    def init_from_env(self: Self) -> None:
        """Initialize settings from environment variables."""
        self._configure_logging_for_windmill()
        self.settings = ToolSettings.from_env()

    def init(self: Self, settings: ToolSettings) -> None:
        """Initialize with explicit settings."""
        self.settings = settings

    def _get_duckdb_connection(self: Self) -> duckdb.DuckDBPyConnection:
        """Create and configure a DuckDB connection with DuckLake attached."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized. Call init_from_env() first.")

        con = duckdb.connect()

        for ext in ["spatial", "httpfs", "postgres", "ducklake"]:
            con.execute(f"INSTALL {ext}; LOAD {ext};")

        if self.settings.s3_endpoint_url:
            apply_duckdb_s3_settings(
                con,
                endpoint_url=self.settings.s3_endpoint_url,
                access_key=self.settings.s3_access_key_id,
                secret_key=self.settings.s3_secret_access_key,
                region=self.settings.s3_region_name,
                provider=self.settings.s3_provider,
                force_path_style=self.settings.s3_force_path_style,
            )

        storage_path = self.settings.ducklake_data_dir
        con.execute(f"""
            ATTACH 'ducklake:postgres:{self.settings.ducklake_postgres_uri}' AS lake (
                DATA_PATH '{storage_path}',
                METADATA_SCHEMA '{self.settings.ducklake_catalog_schema}',
                OVERRIDE_DATA_PATH true
            )
        """)

        # Configure DuckLake parquet options for optimal spatial performance:
        # - ZSTD compression: better compression ratio than Snappy
        # - V2 format: enables DELTA_BINARY_PACKED, BYTE_STREAM_SPLIT encodings
        # - Row group size: balances predicate pushdown with parallelism
        # Read-first to avoid concurrent UPSERTs against the PG metadata catalog,
        # which trigger serializable-isolation failures (40001) when many workers
        # connect simultaneously.
        self._ensure_lake_option(con, "parquet_compression", PARQUET_COMPRESSION)
        # parquet_version only accepts numeric input ('2') but is stored in
        # canonical form ('V2'); compare against the stored form or the guard
        # re-writes on every connection.
        self._ensure_lake_option(
            con,
            "parquet_version",
            PARQUET_VERSION,
            stored_value=f"V{PARQUET_VERSION}",
        )
        self._ensure_lake_option(
            con, "parquet_row_group_size", str(PARQUET_ROW_GROUP_SIZE)
        )

        return con

    def _ensure_lake_option(
        self: Self,
        con: duckdb.DuckDBPyConnection,
        key: str,
        value: str,
        stored_value: str | None = None,
    ) -> None:
        """Set a DuckLake option only if its stored value differs.

        Every `CALL lake.set_option` is an UPSERT against the PostgreSQL
        `ducklake_metadata` table. When many worker connections issue the same
        writes simultaneously, they race on serializable isolation
        (`could not serialize access due to concurrent update`, SQLSTATE 40001).
        Reading first means steady-state reconnects skip the write entirely.

        Some options are stored in a canonical form that differs from the
        accepted input form (e.g. parquet_version: input '2', stored 'V2');
        pass `stored_value` for those so the comparison matches what DuckLake
        actually persists. `set_option` always receives `value`.
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        schema = self.settings.ducklake_catalog_schema
        expected = value if stored_value is None else stored_value
        try:
            rows = con.execute(
                f"SELECT value FROM __ducklake_metadata_lake.{schema}.ducklake_metadata "  # noqa: S608
                "WHERE key = ?",
                [key],
            ).fetchall()
        except Exception as e:
            logger.debug(
                "Could not read DuckLake option %s, falling back to write: %s",
                key,
                e,
            )
            rows = None

        if rows and all(row[0] == expected for row in rows):
            return
        try:
            con.execute(f"CALL lake.set_option('{key}', '{value}')")
        except Exception as e:
            # All connections write the same constants, so losing the race to
            # a concurrent writer leaves the option in the desired state.
            if "could not serialize access" in str(e):
                logger.warning(
                    "Concurrent writer already set DuckLake option %s: %s",
                    key,
                    e,
                )
                return
            raise

    def _is_retriable_ducklake_error(self: Self, error: Exception) -> bool:
        """Check if a DuckLake error is retriable (connection/transaction issues)."""
        error_msg = str(error).lower()
        return (
            "ssl syscall error" in error_msg
            or "eof detected" in error_msg
            or "connection" in error_msg
            or "transactioncontext" in error_msg
            or "failed to commit" in error_msg
            or "rollback" in error_msg
        )

    def _execute_with_retry(
        self: Self,
        operation: str,
        sql: str,
        params: list[Any] | None = None,
        max_retries: int = 2,
    ) -> Any:
        """Execute a DuckDB/DuckLake SQL statement with retry logic.

        Args:
            operation: Description of the operation for logging
            sql: SQL statement to execute
            params: Optional list of parameters for parameterized query
            max_retries: Maximum number of retry attempts

        Returns:
            Result of the execute() call
        """
        for attempt in range(max_retries + 1):
            try:
                if params:
                    return self.duckdb_con.execute(sql, params)
                return self.duckdb_con.execute(sql)
            except Exception as e:
                if self._is_retriable_ducklake_error(e) and attempt < max_retries:
                    logger.warning(
                        "DuckLake %s error (attempt %d/%d), reconnecting: %s",
                        operation,
                        attempt + 1,
                        max_retries + 1,
                        e,
                    )
                    # Force reconnection by clearing the cached connection
                    if self._duckdb_con:
                        try:
                            self._duckdb_con.close()
                        except Exception:
                            pass
                    self._duckdb_con = None
                    continue
                raise

    @property
    def duckdb_con(self: Self) -> duckdb.DuckDBPyConnection:
        """Get or create DuckDB connection (cached).

        A fresh connection gets the catalog views replayed onto it, so a
        reconnect mid-tool is invisible to code holding a catalog relation.
        """
        if self._duckdb_con is None:
            con = self._get_duckdb_connection()
            self._duckdb_con = con
            self._replay_catalog_views(con)
        return self._duckdb_con

    def recycle_duckdb_connection(self: Self) -> None:
        """Close and clear the cached DuckDB connection so the next access rebuilds it.

        DuckLake caches catalog metadata on the connection. For tools that create
        many tables in a loop (e.g. project import), that cache grows with the
        catalog size (cumulative snapshots) and is only freed when the connection
        closes — driving the worker toward OOM on large catalogs. Recycling between
        batches releases it. Safe between DuckLake commits (each CREATE TABLE is its
        own commit), but never call it mid-transaction.
        """
        if self._duckdb_con is not None:
            try:
                self._duckdb_con.close()
            except Exception:
                pass
            self._duckdb_con = None

    @property
    def s3_client(self: Self) -> Any:
        """Get or create S3 client (cached)."""
        if self._s3_client is None:
            if self.settings is None:
                raise RuntimeError("Settings not initialized")
            self._s3_client = self.settings.get_s3_client()
        return self._s3_client

    def download_uploaded_object(
        self: Self, s3_key: str, local_file: Path, client: Any | None = None
    ) -> None:
        """Download a browser-uploaded object after checking its size.

        Presigned PUT uploads carry no size policy, so the limit is enforced
        here, before the object is fetched and converted.
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        client = client if client is not None else self.s3_client
        bucket = self.settings.s3_bucket_name
        size = client.head_object(Bucket=bucket, Key=s3_key)["ContentLength"]
        limit = self.settings.max_upload_dataset_file_size
        if size > limit:
            raise ValueError(
                f"Uploaded file is {size // 1024 // 1024} MB; "
                f"the limit is {limit // 1024 // 1024} MB."
            )
        client.download_file(Bucket=bucket, Key=s3_key, Filename=str(local_file))

    @property
    def s3_public_client(self: Self) -> Any:
        """Get S3 client for generating public presigned URLs.

        Uses the public endpoint URL if configured, otherwise falls back
        to the internal S3 client. This ensures presigned URLs are
        accessible from outside the cluster.
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        return self.settings.get_s3_public_client()

    def get_layer_table_path(self: Self, layer_id: str) -> str:
        """Build the DuckLake table path for a **new** layer table.

        For a table that already exists, use `resolve_layer_table_path`.
        """
        return layer_table_path(layer_id)

    def _export_catalog_filtered(
        self: Self,
        catalog_path: "Path",
        cql_filter: dict[str, Any],
    ) -> str:
        """One filtered COPY of a catalog layer's file to a temp parquet."""
        import json
        import tempfile

        from goatlib.storage.query_builder import build_cql_filter

        con = self.duckdb_con
        described = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{catalog_path}')"
        ).fetchall()
        cols = [r[0] for r in described]
        # The file's geometry column is whatever the publisher named it.
        geom_col = next(
            (r[0] for r in described if "GEOMETRY" in str(r[1]).upper()),
            "geometry",
        )
        filters = build_cql_filter(
            {"filter": json.dumps(cql_filter), "lang": "cql2-json"}, cols, geom_col
        )
        where = f"WHERE {' AND '.join(filters.clauses)}" if filters.clauses else ""
        tmp = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False)
        tmp.close()
        self._execute_with_retry(
            "export filtered catalog layer",
            f"COPY (SELECT * FROM read_parquet('{catalog_path}') {where}) "
            f"TO '{tmp.name}' (FORMAT PARQUET, COMPRESSION ZSTD)",
            filters.params,
        )
        return tmp.name

    def resolve_layer_table_path(self: Self, layer_id: str) -> str:
        """Find the DuckLake table path of an **existing** layer.

        Asks the catalog where the table is rather than deriving it from the
        owner, so a layer keeps working after the naming in
        `layer_schema_name` changes. Falls back to the computed path when the
        catalog has no such table — the caller then fails on its own terms
        (a missing table) instead of on a lookup that returned nothing.
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        catalog_path = _catalog_layer_parquet(layer_id)
        if catalog_path is not None:
            return self._ensure_catalog_view(layer_id, catalog_path)

        try:
            schema = resolve_layer_schema(
                self.duckdb_con,
                layer_id,
                self.settings.ducklake_catalog_schema,
                self.settings.ducklake_postgres_uri,
            )
        except Exception as e:
            logger.warning(
                "Could not resolve schema for layer %s, using computed path: %s",
                layer_id,
                e,
            )
            return layer_table_path(layer_id)

        if schema is None:
            return layer_table_path(layer_id)
        return f"lake.{schema}.{layer_id_to_table_name(layer_id)}"

    def _ensure_catalog_view(self: Self, layer_id: str, path: "Path") -> str:
        """A rowid-bearing view over a catalog layer's file, on this runner's
        own connection; returns the relation to query.

        Named by layer so tools reading several catalog layers coexist; the
        file is immutable, so a stale view cannot serve stale data. The view is
        also remembered on the runner, because a connection is not for keeps:
        `_execute_with_retry` drops it on a transient DuckLake error and
        `recycle_duckdb_connection` drops it between batches, and the retry
        that is meant to heal the failure must find the view on the new
        connection too.
        """
        from goatlib.utils.layer import catalog_layer_relation, catalog_view_sql

        self._catalog_views[layer_id] = path
        for statement in catalog_view_sql(layer_id, path):
            self.duckdb_con.execute(statement)
        return catalog_layer_relation(layer_id)

    def _replay_catalog_views(self: Self, con: duckdb.DuckDBPyConnection) -> None:
        """Recreate every catalog view this runner has resolved, on `con`."""
        from goatlib.utils.layer import catalog_view_sql

        for layer_id, path in self._catalog_views.items():
            for statement in catalog_view_sql(layer_id, path):
                con.execute(statement)

    async def get_postgres_pool(self: Self) -> asyncpg.Pool:
        """Create PostgreSQL connection pool."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        return await asyncpg.create_pool(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
            min_size=1,
            max_size=5,
        )

    async def get_layer_owner_id(self: Self, layer_id: str) -> str | None:
        """Look up the owner (user_id) of a layer from PostgreSQL.

        This is needed to access layers owned by other users (catalog/shared layers).

        Args:
            layer_id: Layer UUID string

        Returns:
            Owner's user_id as string, or None if not found
        """
        import uuid as uuid_mod

        pool = await self.get_postgres_pool()
        try:
            row = await pool.fetchrow(
                "SELECT user_id FROM customer.layer WHERE id = $1",
                uuid_mod.UUID(layer_id),
            )
            if row and row["user_id"]:
                return str(row["user_id"])
            return None
        finally:
            await pool.close()

    def get_layer_owner_id_sync(self: Self, layer_id: str) -> str | None:
        """Synchronous wrapper for get_layer_owner_id.

        Args:
            layer_id: Layer UUID string

        Returns:
            Owner's user_id as string, or None if not found
        """
        try:
            return _get_or_create_event_loop().run_until_complete(
                self.get_layer_owner_id(layer_id)
            )
        except Exception as e:
            logger.warning("Failed to look up owner for layer %s: %s", layer_id, e)
            return None

    def cleanup(self: Self) -> None:
        """Clean up resources."""
        if self._duckdb_con:
            try:
                self._duckdb_con.close()
            except Exception:
                pass
            self._duckdb_con = None


class BaseToolRunner(SimpleToolRunner, ABC, Generic[TParams]):
    """Base class for analysis tools that create new layers.

    Handles the common workflow:
    - DuckLake ingestion
    - Layer creation in PostgreSQL
    - Project linking
    - Standardized output format

    Subclasses implement the actual analysis in process().

    Attributes:
        tool_class: The analysis tool class (must have OUTPUT_GEOMETRY_TYPE).
    """

    # Subclasses must define this - used for OUTPUT_GEOMETRY_TYPE and DEFAULT_OUTPUT_NAME
    tool_class: type = None  # type: ignore[assignment]

    def __init__(self: Self) -> None:
        """Initialize tool runner."""
        super().__init__()
        self.db_service: ToolDatabaseService | None = None

    @abstractmethod
    def process(
        self: Self, params: TParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run the analysis and return output parquet path + metadata.

        This is where the actual tool logic goes. Subclasses must implement this.

        Args:
            params: Tool-specific parameters (validated Pydantic model)
            temp_dir: Temporary directory for intermediate files

        Returns:
            Tuple of (output_parquet_path, metadata)
        """
        pass

    # Subclasses should set these
    output_geometry_type: str | None = None
    default_output_name: str = "Tool Output"
    tool_type: str | None = None  # e.g., "catchment_area", "buffer", "join"

    @staticmethod
    def unique_column_name(
        columns: dict[str, str],
        name: str,
    ) -> str:
        """Return *name* if it doesn't exist in *columns*, otherwise append _1, _2, etc.

        Matches DuckDB's auto-rename behaviour for duplicate column names.
        """
        if name not in columns:
            return name
        suffix = 1
        while f"{name}_{suffix}" in columns:
            suffix += 1
        return f"{name}_{suffix}"

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict output columns based on input schemas and parameters.

        This method enables field selectors in workflow UIs to show available
        fields from upstream tool nodes BEFORE execution.

        Default behavior: pass through all input columns unchanged.
        Subclasses should override to define tool-specific output columns.

        Args:
            input_schemas: Dict mapping input name -> column schema
                e.g., {"input_layer_id": {"id": "INTEGER", "name": "VARCHAR", "geometry": "GEOMETRY"}}
            params: Tool configuration parameters

        Returns:
            Dict mapping output column name -> DuckDB type string
        """
        # Default: pass through all columns from first/primary input
        primary_input = (
            input_schemas.get("input_layer_id")
            or input_schemas.get("layer_id")
            or input_schemas.get("source_layer_id")
            or input_schemas.get("target_layer_id")
            or next(iter(input_schemas.values()), {})
        )
        return dict(primary_input)

    def get_tool_type(self: Self) -> str | None:
        """Return the tool type for this runner.

        Returns the tool_type class attribute, or derives it from default_output_name
        by converting to lowercase snake_case.

        Returns:
            Tool type string (e.g., "catchment_area", "buffer")
        """
        if self.tool_type:
            return self.tool_type
        # Derive from default_output_name by converting to lowercase snake_case
        if self.default_output_name:
            import re

            # Convert CamelCase or spaces to snake_case
            name = self.default_output_name.replace(" ", "_")
            name = re.sub(r"([A-Z])", r"_\1", name).lower()
            name = re.sub(r"_+", "_", name).strip("_")
            return name
        return None

    def get_job_id(self: Self) -> str | None:
        """Get the Windmill job ID from environment.

        Windmill sets WM_JOB_ID environment variable for each job execution.

        Returns:
            Job ID string if running in Windmill, None otherwise
        """
        return os.environ.get("WM_JOB_ID")

    def get_feature_layer_type(self: Self, params: TParams) -> str:
        """Return the feature_layer_type for the output.

        Override if the tool creates something other than "tool" type.

        Args:
            params: Tool parameters

        Returns:
            "standard", "tool", or "street_network"
        """
        return "tool"

    def compute_quantile_breaks(
        self: Self,
        table_name: str | None = None,
        column_name: str = "",
        num_breaks: int = 6,
        strip_zeros: bool = True,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        """Compute quantile breaks for a column using DuckDB.

        Args:
            table_name: Full table path (e.g., "lake.user_xxx.t_yyy")
            column_name: Column name to compute breaks for
            num_breaks: Number of break values (default 6 to match 7-color palette)
            strip_zeros: Whether to exclude zero values (default True)
            parquet_path: Alternative to table_name — read directly from parquet

        Returns:
            Dict with breaks, min, max, mean, std_dev, method, attribute
        """
        # Allow computing from parquet file directly (for temp mode)
        if not table_name and parquet_path:
            table_name = f"read_parquet('{parquet_path}')"
        if not table_name:
            return None
        from goatlib.analysis.schemas.statistics import ClassBreakMethod
        from goatlib.analysis.statistics import calculate_class_breaks

        try:
            result = calculate_class_breaks(
                con=self.duckdb_con,
                table_name=table_name,
                attribute=column_name,
                method=ClassBreakMethod.quantile,
                num_breaks=num_breaks,
                strip_zeros=strip_zeros,
            )

            if result.breaks:
                # Remove duplicates and sort
                unique_breaks = sorted(set(result.breaks))

                return {
                    "breaks": unique_breaks,
                    "min": result.min,
                    "max": result.max,
                    "mean": result.mean,
                    "std_dev": result.std_dev,
                    "method": "quantile",
                    "attribute": column_name,
                }
        except Exception as e:
            logger.warning("Failed to compute quantile breaks: %s", e)

        return None

    def get_layer_properties(
        self: Self,
        params: TParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        """Return custom layer properties (style) for the output.

        Override in subclasses to provide tool-specific styles (e.g., heatmaps).
        If None is returned, default style will be generated based on geometry type.

        Args:
            params: Tool parameters
            metadata: Dataset metadata from analysis
            table_info: DuckLake table info (for computing quantile breaks)
            parquet_path: Alternative to table_info — compute style from parquet file

        Returns:
            Style dict or None for default style
        """
        return None

    def _export_temp_layer_to_parquet(
        self: Self,
        temp_layer_id: str,
        user_id: str,
        cql_filter: dict[str, Any] | None = None,
    ) -> str:
        """Export a temporary workflow layer to parquet for chained tool input.

        Temporary layers are stored at /data/temporary/{user_id}/{workflow_id}/{node_id}/data.parquet
        The temp_layer_id format is "{workflow_id}:{node_id}" or "{workflow_id}:{node_id}:{uuid}".

        Args:
            temp_layer_id: Temp layer ID in format "workflow_id:node_id" or "workflow_id:node_id:uuid"
            user_id: User UUID for the temp directory path
            cql_filter: Optional CQL filter (applied via DuckDB query)

        Returns:
            Path to the parquet file (copy or original if no filter)
        """
        import json
        import tempfile

        from goatlib.storage.query_builder import build_cql_filter
        from goatlib.tools.temp_writer import TEMP_DATA_ROOT

        # Parse temp_layer_id - can be "workflow_id:node_id" or "workflow_id:node_id:uuid"
        parts = temp_layer_id.split(":")
        if len(parts) < 2:
            raise ValueError(
                f"Invalid temp_layer_id format: {temp_layer_id}. Expected 'workflow_id:node_id' or 'workflow_id:node_id:uuid'"
            )

        workflow_id = parts[0]
        node_id = parts[1]
        # Third part (uuid) is optional - if provided, use it to find specific file
        temp_file_uuid = parts[2] if len(parts) > 2 else None

        # Build path matching TempLayerWriter structure:
        # /data/temporary/user_{user_id}/w_{workflow_id}/n_{node_id}/
        user_id_clean = user_id.replace("-", "")
        workflow_id_clean = workflow_id.replace("-", "")
        base_path = (
            TEMP_DATA_ROOT
            / f"user_{user_id_clean}"
            / f"w_{workflow_id_clean}"
            / f"n_{node_id}"
        )

        # Find the parquet file
        if temp_file_uuid:
            # Specific file requested
            temp_parquet_path = base_path / f"t_{temp_file_uuid}.parquet"
        else:
            # Find any parquet file (should only be one per node)
            parquet_files = list(base_path.glob("t_*.parquet"))
            if not parquet_files:
                raise FileNotFoundError(
                    f"No parquet files found in: {base_path}. "
                    f"The upstream tool may not have completed successfully."
                )
            # Use the first (and typically only) parquet file
            temp_parquet_path = parquet_files[0]

        if not temp_parquet_path.exists():
            raise FileNotFoundError(
                f"Temporary layer not found: {temp_parquet_path}. "
                f"The upstream tool may not have completed successfully."
            )

        logger.info(f"Reading chained input from temp layer: {temp_parquet_path}")

        # If no filter, just return the temp file path directly
        if not cql_filter:
            return str(temp_parquet_path)

        # Apply CQL filter via DuckDB and write to a new temp file
        # Get column names from parquet
        columns_result = self.duckdb_con.execute(
            f"SELECT column_name FROM parquet_schema('{temp_parquet_path}')"
        )
        column_names = [row[0] for row in columns_result.fetchall()]

        filter_dict = {"filter": json.dumps(cql_filter), "lang": "cql2-json"}
        cql_filters = build_cql_filter(filter_dict, column_names, "geometry")

        where_clause = ""
        if cql_filters.clauses:
            where_clause = "WHERE " + " AND ".join(cql_filters.clauses)

        # Create filtered output
        temp_file = tempfile.NamedTemporaryFile(
            suffix=".parquet", delete=False, prefix="temp_layer_"
        )
        temp_path = temp_file.name
        temp_file.close()

        query = f"""
            COPY (
                SELECT * FROM read_parquet('{temp_parquet_path}')
                {where_clause}
            ) TO '{temp_path}' (FORMAT PARQUET)
        """
        self.duckdb_con.execute(query, cql_filters.params if cql_filters.params else [])

        logger.info(f"Filtered temp layer written to: {temp_path}")
        return temp_path

    def resolve_bundle_dependency(
        self: Self, bundle_id: str, kind: str
    ) -> "str | None":
        """The bundle this one depends on for ``kind``, or None if unlinked.

        A tool asks this to follow a link the user already made rather than
        making them state it twice: a public-transport bundle names the street
        network its stops were connected to, and that is the network its
        journeys' access and egress legs should be routed on.
        """
        if self.db_service is None:
            return None
        return _get_or_create_event_loop().run_until_complete(
            self.db_service.get_bundle_dependency(bundle_id, kind)
        )

    def resolve_bundle_artifact(
        self: Self, bundle_id: str, kind: str
    ) -> "tuple[str | None, BundleArtifactState | None]":
        """Path and state of a bundle's artifact of ``kind``.

        The path comes back only for a ``ready`` artifact. The state comes back
        either way, so a caller can tell "being rebuilt after an edit" from "the
        last build failed" and say so; ``None`` means no build has been
        attempted at all.

        Currency is computed from the revisions rather than read from a stored
        flag. A layer write advances ``layers_revision`` in the same statement
        that claims it, so nothing has to remember to mark anything stale — and
        a graph that silently disagreed with the layers would give wrong answers
        rather than an error.

        Artifacts live on the data volume, so this is the stored file itself —
        no copy. Callers must treat it as read-only."""
        if self.db_service is None:
            return None, None
        row = _get_or_create_event_loop().run_until_complete(
            self.db_service.get_bundle_artifact(bundle_id, kind)
        )
        if not row:
            return None, None

        state = artifact_state(
            row.get("build_status"),
            row.get("revision"),
            row["layers_revision"],
            row.get("storage_path"),
            bool(row.get("dependencies_current", True)),
        )
        if state is not BundleArtifactState.ready:
            return None, state

        resolved = resolve_artifact(self.settings.bundles_data_dir, row["storage_path"])
        if resolved is None:
            # The row is current and complete but its file is gone — a volume
            # restored from a backup that predates the build. Rebuildable, so it
            # reads as a failed build rather than as something to route on.
            return None, BundleArtifactState.failed
        return str(resolved), state

    def export_layer_to_parquet(
        self: Self,
        layer_id: str,
        user_id: str,
        cql_filter: dict[str, Any] | None = None,
    ) -> str:
        """Export a DuckLake layer to a temporary parquet file.

        Supports optional CQL2-JSON filtering.
        The layer's actual owner is looked up from the database to correctly
        access layers owned by other users (catalog/shared layers).

        Also supports reading from temporary workflow results when layer_id
        is in the format "{workflow_id}:{node_id}" (output from tool chaining).

        Args:
            layer_id: Layer UUID string or temp layer ID (workflow_id:node_id)
            user_id: User UUID string (used for fallback if layer info unavailable)
            cql_filter: Optional CQL2-JSON filter dict to apply

        Returns:
            Path to the temporary parquet file
        """
        import json
        import tempfile

        from goatlib.storage.query_builder import build_cql_filter

        # Check if this is a temp layer ID (format: workflow_id:node_id)
        if ":" in layer_id:
            return self._export_temp_layer_to_parquet(layer_id, user_id, cql_filter)

        # A materialized catalog layer already IS a parquet file — immutable,
        # so with no filter the file itself is the export.
        catalog_path = _catalog_layer_parquet(layer_id)
        if catalog_path is not None:
            if not cql_filter:
                return str(catalog_path)
            return self._export_catalog_filtered(catalog_path, cql_filter)

        # Look up the layer's actual owner to correctly access shared/catalog layers
        layer_owner_id = self.get_layer_owner_id_sync(layer_id)
        if layer_owner_id is None:
            layer_owner_id = user_id  # Fallback to passed user_id
            logger.warning(
                f"Could not find owner for layer {layer_id}, using current user {user_id}"
            )
        elif layer_owner_id != user_id:
            logger.info(
                f"Layer {layer_id} owned by {layer_owner_id}, accessed by {user_id}"
            )

        table_name = self.resolve_layer_table_path(layer_id)
        logger.debug(f"Resolved table name for layer {layer_id}: {table_name}")

        # Verify the table exists before attempting to export.
        # Only wrap genuine "table missing" errors — let connection, transaction,
        # and metadata-catalog failures bubble up unchanged so they're not
        # misdiagnosed as missing layers.
        try:
            check_result = self.duckdb_con.execute(
                f"SELECT COUNT(*) FROM {table_name} LIMIT 1"
            ).fetchone()
            logger.debug(f"Table {table_name} exists with data check: {check_result}")
        except duckdb.CatalogException as e:
            raise ValueError(
                f"Cannot access layer {layer_id} - table {table_name} not found. "
                f"Owner ID: {layer_owner_id}, requested by: {user_id}. Error: {e}"
            ) from e
        except Exception:
            logger.exception(
                "Unexpected error checking layer %s (table %s, owner %s, requester %s)",
                layer_id,
                table_name,
                layer_owner_id,
                user_id,
            )
            raise

        temp_file = tempfile.NamedTemporaryFile(
            suffix=".parquet", delete=False, prefix="layer_"
        )
        temp_path = temp_file.name
        temp_file.close()

        # Detect geometry column name and get column names from table schema
        cols_result = self._execute_with_retry(
            "describe table",
            f"DESCRIBE {table_name}",
        )
        geom_col = "geometry"  # default
        column_names: list[str] = []
        for col_name, col_type, *_ in cols_result.fetchall():
            column_names.append(col_name)
            if "GEOMETRY" in col_type.upper():
                geom_col = col_name

        # Build WHERE clause
        where_clause = ""
        params: list[Any] = []

        if cql_filter:
            filter_dict = {"filter": json.dumps(cql_filter), "lang": "cql2-json"}
            cql_filters = build_cql_filter(filter_dict, column_names, geom_col)
            if cql_filters.clauses:
                where_clause = "WHERE " + " AND ".join(cql_filters.clauses)
                params = cql_filters.params

        if where_clause:
            # Use parameterized query
            query = f"SELECT * FROM {table_name} {where_clause}"
            self._execute_with_retry(
                "export layer with filter",
                f"COPY ({query}) TO '{temp_path}' (FORMAT PARQUET, COMPRESSION ZSTD)",
                params,
            )
        else:
            self._execute_with_retry(
                "export layer",
                f"COPY {table_name} TO '{temp_path}' (FORMAT PARQUET, COMPRESSION ZSTD)",
            )

        logger.info("Exported layer %s to %s", layer_id, temp_path)
        return temp_path

    def is_layer_id(self: Self, value: str | None) -> bool:
        """Check if a string value looks like a layer UUID or temp layer reference.

        Recognizes:
        - Standard UUIDs: 36 chars with format 8-4-4-4-12
        - Temp layer IDs: "workflow_id:node_id:uuid" (from workflow tool chaining)

        Args:
            value: String to check

        Returns:
            True if the value appears to be a layer identifier
        """
        if not value or not isinstance(value, str):
            return False
        # UUIDs are 36 characters with format: 8-4-4-4-12
        if len(value) == 36 and value.count("-") == 4:
            return True
        # Temp layer IDs contain colons (e.g. "workflow_id:node_id:uuid")
        if ":" in value:
            return True
        return False

    def resolve_layer_paths(
        self: Self,
        items: list,
        user_id: str,
        path_field: str = "input_path",
        filter_field: str = "input_layer_filter",
    ) -> list:
        """Resolve layer IDs to parquet file paths in a list of Pydantic models.

        For each item in the list, if the path_field contains a layer UUID,
        export it to a parquet file and update the field with the file path.
        Also fetches and sets the layer name if not already provided.
        If a filter_field is present, it will be passed to export_layer_to_parquet.

        Args:
            items: List of Pydantic model instances (e.g., opportunities)
            user_id: User UUID for accessing layers
            path_field: Name of the field containing the layer ID/path
            filter_field: Name of the field containing the CQL2-JSON filter (default: "input_layer_filter")

        Returns:
            New list with resolved paths and names
        """
        resolved = []
        for item in items:
            input_value = getattr(item, path_field, None)
            if self.is_layer_id(input_value):
                # Get filter if present
                cql_filter = getattr(item, filter_field, None)

                # Export the layer to parquet with optional filter
                parquet_path = self.export_layer_to_parquet(
                    input_value, user_id, cql_filter=cql_filter
                )
                logger.info(f"Exported layer {input_value} to {parquet_path}")
                if cql_filter:
                    logger.info(f"Applied filter to layer {input_value}")

                # Fetch layer name if item has 'name' field and it's not set
                # Skip DB lookup for temp layer IDs (contain colons) — no DB record exists
                item_dict = item.model_dump()
                is_temp = ":" in input_value
                if "name" in item_dict and not item_dict.get("name") and not is_temp:
                    layer_info = _get_or_create_event_loop().run_until_complete(
                        self.db_service.get_layer_info(input_value)
                    )
                    if layer_info and layer_info.get("name"):
                        item_dict["name"] = layer_info["name"]
                        logger.info(
                            f"Set layer name from database: {layer_info['name']}"
                        )

                item_dict[path_field] = parquet_path
                resolved.append(type(item)(**item_dict))
            else:
                resolved.append(item)
        return resolved

    def get_project_layer_name_by_id(
        self: Self, layer_project_id: int | None
    ) -> str | None:
        """Layer name by the project-layer PK, or None. Best-effort."""
        if layer_project_id is None:
            return None
        try:
            return _get_or_create_event_loop().run_until_complete(
                self.db_service.get_project_layer_name_by_id(int(layer_project_id))
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Could not resolve project layer name by id %s: %s",
                layer_project_id,
                e,
            )
            return None

    def run(self: Self, params: TParams) -> dict[str, Any]:
        """Main entry point - runs the full tool workflow.

        1. Generate output layer ID
        2. Run analysis (subclass implements)
        3. If temp_mode: write to /data/temporary/ (no DB, no DuckLake)
        4. Else: Ingest to DuckLake, create layer in PostgreSQL, optionally add to project
        5. Return standardized output

        Args:
            params: Validated tool parameters

        Returns:
            Dict with layer metadata (ToolOutputBase format)
        """
        output_layer_id = str(uuid_module.uuid4())
        # Use result_layer_name first (new field), then output_name (legacy), then default
        output_name = (
            params.result_layer_name or params.output_name or self.default_output_name
        )

        # Check if we're in temp mode (for workflow preview)
        temp_mode = getattr(params, "temp_mode", False)
        workflow_id = getattr(params, "workflow_id", None)
        node_id = getattr(params, "node_id", None)

        if temp_mode and (not workflow_id or not node_id):
            raise ValueError("workflow_id and node_id are required when temp_mode=True")

        logger.info(
            f"Starting tool: {self.__class__.__name__} "
            f"(user={params.user_id}, output={output_layer_id}, "
            f"temp_mode={temp_mode}, "
            f"triggered_by={getattr(params, 'triggered_by_email', 'N/A')})"
        )

        # Create a single event loop for all async operations in this run
        # This ensures consistent event loop context for asyncpg connections
        loop = _get_or_create_event_loop()

        # Initialize db_service early so it's available in process() for resolve_layer_paths
        # (Only needed for non-temp mode, but also useful for reading layer info in temp mode)
        loop.run_until_complete(self._init_db_service())

        with tempfile.TemporaryDirectory(
            prefix=f"{self.__class__.__name__.lower()}_"
        ) as temp_dir:
            temp_path = Path(temp_dir)

            # Step 1: Run analysis (subclass implements this)
            output_parquet, metadata = self.process(params, temp_path)
            logger.info(
                f"Analysis complete: {metadata.feature_count or 0} features "
                f"at {output_parquet}"
            )

            # Compute style properties from parquet (works for both temp and permanent)
            custom_properties = self.get_layer_properties(
                params, metadata, parquet_path=output_parquet
            )

            # Branch: temp_mode vs permanent mode
            if temp_mode:
                # Temp mode: write to /data/temporary/, no DB records
                result = self._write_temp_result(
                    params=params,
                    output_parquet=output_parquet,
                    output_name=output_name,
                    output_layer_id=output_layer_id,
                    properties=custom_properties,
                )

                # Close the database pool
                loop.run_until_complete(self._close_db_service())

                return result

            # Permanent mode: full DuckLake + PostgreSQL flow
            # Step 2: Ingest to DuckLake
            table_info = self._ingest_to_ducklake(
                user_id=params.user_id,
                layer_id=output_layer_id,
                parquet_path=output_parquet,
            )
            logger.info(f"DuckLake table created: {table_info['table_name']}")

            # Step 2b: Generate PMTiles for spatial layers (non-blocking optimization)
            if table_info.get("geometry_type"):
                pmtiles_path = self._generate_pmtiles(
                    user_id=params.user_id,
                    layer_id=output_layer_id,
                    table_name=table_info["table_name"],
                    geometry_column=table_info.get("geometry_column", "geometry"),
                )
                if pmtiles_path:
                    table_info["pmtiles_path"] = str(pmtiles_path)

            # Refresh database pool - connections may have gone stale during long analysis
            loop.run_until_complete(self._close_db_service())

            # Step 3 & 4: Create layer + optional project link
            result_info = loop.run_until_complete(
                self._create_db_records(
                    output_layer_id=output_layer_id,
                    params=params,
                    output_name=output_name,
                    metadata=metadata,
                    table_info=table_info,
                    custom_properties=custom_properties,
                )
            )

        # Close the database pool
        loop.run_until_complete(self._close_db_service())

        # Step 5: Build and return output
        # Note: folder_id is resolved inside _create_db_records if not provided
        # Detect geometry type from the actual parquet/DuckLake table
        detected_geom_type = table_info.get("geometry_type")
        is_feature = bool(detected_geom_type)

        # Build wm_labels for Windmill job tracking
        # Include email if provided (injected by GeoAPI from auth token)
        wm_labels: list[str] = []
        triggered_by_email = getattr(params, "triggered_by_email", None)
        if triggered_by_email:
            wm_labels.append(triggered_by_email)

        output = ToolOutputBase(
            layer_id=output_layer_id,
            name=output_name,
            folder_id=result_info["folder_id"],
            user_id=params.user_id,
            project_id=params.project_id,
            layer_project_id=result_info.get("layer_project_id"),
            type="feature" if is_feature else "table",
            feature_layer_type=self.get_feature_layer_type(params)
            if is_feature
            else None,
            geometry_type=detected_geom_type,
            feature_count=table_info.get("feature_count", 0),
            extent=table_info.get("extent"),
            table_name=table_info["table_name"],
            wm_labels=wm_labels,
        )

        logger.info(f"Tool completed: {output_layer_id} ({output_name})")
        return output.model_dump()

    def _write_temp_result(
        self: Self,
        params: TParams,
        output_parquet: Path,
        output_name: str,
        output_layer_id: str,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Write result to temporary storage for workflow preview.

        This writes the parquet to /data/temporary/ and generates PMTiles,
        but does NOT create any database records. The result can be served
        via GeoAPI using query params: ?temp=true&workflow_id=xxx&node_id=yyy

        Args:
            params: Tool parameters (must have workflow_id and node_id)
            output_parquet: Path to the output parquet file
            output_name: Display name for the layer
            output_layer_id: UUID for the layer (for identification)
            properties: Optional layer style properties from the tool

        Returns:
            Dict with temp layer info (TempToolOutput format)
        """
        from goatlib.tools.temp_writer import TempLayerWriter

        workflow_id = getattr(params, "workflow_id", None)
        node_id = getattr(params, "node_id", None)

        if not workflow_id or not node_id:
            raise ValueError("workflow_id and node_id are required for temp_mode")

        # Create temp layer writer
        writer = TempLayerWriter(
            user_id=params.user_id,
            workflow_id=workflow_id,
            node_id=node_id,
            pmtiles_enabled=self.settings.pmtiles_enabled if self.settings else True,
            pmtiles_max_zoom=self.settings.pmtiles_max_zoom if self.settings else 14,
        )

        # Write to temp storage
        result = writer.write_from_parquet(
            source_parquet=output_parquet,
            layer_name=output_name,
            process_id=self.get_tool_type(),
            duckdb_con=self.duckdb_con,
            properties=properties,
        )

        logger.info(
            f"Temp layer written: {result.parquet_path} "
            f"(workflow={workflow_id}, node={node_id})"
        )

        # Extract the temp file UUID from the parquet path (t_{uuid}.parquet)
        temp_file_name = result.parquet_path.stem  # "t_{uuid}"
        temp_file_uuid = (
            temp_file_name[2:] if temp_file_name.startswith("t_") else temp_file_name
        )

        # Build wm_labels for Windmill job tracking
        wm_labels: list[str] = []
        triggered_by_email = getattr(params, "triggered_by_email", None)
        if triggered_by_email:
            wm_labels.append(triggered_by_email)

        # Return temp-specific output format
        # temp_layer_id format is "workflow_id:node_id:layer_uuid" for frontend to fetch temp data
        temp_layer_id = f"{workflow_id}:{node_id}:{temp_file_uuid}"
        return {
            "status": "success",
            "temp_mode": True,
            "layer_id": temp_file_uuid,  # Use the temp file UUID as layer_id
            "temp_layer_id": temp_layer_id,
            "name": output_name,
            "user_id": params.user_id,
            "workflow_id": workflow_id,
            "node_id": node_id,
            "type": "feature" if result.metadata.geometry_type else "table",
            "geometry_type": result.metadata.geometry_type,
            "feature_count": result.metadata.feature_count,
            "extent": result.metadata.bbox,
            "parquet_path": str(result.parquet_path),
            "pmtiles_path": str(result.pmtiles_path) if result.pmtiles_path else None,
            "wm_labels": wm_labels,
            "properties": properties,
        }

    def _ingest_to_ducklake(
        self: Self,
        user_id: str,
        layer_id: str,
        parquet_path: Path,
    ) -> dict[str, Any]:
        """Ingest parquet file into DuckLake.

        Creates a new table in DuckLake from a GeoParquet file.
        The table is stored at lake.user_{user_id}.t_{layer_id}.

        Args:
            user_id: User UUID string
            layer_id: Layer UUID string
            parquet_path: Path to the parquet file

        Returns:
            Table info dict with table_name, feature_count, extent, geometry_type, columns, size
        """
        table_name = self.get_layer_table_path(layer_id)
        schema = layer_schema_name()

        # Get file size before ingestion
        file_size = parquet_path.stat().st_size if parquet_path.exists() else 0

        # Retry logic for connection issues with DuckLake
        max_retries = 2
        for attempt in range(max_retries + 1):
            try:
                con = self.duckdb_con

                # Ensure user schema exists
                con.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema}")

                # Detect geometry column for Hilbert ordering
                cols = con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
                ).fetchall()
                geom_col = None
                for col_name, col_type, *_ in cols:
                    if "GEOMETRY" in col_type.upper():
                        geom_col = col_name
                        break

                # Create table from parquet with Hilbert ordering for spatial locality
                # This ensures spatially-close rows are stored together in row groups,
                # enabling efficient bbox-based row group pruning during queries
                if geom_col:
                    con.execute(f"""
                        CREATE TABLE {table_name} AS
                        SELECT * FROM read_parquet('{parquet_path}')
                        ORDER BY ST_Hilbert({geom_col})
                    """)
                    logger.info(
                        "Created DuckLake table: %s from %s (Hilbert-sorted by %s)",
                        table_name,
                        parquet_path,
                        geom_col,
                    )
                else:
                    con.execute(f"""
                        CREATE TABLE {table_name} AS
                        SELECT * FROM read_parquet('{parquet_path}')
                    """)
                    logger.info(
                        "Created DuckLake table: %s from %s", table_name, parquet_path
                    )

                # Get table info
                table_info = self._get_table_info(con, table_name)
                table_info["table_name"] = table_name
                table_info["size"] = file_size

                return table_info

            except Exception as e:
                if self._is_retriable_ducklake_error(e) and attempt < max_retries:
                    logger.warning(
                        "DuckLake ingest error (attempt %d/%d), reconnecting: %s",
                        attempt + 1,
                        max_retries + 1,
                        e,
                    )
                    # Force reconnection by clearing the cached connection
                    if self._duckdb_con:
                        try:
                            self._duckdb_con.close()
                        except Exception:
                            pass
                    self._duckdb_con = None
                    # Small delay before retry to let connection issues settle
                    import time

                    time.sleep(0.5)
                    continue
                raise

    def _get_table_info(
        self: Self, con: duckdb.DuckDBPyConnection, table_name: str
    ) -> dict[str, Any]:
        """Get metadata about a DuckLake table.

        Args:
            con: DuckDB connection
            table_name: Full table path (lake.schema.table)

        Returns:
            Dict with columns, feature_count, extent, geometry_type, extent_wkt
        """
        # Get column names and types
        cols = con.execute(f"DESCRIBE {table_name}").fetchall()
        columns = {row[0]: row[1] for row in cols}

        # Get row count
        count_result = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        feature_count = count_result[0] if count_result else 0

        # Detect geometry column
        geom_col = None
        for col_name, col_type in columns.items():
            if "GEOMETRY" in col_type.upper():
                geom_col = col_name
                break

        geometry_type = None
        extent = None
        extent_wkt = None

        if geom_col:
            # Get geometry type
            type_result = con.execute(f"""
                SELECT DISTINCT ST_GeometryType({geom_col})
                FROM {table_name}
                WHERE {geom_col} IS NOT NULL
                LIMIT 1
            """).fetchone()
            if type_result:
                geometry_type = type_result[0]

            # Get extent using ST_Extent_Agg (the correct aggregate function in DuckDB spatial)
            extent_result = con.execute(f"""
                SELECT
                    ST_XMin(ST_Extent_Agg({geom_col})),
                    ST_YMin(ST_Extent_Agg({geom_col})),
                    ST_XMax(ST_Extent_Agg({geom_col})),
                    ST_YMax(ST_Extent_Agg({geom_col}))
                FROM {table_name}
            """).fetchone()
            if extent_result and all(v is not None for v in extent_result):
                extent = list(extent_result)
                extent_wkt = (
                    f"POLYGON(({extent[0]} {extent[1]}, {extent[2]} {extent[1]}, "
                    f"{extent[2]} {extent[3]}, {extent[0]} {extent[3]}, "
                    f"{extent[0]} {extent[1]}))"
                )

        return {
            "columns": columns,
            "feature_count": feature_count,
            "geometry_type": geometry_type,
            "geometry_column": geom_col,
            "extent": extent,
            "extent_wkt": extent_wkt,
        }

    def _get_ducklake_snapshot_id(
        self: Self,
        schema_name: str,
        table_name: str,
    ) -> int | None:
        """Get the DuckLake snapshot_id for a table.

        Queries the DuckLake internal metadata catalog to get the
        begin_snapshot for a table. This snapshot_id is used to track
        whether PMTiles files are in sync with the source data.

        Args:
            schema_name: DuckLake schema name (e.g., "user_xxx")
            table_name: Table name without schema (e.g., "t_yyy")

        Returns:
            Snapshot ID if found, None otherwise
        """
        try:
            result = self.duckdb_con.execute(f"""
                SELECT t.begin_snapshot
                FROM __ducklake_metadata_lake.ducklake.ducklake_table t
                JOIN __ducklake_metadata_lake.ducklake.ducklake_schema s
                    ON t.schema_id = s.schema_id
                WHERE s.schema_name = '{schema_name}'
                AND t.table_name = '{table_name}'
                AND t.end_snapshot IS NULL
            """).fetchone()

            if result:
                return result[0]
        except Exception as e:
            logger.debug(
                f"Could not get snapshot_id for {schema_name}.{table_name}: {e}"
            )

        return None

    def _generate_pmtiles(
        self: Self,
        user_id: str,
        layer_id: str,
        table_name: str,
        geometry_column: str = "geometry",
    ) -> Path | None:
        """Generate PMTiles for a layer after DuckLake ingestion.

        Creates a static PMTiles file for efficient tile serving without
        dynamic generation overhead. The PMTiles file is stored alongside
        the source GeoParquet data in the user's tiles directory.

        The DuckLake snapshot_id is embedded in the PMTiles metadata to
        track whether the tiles are in sync with the source data.

        Args:
            user_id: User UUID string
            layer_id: Layer UUID string
            table_name: Full DuckLake table path (e.g., "lake.user_xxx.t_yyy")
            geometry_column: Name of the geometry column (default: "geometry")

        Returns:
            Path to generated PMTiles file, or None if generation was skipped/failed
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        # Skip if PMTiles generation is disabled
        if not self.settings.pmtiles_enabled:
            logger.debug("PMTiles generation is disabled")
            return None

        try:
            # Lazy import to avoid requiring pmtiles in all environments
            from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

            # Create PMTiles config from settings
            config = PMTilesConfig(
                enabled=True,
                min_zoom=self.settings.pmtiles_min_zoom,
                max_zoom=self.settings.pmtiles_max_zoom,
            )

            generator = PMTilesGenerator(
                tiles_data_dir=self.settings.tiles_data_dir,
                config=config,
            )

            # Get snapshot_id for sync tracking
            # table_name is like "lake.user_xxx.t_yyy"
            parts = table_name.split(".")
            if len(parts) >= 3:
                schema_name = parts[1]  # user_xxx
                tbl_name = parts[2]  # t_yyy
                snapshot_id = self._get_ducklake_snapshot_id(schema_name, tbl_name)
            else:
                snapshot_id = None

            pmtiles_path = generator.generate_from_table(
                duckdb_con=self.duckdb_con,
                table_name=table_name,
                layer_id=layer_id,
                geometry_column=geometry_column,
                snapshot_id=snapshot_id,
            )

            if pmtiles_path:
                logger.info(
                    f"PMTiles generated: {pmtiles_path} "
                    f"({pmtiles_path.stat().st_size / 1024 / 1024:.1f} MB)"
                    + (f" [snapshot={snapshot_id}]" if snapshot_id else "")
                )

            return pmtiles_path

            return pmtiles_path

        except Exception as e:
            # Log error but don't fail the tool - PMTiles are optional optimization
            logger.warning(f"PMTiles generation failed (non-fatal): {e}")
            return None

    async def _init_db_service(self: Self) -> None:
        """Initialize database service and connection pool.

        This is called early in run() so db_service is available for
        resolve_layer_paths() during process().
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized. Call init_from_env() first.")

        if self.db_service is not None:
            return  # Already initialized

        self._db_pool = await asyncpg.create_pool(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
            min_size=1,
            max_size=5,
        )

        self.db_service = ToolDatabaseService(
            self._db_pool, schema=self.settings.customer_schema
        )

    async def _close_db_service(self: Self) -> None:
        """Close database connection pool."""
        if hasattr(self, "_db_pool") and self._db_pool is not None:
            await self._db_pool.close()
            self._db_pool = None
            self.db_service = None

    async def _create_db_records(
        self: Self,
        output_layer_id: str,
        params: TParams,
        output_name: str,
        metadata: DatasetMetadata,
        table_info: dict[str, Any],
        custom_properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create layer record and optionally link to project.

        Args:
            output_layer_id: UUID for the new layer
            params: Tool parameters
            output_name: Layer display name
            metadata: Dataset metadata from analysis
            table_info: DuckLake table info
            custom_properties: Optional custom layer properties (style).
                               If None, get_layer_properties() is called.

        Returns:
            Dict with folder_id and layer_project_id (if added to project)
        """
        if self.db_service is None:
            await self._init_db_service()

        # Resolve folder_id: use provided value, or derive from project_id
        folder_id = params.folder_id
        if not folder_id and params.project_id:
            folder_id = await self.db_service.get_project_folder_id(params.project_id)
            if not folder_id:
                raise ValueError(
                    f"Could not find folder for project {params.project_id}"
                )
            logger.info(
                f"Derived folder_id={folder_id} from project_id={params.project_id}"
            )

        if not folder_id:
            raise ValueError(
                "folder_id is required, or project_id must be provided to derive it"
            )

        # Determine layer type from actual geometry in the data
        detected_geom_type = table_info.get("geometry_type")
        is_feature = bool(detected_geom_type)
        layer_type = "feature" if is_feature else "table"
        feature_layer_type = self.get_feature_layer_type(params) if is_feature else None

        # Get custom layer properties (style) from parameter or subclass
        if custom_properties is None:
            custom_properties = self.get_layer_properties(params, metadata, table_info)

        # Create layer metadata (returns generated properties)
        layer_properties = await self.db_service.create_layer(
            layer_id=output_layer_id,
            user_id=params.user_id,
            folder_id=folder_id,
            name=output_name,
            layer_type=layer_type,
            feature_layer_type=feature_layer_type,
            geometry_type=detected_geom_type,
            extent_wkt=table_info.get("extent_wkt"),
            feature_count=table_info.get("feature_count", 0),
            size=table_info.get("size", 0),
            properties=custom_properties,
            tool_type=self.get_tool_type(),
            job_id=self.get_job_id(),
        )

        # Add to project if requested
        layer_project_id = None
        if params.project_id:
            layer_project_id = await self.db_service.add_to_project(
                layer_id=output_layer_id,
                project_id=params.project_id,
                name=output_name,
                properties=layer_properties,
            )

        return {"folder_id": folder_id, "layer_project_id": layer_project_id}
