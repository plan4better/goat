"""Raster file routes (style spec 9): value tiles (the cells' values for the
browser to color) and their description, colored tiles, the file's bounds,
statistics and point values. Every route reads the layer row's own file and
answers only callers who may read the layer.

Tiles are read for each request, never kept in Redis: the browser caches them.
A tile whose caller has gone is not read, and a read past `TILE_DEADLINE_S`
answers 504 and marks the file as failing."""

import asyncio
import hashlib
import math
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Annotated, Any, Literal
from urllib.parse import quote, urlencode

from cachetools import LRUCache
from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.formula import Formula, FormulaError, parse_formula
from goatlib.raster.source import (
    BandError,
    RasterUnavailableError,
    recent_failure,
    remember_failure,
)
from goatlib.raster.token import Rgb, TokenError, decode_token
from goatlib.raster.values import ENCODING_VERSION, MAX_Q, ValueEncoding

from geoapi.dependencies import normalize_layer_id
from geoapi.deps.authz import require_layer_read
from geoapi.services.raster_service import (
    RasterLayer,
    Resampling,
    info_json,
    raster_service,
    valid_bounds,
)

router = APIRouter(prefix="/collections", tags=["Rasters"])

CACHE = "public, max-age=3600"
#: The value tiles' description is asked again soon: its version follows the
#: remote file.
DESCRIPTION_CACHE = "public, max-age=60"
TILE = "image/webp"

#: File reads run on threads of their own, so a slow file never holds the
#: threads every other route shares.
RASTER_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="raster")
#: At most this many reads of one layer at once; the others wait without a thread.
READS_PER_LAYER = 4
_slots: LRUCache[tuple[int, str], asyncio.Semaphore] = LRUCache(4096)
#: A tile read taking longer answers 504. GDAL's timeouts bound each request a
#: read sends, not the read.
TILE_DEADLINE_S = 10.0
#: The share of the deadline a started read must have run to be blamed for it:
#: its thread starts a little after the deadline's clock even when one is free.
BLAMED_SHARE = 0.9
#: What `_read_tile` gives for a caller that has gone.
_GONE = object()
_BUSY = "The raster readers are busy."

BandQuery = Annotated[
    int | None, Query(ge=1, le=1024, description="The band, from 1 (default 1)")
]
FormulaQuery = Annotated[
    str | None,
    Query(max_length=1000, description="A band formula, instead of a band"),
]
ResamplingQuery = Annotated[
    Resampling, Query(description="How the cells are read onto the tile's pixels")
]


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


@contextmanager
def _answers() -> Iterator[None]:
    """A read's failures as HTTP answers."""
    try:
        yield
    except BandError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except UnsafeUrlError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except RasterUnavailableError as error:
        raise HTTPException(status_code=504, detail=str(error)) from None


async def _read(layer: RasterLayer, fn: Any, *args: Any) -> Any:
    """A read of the layer's file on the raster threads, its failures as HTTP
    answers."""
    _not_failing(layer)
    with _answers():
        async with _slot(layer.id):
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(RASTER_EXECUTOR, fn, layer, *args)


def _not_failing(layer: RasterLayer) -> None:
    """504 at once, without a read slot, for a file that failed in goatlib's
    last 30 seconds: its requests never queue behind its stuck reads."""
    failed = recent_failure(raster_service.failure_key(layer))
    if failed is not None:
        raise HTTPException(status_code=504, detail=failed)


async def _read_tile(request: Request, layer: RasterLayer, fn: Any, *args: Any) -> Any:
    """`_read` for a tile: `_GONE` without a read when the caller has gone
    (MapLibre drops tiles that left the view), before and once it has the
    layer's slot. Past `TILE_DEADLINE_S` (counted from when the slot is taken
    and the read is handed to the raster threads), a read that has run for
    (nearly) all of it answers 504 and marks the file as failing for goatlib's
    30 seconds. A read still waiting for a raster thread is dropped, and one
    that got its thread late is left to finish unanswered: both answer 503 (the
    readers are busy, the file is not to blame). A started read's thread cannot
    be stopped, so the slot stays taken until it returns: a slow host holds at
    most `READS_PER_LAYER` threads per layer."""
    if await request.is_disconnected():
        return _GONE
    _not_failing(layer)
    slot = _slot(layer.id)
    await slot.acquire()
    #: When a raster thread started the read.
    started: list[float] = []

    def run() -> Any:
        started.append(time.monotonic())
        return fn(layer, *args)

    read = None
    try:
        if not await request.is_disconnected():
            read = RASTER_EXECUTOR.submit(run)
    finally:
        if read is None:
            slot.release()
    if read is None:
        return _GONE
    # Released on the event loop once the read is done or dropped.
    waiting = asyncio.wrap_future(read)
    waiting.add_done_callback(lambda _: slot.release())
    with _answers():
        try:
            return await asyncio.wait_for(asyncio.shield(waiting), TILE_DEADLINE_S)
        except TimeoutError:
            # Cancelling succeeds only for a read no thread has started.
            if read.cancel():
                raise HTTPException(status_code=503, detail=_BUSY) from None
            if read.done():
                return read.result()
            ran = time.monotonic() - started[0] if started else 0.0
            if ran < BLAMED_SHARE * TILE_DEADLINE_S:
                raise HTTPException(status_code=503, detail=_BUSY) from None
            message = f"The file did not answer within {TILE_DEADLINE_S:g} seconds."
            remember_failure(raster_service.failure_key(layer), message)
            raise HTTPException(status_code=504, detail=message) from None


def _gone() -> Response:
    """The answer to a caller that has gone, which no cache may keep."""
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


def _values_of(band: int | None, formula: str | None) -> Formula:
    """What a value tile holds: the band's values, or the formula's; band 1
    when neither is given."""
    if band is not None and formula is not None:
        raise HTTPException(status_code=400, detail="A band or a formula, not both.")
    try:
        return parse_formula(formula if formula is not None else f"b{band or 1}")
    except FormulaError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


def _encoding_of(base: float, step: float) -> ValueEncoding:
    """The encoding a value tile's address names (code q is `base + q * step`);
    400 when its codes cannot all be finite values."""
    if not (
        math.isfinite(base)
        and math.isfinite(step)
        and step > 0
        and math.isfinite(base + MAX_Q * step)
    ):
        raise HTTPException(
            status_code=400,
            detail="base and step must be finite, step above 0, and every code finite.",
        )
    return ValueEncoding(base=base, step=step, integer=False, range=None)


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
    request: Request,
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
    content = await _read_tile(request, layer, raster_service.tile, z, x, y, coloring)
    if content is _GONE:
        return _gone()
    return _tile(content, etag, None)


@router.get(
    "/{collectionId}/coverage/tiles/WebMercatorQuad",
    summary="How a raster file's value tiles hold a band's or a formula's values",
    dependencies=[Depends(require_layer_read)],
)
async def raster_values_tileset(
    request: Request,
    collection_id: Annotated[str, Path(alias="collectionId")],
    band: BandQuery = None,
    formula: FormulaQuery = None,
    resampling: ResamplingQuery = "bilinear",
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """OGC tileset metadata with `goat:values`: the factors of a MapLibre
    `raster-dem` source with the custom encoding that turn a tile's codes into
    values (code 0 is no data), the values' range as a missing domain uses it,
    whether they are whole numbers, and the version. The tile link carries the
    encoding's base and step (shortest round-trip decimals), so a tile's
    address alone fixes its pixels."""
    values = _values_of(band, formula)
    layer = await _layer(collection_id)
    version = await _read(layer, raster_service.values_version)
    shown: dict[str, str | int] = {
        "f": "webp",
        **({"formula": formula} if formula is not None else {"band": band or 1}),
        "resampling": resampling,
    }
    etag = _etag(layer.id, version, urlencode(shown))
    headers = {"Cache-Control": DESCRIPTION_CACHE, "ETag": etag}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    encoding, maxzoom = await _read(layer, raster_service.value_tileset, values)
    query = urlencode(
        {
            **shown,
            "base": repr(encoding.base),
            "step": repr(encoding.step),
            "v": version,
        },
        quote_via=quote,
    )
    base_url = str(request.base_url).rstrip("/")
    tiles = f"{base_url}/collections/{layer.id}/coverage/tiles/WebMercatorQuad"
    return JSONResponse(
        {
            "title": f"{layer.id} values",
            "tileMatrixSetURI": (
                "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
            ),
            "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
            "dataType": "coverage",
            "maxzoom": maxzoom,
            "links": [
                {
                    "rel": "item",
                    "type": TILE,
                    "templated": True,
                    "href": f"{tiles}/{{tileMatrix}}/{{tileRow}}/{{tileCol}}?{query}",
                }
            ],
            "goat:values": {
                "encoding": encoding.factors(),
                "range": list(encoding.range) if encoding.range else None,
                "integer": encoding.integer,
                "version": version,
            },
        },
        headers=headers,
    )


@router.get(
    "/{collectionId}/coverage/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}",
    summary="A value tile of a raster file's band or formula",
    dependencies=[Depends(require_layer_read)],
)
async def raster_values_tile(
    request: Request,
    collection_id: Annotated[str, Path(alias="collectionId")],
    z: Annotated[int, Path(alias="tileMatrix", ge=0, le=24)],
    y: Annotated[int, Path(alias="tileRow", ge=0)],
    x: Annotated[int, Path(alias="tileCol", ge=0)],
    base: Annotated[float, Query(description="Code q is base + q * step")],
    step: Annotated[float, Query(description="What one code adds to the value")],
    band: BandQuery = None,
    formula: FormulaQuery = None,
    resampling: ResamplingQuery = "bilinear",
    f: Annotated[Literal["webp"], Query(description="Lossless WebP")] = "webp",
    v: Annotated[
        str, Query(max_length=64, description="The description's version")
    ] = "",
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """Each pixel's code `q = R * 65536 + G * 256 + B` is the value
    `base + q * step`, with the base and step of the address (the description's
    link names them); code 0 is no data, alpha is always 255."""
    values = _values_of(band, formula)
    encoding = _encoding_of(base, step)
    layer = await _layer(collection_id)
    shown = f"values:{values.expression}:{resampling}:{f}:{ENCODING_VERSION}"
    version = raster_service.tile_version(layer, shown)
    etag = _etag(layer.id, version, v, base, step, z, x, y)
    if if_none_match == etag:
        return Response(status_code=304, headers={"Cache-Control": CACHE, "ETag": etag})
    content = await _read_tile(
        request, layer, raster_service.values, z, x, y, values, encoding, resampling
    )
    if content is _GONE:
        return _gone()
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
