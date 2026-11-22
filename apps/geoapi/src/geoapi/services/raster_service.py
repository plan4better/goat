"""Raster files (COGs) as geoapi serves them: value tiles, colored tiles,
statistics and point values, read with goatlib.raster.

The file's bounds (EPSG:4326, from its header) are what core stores as a COG
layer's extent when it creates the layer, and what the web asks for when a
layer has none. geoapi only reads the layer row: core owns it.

A layer's file is always the layer row's own `url` (a raster layer with
`data_type = 'cog'`), never an address from a request. A raster promoted from
the catalog is the exception: the catalog bucket is private, so it is read from
the file GOAT stores for the layer, named from the layer's id
(`stored_raster_file`); it has no `url`. Statistics are kept per file version
(the row's version and a remote file's validator) in process memory, every
band's class breaks too, kept apart: only the info reads them, and the route
computes them outside the layer's read slots (`band_samples`, `band_breaks`),
so a tile never waits for them. Tiles are not kept here (no Redis): the browser
caches them under ETags made of the row's version and what the tile shows (the
coloring token, or a value tile's band or formula and encoding), a tile whose
address names the current values version for good.

An alpha band (an orthophoto's transparency) is no band of values, as goatlib's
reader takes it: the info lists statistics and breaks for the other bands only,
while its `count` is the file's band count.
"""

import hashlib
import logging
import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Concatenate, Literal, ParamSpec
from uuid import UUID

import numpy as np
from cachetools import TTLCache
from goatlib.raster.color import Coloring, image_bands
from goatlib.raster.formula import Formula, parse_formula
from goatlib.raster.source import (
    FAILURE_TTL_S,
    TILE_SIZE,
    BandStats,
    PointValues,
    RasterInfo,
    RasterSource,
    RasterUnavailableError,
    TileSize,
    check_bands,
    logged,
    native_zoom,
    recent_failure,
    remember_failure,
    remote_validator,
)
from goatlib.raster.source import (
    failure_key as file_failure_key,
)
from goatlib.raster.stats import (
    classified_sample,
    precomputed_breaks,
)
from goatlib.raster.token import Classes, Rgb
from goatlib.raster.values import ENCODING_VERSION, ValueEncoding, value_encoding
from goatlib.utils.layer import stored_raster_file
from numpy.typing import NDArray

from geoapi.config import settings
from geoapi.services.layer_service import layer_service

logger = logging.getLogger(__name__)

#: How long a layer row (its address) and a file's statistics are reused.
ROW_TTL_S = 60
STATS_TTL_S = 3600
_MISSING = object()

#: Every band's class breaks by its index: method, class count, inner breaks.
BandBreaks = dict[int, dict[str, dict[str, list[float]]]]

#: How a value tile is read from cells that do not line up with its pixels.
Resampling = Literal["nearest", "bilinear"]
#: The arguments a tile read takes after the layer.
P = ParamSpec("P")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _microseconds(at: datetime | None) -> int:
    """An update time to the microsecond, so two writes within one second
    are two versions."""
    if at is None:
        return 0
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (at - _EPOCH) // timedelta(microseconds=1)


@dataclass(frozen=True)
class RasterLayer:
    id: str
    #: The address the user typed: opened only through the URL guard.
    external_url: str | None
    #: Changes when the row's address or update time changes.
    version: str
    #: The file GOAT stores for the layer (a catalog raster), read instead.
    stored_file: Path | None = None


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
        self._breaks: TTLCache[str, BandBreaks] = TTLCache(256, STATS_TTL_S)
        #: Breaks that could not all be computed, kept for goatlib's failure
        #: memo (30 s): the next info answers them as they are (none for a
        #: band that failed) instead of computing them again at once.
        self._breaks_failed: TTLCache[str, BandBreaks] = TTLCache(256, FAILURE_TTL_S)
        self._lock = threading.Lock()
        self._gates: dict[str, threading.Lock] = {}

    def clear(self) -> None:
        self._rows.clear()
        self._stats.clear()
        self._ranges.clear()
        self._bounds.clear()
        self._breaks.clear()
        self._breaks_failed.clear()

    async def layer(self, layer_id: str, fresh: bool = False) -> RasterLayer | None:
        """The raster file layer `layer_id` (32 hex digits), or None; kept for
        a minute, read again when `fresh`."""
        if not fresh and layer_id in self._rows:
            return self._rows[layer_id]
        row = await layer_service._execute_with_retry(
            "SELECT url, updated_at, "
            "catalog_external_uid IS NOT NULL AS catalog "
            "FROM customer.layer "
            "WHERE id = $1 AND type = 'raster' AND data_type = 'cog' "
            "AND (url IS NOT NULL OR catalog_external_uid IS NOT NULL)",
            UUID(layer_id),
            fetch_one=True,
        )
        found = None
        if row is not None:
            url = row["url"]
            digest = hashlib.sha256((url or "").encode()).hexdigest()[:12]
            stored = (
                stored_raster_file(layer_id, Path(settings.CATALOG_LAYERS_DIR))
                if row.get("catalog")
                else None
            )
            found = RasterLayer(
                layer_id, url, f"{digest}-{_microseconds(row['updated_at'])}", stored
            )
        self._rows[layer_id] = found
        return found

    def _source(
        self, layer: RasterLayer, remember_failures: bool = True
    ) -> RasterSource:
        return RasterSource(
            layer.external_url,
            settings.raster_private_hosts,
            stored_file=layer.stored_file,
            remember_failures=remember_failures,
        )

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

    def _file(self, layer: RasterLayer) -> str:
        """What the file's statistics are kept under: the layer and the values
        version, so a remote file replaced at the same address is read again
        once its validator changes."""
        return f"{layer.id}:{self.values_version(layer)}"

    def statistics(
        self,
        layer: RasterLayer,
        source: RasterSource | None = None,
        file: str | None = None,
    ) -> tuple[RasterInfo, list[BandStats]]:
        """The file's info and band statistics, read with `source` when one is
        open already, kept under `file` (`_file`) when it is looked up
        already."""

        def read() -> tuple[RasterInfo, list[BandStats]]:
            if source is not None:
                return source.info(), source.statistics()
            with self._source(layer) as opened:
                return opened.info(), opened.statistics()

        return self._once(self._stats, file or self._file(layer), read)

    def described(self, layer: RasterLayer) -> tuple[str, RasterInfo, list[BandStats]]:
        """What the info answers from the file, its values version looked up
        once: the key it is kept under (`_file`), which its class breaks are
        kept under too, the info and the band statistics."""
        file = self._file(layer)
        return (file, *self.statistics(layer, file=file))

    def kept_breaks(self, file: str) -> BandBreaks | None:
        """The class breaks of the file version `file` (`described`), or those
        of a computation that failed in the last 30 seconds; None when they
        are to be computed."""
        with self._lock:
            found: BandBreaks | None = self._breaks.get(file)
            if found is None:
                found = self._breaks_failed.get(file)
        return found

    def keep_breaks(self, file: str, breaks: BandBreaks, complete: bool) -> None:
        """Keep the breaks computed for `file`: for an hour, as the statistics,
        or for 30 seconds when some could not be computed."""
        with self._lock:
            (self._breaks if complete else self._breaks_failed)[file] = breaks

    def band_samples(self, layer: RasterLayer) -> dict[int, NDArray[np.float64]]:
        """What every band's class breaks are computed from: the values a style
        check classifies (`classified_sample`), from one read of the file,
        each band's drawn before the next band's values are read. A failed
        read raises without marking the file failing: the breaks are optional,
        the file's tiles do not fail for them."""
        with self._source(layer, remember_failures=False) as opened:
            return {
                band: classified_sample(values)
                for band, values in opened.band_samples()
            }

    def bounds(self, layer: RasterLayer) -> tuple[float, float, float, float]:
        """The file's west, south, east and north in degrees, from its header,
        once per layer version."""

        def read() -> tuple[float, float, float, float]:
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

        key = f"{self._file(layer)}:{formula.expression}"
        return self._once(self._ranges, key, read)

    def value_range(
        self, layer: RasterLayer, source: RasterSource, formula: Formula
    ) -> tuple[float, float] | None:
        """The band's minimum and maximum from its statistics, or the formula's
        from a sample of the file."""
        band = _single_band(formula)
        if band is None:
            return self._formula_range(layer, source, formula)
        _, stats = self.statistics(layer, source)
        found = next((b for b in stats if b.index == band), None)
        if found is None or found.min is None or found.max is None:
            return None
        return (found.min, found.max)

    def _band_range(
        self, layer: RasterLayer, source: RasterSource, coloring: Coloring
    ) -> tuple[float, float] | None:
        """What stands in for a missing domain (of a ramp, or of classes that
        hide the cells beyond them), and stretches a one-band image: the band's
        (or the formula's) minimum and maximum."""
        if isinstance(coloring, Rgb):
            info = source.info()
            # Only a one-band image without a color table is stretched, by the
            # band it draws (`bands_needed`): its first value band.
            held = info.value_bands
            if coloring.bands is not None or len(held) >= 3 or info.color_table:
                return None
            first = _FIRST_BAND if held[0] == 1 else parse_formula(f"b{held[0]}")
            return self.value_range(layer, source, first)
        if isinstance(coloring, Classes) and coloring.outside != "hide":
            return None
        if getattr(coloring, "domain", "given") is None:
            return self.value_range(layer, source, coloring.formula)
        return None

    def encoding(
        self, layer: RasterLayer, source: RasterSource, formula: Formula
    ) -> ValueEncoding:
        """How the formula's value tiles hold its values. Raises BandError for
        a band the file does not have, or that holds no values (an alpha
        band), as validation refuses it (`check_bands`)."""
        info = source.info()
        check_bands(info, formula.bands)
        return value_encoding(
            info.dtype,
            scaled=info.scaled,
            value_range=self.value_range(layer, source, formula),
            formula=_single_band(formula) is None,
        )

    def value_tileset(
        self, layer: RasterLayer, formula: Formula, tilesize: TileSize = TILE_SIZE
    ) -> tuple[
        ValueEncoding, int | None, tuple[float, float, float, float], tuple[str, ...]
    ]:
        """The formula's encoding, the file's extent (`_extent`) and its band
        names (from the header, as the info has them), for the value tiles'
        description."""
        with self._source(layer) as source:
            encoding = self.encoding(layer, source, formula)
            info = source.info()
            return (encoding, *_extent(info, tilesize), info.names)

    def image_tileset(
        self, layer: RasterLayer, tilesize: TileSize = TILE_SIZE
    ) -> tuple[int | None, tuple[float, float, float, float], RasterInfo]:
        """The file's extent (`_extent`) and its header's facts, for the
        colored tiles' description: no statistics."""
        with self._source(layer) as source:
            info = source.info()
            return (*_extent(info, tilesize), info)

    def values_version(self, layer: RasterLayer) -> str:
        """The version of the layer's value tiles: the row's, the remote file's
        validator (so a file replaced at the same address gets new tiles once
        goatlib checks the address again, every ten minutes) and the
        encoding's. A file that failed in goatlib's last 30 seconds raises
        RasterUnavailableError at once, and a host that does not answer is
        remembered as failing."""
        return self.values_state(layer)[0]

    def values_state(self, layer: RasterLayer) -> tuple[str, bool]:
        """`values_version`, and whether it follows the file: a file GOAT
        stores changes only with its row, a remote one only as far as its host
        gives a validator (ETag or Last-Modified)."""
        key = self.failure_key(layer)
        failed = recent_failure(key)
        if failed is not None:
            raise RasterUnavailableError(failed)
        version = layer.version
        follows = True
        if layer.stored_file is None and layer.external_url:
            try:
                validator = remote_validator(
                    layer.external_url, settings.raster_private_hosts
                )
            except RasterUnavailableError as error:
                remember_failure(key, str(error))
                raise
            follows = bool(validator)
            if validator:
                digest = hashlib.sha1(validator.encode()).hexdigest()[:8]
                version = f"{version}-{digest}"
        return f"{version}-{ENCODING_VERSION}", follows

    def tile(
        self,
        layer: RasterLayer,
        z: int,
        x: int,
        y: int,
        coloring: Coloring,
        tilesize: TileSize = TILE_SIZE,
    ) -> bytes | None:
        """A colored tile `tilesize` px wide read from the file."""
        with self._source(layer) as source:
            band_range = self._band_range(layer, source, coloring)
            return source.tile(z, x, y, coloring, band_range, tilesize=tilesize)

    def values(
        self,
        layer: RasterLayer,
        z: int,
        x: int,
        y: int,
        formula: Formula,
        encoding: ValueEncoding,
        resampling: Resampling,
        tilesize: TileSize = TILE_SIZE,
    ) -> bytes | None:
        """A value tile `tilesize` px wide of the formula in `encoding` (the
        one its address names, so the address alone fixes the tile) read from
        the file; None outside it. Raises BandError for a band the file does
        not have."""
        with self._source(layer) as source:
            return source.values(
                z, x, y, formula, encoding, resampling, tilesize=tilesize
            )

    def at_version(
        self,
        layer: RasterLayer,
        read: Callable[Concatenate[RasterLayer, P], bytes | None],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> tuple[str, bool, bytes | None]:
        """A tile read by `read(layer, *args, **kwargs)` (`tile` or `values`),
        with the values version it was read at and whether that follows the
        file (`values_state`): the routes let caches keep for good only a tile
        whose address names that version, of a file it follows."""
        version, follows = self.values_state(layer)
        return version, follows, read(layer, *args, **kwargs)

    def point(
        self, layer: RasterLayer, lon: float, lat: float, formula: Formula | None
    ) -> PointValues:
        with self._source(layer) as source:
            return source.point(lon, lat, formula)

    @staticmethod
    def tile_version(layer: RasterLayer, token: str) -> str:
        return f"r{layer.version}-{hashlib.sha1(token.encode()).hexdigest()[:16]}"

    @staticmethod
    def failure_key(layer: RasterLayer) -> str:
        """What goatlib remembers the layer's file failing under."""
        return file_failure_key(layer.external_url, layer.stored_file)


def _extent(
    info: RasterInfo, tilesize: TileSize
) -> tuple[int | None, tuple[float, float, float, float]]:
    """The file's deepest useful zoom for tiles of `tilesize` and its bounds in
    degrees: what a map needs to ask only for the tiles that show the file."""
    return native_zoom(info, tilesize), info.bounds


def _single_band(formula: Formula) -> int | None:
    """The band a formula only names (`b2`), else None."""
    if len(formula.bands) == 1 and formula.expression.strip() == f"b{formula.bands[0]}":
        return formula.bands[0]
    return None


_FIRST_BAND = parse_formula("b1")


def valid_bounds(bounds: tuple[float, ...]) -> bool:
    """A box on earth: finite degrees, west below east, south below north."""
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        return False
    west, south, east, north = bounds
    return -180 <= west < east <= 180 and -90 <= south < north <= 90


def band_breaks(
    layer: RasterLayer, samples: dict[int, NDArray[np.float64]]
) -> tuple[BandBreaks, bool]:
    """Every band's class breaks from its sample (`band_samples`,
    `precomputed_breaks`), and whether all could be computed: a band whose
    computation fails gets none, logged without the file's key."""
    out: BandBreaks = {}
    complete = True
    for band, values in samples.items():
        try:
            out[band] = precomputed_breaks(values)
        except Exception as error:
            complete = False
            out[band] = {}
            address, text = logged(RasterService.failure_key(layer), error)
            logger.warning(
                "The class breaks of band %d of the raster file %s could not be "
                "computed: %s: %s",
                band,
                address,
                type(error).__name__,
                text,
            )
    return out, complete


#: The most entries a color table is sent with: an 8 bit band's codes.
MAX_PALETTE = 256


def palette(info: RasterInfo) -> dict[str, Any] | None:
    """What an image drawn with the file's color table (goatlib `_image`)
    shows, from the header: the band the table colors (`image_bands`) and every
    entry's color (RGBA; goatlib draws an entry without alpha opaque, a value
    the table does not list transparent). A map draws such an image from that
    band's value tiles in these colors, so it holds every cell's code, also
    where entries share a color (spec 9.1, 9.7). None without a color table,
    for stored values that are scaled (no codes of the table), and for a table
    longer than an 8 bit band's."""
    table = info.color_table
    if not table or len(table) > MAX_PALETTE or info.scaled or not info.value_bands:
        return None
    image = Rgb(v=1, noData=[], kind="rgb")
    band = image_bands(image, info.value_bands, info.color_interp)[0]
    colors = {
        str(code): list((tuple(color) + (255,) * 4)[:4])
        for code, color in table.items()
    }
    return {"band": band, "colors": colors}


def info_json(
    info: RasterInfo, stats: list[BandStats], breaks: BandBreaks
) -> dict[str, Any]:
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
        # Which bands the file marks red, green, blue, alpha or palette (GDAL's
        # names): an image draws the bands marked red, green and blue.
        "color_interp": list(info.color_interp),
        "palette": palette(info),
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
                "counts": b.counts,
                "approximate": b.approximate,
                "breaks": breaks.get(b.index, {}),
            }
            for b in stats
        ],
    }


raster_service = RasterService()
