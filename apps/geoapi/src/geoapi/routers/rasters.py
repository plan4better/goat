"""Raster file routes (style spec 9): value tiles (the cells' values for the
browser to color) and colored tiles, each with their description, the file's
bounds, statistics and point values. Every route reads the layer row's own
file and answers only callers who may read the layer.

Tiles are read for each request, never kept in Redis: the browser caches them,
a tile read with content for good when its address names the layer's values
version (its address then fixes its pixels). A tile whose caller has gone is
not read, and a read past `TILE_DEADLINE_S` answers 504 and marks the file as
failing."""

import asyncio
import hashlib
import logging
import math
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from enum import IntEnum
from typing import Annotated, Any, Concatenate, Literal, ParamSpec
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
    TILE_SIZE,
    BandError,
    RasterInfo,
    RasterUnavailableError,
    check_bands,
    logged,
    recent_failure,
    remember_failure,
)
from goatlib.raster.token import Rgb, TokenError, decode_token
from goatlib.raster.values import ENCODING_VERSION, MAX_Q, ValueEncoding

from geoapi.dependencies import normalize_layer_id
from geoapi.deps.authz import require_layer_read
from geoapi.services.raster_service import (
    BandBreaks,
    Breaks,
    FormulaStats,
    RasterLayer,
    Resampling,
    band_breaks,
    formula_described,
    formula_key,
    info_json,
    palette,
    raster_service,
    valid_bounds,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/collections", tags=["Rasters"])

CACHE = "public, max-age=3600"
#: A tile of the layer's current values version is kept for good: its address
#: names the file's version, the encoding's packing version and what it shows
#: (a value tile's band or formula and encoding, a colored tile's coloring), so
#: another file or style is another address.
FOREVER = "max-age=31536000, immutable"
#: A tile of a remote file whose host gives no validator (no ETag, no
#: Last-Modified, or a HEAD it refuses): its version does not follow the file.
AN_HOUR = "max-age=3600"
#: A tile whose address names another version, or none, holds the current
#: file, which that address does not name.
STALE_TILE_CACHE = "no-store"
#: The tiles' descriptions are asked again soon: their version follows the
#: remote file.
DESCRIPTION_AGE = "max-age=60"
TILE = "image/webp"
#: The arguments a tile read takes after the layer.
P = ParamSpec("P")

#: File reads run on threads of their own, so a slow file never holds the
#: threads every other route shares.
RASTER_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="raster")
#: At most this many reads of one layer at once; the others wait without a thread.
READS_PER_LAYER = 4
_slots: LRUCache[tuple[int, str], asyncio.Semaphore] = LRUCache(4096)
#: Class breaks are classified on threads of their own, after the read slot
#: is released: tiles never wait for them.
BREAKS_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="breaks")
#: The class breaks being computed, by event loop, file version and band: the
#: infos of a cold band wait for one computation, without a read slot or a
#: thread.
_breaks_runs: dict[tuple[int, str, int], asyncio.Future[Breaks]] = {}
#: The band formulas being described, by event loop, file version and
#: formula (`formula_key`), as the breaks.
_formula_runs: dict[tuple[int, str, str], asyncio.Future[FormulaStats | None]] = {}
#: At most this many band formulas are being described at once in the process:
#: an info asking for another one meanwhile answers without `formula`. Any
#: text that parses is a formula of its own, so without a cap their values
#: would queue for the breaks threads that every layer's class breaks share.
MAX_FORMULA_RUNS = 8
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
BreaksBandQuery = Annotated[
    int | None,
    Query(
        ge=1,
        le=1024,
        description=(
            "The band whose class breaks the info answers (`breaks` of that "
            "band alone), computed once per file version; without it no band "
            "carries breaks"
        ),
    ),
]
FormulaQuery = Annotated[
    str | None,
    Query(max_length=1000, description="A band formula, instead of a band"),
]
ResamplingQuery = Annotated[
    Resampling, Query(description="How the cells are read onto the tile's pixels")
]


class TileSize(IntEnum):
    """The tile sizes there are (goatlib's `TileSize`): an enum, as a query
    string reads as one and not as a literal number."""

    SMALL = 256
    LARGE = 512


TileSizeQuery = Annotated[
    TileSize,
    Query(
        description=(
            "The tiles' width in pixels: 512 draws each tile's area at twice "
            "the resolution (the web asks for these)"
        )
    ),
]


def _slot(layer_id: str) -> asyncio.Semaphore:
    key = (id(asyncio.get_running_loop()), layer_id)
    slot = _slots.get(key)
    if slot is None:
        slot = _slots[key] = asyncio.Semaphore(READS_PER_LAYER)
    return slot


async def _layer(collection_id: str, fresh: bool = False) -> RasterLayer:
    try:
        layer_id = normalize_layer_id(collection_id)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Invalid collection ID") from None
    layer = await raster_service.layer(layer_id, fresh)
    if layer is None:
        raise HTTPException(status_code=404, detail="Not a raster file layer")
    return layer


@contextmanager
def _answers() -> Iterator[None]:
    """A read's failures as HTTP answers. goatlib's messages say what failed
    without the file's address (the URL guard's messages name the host only),
    so they are the answer's detail as they are."""
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


async def _read_tile(
    request: Request, layer: RasterLayer, fn: Any, *args: Any, **kwargs: Any
) -> Any:
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
        return fn(layer, *args, **kwargs)

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


def _tile(
    content: bytes | None, etag: str, cache: str = CACHE, empty: str = CACHE
) -> Response:
    """A read tile under `cache`, or 204 under `empty` for one without content."""
    if not content:
        return Response(status_code=204, headers={"Cache-Control": empty})
    return Response(
        content=content, media_type=TILE, headers={"Cache-Control": cache, "ETag": etag}
    )


def _audience(request: Request) -> str:
    """Who may keep an answer: one read with a sign-in may be of a layer not
    everyone may read, which no shared cache may keep (`private`); one read
    without is `public`. The web sends no token with tile requests, so while
    `ENFORCE_READ_AUTHZ` is off every map tile is public, a private layer's
    included: enforce it before a shared cache serves them."""
    return "private" if request.headers.get("authorization") else "public"


def _tile_cache(request: Request, current: bool, follows: bool) -> str:
    """A tile's Cache-Control. One whose address names another version than
    the layer's holds the current file: no cache keeps it. One of a file its
    version does not follow (a remote file whose host gives no validator) is
    kept an hour, any other for good; by the browser only when read with a
    sign-in (`_audience`)."""
    if not current:
        return STALE_TILE_CACHE
    return f"{_audience(request)}, {FOREVER if follows else AN_HOUR}"


def _description_cache(request: Request) -> str:
    """A description's Cache-Control: a minute, as `_audience` allows."""
    return f"{_audience(request)}, {DESCRIPTION_AGE}"


async def _values_state(layer: RasterLayer) -> tuple[str, bool]:
    """The layer's values version and whether it follows the file, on the
    raster threads (a remote file's check may ask its host), without a read
    slot."""
    _not_failing(layer)
    with _answers():
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            RASTER_EXECUTOR, raster_service.values_state, layer
        )


async def _versioned_tile(
    request: Request,
    layer: RasterLayer,
    v: str,
    etag: str,
    if_none_match: str | None,
    read: Callable[Concatenate[RasterLayer, P], bytes | None],
    *args: P.args,
    **kwargs: P.kwargs,
) -> Response:
    """A tile whose address names the values version `v`, read by
    `read(layer, *args, **kwargs)`, under `_tile_cache`: 304 on its ETag with
    the header its 200 had, 204 for a caller that has gone or a tile without
    content."""
    if if_none_match == etag:
        current, follows = await _values_state(layer)
        cache = _tile_cache(request, v == current, follows)
        return Response(status_code=304, headers={"Cache-Control": cache, "ETag": etag})
    answer = await _read_tile(
        request, layer, raster_service.at_version, read, *args, **kwargs
    )
    if answer is _GONE:
        return _gone()
    current, follows, content = answer
    if v != current:
        return _tile(content, etag, STALE_TILE_CACHE, STALE_TILE_CACHE)
    return _tile(content, etag, _tile_cache(request, True, follows))


def _tileset(
    title: str,
    data_type: str,
    maxzoom: int | None,
    bounds: tuple[float, float, float, float],
    href: str,
) -> dict[str, Any]:
    """OGC tileset metadata of a file's tiles in WebMercatorQuad, as a map
    reads it: `maxzoom`, the native zoom for the tile size asked for (a map
    magnifies its tiles past it), and `bounds`, the file's west, south, east
    and north in degrees as in TileJSON (null when they are no box on earth),
    so a map asks only for the tiles that touch them."""
    return {
        "title": title,
        "tileMatrixSetURI": (
            "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
        ),
        "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
        "dataType": data_type,
        "maxzoom": maxzoom,
        "bounds": list(bounds) if valid_bounds(bounds) else None,
        "links": [{"rel": "item", "type": TILE, "templated": True, "href": href}],
    }


#: The shape of the value tiles' description: its ETag names it, so a body that
#: gains a field (`names`) is sent anew rather than revalidated as the one a
#: browser kept. A tile's pixels do not change with it (`ENCODING_VERSION` does
#: that), so the tiles keep their URLs.
VALUES_DESCRIPTION_SHAPE = "names"
#: The shape of the colored tiles' description, as `VALUES_DESCRIPTION_SHAPE`.
IMAGE_DESCRIPTION_SHAPE = "color_table_palette"


def _etag(*parts: object) -> str:
    return '"' + hashlib.sha1(":".join(map(str, parts)).encode()).hexdigest() + '"'


def _sized(tilesize: int) -> tuple[int, ...]:
    """What a tile's ETag adds for its size: nothing for the default, so a
    256 px tile keeps the ETag it had before tiles had sizes."""
    return () if tilesize == TILE_SIZE else (tilesize,)


@router.get(
    "/{collectionId}/raster/info",
    summary="A raster file's size, bands, band statistics and class breaks",
    dependencies=[Depends(require_layer_read)],
)
async def raster_info(
    collection_id: Annotated[str, Path(alias="collectionId")],
    band: BreaksBandQuery = None,
    formula: Annotated[
        str | None,
        Query(
            max_length=1000,
            description=(
                "A band formula whose statistics and class breaks the info "
                "answers (`formula`, with the expression as asked), instead "
                "of a band: no band carries breaks then"
            ),
        ),
    ] = None,
) -> dict[str, Any]:
    if band is not None and formula is not None:
        raise HTTPException(status_code=400, detail="A band or a formula, not both.")
    asked = _values_of(None, formula) if formula is not None else None
    layer = await _layer(collection_id)
    file, info, stats = await _read(layer, raster_service.described)
    breaks: BandBreaks = {}
    if band is not None:
        with _answers():
            check_bands(info, [band])
        kept = raster_service.kept_breaks(file, band)
        breaks[band] = (
            kept if kept is not None else await _breaks(layer, file, info, band)
        )
    described = None
    if asked is not None:
        with _answers():
            check_bands(info, asked.bands)
        found = await _formula(layer, file, info, asked)
        described = (asked.expression, found) if found is not None else None
    return info_json(info, stats, breaks, described)


async def _formula(
    layer: RasterLayer, file: str, info: RasterInfo, formula: Formula
) -> FormulaStats | None:
    """A band formula's statistics and class breaks of the file version
    `file`: kept, or computed once while every info asking meanwhile waits
    without a read slot, however the formula is spaced (`formula_key`). None
    where they could not be computed (kept so for 30 seconds), and while
    `MAX_FORMULA_RUNS` other formulas are being described (nothing is kept
    then, the next info asks again): an info without them still answers."""
    name = formula_key(formula)
    known, kept = raster_service.kept_formula(file, name)
    if known:
        return kept
    key = (id(asyncio.get_running_loop()), file, name)
    run = _formula_runs.get(key)
    if run is None:
        if len(_formula_runs) >= MAX_FORMULA_RUNS:
            return None
        run = _formula_runs[key] = asyncio.ensure_future(
            _compute_formula(layer, file, info, formula, name)
        )
        run.add_done_callback(lambda _: _formula_runs.pop(key, None))
    return await asyncio.shield(run)


async def _compute_formula(
    layer: RasterLayer, file: str, info: RasterInfo, formula: Formula, name: str
) -> FormulaStats | None:
    """Reads the formula's values in one of the layer's read slots, which
    gives their statistics and the sample to classify (the overview's values
    stay on the raster thread), then classifies the sample after releasing it,
    as a band's breaks. Whatever fails is logged and kept as failed under
    `name` (`formula_key`): the info answers without the formula."""
    loop = asyncio.get_running_loop()
    try:
        async with _slot(layer.id):
            stats, sample = await loop.run_in_executor(
                RASTER_EXECUTOR, raster_service.formula_sample, layer, formula, info
            )
        described: FormulaStats = await loop.run_in_executor(
            BREAKS_EXECUTOR, formula_described, layer, formula, stats, sample, info
        )
    except Exception as error:
        address, text = logged(raster_service.failure_key(layer), error)
        logger.warning(
            "The band formula %s of the raster file %s was not described: %s: %s",
            formula.expression,
            address,
            type(error).__name__,
            text,
        )
        raster_service.keep_formula(file, name, None)
        return None
    raster_service.keep_formula(file, name, described)
    return described


async def _breaks(layer: RasterLayer, file: str, info: RasterInfo, band: int) -> Breaks:
    """A band's class breaks of the file version `file`, computed once while
    every info asking for them meanwhile waits for that computation without a
    read slot. Never fails: an info without breaks still answers."""
    key = (id(asyncio.get_running_loop()), file, band)
    run = _breaks_runs.get(key)
    if run is None:
        run = _breaks_runs[key] = asyncio.ensure_future(
            _compute_breaks(layer, file, info, band)
        )
        run.add_done_callback(lambda _: _breaks_runs.pop(key, None))
    # A caller that goes away leaves the computation to the others.
    return await asyncio.shield(run)


async def _compute_breaks(
    layer: RasterLayer, file: str, info: RasterInfo, band: int
) -> Breaks:
    """Reads the band's sample in one of the layer's read slots, then
    classifies it after releasing it; a failed read gives no breaks and is
    remembered for 30 seconds, for the breaks only."""
    loop = asyncio.get_running_loop()
    try:
        async with _slot(layer.id):
            values = await loop.run_in_executor(
                RASTER_EXECUTOR, raster_service.band_sample, layer, band
            )
    except Exception as error:
        address, text = logged(raster_service.failure_key(layer), error)
        logger.warning(
            "The class breaks of band %d of the raster file %s were not "
            "computed: %s: %s",
            band,
            address,
            type(error).__name__,
            text,
        )
        raster_service.keep_breaks(file, band, {}, complete=False)
        return {}
    breaks, complete = await loop.run_in_executor(
        BREAKS_EXECUTOR, band_breaks, layer, band, values, info
    )
    raster_service.keep_breaks(file, band, breaks, complete)
    return breaks


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
    creates the layer or gives it another address, and asks right after the
    change, so the row is read afresh; the web asks here for a layer stored
    without one."""
    layer = await _layer(collection_id, fresh=True)
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
    v: Annotated[
        str, Query(max_length=64, description="The description's version")
    ] = "",
    tilesize: TileSizeQuery = TileSize.SMALL,
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """Cached as value tiles are: for good when `v` names the layer's values
    version (the colored tiles' description gives it)."""
    try:
        coloring = decode_token(style)
    except TokenError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    layer = await _layer(collection_id)
    version = raster_service.tile_version(layer, style)
    size = int(tilesize)
    etag = _etag(layer.id, version, z, x, y, *_sized(size))
    return await _versioned_tile(
        request,
        layer,
        v,
        etag,
        if_none_match,
        raster_service.tile,
        z,
        x,
        y,
        coloring,
        size,
    )


@router.get(
    "/{collectionId}/raster/tiles",
    summary="Where a raster file's colored tiles are: its bounds, native zoom and version",
    dependencies=[Depends(require_layer_read)],
)
async def raster_tileset(
    request: Request,
    collection_id: Annotated[str, Path(alias="collectionId")],
    tilesize: TileSizeQuery = TileSize.SMALL,
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """OGC tileset metadata of the colored tiles (`_tileset`), read from the
    file's header: no band, no encoding, no statistics. `goat:version` is the
    layer's values version, which the tile link names (`v`) and the coloring
    token joins (`style`): such a tile is cached as value tiles are."""
    size = int(tilesize)
    layer = await _layer(collection_id)
    version = await _read(layer, raster_service.values_version)
    # The default size leaves the link as other clients know it.
    shown: dict[str, int] = {"tilesize": size} if size != TILE_SIZE else {}
    etag = _etag(layer.id, version, urlencode(shown), IMAGE_DESCRIPTION_SHAPE)
    headers = {"Cache-Control": _description_cache(request), "ETag": etag}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    maxzoom, bounds, info = await _read(layer, raster_service.image_tileset, size)
    query = urlencode({**shown, "v": version}, quote_via=quote)
    base_url = str(request.base_url).rstrip("/")
    tiles = f"{base_url}/collections/{layer.id}/raster/tiles"
    return JSONResponse(
        {
            **_tileset(
                f"{layer.id} image",
                "map",
                maxzoom,
                bounds,
                f"{tiles}/{{tileMatrix}}/{{tileCol}}/{{tileRow}}.webp?{query}",
            ),
            "goat:version": version,
            # 8 bit bands drawn as they are (unscaled, without a color table)
            # are the tiles' pixels, and a color table's code is the color
            # only its entry has: a map reads their values there (spec 9.7).
            "goat:bands": {
                "count": info.count,
                "dtype": info.dtype,
                "scaled": info.scaled,
                "color_table": bool(info.color_table),
                "names": list(info.names),
                # The bands that hold values: an alpha band is none.
                "value_bands": list(info.value_bands),
                # The bands marked red, green and blue are the ones an image
                # draws (goatlib `image_bands`).
                "color_interp": list(info.color_interp),
                # Drawn with the file's color table: every entry's color, from
                # which a map reads a pixel's code.
                "palette": palette(info),
            },
        },
        headers=headers,
    )


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
    tilesize: TileSizeQuery = TileSize.SMALL,
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """OGC tileset metadata (`_tileset`) with `goat:values`: the factors of a
    MapLibre `raster-dem` source with the custom encoding that turn a tile's
    codes into values (code 0 is no data), the values' range as a missing
    domain uses it, whether they are whole numbers, and the version. The tile
    link carries the encoding's base and step (shortest round-trip decimals),
    so a tile's address alone fixes its pixels, and the tile size asked for,
    which the native zoom (`maxzoom`) is for."""
    values = _values_of(band, formula)
    size = int(tilesize)
    layer = await _layer(collection_id)
    version = await _read(layer, raster_service.values_version)
    shown: dict[str, str | int] = {
        "f": "webp",
        **({"formula": formula} if formula is not None else {"band": band or 1}),
        "resampling": resampling,
        # The default size leaves the link as other clients know it.
        **({"tilesize": size} if size != TILE_SIZE else {}),
    }
    etag = _etag(layer.id, version, urlencode(shown), VALUES_DESCRIPTION_SHAPE)
    headers = {"Cache-Control": _description_cache(request), "ETag": etag}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    encoding, maxzoom, bounds, names = await _read(
        layer, raster_service.value_tileset, values, size
    )
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
            **_tileset(
                f"{layer.id} values",
                "coverage",
                maxzoom,
                bounds,
                f"{tiles}/{{tileMatrix}}/{{tileRow}}/{{tileCol}}?{query}",
            ),
            "goat:values": {
                "encoding": encoding.factors(),
                "range": list(encoding.range) if encoding.range else None,
                "integer": encoding.integer,
                "version": version,
                # A popup labels values with the file's band names.
                "names": list(names),
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
    tilesize: TileSizeQuery = TileSize.SMALL,
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """Each pixel's code `q = R * 65536 + G * 256 + B` is the value
    `base + q * step`, with the base and step of the address (the description's
    link names them); code 0 is no data, alpha is always 255."""
    values = _values_of(band, formula)
    encoding = _encoding_of(base, step)
    size = int(tilesize)
    layer = await _layer(collection_id)
    shown = f"values:{values.expression}:{resampling}:{f}:{ENCODING_VERSION}"
    version = raster_service.tile_version(layer, shown)
    etag = _etag(layer.id, version, v, base, step, z, x, y, *_sized(size))
    return await _versioned_tile(
        request,
        layer,
        v,
        etag,
        if_none_match,
        raster_service.values,
        z,
        x,
        y,
        values,
        encoding,
        resampling,
        size,
    )


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
