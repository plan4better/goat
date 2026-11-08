"""PMTiles synchronization task for Windmill.

This task synchronizes PMTiles files with DuckLake geometry layers and with
promoted catalog layers. It can be run as a scheduled Windmill job or
triggered manually.

A layer's tiles are in sync when manby built them with the current recipe
(MANBY_MARKER) from the current data: the layer's DuckLake snapshot, or for a
catalog layer its local GeoParquet copy, when that is no newer than the tiles.
Tiles from before manby or from an older recipe are stale like tiles of old
data, so a plain run after a deploy that brings a new recipe rebuilds them,
without `force` (which rebuilds the layers already done too). A run stopped on
the way goes on with the layers still stale when it is started again.

Architecture:
- All queries via DuckDB with postgres_scanner (no separate psycopg dependency)
- Data queries: DuckLake via BaseDuckLakeManager (proper catalog access)
- Catalog layers: their local GeoParquet copy, read through the catalog layer
  view on the same connection; never downloaded from the catalog bucket and
  never changed

Usage as Windmill script:
    # Called by Windmill with PMTilesSyncParams

Usage as library:
    from goatlib.tasks import PMTilesSyncTask

    task = PMTilesSyncTask()
    task.init_from_env()
    results = task.run(PMTilesSyncParams(limit=100, dry_run=True))
"""

import logging
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Self

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    import duckdb

from goatlib.config.postgres import TASKS_APPLICATION_NAME
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator
from goatlib.storage import BaseDuckLakeManager
from goatlib.storage.ducklake import catalog_libpq
from goatlib.tools.base import ToolSettings
from goatlib.tools.catalog_materialize import (
    generate_catalog_pmtiles,
    parquet_geometry_column,
)
from goatlib.utils.container_memory import JOB_DUCKLAKE_MEMORY_SHARE, set_memory_share
from goatlib.utils.credentials import postgres_attach_target
from goatlib.utils.layer import (
    catalog_layers_dir,
    catalog_tiles_dir,
    layer_id_to_table_name,
)

logger = logging.getLogger(__name__)


class PMTilesSyncParams(BaseModel):
    """Parameters for PMTiles sync task."""

    user_id: str | None = Field(
        default=None,
        description="Process only layers for this user (UUID with dashes)",
    )
    limit: int | None = Field(
        default=None,
        description="Maximum number of layers to process (DuckLake and catalog layers each)",
    )
    force: bool = Field(
        default=False,
        description="Regenerate even if PMTiles exist and are in sync",
    )
    missing_only: bool = Field(
        default=False,
        description="Only generate missing PMTiles, skip stale ones",
    )
    dry_run: bool = Field(
        default=False,
        description="Show what would be done without making changes",
    )
    small_first: bool = Field(
        default=True,
        description="Process smaller layers first (default: True)",
    )
    geometry_type_filter: str | None = Field(
        default=None,
        description="Only process layers matching this geometry type (e.g. 'polygon', 'point', 'line')",
    )
    anchor_only: bool = Field(
        default=False,
        description="Only generate anchor PMTiles for polygon layers (skip main tile regeneration)",
    )
    layers: Literal["all", "ducklake", "catalog"] = Field(
        default="all",
        description=(
            "Which layers to sync: all, DuckLake layers only, or promoted catalog "
            "layers only (tiled from their local GeoParquet copy). user_id, "
            "geometry_type_filter and anchor_only select DuckLake layers: with "
            "one of them set, catalog layers are left out"
        ),
    )


__all__ = ["PMTilesSyncParams", "PMTilesSyncTask", "main"]


@dataclass
class LayerInfo:
    """Information about a DuckLake layer with geometry."""

    schema_name: str
    table_name: str
    user_id: str
    layer_id: str
    geometry_column: str
    snapshot_id: int
    size_bytes: int = 0
    record_count: int = 0

    @property
    def full_table_name(self: Self) -> str:
        """Get the full DuckLake table name (lake.schema.table)."""
        return f"lake.{self.schema_name}.{self.table_name}"


@dataclass
class CatalogLayerInfo:
    """A promoted catalog layer and its local GeoParquet copy."""

    layer_id: str
    parquet_path: Path
    size_bytes: int = 0
    modified_ns: int = 0


@dataclass
class SyncResult:
    """Result of processing a single layer."""

    layer_id: str
    status: str  # "generated", "in_sync", "skipped", "error", "failed"
    message: str = ""


@dataclass
class SyncStats:
    """Statistics from a sync run."""

    total_layers: int = 0
    in_sync: int = 0
    missing: int = 0
    stale: int = 0
    generated: int = 0
    errors: int = 0
    skipped: int = 0
    failed: int = 0

    def to_dict(self: Self) -> dict:
        """Convert to dictionary for Windmill output."""
        return {
            "total_layers": self.total_layers,
            "in_sync": self.in_sync,
            "missing": self.missing,
            "stale": self.stale,
            "generated": self.generated,
            "errors": self.errors,
            "skipped": self.skipped,
            "failed": self.failed,
        }

    def add(self: Self, other: "SyncStats") -> None:
        """Count the layers of another pass in these."""
        for name, value in other.to_dict().items():
            setattr(self, name, getattr(self, name) + value)


class PMTilesSyncTask:
    """Synchronize PMTiles for all DuckLake geometry layers and catalog layers.

    This task ensures all geometry layers in DuckLake, and the promoted
    catalog layers, have corresponding PMTiles files for efficient tile
    serving. It tracks DuckLake snapshots (for a catalog layer, its file) and
    the recipe, to only regenerate tiles when source data or recipe changes.

    Example (Windmill):
        def main(params: PMTilesSyncParams) -> dict:
            task = PMTilesSyncTask()
            task.init_from_env()
            return task.run(params)

    Example (Library):
        task = PMTilesSyncTask()
        task.init_from_env()
        stats = task.run(PMTilesSyncParams(dry_run=True))
        print(f"Would process {stats.missing + stats.stale} layers")
    """

    def __init__(self: Self) -> None:
        """Initialize the PMTiles sync task."""
        self.settings: ToolSettings | None = None
        self._manager: BaseDuckLakeManager | None = None
        self._generator: PMTilesGenerator | None = None
        self._catalog_generator: PMTilesGenerator | None = None
        self._spill_dir: tempfile.TemporaryDirectory | None = None

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
        """Initialize settings from environment variables and Windmill secrets."""
        self._configure_logging_for_windmill()
        self.settings = ToolSettings.from_env()

    def _get_manager(self: Self) -> BaseDuckLakeManager:
        """Get or create DuckLake manager."""
        if self._manager is None:
            if not self.settings:
                raise RuntimeError("Call init_from_env() before running task")
            self._manager = BaseDuckLakeManager(
                read_only=True, application_name=TASKS_APPLICATION_NAME
            )
            # Registered before the first connection exists, so every one the
            # manager builds is bounded, a replacement for a stale one too.
            self._manager.add_connection_hook(self._bound_connection)
            self._manager.init_from_params(
                postgres_uri=self.settings.ducklake_postgres_uri,
                storage_path=self.settings.ducklake_data_dir,
                catalog_schema=self.settings.ducklake_catalog_schema,
            )
        return self._manager

    def _bound_connection(self: Self, con: "duckdb.DuckDBPyConnection") -> None:
        """Cap the connection that feeds the tile builder, as a tool run does.

        The builder sorts the whole layer on this connection before it hands
        the file to manby, and DuckDB spills a sort only when it reaches its
        own memory_limit, which by default is 80% of the container. The share
        is the one a tool run gives its DuckLake connection: this connection
        is one too, it stays open (and holds whatever it cached) while manby
        runs on its own half of the container, and the rest is left for Python
        and the worker. DuckDB spills into a directory made here: its default,
        `.tmp` in the working directory, need not be writable.
        """
        set_memory_share(con, JOB_DUCKLAKE_MEMORY_SHARE)
        if self._spill_dir is None:
            self._spill_dir = tempfile.TemporaryDirectory(prefix="duckdb_spill_")
        spill_dir = self._spill_dir.name.replace("'", "''")
        con.execute(f"SET temp_directory='{spill_dir}'")

    def _get_generator(self: Self) -> PMTilesGenerator:
        """Get or create PMTiles generator."""
        if self._generator is None:
            if not self.settings:
                raise RuntimeError("Call init_from_env() before running task")
            config = PMTilesConfig(enabled=True)
            self._generator = PMTilesGenerator(self.settings.tiles_data_dir, config)
        return self._generator

    def _catalog_config(self: Self) -> PMTilesConfig:
        """The config catalog_materialize builds a catalog layer's tiles with."""
        if not self.settings:
            raise RuntimeError("Call init_from_env() before running task")
        return PMTilesConfig(
            min_zoom=self.settings.pmtiles_min_zoom,
            max_zoom=self.settings.pmtiles_max_zoom,
        )

    def _get_catalog_generator(self: Self) -> PMTilesGenerator:
        """Get or create the PMTiles generator of the catalog tiles directory."""
        if self._catalog_generator is None:
            self._catalog_generator = PMTilesGenerator(
                str(catalog_tiles_dir()), self._catalog_config()
            )
        return self._catalog_generator

    def close(self: Self) -> None:
        """Close connections and cleanup resources."""
        if self._manager is not None:
            self._manager.close()
            self._manager = None
        if self._spill_dir is not None:
            self._spill_dir.cleanup()
            self._spill_dir = None

    def _attach_postgres(self: Self, con: "duckdb.DuckDBPyConnection") -> None:
        """Attach PostgreSQL as 'pg' for querying catalog tables."""
        if not self.settings:
            raise RuntimeError("Call init_from_env() before running task")

        # Build libpq connection string from URI
        from urllib.parse import unquote, urlparse

        parsed = urlparse(self.settings.ducklake_postgres_uri)
        host = parsed.hostname or "localhost"
        port = parsed.port or 5432
        user = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        dbname = parsed.path.lstrip("/") if parsed.path else ""

        libpq_str = catalog_libpq(
            {
                "host": host,
                "port": str(port),
                "dbname": dbname,
                "user": user,
                "password": password,
            },
            TASKS_APPLICATION_NAME,
        )
        target = postgres_attach_target(con, libpq_str)
        # Both listings attach it, on the manager's one connection
        con.execute(f"ATTACH IF NOT EXISTS '{target}' AS pg (TYPE postgres, READ_ONLY)")

    def get_geometry_layers(
        self: Self,
        user_id: str | None = None,
        limit: int | None = None,
        order_by_size: bool = False,
    ) -> list[LayerInfo]:
        """Get all DuckLake tables with geometry columns.

        Queries PostgreSQL metadata tables directly for efficiency when listing
        thousands of tables.

        Args:
            user_id: Filter to specific user (UUID format with dashes)
            limit: Maximum number of layers to return
            order_by_size: If True, order by size ascending (smallest first)

        Returns:
            List of LayerInfo for each geometry layer
        """
        user_filter = ""
        if user_id:
            user_filter = f"AND l.user_id = '{user_id}'"

        limit_clause = f"LIMIT {limit}" if limit else ""
        order_clause = (
            "ORDER BY COALESCE(stats.total_size, 0) ASC"
            if order_by_size
            else "ORDER BY data_snapshot DESC"
        )

        if not self.settings:
            raise RuntimeError("Call init_from_env() before running task")

        catalog = self.settings.ducklake_catalog_schema
        customer_schema = self.settings.customer_schema

        # Query PostgreSQL catalog tables via DuckDB's postgres_query()
        # These are DuckLake metadata tables stored in PostgreSQL
        #
        # Key insight: We track per-table data modification by looking at
        # MAX(begin_snapshot) from ducklake_data_file for each table.
        # This tells us when the table's data was last modified, not when
        # the global catalog was last changed.
        query = f"""
            WITH current_snapshot AS (
                SELECT MAX(snapshot_id) as snapshot_id
                FROM postgres_query('pg', 'SELECT snapshot_id FROM {catalog}.ducklake_snapshot')
            ),
            ducklake_table AS (
                SELECT * FROM postgres_query('pg',
                    'SELECT table_id, schema_id, table_name, begin_snapshot, end_snapshot
                     FROM {catalog}.ducklake_table')
            ),
            ducklake_schema AS (
                SELECT * FROM postgres_query('pg',
                    'SELECT schema_id, schema_name FROM {catalog}.ducklake_schema')
            ),
            ducklake_column AS (
                SELECT * FROM postgres_query('pg',
                    'SELECT table_id, column_name, column_type, begin_snapshot, end_snapshot
                     FROM {catalog}.ducklake_column')
            ),
            ducklake_data_file AS (
                SELECT * FROM postgres_query('pg',
                    'SELECT table_id, file_size_bytes, record_count,
                            begin_snapshot, end_snapshot
                     FROM {catalog}.ducklake_data_file')
            ),
            layer_owner AS (
                -- Ownership comes from the layer record, never from the
                -- schema name: the schema is where the data happens to sit,
                -- which is not a fact about who owns it.
                SELECT * FROM postgres_query('pg',
                    'SELECT id::text AS layer_id, user_id::text AS user_id
                     FROM {customer_schema}.layer')
            ),
            table_stats AS (
                -- Get both size and latest data modification snapshot per table
                SELECT
                    df.table_id,
                    SUM(df.file_size_bytes) as total_size,
                    SUM(df.record_count) as total_records,
                    MAX(df.begin_snapshot) as last_data_snapshot
                FROM ducklake_data_file df, current_snapshot cs
                WHERE df.end_snapshot IS NULL
                AND cs.snapshot_id >= df.begin_snapshot
                GROUP BY df.table_id
            )
            SELECT
                s.schema_name,
                t.table_name,
                l.layer_id,
                l.user_id,
                c.column_name AS geometry_column,
                COALESCE(stats.last_data_snapshot, t.begin_snapshot) as data_snapshot,
                COALESCE(stats.total_size, 0) as total_size,
                COALESCE(stats.total_records, 0) as total_records
            FROM ducklake_table t
            JOIN ducklake_schema s ON t.schema_id = s.schema_id
            JOIN ducklake_column c ON t.table_id = c.table_id
            JOIN layer_owner l ON t.table_name = 't_' || REPLACE(l.layer_id, '-', '')
            LEFT JOIN table_stats stats ON t.table_id = stats.table_id
            CROSS JOIN current_snapshot cs
            WHERE c.column_type ILIKE 'geometry'
            AND t.end_snapshot IS NULL
            AND c.end_snapshot IS NULL
            AND cs.snapshot_id >= t.begin_snapshot
            AND cs.snapshot_id >= c.begin_snapshot
            {user_filter}
            {order_clause}
            {limit_clause}
        """

        # Use DuckDB with postgres_query to query catalog tables
        manager = self._get_manager()
        with manager.connection() as con:
            # Attach PostgreSQL for catalog queries
            self._attach_postgres(con)
            rows = con.execute(query).fetchall()

        if not rows:
            logger.info("No geometry layers found")
            return []

        layers = []
        for (
            schema_name,
            table_name,
            layer_id_uuid,
            user_id_uuid,
            geometry_column,
            data_snapshot,
            total_size,
            total_records,
        ) in rows:
            layers.append(
                LayerInfo(
                    schema_name=schema_name,
                    table_name=table_name,
                    user_id=user_id_uuid,
                    layer_id=layer_id_uuid,
                    geometry_column=geometry_column,
                    snapshot_id=data_snapshot,  # Per-table data modification snapshot
                    size_bytes=total_size,
                    record_count=total_records,
                )
            )

        return layers

    def _promoted_layer_ids(self: Self) -> list[str]:
        """Ids of the promoted catalog layers whose tiles the sync keeps.

        Only layers a project uses: an unused one is what catalog_gc deletes,
        with its tiles. Only feature layers, as a table has no geometry. None
        whose materialize job is queued or running: the job writes the copy
        and builds its tiles itself.
        """
        if not self.settings:
            raise RuntimeError("Call init_from_env() before running task")

        customer_schema = self.settings.customer_schema
        query = f"""
            SELECT layer_id FROM postgres_query('pg',
                'SELECT l.id::text AS layer_id
                 FROM {customer_schema}.layer l
                 WHERE l.catalog_external_uid IS NOT NULL
                 AND l.type = ''feature''
                 AND COALESCE(
                     l.other_properties->''catalog_materialize''->>''status'', ''''
                 ) NOT IN (''pending'', ''running'')
                 AND EXISTS (
                     SELECT 1 FROM {customer_schema}.layer_project lp
                     WHERE lp.layer_id = l.id
                 )')
        """
        manager = self._get_manager()
        with manager.connection() as con:
            self._attach_postgres(con)
            rows = con.execute(query).fetchall()
        return [layer_id for (layer_id,) in rows]

    def get_catalog_layers(
        self: Self,
        limit: int | None = None,
        order_by_size: bool = False,
    ) -> list[CatalogLayerInfo]:
        """Get the promoted catalog layers to sync, with their local copy.

        Taken from the layer rows, never by listing the directory: a parquet
        without a row is no layer anyone uses (catalog_gc deletes the row
        before the files). A layer without its copy is skipped; core's heal
        materializes it again when it is added.

        Args:
            limit: Maximum number of layers to return
            order_by_size: If True, smallest copy first, else the newest

        Returns:
            List of CatalogLayerInfo for each layer with a copy
        """
        layers = []
        without_copy = 0
        for layer_id in self._promoted_layer_ids():
            path = catalog_layers_dir() / f"{layer_id_to_table_name(layer_id)}.parquet"
            try:
                stat = path.stat()
            except FileNotFoundError:
                without_copy += 1
                continue
            layers.append(
                CatalogLayerInfo(
                    layer_id=layer_id,
                    parquet_path=path,
                    size_bytes=stat.st_size,
                    modified_ns=stat.st_mtime_ns,
                )
            )
        if without_copy:
            logger.info(f"Skipping {without_copy} catalog layers without a local copy")

        if order_by_size:
            layers.sort(key=lambda layer: layer.size_bytes)
        else:
            layers.sort(key=lambda layer: layer.modified_ns, reverse=True)
        return layers[:limit] if limit else layers

    def _detect_geometry_type(
        self: Self,
        layer: LayerInfo,
    ) -> str:
        """Detect actual geometry type by sampling layer data.

        Args:
            layer: Layer info with table name and geometry column

        Returns:
            Geometry type string: "polygon", "line", "point", or "unknown"
        """
        manager = self._get_manager()
        try:
            with manager.connection() as con:
                result = con.execute(f"""
                    SELECT DISTINCT ST_GeometryType({layer.geometry_column})
                    FROM {layer.full_table_name}
                    LIMIT 10
                """).fetchall()
                types = {row[0].upper() for row in result if row[0]}
                if any("POLYGON" in t for t in types):
                    return "polygon"
                elif any("LINE" in t for t in types):
                    return "line"
                elif any("POINT" in t for t in types):
                    return "point"
        except Exception as e:
            logger.warning(
                f"Could not detect geometry type for {layer.full_table_name}: {e}"
            )
        return "unknown"

    @staticmethod
    def _stale_reason(
        generator: PMTilesGenerator,
        layer_id: str,
        snapshot_id: int | None,
        source_modified_ns: int | None = None,
    ) -> str | None:
        """Why a layer's existing tiles need a rebuild, None when they are in sync.

        Each file of the layer must be in sync (PMTilesGenerator.stale_reason):
        the main file and, when there is one, its label anchor file. A main
        file in sync without an anchor file is complete: generate_from_table
        publishes a polygon layer's anchors first.

        Args:
            generator: Generator of the tiles directory the files are in
            layer_id: Layer UUID
            snapshot_id: The layer's DuckLake snapshot, None for a catalog layer
            source_modified_ns: For a catalog layer, the mtime of its parquet:
                tiles older than the file are of the data it replaced

        Returns:
            The reason, or None
        """
        main_path = generator.get_pmtiles_path(layer_id)
        anchor_path = generator.get_anchor_pmtiles_path(layer_id)
        for path, prefix in ((main_path, ""), (anchor_path, "label anchors: ")):
            if path == anchor_path and not path.exists():
                continue
            reason = generator.stale_reason(path, snapshot_id)
            if (
                reason is None
                and source_modified_ns is not None
                and path.stat().st_mtime_ns < source_modified_ns
            ):
                reason = "parquet newer than the tiles"
            if reason is not None:
                return prefix + reason
        return None

    def _process_layer(
        self: Self,
        layer: LayerInfo,
        force: bool = False,
        dry_run: bool = False,
        anchor_only: bool = False,
    ) -> SyncResult:
        """Process a single layer - generate PMTiles if needed."""
        generator = self._get_generator()

        try:
            # A layer with no rows is a normal state — the Create flow makes
            # empty layers to draw into, and a filter or join can match
            # nothing. manby rejects the empty input that would produce ("Did
            # not read any valid geometries"), which reads as a failure when
            # nothing is wrong.
            # The count comes from the catalog, so this costs no table access.
            if layer.record_count == 0:
                return SyncResult(
                    layer_id=layer.layer_id,
                    status="skipped",
                    message="Layer has no features",
                )

            pmtiles_path = generator.get_pmtiles_path(layer.layer_id)

            # Anchor-only mode: generate only anchor PMTiles for polygon layers
            if anchor_only:
                if not pmtiles_path.exists():
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="No main PMTiles file, skipping anchor generation",
                    )
                anchor_path = generator.get_anchor_pmtiles_path(layer.layer_id)
                if anchor_path.exists() and generator.is_pmtiles_in_sync(
                    anchor_path, layer.snapshot_id
                ):
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="Anchor layer in sync",
                    )
                if dry_run:
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="would_create",
                        message="Would generate anchor PMTiles",
                    )
                manager = self._get_manager()
                with manager.connection() as con:
                    output = generator.generate_anchor_from_table(
                        duckdb_con=con,
                        table_name=layer.full_table_name,
                        layer_id=layer.layer_id,
                        geometry_column=layer.geometry_column,
                        snapshot_id=layer.snapshot_id,
                    )
                if output:
                    size_mb = output.stat().st_size / 1024 / 1024
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="generated",
                        message=f"Generated anchor {size_mb:.1f} MB",
                    )
                else:
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="Not a polygon layer",
                    )

            # Check if regeneration is needed
            stale_msg = ""
            if pmtiles_path.exists() and not force:
                reason = self._stale_reason(
                    generator, layer.layer_id, layer.snapshot_id
                )
                if reason is None:
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="in_sync",
                        message=f"In sync (snapshot={layer.snapshot_id})",
                    )
                stale_msg = f"Stale: {reason}"

            if dry_run:
                status = "would_regenerate" if pmtiles_path.exists() else "would_create"
                return SyncResult(
                    layer_id=layer.layer_id,
                    status=status,
                    message=stale_msg or "Would create new PMTiles",
                )

            # Generate PMTiles from DuckLake table
            manager = self._get_manager()
            with manager.connection() as con:
                output = generator.generate_from_table(
                    duckdb_con=con,
                    table_name=layer.full_table_name,
                    layer_id=layer.layer_id,
                    geometry_column=layer.geometry_column,
                    snapshot_id=layer.snapshot_id,
                )

            return self._generated(layer.layer_id, output, stale_msg)

        except Exception as e:
            return SyncResult(
                layer_id=layer.layer_id,
                status="error",
                message=str(e),
            )

    def _process_catalog_layer(
        self: Self,
        layer: CatalogLayerInfo,
        force: bool = False,
        dry_run: bool = False,
    ) -> SyncResult:
        """Process a single catalog layer - build its tiles from its copy if needed."""
        generator = self._get_catalog_generator()

        try:
            pmtiles_path = generator.get_pmtiles_path(layer.layer_id)

            stale_msg = ""
            if pmtiles_path.exists() and not force:
                reason = self._stale_reason(
                    generator, layer.layer_id, None, layer.modified_ns
                )
                if reason is None:
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="in_sync",
                        message="In sync",
                    )
                stale_msg = f"Stale: {reason}"

            # On the manager's connection, bounded and spilling as for a
            # DuckLake layer. The copy is read where it is, never changed.
            manager = self._get_manager()
            with manager.connection() as con:
                geometry_column = parquet_geometry_column(con, layer.parquet_path)
                if geometry_column is None:
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="No geometry column",
                    )
                if dry_run:
                    status = (
                        "would_regenerate" if pmtiles_path.exists() else "would_create"
                    )
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status=status,
                        message=stale_msg or "Would create new PMTiles",
                    )
                output = generate_catalog_pmtiles(
                    con,
                    layer.layer_id,
                    layer.parquet_path,
                    geometry_column,
                    self._catalog_config(),
                )

            return self._generated(layer.layer_id, output, stale_msg)

        except Exception as e:
            return SyncResult(
                layer_id=layer.layer_id,
                status="error",
                message=str(e),
            )

    @staticmethod
    def _generated(layer_id: str, output: Path | None, stale_msg: str) -> SyncResult:
        """The result of a build, with why the old tiles were stale."""
        if output:
            size_mb = output.stat().st_size / 1024 / 1024
            message = f"Generated {size_mb:.1f} MB"
            if stale_msg:
                message += f" ({stale_msg})"
            return SyncResult(layer_id=layer_id, status="generated", message=message)
        return SyncResult(
            layer_id=layer_id,
            status="failed",
            message="Generation returned None",
        )

    def run(
        self: Self,
        params: PMTilesSyncParams,
    ) -> dict:
        """Run the PMTiles synchronization task.

        Args:
            params: Task parameters

        Returns:
            Dict with sync statistics for Windmill output, both passes counted
        """
        stats = SyncStats()

        try:
            if params.layers != "catalog":
                stats.add(self._sync_ducklake_layers(params))
            if params.layers != "ducklake":
                stats.add(self._sync_catalog_layers(params))
            return stats.to_dict()

        finally:
            self.close()

    def _sync_ducklake_layers(self: Self, params: PMTilesSyncParams) -> SyncStats:
        """Sync the PMTiles of the DuckLake geometry layers."""
        stats = SyncStats()

        # Query metadata from PostgreSQL
        logger.info("Querying geometry layers from PostgreSQL...")
        layers = self.get_geometry_layers(
            user_id=params.user_id,
            limit=params.limit,
            order_by_size=params.small_first,
        )

        stats.total_layers = len(layers)
        logger.info(f"Found {len(layers)} geometry layers")

        if not layers:
            logger.info("No layers to process")
            return stats

        # Filter by geometry type if requested (anchor_only implies polygon)
        geom_filter = params.geometry_type_filter
        if params.anchor_only and not geom_filter:
            geom_filter = "polygon"

        if geom_filter:
            filter_type = geom_filter.lower()
            filtered = []
            for layer in layers:
                geom_type = self._detect_geometry_type(layer)
                if geom_type == filter_type:
                    filtered.append(layer)
                else:
                    logger.info(
                        f"  Skipping {layer.full_table_name} "
                        f"(geometry={geom_type}, filter={filter_type})"
                    )
            logger.info(
                f"Filtered to {len(filtered)}/{len(layers)} {filter_type} layers"
            )
            layers = filtered

        # Anchor-only mode: process all polygon layers, skip categorization
        if params.anchor_only:
            to_process = layers
            logger.info(
                f"Anchor-only mode: processing {len(to_process)} polygon layers..."
            )
            for i, layer in enumerate(to_process, 1):
                logger.info(f"Processing {i}/{len(to_process)}: {layer.layer_id}")
                result = self._process_layer(
                    layer,
                    dry_run=params.dry_run,
                    anchor_only=True,
                )
                if result.status == "generated":
                    stats.generated += 1
                elif result.status == "error":
                    stats.errors += 1
                elif result.status in ("skipped", "would_create"):
                    stats.skipped += 1
                logger.info(f"  [{result.status}] {result.message}")

            logger.info("\n--- Summary ---")
            logger.info(f"  Total polygon layers: {len(to_process)}")
            if stats.generated > 0:
                logger.info(f"  Generated anchors: {stats.generated}")
            if stats.skipped > 0:
                logger.info(f"  Skipped: {stats.skipped}")
            if stats.errors > 0:
                logger.info(f"  Errors: {stats.errors}")
            return stats

        generator = self._get_generator()
        self._sync_layers(
            "DuckLake",
            layers,
            generator,
            lambda layer: self._stale_reason(
                generator, layer.layer_id, layer.snapshot_id
            ),
            lambda layer: self._process_layer(
                layer, force=params.force, dry_run=params.dry_run
            ),
            params,
            stats,
        )
        return stats

    def _sync_catalog_layers(self: Self, params: PMTilesSyncParams) -> SyncStats:
        """Sync the PMTiles of the promoted catalog layers.

        A catalog layer has no DuckLake snapshot. Its tiles are in sync when
        built with the current recipe and no older than its copy, which the
        materialize job writes before it builds the tiles: a copy written
        again (a new version of the dataset) makes the old tiles stale.
        """
        stats = SyncStats()

        narrowed = [
            name
            for name in ("user_id", "geometry_type_filter", "anchor_only")
            if getattr(params, name)
        ]
        if narrowed:
            logger.info(
                f"Catalog layers left out: {', '.join(narrowed)} select DuckLake layers"
            )
            return stats

        logger.info("Querying catalog layers from PostgreSQL...")
        layers = self.get_catalog_layers(
            limit=params.limit,
            order_by_size=params.small_first,
        )

        stats.total_layers = len(layers)
        logger.info(f"Found {len(layers)} catalog layers")

        if not layers:
            logger.info("No catalog layers to process")
            return stats

        generator = self._get_catalog_generator()
        self._sync_layers(
            "Catalog",
            layers,
            generator,
            lambda layer: self._stale_reason(
                generator, layer.layer_id, None, layer.modified_ns
            ),
            lambda layer: self._process_catalog_layer(
                layer, force=params.force, dry_run=params.dry_run
            ),
            params,
            stats,
        )
        return stats

    def _sync_layers(
        self: Self,
        kind: str,
        layers: list[Any],
        generator: PMTilesGenerator,
        stale_reason: Callable[[Any], str | None],
        process: Callable[[Any], SyncResult],
        params: PMTilesSyncParams,
        stats: SyncStats,
    ) -> None:
        """Categorize layers by their tiles and process those that need it.

        Args:
            kind: The layers' kind, for the log
            layers: LayerInfo or CatalogLayerInfo
            generator: Generator of the tiles directory the layers' tiles are in
            stale_reason: Why a layer's existing tiles are stale, None if not
            process: Builds a layer's tiles, see _process_layer
            params: Task parameters
            stats: Filled in with the layers' counts
        """
        # Categorize layers
        missing = []
        stale = []
        in_sync = []
        corrupted = []

        for layer in layers:
            pmtiles_path = generator.get_pmtiles_path(layer.layer_id)

            # Clean up any leftover temp files from interrupted generations
            # These patterns are from previous implementations:
            # - .tmp_filename.pmtiles (old prefix pattern)
            # - filename.pmtiles.tmp (old suffix pattern, and the tiler's
            #   own temp file from when it built in the tiles directory)
            temp_patterns = [
                pmtiles_path.parent / f".tmp_{pmtiles_path.name}",
                pmtiles_path.with_suffix(".pmtiles.tmp"),
                pmtiles_path.parent / f"{pmtiles_path.name}.tmp",
            ]
            for temp_path in temp_patterns:
                if temp_path.exists():
                    logger.debug(f"Cleaning up interrupted generation: {temp_path}")
                    try:
                        temp_path.unlink()
                    except OSError:
                        pass

            if not pmtiles_path.exists():
                missing.append(layer)
            elif not generator.is_pmtiles_valid(pmtiles_path):
                # Corrupted file - delete it and treat as missing
                logger.warning(f"Corrupted PMTiles file, deleting: {pmtiles_path}")
                try:
                    pmtiles_path.unlink()
                except OSError as e:
                    logger.error(f"Failed to delete corrupted file: {e}")
                corrupted.append(layer)
                missing.append(layer)
            elif stale_reason(layer) is not None:
                # Old data, or built before manby or with an older recipe
                stale.append(layer)
            else:
                in_sync.append(layer)

        stats.in_sync = len(in_sync)
        stats.missing = len(missing)
        stats.stale = len(stale)

        status_msg = (
            f"{kind} layers: {stats.in_sync} in sync, {stats.missing} missing, "
            f"{stats.stale} stale"
        )
        if corrupted:
            status_msg += f" ({len(corrupted)} corrupted files deleted)"
        logger.info(status_msg)

        # Determine what to process
        if params.force:
            to_process = layers
        elif params.missing_only:
            to_process = missing
            if stale:
                logger.info(f"Skipping {len(stale)} stale layers (--missing-only)")
        else:
            to_process = missing + stale

        if not to_process:
            logger.info(f"All PMTiles of {kind} layers are up to date!")
            return

        logger.info(f"Processing {len(to_process)} {kind} layers...")

        # Process layers
        for i, layer in enumerate(to_process, 1):
            size_str = (
                f"{layer.size_bytes / 1024 / 1024:.1f}MB"
                if layer.size_bytes >= 1024 * 1024
                else f"{layer.size_bytes / 1024:.1f}KB"
                if layer.size_bytes > 0
                else "?"
            )
            logger.info(
                f"Processing {i}/{len(to_process)}: {layer.layer_id} ({size_str})"
            )

            result = process(layer)

            if result.status == "generated":
                stats.generated += 1
            elif result.status == "error":
                stats.errors += 1
            elif result.status == "failed":
                stats.failed += 1
            elif result.status in ("skipped", "would_create", "would_regenerate"):
                stats.skipped += 1

            logger.info(f"  [{result.status}] {result.message}")

        # Summary
        logger.info(f"\n--- Summary ({kind} layers) ---")
        logger.info(f"  Total layers: {stats.total_layers}")
        logger.info(f"  In sync: {stats.in_sync}")
        if stats.generated > 0:
            logger.info(f"  Generated: {stats.generated}")
        if stats.errors > 0:
            logger.info(f"  Errors: {stats.errors}")
        if stats.failed > 0:
            logger.info(f"  Failed: {stats.failed}")
        if stats.skipped > 0:
            logger.info(f"  Skipped: {stats.skipped}")


def main(params: PMTilesSyncParams) -> dict:
    """Windmill entry point for PMTiles sync task.

    This function is called by Windmill with parameters from the job.
    Environment variables and Windmill secrets provide connection settings.

    Args:
        params: Parameters matching PMTilesSyncParams schema

    Returns:
        Dict with sync statistics
    """
    task = PMTilesSyncTask()
    task.init_from_env()

    try:
        return task.run(params)
    finally:
        task.close()


# CLI entry point for local testing
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Sync PMTiles for DuckLake geometry layers and catalog layers"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would be done"
    )
    parser.add_argument("--limit", type=int, help="Process at most N tables")
    parser.add_argument(
        "--user-id", type=str, help="Process only tables for a specific user"
    )
    parser.add_argument(
        "--force", action="store_true", help="Regenerate even if in sync"
    )
    parser.add_argument(
        "--missing-only", action="store_true", help="Only generate missing, skip stale"
    )
    parser.add_argument(
        "--small-first", action="store_true", help="Process smaller layers first"
    )
    parser.add_argument(
        "--anchor-only",
        action="store_true",
        help="Only generate anchor PMTiles for polygon layers (skip main tiles)",
    )
    parser.add_argument(
        "--layers",
        choices=["all", "ducklake", "catalog"],
        default="all",
        help="Sync all layers, DuckLake layers only or catalog layers only",
    )

    args = parser.parse_args()

    params = PMTilesSyncParams(
        user_id=args.user_id,
        limit=args.limit,
        force=args.force,
        missing_only=args.missing_only,
        dry_run=args.dry_run,
        small_first=args.small_first,
        anchor_only=args.anchor_only,
        layers=args.layers,
    )

    result = main(params)
    print(f"\nResult: {result}")
