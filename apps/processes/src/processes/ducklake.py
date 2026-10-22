"""DuckLake manager instance for Processes API.

Creates a read-only singleton instance of BaseDuckLakeManager from goatlib.
Processes API only reads data for sync analytics - all writes happen through the core app.
"""

import tempfile
import threading

import duckdb
from goatlib.storage import BaseDuckLakeManager, load_extensions

from processes.config import settings

# Singleton instance for analytics queries (histogram, aggregation-stats, etc.)
# This allows processes and core to run concurrently without lock conflicts
ducklake_manager = BaseDuckLakeManager(
    read_only=True,
    pin_snapshot=settings.DUCKLAKE_PIN_SNAPSHOT,
    refresh_interval=settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS,
    application_name="goat-processes-ducklake",
)

# Separate singleton for preview-sql queries.
# preview_sql runs arbitrary user SQL of unknown duration, so it must not share
# the analytics lock — a slow or complex query would block all other analytics.
preview_ducklake_manager = BaseDuckLakeManager(
    read_only=True,
    pin_snapshot=settings.DUCKLAKE_PIN_SNAPSHOT,
    refresh_interval=settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS,
    application_name="goat-processes-ducklake",
)

# Separate singleton for layer-search.
# layer-search fans out unauthenticated ILIKE scans across many layers, so it
# must not share the analytics lock with authenticated analytics queries — nor
# the preview lock, since arbitrary preview-sql queries must not block search.
search_ducklake_manager = BaseDuckLakeManager(
    read_only=True,
    pin_snapshot=settings.DUCKLAKE_PIN_SNAPSHOT,
    refresh_interval=settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS,
    application_name="goat-processes-ducklake",
)

# mirror-values reads only S3, so it gets its own database, off the analytics lock.
_mirror_db: duckdb.DuckDBPyConnection | None = None
_mirror_db_lock = threading.Lock()


def mirror_cursor() -> duckdb.DuckDBPyConnection:
    """A cursor on the mirror database, made on first use."""
    global _mirror_db
    with _mirror_db_lock:
        if _mirror_db is None:
            from goatlib.tools.data_integration import ensure_s3

            db = duckdb.connect()
            db.execute("SET memory_limit = '256MB'")
            db.execute(f"SET threads = {int(settings.DUCKDB_THREADS)}")
            db.execute(
                f"SET temp_directory = '{tempfile.gettempdir()}/goat_mirror_duckdb'"
            )
            # The image's baked extensions: images must not download them.
            load_extensions(db, "httpfs", "spatial")
            # Once here: cursors creating the secret together conflict.
            ensure_s3(db)
            _mirror_db = db
        return _mirror_db.cursor()


def close_mirror_db() -> None:
    global _mirror_db
    with _mirror_db_lock:
        if _mirror_db is not None:
            _mirror_db.close()
            _mirror_db = None
