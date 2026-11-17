"""One vector tile at a time out of an item's published ``.pmtiles``.

goat-data publishes a layer's tiles as ``data/<name>.pmtiles`` in the private
catalog bucket (the item's ``tiles`` asset). The detail map draws them through
``/assets/{id}/tiles/{z}/{x}/{y}``, one tile per request, so the file itself is
never served and the bucket needs no browser access.

A tile file can be hundreds of megabytes, so it is read in ranges: the header
and root directory once (cached per mirror generation), then the directory and
the one tile a request needs. :class:`~catalog.services.assets.AssetReader`
reads whole objects through DuckDB, which has no ranged read, so this signs its
own range GETs (AWS SigV4, standard library only: no S3 client in this image).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urlsplit

from pmtiles.reader import Reader
from pmtiles.tile import Compression

from catalog.config import CatalogSettings
from catalog.errors import ApiError
from catalog.services.preview import object_key

logger = logging.getLogger(__name__)

#: The header (127 bytes) and the root directory, which the format keeps within
#: the first 16 KiB. Read once per file, and read again when the file changed.
_HEAD_BYTES = 16_384
_HEADS_KEPT = 512
#: goat-data replaces a tile file under the same name without touching its
#: item, so a cached head is checked against the bucket again after this long.
_HEAD_RECHECK_S = 60


class _Replaced(Exception):
    """The file changed under a cached head."""


def _amz_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class TileReader:
    """Reads single tiles of items' published tile files."""

    def __init__(self, settings: CatalogSettings) -> None:
        self._settings = settings
        self._heads: OrderedDict[str, tuple[bytes, str, float]] = OrderedDict()
        self._lock = threading.Lock()

    def _sign(
        self, key: str, amz_date: str, query: str, headers: dict[str, str]
    ) -> tuple[str, str, str, str]:
        """AWS SigV4 of one GET of ``key``: the object's address, the
        credential scope, the signed header names and the signature.
        ``headers`` are the signed headers; ``host`` is added."""
        s = self._settings
        endpoint = (
            s.s3_endpoint_url or f"https://s3.{s.s3_region}.amazonaws.com"
        ).rstrip("/")
        parts = urlsplit(endpoint)
        path = f"{parts.path}/{s.s3_catalog_bucket}/{quote(key, safe='/~')}"
        headers["host"] = parts.netloc
        scope = f"{amz_date[:8]}/{s.s3_region}/s3/aws4_request"
        signed = ";".join(sorted(headers))
        canonical = "\n".join(
            [
                "GET",
                path,
                query,
                "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)),
                signed,
                "UNSIGNED-PAYLOAD",
            ]
        )
        to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical.encode()).hexdigest(),
            ]
        )
        key_bytes = f"AWS4{s.s3_secret_access_key}".encode()
        for part in scope.split("/"):
            key_bytes = hmac.new(key_bytes, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key_bytes, to_sign.encode(), hashlib.sha256).hexdigest()
        return f"{parts.scheme}://{parts.netloc}{path}", scope, signed, signature

    def read_range(self, key: str, offset: int, length: int) -> tuple[bytes, str]:
        """``length`` bytes of one object from ``offset`` and the object's
        ETag: the one call that reaches the bucket, and the seam a test points
        at local files."""
        amz_date = _amz_date()
        headers = {
            "range": f"bytes={offset}-{offset + length - 1}",
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            "x-amz-date": amz_date,
        }
        url, scope, signed, signature = self._sign(key, amz_date, "", headers)
        request = urllib.request.Request(
            url,
            headers={
                **{k: v for k, v in headers.items() if k != "host"},
                "Authorization": (
                    "AWS4-HMAC-SHA256 "
                    f"Credential={self._settings.s3_access_key_id}/{scope}, "
                    f"SignedHeaders={signed}, Signature={signature}"
                ),
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return response.read(), response.headers.get("ETag", "")

    def presign(self, key: str, expires: int = 900) -> str:
        """A GET address of one object that works for ``expires`` seconds: for
        a reader (GDAL) that fetches ranges itself. Never sent to a client."""
        s = self._settings
        amz_date = _amz_date()
        scope = f"{amz_date[:8]}/{s.s3_region}/s3/aws4_request"
        params = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{s.s3_access_key_id}/{scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(expires),
            "X-Amz-SignedHeaders": "host",
        }
        query = "&".join(
            f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}"
            for k, v in sorted(params.items())
        )
        url, _, _, signature = self._sign(key, amz_date, query, {})
        return f"{url}?{query}&X-Amz-Signature={signature}"

    def _bytes(self, key: str, head: bytes, etag: str) -> Any:
        """``get_bytes`` for the pmtiles reader: the cached head when the range
        lies in it, a range read of the same file version otherwise."""

        def get_bytes(offset: int, length: int) -> bytes:
            if offset + length <= len(head):
                return head[offset : offset + length]
            data, current = self.read_range(key, offset, length)
            if current != etag:
                raise _Replaced
            return data

        return get_bytes

    def _head(self, key: str, fresh: bool = False) -> tuple[bytes, str]:
        now = time.monotonic()
        with self._lock:
            cached = self._heads.get(key)
            if cached and not fresh and now - cached[2] < _HEAD_RECHECK_S:
                self._heads.move_to_end(key)
                return cached[0], cached[1]
        head, etag = self.read_range(key, 0, _HEAD_BYTES)
        with self._lock:
            self._heads[key] = (head, etag, now)
            self._heads.move_to_end(key)
            while len(self._heads) > _HEADS_KEPT:
                self._heads.popitem(last=False)
        return head, etag

    def _key(self, row: dict[str, Any]) -> str:
        """404 when the item has no tiles asset, or its href is not a
        ``.pmtiles`` under the bucket's ``data/`` (the key comes from the
        item's own href, as for every asset)."""
        assets = row.get("assets")
        asset = assets.get("tiles") if isinstance(assets, dict) else None
        href = asset.get("href") if isinstance(asset, dict) else None
        if not href or not str(href).lower().endswith(".pmtiles"):
            raise ApiError(404, "item has no tiles")
        return object_key(
            str(href), self._settings.s3_catalog_bucket or "", prefixes=("data/",)
        )

    def version(self, row: dict[str, Any]) -> str:
        """The ETag of the item's tile file as last checked: what a client's
        copy of a tile is validated against."""
        key = self._key(row)
        try:
            return self._head(key)[1]
        except (OSError, urllib.error.URLError) as exc:
            logger.warning("tiles read failed for %s: %s", key, exc)
            raise ApiError(404, "tiles are not available") from exc

    def tile(
        self, row: dict[str, Any], z: int, x: int, y: int
    ) -> tuple[bytes, str | None] | None:
        """``(tile bytes, Content-Encoding)`` or None for an empty tile; 404 as
        in ``_key``, or when the file cannot be read."""
        key = self._key(row)
        if x >= 2**z or y >= 2**z:
            return None
        try:
            try:
                header, data = self._read(key, self._head(key), z, x, y)
            except _Replaced:
                header, data = self._read(key, self._head(key, fresh=True), z, x, y)
        except (OSError, urllib.error.URLError, ValueError, _Replaced) as exc:
            logger.warning("tiles read failed for %s: %s", key, exc)
            raise ApiError(404, "tiles are not available") from exc
        if not data:
            return None
        gzip = header.get("tile_compression") == Compression.GZIP
        return bytes(data), "gzip" if gzip else None

    def _read(
        self, key: str, head: tuple[bytes, str], z: int, x: int, y: int
    ) -> tuple[dict[str, Any], bytes | None]:
        reader = Reader(self._bytes(key, *head))
        return reader.header(), reader.get(z, x, y)


#: How long a signed address of a raster is reused, and how long it is valid.
#: Long, so the address is as stable as a project raster's in geoapi:
#: goatlib caches what it learns per address and never drops old addresses.
#: It never leaves the server.
_ADDRESS_REUSE_S = 12 * 3600
_ADDRESS_VALID_S = 24 * 3600
_RASTER_SUFFIXES = (".tif", ".tiff")


class RasterTileReader:
    """Draws an item's own GeoTIFF tile by tile with goatlib's raster code (the
    code geoapi draws project rasters with), so the detail map shows the raster
    in its style. GDAL reads the private file through a signed address that is
    never sent to a client."""

    def __init__(self, settings: CatalogSettings, tiles: TileReader) -> None:
        self._settings = settings
        self._tiles = tiles
        self._addresses: dict[tuple[str, str], tuple[str, float]] = {}
        self._lock = threading.Lock()

    def _key(self, row: dict[str, Any]) -> str:
        href = str(row.get("parquet_url") or "")
        if not href.lower().endswith(_RASTER_SUFFIXES):
            raise ApiError(404, "item is not a raster")
        return object_key(
            href, self._settings.s3_catalog_bucket or "", prefixes=("data/",)
        )

    def _source(self, generation: str, key: str) -> Any:
        """The raster to read: a seam a test points at a local file."""
        from goatlib.raster.source import RasterSource

        now = time.monotonic()
        with self._lock:
            cached = self._addresses.get((generation, key))
            if cached is None or now - cached[1] > _ADDRESS_REUSE_S:
                for stale in [k for k in self._addresses if k[0] != generation]:
                    del self._addresses[stale]
                cached = (self._tiles.presign(key, _ADDRESS_VALID_S), now)
                self._addresses[(generation, key)] = cached
        host = urlsplit(cached[0]).hostname or ""
        return RasterSource(cached[0], private_hosts=[host])

    def tile(
        self,
        generation: str,
        row: dict[str, Any],
        z: int,
        x: int,
        y: int,
        token: str | None,
    ) -> bytes | None:
        """A colored WebP tile, None outside the file; 400 for a bad coloring,
        404 when the item is no raster or its file cannot be read."""
        from goatlib.raster.source import BandError, RasterUnavailableError
        from goatlib.raster.token import TokenError, decode_token

        key = self._key(row)
        try:
            coloring = decode_token(token or "")
        except TokenError as error:
            raise ApiError(400, str(error)) from None
        try:
            with self._source(generation, key) as source:
                return source.tile(z, x, y, coloring)
        except BandError as error:
            raise ApiError(400, str(error)) from None
        except RasterUnavailableError as error:
            logger.warning("raster tile of %s not available: %s", key, error)
            raise ApiError(404, "the raster is not available") from None

    def dem(
        self, generation: str, row: dict[str, Any], z: int, x: int, y: int
    ) -> bytes | None:
        """The first band as Terrarium elevation tiles, for hillshade styles."""
        from goatlib.raster.source import RasterUnavailableError

        key = self._key(row)
        try:
            with self._source(generation, key) as source:
                return source.dem(z, x, y)
        except RasterUnavailableError as error:
            logger.warning("raster dem of %s not available: %s", key, error)
            raise ApiError(404, "the raster is not available") from None
