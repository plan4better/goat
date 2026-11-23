"""Catalog items that are not layers yet, as a preview reads them.

A catalog item's data stays in the private catalog bucket until the item is
added to a project (promotion copies it). Before that the catalog page draws
it through geoapi's own tile and raster routes, under the collection id
`catalog:<item id>`: the tiles goat-data published for a vector item
(`assets.tiles`, a `.pmtiles` read in ranges) and a raster item's GeoTIFF,
which GDAL reads through an address signed for it that never leaves the
server.

Which object is read comes from the item's own row in the catalog mirror
(`CATALOG_DATA_DIR`): the file name of its href under the bucket's `data/`
prefix, never anything from the request. Who may read is decided by
`geoapi.deps.authz.catalog_read_allowed` alone; nothing here asks.
"""

import logging
import re
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
from cachetools import TTLCache
from fastapi import HTTPException
from goatlib.catalog.item import RASTER_SUFFIXES, bucket_key_for

from geoapi.config import settings

logger = logging.getLogger(__name__)

#: What a collection id starts with when it names a catalog item.
COLLECTION_PREFIX = "catalog:"
#: The mirror's items file, as goatlib's `sync_catalog` writes it.
MIRROR_ITEMS = "mirror_items.parquet"
#: How long an item's row is reused: the mirror changes with a sync.
ITEM_TTL_S = 60
#: The header and root directory of a tile file, which the format keeps
#: within its first 16 KiB.
HEAD_BYTES = 16_384
#: How long a raster's signed address is reused, and how long it is valid:
#: goatlib and GDAL keep what they read of a file by its address.
ADDRESS_REUSE_S = 12 * 3600
ADDRESS_VALID_S = 24 * 3600

_ITEM_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

#: The mirror and the catalog bucket are read on threads of their own: a slow
#: bucket never holds the threads the layers' tiles and rasters are read on.
CATALOG_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="catalog")


class Replaced(Exception):
    """The object changed under a read that named its ETag."""


def catalog_item_id(collection_id: str) -> str | None:
    """The catalog item a collection id names, None for a layer's id; 400
    for one that names no possible item."""
    if not collection_id.startswith(COLLECTION_PREFIX):
        return None
    item_id = collection_id[len(COLLECTION_PREFIX) :]
    if not _ITEM_ID.fullmatch(item_id):
        raise HTTPException(status_code=400, detail="Invalid catalog item id")
    return item_id


@dataclass(frozen=True)
class CatalogItem:
    id: str
    #: The bucket key of its published tiles, None without them.
    tiles_key: str | None
    #: The bucket key of its GeoTIFF, None for an item that is no raster.
    raster_key: str | None


def _key(href: object, suffixes: tuple[str, ...]) -> str | None:
    try:
        return bucket_key_for(str(href or ""), suffixes)
    except ValueError:
        return None


def item_of(item_id: str, data_href: object, assets: object) -> CatalogItem:
    """An item from its mirror row: its data href and its assets."""
    tiles = assets.get("tiles") if isinstance(assets, dict) else None
    tiles_href = tiles.get("href") if isinstance(tiles, dict) else None
    return CatalogItem(
        item_id,
        tiles_key=_key(tiles_href, (".pmtiles",)),
        raster_key=_key(data_href, RASTER_SUFFIXES),
    )


def _status(error: Exception) -> int | None:
    """The HTTP status of a botocore `ClientError`, None for anything else."""
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return None
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return status if isinstance(status, int) else None


class CatalogItems:
    def __init__(self) -> None:
        self._items: TTLCache[str, CatalogItem | None] = TTLCache(4096, ITEM_TTL_S)
        self._addresses: TTLCache[tuple[str, str], str] = TTLCache(
            1024, ADDRESS_REUSE_S
        )
        self._lock = threading.Lock()
        self._s3: Any = None

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._addresses.clear()

    def _bucket(self) -> str:
        if not settings.CATALOG_S3_BUCKET:
            raise HTTPException(
                status_code=404, detail="Catalog previews are not set up here"
            )
        return settings.CATALOG_S3_BUCKET

    def _client(self) -> Any:
        """The catalog bucket's client, made on first use (boto3 is loaded
        only where a preview is read)."""
        with self._lock:
            if self._s3 is None:
                import boto3
                from botocore.config import Config

                self._s3 = boto3.client(
                    "s3",
                    endpoint_url=settings.CATALOG_S3_ENDPOINT_URL,
                    aws_access_key_id=settings.CATALOG_S3_ACCESS_KEY_ID,
                    aws_secret_access_key=settings.CATALOG_S3_SECRET_ACCESS_KEY,
                    region_name=settings.CATALOG_S3_REGION,
                    config=Config(
                        signature_version="s3v4",
                        connect_timeout=3,
                        read_timeout=10,
                        retries={"max_attempts": 2},
                    ),
                )
            return self._s3

    def item(self, item_id: str) -> CatalogItem:
        """The item's row in the mirror, kept for a minute; 404 for an item
        the mirror does not hold, or without a mirror."""
        with self._lock:
            known = item_id in self._items
            found = self._items.get(item_id)
        if not known:
            found = self._read(item_id)
            with self._lock:
                self._items[item_id] = found
        if found is None:
            raise HTTPException(status_code=404, detail="Catalog item not found")
        return found

    @staticmethod
    def _read(item_id: str) -> CatalogItem | None:
        mirror = Path(settings.CATALOG_DATA_DIR) / MIRROR_ITEMS
        if not mirror.exists():
            return None
        con = duckdb.connect()
        try:
            row = con.execute(
                "SELECT parquet_url, assets FROM read_parquet(?) WHERE id = ?",
                [str(mirror), item_id],
            ).fetchone()
        finally:
            con.close()
        return None if row is None else item_of(item_id, row[0], row[1])

    def read_range(
        self, key: str, offset: int, length: int, etag: str | None = None
    ) -> tuple[bytes, str]:
        """`length` bytes of an object from `offset`, and its ETag. With
        `etag`, only of that version of the object: `Replaced` when it
        changed. 404 for an object the bucket does not hold."""
        bucket = self._bucket()
        named = {"IfMatch": etag} if etag is not None else {}
        try:
            got = self._client().get_object(
                Bucket=bucket,
                Key=key,
                Range=f"bytes={offset}-{offset + length - 1}",
                **named,
            )
            return got["Body"].read(), str(got.get("ETag") or "")
        except Exception as error:
            raise self._answer(key, error) from None

    @staticmethod
    def _answer(key: str, error: Exception) -> Exception:
        """What a failed read of the bucket raises: `Replaced`, 404 for a
        missing object, 503 for a bucket that does not answer."""
        status = _status(error)
        if status == 412:
            return Replaced()
        if status == 404:
            return HTTPException(
                status_code=404, detail="The item's file is not available"
            )
        logger.warning(
            "The catalog bucket did not give %s: %s", key, type(error).__name__
        )
        return HTTPException(
            status_code=503, detail="The catalog bucket did not answer"
        )

    def tiles_bytes(self, key: str) -> tuple[Callable[[int, int], bytes], str]:
        """`get_bytes` for a PMTiles reader over one version of a tile file,
        and that version's ETag. The file's head is read here and kept; any
        other range is read from the bucket, of this version only (`Replaced`
        once goat-data put another file under the name)."""
        head, etag = self.read_range(key, 0, HEAD_BYTES)

        def get_bytes(offset: int, length: int) -> bytes:
            if offset + length <= len(head):
                return head[offset : offset + length]
            return self.read_range(key, offset, length, etag)[0]

        return get_bytes, etag

    def raster_address(self, key: str) -> tuple[str, str]:
        """An address GDAL can read the GeoTIFF from, and the object's ETag.
        The address is signed for a day and reused for half of one, as long as
        the object is the same; it is never part of an answer."""
        bucket = self._bucket()
        client = self._client()
        try:
            etag = str(client.head_object(Bucket=bucket, Key=key).get("ETag") or "")
        except Exception as error:
            raise self._answer(key, error) from None
        with self._lock:
            address: str | None = self._addresses.get((key, etag))
            if address is None:
                address = client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": bucket, "Key": key},
                    ExpiresIn=ADDRESS_VALID_S,
                )
                self._addresses[(key, etag)] = address
        return address, etag


catalog_items = CatalogItems()
