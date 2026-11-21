"""FastAPI dependencies for GeoAPI."""

import asyncio
import hashlib
import json
import logging
import re
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path as FSPath
from typing import Annotated, Any, Literal, Optional

from fastapi import Depends, HTTPException, Path, Query
from goatlib.filter.normalize import DAYS_AGO, normalize
from goatlib.filter.validate import over_request_limits, over_request_limits_text
from goatlib.storage.cql_evaluator import parse_cql2_filter
from goatlib.utils.layer import (
    InvalidLayerIdError,
    LayerNotFoundError,
    layer_id_to_table_name,
)
from goatlib.utils.layer import (
    get_schema_for_layer as _goatlib_get_schema_for_layer,
)
from goatlib.utils.layer import (
    normalize_layer_id as _goatlib_normalize_layer_id,
)
from pydantic import BaseModel

from geoapi.config import settings
from geoapi.ducklake import ducklake_manager
from geoapi.ducklake_pool import ducklake_pool as _ducklake_pool

logger = logging.getLogger(__name__)

# Catalog layers this process serves, and where their parquet lives. The
# manager's connection is REPLACED over its lifetime (stale-recycle,
# snapshot-refresh swap), and views in the old instance's in-memory catalog
# die with it — so views are not created once but REPLAYED on every new
# connection via the manager hook below.
_catalog_views: dict[str, FSPath] = {}
_catalog_views_lock = threading.Lock()


def _catalog_parquet_path(table_name: str) -> FSPath:
    return FSPath(settings.CATALOG_LAYERS_DIR) / f"{table_name}.parquet"


def _create_catalog_view(con: Any, table_name: str, path: FSPath) -> None:
    """The read view for one materialized catalog layer.

    Lives in the in-memory `catalog_layers` schema — nothing touches the
    DuckLake catalog, no snapshots involved. It names file_row_number
    `rowid`: stable because the file is immutable (a new catalog version is
    a new layer with a new file), so every rowid-based query works on it.
    """
    con.execute("CREATE SCHEMA IF NOT EXISTS catalog_layers")
    con.execute(
        f'CREATE VIEW IF NOT EXISTS catalog_layers."{table_name}" AS '
        f"SELECT file_row_number AS rowid, * EXCLUDE (file_row_number) "
        f"FROM read_parquet('{path}', file_row_number=true)"
    )


def _replay_catalog_views(con: Any) -> None:
    with _catalog_views_lock:
        views = dict(_catalog_views)
    for table_name, path in views.items():
        _create_catalog_view(con, table_name, path)


# Both connection owners need the views: the manager serves metadata/download
# paths, the cursor pool serves feature and tile queries — each builds and
# swaps its own DuckDB instances.
ducklake_manager.add_connection_hook(_replay_catalog_views)
_ducklake_pool.add_connection_hook(_replay_catalog_views)


def _ensure_catalog_view(table_name: str) -> None:
    """Register a catalog layer's view and create it on the live connections.

    Registration and creation happen under one lock. Registering first and
    creating after release let a second request see the name as known and
    query a view that did not exist yet — a 500 under the routine four-worker
    concurrency of `get_layer_info_sync`.
    """
    with _catalog_views_lock:
        if table_name in _catalog_views:
            return
        path = _catalog_parquet_path(table_name)
        # Both owners' LIVE connections, immediately: the replay hooks only
        # cover connections built after this point, and the pool's bases were
        # built at startup — long before the first request registered anything.
        with ducklake_manager.connection() as con:
            _create_catalog_view(con, table_name, path)
        _ducklake_pool.apply_to_bases(
            lambda con: _create_catalog_view(con, table_name, path)
        )
        _catalog_views[table_name] = path


def _forget_catalog_view(table_name: str) -> None:
    """Stop replaying a view whose file is gone (GC, or an operator)."""
    with _catalog_views_lock:
        _catalog_views.pop(table_name, None)


# Thread pool for sync DuckDB operations in dependencies
_layer_info_executor = ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="layer_info"
)


class LayerInfo(BaseModel):
    """Layer information extracted from URL.

    `kind` says where the data lives: "lake" is a DuckLake table (user data,
    editable), "catalog" is a materialized catalog layer — an immutable
    GeoParquet read through a view whose first column names file_row_number
    `rowid`, so every rowid-based query works on both kinds unchanged.
    """

    layer_id: str
    schema_name: str
    table_name: str
    kind: Literal["lake", "catalog"] = "lake"

    @property
    def writable(self) -> bool:
        """Catalog layers are shared read-only snapshots; writes must refuse
        cleanly — a view over a parquet scan is not updatable anyway."""
        return self.kind == "lake"

    @property
    def full_table_name(self) -> str:
        """Get full qualified table name."""
        if self.kind == "catalog":
            return f'catalog_layers."{self.table_name}"'
        return f"lake.{self.schema_name}.{self.table_name}"

    @property
    def sql_relation(self) -> str:
        """The relation, quoted — for DESCRIBE and identifier positions."""
        if self.kind == "catalog":
            return f'catalog_layers."{self.table_name}"'
        return f'lake."{self.schema_name}"."{self.table_name}"'


def normalize_layer_id(layer_id: str) -> str:
    """Normalize layer ID to standard UUID format with hyphens.

    Accepts:
    - 32-char hex: abc123def456...
    - UUID format: abc123de-f456-...

    Returns:
        Standard UUID format (lowercase, with hyphens)

    Raises:
        HTTPException: If layer ID is invalid
    """
    try:
        return _goatlib_normalize_layer_id(layer_id)
    except InvalidLayerIdError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid collection ID: {e.layer_id}. Expected UUID format.",
        )


# Alias for backward compatibility
_layer_id_to_table_name = layer_id_to_table_name


def get_schema_for_layer(layer_id: str) -> str:
    """Get schema name for a layer ID, with caching.

    Queries DuckDB's information_schema for the attached DuckLake catalog.

    Args:
        layer_id: Normalized layer ID (UUID format with hyphens)

    Returns:
        Schema name (e.g., 'user_abc123...')

    Raises:
        HTTPException: If layer not found
    """
    try:
        return _goatlib_get_schema_for_layer(layer_id, ducklake_manager)
    except LayerNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Collection not found: {layer_id}",
        )


def get_layer_info_sync(collection_id: str) -> LayerInfo:
    """Synchronous version for use in thread pool.

    The collection ID is just the layer UUID (with or without hyphens).
    Schema is looked up from DuckLake catalog with caching.
    """
    layer_id = normalize_layer_id(collection_id)
    table_name = _layer_id_to_table_name(layer_id)

    try:
        schema_name = get_schema_for_layer(layer_id)
    except HTTPException:
        # Not a DuckLake table. A materialized catalog layer lives as a
        # parquet file instead; absent that too, the 404 stands.
        if not _catalog_parquet_path(table_name).exists():
            # If we served this once and the file has since been collected,
            # stop recreating its view on every new connection.
            _forget_catalog_view(table_name)
            raise
        _ensure_catalog_view(table_name)
        return LayerInfo(
            layer_id=layer_id,
            schema_name="catalog_layers",
            table_name=table_name,
            kind="catalog",
        )

    return LayerInfo(
        layer_id=layer_id,
        schema_name=schema_name,
        table_name=table_name,
    )


async def get_layer_info(
    collection_id: Annotated[str, Path(alias="collectionId")],
    temp: Annotated[
        bool, Query(description="Temp layer mode (skip DuckLake lookup)")
    ] = False,
) -> LayerInfo:
    """Extract layer info from collection ID in URL path.

    The collection ID is just the layer UUID (with or without hyphens).
    Schema is looked up from DuckLake catalog with caching.

    If temp=true query param is set, skip DuckLake lookup (for temp layer serving).

    Runs in a thread pool to avoid blocking the async event loop
    when DuckDB query is needed (cache miss).
    """
    # For temp layers, return placeholder without DuckLake lookup
    if temp:
        return LayerInfo(
            layer_id=normalize_layer_id(collection_id),
            schema_name="",
            table_name="",
        )

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _layer_info_executor,
        get_layer_info_sync,
        collection_id,
    )


# Common query parameters
async def limit_query(
    limit: Annotated[
        int, Query(description="Maximum number of features to return", ge=1, le=100_000)
    ] = 10,
) -> int:
    """Limit dependency."""
    return limit


async def offset_query(
    offset: Annotated[int, Query(description="Number of features to skip", ge=0)] = 0,
) -> int:
    """Offset dependency."""
    return offset


async def bbox_query(
    bbox: Annotated[
        Optional[str],
        Query(
            description="Bounding box filter: minx,miny,maxx,maxy",
        ),
    ] = None,
) -> Optional[list[float]]:
    """Parse bbox query parameter."""
    if bbox is None:
        return None

    try:
        coords = [float(c) for c in bbox.split(",")]
        if len(coords) != 4:
            raise ValueError("BBox must have exactly 4 values")
        return coords
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid bbox: {e}")


async def properties_query(
    properties: Annotated[
        Optional[str],
        Query(description="Comma-separated list of properties to return"),
    ] = None,
) -> Optional[list[str]]:
    """Parse properties query parameter."""
    if properties is None or properties == "":
        return None
    return [p.strip() for p in properties.split(",")]


def unknown_requested_fields(
    column_names: Optional[list[str]],
    properties: Optional[list[str]] = None,
    sortby: Optional[str] = None,
    geometry_column: Optional[str] = None,
) -> list[str]:
    """Requested `properties` / `sortby` names the layer does not have.

    The query builders splice these names into the SELECT and ORDER BY
    clauses as quoted identifiers, so an unknown name reaches DuckDB and
    fails the whole query.

    Order is preserved and duplicates collapsed. With no resolved column
    list nothing can be checked, so the result is empty (the request keeps
    its previous behaviour rather than 400-ing on every field).
    """
    if not column_names:
        return []

    known = set(column_names)
    if geometry_column:
        known.add(geometry_column)
    # rowid is DuckDB's row identifier, selectable and sortable on every
    # table but never part of the layer's column metadata.
    known.add("rowid")

    requested: list[str] = list(properties or [])
    if sortby:
        sort_field = sortby.lstrip("+-")
        if sort_field:
            requested.append(sort_field)

    unknown: list[str] = []
    for name in requested:
        if name not in known and name not in unknown:
            unknown.append(name)
    return unknown


def reject_unknown_fields(
    column_names: Optional[list[str]],
    properties: Optional[list[str]] = None,
    sortby: Optional[str] = None,
    geometry_column: Optional[str] = None,
) -> None:
    """400 when `properties`/`sortby` name a field the collection lacks.

    Such a name is spliced into the query as a quoted identifier and would
    otherwise fail inside DuckDB and surface as a 500.
    """
    unknown = unknown_requested_fields(
        column_names=column_names,
        properties=properties,
        sortby=sortby,
        geometry_column=geometry_column,
    )
    if unknown:
        raise HTTPException(
            status_code=400,
            detail="Unknown field(s) for this collection: " + ", ".join(unknown),
        )


# What `_filter_problem` found for the filters last seen, by digest: a screen
# of tiles brings the same filter once per tile, and reading a large area
# takes a while on the event loop, the only thread that comes here.
_FILTER_PROBLEMS_MAX = 256
_EMPTY_OBJECT = re.compile(r"\s*\{\s*\}\s*")
_filter_problems: OrderedDict[bytes, Optional[str]] = OrderedDict()


def _filter_problem(text: str, lang: str) -> Optional[str]:
    """Why a request's filter is refused; None for one the query path reads.

    The query builder skips a filter it cannot parse and answers with every
    feature, so the filter is parsed here as the builder parses it (cql2-json
    after `goatlib.filter.normalize`) and refused when that fails. The request
    ceilings (`goatlib.filter.limits.REQUEST_MAX_*`) come first for cql2-json,
    so nothing over one is parsed. CQL2 text has to be parsed to be measured:
    it is held against the ceilings as the CQL2-JSON it stands for. What that
    form cannot express measures as nothing, as in cql2-json.
    """
    try:
        if lang == "cql2-json":
            try:
                parsed = json.loads(text)
            except ValueError:
                return "The filter is not valid JSON."
            if not isinstance(parsed, dict):
                return "The filter is not valid CQL2 JSON."
            issues = over_request_limits(parsed)
            if not issues:
                parse_cql2_filter(normalize(parsed), lang)
        else:
            issues = over_request_limits_text(parse_cql2_filter(text, lang))
    except RecursionError:
        return "The filter nests too deeply."
    except Exception:
        name = "CQL2 JSON" if lang == "cql2-json" else "CQL2 text"
        return f"The filter is not valid {name}."
    return " ".join(i.message for i in issues) or None


async def cql_filter_query(
    filter: Annotated[
        Optional[str],
        Query(alias="filter", description="CQL2 filter expression"),
    ] = None,
    filter_lang: Annotated[
        Optional[str],
        Query(
            alias="filter-lang", description="Filter language: cql2-json or cql2-text"
        ),
    ] = None,
) -> Optional[dict]:
    """Parse CQL2 filter query parameter.

    Returns a dict with 'filter' (raw string) and 'lang' (cql2-json or cql2-text).

    Every client filter enters here, so one over a request ceiling
    (`goatlib.filter.limits.REQUEST_MAX_*`) or one that does not parse is
    answered 400 here (`_filter_problem`) and never reaches the query builder.
    The ceilings lie well above the save limits: a filter saved over one still
    filters. The text is passed on as it was sent (the tile cache keys on it),
    except for a filter with a relative day ("in the last n days",
    `goatlib.filter.normalize.days_ago`): that one is passed on normalized,
    with the day it means today, so the tile caches, the stored tiles' prepared
    filters and the ETags key on that day and a filter sent the same way
    tomorrow is another filter. An empty filter is no filter, and so is an
    empty JSON object: what a client sends for a layer without conditions.
    """
    if filter is None or not filter.strip():
        return None

    lang = filter_lang or "cql2-json"  # Default to cql2-json
    if lang not in ("cql2-json", "cql2-text"):
        raise HTTPException(status_code=400, detail=f"Invalid filter-lang: {lang}")
    if lang == "cql2-json" and _EMPTY_OBJECT.fullmatch(filter):
        return None

    key = hashlib.sha1(f"{lang}\n{filter}".encode()).digest()
    if key in _filter_problems:
        _filter_problems.move_to_end(key)
        problem = _filter_problems[key]
    else:
        problem = _filter_problems[key] = _filter_problem(filter, lang)
        while len(_filter_problems) > _FILTER_PROBLEMS_MAX:
            _filter_problems.popitem(last=False)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if lang == "cql2-json" and DAYS_AGO in filter:
        filter = json.dumps(normalize(json.loads(filter)), ensure_ascii=False)

    return {"filter": filter, "lang": lang}


async def tile_params(
    z: Annotated[int, Path(description="Zoom level", ge=0, le=24)],
    x: Annotated[int, Path(description="Tile column")],
    y: Annotated[int, Path(description="Tile row")],
) -> tuple[int, int, int]:
    """Tile coordinate parameters."""
    return z, x, y


async def tile_matrix_set_id(
    tileMatrixSetId: Annotated[str, Path(description="TileMatrixSet identifier")],
) -> str:
    """TileMatrixSet ID parameter."""
    supported = ["WebMercatorQuad", "WorldCRS84Quad"]
    if tileMatrixSetId not in supported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported TileMatrixSet: {tileMatrixSetId}. "
            f"Supported: {', '.join(supported)}",
        )
    return tileMatrixSetId


# Type aliases for cleaner dependency injection
LayerInfoDep = Annotated[LayerInfo, Depends(get_layer_info)]
LimitDep = Annotated[int, Depends(limit_query)]
OffsetDep = Annotated[int, Depends(offset_query)]
BBoxDep = Annotated[Optional[list[float]], Depends(bbox_query)]
PropertiesDep = Annotated[Optional[list[str]], Depends(properties_query)]
CqlFilterDep = Annotated[Optional[dict], Depends(cql_filter_query)]
TileParamsDep = Annotated[tuple[int, int, int], Depends(tile_params)]
TileMatrixSetIdDep = Annotated[str, Depends(tile_matrix_set_id)]
