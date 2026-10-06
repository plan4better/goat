"""Layer metadata service.

This service retrieves layer metadata from the DuckLake catalog
and PostgreSQL metadata tables.
"""

import asyncio
import json
import logging
from typing import Any, Optional
from uuid import UUID

import asyncpg
from cachetools import TTLCache
from fastapi import HTTPException

from geoapi.config import settings
from geoapi.dependencies import LayerInfo, get_layer_info_sync, normalize_layer_id
from geoapi.tile_cache import get_redis_client

logger = logging.getLogger(__name__)

_METADATA_KEY_PREFIX = "geoapi:layer-meta:"
_METADATA_TTL_SECONDS = 300


class LayerMetadata:
    """Layer metadata container."""

    def __init__(
        self,
        layer_id: str,
        name: str,
        geometry_type: Optional[str],
        bounds: list[float],
        columns: list[dict[str, Any]],
        srid: int = 4326,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        geometry_column: Optional[str] = None,
    ) -> None:
        self.layer_id = layer_id
        self.user_id = user_id
        self.organization_id = organization_id
        self.name = name
        self.geometry_type = geometry_type
        self.bounds = bounds
        self.columns = columns
        self.srid = srid
        self.geometry_column = geometry_column

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-friendly dict for Redis storage."""
        return {
            "layer_id": self.layer_id,
            "name": self.name,
            "geometry_type": self.geometry_type,
            "bounds": self.bounds,
            "columns": self.columns,
            "srid": self.srid,
            "user_id": self.user_id,
            "organization_id": self.organization_id,
            "geometry_column": self.geometry_column,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LayerMetadata":
        """Reconstruct from the dict produced by `to_dict`."""
        return cls(**data)

    @property
    def column_names(self) -> list[str]:
        """Get list of column names."""
        return [col["name"] for col in self.columns]

    @property
    def column_types(self) -> dict[str, str]:
        """Get dict mapping column names to their JSON types."""
        return {col["name"]: col.get("json_type", "string") for col in self.columns}

    @property
    def native_column_types(self) -> dict[str, str]:
        """Get dict mapping column names to their native DuckDB types."""
        return {col["name"]: col.get("type", "") for col in self.columns}

    @property
    def has_geometry(self) -> bool:
        """Check if layer has geometry."""
        return self.geometry_type is not None


class LayerMetadataCache:
    """Redis-backed `LayerMetadata` cache with in-process fallback.

    Cache-aside pattern. Reads return None on miss; the caller is expected
    to fetch from the source of truth (PG + DuckLake) and `set` the value.

    Behaviour:

    * Redis is the **shared** layer when available. All pods read/write the
      same key, so an invalidation by one pod is immediately visible to all
      others — no pub/sub needed.
    * Every Redis call is wrapped in try/except. Connection errors,
      time-outs, OOM-on-write, evictions all degrade silently to a cache
      miss; the caller falls through to PG/DuckLake.
    * When Redis is unreachable (e.g. local single-pod dev with no Redis),
      we fall back to a small in-process `TTLCache`. Keeps single-pod fast
      without forcing Redis as a dev dependency.

    The class deliberately exposes a dict-like API (`__contains__`,
    `__getitem__`, `__setitem__`, `pop`) so it can replace the previous
    `TTLCache` with a one-line swap at the call sites.
    """

    def __init__(self, ttl_seconds: int = _METADATA_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        # In-process fallback for when Redis is down or returns None
        # because of OOM/eviction. Bounded so we don't grow unbounded.
        self._local: TTLCache[str, "LayerMetadata"] = TTLCache(
            maxsize=1000, ttl=ttl_seconds
        )

    @staticmethod
    def _key(layer_id: str) -> str:
        return f"{_METADATA_KEY_PREFIX}{layer_id}"

    # --- Redis ops, each tolerant of failures ---

    def _redis_get(self, layer_id: str) -> Optional["LayerMetadata"]:
        client = get_redis_client()
        if client is None:
            return None
        try:
            raw = client.get(self._key(layer_id))
        except Exception as e:
            logger.debug("Redis layer-meta GET failed: %s", e)
            return None
        if raw is None:
            return None
        try:
            data = json.loads(raw)
            return LayerMetadata.from_dict(data)
        except Exception as e:
            # Stale/garbled value — drop it and treat as miss.
            logger.warning("Discarding malformed layer-meta cache entry: %s", e)
            try:
                client.delete(self._key(layer_id))
            except Exception:
                pass
            return None

    def _redis_set(self, layer_id: str, metadata: "LayerMetadata") -> bool:
        client = get_redis_client()
        if client is None:
            return False
        try:
            client.set(
                self._key(layer_id),
                json.dumps(metadata.to_dict()),
                ex=self._ttl,
            )
            return True
        except Exception as e:
            # OOM (with `noeviction`), connection drop, etc. — fine.
            logger.debug("Redis layer-meta SET failed: %s", e)
            return False

    def _redis_delete(self, layer_id: str) -> None:
        client = get_redis_client()
        if client is None:
            return
        try:
            client.delete(self._key(layer_id))
        except Exception as e:
            logger.debug("Redis layer-meta DEL failed: %s", e)

    # --- Public dict-like API ---

    def __contains__(self, key: str) -> bool:
        return self._redis_get(key) is not None or key in self._local

    def __getitem__(self, key: str) -> "LayerMetadata":
        v = self._redis_get(key)
        if v is None:
            v = self._local.get(key)
        if v is None:
            raise KeyError(key)
        return v

    def __setitem__(self, key: str, value: "LayerMetadata") -> None:
        wrote_to_redis = self._redis_set(key, value)
        if not wrote_to_redis:
            # Only populate the local fallback when Redis isn't carrying
            # the value, so single-pod dev still benefits from a cache.
            self._local[key] = value

    def pop(
        self, key: str, default: Optional["LayerMetadata"] = None
    ) -> Optional["LayerMetadata"]:
        self._redis_delete(key)
        return self._local.pop(key, default)


# Layer metadata cache (5-min TTL). Backed by Redis when available, with
# an in-process TTLCache fallback for local/single-pod dev.
_metadata_cache: LayerMetadataCache = LayerMetadataCache()


class LayerService:
    """Service for layer metadata operations."""

    def __init__(self) -> None:
        self._pool: Optional[asyncpg.Pool] = None
        self._pool_lock = None  # Will be asyncio.Lock

    async def init(self) -> None:
        """Initialize connection pool."""
        import asyncio

        self._pool_lock = asyncio.Lock()
        await self._create_pool()

    async def _create_pool(self) -> None:
        """Create the connection pool with health-check settings."""
        self._pool = await asyncpg.create_pool(
            host=settings.POSTGRES_SERVER,
            port=settings.POSTGRES_PORT,
            user=settings.POSTGRES_USER,
            password=settings.POSTGRES_PASSWORD,
            database=settings.POSTGRES_DB,
            min_size=2,
            max_size=10,
            # Connection health settings
            command_timeout=60,
            # Server settings for keepalive (PostgreSQL)
            server_settings={
                "tcp_keepalives_idle": "30",
                "tcp_keepalives_interval": "5",
                "tcp_keepalives_count": "5",
            },
        )

    async def close(self) -> None:
        """Close connection pool."""
        if self._pool:
            await self._pool.close()

    async def _execute_with_retry(
        self,
        query: str,
        *args,
        fetch_one: bool = False,
        max_retries: int = 2,
    ):
        """Execute a query with retry on connection errors.

        Args:
            query: SQL query
            *args: Query arguments
            fetch_one: If True, use fetchrow; else fetchall
            max_retries: Number of retry attempts
        """
        last_error = None
        for attempt in range(max_retries):
            try:
                async with self._pool.acquire() as conn:
                    if fetch_one:
                        return await conn.fetchrow(query, *args)
                    return await conn.fetch(query, *args)
            except (
                asyncpg.exceptions.ConnectionDoesNotExistError,
                asyncpg.exceptions.InterfaceError,
                OSError,
            ) as e:
                last_error = e
                logger.warning(
                    "Query failed (attempt %d/%d): %s",
                    attempt + 1,
                    max_retries,
                    e,
                )
                # Recreate pool on connection errors
                async with self._pool_lock:
                    try:
                        await self._pool.close()
                    except Exception:
                        pass
                    await self._create_pool()
        raise last_error

    def cached_metadata(self, layer_id: str) -> Optional[LayerMetadata]:
        """Metadata already in the shared cache for `layer_id`, or None.

        Pure cache probe — no Postgres, no DuckLake, no `LayerInfo`
        resolution — for callers that have only the layer id and must not pay
        a lookup per request (the PMTiles tile fast path). The entry is the
        same one `get_layer_metadata` writes and the write hooks invalidate,
        so a reader here sees exactly what the dynamic path would see.
        """
        try:
            if layer_id in _metadata_cache:
                return _metadata_cache[layer_id]
        except KeyError:  # evicted between the check and the read
            return None
        return None

    async def get_metadata_by_id(self, layer_id: UUID) -> Optional[LayerMetadata]:
        """Layer metadata by id alone, for callers without a URL context (the
        egress metering middleware). Resolves the layer like the routes do
        (DuckLake schema or materialized catalog layer); None when unknown."""
        try:
            layer_info = await asyncio.to_thread(get_layer_info_sync, str(layer_id))
        except HTTPException:
            return None
        return await self.get_layer_metadata(layer_info)

    async def get_layer_metadata(
        self, layer_info: LayerInfo
    ) -> Optional[LayerMetadata]:
        """Get layer metadata from PostgreSQL.

        Args:
            layer_info: Layer information from URL

        Returns:
            LayerMetadata if found, None otherwise
        """
        if not self._pool:
            raise RuntimeError("LayerService not initialized")

        # Check cache first
        cache_key = layer_info.layer_id
        if cache_key in _metadata_cache:
            return _metadata_cache[cache_key]

        # Format layer_id as UUID for query
        layer_id_uuid = (
            f"{layer_info.layer_id[:8]}-{layer_info.layer_id[8:12]}-"
            f"{layer_info.layer_id[12:16]}-{layer_info.layer_id[16:20]}-"
            f"{layer_info.layer_id[20:]}"
        )

        # Query with retry
        row = await self._execute_with_retry(
            """
            SELECT
                l.id,
                l.user_id,
                u.organization_id AS organization_id,
                l.name,
                l.feature_layer_geometry_type,
                ST_XMin(e.e) AS xmin,
                ST_YMin(e.e) AS ymin,
                ST_XMax(e.e) AS xmax,
                ST_YMax(e.e) AS ymax
            FROM customer.layer l
            LEFT JOIN customer."user" u ON l.user_id = u.id
            LEFT JOIN LATERAL ST_Envelope(l.extent) e ON TRUE
            WHERE l.id = $1
            """,
            UUID(layer_id_uuid),
            fetch_one=True,
        )

        if not row:
            return None

        # Get column information from DuckLake schema
        columns = await self._get_layer_columns(layer_info)

        if not columns:
            # Every layer geoapi serves is DuckLake-backed, so a table with
            # zero columns almost always means the pinned read connection's
            # snapshot predates this layer's table (e.g. a just-created
            # layer) rather than a genuinely column-less table. Force the
            # pin to the latest snapshot and try once more before deciding.
            from geoapi.ducklake import ducklake_manager

            if ducklake_manager.force_pin_refresh():
                columns = await self._get_layer_columns(layer_info)

        # Detect geometry column from columns (None if no geometry)
        geometry_column = None
        for col in columns:
            if col.get("json_type") == "geometry":
                geometry_column = col["name"]
                break

        bounds = [
            row["xmin"] or -180,
            row["ymin"] or -90,
            row["xmax"] or 180,
            row["ymax"] or 90,
        ]

        metadata = LayerMetadata(
            layer_id=layer_info.layer_id,
            name=row["name"],
            geometry_type=row["feature_layer_geometry_type"],
            bounds=bounds,
            columns=columns,
            user_id=str(row["user_id"]).replace("-", "") if row["user_id"] else None,
            organization_id=str(row["organization_id"])
            if row["organization_id"]
            else None,
            geometry_column=geometry_column,
        )

        if not columns:
            # Still empty after a pin refresh (or the manager is unpinned):
            # don't poison the shared cache with an empty-columns result.
            # Skip writing so the next request re-resolves from DuckLake.
            logger.warning(
                "Layer %s resolved zero DuckLake columns; not caching so the "
                "next request retries",
                cache_key,
            )
            return metadata

        # Cache the metadata
        _metadata_cache[cache_key] = metadata
        logger.debug("Cached metadata for layer %s", cache_key)

        return metadata

    async def _get_layer_columns(self, layer_info: LayerInfo) -> list[dict[str, Any]]:
        """Get column information for a layer from DuckLake.

        Since DuckLake uses native column names, we query the schema directly.
        """
        from geoapi.ducklake import ducklake_manager

        columns = []
        try:
            with ducklake_manager.connection() as con:
                # DESCRIBE loads only this table's metadata;
                # information_schema.columns would lazily load every table
                # in the catalog to answer.
                result = con.execute(f"DESCRIBE {layer_info.sql_relation}").fetchall()

                for row in result:
                    col_name, col_type = row[0], row[1]
                    # A catalog view's first column IS rowid (it names
                    # file_row_number); it is the feature id, not a field.
                    if layer_info.kind == "catalog" and col_name == "rowid":
                        continue
                    # Map DuckDB types to JSON schema types
                    json_type = self._duckdb_to_json_type(col_type)
                    col_meta: dict[str, Any] = {
                        "name": col_name,
                        "type": col_type,
                        "json_type": json_type,
                    }
                    json_format = self._duckdb_to_json_format(col_type)
                    if json_format:
                        col_meta["format"] = json_format
                    columns.append(col_meta)
        except Exception:
            # If DuckLake query fails, return empty columns
            pass

        return columns

    @staticmethod
    def _duckdb_to_json_type(duckdb_type: str) -> str:
        """Map DuckDB data type to JSON schema type."""
        type_lower = duckdb_type.lower()

        if any(t in type_lower for t in ["int", "bigint", "smallint", "tinyint"]):
            return "integer"
        elif any(
            t in type_lower for t in ["float", "double", "decimal", "numeric", "real"]
        ):
            return "number"
        elif "bool" in type_lower:
            return "boolean"
        elif any(t in type_lower for t in ["geometry", "geography"]):
            return "geometry"
        elif "json" in type_lower:
            return "object"
        elif any(t in type_lower for t in ["timestamp", "date", "time"]):
            return "string"  # ISO format
        else:
            return "string"

    @staticmethod
    def _duckdb_to_json_format(duckdb_type: str) -> str | None:
        """TIMESTAMP/TIMESTAMPTZ/DATE -> "date-time"; TIME and non-temporal -> None.

        DATE deliberately collapses into the single datetime field kind.
        """
        type_lower = duckdb_type.lower()
        if "timestamp" in type_lower:
            return "date-time"
        if "date" in type_lower:
            return "date-time"
        return None

    async def is_layer_in_public_project(self, layer_id: UUID) -> bool:
        """Check if a layer belongs to any published (public) project.

        Queries the project_public table's config JSONB to find
        if any public project includes this layer_id in its layers array.

        Args:
            layer_id: Layer UUID

        Returns:
            True if the layer is in at least one public project
        """
        if not self._pool:
            raise RuntimeError("LayerService not initialized")

        row = await self._execute_with_retry(
            """
            SELECT EXISTS (
                SELECT 1 FROM customer.project_public pp
                WHERE EXISTS (
                    SELECT 1 FROM jsonb_array_elements(pp.config->'layers') AS layer
                    WHERE layer->>'layer_id' = $1
                )
            ) AS is_public
            """,
            str(layer_id),
            fetch_one=True,
        )
        return bool(row and row["is_public"])

    async def user_can_read_layer(
        self, layer_id: UUID | str, user_id: UUID | None
    ) -> bool:
        """Check whether a user may read a layer.

        A layer in any published (public) project is readable by anyone,
        anonymous included. Otherwise the one authorization rule decides —
        ``customer.can`` accepts a NULL user for a catalog layer's public
        read grant.

        Args:
            layer_id: Layer UUID (hyphenated or 32-char hex)
            user_id: Requesting user's UUID, or None if anonymous

        Returns:
            True if the layer may be read
        """
        if not self._pool:
            raise RuntimeError("LayerService not initialized")

        lid = normalize_layer_id(str(layer_id))
        if await self.is_layer_in_public_project(UUID(lid)):
            return True

        row = await self._execute_with_retry(
            "SELECT customer.can('layer', $1::uuid, $2::uuid, 'read') AS ok",
            lid,
            str(user_id) if user_id else None,
            fetch_one=True,
        )
        return bool(row and row["ok"])

    async def user_can_edit_layer(self, layer_id: UUID | str, user_id: UUID) -> bool:
        """Check whether a user may write to a layer.

        Delegates to ``customer.layer_write_allowed``, the single write rule
        shared with core: the layer's owner, an editor-or-owner via
        ``effective_role('layer', ...)`` (direct/folder/bundle grants), or
        the shared-workspace rule — a project containing the layer on which
        *both* the requesting user and the layer owner hold an edit-or-owner
        role.

        The owner-side half of the shared-workspace rule is what keeps read
        access from converting into write access. Adding a layer to a
        project only requires ``read-layer``, so without it any user could
        add a catalog layer — or one shared with them as viewer — to a
        project they own and inherit write access to someone else's
        dataset. Project access alone never grants write.

        Args:
            layer_id: Layer UUID (hyphenated or 32-char hex)
            user_id: Requesting user's UUID

        Returns:
            True if the write rule admits the write
        """
        if not self._pool:
            raise RuntimeError("LayerService not initialized")

        row = await self._execute_with_retry(
            "SELECT customer.layer_write_allowed($1::uuid, $2::uuid) AS can_edit",
            normalize_layer_id(str(layer_id)),
            str(user_id),
            fetch_one=True,
        )
        return bool(row and row["can_edit"])

    async def list_layers(
        self,
        user_id: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[LayerMetadata], int]:
        """List available layers.

        Args:
            user_id: Optional user ID filter
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            Tuple of (layers, total_count)
        """
        if not self._pool:
            raise RuntimeError("LayerService not initialized")

        async with self._pool.acquire() as conn:
            # Build condition
            condition = ""
            params = []
            param_idx = 1

            if user_id:
                # Format user_id as UUID
                user_id_uuid = (
                    f"{user_id[:8]}-{user_id[8:12]}-"
                    f"{user_id[12:16]}-{user_id[16:20]}-"
                    f"{user_id[20:]}"
                )
                condition = f"WHERE l.user_id = ${param_idx}"
                params.append(UUID(user_id_uuid))
                param_idx += 1

            # Get total count
            count_sql = f"""
                SELECT COUNT(*)
                FROM customer.layer l
                {condition}
            """
            total = await conn.fetchval(count_sql, *params)

            # Get layers
            sql = f"""
                SELECT
                    l.id,
                    l.user_id,
                    l.name,
                    l.feature_layer_geometry_type,
                    ST_XMin(e.e) AS xmin,
                    ST_YMin(e.e) AS ymin,
                    ST_XMax(e.e) AS xmax,
                    ST_YMax(e.e) AS ymax
                FROM customer.layer l
                LEFT JOIN LATERAL ST_Envelope(l.extent) e ON TRUE
                {condition}
                ORDER BY l.created_at DESC
                LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """
            params.extend([limit, offset])

            rows = await conn.fetch(sql, *params)

            layers = []
            for row in rows:
                layer_id = str(row["id"]).replace("-", "")
                user_id_str = (
                    str(row["user_id"]).replace("-", "") if row["user_id"] else None
                )

                bounds = [
                    row["xmin"] or -180,
                    row["ymin"] or -90,
                    row["xmax"] or 180,
                    row["ymax"] or 90,
                ]

                layers.append(
                    LayerMetadata(
                        layer_id=layer_id,
                        user_id=user_id_str,
                        name=row["name"],
                        geometry_type=row["feature_layer_geometry_type"],
                        bounds=bounds,
                        columns=[],  # Skip columns for list view
                    )
                )

            return layers, total


# Singleton instance
layer_service = LayerService()
