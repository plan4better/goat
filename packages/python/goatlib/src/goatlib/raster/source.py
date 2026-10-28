"""Reading raster files: a COG at an http(s) address, through rio-tiler.

Only addresses that pass the URL guard open: http and https, hosts that resolve
to public addresses or are listed by the deployment, and redirects are followed
here hop by hop with the same check before GDAL sees the final address. GDAL's
own HTTP settings keep a slow or broken file from holding a worker.
Accepted residuals, as for every server-side fetch (`url_guard`): GDAL resolves
the name again when it connects and would follow a redirect the server sends
only to it.
"""

import threading
import time
from collections.abc import Collection, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from types import TracebackType
from typing import Any
from urllib.parse import urljoin

import numpy as np
import rasterio
import requests
from morecantile import Tile
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds
from rasterio.windows import Window
from rio_tiler.errors import RioTilerError, TileOutsideBounds
from rio_tiler.io import Reader

from goatlib.io.remote_source.url_guard import assert_public_http_url
from goatlib.raster.color import Coloring, bands_needed, colorize
from goatlib.raster.formula import Formula

TILE_SIZE = 256
MAX_REDIRECTS = 3
#: Statistics and samples read an overview at most this wide.
SAMPLE_SIZE = 1024
#: Whole-number bands with at most this many distinct values list them.
MAX_VALUES = 1024
HISTOGRAM_BINS = 20
#: A read may decimate the file's coarsest overview at most this much more: a
#: file without overviews is not downloaded whole for a low zoom.
MAX_EXTRA_DECIMATION = 8
#: How long a checked address (after its redirects) is reused.
ADDRESS_TTL_S = 600

#: A file that does not answer fails within seconds: no retries, and a transfer
#: that stalls is cut after five seconds without a byte.
GDAL_OPTIONS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff,.TIF,.TIFF",
    "VSI_CACHE": "TRUE",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_CONNECTTIMEOUT": "3",
    "GDAL_HTTP_TIMEOUT": "5",
    "GDAL_HTTP_LOW_SPEED_TIME": "5",
    "GDAL_HTTP_LOW_SPEED_LIMIT": "1",
    "GDAL_HTTP_MAX_RETRY": "0",
}
#: How long a file that could not be read answers at once with the same error,
#: so a slow or broken host does not hold a thread for every tile.
FAILURE_TTL_S = 30


class RasterUnavailableError(RuntimeError):
    """The file could not be read: unreachable, too slow, or not a raster."""


class BandError(ValueError):
    """The coloring reads a band the file does not have."""


_failures: dict[str, tuple[str, float]] = {}
_failures_lock = threading.Lock()


def _remember_failure(url: str, message: str) -> None:
    with _failures_lock:
        _failures[url] = (message, time.monotonic() + FAILURE_TTL_S)


def _recent_failure(url: str) -> str | None:
    """The error the file gave in the last 30 seconds, if any."""
    with _failures_lock:
        kept = _failures.get(url)
        if kept is None:
            return None
        if kept[1] <= time.monotonic():
            del _failures[url]
            return None
        return kept[0]


_addresses: dict[tuple[str, tuple[str, ...]], tuple[str, float]] = {}
_addresses_lock = threading.Lock()


def resolve_address(url: str, private_hosts: Collection[str] = ()) -> str:
    """The address GDAL may open: `url` after its redirects, every hop checked by
    the URL guard (raises `UnsafeUrlError`), kept for ten minutes. Raises
    RasterUnavailableError when the host does not answer."""
    key = (url, tuple(sorted(private_hosts)))
    with _addresses_lock:
        kept = _addresses.get(key)
    if kept is not None and kept[1] > time.monotonic():
        return kept[0]
    address = _follow(url, private_hosts)
    with _addresses_lock:
        _addresses[key] = (address, time.monotonic() + ADDRESS_TTL_S)
    return address


def _follow(url: str, private_hosts: Collection[str]) -> str:
    current = url.strip()
    for _ in range(MAX_REDIRECTS + 1):
        assert_public_http_url(current, private_hosts)
        try:
            response = requests.head(current, allow_redirects=False, timeout=(3, 3))
        except requests.RequestException as error:
            raise RasterUnavailableError(
                f"The file could not be reached: {error}"
            ) from None
        location = response.headers.get("Location")
        if response.status_code not in (301, 302, 303, 307, 308) or not location:
            return current
        current = urljoin(current, location)
    raise RasterUnavailableError("The file's address redirects too often.")


@dataclass(frozen=True)
class RasterInfo:
    width: int
    height: int
    #: West, south, east, north in degrees.
    bounds: tuple[float, float, float, float]
    count: int
    dtype: str
    nodata: float | None
    bits: tuple[int, ...]
    color_table: dict[int, tuple[int, int, int, int]] | None
    scales: tuple[float, ...]
    offsets: tuple[float, ...]
    names: tuple[str, ...]

    @property
    def scaled(self) -> bool:
        return any(s != 1 for s in self.scales) or any(o != 0 for o in self.offsets)


@dataclass(frozen=True)
class BandStats:
    index: int
    min: float | None
    max: float | None
    mean: float | None
    std: float | None
    p2: float | None
    p98: float | None
    #: Counts and the bin edges (one more than the counts).
    histogram: tuple[list[int], list[float]]
    #: The distinct values of a whole-number band, when there are few.
    values: list[float] | None
    approximate: bool = True


@dataclass(frozen=True)
class PointValues:
    #: Every band's value, None where the point is no data or outside the file.
    values: list[float | None]
    #: The formula's value at the point, when one was given.
    formula: float | None = None


def _stats(index: int, values: np.ndarray, integer: bool) -> BandStats:
    if values.size == 0:
        return BandStats(index, None, None, None, None, None, None, ([], []), None)
    counts, edges = np.histogram(values, bins=HISTOGRAM_BINS)
    distinct = None
    if integer:
        unique = np.unique(values)
        if unique.size <= MAX_VALUES:
            distinct = [int(v) for v in unique]
    p2, p98 = np.percentile(values, [2, 98])
    return BandStats(
        index=index,
        min=float(values.min()),
        max=float(values.max()),
        mean=float(values.mean()),
        std=float(values.std()),
        p2=float(p2),
        p98=float(p98),
        histogram=([int(c) for c in counts], [float(e) for e in edges]),
        values=distinct,
    )


def encode_tile(rgba: np.ndarray) -> bytes:
    """RGBA bytes (H x W x 4) as a lossless WebP: the exact colors (Terrarium
    elevations stay exact) and transparency, at about a quarter of a PNG's size
    for continuous colors, encoded as fast."""
    from rio_tiler.utils import render

    return render(
        np.moveaxis(rgba[..., :3], -1, 0),
        mask=rgba[..., 3],
        img_format="WEBP",
        LOSSLESS=True,
    )


def _terrarium(elevation: np.ndarray) -> np.ndarray:
    """Elevations as Terrarium RGB (`(R * 256 + G + B / 256) - 32768`); no data
    is 0 m, since an elevation tile cannot be transparent."""
    v = np.clip(np.ma.filled(elevation.astype("float64"), 0.0) + 32768, 0, 65535.996)
    whole = np.floor(v)
    out = np.zeros(v.shape + (4,), dtype="uint8")
    out[..., 0] = (whole // 256).astype("uint8")
    out[..., 1] = (whole % 256).astype("uint8")
    out[..., 2] = np.floor((v - whole) * 256).astype("uint8")
    out[..., 3] = 255
    return out


class RasterSource:
    """One raster file, opened for the duration of a `with` block."""

    def __init__(self, url: str, private_hosts: Collection[str] = ()) -> None:
        self.url = url
        self.private_hosts = tuple(private_hosts)
        self._reader: Reader | None = None
        self._env: rasterio.Env | None = None
        self._info: RasterInfo | None = None

    def __enter__(self) -> "RasterSource":
        failed = _recent_failure(self.url)
        if failed is not None:
            raise RasterUnavailableError(failed)
        try:
            address = resolve_address(self.url, self.private_hosts)
        except RasterUnavailableError as error:
            _remember_failure(self.url, str(error))
            raise
        self._env = rasterio.Env(**GDAL_OPTIONS)
        self._env.__enter__()
        try:
            self._reader = Reader(address)
        except (RasterioError, RioTilerError, OSError) as error:
            self._env.__exit__(None, None, None)
            message = f"The file could not be read: {error}"
            _remember_failure(self.url, message)
            raise RasterUnavailableError(message) from None
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._reader is not None:
            self._reader.close()
        if self._env is not None:
            self._env.__exit__(exc_type, exc, tb)

    @property
    def reader(self) -> Reader:
        if self._reader is None:
            raise RuntimeError("RasterSource is used outside its with block.")
        return self._reader

    @contextmanager
    def _reading(self) -> Iterator[None]:
        try:
            yield
        except TileOutsideBounds:
            raise
        except (RasterioError, RioTilerError, OSError) as error:
            message = f"The file could not be read: {error}"
            _remember_failure(self.url, message)
            raise RasterUnavailableError(message) from None

    def info(self) -> RasterInfo:
        if self._info is not None:
            return self._info
        ds = self.reader.dataset
        with self._reading():
            bits = []
            for i in range(1, ds.count + 1):
                nbits = ds.tags(i, ns="IMAGE_STRUCTURE").get("NBITS")
                dtype = np.dtype(ds.dtypes[i - 1])
                bits.append(int(nbits) if nbits else dtype.itemsize * 8)
            try:
                table = {
                    int(k): tuple(int(c) for c in v) for k, v in ds.colormap(1).items()
                }
            except ValueError:
                table = None
            west, south, east, north = self.reader.get_geographic_bounds(
                rasterio.crs.CRS.from_epsg(4326)
            )
        self._info = RasterInfo(
            width=ds.width,
            height=ds.height,
            bounds=(west, south, east, north),
            count=ds.count,
            dtype=ds.dtypes[0],
            nodata=ds.nodata,
            bits=tuple(bits),
            color_table=table or None,  # type: ignore[arg-type]
            scales=tuple(float(s) for s in ds.scales),
            offsets=tuple(float(o) for o in ds.offsets),
            names=tuple(d or f"Band {i}" for i, d in enumerate(ds.descriptions, 1)),
        )
        return self._info

    def _coarsest(self) -> float:
        """The decimation factor of the file's coarsest overview (1 without)."""
        return float(max(self.reader.dataset.overviews(1) or [1]))

    def _too_coarse(self, z: int, x: int, y: int) -> bool:
        """Whether the tile would read far more of the file than it shows."""
        ds = self.reader.dataset
        b = self.reader.tms.xy_bounds(Tile(x, y, z))
        west, south, east, north = transform_bounds(
            self.reader.tms.rasterio_crs, ds.crs, b.left, b.bottom, b.right, b.top
        )
        factor = min((east - west) / ds.res[0], (north - south) / ds.res[1]) / TILE_SIZE
        return factor > self._coarsest() * MAX_EXTRA_DECIMATION

    def _overview(self, indexes: Sequence[int] | None) -> Any:
        """The file at most 1024 px wide, from an overview; a file without one
        that would be read whole gives its center 1024 px instead."""
        info = self.info()
        factor = max(info.width, info.height) / SAMPLE_SIZE
        with self._reading():
            if factor <= self._coarsest() * MAX_EXTRA_DECIMATION:
                return self.reader.preview(
                    indexes=indexes, max_size=SAMPLE_SIZE, unscale=info.scaled
                )
            w, h = min(SAMPLE_SIZE, info.width), min(SAMPLE_SIZE, info.height)
            window = Window((info.width - w) // 2, (info.height - h) // 2, w, h)
            return self.reader.read(indexes=indexes, window=window, unscale=info.scaled)

    def _integer(self) -> bool:
        info = self.info()
        return np.issubdtype(np.dtype(info.dtype), np.integer) and not info.scaled

    def statistics(self) -> list[BandStats]:
        """Every band's statistics, from an overview at most 1024 px wide."""
        info = self.info()
        image = self._overview(None)
        out = []
        for k in range(info.count):
            band = image.array[k]
            values = np.ma.compressed(band).astype("float64")
            out.append(_stats(k + 1, values[np.isfinite(values)], self._integer()))
        return out

    def sample(self, formula: Formula) -> np.ndarray:
        """The formula's valid values over an overview at most 1024 px wide."""
        image = self._overview(formula.bands)
        arrays = {i: image.array[k] for k, i in enumerate(formula.bands)}
        invalid = np.zeros(image.array.shape[1:], dtype=bool)
        for a in arrays.values():
            invalid |= np.ma.getmaskarray(a)
        values = formula.evaluate({i: np.ma.getdata(a) for i, a in arrays.items()})
        return values[~invalid & np.isfinite(values)].astype("float64")

    def tile(
        self,
        z: int,
        x: int,
        y: int,
        coloring: Coloring,
        band_range: tuple[float, float] | None = None,
    ) -> bytes | None:
        """A 256 px tile colored by `coloring` (lossless WebP); None outside the file."""
        info = self.info()
        indexes = bands_needed(coloring, info.count)
        if max(indexes) > info.count:
            raise BandError(
                f"The raster has {info.count} band{'s' if info.count != 1 else ''}."
            )
        if not self.reader.tile_exists(x, y, z) or self._too_coarse(z, x, y):
            return None
        rgb = getattr(coloring, "kind", None) == "rgb"
        with self._reading():
            try:
                image = self.reader.tile(
                    x,
                    y,
                    z,
                    tilesize=TILE_SIZE,
                    indexes=indexes,
                    unscale=info.scaled and not rgb,
                )
            except TileOutsideBounds:
                return None
        bands = {i: image.array[k] for k, i in enumerate(indexes)}
        rgba = colorize(
            coloring,
            bands,
            file_no_data=None,
            bits=info.bits,
            color_table=info.color_table,
            band_range=band_range,
        )
        return encode_tile(rgba)

    def dem(self, z: int, x: int, y: int, band: int = 1) -> bytes | None:
        """The band as Terrarium elevation tiles for MapLibre's hillshade."""
        info = self.info()
        if not self.reader.tile_exists(x, y, z) or self._too_coarse(z, x, y):
            return None
        with self._reading():
            try:
                image = self.reader.tile(
                    x,
                    y,
                    z,
                    tilesize=TILE_SIZE,
                    indexes=(band,),
                    unscale=info.scaled,
                    resampling_method="bilinear",
                )
            except TileOutsideBounds:
                return None
        return encode_tile(_terrarium(image.array[0]))

    def point(
        self, lon: float, lat: float, formula: Formula | None = None
    ) -> PointValues:
        info = self.info()
        with self._reading():
            try:
                data = self.reader.point(lon, lat, unscale=info.scaled)
            except (TileOutsideBounds, RioTilerError):
                return PointValues([None] * info.count)
        values: list[float | None] = []
        raw = np.ma.getdata(data.array)
        for k in range(info.count):
            masked = bool(np.ma.getmaskarray(data.array)[k])
            # A float32 cell as its shortest decimal (0.1, not 0.10000000149).
            v = float(str(raw[k])) if raw.dtype == np.float32 else float(raw[k])
            values.append(None if masked or not np.isfinite(v) else v)
        if formula is None:
            return PointValues(values)
        if any(i > info.count or values[i - 1] is None for i in formula.bands):
            return PointValues(values, None)
        result = float(
            formula.evaluate(
                {i: np.array([values[i - 1]], dtype="float64") for i in formula.bands},
                dtype="float64",
            )[0]
        )
        return PointValues(values, result if np.isfinite(result) else None)
