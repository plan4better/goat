"""Base DuckLake connection manager.

Single connection with lock for thread-safety, plus a connection pool variant.
"""

from __future__ import annotations

import logging
import os
import queue
import re
import threading
from contextlib import contextmanager
from typing import Any, Callable, Generator, Protocol
from urllib.parse import unquote, urlparse

import duckdb

from goatlib.storage.pin_errors import is_pin_miss_error
from goatlib.storage.s3_config import apply_duckdb_s3_settings
from goatlib.storage.snapshot_pin import SnapshotPin

logger = logging.getLogger(__name__)

# Single source of truth for the DuckDB extensions the services need. Both
# managers below AND the image bake step (service Dockerfiles import this list)
# derive from it, so adding one here automatically gets it baked into the
# images — there is no second list to keep in sync.
REQUIRED_DUCKDB_EXTENSIONS = ["spatial", "httpfs", "postgres", "ducklake"]
# Community-repository extensions the analysis tools load on their own
# connections (``INSTALL h3 FROM community``). Not loaded by the managers,
# but baked into the images alongside the list above so those INSTALLs
# resolve from disk instead of community-extensions.duckdb.org.
COMMUNITY_DUCKDB_EXTENSIONS = ["h3"]


def _baked_extension_dir() -> str | None:
    """Directory of extensions pre-baked into the image, if configured.

    When ``DUCKDB_EXTENSION_DIRECTORY`` is set (the service images bake the
    REPOSITORY extensions in at build time), DuckDB loads them from local disk
    and must never reach out to extensions.duckdb.org — so callers point DuckDB
    at this directory, disable autoinstall/autoload, and skip INSTALL entirely.
    Unset in local dev, where the normal download-on-INSTALL path is used.
    """
    return os.environ.get("DUCKDB_EXTENSION_DIRECTORY") or None


def configure_baked_extensions(con: "duckdb.DuckDBPyConnection") -> bool:
    """Point a connection at the baked extension dir. Returns True if baked."""
    ext_dir = _baked_extension_dir()
    if not ext_dir:
        return False
    con.execute(f"SET extension_directory='{ext_dir}'")
    con.execute("SET autoinstall_known_extensions=false")
    con.execute("SET autoload_known_extensions=false")
    return True


# Connection error patterns that should trigger a retry/reconnect
CONNECTION_ERROR_PATTERNS = [
    "ssl syscall error",
    "eof detected",
    "connection already closed",
    "connection error",
    "connection reset",
    "broken pipe",
    "failed to get data file list",
]

# TCP keepalive settings to prevent SSL EOF errors on idle PostgreSQL connections
# See: https://www.postgresql.org/docs/current/libpq-connect.html
POSTGRES_KEEPALIVE_PARAMS = {
    "keepalives": "1",
    "keepalives_idle": "30",  # seconds before sending keepalive
    "keepalives_interval": "5",  # seconds between keepalives
    "keepalives_count": "5",  # failed keepalives before disconnect
}


def is_connection_error(error: Exception) -> bool:
    """Check if an error indicates a broken connection that should be retried."""
    error_str = str(error).lower()
    return any(pattern in error_str for pattern in CONNECTION_ERROR_PATTERNS)


def execute_with_retry(
    manager: "BaseDuckLakeManager | DuckLakePool",
    query: str,
    params: list | None = None,
    fetch_all: bool = True,
    max_retries: int = 1,
) -> tuple[Any, Any]:
    """Execute query with retry on connection errors.

    Standalone function that works with any manager/pool having connection() and reconnect().

    Args:
        manager: DuckLake manager/pool instance
        query: SQL query to execute
        params: Optional query parameters
        fetch_all: If True, fetchall(); if False, fetchone()
        max_retries: Number of retry attempts on connection error

    Returns:
        Tuple of (result, description) where result is fetchall()/fetchone()
        and description is cursor.description for column names.
    """
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            with manager.connection() as con:
                if params:
                    cursor = con.execute(query, params)
                else:
                    cursor = con.execute(query)
                if fetch_all:
                    result = cursor.fetchall()
                else:
                    result = cursor.fetchone()
                return result, con.description
        except Exception as e:
            last_error = e
            if (
                is_pin_miss_error(e)
                and attempt < max_retries
                and manager.force_pin_refresh()
            ):
                logger.info("Pin miss, refreshed snapshot and retrying: %s", e)
                continue
            if is_connection_error(e) and attempt < max_retries:
                logger.warning(
                    "Connection error (attempt %d/%d), reconnecting: %s",
                    attempt + 1,
                    max_retries + 1,
                    e,
                )
                manager.reconnect()
                continue
            break
    raise last_error


def execute_query_with_retry(
    manager: "BaseDuckLakeManager | DuckLakePool",
    query: str,
    params: list | None = None,
    fetch_all: bool = True,
    max_retries: int = 1,
) -> Any:
    """Execute query with retry, returning only the result (no description).

    Simpler version for cases where column names aren't needed.

    Args:
        manager: DuckLake manager/pool instance
        query: SQL query to execute
        params: Optional query parameters
        fetch_all: If True, fetchall(); if False, fetchone()
        max_retries: Number of retry attempts on connection error

    Returns:
        Result from fetchall() or fetchone()
    """
    result, _ = execute_with_retry(manager, query, params, fetch_all, max_retries)
    return result


class DuckLakeSettings(Protocol):
    """Protocol for settings objects that configure DuckLake."""

    POSTGRES_DATABASE_URI: str
    DUCKLAKE_CATALOG_SCHEMA: str
    DUCKLAKE_DATA_DIR: str | None
    DUCKLAKE_S3_ENDPOINT: str | None
    DUCKLAKE_S3_BUCKET: str | None
    DUCKLAKE_S3_ACCESS_KEY: str | None
    DUCKLAKE_S3_SECRET_KEY: str | None
    # Optional: DuckDB memory limit (e.g., "3GB", "1.5GB")
    # If not provided, DuckDB uses its default (typically 80% of system RAM)
    # Optional: DuckDB thread limit (e.g., 2, 4)
    # If not provided, DuckDB uses all available threads


class BaseDuckLakeManager:
    """Single DuckDB connection with lock for thread-safety.

    Connections are automatically recycled after MAX_CONNECTION_AGE_SECONDS
    to prevent accumulation of DuckLake metadata cache, libpq buffers,
    and SSL contexts in long-running services.
    """

    REQUIRED_EXTENSIONS = REQUIRED_DUCKDB_EXTENSIONS

    # Max age before connection is recycled. Prevents unbounded growth of
    # DuckLake metadata cache and libpq/SSL state in long-running processes.
    MAX_CONNECTION_AGE_SECONDS = 300  # 5 minutes

    def __init__(
        self: "BaseDuckLakeManager",
        read_only: bool = False,
        pin_snapshot: bool = False,
        refresh_interval: float = 5.0,
    ) -> None:
        self._connection: duckdb.DuckDBPyConnection | None = None
        self._lock = threading.Lock()
        self._created_at: float = 0.0
        self._postgres_uri: str | None = None
        self._storage_path: str | None = None
        self._catalog_schema: str | None = None
        self._s3_endpoint: str | None = None
        self._s3_access_key: str | None = None
        self._s3_secret_key: str | None = None
        self._extensions_installed: bool = False
        self._read_only: bool = read_only
        self._memory_limit: str | None = None
        self._threads: int | None = None
        self._pin_snapshot = pin_snapshot
        self._refresh_interval = refresh_interval
        self._pin: SnapshotPin | None = None
        self._poll_con: duckdb.DuckDBPyConnection | None = None
        self._poll_lock = threading.Lock()
        # Run on every NEW connection this manager builds. The connection is
        # replaced over its lifetime (stale-recycle, snapshot-refresh swap),
        # and anything created in the old instance's in-memory catalog — e.g.
        # the views geoapi reads materialized catalog layers through — dies
        # with it. A hook re-creates such state wherever the connection came
        # from, so callers never see a swap.
        self._connection_hooks: list[Callable[[duckdb.DuckDBPyConnection], None]] = []

    def add_connection_hook(
        self: "BaseDuckLakeManager",
        hook: "Callable[[duckdb.DuckDBPyConnection], None]",
    ) -> None:
        """Register a hook run on every connection this manager builds.

        Also runs immediately against the current connection, so state a late
        registrant needs exists without waiting for the next swap.
        """
        self._connection_hooks.append(hook)
        if self._connection is not None:
            with self._lock:
                hook(self._connection)

    def init(self: "BaseDuckLakeManager", settings: DuckLakeSettings) -> None:
        """Initialize DuckLake connection."""
        # DuckLake attaches are few, permanent, and idle-in-transaction —
        # the worst clients for a transaction pooler (each pins a server
        # slot forever). Deployments can point them directly at PostgreSQL
        # via DUCKLAKE_POSTGRES_DATABASE_URI, keeping the pooler's slots
        # for short-lived app queries. Falls back to the app-wide URI.
        self._postgres_uri = (
            getattr(settings, "DUCKLAKE_POSTGRES_DATABASE_URI", None)
            or settings.POSTGRES_DATABASE_URI
        )
        self._catalog_schema = settings.DUCKLAKE_CATALOG_SCHEMA
        self._s3_endpoint = getattr(settings, "DUCKLAKE_S3_ENDPOINT", None)
        self._s3_access_key = getattr(settings, "DUCKLAKE_S3_ACCESS_KEY", None)
        self._s3_secret_key = getattr(settings, "DUCKLAKE_S3_SECRET_KEY", None)
        self._memory_limit = getattr(settings, "DUCKDB_MEMORY_LIMIT", None)
        self._threads = getattr(settings, "DUCKDB_THREADS", None)

        s3_bucket = getattr(settings, "DUCKLAKE_S3_BUCKET", None)
        if s3_bucket:
            self._storage_path = s3_bucket
        else:
            data_dir = getattr(settings, "DUCKLAKE_DATA_DIR", None)
            if data_dir:
                self._storage_path = data_dir
            else:
                base_dir = getattr(settings, "DATA_DIR", "/tmp")
                self._storage_path = os.path.join(base_dir, "ducklake")

            # Only create directory in write mode - read-only mode should not
            # attempt to create directories (e.g., on read-only file systems)
            if not self._read_only and not os.path.exists(self._storage_path):
                os.makedirs(self._storage_path, exist_ok=True)

        if self._pin_snapshot:
            initial = self._fetch_latest_snapshot_id()
            self._create_connection(snapshot_version=initial)
            assert self._connection is not None
            self._warm_connection(self._connection)
            self._pin = SnapshotPin(
                self._fetch_latest_snapshot_id,
                self._apply_snapshot,
                refresh_interval=self._refresh_interval,
                maintain=self._recycle_aged,
                name="manager",
            )
            self._pin.start(initial)
        else:
            self._create_connection()
        logger.info("DuckLake initialized: catalog=%s", self._catalog_schema)

    def init_from_params(
        self: "BaseDuckLakeManager",
        postgres_uri: str,
        storage_path: str,
        catalog_schema: str = "ducklake",
        s3_endpoint: str | None = None,
        s3_access_key: str | None = None,
        s3_secret_key: str | None = None,
    ) -> None:
        """Initialize DuckLake with explicit parameters."""
        self._postgres_uri = postgres_uri
        self._catalog_schema = catalog_schema
        self._storage_path = storage_path
        self._s3_endpoint = s3_endpoint
        self._s3_access_key = s3_access_key
        self._s3_secret_key = s3_secret_key

        # Only in write mode: a read-only manager has no business creating the
        # lake directory, and doing so races other readers starting at the same
        # time. Mirrors the guard in init_from_env.
        if (
            not self._read_only
            and not storage_path.startswith("s3://")
            and not os.path.exists(storage_path)
        ):
            os.makedirs(storage_path, exist_ok=True)

        self._create_connection()
        logger.info("DuckLake initialized: catalog=%s", self._catalog_schema)

    def _build_connection(
        self: "BaseDuckLakeManager", snapshot_version: int | None = None
    ) -> duckdb.DuckDBPyConnection:
        """Create and configure a DuckDB connection (does not assign it)."""
        con = duckdb.connect()
        if self._memory_limit:
            con.execute(f"SET memory_limit='{self._memory_limit}'")
        if self._threads:
            con.execute(f"SET threads={self._threads}")
        # Configure allocator to release memory back to OS more aggressively
        # Default is ~128MB, lowering it causes more frequent memory releases
        con.execute("SET allocator_flush_threshold='64MB'")
        # Enable background threads for memory cleanup
        con.execute("SET allocator_background_threads=true")
        # Temporal semantics must not depend on the host OS timezone: naive
        # datetime literals in filters and epoch() on TIMESTAMPTZ are resolved
        # against the session tz. GLOBAL so cursors of this instance inherit.
        con.execute("SET GLOBAL TimeZone='UTC'")
        self._install_extensions(con)
        self._load_extensions(con)
        self._setup_s3(con)
        self._attach_ducklake(con, snapshot_version=snapshot_version)
        for hook in list(self._connection_hooks):
            try:
                hook(con)
            except Exception:
                logger.exception("Connection hook failed on a new connection")
        return con

    def _create_connection(
        self: "BaseDuckLakeManager", snapshot_version: int | None = None
    ) -> None:
        """Create and configure the DuckDB connection, assigning it in place."""
        import time

        self._connection = self._build_connection(snapshot_version)
        self._created_at = time.time()

    def close(self: "BaseDuckLakeManager") -> None:
        """Close the connection, explicitly detaching DuckLake first."""
        if self._pin is not None:
            self._pin.stop()
            self._pin = None
        if self._poll_con is not None:
            try:
                self._poll_con.close()
            except Exception:
                pass
            self._poll_con = None
        if self._connection:
            try:
                self._connection.execute("DETACH lake")
            except Exception:
                pass
            self._connection.close()
            self._connection = None
            logger.info("DuckLake connection closed")

    def attach_catalog(
        self: "BaseDuckLakeManager", con: duckdb.DuckDBPyConnection
    ) -> None:
        """Attach DuckLake catalog to an external DuckDB connection.

        Sets up required extensions, S3 config, and attaches the catalog
        so the connection can query DuckLake tables directly without
        copying data into memory.
        """
        con.execute("SET GLOBAL TimeZone='UTC'")
        self._install_extensions(con)
        self._load_extensions(con)
        self._setup_s3(con)
        self._attach_ducklake(con)

    def _recycle_if_stale(self: "BaseDuckLakeManager") -> None:
        """Recreate connection if it has exceeded MAX_CONNECTION_AGE_SECONDS.

        Must be called while holding self._lock.
        Prevents unbounded growth of DuckLake metadata cache, libpq buffers,
        and SSL contexts in long-running services.
        """
        import time

        if not self._connection or not self._created_at:
            return
        age = time.time() - self._created_at

        if self._pin_snapshot:
            # Age recycling for pinned connections is owned by the pin's
            # maintain hook (_recycle_aged), which runs on the poll thread
            # and builds+warms replacements outside self._lock. Never
            # recycle inline on the request path.
            return

        if age > self.MAX_CONNECTION_AGE_SECONDS:
            logger.info(
                "Recycling DuckLake connection (age %.0fs > %ds)",
                age,
                self.MAX_CONNECTION_AGE_SECONDS,
            )
            try:
                self._connection.execute("DETACH lake")
            except Exception:
                pass
            try:
                self._connection.close()
            except Exception:
                pass
            self._create_connection()

    @contextmanager
    def connection(
        self: "BaseDuckLakeManager",
    ) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        """Get DuckDB connection (with lock).

        Automatically recycles the connection if it has exceeded
        MAX_CONNECTION_AGE_SECONDS to prevent memory accumulation.
        """
        if not self._connection:
            raise RuntimeError("DuckLakeManager not initialized")
        with self._lock:
            self._recycle_if_stale()
            yield self._connection

    @contextmanager
    def connection_with_retry(
        self: "BaseDuckLakeManager",
        max_retries: int = 1,
    ) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        """Get DuckDB connection with automatic reconnect on connection errors.

        Args:
            max_retries: Number of reconnect attempts on connection error.
        """
        if not self._connection:
            raise RuntimeError("DuckLakeManager not initialized")

        for attempt in range(max_retries + 1):
            try:
                with self._lock:
                    yield self._connection
                return  # Success, exit
            except Exception as e:
                if is_connection_error(e) and attempt < max_retries:
                    logger.warning(
                        "Connection error (attempt %d/%d), reconnecting: %s",
                        attempt + 1,
                        max_retries + 1,
                        e,
                    )
                    self.reconnect()
                    continue
                raise

    @property
    def postgres_uri(self: "BaseDuckLakeManager") -> str | None:
        """libpq connection string of the catalog Postgres."""
        return self._postgres_uri

    @property
    def catalog_schema(self: "BaseDuckLakeManager") -> str | None:
        """Schema inside the catalog Postgres holding the ducklake_* tables."""
        return self._catalog_schema

    def reconnect(self: "BaseDuckLakeManager") -> None:
        """Reconnect to DuckLake."""
        with self._lock:
            if self._connection:
                try:
                    self._connection.execute("DETACH lake")
                except Exception:
                    pass
                try:
                    self._connection.close()
                except Exception:
                    pass
            snapshot_version = self._pin.current if self._pin else None
            self._create_connection(snapshot_version=snapshot_version)
            logger.info("DuckLake reconnected")

    def execute(
        self: "BaseDuckLakeManager", query: str, params: tuple | list | None = None
    ) -> list[Any]:
        with self.connection() as con:
            if params:
                return con.execute(query, params).fetchall()
            return con.execute(query).fetchall()

    def execute_one(
        self: "BaseDuckLakeManager", query: str, params: tuple | list | None = None
    ) -> Any:
        with self.connection() as con:
            if params:
                return con.execute(query, params).fetchone()
            return con.execute(query).fetchone()

    def execute_df(
        self: "BaseDuckLakeManager", query: str, params: tuple | list | None = None
    ) -> Any:
        with self.connection() as con:
            if params:
                return con.execute(query, params).fetchdf()
            return con.execute(query).fetchdf()

    def execute_with_retry(
        self: "BaseDuckLakeManager",
        query: str,
        params: tuple | list | None = None,
        max_retries: int = 1,
    ) -> Any:
        """Execute with retry on connection failure."""
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                return self.execute(query, params)
            except Exception as e:
                last_error = e
                if (
                    self._pin is not None
                    and is_pin_miss_error(e)
                    and attempt < max_retries
                    and self.force_pin_refresh()
                ):
                    logger.info("Pin miss, refreshed snapshot and retrying: %s", e)
                    continue
                if is_connection_error(e) and attempt < max_retries:
                    logger.warning(
                        "Query failed (attempt %d/%d), reconnecting: %s",
                        attempt + 1,
                        max_retries + 1,
                        e,
                    )
                    self.reconnect()
                    continue
                break
        raise last_error

    def _install_extensions(
        self: "BaseDuckLakeManager", con: duckdb.DuckDBPyConnection
    ) -> None:
        if self._extensions_installed:
            return
        if _baked_extension_dir():
            # Baked into the image: loaded from disk, never downloaded. The
            # per-connection SET happens in _load_extensions.
            self._extensions_installed = True
            return
        for ext in self.REQUIRED_EXTENSIONS:
            try:
                con.execute(f"INSTALL {ext}")
            except duckdb.IOException as e:
                # Extension might already be installed or network unavailable
                # Try to load it - if it's installed, this will work
                logger.warning(
                    "Could not install extension %s (may already be installed): %s",
                    ext,
                    e,
                )
        logger.info("Installed DuckDB extensions: %s", self.REQUIRED_EXTENSIONS)
        self._extensions_installed = True

    def _load_extensions(
        self: "BaseDuckLakeManager", con: duckdb.DuckDBPyConnection
    ) -> None:
        configure_baked_extensions(con)
        for ext in self.REQUIRED_EXTENSIONS:
            con.execute(f"LOAD {ext}")

    def _setup_s3(self: "BaseDuckLakeManager", con: duckdb.DuckDBPyConnection) -> None:
        apply_duckdb_s3_settings(
            con,
            endpoint_url=self._s3_endpoint,
            access_key=self._s3_access_key,
            secret_key=self._s3_secret_key,
        )

    def _parse_postgres_uri(self: "BaseDuckLakeManager") -> dict[str, str]:
        uri = self._postgres_uri
        if uri.startswith("postgresql://"):
            uri = uri.replace("postgresql://", "postgres://", 1)
        parsed = urlparse(uri)
        params = {}
        if parsed.hostname:
            params["host"] = parsed.hostname
        if parsed.port:
            params["port"] = str(parsed.port)
        if parsed.username:
            params["user"] = unquote(parsed.username)
        if parsed.password:
            params["password"] = unquote(parsed.password)
        if parsed.path and parsed.path != "/":
            params["dbname"] = parsed.path.lstrip("/")
        return params

    def _attach_ducklake(
        self: "BaseDuckLakeManager",
        con: duckdb.DuckDBPyConnection,
        snapshot_version: int | None = None,
    ) -> None:
        params = self._parse_postgres_uri()

        # Add TCP keepalive settings to prevent SSL EOF errors on idle connections
        params.update(POSTGRES_KEEPALIVE_PARAMS)

        libpq_str = " ".join(f"{k}={v}" for k, v in params.items())

        options = [
            f"DATA_PATH '{self._storage_path}'",
            f"METADATA_SCHEMA '{self._catalog_schema}'",
        ]
        options.append("OVERRIDE_DATA_PATH")
        if self._read_only:
            options.append("READ_ONLY")
        if snapshot_version is not None:
            options.append(f"SNAPSHOT_VERSION {snapshot_version}")
        options_str = ", ".join(options)

        attach_sql = f"ATTACH 'ducklake:postgres:{libpq_str}' AS lake ({options_str})"
        con.execute(attach_sql)
        mode = "read-only" if self._read_only else "read-write"
        logger.info("DuckLake catalog attached (%s)", mode)

    def _fetch_latest_snapshot_id(self: "BaseDuckLakeManager") -> int:
        """Newest snapshot id, via a plain postgres attach (~2 ms).

        Serialized by _poll_lock: the shared _poll_con is used by both the
        background poll thread and request threads (force_pin_refresh), and
        a DuckDB connection must not be used concurrently.
        """
        query = (
            "SELECT * FROM postgres_query('pincat', "
            f"'SELECT max(snapshot_id) FROM {self._catalog_schema}.ducklake_snapshot')"
        )
        with self._poll_lock:
            for attempt in range(2):
                try:
                    if self._poll_con is None:
                        con = duckdb.connect()
                        try:
                            con.execute("INSTALL postgres")
                        except duckdb.IOException as install_err:
                            # Extension might already be installed or network
                            # unavailable; LOAD below still works if so.
                            logger.warning(
                                "Could not install postgres extension for poll "
                                "connection (may already be installed): %s",
                                install_err,
                            )
                        con.execute("LOAD postgres")
                        params = self._parse_postgres_uri()
                        params.update(POSTGRES_KEEPALIVE_PARAMS)
                        libpq = " ".join(f"{k}={v}" for k, v in params.items())
                        con.execute(
                            f"ATTACH '{libpq}' AS pincat (TYPE postgres, READ_ONLY)"
                        )
                        self._poll_con = con
                    row = self._poll_con.execute(query).fetchone()
                    if row is None or row[0] is None:
                        raise RuntimeError("ducklake_snapshot is empty")
                    return int(row[0])
                except Exception:
                    if self._poll_con is not None:
                        try:
                            self._poll_con.close()
                        except Exception:
                            pass
                        self._poll_con = None
                    if attempt == 1:
                        raise
        raise RuntimeError("unreachable")

    def _warm_connection(
        self: "BaseDuckLakeManager", con: duckdb.DuckDBPyConnection
    ) -> None:
        """Force the schema-level catalog metadata load off the request path.

        Since DuckLake 1.5.x table metadata loads lazily per table (one
        catalog query each), so enumerating tables here (duckdb_tables())
        would issue one query per table — ~45 s on a 12k-table catalog
        (duckdb/ducklake#1269) on every pool build/rebuild. Warming the
        schema list keeps the expensive part of name resolution off the
        request path while individual tables stay lazy (~tens of ms on
        first touch).
        """
        con.execute(
            "SELECT count(*) FROM duckdb_schemas() WHERE database_name = 'lake'"
        ).fetchone()

    def _build_warm_and_swap(
        self: "BaseDuckLakeManager",
        snapshot_version: int | None,
        expected_con: duckdb.DuckDBPyConnection | None = None,
    ) -> None:
        """Build+warm a connection outside the lock, then swap it in.

        On a build/warm failure the fresh connection is closed and the error
        propagates; the current connection keeps serving untouched.

        When expected_con is given, the swap only happens if the current
        connection is still that one; otherwise a rebuild landed mid-build
        (it pinned a newer snapshot) and the late replacement is discarded.
        """
        import time

        started = time.monotonic()
        new_con = self._build_connection(snapshot_version=snapshot_version)
        try:
            self._warm_connection(new_con)
        except Exception:
            try:
                new_con.close()
            except Exception:
                pass
            raise
        old: duckdb.DuckDBPyConnection | None
        with self._lock:
            if expected_con is not None and self._connection is not expected_con:
                old = new_con
            else:
                old = self._connection
                self._connection = new_con
                self._created_at = time.time()
        if old is not None:
            try:
                old.execute("DETACH lake")
            except Exception:
                pass
            try:
                old.close()
            except Exception:
                pass
        if old is new_con:
            logger.info(
                "DuckLake manager: late pinned rebuild discarded "
                "(a newer snapshot is already active)"
            )
        else:
            logger.info(
                "DuckLake manager: pinned connection swapped to snapshot %s "
                "in %.0f ms",
                snapshot_version,
                (time.monotonic() - started) * 1000,
            )

    def _apply_snapshot(self: "BaseDuckLakeManager", snapshot_id: int) -> None:
        """Build a pinned connection at snapshot_id and swap it in."""
        self._build_warm_and_swap(snapshot_id)

    def _recycle_aged(self: "BaseDuckLakeManager") -> None:
        """Rebuild the connection at the current pin once it ages out.

        Runs on the pin's poll thread (maintain hook), keeping age recycling
        off the request path: the replacement is built and warmed outside
        self._lock and only the swap happens under it.
        """
        import time

        con = self._connection
        if not con or not self._created_at:
            return
        age = time.time() - self._created_at
        if age <= self.MAX_CONNECTION_AGE_SECONDS:
            return
        logger.info(
            "DuckLake manager: pinned connection aged out (%.0fs > %ds), "
            "rebuilding at the current pin",
            age,
            self.MAX_CONNECTION_AGE_SECONDS,
        )
        snapshot_version = self._pin.current if self._pin is not None else None
        self._build_warm_and_swap(snapshot_version, expected_con=con)

    def force_pin_refresh(self: "BaseDuckLakeManager") -> bool:
        """Bring the pin to the latest snapshot now. False when unpinned."""
        if self._pin is None:
            return False
        return self._pin.force_refresh()


class DuckLakePool:
    """Pool of read-only DuckDB connections for concurrent queries.

    Each connection in the pool has the DuckLake catalog attached and
    can independently execute queries without blocking other connections.

    This is useful for high-concurrency read scenarios like tile serving,
    where a single-connection-with-lock model would be a bottleneck.

    Connection health is validated before returning from the pool, and
    stale connections are automatically recreated.

    Example:
        pool = DuckLakePool(pool_size=4)
        pool.init(settings)

        with pool.connection() as con:
            result = con.execute("SELECT * FROM lake.schema.table").fetchall()

        pool.close()
    """

    REQUIRED_EXTENSIONS = REQUIRED_DUCKDB_EXTENSIONS

    # Max age for connections in seconds - older connections are recreated
    # This helps prevent stale PostgreSQL connections inside DuckLake
    MAX_CONNECTION_AGE_SECONDS = 300  # 5 minutes

    def __init__(
        self,
        pool_size: int = 2,
        pin_snapshot: bool = False,
        refresh_interval: float = 5.0,
    ) -> None:
        """Initialize connection pool.

        Args:
            pool_size: Number of connections to maintain in the pool.
            pin_snapshot: When True, all pool connections are attached at a
                pinned DuckLake snapshot version that is refreshed off the
                request path by a background poll thread, instead of always
                reading the latest snapshot.
            refresh_interval: Seconds between background snapshot polls.
        """
        self._pool_size = pool_size
        self._pool: queue.Queue[tuple[duckdb.DuckDBPyConnection, float, int]] = (
            queue.Queue()
        )
        self._initialized = False
        self._init_lock = threading.Lock()
        self._postgres_uri: str | None = None
        self._storage_path: str | None = None
        self._catalog_schema: str | None = None
        self._s3_endpoint: str | None = None
        self._s3_access_key: str | None = None
        self._s3_secret_key: str | None = None
        self._extensions_installed: bool = False
        self._memory_limit: str | None = None
        self._threads: int | None = None
        self._pin_snapshot = pin_snapshot
        self._refresh_interval = refresh_interval
        self._pin: SnapshotPin | None = None
        self._generation = 0
        self._poll_con: duckdb.DuckDBPyConnection | None = None
        self._poll_lock = threading.Lock()
        # Serializes slow-path pool mutations (rebuild swaps, aged recycling,
        # return-path close/repool decisions) so generation tags always match
        # the snapshot a connection is actually attached to.
        self._rebuild_lock = threading.Lock()
        # Pinned mode: per-generation shared base connections, keyed by
        # generation -> [base_con, live_cursor_count, created_at]. Pool queue
        # entries are cursors of a base and share its DuckLake catalog cache,
        # so a rebuild costs ONE metadata load per pod. A base closes only
        # when its generation is superseded AND its last cursor is closed
        # (an in-flight query must never lose its base). Guarded by
        # _rebuild_lock.
        self._bases: dict[int, list[Any]] = {}
        # Run on every NEW base connection (each generation's shared
        # instance). Cursors share their base's catalog, so state a hook
        # creates — e.g. the catalog-layer views — is visible to every
        # cursor of that generation, and recreated when generations swap.
        self._connection_hooks: list[Callable[[duckdb.DuckDBPyConnection], None]] = []
        # Serializes whole _apply_snapshot invocations (build included) so
        # racing rebuild triggers (pin refresh, aged recycle, reconnect)
        # cannot interleave and swap the pool BEHIND the pin's snapshot.
        self._apply_lock = threading.Lock()
        # Watermark of the snapshot the pool actually serves, and when it
        # was applied — lets stale rebuild requests and reconnect storms
        # no-op instead of regressing or duplicating work.
        self._applied_snapshot: int | None = None
        self._applied_at = 0.0

    def init(self, settings: DuckLakeSettings) -> None:
        """Initialize the connection pool from settings."""
        with self._init_lock:
            if self._initialized:
                return

                # Prefers DUCKLAKE_POSTGRES_DATABASE_URI (direct PG for the
            # long-lived attaches) — see BaseDuckLakeManager.init.
            self._postgres_uri = (
                getattr(settings, "DUCKLAKE_POSTGRES_DATABASE_URI", None)
                or settings.POSTGRES_DATABASE_URI
            )
            self._catalog_schema = settings.DUCKLAKE_CATALOG_SCHEMA
            self._s3_endpoint = getattr(settings, "DUCKLAKE_S3_ENDPOINT", None)
            self._s3_access_key = getattr(settings, "DUCKLAKE_S3_ACCESS_KEY", None)
            self._s3_secret_key = getattr(settings, "DUCKLAKE_S3_SECRET_KEY", None)
            self._memory_limit = getattr(settings, "DUCKDB_MEMORY_LIMIT", None)
            self._threads = getattr(settings, "DUCKDB_THREADS", None)

            s3_bucket = getattr(settings, "DUCKLAKE_S3_BUCKET", None)
            if s3_bucket:
                self._storage_path = s3_bucket
            else:
                data_dir = getattr(settings, "DUCKLAKE_DATA_DIR", None)
                if data_dir:
                    self._storage_path = data_dir
                else:
                    base_dir = getattr(settings, "DATA_DIR", "/tmp")
                    self._storage_path = os.path.join(base_dir, "ducklake")

            initial: int | None = None
            if self._pin_snapshot:
                initial = self._fetch_latest_snapshot_id()

            # Create pool connections with retry for transient connection errors
            import time

            if self._pin_snapshot:
                # One warmed base per generation; pooled handles are cursors
                # sharing its catalog cache.
                assert initial is not None
                base = self._create_base_with_retry(snapshot_version=initial)
                self._register_base(self._generation, base)
                self._applied_snapshot = initial
                self._applied_at = time.monotonic()
                for _ in range(self._pool_size):
                    self._pool.put((base.cursor(), time.time(), self._generation))
            else:
                for i in range(self._pool_size):
                    con = self._create_connection_with_retry()
                    self._pool.put((con, time.time(), self._generation))
                    logger.debug(
                        "Created pool connection %d/%d", i + 1, self._pool_size
                    )

            self._initialized = True
            logger.info(
                "DuckLake pool initialized: %d connections, catalog=%s",
                self._pool_size,
                self._catalog_schema,
            )

            if self._pin_snapshot:
                assert initial is not None
                self._pin = SnapshotPin(
                    self._fetch_latest_snapshot_id,
                    self._apply_snapshot,
                    refresh_interval=self._refresh_interval,
                    maintain=self._recycle_aged,
                    name="pool",
                )
                self._pin.start(initial)

    def _parse_postgres_uri(self) -> dict[str, str]:
        """Parse PostgreSQL URI into libpq connection parameters."""
        uri = self._postgres_uri
        if uri.startswith("postgresql://"):
            uri = uri.replace("postgresql://", "postgres://", 1)
        parsed = urlparse(uri)
        params = {}
        if parsed.hostname:
            params["host"] = parsed.hostname
        if parsed.port:
            params["port"] = str(parsed.port)
        if parsed.username:
            params["user"] = unquote(parsed.username)
        if parsed.password:
            params["password"] = unquote(parsed.password)
        if parsed.path and parsed.path != "/":
            params["dbname"] = parsed.path.lstrip("/")
        return params

    def _fetch_latest_snapshot_id(self) -> int:
        """Newest snapshot id, via a plain postgres attach (~2 ms).

        Serialized by _poll_lock: the shared _poll_con is used by both the
        background poll thread and request threads (force_pin_refresh), and
        a DuckDB connection must not be used concurrently.
        """
        query = (
            "SELECT * FROM postgres_query('pincat', "
            f"'SELECT max(snapshot_id) FROM {self._catalog_schema}.ducklake_snapshot')"
        )
        with self._poll_lock:
            for attempt in range(2):
                try:
                    if self._poll_con is None:
                        con = duckdb.connect()
                        try:
                            con.execute("INSTALL postgres")
                        except duckdb.IOException as install_err:
                            # Extension might already be installed or network
                            # unavailable; LOAD below still works if so.
                            logger.warning(
                                "Could not install postgres extension for poll "
                                "connection (may already be installed): %s",
                                install_err,
                            )
                        con.execute("LOAD postgres")
                        params = self._parse_postgres_uri()
                        params.update(POSTGRES_KEEPALIVE_PARAMS)
                        libpq = " ".join(f"{k}={v}" for k, v in params.items())
                        con.execute(
                            f"ATTACH '{libpq}' AS pincat (TYPE postgres, READ_ONLY)"
                        )
                        self._poll_con = con
                    row = self._poll_con.execute(query).fetchone()
                    if row is None or row[0] is None:
                        raise RuntimeError("ducklake_snapshot is empty")
                    return int(row[0])
                except Exception:
                    if self._poll_con is not None:
                        try:
                            self._poll_con.close()
                        except Exception:
                            pass
                        self._poll_con = None
                    if attempt == 1:
                        raise
        raise RuntimeError("unreachable")

    def _create_connection_with_retry(
        self,
        max_retries: int = 3,
        retry_delay: float = 1.0,
        snapshot_version: int | None = None,
    ) -> duckdb.DuckDBPyConnection:
        """Create connection with retry on transient errors."""
        import time

        last_error = None
        for attempt in range(max_retries):
            try:
                return self._create_connection(snapshot_version=snapshot_version)
            except Exception as e:
                last_error = e
                if is_connection_error(e) and attempt < max_retries - 1:
                    logger.warning(
                        "Failed to create connection (attempt %d/%d): %s. Retrying...",
                        attempt + 1,
                        max_retries,
                        e,
                    )
                    time.sleep(retry_delay * (attempt + 1))  # Exponential backoff
                    continue
                break
        raise last_error

    def _create_connection(
        self, snapshot_version: int | None = None
    ) -> duckdb.DuckDBPyConnection:
        """Create a new DuckDB connection with DuckLake attached (read-only)."""
        con = duckdb.connect()

        # Apply memory limit if configured
        if self._memory_limit:
            con.execute(f"SET memory_limit='{self._memory_limit}'")

        # Apply thread limit if configured
        if self._threads:
            con.execute(f"SET threads={self._threads}")

        # Configure allocator to release memory back to OS more aggressively
        con.execute("SET allocator_flush_threshold='64MB'")
        con.execute("SET allocator_background_threads=true")

        # Temporal semantics must not depend on the host OS timezone; GLOBAL
        # so cursors drawn from this base inherit it.
        con.execute("SET GLOBAL TimeZone='UTC'")

        # Point at baked extensions (prod images) so nothing is downloaded; in
        # local dev this is a no-op and we fall back to INSTALL. Install ALL
        # before loading ANY: once httpfs is loaded, later INSTALL downloads
        # route through its TLS stack (system CA store) which slim images may
        # lack; installing first keeps downloads on DuckDB's own bundled cert.
        baked = configure_baked_extensions(con)
        if not self._extensions_installed:
            if not baked:
                for ext in self.REQUIRED_EXTENSIONS:
                    try:
                        con.execute(f"INSTALL {ext}")
                    except duckdb.IOException as e:
                        logger.warning(
                            "Could not install extension %s (may already be installed): %s",
                            ext,
                            e,
                        )
            self._extensions_installed = True
        for ext in self.REQUIRED_EXTENSIONS:
            con.execute(f"LOAD {ext}")

        apply_duckdb_s3_settings(
            con,
            endpoint_url=self._s3_endpoint,
            access_key=self._s3_access_key,
            secret_key=self._s3_secret_key,
        )

        # Attach DuckLake catalog in read-only mode
        params = self._parse_postgres_uri()
        params.update(POSTGRES_KEEPALIVE_PARAMS)
        libpq_str = " ".join(f"{k}={v}" for k, v in params.items())

        options = [
            f"DATA_PATH '{self._storage_path}'",
            f"METADATA_SCHEMA '{self._catalog_schema}'",
            "OVERRIDE_DATA_PATH",
            "READ_ONLY",
        ]
        if snapshot_version is not None:
            options.append(f"SNAPSHOT_VERSION {snapshot_version}")
        options_str = ", ".join(options)

        attach_sql = f"ATTACH 'ducklake:postgres:{libpq_str}' AS lake ({options_str})"
        con.execute(attach_sql)

        return con

    def _warm_connection(self, con: duckdb.DuckDBPyConnection) -> None:
        """Force the schema-level catalog metadata load off the request path.

        Since DuckLake 1.5.x table metadata loads lazily per table (one
        catalog query each), so enumerating tables here (duckdb_tables())
        would issue one query per table — ~45 s on a 12k-table catalog
        (duckdb/ducklake#1269) on every pool build/rebuild. Warming the
        schema list keeps the expensive part of name resolution off the
        request path while individual tables stay lazy (~tens of ms on
        first touch).
        """
        con.execute(
            "SELECT count(*) FROM duckdb_schemas() WHERE database_name = 'lake'"
        ).fetchone()

    def _scaled_memory_limit(self) -> str | None:
        """The configured per-connection memory limit scaled to the pool size.

        In pinned mode all cursors execute on ONE DuckDB instance, so the
        base gets the aggregate budget that pool_size independent
        connections would have had. Returns None (leave DuckDB's default)
        when unset or unparseable.
        """
        if not self._memory_limit:
            return None
        m = re.match(r"^\s*([0-9.]+)\s*([A-Za-z]+)\s*$", self._memory_limit)
        if not m:
            logger.warning(
                "Cannot scale DUCKDB_MEMORY_LIMIT %r to the pool; the shared "
                "base keeps the per-connection value (pool total is %dx "
                "lower than with independent connections)",
                self._memory_limit,
                self._pool_size,
            )
            return None
        return f"{float(m.group(1)) * self._pool_size:g}{m.group(2)}"

    def _create_base_with_retry(
        self, snapshot_version: int | None = None
    ) -> duckdb.DuckDBPyConnection:
        """Create and warm the shared base connection for one generation.

        The base carries the DuckLake catalog cache for every cursor drawn
        from it, and receives the pool's aggregate memory/thread budget
        because all cursor queries execute on this single instance. Closed
        and re-raised on any setup/warm failure so a failed build never
        leaks or mutates the pool.
        """
        con = self._create_connection_with_retry(snapshot_version=snapshot_version)
        try:
            scaled = self._scaled_memory_limit()
            if scaled:
                con.execute(f"SET memory_limit='{scaled}'")
            if self._threads:
                con.execute(f"SET threads={self._threads * self._pool_size}")
            self._warm_connection(con)
        except Exception:
            try:
                con.close()
            except Exception:
                pass
            raise
        for hook in list(self._connection_hooks):
            try:
                hook(con)
            except Exception:
                logger.exception("Connection hook failed on a new pool base")
        return con

    def add_connection_hook(
        self, hook: "Callable[[duckdb.DuckDBPyConnection], None]"
    ) -> None:
        """Register a hook run on every base this pool builds — and on the
        bases already live, so late registration needs no swap to take
        effect. Cursors see whatever the hook created on their base."""
        self._connection_hooks.append(hook)
        self.apply_to_bases(hook)

    def apply_to_bases(self, fn: "Callable[[duckdb.DuckDBPyConnection], None]") -> None:
        """Run `fn` against every live base, all generations.

        For state that must exist before the next query — a hook alone only
        reaches bases built after registration, and pool bases are built at
        startup, long before a request registers anything.
        """
        with self._rebuild_lock:
            bases = [entry[0] for entry in self._bases.values()]
        for base in bases:
            try:
                fn(base)
            except Exception:
                logger.exception("Connection hook failed on a live pool base")

    def _register_base(self, gen: int, base: duckdb.DuckDBPyConnection) -> None:
        """Track a generation's base with pool_size live cursors expected.

        Call while holding _rebuild_lock (or before the pool is serving).
        """
        import time

        self._bases[gen] = [base, self._pool_size, time.time()]

    def _decrement_base_locked(self, gen: int) -> duckdb.DuckDBPyConnection | None:
        """Drop one live cursor from a generation; return its base when the
        last cursor of a superseded generation is gone (caller closes it
        OUTSIDE the lock — teardown can take tens of ms).

        Must be called while holding _rebuild_lock.
        """
        entry = self._bases.get(gen)
        if entry is None:
            return None
        entry[1] -= 1
        if entry[1] <= 0 and gen != self._generation:
            del self._bases[gen]
            base: duckdb.DuckDBPyConnection = entry[0]
            return base
        return None

    def _decrement_base(self, gen: int) -> None:
        """Lock-taking wrapper around _decrement_base_locked + base close."""
        with self._rebuild_lock:
            base = self._decrement_base_locked(gen)
        if base is not None:
            self._close_base(base)

    def _close_base(self, base: duckdb.DuckDBPyConnection) -> None:
        try:
            base.execute("DETACH lake")
        except Exception:
            pass
        try:
            base.close()
        except Exception:
            pass

    def _replace_failed_cursor(self, gen: int) -> None:
        """Replace a failed (already closed and decremented) cursor's slot.

        Draws a cheap cursor from the current base and pools it — atomically
        under the rebuild lock, and only when the slot's generation is still
        current: if a rebuild landed since checkout it already put a full
        set of fresh cursors, so adding one would exceed pool_size.
        """
        import time

        with self._rebuild_lock:
            if gen != self._generation:
                return
            entry = self._bases.get(self._generation)
            if entry is None:
                raise RuntimeError("no live base connection")
            cursor = entry[0].cursor()
            entry[1] += 1
            self._pool.put((cursor, time.time(), self._generation))

    # A rebuild completed this recently satisfies an allow_same re-apply
    # request (reconnect storms after a PG blip coalesce onto one rebuild).
    REBUILD_DEDUP_SECONDS = 5.0

    def _apply_snapshot(self, snapshot_id: int, allow_same: bool = False) -> None:
        """Swap the pool to cursors of a fresh base pinned at snapshot_id.

        Whole invocations serialize on _apply_lock and check the applied
        watermark, so racing triggers (pin refresh, aged recycle, reconnect)
        can neither regress the pool behind the pin nor duplicate rebuilds:
        a request older than the watermark no-ops, and an allow_same
        re-apply (recycle/reconnect) no-ops when an equal rebuild just
        completed.

        The single base is built and warmed OUTSIDE the rebuild lock (one
        metadata load per rebuild, shared by all cursors); the swap under
        the lock is O(1) queue operations. On a build failure nothing is
        mutated — the pin keeps serving the previous snapshot and the next
        poll tick retries. Superseded bases stay alive until their last
        checked-out cursor is returned.
        """
        import time

        with self._apply_lock:
            with self._rebuild_lock:
                applied = self._applied_snapshot
                applied_at = self._applied_at
            if applied is not None:
                if applied > snapshot_id:
                    logger.info(
                        "DuckLake pool: skipping stale rebuild to %s "
                        "(already serving %s)",
                        snapshot_id,
                        applied,
                    )
                    return
                if applied == snapshot_id and (
                    not allow_same
                    or time.monotonic() - applied_at < self.REBUILD_DEDUP_SECONDS
                ):
                    return

            started = time.monotonic()
            new_base = self._create_base_with_retry(snapshot_version=snapshot_id)

            closable: list[duckdb.DuckDBPyConnection] = []
            with self._rebuild_lock:
                self._generation += 1
                gen = self._generation
                self._register_base(gen, new_base)
                # Drain queued stale cursors; checked-out ones are released
                # on return. Cursor close is cheap (no DETACH) — base
                # teardown is the expensive part and happens outside the
                # lock.
                while True:
                    try:
                        old_cursor, _, old_gen = self._pool.get_nowait()
                    except queue.Empty:
                        break
                    try:
                        old_cursor.close()
                    except Exception:
                        pass
                    base = self._decrement_base_locked(old_gen)
                    if base is not None:
                        closable.append(base)
                # Sweep superseded bases whose count already hit zero while
                # they were still current (possible when replacement-cursor
                # draws failed): nothing will decrement them again.
                for g in list(self._bases):
                    if g != gen and self._bases[g][1] <= 0:
                        closable.append(self._bases.pop(g)[0])
                for _ in range(self._pool_size):
                    self._pool.put((new_base.cursor(), time.time(), gen))
                self._applied_snapshot = snapshot_id
                self._applied_at = time.monotonic()
            for base in closable:
                self._close_base(base)
            logger.info(
                "DuckLake pool: base + %d cursors rebuilt at snapshot %s in %.0f ms",
                self._pool_size,
                snapshot_id,
                (time.monotonic() - started) * 1000,
            )

    def _recycle_aged(self) -> None:
        """Rebuild the shared base at the current pin once it ages out.

        Runs on the pin's poll thread. A full generation swap reuses
        _apply_snapshot's build-outside-the-lock machinery, so age recycling
        (libpq/SSL hygiene) never touches the request path.
        """
        import time

        with self._rebuild_lock:
            snapshot_id = self._pin.current if self._pin is not None else None
            entry = self._bases.get(self._generation)
        if snapshot_id is None or entry is None:
            return
        if time.time() - entry[2] <= self.MAX_CONNECTION_AGE_SECONDS:
            return
        logger.info(
            "DuckLake pool: base aged out (>%ds), rebuilding at the current pin",
            self.MAX_CONNECTION_AGE_SECONDS,
        )
        self._apply_snapshot(snapshot_id, allow_same=True)

    def force_pin_refresh(self) -> bool:
        """Bring the pin to the latest snapshot now. False when unpinned."""
        if self._pin is None:
            return False
        return self._pin.force_refresh()

    @property
    def pinned_snapshot_id(self) -> int | None:
        """Currently pinned DuckLake snapshot id, or None when unpinned.

        Lets callers (e.g. tile ETags) key a cache on the snapshot actually
        being served rather than on a version bumped synchronously at write
        time, which can otherwise run ahead of the (async, ~1-2s) pin
        refresh and produce an ETag for data the pool isn't serving yet.
        """
        return self._pin.current if self._pin else None

    def _get_healthy_connection(self) -> tuple[duckdb.DuckDBPyConnection, float, int]:
        """Get a connection from the pool, recreating if too old.

        Only checks connection age - actual connection health is validated
        by the retry logic when queries fail. When the pool is pinned, age
        recycling is owned by the pin's maintain hook (`_recycle_aged`), so
        this method skips it entirely.

        Returns a tuple of (connection, creation_time, generation).
        """
        import time

        con, created_at, gen = self._pool.get()  # Blocks until available

        if self._pin is not None:
            return con, created_at, gen

        current_time = time.time()
        connection_age = current_time - created_at

        # Only recreate if connection is too old
        # Don't do active validation - let the query retry handle failures
        if connection_age > self.MAX_CONNECTION_AGE_SECONDS:
            logger.debug(
                "Connection aged out (%.0fs > %ds), recreating",
                connection_age,
                self.MAX_CONNECTION_AGE_SECONDS,
            )
            try:
                con.close()
            except Exception:
                pass
            con = self._create_connection_with_retry(snapshot_version=None)
            created_at = current_time

        return con, created_at, gen

    @contextmanager
    def connection(self) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        """Get a connection from the pool.

        Validates the connection before returning it.
        On connection errors during use, recreates the connection.
        Returns the connection to the pool when done.
        """
        import time

        if not self._initialized:
            raise RuntimeError("DuckLakePool not initialized")

        con, created_at, gen = self._get_healthy_connection()
        connection_failed = False
        try:
            yield con
        except Exception as e:
            # On connection errors, mark for recreation
            if is_connection_error(e):
                logger.warning("Connection error during query, will recreate: %s", e)
                connection_failed = True
                try:
                    con.close()
                except Exception:
                    pass
            raise
        finally:
            # Gate on the configured mode, not the pin object: bases exist
            # for every pinned pool even before/while the pin is (re)built.
            if self._pin_snapshot:
                if connection_failed:
                    # The failed cursor is already closed: settle its base
                    # accounting, then refill its slot with a cheap cursor
                    # from the current base (atomic; skipped when a rebuild
                    # already replaced this slot).
                    self._decrement_base(gen)
                    try:
                        self._replace_failed_cursor(gen)
                    except Exception as draw_err:
                        # Base itself is unhealthy; reconnect/pin rebuild
                        # heals it and its swap restores full pool size.
                        logger.error("Failed to draw replacement cursor: %s", draw_err)
                else:
                    stale = False
                    base: duckdb.DuckDBPyConnection | None = None
                    with self._rebuild_lock:
                        if gen != self._generation:
                            # A rebuild happened while this cursor was
                            # checked out; its slot was already replaced.
                            # Cursor close is cheap — the base (expensive
                            # teardown) closes outside the lock below.
                            try:
                                con.close()
                            except Exception:
                                pass
                            base = self._decrement_base_locked(gen)
                            stale = True
                        else:
                            self._pool.put((con, created_at, gen))
                    if stale and base is not None:
                        self._close_base(base)
            else:
                # Unpinned: original behavior.
                if connection_failed:
                    try:
                        con = self._create_connection_with_retry()
                        created_at = time.time()
                    except Exception as create_err:
                        logger.error("Failed to recreate connection: %s", create_err)
                        # Retry with more attempts
                        con = self._create_connection_with_retry(max_retries=5)
                        created_at = time.time()
                self._pool.put((con, created_at, gen))

    def execute_with_retry(
        self,
        query: str,
        params: list | tuple | None = None,
        max_retries: int = 2,
        fetch_all: bool = True,
        timeout: float | None = None,
    ) -> Any:
        """Execute a query with automatic retry on connection errors.

        This method handles the full retry logic internally, getting fresh
        connections from the pool on each attempt.

        Args:
            query: SQL query to execute
            params: Query parameters
            max_retries: Number of retry attempts
            fetch_all: If True, fetchall(); if False, fetchone()
            timeout: Optional query timeout in seconds. If exceeded, the query
                     is interrupted via conn.interrupt() and TimeoutError is raised.

        Returns:
            Query result (fetchall or fetchone)
        """
        last_error = None
        for attempt in range(max_retries):
            try:
                with self.connection() as con:
                    if timeout is not None:
                        # Execute with timeout using interrupt
                        return self._execute_with_timeout(
                            con, query, params, fetch_all, timeout
                        )
                    else:
                        if params:
                            cursor = con.execute(query, params)
                        else:
                            cursor = con.execute(query)
                        return cursor.fetchall() if fetch_all else cursor.fetchone()
            except TimeoutError:
                # Don't retry on timeout - it's a deliberate cancellation
                raise
            except Exception as e:
                last_error = e
                if (
                    self._pin is not None
                    and is_pin_miss_error(e)
                    and attempt < max_retries - 1
                    and self.force_pin_refresh()
                ):
                    logger.info("Pin miss, refreshed snapshot and retrying: %s", e)
                    continue
                if is_connection_error(e) and attempt < max_retries - 1:
                    transient_data_error = (
                        "failed to get data file list" in str(e).lower()
                    )
                    if self._pin_snapshot and not transient_data_error:
                        # A broken cursor means the shared base's PG link is
                        # dead for ALL cursors; rebuild it now (single-flight
                        # + dedup in _apply_snapshot coalesce concurrent
                        # failures onto one rebuild) instead of redrawing
                        # doomed cursors until the next snapshot advance.
                        # Data-file-list failures are transient object-store
                        # errors, not base death: a plain retry on the same
                        # base is the right response, not a catalog rebuild.
                        try:
                            self.reconnect()
                        except Exception as rec_err:
                            logger.error("Pinned pool reconnect failed: %s", rec_err)
                    logger.warning(
                        "Query failed (attempt %d/%d), will retry: %s",
                        attempt + 1,
                        max_retries,
                        e,
                    )
                    continue
                raise

        # Should not reach here
        if last_error:
            raise last_error

    def _execute_with_timeout(
        self,
        con: duckdb.DuckDBPyConnection,
        query: str,
        params: list | tuple | None,
        fetch_all: bool,
        timeout: float,
    ) -> Any:
        """Execute query with timeout, using conn.interrupt() for cancellation.

        Runs the query in a thread and interrupts it if timeout is exceeded.
        """

        result_container: dict[str, Any] = {}
        error_container: dict[str, Exception] = {}

        def run_query() -> None:
            try:
                if params:
                    cursor = con.execute(query, params)
                else:
                    cursor = con.execute(query)
                result_container["result"] = (
                    cursor.fetchall() if fetch_all else cursor.fetchone()
                )
            except Exception as e:
                error_container["error"] = e

        thread = threading.Thread(target=run_query, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            # Query exceeded timeout - interrupt it
            logger.warning("Query timeout (%.1fs) exceeded, interrupting", timeout)
            con.interrupt()
            thread.join(timeout=1.0)  # Give it a moment to clean up
            raise TimeoutError(f"Query exceeded {timeout}s timeout and was interrupted")

        if "error" in error_container:
            raise error_container["error"]

        return result_container.get("result")

    @property
    def postgres_uri(self) -> str | None:
        """libpq connection string of the catalog Postgres."""
        return self._postgres_uri

    @property
    def catalog_schema(self) -> str | None:
        """Schema inside the catalog Postgres holding the ducklake_* tables."""
        return self._catalog_schema

    def reconnect(self) -> None:
        """Reconnect all connections in the pool.

        Pinned: a full generation swap at the current pin rebuilds the base
        and every cursor. Unpinned: drains and recreates plain connections.
        """
        import time

        if self._pin_snapshot:
            pin = self._pin
            if pin is None or pin.current is None:
                # init() is still bringing the pin up; nothing to heal yet
                # and the unpinned body must never run on a pinned pool.
                logger.warning("Pinned pool reconnect requested before pin is up")
                return
            # allow_same rebuilds the base at the unchanged pin (dead libpq
            # heal); the dedup window coalesces reconnect storms from many
            # concurrently-failing requests onto one rebuild.
            self._apply_snapshot(pin.current, allow_same=True)
            logger.info("DuckLake pool reconnected at pinned snapshot")
            return

        with self._init_lock:
            # Drain and close all connections
            connections = []
            while not self._pool.empty():
                try:
                    item = self._pool.get_nowait()
                    # Handle both old format (just connection) and new format (tuple)
                    if isinstance(item, tuple):
                        con = item[0]
                    else:
                        con = item
                    connections.append(con)
                except queue.Empty:
                    break

            for con in connections:
                try:
                    con.close()
                except Exception:
                    pass

            # Create new connections with timestamps
            current_time = time.time()
            for i in range(self._pool_size):
                con = self._create_connection()
                self._pool.put((con, current_time, self._generation))
                logger.debug("Recreated pool connection %d/%d", i + 1, self._pool_size)

            logger.info("DuckLake pool reconnected: %d connections", self._pool_size)

    def close(self) -> None:
        """Close all connections in the pool."""
        if self._pin is not None:
            self._pin.stop()
            self._pin = None
        if self._poll_con is not None:
            try:
                self._poll_con.close()
            except Exception:
                pass
            self._poll_con = None
        while not self._pool.empty():
            try:
                item = self._pool.get_nowait()
                # Handle both old format (just connection) and new format (tuple)
                if isinstance(item, tuple):
                    con = item[0]
                else:
                    con = item
                con.close()
            except queue.Empty:
                break
        with self._rebuild_lock:
            bases = [entry[0] for entry in self._bases.values()]
            self._bases.clear()
        for base in bases:
            self._close_base(base)
        self._initialized = False
        logger.info("DuckLake pool closed")
