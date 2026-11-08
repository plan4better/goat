"""PMTiles synchronization task for Windmill.

This task synchronizes PMTiles files with DuckLake geometry layers.
It can be run as a scheduled Windmill job or triggered manually.

Architecture:
- All queries via DuckDB with postgres_scanner (no separate psycopg dependency)
- Data queries: DuckLake via BaseDuckLakeManager (proper catalog access)

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
from dataclasses import dataclass
from typing import TYPE_CHECKING, Self

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from pathlib import Path

    import duckdb

from goatlib.config.postgres import TASKS_APPLICATION_NAME
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator
from goatlib.storage import BaseDuckLakeManager
from goatlib.storage.ducklake import catalog_libpq
from goatlib.tools.base import ToolSettings
from goatlib.utils.container_memory import JOB_DUCKLAKE_MEMORY_SHARE, set_memory_share
from goatlib.utils.credentials import postgres_attach_target

logger = logging.getLogger(__name__)


class PMTilesSyncParams(BaseModel):
    """Parameters for PMTiles sync task."""

    user_id: str | None = Field(
        default=None,
        description="Process only layers for this user (UUID with dashes)",
    )
    limit: int | None = Field(
        default=None,
        description="Maximum number of layers to process",
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
    show_progress: bool = Field(
        default=True,
        description="Show tippecanoe progress (only when tippecanoe builds the tiles, as the fallback when manby fails)",
    )
    geometry_type_filter: str | None = Field(
        default=None,
        description="Only process layers matching this geometry type (e.g. 'polygon', 'point', 'line')",
    )
    anchor_only: bool = Field(
        default=False,
        description="Only generate anchor PMTiles for polygon layers (skip main tile regeneration)",
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


class PMTilesSyncTask:
    """Synchronize PMTiles for all DuckLake geometry layers.

    This task ensures all geometry layers in DuckLake have corresponding
    PMTiles files for efficient tile serving. It tracks DuckLake snapshots
    to only regenerate tiles when source data changes.

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
        return self._generator

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
        con.execute(f"ATTACH '{target}' AS pg (TYPE postgres, READ_ONLY)")

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
    def _has_anchor_layer(pmtiles_path: "Path") -> bool:
        """Check if a layer already has a separate anchor PMTiles file."""
        anchor_path = pmtiles_path.with_name(pmtiles_path.stem + "_anchor.pmtiles")
        return anchor_path.exists()

    def _process_layer(
        self: Self,
        layer: LayerInfo,
        force: bool = False,
        dry_run: bool = False,
        show_progress: bool = True,
        skip_existing_anchors: bool = False,
        anchor_only: bool = False,
    ) -> SyncResult:
        """Process a single layer - generate PMTiles if needed."""
        generator = self._get_generator()

        try:
            # A layer with no rows is a normal state — the Create flow makes
            # empty layers to draw into, and a filter or join can match
            # nothing. Both tilers (manby and the tippecanoe fallback) reject
            # the empty input that would produce ("Did not read any valid
            # geometries"), which reads as a failure when nothing is wrong.
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
                if self._has_anchor_layer(pmtiles_path):
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="Already has anchor layer",
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
                        show_progress=show_progress,
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

            # Skip if already has anchor layer (for resumable polygon migration)
            if skip_existing_anchors and pmtiles_path.exists():
                if self._has_anchor_layer(pmtiles_path):
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="skipped",
                        message="Already has anchor layer",
                    )

            # Check if regeneration is needed
            if pmtiles_path.exists() and not force:
                if generator.is_pmtiles_in_sync(pmtiles_path, layer.snapshot_id):
                    return SyncResult(
                        layer_id=layer.layer_id,
                        status="in_sync",
                        message=f"In sync (snapshot={layer.snapshot_id})",
                    )
                else:
                    stored = generator.get_pmtiles_snapshot_id(pmtiles_path)
                    stale_msg = f"Stale: stored={stored}, current={layer.snapshot_id}"
            else:
                stale_msg = ""

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
                    show_progress=show_progress,
                )

            if output:
                size_mb = output.stat().st_size / 1024 / 1024
                return SyncResult(
                    layer_id=layer.layer_id,
                    status="generated",
                    message=f"Generated {size_mb:.1f} MB",
                )
            else:
                return SyncResult(
                    layer_id=layer.layer_id,
                    status="failed",
                    message="Generation returned None",
                )

        except Exception as e:
            return SyncResult(
                layer_id=layer.layer_id,
                status="error",
                message=str(e),
            )

    def run(
        self: Self,
        params: PMTilesSyncParams,
    ) -> dict:
        """Run the PMTiles synchronization task.

        Args:
            params: Task parameters

        Returns:
            Dict with sync statistics for Windmill output
        """
        stats = SyncStats()

        try:
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
                return stats.to_dict()

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
                    f"Filtered to {len(filtered)}/{len(layers)} "
                    f"{filter_type} layers"
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
                        show_progress=params.show_progress,
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
                return stats.to_dict()

            # Categorize layers
            generator = self._get_generator()
            missing = []
            stale = []
            in_sync = []
            corrupted = []

            for layer in layers:
                pmtiles_path = generator.get_pmtiles_path(layer.layer_id)

                # Clean up any leftover temp files from interrupted generations
                # These patterns are from previous implementations:
                # - .tmp_filename.pmtiles (old prefix pattern)
                # - filename.pmtiles.tmp (old suffix pattern)
                # - filename.pmtiles.tmp (tippecanoe's own temp file, from when
                #   it built in the tiles directory)
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
                elif not generator.is_pmtiles_in_sync(pmtiles_path, layer.snapshot_id):
                    stale.append(layer)
                else:
                    in_sync.append(layer)

            stats.in_sync = len(in_sync)
            stats.missing = len(missing)
            stats.stale = len(stale)

            status_msg = (
                f"Status: {stats.in_sync} in sync, {stats.missing} missing, "
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
                logger.info("All PMTiles are up to date!")
                return stats.to_dict()

            logger.info(f"Processing {len(to_process)} layers...")

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

                result = self._process_layer(
                    layer,
                    force=params.force,
                    dry_run=params.dry_run,
                    show_progress=params.show_progress,
                    skip_existing_anchors=params.geometry_type_filter == "polygon",
                )

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
            logger.info("\n--- Summary ---")
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

            return stats.to_dict()

        finally:
            self.close()


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
        description="Sync PMTiles for DuckLake geometry layers"
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

    args = parser.parse_args()

    params = PMTilesSyncParams(
        user_id=args.user_id,
        limit=args.limit,
        force=args.force,
        missing_only=args.missing_only,
        dry_run=args.dry_run,
        small_first=args.small_first,
        anchor_only=args.anchor_only,
    )

    result = main(params)
    print(f"\nResult: {result}")
