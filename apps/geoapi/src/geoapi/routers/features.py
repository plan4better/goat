"""Features router for OGC Features API endpoints."""

import asyncio
import gzip
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time
from functools import partial
from typing import Annotated, Any, Optional
from uuid import UUID

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

from geoapi.dependencies import (
    BBoxDep,
    CqlFilterDep,
    LayerInfoDep,
    LimitDep,
    OffsetDep,
    PropertiesDep,
    reject_unknown_fields,
    unknown_requested_fields,
)
from geoapi.deps.auth import get_optional_user_id
from geoapi.deps.authz import require_layer_read, require_layer_read_unless_temp
from geoapi.ducklake_pool import ducklake_pool
from geoapi.http_cache import apply_cache_headers, build_query_etag, not_modified
from geoapi.models import Feature, Link
from geoapi.routers.tiles import get_layer_version
from geoapi.services.feature_service import feature_service
from geoapi.services.layer_service import layer_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Features"])

# Feature queries hit DuckLake synchronously. Run them in a thread pool so the
# blocking query never freezes the worker's event loop (which would stall every
# concurrent request on the pod, tiles included). Mirrors the tile path's
# run_in_executor offloading. Concurrency is ultimately bounded by the shared
# DuckLake read pool, so a small worker count is sufficient.
_feature_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="feature")

# Mirrors GZipMiddleware's minimum_size: responses below this stay uncompressed.
_GZIP_MIN_SIZE = 1000

# Type alias for optional user ID dependency
OptionalUserIdDep = Annotated[UUID | None, Depends(get_optional_user_id)]


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return str(value)


def _build_items_response(
    features: list[dict[str, Any]],
    total_count: int,
    links: list[dict[str, str]],
    accept_gzip: bool,
) -> Response:
    """Serialize (and compress) an items response.

    Large collections make this CPU-heavy, so it must run in the feature
    executor, never on the event loop. Serialization goes straight from the
    feature dicts to bytes — no Pydantic models and no response_model
    revalidation — and gzip is applied here so GZipMiddleware (which sees the
    Content-Encoding header) passes the response through untouched.
    """
    payload = {
        "type": "FeatureCollection",
        "features": features,
        "links": links,
        "numberMatched": total_count,
        "numberReturned": len(features),
    }
    body = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), default=_json_default
    ).encode("utf-8")
    return _finalize_items_body(body, accept_gzip)


def _build_items_response_from_json(
    features_json: str,
    returned_count: int,
    total_count: int,
    links: list[dict[str, str]],
    accept_gzip: bool,
) -> Response:
    """Assemble an items response around a DuckDB-serialized features fragment.

    `features_json` is the comma-joined Feature objects produced by
    get_features_json; only the envelope is built in Python.
    """
    links_json = json.dumps(links, ensure_ascii=False, separators=(",", ":"))
    body = (
        '{"type":"FeatureCollection","features":['
        + features_json
        + '],"links":'
        + links_json
        + f',"numberMatched":{total_count},"numberReturned":{returned_count}}}'
    ).encode("utf-8")
    return _finalize_items_body(body, accept_gzip)


def _finalize_items_body(body: bytes, accept_gzip: bool) -> Response:
    headers = {}
    if accept_gzip and len(body) >= _GZIP_MIN_SIZE:
        body = gzip.compress(body, compresslevel=6)
        headers["Content-Encoding"] = "gzip"
        headers["Vary"] = "Accept-Encoding"
    return Response(content=body, media_type="application/json", headers=headers)


@router.get(
    "/collections/{collectionId}/items",
    summary="Get features",
    # This route alone has a `?temp=true` branch, so it takes the
    # temp-aware variant — every other route uses plain `require_layer_read`.
    dependencies=[Depends(require_layer_read_unless_temp)],
)
async def get_features(
    request: Request,
    layer_info: LayerInfoDep,
    limit: LimitDep,
    offset: OffsetDep,
    user_id: OptionalUserIdDep = None,
    bbox: BBoxDep = None,
    properties: PropertiesDep = None,
    cql_filter: CqlFilterDep = None,
    ids: Optional[str] = Query(default=None, description="Comma-separated feature IDs"),
    sortby: Optional[str] = Query(
        default=None, description="Sort column (prefix with - for desc)"
    ),
    temp: bool = Query(default=False, description="Serve from temp storage"),
    if_none_match: Optional[str] = Header(default=None, alias="if-none-match"),
) -> Response:
    """Get features from a collection.

    Supports:
    - Pagination with limit/offset
    - Bounding box filtering
    - Property selection
    - CQL2 filtering
    - ID filtering
    - Sorting
    - Temp layer serving via ?temp=true (collection ID is the layer UUID)
    """
    accept_gzip = "gzip" in request.headers.get("accept-encoding", "").lower()
    base_url = str(request.base_url).rstrip("/")
    loop = asyncio.get_event_loop()
    # An empty `properties` asks for features without properties (the browser's
    # clusters when their style reads no field); without the parameter every
    # property is returned.
    if properties is None and "properties" in request.query_params:
        properties = []

    # Handle temp layer serving
    # URL format: /collections/{layer_uuid}/items?temp=true
    if temp:
        if not user_id:
            raise HTTPException(
                status_code=401, detail="Authentication required for temp layers"
            )
        user_id_str = str(user_id)
        layer_uuid = layer_info.layer_id

        def _run_temp() -> Response:
            features, total_count = feature_service.get_temp_features(
                user_id=user_id_str,
                layer_uuid=layer_uuid,
                limit=limit,
                offset=offset,
                bbox=bbox,
                properties=properties,
            )
            links = [
                {
                    "href": f"{base_url}/collections/{layer_uuid}/items?temp=true",
                    "rel": "self",
                    "type": "application/geo+json",
                },
            ]
            return _build_items_response(features, total_count, links, accept_gzip)

        return await loop.run_in_executor(_feature_executor, _run_temp)

    # Standard layer serving. Revalidation happens BEFORE any DuckLake work:
    # a matching ETag skips the query and the (potentially multi-MB) payload.
    # Temp layers above are excluded — they have no version/snapshot lifecycle.
    etag = build_query_etag(
        layer_info.layer_id,
        get_layer_version(layer_info.layer_id),
        ducklake_pool.pinned_snapshot_id,
        params={
            "limit": limit,
            "offset": offset,
            "bbox": bbox,
            "properties": properties,
            "filter": cql_filter,
            "ids": ids,
            "sortby": sortby,
        },
    )
    if cached := not_modified(if_none_match, etag):
        return cached

    # Get layer metadata
    logger.debug("Getting features for layer_info: %s", layer_info)
    metadata = await layer_service.get_layer_metadata(layer_info)
    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    column_names = metadata.column_names
    geometry_column = metadata.geometry_column or "geometry"
    has_geometry = metadata.has_geometry
    logger.debug(
        "Layer %s: columns=%s, geometry_column=%s, has_geometry=%s",
        layer_info.layer_id,
        column_names,
        geometry_column,
        has_geometry,
    )

    # Requested properties the collection lacks are left out: a style can name a
    # field its dataset no longer has, and its points must still load.
    if properties:
        unknown = set(
            unknown_requested_fields(
                column_names=column_names,
                properties=properties,
                geometry_column=geometry_column,
            )
        )
        properties = [p for p in properties if p not in unknown]

    reject_unknown_fields(
        column_names=column_names,
        properties=properties,
        sortby=sortby,
        geometry_column=geometry_column,
    )

    # Parse IDs
    id_list = None
    if ids:
        id_list = [id.strip() for id in ids.split(",")]

    collection_id = layer_info.layer_id
    native_column_types = metadata.native_column_types

    def _run() -> Response:
        features_json, returned_count, total_count = feature_service.get_features_json(
            layer_info=layer_info,
            limit=limit,
            offset=offset,
            bbox=bbox,
            properties=properties,
            cql_filter=cql_filter,
            column_names=column_names,
            sortby=sortby,
            ids=id_list,
            geometry_column=geometry_column,
            has_geometry=has_geometry,
            native_column_types=native_column_types,
        )

        # Document-level links only. Per-feature links are intentionally
        # omitted: OGC API Features Core requires them on the single-feature
        # resource (/req/core/f-links), not on features inside the items
        # response, and they roughly double the payload for wide collections.
        links = [
            {
                "href": f"{base_url}/collections/{collection_id}/items",
                "rel": "self",
                "type": "application/geo+json",
            },
            {
                "href": f"{base_url}/collections/{collection_id}",
                "rel": "collection",
                "type": "application/json",
            },
        ]
        if offset + limit < total_count:
            next_offset = offset + limit
            links.append(
                {
                    "href": f"{base_url}/collections/{collection_id}/items?limit={limit}&offset={next_offset}",
                    "rel": "next",
                    "type": "application/geo+json",
                    "title": "Next page",
                }
            )
        if offset > 0:
            prev_offset = max(0, offset - limit)
            links.append(
                {
                    "href": f"{base_url}/collections/{collection_id}/items?limit={limit}&offset={prev_offset}",
                    "rel": "prev",
                    "type": "application/geo+json",
                    "title": "Previous page",
                }
            )

        response = _build_items_response_from_json(
            features_json, returned_count, total_count, links, accept_gzip
        )
        apply_cache_headers(response, etag)
        return response

    return await loop.run_in_executor(_feature_executor, _run)


@router.get(
    "/collections/{collectionId}/items/{itemId}",
    summary="Get feature by ID",
    response_model=Feature,
    dependencies=[Depends(require_layer_read)],
)
async def get_feature(
    request: Request,
    response: Response,
    layer_info: LayerInfoDep,
    itemId: str = Path(..., description="Feature ID"),
    properties: PropertiesDep = None,
    if_none_match: Optional[str] = Header(default=None, alias="if-none-match"),
) -> Feature | Response:
    """Get a single feature by ID."""
    etag = build_query_etag(
        layer_info.layer_id,
        get_layer_version(layer_info.layer_id),
        ducklake_pool.pinned_snapshot_id,
        params={"item": itemId, "properties": properties},
    )
    if cached := not_modified(if_none_match, etag):
        return cached

    # Get layer metadata
    metadata = await layer_service.get_layer_metadata(layer_info)
    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    geometry_column = metadata.geometry_column or "geometry"
    has_geometry = metadata.has_geometry

    reject_unknown_fields(
        column_names=metadata.column_names,
        properties=properties,
        geometry_column=geometry_column,
    )

    # Get feature
    loop = asyncio.get_event_loop()
    feature = await loop.run_in_executor(
        _feature_executor,
        partial(
            feature_service.get_feature_by_id,
            layer_info=layer_info,
            feature_id=itemId,
            properties=properties,
            geometry_column=geometry_column,
            has_geometry=has_geometry,
            column_names=metadata.column_names,
            native_column_types=metadata.native_column_types,
        ),
    )

    if not feature:
        raise HTTPException(status_code=404, detail="Feature not found")

    # Build links
    base_url = str(request.base_url).rstrip("/")
    collection_id = layer_info.layer_id

    links = [
        Link(
            href=f"{base_url}/collections/{collection_id}/items/{itemId}",
            rel="self",
            type="application/geo+json",
        ),
        Link(
            href=f"{base_url}/collections/{collection_id}",
            rel="collection",
            type="application/json",
        ),
    ]

    apply_cache_headers(response, etag)
    return Feature(
        id=feature["id"],
        geometry=feature["geometry"],
        properties=feature["properties"],
        links=links,
    )
