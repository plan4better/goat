"""Raster files (COGs) as geoapi serves them: colored tiles, elevation tiles,
statistics and point values, read with goatlib.raster.

The file's bounds (EPSG:4326, from its header) are what core stores as a COG
layer's extent when it creates the layer, and what the web asks for when a
layer has none. geoapi only reads the layer row: core owns it.

A layer's file is always the layer row's own `url` (a raster layer with
`data_type = 'cog'`), never an address from a request. Statistics are kept per
layer version in process memory; tiles go to the Redis tile cache under a
version made of the row's version and the coloring token.
"""

import hashlib
import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import numpy as np
from cachetools import TTLCache
from goatlib.raster.color import Coloring
from goatlib.raster.formula import Formula
from goatlib.raster.source import BandStats, PointValues, RasterInfo, RasterSource
from goatlib.raster.token import Rgb

from geoapi.config import settings
from geoapi.services.layer_service import layer_service
from geoapi.tile_cache import cache_tile, get_cached_tile

#: How long a layer row (its address) and a file's statistics are reused.
ROW_TTL_S = 60
STATS_TTL_S = 3600
_MISSING = object()


@dataclass(frozen=True)
class RasterLayer:
    id: str
    url: str
    #: Changes when the row's address or update time changes.
    version: str


class RasterService:
    def __init__(self) -> None:
        self._rows: TTLCache[str, RasterLayer | None] = TTLCache(1024, ROW_TTL_S)
        self._stats: TTLCache[str, tuple[RasterInfo, list[BandStats]]] = TTLCache(
            256, STATS_TTL_S
        )
        self._ranges: TTLCache[str, tuple[float, float] | None] = TTLCache(
            1024, STATS_TTL_S
        )
        self._bounds: TTLCache[str, tuple[float, float, float, float]] = TTLCache(
            1024, STATS_TTL_S
        )
        self._lock = threading.Lock()
        self._gates: dict[str, threading.Lock] = {}

    def clear(self) -> None:
        self._rows.clear()
        self._stats.clear()
        self._ranges.clear()
        self._bounds.clear()

    async def layer(self, layer_id: str) -> RasterLayer | None:
        """The raster file layer `layer_id` (32 hex digits), or None."""
        if layer_id in self._rows:
            return self._rows[layer_id]
        row = await layer_service._execute_with_retry(
            "SELECT url, extract(epoch FROM updated_at)::bigint AS updated "
            "FROM customer.layer "
            "WHERE id = $1 AND type = 'raster' AND data_type = 'cog' AND url IS NOT NULL",
            UUID(layer_id),
            fetch_one=True,
        )
        found = None
        if row is not None:
            digest = hashlib.sha256(row["url"].encode()).hexdigest()[:12]
            found = RasterLayer(layer_id, row["url"], f"{digest}-{row['updated'] or 0}")
        self._rows[layer_id] = found
        return found

    def _source(self, layer: RasterLayer) -> RasterSource:
        return RasterSource(layer.url, settings.raster_private_hosts)

    def _once(self, cache: TTLCache, key: str, compute: Callable[[], Any]) -> Any:
        """`cache[key]`, computed by one thread while the others wait for it: the
        reads run on many threads, and a cold layer is read once, not per tile."""
        with self._lock:
            found = cache.get(key, _MISSING)
            if found is not _MISSING:
                return found
            gate = self._gates.setdefault(key, threading.Lock())
        with gate:
            with self._lock:
                found = cache.get(key, _MISSING)
            if found is not _MISSING:
                return found
            value = compute()
            with self._lock:
                cache[key] = value
                self._gates.pop(key, None)
            return value

    def statistics(
        self, layer: RasterLayer, source: RasterSource | None = None
    ) -> tuple[RasterInfo, list[BandStats]]:
        """The file's info and band statistics, read with `source` when one is
        open already."""

        def read() -> tuple[RasterInfo, list[BandStats]]:
            if source is not None:
                return source.info(), source.statistics()
            with self._source(layer) as opened:
                return opened.info(), opened.statistics()

        return self._once(self._stats, f"{layer.id}:{layer.version}", read)

    def bounds(self, layer: RasterLayer) -> tuple[float, float, float, float]:
        """The file's west, south, east and north in degrees, from its header
        (or the info read already)."""

        def read() -> tuple[float, float, float, float]:
            stats = self._stats.get(f"{layer.id}:{layer.version}")
            if stats is not None:
                return stats[0].bounds
            with self._source(layer) as opened:
                return opened.info().bounds

        return self._once(self._bounds, f"{layer.id}:{layer.version}", read)

    def _formula_range(
        self, layer: RasterLayer, source: RasterSource, formula: Formula
    ) -> tuple[float, float] | None:
        def read() -> tuple[float, float] | None:
            values = source.sample(formula)
            if not values.size:
                return None
            return float(np.min(values)), float(np.max(values))

        key = f"{layer.id}:{layer.version}:{formula.expression}"
        return self._once(self._ranges, key, read)

    def _band_range(
        self, layer: RasterLayer, source: RasterSource, coloring: Coloring
    ) -> tuple[float, float] | None:
        """What stands in for a missing domain, and stretches a one-band image:
        the band's (or the formula's) minimum and maximum."""
        if isinstance(coloring, Rgb):
            info = source.info()
            # Only a one-band image without a color table is stretched.
            if coloring.bands is not None or info.count >= 3 or info.color_table:
                return None
            band: int | None = 1
        elif getattr(coloring, "domain", "given") is None:
            formula = coloring.formula
            if (
                len(formula.bands) != 1
                or formula.expression.strip() != f"b{formula.bands[0]}"
            ):
                return self._formula_range(layer, source, formula)
            band = formula.bands[0]
        else:
            return None
        _, stats = self.statistics(layer, source)
        found = next((b for b in stats if b.index == band), None)
        if found is None or found.min is None or found.max is None:
            return None
        return (found.min, found.max)

    def cached(
        self, layer: RasterLayer, z: int, x: int, y: int, token: str
    ) -> bytes | None:
        """A tile already in the Redis cache (`token` "dem" for elevation)."""
        found = get_cached_tile(layer.id, z, x, y, self.tile_version(layer, token))
        return found[0] if found is not None else None

    def tile(
        self, layer: RasterLayer, z: int, x: int, y: int, coloring: Coloring, token: str
    ) -> bytes | None:
        """A colored tile read from the file, and kept in the cache."""
        with self._source(layer) as source:
            tile = source.tile(
                z, x, y, coloring, self._band_range(layer, source, coloring)
            )
        if tile:
            version = self.tile_version(layer, token)
            cache_tile(layer.id, z, x, y, tile, False, version=version)
        return tile

    def dem(self, layer: RasterLayer, z: int, x: int, y: int) -> bytes | None:
        """An elevation tile read from the file, and kept in the cache."""
        with self._source(layer) as source:
            tile = source.dem(z, x, y)
        if tile:
            version = self.tile_version(layer, "dem")
            cache_tile(layer.id, z, x, y, tile, False, version=version)
        return tile

    def point(
        self, layer: RasterLayer, lon: float, lat: float, formula: Formula | None
    ) -> PointValues:
        with self._source(layer) as source:
            return source.point(lon, lat, formula)

    @staticmethod
    def tile_version(layer: RasterLayer, token: str) -> str:
        return f"r{layer.version}-{hashlib.sha1(token.encode()).hexdigest()[:16]}"


def valid_bounds(bounds: tuple[float, ...]) -> bool:
    """A box on earth: finite degrees, west below east, south below north."""
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        return False
    west, south, east, north = bounds
    return -180 <= west < east <= 180 and -90 <= south < north <= 90


def info_json(info: RasterInfo, stats: list[BandStats]) -> dict[str, Any]:
    return {
        "width": info.width,
        "height": info.height,
        "bounds": list(info.bounds),
        "count": info.count,
        "dtype": info.dtype,
        "nodata": info.nodata,
        "bits": list(info.bits),
        "color_table": (
            {str(k): list(v) for k, v in info.color_table.items()}
            if info.color_table
            else None
        ),
        "names": list(info.names),
        "scales": list(info.scales),
        "offsets": list(info.offsets),
        "bands": [
            {
                "index": b.index,
                "min": b.min,
                "max": b.max,
                "mean": b.mean,
                "std": b.std,
                "p2": b.p2,
                "p98": b.p98,
                "histogram": {"counts": b.histogram[0], "edges": b.histogram[1]},
                "values": b.values,
                "approximate": b.approximate,
            }
            for b in stats
        ],
    }


raster_service = RasterService()
