"""Raster file routes (style spec 9): colored tiles, elevation tiles for
hillshade, the file's bounds, statistics and point values. Every route reads the layer
row's own file and answers only callers who may read the layer."""

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any

from cachetools import LRUCache
from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Response
from fastapi.concurrency import run_in_threadpool
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.source import BandError, RasterUnavailableError
from goatlib.raster.token import Rgb, TokenError, decode_token

from geoapi.dependencies import normalize_layer_id
from geoapi.deps.authz import require_layer_read
from geoapi.services.raster_service import (
    RasterLayer,
    info_json,
    raster_service,
    valid_bounds,
)

router = APIRouter(prefix="/collections", tags=["Rasters"])

CACHE = "public, max-age=3600"
TILE = "image/webp"

#: File reads run on threads of their own, so a slow file never holds the
#: threads every other route shares; cache lookups stay off them.
RASTER_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="raster")
#: At most this many reads of one layer at once; the others wait without a thread.
READS_PER_LAYER = 4
_slots: LRUCache[tuple[int, str], asyncio.Semaphore] = LRUCache(4096)


def _slot(layer_id: str) -> asyncio.Semaphore:
    key = (id(asyncio.get_running_loop()), layer_id)
    slot = _slots.get(key)
    if slot is None:
        slot = _slots[key] = asyncio.Semaphore(READS_PER_LAYER)
    return slot


async def _layer(collection_id: str) -> RasterLayer:
    try:
        layer_id = normalize_layer_id(collection_id)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Invalid collection ID") from None
    layer = await raster_service.layer(layer_id)
    if layer is None:
        raise HTTPException(status_code=404, detail="Not a raster file layer")
    return layer


async def _read(layer: RasterLayer, fn: Any, *args: Any) -> Any:
    """A read of the layer's file on the raster threads, its failures as HTTP
    answers."""
    try:
        async with _slot(layer.id):
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(RASTER_EXECUTOR, fn, layer, *args)
    except BandError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except UnsafeUrlError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except RasterUnavailableError as error:
        raise HTTPException(status_code=504, detail=str(error)) from None


def _tile(content: bytes | None, etag: str, if_none_match: str | None) -> Response:
    if not content:
        return Response(status_code=204, headers={"Cache-Control": CACHE})
    headers = {"Cache-Control": CACHE, "ETag": etag}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type=TILE, headers=headers)


def _etag(*parts: object) -> str:
    return '"' + hashlib.sha1(":".join(map(str, parts)).encode()).hexdigest() + '"'


@router.get(
    "/{collectionId}/raster/info",
    summary="A raster file's size, bands and band statistics",
    dependencies=[Depends(require_layer_read)],
)
async def raster_info(
    collection_id: Annotated[str, Path(alias="collectionId")],
) -> dict[str, Any]:
    layer = await _layer(collection_id)
    info, stats = await _read(layer, raster_service.statistics)
    return info_json(info, stats)


@router.get(
    "/{collectionId}/raster/bounds",
    summary="A raster file's bounds in EPSG:4326, read from its header",
    dependencies=[Depends(require_layer_read)],
)
async def raster_bounds(
    collection_id: Annotated[str, Path(alias="collectionId")],
) -> dict[str, Any]:
    """West, south, east and north in degrees; null for a file whose bounds
    are no box on earth. core stores them as the layer's extent when it
    creates the layer; the web asks here for a layer stored without one."""
    layer = await _layer(collection_id)
    bounds = await _read(layer, raster_service.bounds)
    if not valid_bounds(bounds):
        return {"bounds": None}
    return {"bounds": list(bounds)}


@router.get(
    "/{collectionId}/raster/tiles/{z}/{x}/{y}.webp",
    summary="A raster tile colored by a style token",
    dependencies=[Depends(require_layer_read)],
)
async def raster_tile(
    collection_id: Annotated[str, Path(alias="collectionId")],
    z: Annotated[int, Path(ge=0, le=24)],
    x: Annotated[int, Path(ge=0)],
    y: Annotated[int, Path(ge=0)],
    style: Annotated[str, Query(description="The coloring, base64url JSON")] = "",
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    try:
        coloring = decode_token(style)
    except TokenError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    layer = await _layer(collection_id)
    etag = _etag(layer.id, raster_service.tile_version(layer, style), z, x, y)
    if if_none_match == etag:
        return Response(status_code=304, headers={"Cache-Control": CACHE, "ETag": etag})
    content = await run_in_threadpool(raster_service.cached, layer, z, x, y, style)
    if content is None:
        content = await _read(layer, raster_service.tile, z, x, y, coloring, style)
    return _tile(content, etag, None)


@router.get(
    "/{collectionId}/raster/dem/{z}/{x}/{y}.webp",
    summary="A raster's first band as Terrarium elevation tiles",
    dependencies=[Depends(require_layer_read)],
)
async def raster_dem(
    collection_id: Annotated[str, Path(alias="collectionId")],
    z: Annotated[int, Path(ge=0, le=24)],
    x: Annotated[int, Path(ge=0)],
    y: Annotated[int, Path(ge=0)],
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    layer = await _layer(collection_id)
    etag = _etag(layer.id, raster_service.tile_version(layer, "dem"), z, x, y)
    if if_none_match == etag:
        return Response(status_code=304, headers={"Cache-Control": CACHE, "ETag": etag})
    content = await run_in_threadpool(raster_service.cached, layer, z, x, y, "dem")
    if content is None:
        content = await _read(layer, raster_service.dem, z, x, y)
    return _tile(content, etag, None)


@router.get(
    "/{collectionId}/raster/point",
    summary="Every band's value at a point, and a style's band or formula value",
    dependencies=[Depends(require_layer_read)],
)
async def raster_point(
    collection_id: Annotated[str, Path(alias="collectionId")],
    lon: Annotated[float, Query(ge=-180, le=180)],
    lat: Annotated[float, Query(ge=-90, le=90)],
    style: Annotated[str | None, Query(description="The coloring token")] = None,
) -> dict[str, Any]:
    formula = None
    if style:
        try:
            coloring = decode_token(style)
        except TokenError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None
        formula = None if isinstance(coloring, Rgb) else coloring.formula
    layer = await _layer(collection_id)
    point = await _read(layer, raster_service.point, lon, lat, formula)
    return {"values": point.values, "styled": point.formula}
