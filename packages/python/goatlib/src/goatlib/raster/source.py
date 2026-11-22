"""Reading raster files through rio-tiler: a COG at an http(s) address, or
the file GOAT stores for a layer (`goatlib.utils.layer.stored_raster_file`).

Only addresses that pass the URL guard open: http and https, hosts that resolve
to public addresses or are listed by the deployment, and redirects are followed
here hop by hop with the same check before GDAL sees the final address. GDAL's
own HTTP settings keep a slow or broken file from holding a worker.
Accepted residuals, as for every server-side fetch (`url_guard`): GDAL resolves
the name again when it connects and would follow a redirect the server sends
only to it.
"""

import ctypes
import functools
import logging
import math
import re
import threading
import time
from collections.abc import Collection, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Any, Final, Literal
from urllib.parse import urljoin, urlsplit, urlunsplit

import numpy as np
import rasterio
import requests
from morecantile import Tile
from rasterio.errors import RasterioError
from rasterio.session import DummySession
from rasterio.warp import transform_bounds
from rasterio.windows import Window
from rio_tiler.errors import RioTilerError, TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.utils import non_alpha_indexes

from goatlib.io.remote_source.url_guard import assert_public_http_url
from goatlib.raster.color import Coloring, bands_needed, colorize
from goatlib.raster.formula import Formula
from goatlib.raster.values import ValueEncoding
from goatlib.utils.layer_address import text_without_keys, without_key

logger = logging.getLogger(__name__)

#: A tile's width and height in pixels unless another is asked for.
TILE_SIZE: Final = 256
#: The tile sizes there are: the web asks for 512 px tiles, a quarter as many
#: requests for the same view.
TileSize = Literal[256, 512]
MAX_REDIRECTS = 3
#: Statistics and samples read an overview at most this wide.
SAMPLE_SIZE = 1024
#: Whole-number bands with at most this many distinct values list them.
MAX_VALUES = 1024
#: A band's histogram, which a style panel draws its classes over.
HISTOGRAM_BINS = 50
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
#: libwebp's effort for a lossless tile (GDAL's QUALITY, default 75): the same
#: pixels, about the same size, in less time.
WEBP_EFFORT = 50
#: How long a file that could not be read answers at once with the same error,
#: so a slow or broken host does not hold a thread for every tile.
FAILURE_TTL_S = 30


class RasterUnavailableError(RuntimeError):
    """The file could not be read: unreachable, too slow, or not a raster. Its
    message is what whoever asked is told: what failed, in plain words, never
    the file's address (a signed link's query is an access key); the error
    goes to the log, without the address's query and credentials (`logged`)."""


class BandError(ValueError):
    """The coloring reads a band the file does not have."""


_failures: dict[str, tuple[str, float]] = {}
_failures_lock = threading.Lock()


def failure_key(url: str | None, stored_file: Path | None) -> str:
    """What a file's failure is remembered under: the file that is read."""
    return str(stored_file) if stored_file is not None else str(url)


class _WithoutKey(logging.Filter):
    """Rewrites a log record without the queries, fragments and credentials of
    the addresses it quotes; never drops one."""

    cleans_keys = True

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        cleaned = text_without_keys(message)
        if cleaned != message:
            record.msg, record.args = cleaned, ()
        # An attached exception is formatted from `exc_text` when it is set.
        if record.exc_info and not record.exc_text:
            trace = logging.Formatter().formatException(record.exc_info)
            record.exc_text = text_without_keys(trace)
        return True


#: The libraries that log the addresses this reader opens: rasterio quotes
#: GDAL's errors with the file's whole address at INFO, urllib3 the address
#: check's request at DEBUG.
_QUOTING_LIBRARIES = ("rasterio", "rio_tiler", "urllib3")


def _clean_library_logs() -> None:
    """Puts `_WithoutKey` on every logger of `_QUOTING_LIBRARIES` there is. A
    filter acts on its own logger's records only, not on its children's, so
    each one gets it; importing this module has created all of those the
    reader logs on. A logger created later (a rasterio module the reader never
    imports) is not covered."""
    names = {
        name
        # A copy: another thread may create a logger meanwhile.
        for name in list(logging.Logger.manager.loggerDict)
        if name.split(".")[0] in _QUOTING_LIBRARIES
    }
    for name in sorted(names | set(_QUOTING_LIBRARIES)):
        library = logging.getLogger(name)
        if not any(getattr(f, "cleans_keys", False) for f in library.filters):
            library.addFilter(_WithoutKey())


_clean_library_logs()


def logged(address: str, error: Exception) -> tuple[str, str]:
    """The file's address and the error as a log line gives them: the address
    as someone who cannot edit the layer gets it (scheme, host and path), and
    the error's text without the query, fragment and credentials of the
    addresses it quotes."""
    return without_key(address), text_without_keys(str(error))


def read_failure(error: Exception) -> str:
    """What a failed read of a file tells whoever asked: the host's HTTP status,
    a timeout, or that the file could not be read as a raster. GDAL's own text
    names the file's address, so it is never part of the message."""
    text = str(error)
    status = re.search(r"HTTP response code: (\d{3})", text)
    if status:
        return f"The file's host answered with HTTP {status.group(1)}."
    if re.search(r"timed out|too slow", text, re.IGNORECASE):
        return "The file's host did not answer in time."
    return "The file could not be read as a raster."


def remember_failure(key: str, message: str) -> None:
    """Opening the file of `key` (`failure_key`) fails with `message` for the
    next 30 seconds."""
    with _failures_lock:
        _failures[key] = (message, time.monotonic() + FAILURE_TTL_S)


def recent_failure(key: str) -> str | None:
    """The error the file of `key` (`failure_key`) gave in the last 30 seconds,
    if any."""
    with _failures_lock:
        kept = _failures.get(key)
        if kept is None:
            return None
        if kept[1] <= time.monotonic():
            del _failures[key]
            return None
        return kept[0]


#: A checked address, its file's validator and when both expire.
_addresses: dict[tuple[str, tuple[str, ...]], tuple[str, str | None, float]] = {}
_addresses_lock = threading.Lock()


def resolve_address(url: str, private_hosts: Collection[str] = ()) -> str:
    """The address GDAL may open: `url` after its redirects, every hop checked by
    the URL guard (raises `UnsafeUrlError`), kept for ten minutes. Raises
    RasterUnavailableError when the host does not answer."""
    return _resolved(url, private_hosts)[0]


def remote_validator(url: str, private_hosts: Collection[str] = ()) -> str | None:
    """The file's version as its host gives it: the final address's `ETag`, else
    its `Last-Modified`, None without either or when the HEAD fails. From the
    HEAD `resolve_address` sends and kept with its address for ten minutes;
    raises as it does."""
    return _resolved(url, private_hosts)[1]


def _resolved(url: str, private_hosts: Collection[str]) -> tuple[str, str | None]:
    """The checked address and validator, kept for ten minutes. GDAL keeps
    what it read of a remote file for the process, so when a check finds
    another validator, or none that could tell, those blocks are dropped: a
    replaced file is never read from its predecessor's."""
    key = (url, tuple(sorted(private_hosts)))
    with _addresses_lock:
        kept = _addresses.get(key)
    if kept is not None and kept[2] > time.monotonic():
        return kept[0], kept[1]
    address, validator = _follow(url, private_hosts)
    with _addresses_lock:
        _addresses[key] = (address, validator, time.monotonic() + ADDRESS_TTL_S)
    if kept is not None and (validator is None or kept[:2] != (address, validator)):
        for read in {kept[0], address}:
            forget_cached_reads(read)
    return address, validator


def _rasterio_libgdal() -> list[str]:
    """Where the GDAL rasterio runs on may be: the libgdal loaded in this
    process, else the one rasterio's wheel bundles."""
    import rasterio

    found: list[str] = []
    try:
        with open("/proc/self/maps") as maps:
            found += [line.split()[-1] for line in maps if "libgdal" in line]
    except OSError:
        pass
    base = Path(rasterio.__file__).parent
    found += [str(p) for p in sorted(base.parent.glob("rasterio.libs/libgdal*"))]
    found += [str(p) for p in sorted(base.glob(".dylibs/libgdal*"))]
    return list(dict.fromkeys(found))


@functools.cache
def _gdal() -> ctypes.CDLL | None:
    """rasterio's own GDAL, for a call rasterio does not wrap; None, said once
    per process, when it cannot be had. Never another libgdal: its cache is
    not the one rasterio reads through."""
    paths = _rasterio_libgdal()
    for path in paths:
        try:
            library = ctypes.CDLL(path)
        except OSError:
            continue
        if hasattr(library, "VSICurlPartialClearCache"):
            library.VSICurlPartialClearCache.argtypes = [ctypes.c_char_p]
            library.VSICurlPartialClearCache.restype = None
            return library
    reason = (
        "rasterio's libgdal has no VSICurlPartialClearCache"
        if paths
        else "no libgdal of rasterio's was found"
    )
    logger.warning(
        "GDAL's read cache of remote files cannot be cleared (%s): a file "
        "replaced at the same address may be read from its predecessor's blocks "
        "until the process restarts.",
        reason,
    )
    return None


def forget_cached_reads(address: str) -> None:
    """Drop what GDAL keeps of the remote file at `address` (its size, header
    and blocks), so the next read asks its host again."""
    gdal = _gdal()
    if gdal is not None:
        gdal.VSICurlPartialClearCache(_gdal_path(address).encode())


def _follow(url: str, private_hosts: Collection[str]) -> tuple[str, str | None]:
    """The final address and its HEAD's `ETag`, else `Last-Modified`; no
    validator from a HEAD that failed (a host may refuse HEAD and still send
    one)."""
    current = url.strip()
    for _ in range(MAX_REDIRECTS + 1):
        assert_public_http_url(current, private_hosts)
        try:
            response = requests.head(current, allow_redirects=False, timeout=(3, 3))
        except requests.RequestException as error:
            logger.warning(
                "The raster file at %s could not be reached: %s",
                *logged(current, error),
            )
            raise RasterUnavailableError(
                "The file's host did not answer in time."
                if isinstance(error, requests.Timeout)
                else "The file's host could not be reached."
            ) from None
        location = response.headers.get("Location")
        if response.status_code not in (301, 302, 303, 307, 308) or not location:
            if not 200 <= response.status_code < 300:
                return current, None
            headers = response.headers
            return current, headers.get("ETag") or headers.get("Last-Modified")
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
    #: The zoom whose 256 px tiles show the file's cells at their own size
    #: (rio-tiler's estimate): deeper tiles only magnify them.
    maxzoom: int | None = None
    #: The zoom whose 256 px tile the file's smallest possible overview fills
    #: (rio-tiler's estimate).
    minzoom: int | None = None
    #: The file's alpha bands (an orthophoto's transparency), by index: the
    #: other bands' mask, no bands of values (`value_bands`).
    alpha_bands: tuple[int, ...] = ()
    #: Each band's color interpretation as rasterio reads it ("red", "green",
    #: "blue", "alpha", "gray", "palette", "undefined", ...): an image draws the
    #: bands marked red, green and blue (`image_bands`).
    color_interp: tuple[str, ...] = ()

    @property
    def scaled(self) -> bool:
        return any(s != 1 for s in self.scales) or any(o != 0 for o in self.offsets)

    @property
    def value_bands(self) -> tuple[int, ...]:
        """The bands that hold values, by index: every band but an alpha band.
        The bands statistics, samples, tiles and validation take."""
        return tuple(i for i in range(1, self.count + 1) if i not in self.alpha_bands)


def check_bands(info: RasterInfo, bands: Sequence[int]) -> None:
    """Raises BandError for a band that is not one of the file's value bands
    (`RasterInfo.value_bands`), in the words validation uses."""
    held = info.value_bands
    if not set(bands) <= set(held):
        n = len(held)
        raise BandError(f"The raster has {n} band{'s' if n != 1 else ''}.")


def native_zoom(info: RasterInfo, tilesize: TileSize = TILE_SIZE) -> int | None:
    """The zoom whose tiles of `tilesize` show the file's cells at their own
    size: a 512 px tile shows them one zoom higher up than a 256 px one, never
    below the file's minzoom."""
    if info.maxzoom is None:
        return None
    zoom = info.maxzoom - int(math.log2(tilesize // TILE_SIZE))
    return zoom if info.minzoom is None else max(zoom, info.minzoom)


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
    #: How many cells of the overview hold each of `values`, in its order:
    #: they sum to the cells with a value, so each code's share follows.
    counts: list[int] | None = None


@dataclass(frozen=True)
class PointValues:
    #: Every band's value, None where the point is no data or outside the file.
    values: list[float | None]
    #: The formula's value at the point, when one was given.
    formula: float | None = None


def _histogram(values: np.ndarray) -> tuple[list[int], list[float]]:
    """The counts of `HISTOGRAM_BINS` bins over the values' range and the
    bins' edges. Values whose range floats cannot split into that many finite
    bins (one large value, neighbouring floats, or a span beyond the largest
    float) get one bin of them all, from the minimum to the maximum."""
    try:
        counts, edges = np.histogram(values, bins=HISTOGRAM_BINS)
    except ValueError:
        return [int(values.size)], [float(values.min()), float(values.max())]
    return [int(c) for c in counts], [float(e) for e in edges]


def _stats(index: int, values: np.ndarray, integer: bool) -> BandStats:
    if values.size == 0:
        return BandStats(index, None, None, None, None, None, None, ([], []), None)
    histogram = _histogram(values)
    distinct = cells = None
    if integer:
        unique, held = np.unique(values, return_counts=True)
        if unique.size <= MAX_VALUES:
            distinct = [int(v) for v in unique]
            cells = [int(n) for n in held]
    p2, p98 = np.percentile(values, [2, 98])
    return BandStats(
        index=index,
        min=float(values.min()),
        max=float(values.max()),
        mean=float(values.mean()),
        std=float(values.std()),
        p2=float(p2),
        p98=float(p98),
        histogram=histogram,
        values=distinct,
        counts=cells,
    )


def _value_bands(band_names: Sequence[str]) -> list[int]:
    """The indexes of the bands a read gave (rio-tiler names them `b1`, `b2`,
    ...): the file's bands but an alpha band. As the reader takes it, an alpha
    band is the other bands' transparency, not a band of values: it masks them
    and gets no statistics, sample or point value of its own, while the file's
    band count still includes it."""
    return [int(name.removeprefix("b")) for name in band_names]


def _needs_s3_session(address: str) -> bool:
    """Whether the file at `address` is read with rasterio's AWS session: only
    a path GDAL reads through S3 (`s3://`, `/vsis3/`). GDAL reads an http(s)
    address unsigned (`/vsicurl/`), a bucket's (amazonaws.com) included, where
    rasterio would still build the session."""
    return address.startswith(("s3://", "/vsis3/"))


def _gdal_path(address: str) -> str:
    """The name GDAL opens `address` by: an http(s) address (its scheme in any
    case) as `/vsicurl/` with its query and without its fragment, which is
    what rasterio passes for one anyway. Named so, rasterio's open does not
    take a bucket's address (amazonaws.com) for S3 and build an AWS session for
    it: without credentials in the environment botocore would look for them,
    the cloud's metadata service last, about two seconds per open."""
    parts = urlsplit(address)
    if parts.scheme not in ("http", "https"):
        return address
    return f"/vsicurl/{urlunsplit(parts._replace(fragment=''))}"


def gdal_env(address: str) -> rasterio.Env:
    """GDAL's settings for reading the file at `address`. With AWS credentials
    in the environment, rasterio builds a boto3 session for every `Env`; only
    an S3 address is read with one (`_needs_s3_session`), any other file opens
    without."""
    if not _needs_s3_session(address):
        return rasterio.Env(session=DummySession(), **GDAL_OPTIONS)
    return rasterio.Env(**GDAL_OPTIONS)


def encode_tile(rgba: np.ndarray) -> bytes:
    """RGBA bytes (H x W x 4) as a lossless WebP: the exact colors (value tiles
    stay exact) and transparency, at about a quarter of a PNG's size for
    continuous colors. For a lossless image GDAL's QUALITY is libwebp's effort,
    not a loss: `WEBP_EFFORT` packs about as small as the default 75 in less
    time, the pixels the same."""
    from rio_tiler.utils import render

    return render(
        np.moveaxis(rgba[..., :3], -1, 0),
        mask=rgba[..., 3],
        img_format="WEBP",
        LOSSLESS=True,
        QUALITY=WEBP_EFFORT,
    )


class RasterSource:
    """One raster file, opened for the duration of a `with` block.

    A layer's file is either the file GOAT stores for it (`stored_file`, from
    `goatlib.utils.layer.stored_raster_file`, named from the layer's id), which
    opens as it is, or the address the user typed (`url`), which opens only
    through the URL guard. A path typed as a `url` is therefore refused.

    A failed read marks the file failing for the next 30 seconds
    (`remember_failure`), unless `remember_failures` is off: a read others can
    do without (geoapi's class breaks) then never makes the file's tiles fail.
    """

    def __init__(
        self,
        url: str | None,
        private_hosts: Collection[str] = (),
        *,
        stored_file: Path | None = None,
        remember_failures: bool = True,
    ) -> None:
        if stored_file is None and url is None:
            raise ValueError("A raster source needs a stored file or a url")
        self.url = url
        self.private_hosts = tuple(private_hosts)
        self.stored_file = stored_file
        self.remember_failures = remember_failures
        #: What a failure is remembered under: the file that was read.
        self._key = failure_key(url, stored_file)
        self._reader: Reader | None = None
        self._env: rasterio.Env | None = None
        self._info: RasterInfo | None = None

    def __enter__(self) -> "RasterSource":
        failed = recent_failure(self._key)
        if failed is not None:
            raise RasterUnavailableError(failed)
        if self.stored_file is not None:
            address = str(self.stored_file)
        else:
            try:
                address = resolve_address(str(self.url), self.private_hosts)
            except RasterUnavailableError as error:
                if self.remember_failures:
                    remember_failure(self._key, str(error))
                raise
        self._env = gdal_env(address)
        self._env.__enter__()
        try:
            self._reader = Reader(_gdal_path(address))
        except (RasterioError, RioTilerError, OSError) as error:
            self._env.__exit__(None, None, None)
            raise self._failed(error) from None
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
            raise self._failed(error) from None

    def _failed(self, error: Exception) -> RasterUnavailableError:
        """The failure to raise for a read that failed with `error`, remembered
        for the next 30 seconds (`remember_failures`); the error itself is
        logged (`logged`)."""
        logger.warning(
            "The raster file %s could not be read: %s", *logged(self._key, error)
        )
        message = read_failure(error)
        if self.remember_failures:
            remember_failure(self._key, message)
        return RasterUnavailableError(message)

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
            # As rio-tiler reads the file: its alpha bands mask the others.
            alpha = sorted(set(ds.indexes) - set(non_alpha_indexes(ds)))
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
            maxzoom=int(self.reader.maxzoom),
            minzoom=int(self.reader.minzoom),
            alpha_bands=tuple(alpha),
            color_interp=tuple(c.name for c in ds.colorinterp),
        )
        return self._info

    def _coarsest(self) -> float:
        """The decimation factor of the file's coarsest overview (1 without)."""
        return float(max(self.reader.dataset.overviews(1) or [1]))

    def _too_coarse(self, z: int, x: int, y: int, tilesize: int) -> bool:
        """Whether the tile would read far more of the file than it shows."""
        ds = self.reader.dataset
        b = self.reader.tms.xy_bounds(Tile(x, y, z))
        west, south, east, north = transform_bounds(
            self.reader.tms.rasterio_crs, ds.crs, b.left, b.bottom, b.right, b.top
        )
        factor = min((east - west) / ds.res[0], (north - south) / ds.res[1]) / tilesize
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
        """Every value band's statistics, from an overview at most 1024 px
        wide (`_value_bands`: an alpha band has none)."""
        image = self._overview(None)
        out = []
        for k, index in enumerate(_value_bands(image.band_names)):
            values = np.ma.compressed(image.array[k]).astype("float64")
            out.append(_stats(index, values[np.isfinite(values)], self._integer()))
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
        tilesize: TileSize = TILE_SIZE,
    ) -> bytes | None:
        """A tile `tilesize` px wide colored by `coloring` (lossless WebP); None
        outside the file. A 512 px tile is the tile z/x/y, the same area at
        twice the resolution."""
        info = self.info()
        indexes = bands_needed(coloring, info.value_bands, info.color_interp)
        check_bands(info, indexes)
        rgb = getattr(coloring, "kind", None) == "rgb"
        with self._reading():
            if not self.reader.tile_exists(x, y, z) or self._too_coarse(
                z, x, y, tilesize
            ):
                return None
            try:
                image = self.reader.tile(
                    x,
                    y,
                    z,
                    tilesize=tilesize,
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
            color_interp=info.color_interp,
        )
        return encode_tile(rgba)

    def values(
        self,
        z: int,
        x: int,
        y: int,
        formula: Formula,
        encoding: ValueEncoding,
        resampling: Literal["nearest", "bilinear"] = "bilinear",
        tilesize: TileSize = TILE_SIZE,
    ) -> bytes | None:
        """A tile `tilesize` px wide of the formula's values in `encoding`
        (lossless WebP), as `tile` draws it; None outside the file. A cell
        where a band is no data or the formula has no value is no data.
        Evaluated in float64, so 32 bit whole numbers stay exact. `resampling`
        is the read's and the reprojection's: a file in another CRS than the
        tile's is smooth too."""
        info = self.info()
        check_bands(info, formula.bands)
        with self._reading():
            if not self.reader.tile_exists(x, y, z) or self._too_coarse(
                z, x, y, tilesize
            ):
                return None
            try:
                image = self.reader.tile(
                    x,
                    y,
                    z,
                    tilesize=tilesize,
                    indexes=formula.bands,
                    unscale=info.scaled,
                    resampling_method=resampling,
                    reproject_method=resampling,
                )
            except TileOutsideBounds:
                return None
        arrays = {i: image.array[k] for k, i in enumerate(formula.bands)}
        invalid = np.zeros(image.array.shape[1:], dtype=bool)
        for a in arrays.values():
            invalid |= np.ma.getmaskarray(a)
        values = formula.evaluate(
            {i: np.ma.getdata(a) for i, a in arrays.items()}, dtype="float64"
        )
        return encode_tile(encoding.encode(np.ma.masked_array(values, invalid)))

    def point(
        self, lon: float, lat: float, formula: Formula | None = None
    ) -> PointValues:
        info = self.info()
        with self._reading():
            try:
                data = self.reader.point(lon, lat, unscale=info.scaled)
            except (TileOutsideBounds, RioTilerError):
                return PointValues([None] * info.count)
        # An alpha band has no value (`_value_bands`).
        values: list[float | None] = [None] * info.count
        raw = np.ma.getdata(data.array)
        for k, index in enumerate(_value_bands(data.band_names)):
            masked = bool(np.ma.getmaskarray(data.array)[k])
            # A float32 cell as its shortest decimal (0.1, not 0.10000000149).
            v = float(str(raw[k])) if raw.dtype == np.float32 else float(raw[k])
            values[index - 1] = None if masked or not np.isfinite(v) else v
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
