"""The full ``/stac`` HTTP surface: STAC API + GOAT extensions.

STAC API is OGC API - Features plus the STAC object model and Item Search.
This router is pure wiring: every handler delegates to the Task 3-8 modules
(``catalog.store``, ``catalog.services.search/cql/queryables/aggregations/
stac_build``) for anything data- or SQL-shaped, and only builds request
parsing + response envelopes + pagination links itself (the parts genuinely
specific to HTTP), following the pagination-link-helper layout of the
reference router (``cyrine/catalog-harvester:apps/geoapi/.../routers/stac.py``).

Endpoints (api spec §2):
- ``GET /stac``                                     landing Catalog
- ``GET /stac/conformance``
- ``GET /stac/queryables`` · ``GET /stac/collections/{cid}/queryables``
- ``GET /stac/collections``                          Collection Search (browse level)
- ``GET /stac/collections/{cid}``
- ``GET /stac/collections/{cid}/items`` · ``.../items/{item_id}``
- ``GET|POST /stac/search``                          cross-collection Item Search
- ``GET /stac/aggregations`` · ``GET /stac/aggregate``
- ``GET /stac/resolve/{entry_id}`` · ``GET /stac/items/{item_id}``  (GOAT extensions)

Every GET response gets an ``ETag``/``Cache-Control`` pair from the
app-level middleware (``catalog.app``). These are **public read paths**
(design S1/S14): ``catalog.auth.optional_auth`` lets an anonymous request
through and still rejects a malformed token, so the GOAT UI's public catalog
page works with no credentials.
"""

from typing import Annotated, Any, Literal
from urllib.parse import urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from goatlib.api import DEFAULT_OPENAPI_URL
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from catalog.auth import optional_auth
from catalog.deps import check_not_modified, get_preview_reader, get_store
from catalog.errors import ApiError
from catalog.limits import MAX_LIST_LIMIT, MAX_SEARCH_LIMIT, clamp_limit
from catalog.routers.params import (
    AggregateQuery,
    CollectionSearchQuery,
    ItemsQuery,
    SearchQuery,
    reject_get_encodings,
)
from catalog.services import capabilities, stac_build
from catalog.services.aggregations import (
    AggregationCollection,
    AggregationsDiscovery,
    available_aggregations,
    run_aggregations,
)
from catalog.services.preview import PreviewReader
from catalog.services.queryables import queryables_schema
from catalog.services.search import (
    SearchParams,
    collection_ids,
    get_collection_row,
    resolve_id,
    search_collections,
    search_items,
)
from catalog.store import CatalogStore

# Order matters: optional_auth MUST run before check_not_modified so a
# conditional GET's If-None-Match can never short-circuit past the auth gate
# (see catalog.deps.check_not_modified's docstring).
# Handlers are plain `def` on purpose: every one of them runs a synchronous
# DuckDB scan, and an `async def` would run that scan on the event loop, where
# one slow aggregation freezes every other request — not even a 304 check gets
# through. A plain `def` runs in Starlette's threadpool instead; the store is
# built for that (a cursor per call). The POST search is the one exception,
# because it awaits the raw body, so it offloads its scan explicitly.

router = APIRouter(
    prefix="/stac",
    tags=["STAC"],
    dependencies=[Depends(optional_auth), Depends(check_not_modified)],
)

_SCHEMA_JSON = "application/schema+json"


def _documents(model: type[BaseModel]) -> dict[int | str, dict[str, Any]]:
    """OpenAPI schema for a 200 response, without validating through it.

    The handlers build plain dicts and must serve them byte-for-byte -- a
    ``response_model`` would re-serialize every response through pydantic,
    which is both a per-request cost and a chance to silently drop a member the
    catalog publisher wrote. Declaring the model here documents the shape
    (Swagger and generated clients see it) while leaving the response alone.

    The media type is not named here: it follows the route's
    ``response_class``, so the documented schema cannot end up filed under a
    content type the endpoint never serves.
    """
    return {200: {"model": model}}


class GeoJSONResponse(JSONResponse):
    """A GeoJSON Feature/FeatureCollection response (OGC API - Features core
    requires ``application/geo+json``, not the default ``application/json``
    FastAPI would otherwise serve every ``dict`` return value as)."""

    media_type = "application/geo+json"


class JSONSchemaResponse(JSONResponse):
    """A JSON Schema document (``/queryables``), which OGC API - Features
    Part 3 requires be served as ``application/schema+json``."""

    media_type = _SCHEMA_JSON


# --------------------------------------------------------------------------
# Request/response helpers
# --------------------------------------------------------------------------


def _base_url(request: Request) -> str:
    """This API's own origin, as the caller reached it.

    ``request.base_url`` takes the host from the ``Host`` header but the scheme
    from the connection, and TLS terminates at the ingress -- so behind one the
    scheme is ``http`` while the browser is on ``https``. Every absolute href
    this service emits runs through here, and an ``http`` asset href is fetched
    from an ``https`` page as active mixed content, which the browser blocks.

    ``X-Forwarded-Proto`` is the original scheme. It is read here rather than
    left to the ASGI server's proxy handling, which trusts only ``127.0.0.1``
    unless ``FORWARDED_ALLOW_IPS`` names the proxy, so the correct scheme does
    not depend on how the container was launched. Only the first value counts
    (each proxy appends), and only the two schemes this API is served over.
    """
    base = str(request.base_url).rstrip("/")
    forwarded = (
        request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    )
    if forwarded in ("http", "https"):
        return urlunsplit(urlsplit(base)._replace(scheme=forwarded))
    return base


def _stac_base(request: Request) -> str:
    return f"{_base_url(request)}/stac"


def _assets_base(request: Request) -> str:
    """This API's own asset base, derived from the request like every other base.

    A sibling of ``/stac`` rather than a path inside it: the assets route is not
    a STAC endpoint. Derived rather than configured so a served thumbnail href is
    right on localhost and behind the ingress with nothing set -- the one case
    that would need a setting is a CDN in front, which is a change here and
    nowhere else.
    """
    return f"{_base_url(request)}/assets"


def _ui_base(request: Request) -> str:
    """The GOAT web app's base URL, for the served items' "Open in GOAT" link.

    Read off the app's settings rather than the request, since it points at a
    different service than the one answering this call.
    """
    return str(request.app.state.settings.goat_ui_base_url)


def _paged_href(request: Request, offset: int, limit: int) -> str:
    """A same-path GET href carrying every one of the request's original
    query params, with only ``offset``/``limit`` replaced.

    Building pagination hrefs from a hardcoded ``{base}/search``-style
    string would silently drop every other filter (``q``, ``bbox``,
    ``filter``, ...) -- following a ``next`` link would then return
    unfiltered results, and ``self`` wouldn't round-trip. Reading the
    params back off ``request`` instead makes every filter survive.
    """
    kept = [
        (k, v)
        for k, v in request.query_params.multi_items()
        if k not in ("offset", "limit")
    ]
    kept.append(("offset", str(offset)))
    kept.append(("limit", str(limit)))
    path_url = f"{_base_url(request)}{request.url.path}"
    query = urlencode(kept)
    return f"{path_url}?{query}" if query else path_url


def _root_href(request: Request) -> str:
    return _stac_base(request)


def _self_href(request: Request) -> str:
    """The literal incoming request URL, verbatim.

    Reconstructing this from ``_paged_href`` would inject an explicit
    ``offset``/``limit`` even when the caller never sent them (e.g. a bare
    ``GET /stac/collections``), so ``self`` would no longer match the
    requested URL -- a conformance requirement (and what
    ``stac-api-validator`` checks) for every navigable resource.
    """
    return str(request.url)


def _page_links(
    request: Request, limit: int, offset: int, matched: int
) -> list[dict[str, Any]]:
    """root/first/self/next/prev links for a Collection Search-style listing."""
    links: list[dict[str, Any]] = [
        {"rel": "root", "type": "application/json", "href": _root_href(request)},
        {
            "rel": "self",
            "type": "application/json",
            "href": _self_href(request),
        },
        {
            "rel": "first",
            "type": "application/json",
            "href": _paged_href(request, 0, limit),
        },
    ]
    if offset + limit < matched:
        links.append(
            {
                "rel": "next",
                "type": "application/json",
                "href": _paged_href(request, offset + limit, limit),
            }
        )
    if offset > 0:
        links.append(
            {
                "rel": "prev",
                "type": "application/json",
                "href": _paged_href(request, max(0, offset - limit), limit),
            }
        )
    return links


def _next_prev_href(
    request: Request, limit: int, offset: int, matched: int
) -> tuple[str | None, str | None]:
    next_href = (
        _paged_href(request, offset + limit, limit)
        if offset + limit < matched
        else None
    )
    prev_href = (
        _paged_href(request, max(0, offset - limit), limit) if offset > 0 else None
    )
    return next_href, prev_href


def _post_paging_link(
    rel: str, href: str, body: dict[str, Any], offset: int
) -> dict[str, Any]:
    """A STAC POST-pagination link: the body is the COMPLETE next request
    (original body with ``offset`` bumped), so ``merge`` is ``False`` --
    the client POSTs this body as-is rather than merging it onto anything.
    """
    new_body = dict(body)
    new_body["offset"] = offset
    return {
        "rel": rel,
        "type": "application/geo+json",
        "href": href,
        "method": "POST",
        "body": new_body,
        "merge": False,
    }


def _require_collection_row(store: CatalogStore, cid: str) -> dict[str, Any]:
    row = get_collection_row(store, cid)
    if row is None:
        raise ApiError(404, f"Collection not found: {cid}")
    return row


def _run_search(
    store: CatalogStore,
    base: str,
    params: SearchParams,
    ui: str | None = None,
    assets: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    rows, matched = search_items(store, params)
    features = [
        stac_build.record_to_item(
            stac_build.item_from_row(row),
            stac_base=base,
            goat_ui_base_url=ui,
            assets_base=assets,
        )
        for row in rows
    ]
    return features, matched


# --------------------------------------------------------------------------
# Landing / conformance / queryables
# --------------------------------------------------------------------------


@router.get(
    "",
    summary="STAC landing page (Catalog)",
    responses=_documents(stac_build.StacCatalog),
)
def stac_landing(
    request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    base = _stac_base(request)
    root = _base_url(request)
    # Id-only, capped query (catalog.services.search.collection_ids): the
    # design targets 100k+ datasets, so the landing page must not load and
    # JSON-parse every collection document just to list a few child links.
    source_ids = collection_ids(store, limit=100)
    return stac_build.catalog_landing(
        base,
        source_ids=source_ids,
        service_desc=f"{root}{DEFAULT_OPENAPI_URL}",
        conforms_to=capabilities.conformance_classes(store.registry),
        capability_links=capabilities.capability_links(store.registry, base),
    )


@router.get(
    "/conformance",
    summary="STAC conformance declaration",
    responses=_documents(stac_build.Conformance),
)
def stac_conformance(store: CatalogStore = Depends(get_store)) -> dict[str, Any]:
    """The conformance classes this catalog serves.

    What is listed here is what the API will honour; a class the current data
    cannot support is not declared.
    """
    # Derived from the loaded file rather than a fixed list, so the declaration
    # and the behaviour cannot disagree -- see `catalog.services.capabilities`.
    return {"conformsTo": capabilities.conformance_classes(store.registry)}


@router.get(
    "/queryables",
    summary="Filterable properties (CQL2)",
    response_class=JSONSchemaResponse,
    responses=_documents(stac_build.Queryables),
)
def stac_queryables(
    request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    return queryables_schema(_stac_base(request), store.registry)


@router.get(
    "/collections/{cid}/queryables",
    summary="Filterable properties of a collection (CQL2)",
    response_class=JSONSchemaResponse,
    responses=_documents(stac_build.Queryables),
)
def stac_collection_queryables(
    cid: str, request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    _require_collection_row(store, cid)
    return queryables_schema(_stac_base(request), store.registry, collection=cid)


# --------------------------------------------------------------------------
# Collections (Collection Search)
# --------------------------------------------------------------------------


@router.get(
    "/collections",
    summary="STAC collections (Collection Search)",
    responses=_documents(stac_build.StacCollections),
)
def stac_collections(
    request: Request,
    query: Annotated[CollectionSearchQuery, Query()],
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    limit = clamp_limit(query.limit, MAX_LIST_LIMIT)
    offset = query.offset
    base = _stac_base(request)
    # The COLLECTION registry: it hides what a dataset row does not carry
    # (`goat:geometryType` is per layer) so a filter naming it is a 400 here,
    # not a silent column reference that drops every mixed-type bundle. The
    # query-param path keeps its member semi-join promotion untouched.
    params = query.to_search_params(store.collection_registry, limit=limit)
    rows, matched = search_collections(store, params)
    ui = _ui_base(request)
    assets = _assets_base(request)
    collections = [
        stac_build.collection_to_stac(
            stac_build.collection_from_row(row, assets_base=assets),
            stac_base=base,
            goat_ui_base_url=ui,
        )
        for row in rows
    ]
    return {
        "collections": collections,
        "numberMatched": matched,
        "numberReturned": len(collections),
        "links": _page_links(request, limit, offset, matched),
    }


@router.get(
    "/collections/{cid}",
    summary="A STAC collection",
    responses=_documents(stac_build.StacCollection),
)
def stac_collection(
    cid: str, request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    row = _require_collection_row(store, cid)
    return stac_build.collection_to_stac(
        stac_build.collection_from_row(row, assets_base=_assets_base(request)),
        stac_base=_stac_base(request),
        goat_ui_base_url=_ui_base(request),
    )


@router.get(
    "/collections/{cid}/items",
    summary="STAC items in a collection",
    response_class=GeoJSONResponse,
    responses=_documents(stac_build.StacItemCollection),
)
def stac_collection_items(
    cid: str,
    request: Request,
    query: Annotated[ItemsQuery, Query()],
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    limit = clamp_limit(query.limit, MAX_LIST_LIMIT)
    offset = query.offset
    base = _stac_base(request)
    _require_collection_row(store, cid)
    params = query.to_search_params(collection_id=cid, limit=limit)
    rows, matched = search_items(store, params)
    ui = _ui_base(request)
    features = [
        stac_build.record_to_item(
            stac_build.item_from_row(row),
            stac_base=base,
            collection_id=cid,
            goat_ui_base_url=ui,
            assets_base=_assets_base(request),
        )
        for row in rows
    ]
    self_href = _self_href(request)
    first_href = _paged_href(request, 0, limit)
    next_href, prev_href = _next_prev_href(request, limit, offset, matched)
    return stac_build.item_collection(
        features,
        stac_base=base,
        self_href=self_href,
        number_matched=matched,
        first_href=first_href,
        next_href=next_href,
        prev_href=prev_href,
    )


@router.get(
    "/collections/{cid}/items/{item_id}",
    summary="A STAC item",
    response_class=GeoJSONResponse,
    responses=_documents(stac_build.StacItem),
)
def stac_collection_item(
    cid: str,
    item_id: str,
    request: Request,
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    rows, _ = search_items(
        store, SearchParams(collections=[cid], ids=[item_id], limit=1)
    )
    if not rows:
        raise ApiError(404, f"Item not found: {item_id!r} in collection {cid!r}")
    return stac_build.record_to_item(
        stac_build.item_from_row(rows[0]),
        stac_base=_stac_base(request),
        collection_id=cid,
        goat_ui_base_url=_ui_base(request),
        assets_base=_assets_base(request),
    )


# --------------------------------------------------------------------------
# Item Search
# --------------------------------------------------------------------------


@router.get(
    "/search",
    summary="STAC item search (GET)",
    response_class=GeoJSONResponse,
    responses=_documents(stac_build.StacItemCollection),
)
def stac_search_get(
    request: Request,
    query: Annotated[SearchQuery, Query()],
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    base = _stac_base(request)
    params = query.to_search_params(
        store.registry,
        default_filter_lang="cql2-text",
        limit=clamp_limit(query.limit, MAX_SEARCH_LIMIT),
    )
    features, matched = _run_search(
        store, base, params, _ui_base(request), _assets_base(request)
    )
    self_href = _self_href(request)
    first_href = _paged_href(request, 0, params.limit)
    next_href, prev_href = _next_prev_href(
        request, params.limit, params.offset, matched
    )
    return stac_build.item_collection(
        features,
        stac_base=base,
        self_href=self_href,
        number_matched=matched,
        first_href=first_href,
        next_href=next_href,
        prev_href=prev_href,
    )


@router.post(
    "/search",
    summary="STAC item search (POST)",
    response_class=GeoJSONResponse,
    responses=_documents(stac_build.StacItemCollection),
)
async def stac_search_post(
    request: Request,
    store: CatalogStore = Depends(get_store),
    body: SearchQuery = Body(default_factory=SearchQuery),
) -> dict[str, Any]:
    base = _stac_base(request)
    # Checked against the raw body, because by this point the shared GET/POST
    # model has already coerced a CSV `bbox` string into a list. Starlette caches
    # the body, so this re-reads rather than re-receives it.
    reject_get_encodings(await request.json() if await request.body() else None)
    params = body.to_search_params(
        store.registry,
        # cql2-json is the POST default (a JSON body carries a JSON filter);
        # the GET verb defaults to cql2-text.
        default_filter_lang="cql2-json",
        limit=clamp_limit(body.limit, MAX_SEARCH_LIMIT),
    )
    features, matched = await run_in_threadpool(
        _run_search, store, base, params, _ui_base(request), _assets_base(request)
    )
    self_href = f"{base}/search"
    result = stac_build.item_collection(
        features, stac_base=base, self_href=self_href, number_matched=matched
    )
    # The echoed body must replay as the caller sent it, so `limit` is the
    # request's own value rather than the clamped one applied above.
    original_body = body.model_dump(by_alias=True, exclude_none=True)
    original_body["limit"] = params.limit
    if params.offset + params.limit < matched:
        result["links"].append(
            _post_paging_link(
                "next", self_href, original_body, params.offset + params.limit
            )
        )
    if params.offset > 0:
        result["links"].append(
            _post_paging_link(
                "prev", self_href, original_body, max(0, params.offset - params.limit)
            )
        )
    return result


class ResolvedEntry(BaseModel):
    """``GET /resolve/{entry_id}``: what an id turned out to identify.

    A GOAT extension, so it has no STAC shape to conform to -- ``kind`` tells
    the caller which of the two payload members is populated.
    """

    model_config = ConfigDict(extra="allow")

    kind: Literal["item", "collection"]
    item: stac_build.StacItem | None = None
    collection: stac_build.StacCollection | None = None
    collection_id: str | None = None
    items: list[stac_build.StacItem] | None = Field(
        default=None, description="A collection's members, capped server-side"
    )


# --------------------------------------------------------------------------
# Aggregation extension
# --------------------------------------------------------------------------


@router.get(
    "/aggregations",
    summary="Available facet aggregations (discovery)",
    responses=_documents(AggregationsDiscovery),
)
def stac_aggregations(
    unit: Annotated[
        Literal["items", "collections"],
        Query(description="Count layers ('items') or datasets ('collections')"),
    ] = "items",
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    return available_aggregations(store, unit)


@router.get(
    "/aggregate",
    summary="Execute facet aggregations",
    responses=_documents(AggregationCollection),
)
def stac_aggregate(
    query: Annotated[AggregateQuery, Query()],
    store: CatalogStore = Depends(get_store),
) -> dict[str, Any]:
    registry = (
        store.collection_registry if query.unit == "collections" else store.registry
    )
    return run_aggregations(
        store,
        query.to_search_params(registry),
        query.aggregations,
        query.unit,
    )


# --------------------------------------------------------------------------
# GOAT extensions: resolve / collection-agnostic item lookup
# --------------------------------------------------------------------------


@router.get(
    "/resolve/{entry_id}",
    summary="Resolve a catalog id (GOAT extension)",
    responses=_documents(ResolvedEntry),
)
def stac_resolve(
    entry_id: str, request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    """What is this id -- an item or a collection? One lookup, for the
    catalog detail page."""
    base = _stac_base(request)
    res = resolve_id(store, entry_id)
    if res is None:
        raise ApiError(404, f"Catalog entry not found: {entry_id}")

    ui = _ui_base(request)
    assets = _assets_base(request)
    if res["kind"] == "item":
        collection_id = res["collection_id"]
        out: dict[str, Any] = {
            "kind": "item",
            "item": stac_build.record_to_item(
                stac_build.item_from_row(res["row"]),
                stac_base=base,
                collection_id=collection_id,
                goat_ui_base_url=ui,
                assets_base=assets,
            ),
            "collection_id": collection_id,
        }
        if collection_id:
            coll_row = get_collection_row(store, collection_id)
            if coll_row is not None:
                out["collection"] = stac_build.collection_to_stac(
                    stac_build.collection_from_row(coll_row, assets_base=assets),
                    stac_base=base,
                    goat_ui_base_url=ui,
                )
        return out

    return {
        "kind": "collection",
        "collection": stac_build.collection_to_stac(
            stac_build.collection_from_row(res["collection_row"], assets_base=assets),
            stac_base=base,
            goat_ui_base_url=ui,
        ),
        "items": [
            stac_build.record_to_item(
                stac_build.item_from_row(row),
                stac_base=base,
                collection_id=entry_id,
                goat_ui_base_url=ui,
                assets_base=assets,
            )
            for row in res["member_rows"]
        ],
        "goat:member_count": res["member_count"],
    }


@router.get(
    "/items/{item_id}/preview",
    summary="A bounded sample of an item's data (GOAT extension)",
    response_class=GeoJSONResponse,
)
def stac_item_preview(
    item_id: str,
    store: CatalogStore = Depends(get_store),
    reader: PreviewReader = Depends(get_preview_reader),
) -> Response:
    """A sample of the item's data as GeoJSON, for drawing a preview map.

    At most 100 features and 2 MB, whichever comes first, and no parameters:
    this shows what the data looks like, it does not return the data. Add the
    layer to a project to work with it.

    An item with no geometry samples its rows instead, as Features with a
    `null` geometry — the same shape, with nothing to draw on a map.

    Answers 404 where a deployment does not offer previews.
    """
    # Everything below is implementation, kept out of the description above --
    # this docstring is the endpoint's public text in `/openapi.json`, and a
    # client has no use for how the sample is produced.
    #
    # There is no viewport parameter, so the answer depends only on the item and
    # the mirror generation: it is rendered once per item per harvest and cached
    # under that generation, which a sync then drops. The ceilings are what keep
    # a preview from becoming a download of data design S14 keeps private.
    res = resolve_id(store, item_id)
    if res is None or res["kind"] != "item":
        raise ApiError(404, f"Item not found: {item_id}")

    payload = reader.render(
        store.etag_seed, res["row"], limit=store.settings.preview_max_features
    )
    # Stated here rather than left to the app-wide default: a preview cannot
    # change until a sync swaps the mirror, and that changes the ETag, so a
    # long lifetime costs nothing and makes the client's cache the one that
    # matters (see CatalogSettings.preview_cache_dir).
    max_age = store.settings.preview_max_age_seconds
    return Response(
        content=payload,
        media_type=GeoJSONResponse.media_type,
        headers={"Cache-Control": f"public, max-age={max_age}"},
    )


@router.get(
    "/items/{item_id}",
    summary="A STAC item by id (GOAT extension, collection-agnostic)",
    response_class=GeoJSONResponse,
    responses=_documents(stac_build.StacItem),
)
def stac_item_by_id(
    item_id: str, request: Request, store: CatalogStore = Depends(get_store)
) -> dict[str, Any]:
    """Fetch an item by id without knowing its collection -- a convenience
    for clients (e.g. a detail page) that hold only the id."""
    res = resolve_id(store, item_id)
    if res is None or res["kind"] != "item":
        raise ApiError(404, f"Item not found: {item_id}")
    return stac_build.record_to_item(
        stac_build.item_from_row(res["row"]),
        stac_base=_stac_base(request),
        collection_id=res["collection_id"],
        goat_ui_base_url=_ui_base(request),
        assets_base=_assets_base(request),
    )
