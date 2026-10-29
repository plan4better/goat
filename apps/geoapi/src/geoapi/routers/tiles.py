"""Tiles router for OGC Tiles API endpoints."""

import hashlib
import json
import logging
import time
import uuid
from typing import Annotated, Any, Literal

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
from goatlib.utils.column_types import type_class

from geoapi.dependencies import (
    BBoxDep,
    CqlFilterDep,
    LayerInfoDep,
    PropertiesDep,
    TileMatrixSetIdDep,
    normalize_layer_id,
    reject_unknown_fields,
)
from geoapi.deps.authz import require_layer_read
from geoapi.models import (
    Link,
    StyleJSON,
    TileJSON,
    TileMatrixSetItem,
    TileMatrixSetsResponse,
    TileSet,
)
from geoapi.services.layer_service import layer_service
from geoapi.services.tile_service import tile_service

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-layer version registry for ETag-based caching of dynamic tiles.
#
# Each write (feature create/update/delete, column change) bumps the version
# via bump_layer_version().  The tile endpoint uses get_layer_version() to
# build a cheap ETag and can return 304 when the browser already has the
# latest tile.
#
# PMTiles are immutable files and keep using max-age=3600 without ETags.
# ---------------------------------------------------------------------------
_layer_versions: dict[str, int] = {}
_version_counter = int(time.time())


def bump_layer_version(layer_id: str) -> None:
    """Increment the version for a layer after a data write."""
    global _version_counter
    _version_counter += 1
    _layer_versions[layer_id.replace("-", "")] = _version_counter


def get_layer_version(layer_id: str) -> int:
    """Return current version for a layer (0 if never bumped)."""
    return _layer_versions.get(layer_id.replace("-", ""), 0)


def build_tile_etag_seed(
    layer_id: str,
    layer_ver: int,
    cql_filter: dict[str, Any] | None = None,
    bbox: list[float] | None = None,
    decoration: str | None = None,
    pinned_snapshot_id: int | None = None,
    h3: str | None = None,
) -> str:
    """Build the seed string hashed into a dynamic tile's ETag.

    `layer_ver` is bumped synchronously on write, but the pinned pool's
    snapshot refresh is asynchronous (~1-2s behind). Without
    `pinned_snapshot_id`, a request in that window would render the OLD
    snapshot's data but stamp the NEW version's ETag, so the browser would
    304 against a tile it never actually received.

    When `pinned_snapshot_id` is None (pool unpinned, or an unpinned
    manager), the seed is byte-for-byte what it was before this field
    existed, so existing ETags don't all bust on deploy.
    """
    etag_seed = f"{layer_id}:{layer_ver}"
    if cql_filter:
        etag_seed += f":f={json.dumps(cql_filter, sort_keys=True)}"
    if bbox:
        etag_seed += f":b={bbox}"
    if decoration:
        etag_seed += f":d={decoration}"
    if h3:
        etag_seed += f":h={h3}"
    if pinned_snapshot_id is not None:
        etag_seed += f":s={pinned_snapshot_id}"
    return etag_seed


router = APIRouter(tags=["Tiles"])


def check_h3_request(
    op: str,
    field: str | None,
    columns: list[dict],
    geometry_type: str | None,
) -> None:
    """H3 hexagons group points; a sum or mean needs a numeric field."""
    if not geometry_type or "point" not in geometry_type.lower():
        raise HTTPException(
            status_code=400, detail="H3 hexagons are drawn for point layers only."
        )
    if op == "count":
        return
    types = {c["name"]: c.get("type", "") for c in columns}
    if not field or field not in types:
        raise HTTPException(
            status_code=400, detail=f"h3_value {op} needs a field of the layer."
        )
    if type_class(types[field]) not in ("integer", "number"):
        raise HTTPException(
            status_code=400, detail=f"h3_field {field!r} is not a number."
        )


def tile_feature_ids(ids: str | None, h3: str | None) -> list[str] | None:
    """The features an H3 tile counts (an atlas page's); vector tiles draw
    every feature and filter in the browser."""
    if ids is None:
        return None
    if h3 is None:
        raise HTTPException(status_code=400, detail="ids applies to H3 tiles only.")
    return ids.split(",")


async def _h3_tile_response(
    *,
    layer_info: Any,
    z: int,
    x: int,
    y: int,
    resolution: str,
    op: str,
    field: str | None,
    columns: list[dict],
    geometry_column: str,
    geometry_type: str | None,
    cql_filter: dict[str, Any] | None,
    bbox: list[float] | None,
    ids: list[str] | None,
    headers: dict[str, str],
    start_time: float,
) -> Response:
    check_h3_request(op, field, columns, geometry_type)
    try:
        tile = await tile_service.get_h3_tile(
            layer_info=layer_info,
            z=z,
            x=x,
            y=y,
            resolution=resolution,
            op=op,
            field=field if op != "count" else None,
            column_names=[c["name"] for c in columns],
            geometry_column=geometry_column,
            cql_filter=cql_filter,
            bbox=bbox,
            ids=ids,
        )
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"H3 tile query timeout for z={z}, x={x}, y={y}.",
        )
    headers = {
        **headers,
        "X-Tile-Source": "h3",
        "X-Response-Time": f"{(time.monotonic() - start_time) * 1000:.1f}ms",
    }
    if not tile:
        return Response(status_code=204, headers=headers)
    return Response(
        content=tile, media_type="application/vnd.mapbox-vector-tile", headers=headers
    )


async def _reject_unknown_tile_properties(
    collection_id: str, layer_id: str, properties: list[str] | None
) -> None:
    """Validate `?properties=` on every tile path, PMTiles included.

    The same request must not 400 on the dynamic path and 200 from PMTiles:
    a validation that fires on one path only teaches callers the wrong
    contract. The column list comes from the shared layer-metadata cache —
    keyed by layer id, written by `get_layer_metadata` and dropped by the same
    write hooks the dynamic path relies on, so this sees exactly what the
    dynamic path would see. A cache miss resolves the layer once and warms
    that entry, so the fast path pays a lookup per layer, not per tile, and
    only for requests that carry `?properties=` at all.

    An unresolvable layer returns without raising: the paths below produce the
    404 for it.
    """
    if not properties:
        return

    metadata = layer_service.cached_metadata(layer_id)
    if metadata is None:
        from geoapi.dependencies import get_layer_info

        try:
            layer_info = await get_layer_info(collection_id)
        except HTTPException:
            return
        metadata = await layer_service.get_layer_metadata(layer_info)
    if metadata is None:
        return

    reject_unknown_fields(
        column_names=metadata.column_names,
        properties=properties,
        geometry_column=metadata.geometry_column or "geometry",
    )


def _pmtiles_tile_response(
    result: tuple[bytes, bool, str], request_id: str, start_time: float
) -> Response:
    """The response for a tile read from PMTiles (204 when it is empty)."""
    tile_data, is_gzip, source = result
    elapsed_ms = (time.monotonic() - start_time) * 1000
    if not tile_data:
        return Response(
            status_code=204,
            headers={
                "X-Request-ID": request_id,
                "X-Response-Time": f"{elapsed_ms:.1f}ms",
            },
        )
    headers = {
        "Cache-Control": "public, max-age=3600",
        "X-Tile-Source": source,
        "X-Request-ID": request_id,
        "X-Response-Time": f"{elapsed_ms:.1f}ms",
    }
    if is_gzip:
        headers["Content-Encoding"] = "gzip"
    return Response(
        content=tile_data,
        media_type="application/vnd.mapbox-vector-tile",
        headers=headers,
    )


@router.get(
    "/collections/{collectionId}/tiles/{tileMatrixSetId}/{z}/{x}/{y}",
    summary="Get vector tile",
    response_class=Response,
    responses={
        200: {
            "content": {"application/vnd.mapbox-vector-tile": {}},
            "description": "Mapbox Vector Tile",
        },
        204: {"description": "Empty tile"},
        404: {"description": "Collection not found"},
        504: {"description": "Query timeout"},
    },
    dependencies=[Depends(require_layer_read)],
)
async def get_tile(
    request: Request,
    collection_id: Annotated[str, Path(alias="collectionId")],
    tileMatrixSetId: TileMatrixSetIdDep,
    z: int = Path(..., ge=0, le=24, description="Zoom level"),
    x: int = Path(..., ge=0, description="Tile column"),
    y: int = Path(..., ge=0, description="Tile row"),
    properties: PropertiesDep = None,
    cql_filter: CqlFilterDep = None,
    bbox: BBoxDep = None,
    limit: int = Query(default=None, ge=1, le=100000, description="Max features"),
    label: bool = Query(
        default=False,
        description="Merge polygon label anchor points into tile response",
    ),
    decoration: Literal["start", "end", "start_and_end", "center"] | None = Query(
        default=None,
        description="If set, emit per-line decoration placement points + bearings in a separate MVT layer.",
    ),
    dynamic: bool = Query(
        default=False, description="Force dynamic tile generation, bypassing PMTiles"
    ),
    h3: str | None = Query(
        default=None,
        pattern=r"^(auto|[5-9]|10)$",
        description="Draw a point layer as H3 hexagons of this resolution (5 to 10, "
        'or "auto" from the zoom) in an MVT layer `h3`, instead of its features.',
    ),
    h3_value: Literal["count", "sum", "mean"] = Query(
        default="count",
        description="A hexagon's value: its points, or the sum or mean of h3_field.",
    ),
    h3_field: str | None = Query(
        default=None, description="The numeric field h3_value sums or averages."
    ),
    ids: str | None = Query(
        default=None,
        pattern=r"^\d+(,\d+)*$",
        description="H3 tiles only: count only these features (comma-separated ids).",
    ),
    temp: bool = Query(
        default=False,
        description="The collection is a workflow result (temporary layer)",
    ),
    if_none_match: str | None = Header(default=None, alias="if-none-match"),
) -> Response:
    """Get a vector tile for the specified collection and tile coordinates."""
    request_id = str(uuid.uuid4())[:8]
    start_time = time.monotonic()
    feature_ids = tile_feature_ids(ids, h3)

    # Ultra-fast path: Try PMTiles by layer_id without ANY database lookup
    # This completely bypasses DuckDB schema lookup for cached tile serving
    try:
        layer_id = normalize_layer_id(collection_id)
    except HTTPException:
        raise HTTPException(
            status_code=400, detail=f"Invalid collection ID: {collection_id}"
        )

    await _reject_unknown_tile_properties(collection_id, layer_id, properties)

    # Try ultra-fast PMTiles path first (wrapped in try-except to ensure fallback)
    try:
        if (
            not dynamic
            and decoration is None
            and h3 is None
            and tile_service.can_serve_from_pmtiles_by_layer_id(
                layer_id, cql_filter, bbox
            )
        ):
            result = await tile_service.get_tile_from_pmtiles_by_layer_id(
                layer_id=layer_id,
                z=z,
                x=x,
                y=y,
                label=label,
                search_temp=temp,
            )
            if result is not None:
                return _pmtiles_tile_response(result, request_id, start_time)
    except Exception as e:
        # Log but continue to fallback path
        logger.warning("Ultra-fast PMTiles path failed for %s: %s", layer_id, e)

    # Slow path: Need full layer info for dynamic tile generation
    # Import here to avoid circular dependency and delay the slow lookup
    from geoapi.dependencies import get_layer_info

    try:
        layer_info = await get_layer_info(collection_id)
    except HTTPException as e:
        # No layer by that id: it may be a workflow result, whose tiles sit
        # in the workflow temp tree. Searching that tree is expensive, so it
        # happens here, for ids that are no layer, instead of for every layer
        # without tiles. Already done above when the client said `temp`.
        if (
            e.status_code != 404
            or temp
            or dynamic
            or decoration is not None
            or not tile_service.can_serve_from_pmtiles_by_layer_id(
                layer_id, cql_filter, bbox
            )
        ):
            raise
        result = await tile_service.get_tile_from_pmtiles_by_layer_id(
            layer_id=layer_id, z=z, x=x, y=y, label=label, search_temp=True
        )
        if result is None:
            raise
        return _pmtiles_tile_response(result, request_id, start_time)

    # Check if we can still use PMTiles with layer_info (redundant but safe)
    if (
        not dynamic
        and decoration is None
        and h3 is None
        and tile_service.can_serve_from_pmtiles(layer_info, cql_filter, bbox)
    ):
        result = await tile_service.get_tile_from_pmtiles_only(
            layer_info=layer_info,
            z=z,
            x=x,
            y=y,
            label=label,
        )
        if result is not None:
            tile_data, is_gzip, source = result
            if not tile_data:
                return Response(status_code=204)
            headers = {
                "Cache-Control": "public, max-age=3600",
                "X-Tile-Source": source,
            }
            if is_gzip:
                headers["Content-Encoding"] = "gzip"
            return Response(
                content=tile_data,
                media_type="application/vnd.mapbox-vector-tile",
                headers=headers,
            )

    # Dynamic tile generation path
    metadata = await layer_service.get_layer_metadata(layer_info)

    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    if not metadata.has_geometry:
        raise HTTPException(status_code=400, detail="Collection has no geometry column")

    # Only the dynamic path splices `properties` into SQL; the PMTiles paths
    # above ignore it (a tileset carries all its properties) and return
    # before any column list is resolved.
    reject_unknown_fields(
        column_names=metadata.column_names,
        properties=properties,
        geometry_column=metadata.geometry_column or "geometry",
    )

    # --- ETag check: skip tile generation if client already has current version ---
    from geoapi.ducklake_pool import ducklake_pool

    layer_ver = get_layer_version(layer_id)
    # Include filter/bbox/pinned-snapshot in the ETag so different queries
    # are cached separately and a pre-refresh tile isn't served with a
    # post-write ETag (see build_tile_etag_seed docstring).
    etag_seed = build_tile_etag_seed(
        layer_id,
        layer_ver,
        cql_filter=cql_filter,
        bbox=bbox,
        decoration=decoration,
        pinned_snapshot_id=ducklake_pool.pinned_snapshot_id,
        h3=f"{h3}:{h3_value}:{h3_field or ''}{f':i={ids}' if ids else ''}"
        if h3
        else None,
    )
    etag = f'W/"{hashlib.md5(etag_seed.encode()).hexdigest()[:16]}"'

    if if_none_match and if_none_match.strip() == etag:
        elapsed_ms = (time.monotonic() - start_time) * 1000
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Cache-Control": "no-cache",
                "X-Request-ID": request_id,
                "X-Response-Time": f"{elapsed_ms:.1f}ms",
            },
        )

    columns = metadata.columns
    geometry_column = metadata.geometry_column or "geometry"

    if h3 is not None:
        return await _h3_tile_response(
            layer_info=layer_info,
            z=z,
            x=x,
            y=y,
            resolution=h3,
            op=h3_value,
            field=h3_field,
            columns=columns,
            geometry_column=geometry_column,
            geometry_type=metadata.geometry_type,
            cql_filter=cql_filter,
            bbox=bbox,
            ids=feature_ids,
            headers={
                "ETag": etag,
                "Cache-Control": "no-cache",
                "X-Request-ID": request_id,
            },
            start_time=start_time,
        )

    try:
        # Get tile - the service handles threading internally for sync operations
        result = await tile_service.get_tile(
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
            geometry_type=metadata.geometry_type,
            force_dynamic=dynamic,
            decoration=decoration,
        )
    except TimeoutError:
        # Query exceeded timeout - return 504 Gateway Timeout
        raise HTTPException(
            status_code=504,
            detail=f"Tile query timeout for z={z}, x={x}, y={y}. Try a higher zoom level or smaller area.",
        )

    if not result:
        elapsed_ms = (time.monotonic() - start_time) * 1000
        return Response(
            status_code=204,
            headers={
                "ETag": etag,
                "Cache-Control": "no-cache",
                "X-Request-ID": request_id,
                "X-Response-Time": f"{elapsed_ms:.1f}ms",
            },
        )

    tile_data, is_gzip, source = result
    elapsed_ms = (time.monotonic() - start_time) * 1000
    headers = {
        "Cache-Control": "no-cache",
        "ETag": etag,
        "X-Tile-Source": source,
        "X-Request-ID": request_id,
        "X-Response-Time": f"{elapsed_ms:.1f}ms",
    }
    if is_gzip:
        headers["Content-Encoding"] = "gzip"

    return Response(
        content=tile_data,
        media_type="application/vnd.mapbox-vector-tile",
        headers=headers,
    )


@router.get(
    "/collections/{collectionId}/tiles",
    summary="List available tilesets",
    response_model=list[TileSet],
)
async def list_tilesets(
    request: Request,
    layer_info: LayerInfoDep,
) -> list[TileSet]:
    """List available tile matrix sets for a collection."""
    base_url = str(request.base_url).rstrip("/")
    collection_id = layer_info.layer_id

    tilesets = []
    for tms_id in ["WebMercatorQuad", "WorldCRS84Quad"]:
        tilesets.append(
            TileSet(
                title=f"{collection_id} - {tms_id}",
                tileMatrixSetURI=f"http://www.opengis.net/def/tilematrixset/OGC/1.0/{tms_id}",
                dataType="vector",
                links=[
                    Link(
                        href=f"{base_url}/collections/{collection_id}/tiles/{tms_id}",
                        rel="self",
                        type="application/json",
                    ),
                    Link(
                        href=f"{base_url}/collections/{collection_id}/tiles/{tms_id}/{{z}}/{{x}}/{{y}}",
                        rel="item",
                        type="application/vnd.mapbox-vector-tile",
                        templated=True,
                    ),
                ],
            )
        )
    return tilesets


@router.get(
    "/collections/{collectionId}/tiles/{tileMatrixSetId}",
    summary="Get tileset metadata",
    response_model=TileSet,
)
async def get_tileset(
    request: Request,
    layer_info: LayerInfoDep,
    tileMatrixSetId: TileMatrixSetIdDep,
) -> TileSet:
    """Get tileset metadata for a collection."""
    base_url = str(request.base_url).rstrip("/")
    collection_id = layer_info.layer_id

    return TileSet(
        title=f"{collection_id} - {tileMatrixSetId}",
        tileMatrixSetURI=f"http://www.opengis.net/def/tilematrixset/OGC/1.0/{tileMatrixSetId}",
        dataType="vector",
        links=[
            Link(
                href=f"{base_url}/collections/{collection_id}/tiles/{tileMatrixSetId}",
                rel="self",
                type="application/json",
            ),
            Link(
                href=f"{base_url}/collections/{collection_id}/tiles/{tileMatrixSetId}/{{z}}/{{x}}/{{y}}",
                rel="item",
                type="application/vnd.mapbox-vector-tile",
                templated=True,
            ),
            Link(
                href=f"{base_url}/collections/{collection_id}/tiles/{tileMatrixSetId}/tilejson.json",
                rel="describedby",
                type="application/json",
                title="TileJSON",
            ),
        ],
    )


@router.get(
    "/collections/{collectionId}/tiles/{tileMatrixSetId}/tilejson.json",
    summary="Get TileJSON",
    response_model=TileJSON,
    dependencies=[Depends(require_layer_read)],
)
async def get_tilejson(
    request: Request,
    layer_info: LayerInfoDep,
    tileMatrixSetId: TileMatrixSetIdDep,
    minzoom: int = Query(default=0, ge=0, le=24),
    maxzoom: int = Query(default=22, ge=0, le=24),
) -> TileJSON:
    """Get TileJSON document for a collection."""
    metadata = await layer_service.get_layer_metadata(layer_info)
    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    base_url = str(request.base_url).rstrip("/")
    collection_id = layer_info.layer_id

    # Build vector layer fields
    fields = {}
    for col in metadata.columns:
        if col["name"] not in ("geom", "geometry"):
            fields[col["name"]] = col["json_type"]

    vector_layers = [
        {
            "id": "default",
            "fields": fields,
            "minzoom": minzoom,
            "maxzoom": maxzoom,
        }
    ]

    # Build tile URL with query params
    tile_url = f"{base_url}/collections/{collection_id}/tiles/{tileMatrixSetId}/{{z}}/{{x}}/{{y}}"

    # Forward query parameters to tile URL
    query_params = []
    for key, value in request.query_params.items():
        if key not in ("minzoom", "maxzoom"):
            query_params.append(f"{key}={value}")
    if query_params:
        tile_url += "?" + "&".join(query_params)

    return TileJSON(
        name=metadata.name,
        tiles=[tile_url],
        vector_layers=vector_layers,
        minzoom=minzoom,
        maxzoom=maxzoom,
        bounds=metadata.bounds,
        center=[
            (metadata.bounds[0] + metadata.bounds[2]) / 2,
            (metadata.bounds[1] + metadata.bounds[3]) / 2,
            0,
        ],
    )


@router.get(
    "/collections/{collectionId}/tiles/{tileMatrixSetId}/style.json",
    summary="Get StyleJSON",
    response_model=StyleJSON,
    dependencies=[Depends(require_layer_read)],
)
async def get_stylejson(
    request: Request,
    layer_info: LayerInfoDep,
    tileMatrixSetId: TileMatrixSetIdDep,
    minzoom: int = Query(default=0, ge=0, le=24),
    maxzoom: int = Query(default=22, ge=0, le=24),
) -> StyleJSON:
    """Get MapLibre StyleJSON document for a collection."""
    metadata = await layer_service.get_layer_metadata(layer_info)
    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    base_url = str(request.base_url).rstrip("/")
    collection_id = layer_info.layer_id

    tile_url = f"{base_url}/collections/{collection_id}/tiles/{tileMatrixSetId}/{{z}}/{{x}}/{{y}}"

    # Create style layers based on geometry type
    layers = []
    geom_type = (metadata.geometry_type or "polygon").lower()

    if geom_type in ("polygon", "multipolygon"):
        layers.append(
            {
                "id": f"{collection_id}_fill",
                "source": collection_id,
                "source-layer": "default",
                "type": "fill",
                "paint": {
                    "fill-color": "rgba(200, 100, 240, 0.4)",
                    "fill-outline-color": "#000",
                },
            }
        )
    elif geom_type in ("linestring", "multilinestring", "line"):
        layers.append(
            {
                "id": f"{collection_id}_line",
                "source": collection_id,
                "source-layer": "default",
                "type": "line",
                "paint": {
                    "line-color": "#000",
                    "line-width": 2,
                },
            }
        )
    elif geom_type in ("point", "multipoint"):
        layers.append(
            {
                "id": f"{collection_id}_circle",
                "source": collection_id,
                "source-layer": "default",
                "type": "circle",
                "paint": {
                    "circle-color": "#3388ff",
                    "circle-radius": 5,
                    "circle-stroke-color": "#fff",
                    "circle-stroke-width": 1,
                },
            }
        )
    else:
        # Generic layers for unknown geometry
        layers.extend(
            [
                {
                    "id": f"{collection_id}_fill",
                    "source": collection_id,
                    "source-layer": "default",
                    "type": "fill",
                    "filter": ["==", ["geometry-type"], "Polygon"],
                    "paint": {"fill-color": "rgba(200, 100, 240, 0.4)"},
                },
                {
                    "id": f"{collection_id}_line",
                    "source": collection_id,
                    "source-layer": "default",
                    "type": "line",
                    "filter": ["==", ["geometry-type"], "LineString"],
                    "paint": {"line-color": "#000", "line-width": 2},
                },
                {
                    "id": f"{collection_id}_circle",
                    "source": collection_id,
                    "source-layer": "default",
                    "type": "circle",
                    "filter": ["==", ["geometry-type"], "Point"],
                    "paint": {"circle-color": "#3388ff", "circle-radius": 5},
                },
            ]
        )

    return StyleJSON(
        name=metadata.name,
        sources={
            collection_id: {
                "type": "vector",
                "tiles": [tile_url],
                "minzoom": minzoom,
                "maxzoom": maxzoom,
                "bounds": metadata.bounds,
            }
        },
        layers=layers,
        center=[
            (metadata.bounds[0] + metadata.bounds[2]) / 2,
            (metadata.bounds[1] + metadata.bounds[3]) / 2,
        ],
        zoom=0,
    )


@router.get(
    "/tileMatrixSets",
    summary="List tile matrix sets",
    response_model=TileMatrixSetsResponse,
)
async def list_tile_matrix_sets(request: Request) -> TileMatrixSetsResponse:
    """List available tile matrix sets."""
    base_url = str(request.base_url).rstrip("/")

    return TileMatrixSetsResponse(
        tileMatrixSets=[
            TileMatrixSetItem(
                id="WebMercatorQuad",
                title="Web Mercator Quad",
                links=[
                    Link(
                        href=f"{base_url}/tileMatrixSets/WebMercatorQuad",
                        rel="self",
                        type="application/json",
                    )
                ],
            ),
            TileMatrixSetItem(
                id="WorldCRS84Quad",
                title="World CRS84 Quad",
                links=[
                    Link(
                        href=f"{base_url}/tileMatrixSets/WorldCRS84Quad",
                        rel="self",
                        type="application/json",
                    )
                ],
            ),
        ]
    )


@router.get(
    "/tileMatrixSets/{tileMatrixSetId}",
    summary="Get tile matrix set",
)
async def get_tile_matrix_set(
    request: Request,
    tileMatrixSetId: TileMatrixSetIdDep,
) -> dict:
    """Get tile matrix set definition."""
    # Return basic TMS info (full OGC TMS definition would be much larger)
    tms_info = {
        "WebMercatorQuad": {
            "id": "WebMercatorQuad",
            "title": "Web Mercator Quad",
            "uri": "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad",
            "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
            "wellKnownScaleSet": "http://www.opengis.net/def/wkss/OGC/1.0/GoogleMapsCompatible",
        },
        "WorldCRS84Quad": {
            "id": "WorldCRS84Quad",
            "title": "World CRS84 Quad",
            "uri": "http://www.opengis.net/def/tilematrixset/OGC/1.0/WorldCRS84Quad",
            "crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
            "wellKnownScaleSet": "http://www.opengis.net/def/wkss/OGC/1.0/GoogleCRS84Quad",
        },
    }

    return tms_info.get(tileMatrixSetId, {})
