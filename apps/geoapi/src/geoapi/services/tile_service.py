"""Tile service for generating MVT tiles.

This service generates Mapbox Vector Tiles (MVT) using a hybrid approach:
1. PMTiles (static) - Pre-generated tiles for fast unfiltered access
2. Dynamic tiles - On-the-fly generation using DuckDB's ST_AsMVT for filtered requests

The service automatically routes requests to the appropriate source:
- If PMTiles exist AND no CQL filter is applied → serve from PMTiles
- Otherwise → generate dynamically from DuckLake

Variable-depth tile pyramid support:
PMTiles generated with --generate-variable-depth-tile-pyramid may not have
tiles at all zoom levels. When a tile is missing, we find the nearest parent
tile and use tippecanoe-overzoom to generate the requested tile on-the-fly.

Caching:
- Redis cache for distributed deployments (shared across pods)
- In-memory cache for PMTiles readers (file handles, cannot be shared)
"""

import asyncio
import gzip
import logging
import math
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BufferedReader
from pathlib import Path
from typing import Any, Optional

from cachetools import LRUCache, TTLCache
from goatlib.storage import build_filters
from pmtiles.reader import MmapSource
from pmtiles.tile import (
    deserialize_directory,
    deserialize_header,
    find_tile,
    zxy_to_tileid,
)

from geoapi.config import settings
from geoapi.dependencies import LayerInfo
from geoapi.ducklake_pool import ducklake_pool
from geoapi.tile_cache import cache_tile, get_cached_tile

logger = logging.getLogger(__name__)


def _qi(name: str) -> str:
    """Quote a SQL identifier, doubling any embedded double quote."""
    return '"' + name.replace('"', '""') + '"'


# Web Mercator extent in meters (EPSG:3857)
WEB_MERCATOR_EXTENT = 20037508.342789244

# Thread pool for PMTiles I/O (file reads are blocking)
# 16 workers - balanced for parallel file access without overwhelming resources
# Per-file locking in _get_cached_pmtiles_reader prevents contention
_pmtiles_executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="pmtiles")

# Thread pool for dynamic tile generation (DuckDB queries are blocking)
_dynamic_tile_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="dyntile")

# Maximum leaf directory entries to cache per PMTiles file (~64KB per file)
_LEAF_CACHE_MAX_SIZE = 1000

# Maximum entries for path and exists caches (for 10,000+ layers scalability)
# These use LRU eviction to bound memory usage
_PATH_CACHE_MAX_SIZE = 2000  # ~400KB max
_EXISTS_CACHE_MAX_SIZE = 5000  # ~250KB max
# How long "no workflow temp tiles for this layer id" is believed.
_TEMP_MISS_TTL_S = 30


def _tiles_version(pmtiles_path: Path, label: bool) -> str | None:
    """What the cached tiles of this file are keyed on: its mtime, plus the
    anchor file's for label tiles (regenerated on its own). None when the
    file is gone."""
    try:
        version = str(pmtiles_path.stat().st_mtime_ns)
    except FileNotFoundError:
        return None
    if label:
        anchor = pmtiles_path.with_name(pmtiles_path.stem + "_anchor.pmtiles")
        try:
            version += f".{anchor.stat().st_mtime_ns}"
        except FileNotFoundError:
            version += ".none"
    return version


class CachedPMTilesReader:
    """Optimized PMTiles reader that caches header and root directory.

    The standard pmtiles library re-parses the header and decompresses
    the root directory on every get() call. This class caches them.
    """

    def __init__(self, get_bytes):
        self.get_bytes = get_bytes
        # Parse header once
        self._header = deserialize_header(self.get_bytes(0, 127))
        # Parse and cache root directory once
        root_bytes = self.get_bytes(
            self._header["root_offset"], self._header["root_length"]
        )
        self._root_directory = deserialize_directory(root_bytes)
        # Cache for leaf directories with size limit (FIFO eviction)
        self._leaf_cache: dict[tuple[int, int], list] = {}

    def header(self):
        return self._header

    def get(self, z: int, x: int, y: int) -> Optional[bytes]:
        """Get tile data with cached directory lookups."""
        tile_id = zxy_to_tileid(z, x, y)
        header = self._header

        # Start with cached root directory
        directory = self._root_directory

        for depth in range(0, 4):  # max depth
            result = find_tile(directory, tile_id)
            if result:
                if result.run_length == 0:
                    # Need to read leaf directory
                    leaf_offset = header["leaf_directory_offset"] + result.offset
                    leaf_length = result.length

                    # Check leaf cache
                    cache_key = (leaf_offset, leaf_length)
                    if cache_key in self._leaf_cache:
                        directory = self._leaf_cache[cache_key]
                    else:
                        # Evict oldest entries if cache is full
                        while len(self._leaf_cache) >= _LEAF_CACHE_MAX_SIZE:
                            oldest_key = next(iter(self._leaf_cache))
                            del self._leaf_cache[oldest_key]
                        # Read and cache leaf directory
                        leaf_bytes = self.get_bytes(leaf_offset, leaf_length)
                        directory = deserialize_directory(leaf_bytes)
                        self._leaf_cache[cache_key] = directory
                else:
                    # Found tile data
                    return self.get_bytes(
                        header["tile_data_offset"] + result.offset, result.length
                    )
            else:
                return None
        return None


# PMTiles reader cache to avoid re-parsing the index for every tile request
# key=pmtiles_path -> (reader, header, file_handle, mtime)
# NOTE: This must remain in-memory (file handles cannot be serialized to Redis)
_pmtiles_reader_cache: dict[
    str, tuple[CachedPMTilesReader, Any, BufferedReader, float]
] = {}
_pmtiles_reader_cache_lock = threading.Lock()  # Protects cache dict access only
# Per-file locks for creation - bounded with LRU eviction
_pmtiles_file_locks: LRUCache[str, threading.Lock] = LRUCache(maxsize=100)
_PMTILES_READER_CACHE_MAX_SIZE = 30  # Max cached readers (limits open file handles)


def _get_cached_pmtiles_reader(
    pmtiles_path: Path,
) -> tuple[CachedPMTilesReader, Any, bool]:
    """Get or create a cached PMTiles reader.

    Uses per-file locking so requests for different files can proceed in parallel.

    If the file on disk has been modified since we cached it (e.g. the layer
    was overwritten by a workflow export or ``layer_update``), the stale
    reader is evicted and the file is re-opened. This keeps tile output fresh
    across in-place regenerations without requiring explicit cross-process
    cache invalidation.

    Returns:
        Tuple of (reader, header, is_gzip)
    """
    path_str = str(pmtiles_path)
    current_mtime = pmtiles_path.stat().st_mtime

    # Fast path: check if already cached (minimal lock time)
    with _pmtiles_reader_cache_lock:
        if path_str in _pmtiles_reader_cache:
            reader, header, fh, cached_mtime = _pmtiles_reader_cache[path_str]
            if cached_mtime == current_mtime:
                tile_compression = header.get("tile_compression")
                is_gzip = bool(tile_compression and tile_compression.value == 2)
                return reader, header, is_gzip
            # File has been rewritten since we cached it — evict and re-open.
            try:
                fh.close()
            except Exception:
                pass
            del _pmtiles_reader_cache[path_str]

        # Get or create per-file lock
        if path_str not in _pmtiles_file_locks:
            _pmtiles_file_locks[path_str] = threading.Lock()
        file_lock = _pmtiles_file_locks[path_str]

    # Acquire per-file lock (allows parallel opens of different files)
    with file_lock:
        # Double-check after acquiring lock (another thread may have created it)
        with _pmtiles_reader_cache_lock:
            if path_str in _pmtiles_reader_cache:
                reader, header, fh, cached_mtime = _pmtiles_reader_cache[path_str]
                if cached_mtime == current_mtime:
                    tile_compression = header.get("tile_compression")
                    is_gzip = bool(tile_compression and tile_compression.value == 2)
                    return reader, header, is_gzip
                # Stale again — evict and fall through to re-open.
                try:
                    fh.close()
                except Exception:
                    pass
                del _pmtiles_reader_cache[path_str]

        # Not in cache - open file (outside global lock)
        fh = open(pmtiles_path, "rb")
        source = MmapSource(fh)
        reader = CachedPMTilesReader(source)
        header = reader.header()

        # Store in cache (brief lock)
        with _pmtiles_reader_cache_lock:
            # Evict oldest entries if cache is full
            if len(_pmtiles_reader_cache) >= _PMTILES_READER_CACHE_MAX_SIZE:
                oldest_key = next(iter(_pmtiles_reader_cache))
                old_reader, old_header, old_fh, _ = _pmtiles_reader_cache[oldest_key]
                try:
                    old_fh.close()
                except Exception:
                    pass
                del _pmtiles_reader_cache[oldest_key]
                # Note: file locks use their own LRU eviction, no need to sync

            _pmtiles_reader_cache[path_str] = (reader, header, fh, current_mtime)

        tile_compression = header.get("tile_compression")
        is_gzip = bool(tile_compression and tile_compression.value == 2)
        return reader, header, is_gzip


def tile_to_bbox_4326(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Convert tile coordinates to EPSG:4326 (lon/lat) bounding box.

    Args:
        z: Zoom level
        x: Tile X coordinate
        y: Tile Y coordinate

    Returns:
        Tuple of (xmin, ymin, xmax, ymax) in EPSG:4326
    """
    n = 2**z
    lon_min = x / n * 360.0 - 180.0
    lon_max = (x + 1) / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return (lon_min, lat_min, lon_max, lat_max)


def get_bounds_from_pmtiles_header(header) -> tuple[float, float, float, float]:
    """Extract bounds from PMTiles header.

    PMTiles v3 stores bounds as e7 (10^7) format integers: min_lon_e7, min_lat_e7, etc.
    Some PMTiles may have float bounds: min_lon, min_lat, etc.

    Args:
        header: PMTiles header dictionary

    Returns:
        Tuple of (min_lon, min_lat, max_lon, max_lat) in EPSG:4326
    """
    # Try e7 format first (PMTiles v3 standard)
    min_lon_e7 = header.get("min_lon_e7")
    if min_lon_e7 is not None:
        return (
            min_lon_e7 / 1e7,
            header.get("min_lat_e7", -850000000) / 1e7,
            header.get("max_lon_e7", 1800000000) / 1e7,
            header.get("max_lat_e7", 850000000) / 1e7,
        )

    # Fallback to float format (older or custom PMTiles)
    return (
        header.get("min_lon", -180),
        header.get("min_lat", -85),
        header.get("max_lon", 180),
        header.get("max_lat", 85),
    )


def tile_intersects_bounds(
    z: int,
    x: int,
    y: int,
    bounds_min_lon: float,
    bounds_min_lat: float,
    bounds_max_lon: float,
    bounds_max_lat: float,
) -> bool:
    """Check if a tile intersects the given bounds (EPSG:4326).

    Args:
        z, x, y: Tile coordinates
        bounds_*: Bounding box in EPSG:4326 (lon/lat)

    Returns:
        True if tile intersects bounds, False otherwise
    """
    tile_bbox = tile_to_bbox_4326(z, x, y)
    tile_min_lon, tile_min_lat, tile_max_lon, tile_max_lat = tile_bbox

    # Check if boxes don't overlap
    if tile_max_lon < bounds_min_lon or tile_min_lon > bounds_max_lon:
        return False
    if tile_max_lat < bounds_min_lat or tile_min_lat > bounds_max_lat:
        return False

    return True


def tile_to_bbox_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Convert tile coordinates to EPSG:3857 (Web Mercator) bounding box.

    Args:
        z: Zoom level
        x: Tile X coordinate
        y: Tile Y coordinate

    Returns:
        Tuple of (xmin, ymin, xmax, ymax) in EPSG:3857
    """
    n = 2**z
    tile_size = 2 * WEB_MERCATOR_EXTENT / n
    x_min = -WEB_MERCATOR_EXTENT + x * tile_size
    x_max = -WEB_MERCATOR_EXTENT + (x + 1) * tile_size
    y_max = WEB_MERCATOR_EXTENT - y * tile_size
    y_min = WEB_MERCATOR_EXTENT - (y + 1) * tile_size
    return (x_min, y_min, x_max, y_max)


class TileService:
    """Service for generating vector tiles with hybrid PMTiles/dynamic support."""

    def __init__(self) -> None:
        self.max_features = settings.MAX_FEATURES_PER_TILE
        self.extent = settings.DEFAULT_EXTENT
        self.buffer = settings.DEFAULT_TILE_BUFFER
        self.ducklake_data_dir = Path(settings.DUCKLAKE_DATA_DIR)
        self.tiles_data_dir = Path(settings.TILES_DATA_DIR)
        # A catalog layer's tiles have their own directory under the catalog
        # tree: derived from a dataset every deployment has, so wipeable and
        # rebuildable on their own, and never mixed into the tiles a user's
        # data produced.
        self.catalog_tiles_dir = Path(settings.CATALOG_TILES_DIR)
        # Track which PMTiles files exist (LRU cache for 10k+ layers)
        # TTL, not plain LRU: a False verdict must expire, because PMTiles can
        # arrive AFTER a layer starts serving — catalog layers flip ready as
        # soon as their data lands and tiles follow — and a sticky False would
        # pin every pod to the dynamic path until restart. (True expiring too
        # means a deleted file self-heals within the same minute.)
        self._pmtiles_exists_cache: TTLCache[str, bool] = TTLCache(
            maxsize=_EXISTS_CACHE_MAX_SIZE, ttl=60
        )
        # Cache PMTiles paths by layer_id (LRU cache for 10k+ layers)
        self._pmtiles_path_cache: LRUCache[str, Path | None] = LRUCache(
            maxsize=_PATH_CACHE_MAX_SIZE
        )
        # Layer ids the workflow temp tree was searched for in vain. The
        # search walks the whole tree (thousands of directories on NFS), so it
        # runs only for ids that are no layer (see `search_temp`), and a miss
        # is remembered. The verdict expires: a workflow's tiles can arrive
        # after its first request.
        self._temp_pmtiles_misses: TTLCache[str, bool] = TTLCache(
            maxsize=_PATH_CACHE_MAX_SIZE, ttl=_TEMP_MISS_TTL_S
        )
        # One temp tree search at a time per process: concurrent tile
        # requests wait for the first verdict instead of each walking the tree.
        self._temp_search_lock = asyncio.Lock()

    def _find_pmtiles_by_layer_id(self, layer_id: str) -> Path | None:
        """Find PMTiles file for a layer by its id alone (no schema lookup needed).

        PMTiles are stored flat as {tiles_data_dir}/t_{layer_id_no_hyphens}.pmtiles
        (catalog layers under {catalog_tiles_dir}), so finding them is a stat() of
        a known path. The tiles directory is never listed: it holds tens of
        thousands of files, and listing it has failed outright on NFS clients
        that cached it. Temp PMTiles are stored as
        {temp_data_dir}/**/t_{layer_id_no_hyphens}.pmtiles.

        Request handlers use `_find_pmtiles_by_layer_id_async`, which keeps
        the temp tree search off the event loop.

        Args:
            layer_id: Layer UUID (with or without hyphens)

        Returns:
            Path to PMTiles file if found, None otherwise
        """
        found = self._find_known_pmtiles(layer_id)
        if found is not None:
            return found
        return self._search_temp_pmtiles(layer_id)

    async def _find_pmtiles_by_layer_id_async(
        self, layer_id: str, search_temp: bool = False
    ) -> Path | None:
        """`_find_pmtiles_by_layer_id` for request handlers.

        The stat() checks run inline. The workflow temp tree is searched only
        with `search_temp`: callers set it for ids known to be workflow
        results, never for a layer, which has its tiles at the flat path or
        none. The search runs in a worker thread, one at a time, so a slow
        walk on network storage never blocks the event loop (and with it
        every other request and the health check).
        """
        found = self._find_known_pmtiles(layer_id)
        if found is not None or not search_temp:
            return found
        layer_id_normalized = layer_id.replace("-", "")
        if layer_id_normalized in self._temp_pmtiles_misses:
            return None
        async with self._temp_search_lock:
            # Another request may have searched while this one waited.
            if layer_id_normalized in self._temp_pmtiles_misses:
                return None
            cached = self._pmtiles_path_cache.get(layer_id_normalized)
            if cached is not None:
                return cached
            return await asyncio.to_thread(self._search_temp_pmtiles, layer_id)

    def _find_known_pmtiles(self, layer_id: str) -> Path | None:
        """The cached path, else the catalog or flat path when the file exists."""
        layer_id_normalized = layer_id.replace("-", "")

        # Check cache first - only return if we found a path (don't cache None)
        cached = self._pmtiles_path_cache.get(layer_id_normalized)
        if cached is not None:
            return cached

        # No `kind` here, so both trees are candidates. The catalog one is a
        # single stat() and holds at most the promoted layers, so it goes first.
        catalog = self.catalog_tiles_dir / f"t_{layer_id_normalized}.pmtiles"
        if catalog.exists():
            self._pmtiles_path_cache[layer_id_normalized] = catalog
            return catalog

        flat = self.tiles_data_dir / f"t_{layer_id_normalized}.pmtiles"
        if flat.exists():
            self._pmtiles_path_cache[layer_id_normalized] = flat
            return flat

        return None

    def _search_temp_pmtiles(self, layer_id: str) -> Path | None:
        """Search the workflow temp tree, nested by user, workflow and node."""
        layer_id_normalized = layer_id.replace("-", "")
        if layer_id_normalized in self._temp_pmtiles_misses:
            return None

        matches: list[Path] = []
        temp_data_dir = self.tiles_data_dir.parent / "temporary"
        if temp_data_dir.exists():
            matches = list(temp_data_dir.glob(f"**/t_{layer_id_normalized}.pmtiles"))

        if matches:
            path = matches[0]
            self._pmtiles_path_cache[layer_id_normalized] = path
            return path
        self._temp_pmtiles_misses[layer_id_normalized] = True
        return None

    def invalidate_pmtiles_path_cache(self, layer_id: str) -> None:
        """Invalidate the PMTiles path cache for a layer.

        Call this when PMTiles are regenerated or deleted.
        """
        layer_id_normalized = layer_id.replace("-", "")
        self._temp_pmtiles_misses.pop(layer_id_normalized, None)
        if layer_id_normalized in self._pmtiles_path_cache:
            del self._pmtiles_path_cache[layer_id_normalized]
            logger.debug("Invalidated PMTiles path cache for layer %s", layer_id)

    def _get_pmtiles_path(self, layer_info: LayerInfo) -> Path:
        """Get the PMTiles file path for a layer.

        Tiles are written flat, keyed only by layer id. Tiles written before
        that are nested under the schema holding the layer's table, so a
        layer whose tiles have not been regenerated since is still found.

        Args:
            layer_info: Layer information

        Returns:
            Path to PMTiles file — the flat one when it exists, else the
            legacy location (returned even when absent, so callers keep
            treating a missing file as "no tiles").
        """
        if getattr(layer_info, "kind", "lake") == "catalog":
            catalog = self.catalog_tiles_dir / f"{layer_info.table_name}.pmtiles"
            if catalog.exists():
                return catalog
            # Materialized before the move: served where it was written, so an
            # un-migrated deployment keeps working. Returned unconditionally
            # otherwise, so a caller still reads "no tiles" from a missing file
            # -- but pointing at the catalog tree, which is where the next
            # materialize writes.
            moved = self.tiles_data_dir / f"{layer_info.table_name}.pmtiles"
            return moved if moved.exists() else catalog

        flat = self.tiles_data_dir / f"{layer_info.table_name}.pmtiles"
        if flat.exists():
            return flat

        legacy = (
            self.tiles_data_dir
            / layer_info.schema_name
            / f"{layer_info.table_name}.pmtiles"
        )
        return legacy if legacy.exists() else flat

    def _pmtiles_exists(self, layer_info: LayerInfo) -> bool:
        """Check if PMTiles file exists for a layer.

        Uses caching to avoid repeated filesystem checks.

        Args:
            layer_info: Layer information

        Returns:
            True if PMTiles file exists
        """
        cache_key = f"{layer_info.schema_name}/{layer_info.table_name}"

        # One read, not check-then-get: on a TTLCache `in` and `[]` each
        # re-evaluate expiry, so an entry can pass the test and then raise
        # KeyError on the read (also across threads on the tile executor).
        cached = self._pmtiles_exists_cache.get(cache_key)
        if cached is not None:
            return cached
        pmtiles_path = self._get_pmtiles_path(layer_info)
        exists = pmtiles_path.exists()
        self._pmtiles_exists_cache[cache_key] = exists
        logger.debug(
            "PMTiles %s for %s", "available" if exists else "not found", cache_key
        )
        return exists

    def invalidate_pmtiles_cache(self, schema_name: str, table_name: str) -> None:
        """Invalidate PMTiles cache for a layer.

        Call this when PMTiles are regenerated or deleted.

        Args:
            schema_name: Schema name (e.g., "user_abc123")
            table_name: Table name (e.g., "t_xyz789")
        """
        cache_key = f"{schema_name}/{table_name}"
        if cache_key in self._pmtiles_exists_cache:
            del self._pmtiles_exists_cache[cache_key]
            logger.debug("Invalidated PMTiles cache for %s", cache_key)

    def _should_use_pmtiles(
        self,
        layer_info: LayerInfo,
        cql_filter: Optional[dict] = None,
        bbox: Optional[list[float]] = None,
    ) -> bool:
        """Determine if request should use PMTiles.

        PMTiles are used when:
        1. PMTiles file exists for the layer
        2. No CQL filter is applied (filters require dynamic generation)
        3. No additional bbox filter (tile bbox is implicit)

        Args:
            layer_info: Layer information
            cql_filter: Optional CQL filter
            bbox: Optional additional bbox filter

        Returns:
            True if PMTiles should be used
        """
        # If filters are applied, need dynamic generation
        if cql_filter or bbox:
            return False

        # Check if PMTiles exist
        return self._pmtiles_exists(layer_info)

    def can_serve_from_pmtiles(
        self,
        layer_info: LayerInfo,
        cql_filter: Optional[dict] = None,
        bbox: Optional[list[float]] = None,
    ) -> bool:
        """Public method to check if PMTiles can be used for this request.

        This is used by the router to skip expensive metadata lookups.

        Args:
            layer_info: Layer information
            cql_filter: Optional CQL filter
            bbox: Optional additional bbox filter

        Returns:
            True if PMTiles can serve this request
        """
        return self._should_use_pmtiles(layer_info, cql_filter, bbox)

    async def get_tile_from_pmtiles_only(
        self,
        layer_info: LayerInfo,
        z: int,
        x: int,
        y: int,
        label: bool = False,
    ) -> Optional[tuple[bytes, bool, str]]:
        """Get tile directly from PMTiles without metadata lookup.

        Fast path for tile serving when PMTiles exist and no filters are applied.

        Args:
            layer_info: Layer information
            z: Zoom level
            x: Tile X coordinate
            y: Tile Y coordinate
            label: If True, serve anchor PMTiles (polygon label points) instead of main tiles

        Returns:
            Tuple of (tile_data, is_gzip, source) or None if PMTiles not available
        """
        if not self._pmtiles_exists(layer_info):
            return None

        result = await self._get_tile_from_pmtiles(layer_info, z, x, y, label=label)
        if result is None:
            return None

        tile_data, is_gzip = result
        return (tile_data, is_gzip, "pmtiles")

    def can_serve_from_pmtiles_by_layer_id(
        self,
        layer_id: str,
        cql_filter: Optional[dict] = None,
        bbox: Optional[list[float]] = None,
    ) -> bool:
        """Check if this request may be served from PMTiles by layer_id alone.

        Only the filters decide here; whether the file exists is answered by
        `get_tile_from_pmtiles_by_layer_id`, which returns None without one,
        so the file lookup never runs on the event loop.

        Args:
            layer_id: Layer UUID (with or without hyphens)
            cql_filter: Optional CQL filter
            bbox: Optional additional bbox filter

        Returns:
            True if PMTiles can serve this request
        """
        # If filters are applied, need dynamic generation
        return not (cql_filter or bbox)

    async def get_tile_from_pmtiles_by_layer_id(
        self,
        layer_id: str,
        z: int,
        x: int,
        y: int,
        label: bool = False,
        search_temp: bool = False,
    ) -> Optional[tuple[bytes, bool, str]]:
        """Get tile directly from PMTiles using only layer_id (no schema lookup).

        Ultra-fast path that completely bypasses DuckDB.
        Uses Redis cache for distributed deployments, keyed on the PMTiles
        file's mtime so a regenerated file is never answered from the cache.

        Args:
            layer_id: Layer UUID (with or without hyphens)
            z: Zoom level
            x: Tile X coordinate
            y: Tile Y coordinate
            label: If True, serve anchor PMTiles (polygon label points) instead of main tiles
            search_temp: Also search the workflow temp tree (workflow results only)

        Returns:
            Tuple of (tile_data, is_gzip, source) or None if PMTiles not available
        """
        start_time = time.monotonic()

        # Anchor tiles are cached under a separate key to avoid collision
        cache_layer_id = layer_id + "_anchor" if label else layer_id

        # Step 1: Find PMTiles path. Its mtime versions the cached tiles: a
        # workflow re-run or a layer refresh rewrites the file under the same
        # layer id, and must not be answered with tiles of the old one.
        pmtiles_path = await self._find_pmtiles_by_layer_id_async(layer_id, search_temp)
        if pmtiles_path is None:
            return None
        version = _tiles_version(pmtiles_path, label)
        if version is None:
            # The cached path is gone: rewritten elsewhere or deleted for
            # regeneration. Look again.
            self._pmtiles_path_cache.pop(layer_id.replace("-", ""), None)
            pmtiles_path = await self._find_pmtiles_by_layer_id_async(
                layer_id, search_temp
            )
            if pmtiles_path is None:
                return None
            version = _tiles_version(pmtiles_path, label)
            if version is None:
                return None

        # Check Redis cache (fast path for distributed deployments)
        cached = get_cached_tile(cache_layer_id, z, x, y, version=version)
        if cached is not None:
            tile_data, is_gzip = cached
            elapsed_ms = (time.monotonic() - start_time) * 1000
            logger.debug(
                "Redis cache hit for %s tile %d/%d/%d: %d bytes (%.1fms)",
                cache_layer_id[:8],
                z,
                x,
                y,
                len(tile_data),
                elapsed_ms,
            )
            return (tile_data, is_gzip, "pmtiles-cached")

        # Step 2: Read tile from PMTiles
        result = await self._get_tile_from_pmtiles_path(pmtiles_path, z, x, y)

        elapsed_ms = (time.monotonic() - start_time) * 1000
        if result is None:
            logger.debug(
                "PMTiles %s tile %d/%d/%d: not found (%.1fms)",
                pmtiles_path.name,
                z,
                x,
                y,
                elapsed_ms,
            )
            return None

        tile_data, is_gzip = result

        # Step 3: When label=True, merge anchor tile (polygon label points)
        if label:
            tile_data, is_gzip = await self._merge_anchor_tile(
                pmtiles_path, z, x, y, tile_data, is_gzip
            )

        # Cache in Redis for other pods
        if tile_data:
            cache_tile(cache_layer_id, z, x, y, tile_data, is_gzip, version=version)

        logger.debug(
            "PMTiles %s tile %d/%d/%d: %d bytes (%.1fms)",
            pmtiles_path.name,
            z,
            x,
            y,
            len(tile_data),
            elapsed_ms,
        )
        return (tile_data, is_gzip, "pmtiles")

    async def _get_tile_from_pmtiles_path(
        self, pmtiles_path: Path, z: int, x: int, y: int
    ) -> Optional[tuple[bytes, bool]]:
        """Get tile data from a specific PMTiles file path.

        Supports variable-depth tile pyramids with overzoom.
        NOTE: Redis caching is done at the caller level (get_tile_from_pmtiles_by_layer_id).

        Args:
            pmtiles_path: Path to PMTiles file
            z: Zoom level
            x: Tile X coordinate
            y: Tile Y coordinate

        Returns:
            Tuple of (tile_data, is_gzip_compressed) or None if tile not found
        """

        def _read_tile() -> (
            Optional[tuple[bytes, bool]] | tuple[str, bytes, int, int, int, bool]
        ):
            """Synchronous tile read function using cached reader."""
            try:
                # Get cached reader (fast path - no file open/index parse)
                reader, header, is_gzip = _get_cached_pmtiles_reader(pmtiles_path)

                min_zoom = header.get("min_zoom", 0)

                # Check if tile is below min zoom
                if z < min_zoom:
                    return (b"", False)  # Empty tile

                # Try to get the tile directly
                tile_data = reader.get(z, x, y)

                if tile_data:
                    # Check if tile is gzip compressed (fallback check)
                    if not is_gzip:
                        is_gzip = len(tile_data) >= 2 and tile_data[0:2] == b"\x1f\x8b"
                    return (tile_data, is_gzip)

                # Tile not found - find parent tile for variable-depth pyramids
                parent_z, parent_x, parent_y = z, x, y
                parent_tile = None

                while parent_z >= min_zoom:
                    parent_tile = reader.get(parent_z, parent_x, parent_y)
                    if parent_tile is not None:
                        break
                    # Move to parent tile
                    parent_z -= 1
                    parent_x >>= 1
                    parent_y >>= 1

                if parent_tile is None:
                    # No parent found - return empty tile
                    return (b"", False)

                # If parent is at same zoom, just return it
                if parent_z == z:
                    return (parent_tile, is_gzip)

                # Check if target tile intersects the data bounds
                # This avoids expensive overzoom for tiles outside the data extent
                min_lon, min_lat, max_lon, max_lat = get_bounds_from_pmtiles_header(
                    header
                )

                if not tile_intersects_bounds(
                    z, x, y, min_lon, min_lat, max_lon, max_lat
                ):
                    # Target tile is outside data bounds - return empty without overzoom
                    logger.debug(
                        "Tile %d/%d/%d outside bounds [%.4f,%.4f,%.4f,%.4f] - skipping overzoom",
                        z,
                        x,
                        y,
                        min_lon,
                        min_lat,
                        max_lon,
                        max_lat,
                    )
                    return (b"", False)

                # Signal that overzoom is needed
                return (
                    "overzoom",
                    parent_tile,
                    parent_z,
                    parent_x,
                    parent_y,
                    is_gzip,
                )

            except Exception as e:
                logger.warning(
                    "Error reading PMTiles %s at %d/%d/%d: %s",
                    pmtiles_path,
                    z,
                    x,
                    y,
                    e,
                )
                return None

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pmtiles_executor, _read_tile)

        if result is None:
            return None

        # Handle overzoom case - now with full support!
        if isinstance(result, tuple) and len(result) == 6 and result[0] == "overzoom":
            _, parent_tile, parent_z, parent_x, parent_y, is_gzip = result

            overzoom_start = time.monotonic()
            # Run async overzoom (non-blocking)
            overzoomed = await self._overzoom_tile(
                parent_tile, parent_z, parent_x, parent_y, z, x, y, is_gzip
            )
            overzoom_ms = (time.monotonic() - overzoom_start) * 1000

            if overzoomed:
                logger.debug(
                    "Overzoom %d/%d/%d -> %d/%d/%d: %d bytes parent -> %d bytes (%.1fms)",
                    parent_z,
                    parent_x,
                    parent_y,
                    z,
                    x,
                    y,
                    len(parent_tile),
                    len(overzoomed),
                    overzoom_ms,
                )
                # tippecanoe-overzoom outputs gzip-compressed tiles
                return (overzoomed, True)

            # Overzoom returned empty - this is normal when target tile has no features
            logger.debug(
                "Overzoom %d/%d/%d -> %d/%d/%d: no features (%.1fms)",
                parent_z,
                parent_x,
                parent_y,
                z,
                x,
                y,
                overzoom_ms,
            )
            return (b"", False)

        return result

    async def _get_tile_from_pmtiles(
        self, layer_info: LayerInfo, z: int, x: int, y: int, label: bool = False
    ) -> Optional[tuple[bytes, bool]]:
        """Get tile data from PMTiles file using pmtiles library.

        Supports variable-depth tile pyramids: if the requested tile doesn't
        exist, finds the nearest parent tile and uses tippecanoe-overzoom to
        generate the requested tile on-the-fly.

        Runs in a thread pool since file I/O is blocking.

        Args:
            layer_info: Layer information
            z: Zoom level
            x: Tile X coordinate
            y: Tile Y coordinate
            label: If True, serve anchor PMTiles (polygon label points) instead of main tiles

        Returns:
            Tuple of (tile_data, is_gzip_compressed) or None if tile not found
        """
        pmtiles_path = self._get_pmtiles_path(layer_info)

        def _read_tile() -> (
            Optional[tuple[bytes, bool]] | tuple[str, bytes, int, int, int, bool]
        ):
            """Synchronous tile read function.

            Returns either:
            - (tile_data, is_gzip) for direct tile
            - ("overzoom", parent_tile, parent_z, parent_x, parent_y, is_gzip) for overzoom
            - None on error
            """
            try:
                with open(pmtiles_path, "rb") as f:
                    reader = CachedPMTilesReader(MmapSource(f))
                    header = reader.header()

                    min_zoom = header.get("min_zoom", 0)

                    # Check if below min zoom
                    if z < min_zoom:
                        logger.debug(
                            "PMTiles zoom %d below min %d for %s",
                            z,
                            min_zoom,
                            pmtiles_path.name,
                        )
                        return b"", False  # Empty tile

                    # Check if tiles are gzip compressed
                    tile_compression = header.get("tile_compression")
                    is_gzip = tile_compression and tile_compression.value == 2  # GZIP

                    # Try to get tile at requested zoom
                    tile_data = reader.get(z, x, y)

                    if tile_data is not None:
                        return tile_data, is_gzip

                    # Tile doesn't exist - find parent tile for variable-depth pyramids
                    # Walk up the tree to find the nearest parent with data
                    parent_z, parent_x, parent_y = z, x, y
                    parent_tile = None

                    while parent_z >= min_zoom:
                        parent_tile = reader.get(parent_z, parent_x, parent_y)
                        if parent_tile is not None:
                            break
                        # Move to parent tile
                        parent_z -= 1
                        parent_x >>= 1
                        parent_y >>= 1

                    if parent_tile is None:
                        # No parent found - return empty tile
                        return b"", False

                    # If parent is at same zoom, just return it
                    if parent_z == z:
                        return parent_tile, is_gzip

                    # Check if target tile intersects the data bounds
                    # This avoids expensive overzoom for tiles outside the data extent
                    min_lon, min_lat, max_lon, max_lat = get_bounds_from_pmtiles_header(
                        header
                    )

                    if not tile_intersects_bounds(
                        z, x, y, min_lon, min_lat, max_lon, max_lat
                    ):
                        # Target tile is outside data bounds - return empty without overzoom
                        logger.debug(
                            "Tile %d/%d/%d outside bounds [%.4f,%.4f,%.4f,%.4f] - skipping overzoom",
                            z,
                            x,
                            y,
                            min_lon,
                            min_lat,
                            max_lon,
                            max_lat,
                        )
                        return b"", False

                    # Signal that overzoom is needed (will be done async outside executor)
                    return (
                        "overzoom",
                        parent_tile,
                        parent_z,
                        parent_x,
                        parent_y,
                        is_gzip,
                    )

            except Exception as e:
                logger.warning("PMTiles read error for %s: %s", pmtiles_path, e)
                return None

        # Run blocking file I/O in thread pool
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pmtiles_executor, _read_tile)

        if result is None:
            return None

        # Check if overzoom is needed
        if isinstance(result, tuple) and len(result) == 6 and result[0] == "overzoom":
            _, parent_tile, parent_z, parent_x, parent_y, is_gzip = result

            # Run async overzoom (non-blocking)
            overzoomed = await self._overzoom_tile(
                parent_tile, parent_z, parent_x, parent_y, z, x, y, is_gzip
            )

            if overzoomed:
                # tippecanoe-overzoom outputs gzip-compressed tiles
                result = overzoomed, True
            else:
                result = b"", False

        tile_data, is_gzip = result

        # Merge anchor tile when labels are requested
        if label:
            tile_data, is_gzip = await self._merge_anchor_tile(
                pmtiles_path, z, x, y, tile_data, is_gzip
            )

        return tile_data, is_gzip

    async def _merge_anchor_tile(
        self,
        pmtiles_path: Path,
        z: int,
        x: int,
        y: int,
        tile_data: bytes,
        is_gzip: bool,
    ) -> tuple[bytes, bool]:
        """Merge anchor tile data into the main tile for polygon label support.

        Reads the anchor PMTiles file (label points from --convert-polygons-to-label-points)
        and concatenates the raw MVT bytes with the main tile. Only called when label=True.

        Args:
            pmtiles_path: Path to the main PMTiles file
            z, x, y: Tile coordinates
            tile_data: Main tile MVT data (possibly gzipped)
            is_gzip: Whether tile_data is gzip compressed

        Returns:
            Tuple of (merged_tile_data, is_gzip)
        """
        if not tile_data:
            return tile_data, is_gzip

        anchor_path = pmtiles_path.with_name(pmtiles_path.stem + "_anchor.pmtiles")
        if not anchor_path.exists():
            return tile_data, is_gzip

        anchor_result = await self._get_tile_from_pmtiles_path(anchor_path, z, x, y)
        if not anchor_result or not anchor_result[0]:
            return tile_data, is_gzip

        anchor_data, anchor_is_gzip = anchor_result

        # MVT concatenation requires raw protobuf bytes
        main_bytes = gzip.decompress(tile_data) if is_gzip else tile_data
        anchor_bytes = gzip.decompress(anchor_data) if anchor_is_gzip else anchor_data

        return main_bytes + anchor_bytes, False

    async def _overzoom_tile(
        self,
        parent_tile: bytes,
        parent_z: int,
        parent_x: int,
        parent_y: int,
        target_z: int,
        target_x: int,
        target_y: int,
        is_gzip: bool,
    ) -> Optional[bytes]:
        """Use tippecanoe-overzoom to generate a tile from its parent.

        This is an async method that doesn't block the event loop.

        Args:
            parent_tile: The parent tile data (MVT, possibly gzipped)
            parent_z, parent_x, parent_y: Parent tile coordinates
            target_z, target_x, target_y: Target tile coordinates
            is_gzip: Whether parent tile is gzip compressed

        Returns:
            Overzoomed tile data (gzip compressed) or None on error
        """
        try:
            # tippecanoe-overzoom expects uncompressed input
            if is_gzip:
                input_data = gzip.decompress(parent_tile)
            else:
                input_data = parent_tile

            with (
                tempfile.NamedTemporaryFile(suffix=".mvt", delete=True) as in_file,
                tempfile.NamedTemporaryFile(suffix=".mvt.gz", delete=True) as out_file,
            ):
                # Write input file
                in_file.write(input_data)
                in_file.flush()

                # Run tippecanoe-overzoom asynchronously (non-blocking)
                # Format: tippecanoe-overzoom -o out.mvt.gz in.mvt parent_z/x/y target_z/x/y
                process = await asyncio.create_subprocess_exec(
                    "tippecanoe-overzoom",
                    "-o",
                    out_file.name,
                    "-b",
                    "5",  # buffer size
                    "-d",
                    "12",  # detail
                    in_file.name,
                    f"{parent_z}/{parent_x}/{parent_y}",
                    f"{target_z}/{target_x}/{target_y}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

                try:
                    _, stderr = await asyncio.wait_for(
                        process.communicate(), timeout=10.0
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                    logger.warning(
                        "tippecanoe-overzoom timeout for %d/%d/%d",
                        target_z,
                        target_x,
                        target_y,
                    )
                    return None

                if process.returncode != 0:
                    error_msg = stderr.decode().strip() if stderr else "unknown error"
                    # Don't warn for expected "no features" case - this is normal
                    if "no features" not in error_msg.lower():
                        logger.debug(
                            "tippecanoe-overzoom %d/%d/%d -> %d/%d/%d: %s",
                            parent_z,
                            parent_x,
                            parent_y,
                            target_z,
                            target_x,
                            target_y,
                            error_msg or "empty output",
                        )
                    return None

                # Read the output tile
                out_file.seek(0)
                result = out_file.read()

                # tippecanoe-overzoom may produce empty output for tiles with no features
                if len(result) == 0:
                    return None

                return result

        except Exception as e:
            logger.warning("Overzoom error: %s", e)
            return None

    async def get_tile(
        self,
        layer_info: LayerInfo,
        z: int,
        x: int,
        y: int,
        properties: Optional[list[str]] = None,
        cql_filter: Optional[dict] = None,
        bbox: Optional[list[float]] = None,
        limit: Optional[int] = None,
        columns: Optional[list[dict]] = None,
        geometry_column: str = "geometry",
        geometry_type: Optional[str] = None,
        force_dynamic: bool = False,
        decoration: Optional[str] = None,  # NEW
    ) -> Optional[tuple[bytes, bool, str]]:
        """Generate MVT tile for a layer.

        Uses PMTiles for unfiltered requests, GeoParquet for filtered requests.

        Args:
            layer_info: Layer information from URL
            z, x, y: Tile coordinates
            properties: List of properties to include
            cql_filter: CQL2 filter dict with 'filter' and 'lang' keys
            bbox: Additional bbox filter
            limit: Maximum features
            columns: List of column dicts with 'name' and 'type' keys
            geometry_column: Name of the geometry column
            geometry_type: Geometry type (e.g., "polygon") for anchor generation

        Returns:
            Tuple of (MVT tile bytes, is_gzip_compressed, source) or None if empty
            source is 'pmtiles' or 'geoparquet'
        """
        # If CQL filter, bbox, force_dynamic, or decoration is set, use dynamic GeoParquet generation
        if cql_filter or bbox or force_dynamic or decoration:
            # Run in thread pool to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            tile_data = await loop.run_in_executor(
                _dynamic_tile_executor,
                lambda: self._generate_dynamic_tile(
                    layer_info=layer_info,
                    z=z,
                    x=x,
                    y=y,
                    properties=properties,
                    cql_filter=cql_filter,
                    bbox=bbox,
                    limit=limit,
                    columns=columns,
                    geometry_column=geometry_column,
                    geometry_type=geometry_type,
                    decoration=decoration,
                ),
            )
            if tile_data is None:
                return None
            return (
                tile_data,
                False,
                "geoparquet",
            )  # Dynamic tiles are not gzip compressed

        # Unfiltered request - try PMTiles first, fallback to GeoParquet
        if not self._pmtiles_exists(layer_info):
            logger.debug(
                "No PMTiles for %s, falling back to dynamic tiles",
                layer_info.table_name,
            )
            # Fallback to dynamic GeoParquet generation
            loop = asyncio.get_event_loop()
            tile_data = await loop.run_in_executor(
                _dynamic_tile_executor,
                lambda: self._generate_dynamic_tile(
                    layer_info=layer_info,
                    z=z,
                    x=x,
                    y=y,
                    properties=properties,
                    cql_filter=None,
                    bbox=None,
                    limit=limit,
                    columns=columns,
                    geometry_column=geometry_column,
                    geometry_type=geometry_type,
                ),
            )
            if tile_data is None:
                return None
            return tile_data, False, "geoparquet"

        result = await self._get_tile_from_pmtiles(layer_info, z, x, y)
        if result is not None:
            tile_data, is_gzip = result
            logger.debug(
                "Tile (PMTiles): %s z=%d/%d/%d",
                layer_info.table_name,
                z,
                x,
                y,
            )
            return tile_data, is_gzip, "pmtiles"

        # Tile not in PMTiles (outside zoom bounds)
        return None

    def _generate_dynamic_tile(
        self,
        layer_info: LayerInfo,
        z: int,
        x: int,
        y: int,
        properties: Optional[list[str]] = None,
        cql_filter: Optional[dict] = None,
        bbox: Optional[list[float]] = None,
        limit: Optional[int] = None,
        columns: Optional[list[dict]] = None,
        geometry_column: str = "geometry",
        geometry_type: Optional[str] = None,
        decoration: Optional[str] = None,  # NEW
    ) -> Optional[bytes]:
        """Generate MVT tile dynamically using DuckDB.

        For polygon layers, generates two MVT layers in the same tile:
        - 'default': the polygon geometry
        - 'default_anchor': point features from ST_PointOnSurface for label placement

        Args:
            layer_info: Layer information from URL
            z, x, y: Tile coordinates
            properties: List of properties to include
            cql_filter: CQL2 filter dict
            bbox: Additional bbox filter
            limit: Maximum features
            columns: List of column dicts
            geometry_column: Name of the geometry column
            geometry_type: Geometry type (e.g., "polygon") for anchor generation

        Returns:
            MVT tile bytes or None if empty
        """
        logger.debug(
            "Tile (GeoParquet): %s z=%d/%d/%d",
            layer_info.table_name,
            z,
            x,
            y,
        )
        limit = min(limit or self.max_features, self.max_features)
        table = layer_info.full_table_name

        geom_col = geometry_column
        columns = columns or []

        # Build column type mapping
        col_types = {col["name"]: col.get("type", "VARCHAR") for col in columns}
        column_names = [col["name"] for col in columns]

        # MVT supported types (can be passed directly)
        mvt_supported_types = {
            "varchar",
            "text",
            "string",
            "float",
            "double",
            "real",
            "integer",
            "int",
            "int4",
            "int8",
            "bigint",
            "smallint",
            "tinyint",
            "boolean",
            "bool",
        }

        # Types that need casting to BIGINT (unsigned integers)
        unsigned_int_types = {"ubigint", "uinteger", "uint64", "uint32", "uhugeint"}

        # Types that cannot be included in MVT at all (even with casting)
        mvt_excluded_type_prefixes = {"struct", "map", "list", "union"}

        def is_excluded_type(col_type: str) -> bool:
            """Check if type must be excluded from MVT entirely."""
            type_lower = col_type.lower()
            # Exclude array types (e.g., VARCHAR[], INTEGER[])
            if type_lower.endswith("[]"):
                return True
            return any(type_lower.startswith(t) for t in mvt_excluded_type_prefixes)

        def get_cast_type(col_type: str) -> str | None:
            """Get the target type for casting, or None if no cast needed."""
            type_lower = col_type.lower()
            # Check unsigned integers FIRST (before substring match)
            if type_lower in unsigned_int_types:
                return "BIGINT"
            # "interval" contains "int": without this it would pass as an integer
            if "interval" in type_lower:
                return "VARCHAR"
            # Check if it's a supported type (no cast needed)
            if any(t in type_lower for t in mvt_supported_types):
                return None
            # Cast everything else to VARCHAR
            return "VARCHAR"

        # Check if 'id' column exists in the data
        has_id_column = "id" in column_names

        # Build property selection - must be explicit columns (no * in subqueries)
        if properties:
            # Use specified properties, excluding geometry. A name the layer
            # does not have would break the whole tile query, so it is dropped
            # here; the route rejects it with a 400 before getting this far.
            prop_cols = [
                p for p in properties if p not in (geom_col,) and p in column_names
            ]
            # Always include id if it exists in the table (for feature identification)
            if has_id_column and "id" not in prop_cols:
                prop_cols.append("id")
        elif column_names:
            # Use all available columns except geometry
            prop_cols = [c for c in column_names if c not in (geom_col,)]
        else:
            # No properties available
            prop_cols = []

        # Filter out hidden fields (e.g., bbox columns) from client responses
        prop_cols = [c for c in prop_cols if c not in settings.HIDDEN_FIELDS]

        # Filter out columns with types that cannot be used in MVT at all
        prop_cols = [
            c for c in prop_cols if not is_excluded_type(col_types.get(c, "VARCHAR"))
        ]

        # Build select clause with casting for unsupported types
        select_parts = []
        for col in prop_cols:
            col_type = col_types.get(col, "VARCHAR")
            cast_type = get_cast_type(col_type)
            ident = _qi(col)
            if cast_type:
                select_parts.append(f"CAST({ident} AS {cast_type}) AS {ident}")
            else:
                select_parts.append(ident)
        select_props = ", ".join(select_parts) if select_parts else None

        # Build WHERE clause (additional filters beyond tile bounds)
        # Uses shared query builder for bbox and CQL filters
        filters = build_filters(
            bbox=bbox,
            cql_filter=cql_filter,
            geometry_column=geom_col,
            column_names=column_names,
            has_geometry=True,
        )
        extra_where_sql = filters.to_where_sql()
        params = filters.params

        # Build struct_pack arguments for ST_AsMVT
        # geometry is handled separately via ST_AsMVTGeom
        struct_fields = [
            f'geometry := ST_AsMVTGeom(ST_Transform(candidates."{geom_col}", '
            f"'EPSG:4326', 'EPSG:3857', always_xy := true), ST_Extent(bounds.bbox3857))"
        ]

        # Include rowid+1 as _rowid — promoted to MVT feature ID via ST_AsMVT's feature_id_name.
        # +1 because MVT feature ID 0 is treated as "unset" by MapLibre.
        struct_fields.append('"_rowid" := candidates.rowid + 1')

        # Include all property columns (including original 'id' if present)
        for col in prop_cols:
            struct_fields.append(f"{_qi(col)} := candidates.{_qi(col)}")
        struct_pack_args = ", ".join(struct_fields)

        # Build MVT query
        select_clause = f'"{geom_col}"'
        if select_props:
            select_clause += f", {select_props}"

        # Always include rowid in the candidates CTE
        select_clause += ", rowid"

        # Check if table has bbox column for fast row group pruning
        # Support both legacy scalar columns ($minx, etc.) and GeoParquet 1.1 struct bbox
        has_scalar_bbox = all(
            c in column_names for c in ["$minx", "$miny", "$maxx", "$maxy"]
        )
        has_struct_bbox = "bbox" in column_names
        has_bbox_columns = has_scalar_bbox or has_struct_bbox

        # Compute tile bounds unconditionally — cheap pure math needed by both
        # the fast-path bbox query and the arrow layer (if requested).
        tile_xmin, tile_ymin, tile_xmax, tile_ymax = tile_to_bbox_4326(z, x, y)
        tile_xmin_3857, tile_ymin_3857, tile_xmax_3857, tile_ymax_3857 = (
            tile_to_bbox_3857(z, x, y)
        )

        if has_bbox_columns:
            # Fast path: use bbox columns for row group pruning
            # This is 10-100x faster because parquet can skip entire row groups

            # Prefer scalar columns (legacy) over struct bbox (GeoParquet 1.1)
            if has_scalar_bbox:
                bbox_filter = f""""$minx" <= {tile_xmax}
                      AND "$maxx" >= {tile_xmin}
                      AND "$miny" <= {tile_ymax}
                      AND "$maxy" >= {tile_ymin}"""
            else:
                bbox_filter = f"""bbox.xmin <= {tile_xmax}
                      AND bbox.xmax >= {tile_xmin}
                      AND bbox.ymin <= {tile_ymax}
                      AND bbox.ymax >= {tile_ymin}"""

            # Use pre-computed literal bounds everywhere - no ST_TileEnvelope in main query
            # This eliminates redundant geometry computations
            # Note: Using LIMIT instead of ORDER BY random() - with Hilbert-ordered data,
            # this gives spatially coherent results and is much faster (no sort needed)
            query = f"""
                WITH bounds AS (
                    SELECT
                        ST_MakeEnvelope({tile_xmin_3857}, {tile_ymin_3857}, {tile_xmax_3857}, {tile_ymax_3857}) AS bbox3857,
                        ST_MakeEnvelope({tile_xmin}, {tile_ymin}, {tile_xmax}, {tile_ymax}) AS bbox4326
                ),
                candidates AS (
                    SELECT {select_clause}
                    FROM {table}, bounds
                    WHERE {bbox_filter}
                      AND ST_Intersects("{geom_col}", bounds.bbox4326){extra_where_sql}
                    LIMIT {limit}
                )
                SELECT ST_AsMVT(
                    struct_pack({struct_pack_args}),
                    'default',
                    4096,
                    'geometry',
                    '_rowid'
                )
                FROM candidates, bounds
            """
        else:
            # Fallback: no bbox columns, use ST_Intersects only
            query = f"""
                WITH bounds AS (
                    SELECT
                        ST_TileEnvelope({z}, {x}, {y}) AS bbox3857,
                        ST_Transform(ST_TileEnvelope({z}, {x}, {y}), 'EPSG:3857', 'EPSG:4326', always_xy := true) AS bbox4326
                ),
                candidates AS (
                    SELECT {select_clause}
                    FROM {table}, bounds
                    WHERE ST_Intersects("{geom_col}", bounds.bbox4326){extra_where_sql}
                    LIMIT {limit}
                )
                SELECT ST_AsMVT(
                    struct_pack({struct_pack_args}),
                    'default',
                    4096,
                    'geometry',
                    '_rowid'
                )
                FROM candidates, bounds
            """

        # Determine if we need to generate label anchor points for polygon layers
        is_polygon_layer = geometry_type and "polygon" in geometry_type.lower()

        try:
            # Use pool's execute_with_retry for automatic connection handling
            # Apply query timeout to prevent blocking other requests
            result = ducklake_pool.execute_with_retry(
                query,
                params=params if params else None,
                max_retries=3,
                fetch_all=False,
                timeout=settings.QUERY_TIMEOUT,
            )

            if not result or not result[0]:
                return None

            tile_data = bytes(result[0])

            # For polygon layers, generate and append a label anchor layer
            # using ST_PointOnSurface for optimal label placement
            if is_polygon_layer:
                anchor_data = self._generate_anchor_layer(
                    query=query,
                    struct_pack_args=struct_pack_args,
                    geom_col=geom_col,
                    params=params,
                )
                if anchor_data:
                    # MVT is protobuf — multiple layers can be concatenated
                    tile_data = tile_data + anchor_data

            # For line layers requesting decoration placement, generate and append
            # a per-line decoration points layer. The source geometry is read
            # pre-tile-clipping, so endpoints are real endpoints (sidesteps
            # MapLibre's tile-boundary placement issues for non-repeat modes).
            if decoration and geometry_type and "line" in geometry_type.lower():
                decoration_data = self._generate_decoration_layer(
                    table=table,
                    geom_col=geom_col,
                    decoration=decoration,
                    bbox_3857=(
                        tile_xmin_3857,
                        tile_ymin_3857,
                        tile_xmax_3857,
                        tile_ymax_3857,
                    ),
                    bbox_4326=(tile_xmin, tile_ymin, tile_xmax, tile_ymax),
                    extra_where_sql=extra_where_sql,
                    params=params,
                )
                if decoration_data:
                    tile_data = tile_data + decoration_data

            return tile_data
        except TimeoutError:
            logger.warning("Tile query timeout: z=%d, x=%d, y=%d", z, x, y)
            raise
        except Exception as e:
            logger.error("Tile generation error: %s", e)
            raise

    def _generate_decoration_layer(
        self,
        table: str,
        geom_col: str,
        decoration: str,
        bbox_3857: tuple[float, float, float, float],
        bbox_4326: tuple[float, float, float, float],
        extra_where_sql: str = "",
        params: list | None = None,
    ) -> Optional[bytes]:
        """Generate an MVT layer of decoration placement points + bearings for a line layer.

        Emits one or two point features per line that intersects the tile bbox,
        depending on `decoration`. Each feature has a `bearing` property in degrees
        clockwise from north (0..360), computed from the relevant segment of the
        full source geometry (read pre-tile-clipping, so endpoints are real
        endpoints rather than tile-boundary intersections).

        Args:
            table: Fully qualified table name
            geom_col: Geometry column name
            decoration: One of "start" | "end" | "start_and_end" | "center"
            bbox_3857: (xmin, ymin, xmax, ymax) tile bounds in EPSG:3857
            bbox_4326: (xmin, ymin, xmax, ymax) tile bounds in EPSG:4326
            extra_where_sql: Optional additional WHERE clause text (e.g. CQL/bbox filters)
            params: Query parameters bound by `extra_where_sql`

        Returns:
            MVT bytes for the 'default_decoration' layer, or None if empty
        """
        tile_xmin_3857, tile_ymin_3857, tile_xmax_3857, tile_ymax_3857 = bbox_3857
        tile_xmin, tile_ymin, tile_xmax, tile_ymax = bbox_4326

        if decoration == "start":
            placement_cte = f"""
                SELECT
                    ST_StartPoint("{geom_col}") AS geom,
                    DEGREES(ST_Azimuth(ST_StartPoint("{geom_col}"), ST_PointN("{geom_col}", 2))) AS bearing,
                    rowid
                FROM candidates
                WHERE ST_NumPoints("{geom_col}") >= 2
            """
        elif decoration == "end":
            placement_cte = f"""
                SELECT
                    ST_EndPoint("{geom_col}") AS geom,
                    DEGREES(ST_Azimuth(ST_PointN("{geom_col}", CAST(ST_NumPoints("{geom_col}") - 1 AS INTEGER)), ST_EndPoint("{geom_col}"))) AS bearing,
                    rowid
                FROM candidates
                WHERE ST_NumPoints("{geom_col}") >= 2
            """
        elif decoration == "start_and_end":
            placement_cte = f"""
                SELECT
                    ST_StartPoint("{geom_col}") AS geom,
                    DEGREES(ST_Azimuth(ST_StartPoint("{geom_col}"), ST_PointN("{geom_col}", 2))) AS bearing,
                    rowid
                FROM candidates
                WHERE ST_NumPoints("{geom_col}") >= 2
                UNION ALL
                SELECT
                    ST_EndPoint("{geom_col}") AS geom,
                    DEGREES(ST_Azimuth(ST_PointN("{geom_col}", CAST(ST_NumPoints("{geom_col}") - 1 AS INTEGER)), ST_EndPoint("{geom_col}"))) AS bearing,
                    rowid
                FROM candidates
                WHERE ST_NumPoints("{geom_col}") >= 2
            """
        elif decoration == "center":
            placement_cte = f"""
                SELECT
                    ST_LineInterpolatePoint("{geom_col}", 0.5) AS geom,
                    DEGREES(ST_Azimuth(
                        ST_LineInterpolatePoint("{geom_col}", 0.49),
                        ST_LineInterpolatePoint("{geom_col}", 0.51)
                    )) AS bearing,
                    rowid
                FROM candidates
                WHERE ST_NumPoints("{geom_col}") >= 2
            """
        else:
            return None

        placement_query = f"""
            WITH bounds AS (
                SELECT
                    ST_MakeEnvelope({tile_xmin_3857}, {tile_ymin_3857}, {tile_xmax_3857}, {tile_ymax_3857}) AS bbox3857,
                    ST_MakeEnvelope({tile_xmin}, {tile_ymin}, {tile_xmax}, {tile_ymax}) AS bbox4326
            ),
            candidates AS (
                SELECT "{geom_col}", rowid
                FROM {table}, bounds
                WHERE ST_Intersects("{geom_col}", bounds.bbox4326){extra_where_sql}
            ),
            placement_pts AS (
                {placement_cte}
            )
            SELECT ST_AsMVT(
                struct_pack(
                    geometry := ST_AsMVTGeom(
                        ST_Transform(placement_pts.geom, 'EPSG:4326', 'EPSG:3857', always_xy := true),
                        ST_Extent(bounds.bbox3857)
                    ),
                    "_rowid" := placement_pts.rowid + 1,
                    "bearing" := COALESCE(((placement_pts.bearing % 360) + 360) % 360, 0)
                ),
                'default_decoration',
                4096,
                'geometry',
                '_rowid'
            )
            FROM placement_pts, bounds
        """

        try:
            result = ducklake_pool.execute_with_retry(
                placement_query,
                params=params if params else None,
                max_retries=1,
                fetch_all=False,
                timeout=settings.QUERY_TIMEOUT,
            )
            if result and result[0]:
                return bytes(result[0])
        except Exception as e:
            logger.warning("Decoration layer generation failed: %s", e)
        return None

    def _generate_anchor_layer(
        self,
        query: str,
        struct_pack_args: str,
        geom_col: str,
        params: list | None = None,
    ) -> Optional[bytes]:
        """Generate a label anchor MVT layer for polygon features.

        Creates point features using ST_PointOnSurface for optimal label
        placement inside polygons. The result is a separate MVT layer named
        'default_anchor' that can be concatenated with the main tile.

        Args:
            query: The original tile query (reused for the candidates CTE)
            struct_pack_args: Original struct_pack arguments
            geom_col: Geometry column name
            params: Query parameters

        Returns:
            MVT bytes for the anchor layer, or None if empty
        """
        # Build anchor struct_pack by wrapping the transformed geometry with
        # ST_PointOnSurface. The original geometry field looks like:
        #   geometry := ST_AsMVTGeom(ST_Transform(...), ST_Extent(bounds.bbox3857))
        # We need:
        #   geometry := ST_AsMVTGeom(
        #     ST_PointOnSurface(ST_Transform(...)),
        #     ST_Extent(bounds.bbox3857)
        #   )
        original_geom_expr = f'ST_AsMVTGeom(ST_Transform(candidates."{geom_col}"'
        anchor_geom_expr = (
            f'ST_AsMVTGeom(ST_PointOnSurface(ST_Transform(candidates."{geom_col}"'
        )
        # The closing parens: original has ...always_xy := true), ST_Extent(bounds.bbox3857))
        # We need an extra ) to close ST_PointOnSurface before the comma
        original_close = "always_xy := true), ST_Extent"
        anchor_close = "always_xy := true)), ST_Extent"

        anchor_struct = struct_pack_args.replace(
            original_geom_expr, anchor_geom_expr
        ).replace(original_close, anchor_close)
        anchor_query = query.replace(
            f"struct_pack({struct_pack_args})",
            f"struct_pack({anchor_struct})",
        ).replace(
            "'default',\n                    4096,\n                    'geometry',\n                    '_rowid'",
            "'default_anchor',\n                    4096,\n                    'geometry',\n                    '_rowid'",
        )

        try:
            result = ducklake_pool.execute_with_retry(
                anchor_query,
                params=params if params else None,
                max_retries=1,
                fetch_all=False,
                timeout=settings.QUERY_TIMEOUT,
            )
            if result and result[0]:
                return bytes(result[0])
        except Exception as e:
            logger.warning("Anchor layer generation failed: %s", e)
        return None


# Singleton instance
tile_service = TileService()
