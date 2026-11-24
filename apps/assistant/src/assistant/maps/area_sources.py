"""The outlines a ``set_area`` row operation is built from, read before the
plan of ``map_update``: region outlines from the catalog, the features of
another polygon layer from geoapi, and the map view from the page.

They are read the way the web's filter panel reads them: a region's outline
from the catalog's ``/nuts/{id}/geometry`` (``useCatalogNutsGeometries``),
another layer's features from geoapi's items route as far as the map shows
them (its project layers' saved filters, ``LayerFilterPanel``), named by the
layer's likeliest name column (``pickSearchColumns``), and the view from
the page context's ``viewport.bbox``.
"""

import asyncio
import json
from collections.abc import Awaitable, Mapping, Sequence
from typing import Any
from urllib.parse import quote
from uuid import UUID

from goatlib.filter.limits import MAX_FEATURES
from pydantic_ai.exceptions import ToolFailed

from assistant.context import ProjectMapContext
from assistant.maps.filter_area import AreaSources, Outline, SetArea
from assistant.maps.operations import FilterLayer, MapOp
from assistant.maps.state import MapRead
from assistant.maps.view import LOCKED, NO_LAYER
from assistant.tools.filters import field_kind
from assistant.tools.http import ServiceError
from assistant.tools.project import (
    _COPYING,
    STILL_COPYING,
    _compile,
    _copy_status,
    _Layer,
    _Names,
)
from assistant.tools.runtime import InputInvalid, ToolEnv

NO_VIEW = "The page did not send the map view."
REGIONS_DOWN = (
    "The region outlines could not be loaded right now, so nothing was changed. "
    "Try again in a moment."
)
FEATURES_DOWN = (
    "The features of {name!r} could not be read right now, so nothing was "
    "changed. Try again in a moment."
)

#: The name hints and the fields the panel's feature list never names a
#: feature by (``editorSearchLayers.ts``).
_NAME_HINTS = ("name", "title", "label", "bezeichnung", "street", "strasse")
_HIDDEN_FIELDS = frozenset({"layer_id", "id", "h3_3", "h3_6", "geom", "geometry"})

AreaFacts = Mapping[int, AreaSources | InputInvalid | ToolFailed]

#: The set_area operations one call takes, the regions of all of them
#: together, and how many outline requests of a call run at the same time:
#: a request names a few places, and each outline is read and simplified.
MAX_AREAS_PER_CALL = 10
MAX_REGIONS_PER_CALL = 100
OUTLINE_READS = 8


def check_outline_budget(operations: Sequence[MapOp]) -> None:
    """Refuses a call whose areas would read more outlines than one call
    takes, before anything is read."""
    areas = [
        found[1]
        for op in operations
        if isinstance(op, FilterLayer)
        if (found := _area_operation(op)) is not None
    ]
    if len(areas) > MAX_AREAS_PER_CALL:
        raise InputInvalid(
            f"This call sets {len(areas)} areas; one call sets at most "
            f"{MAX_AREAS_PER_CALL}. Split it into several calls."
        )
    regions = sum(len(area.regions or ()) for area in areas)
    if regions > MAX_REGIONS_PER_CALL:
        raise InputInvalid(
            f"This call's areas name {regions} regions together; one call takes "
            f"at most {MAX_REGIONS_PER_CALL} regions. Split it into several "
            "calls, or use larger regions (one level up)."
        )


def name_column(queryables: Any) -> str | None:
    """The column the panel names a layer's features by: its text columns,
    those whose name holds a hint first (in the hints' order), then the
    others in order, date-times and the hidden fields left out."""
    properties = queryables.get("properties") if isinstance(queryables, dict) else None
    texts = [
        name
        for name, value in (properties or {}).items()
        if name not in _HIDDEN_FIELDS
        and isinstance(value, dict)
        and value.get("type") == "string"
        and value.get("kind") != "datetime"
        and value.get("format") != "date-time"
    ]

    def hint(name: str) -> int:
        lower = name.lower()
        return next((i for i, h in enumerate(_NAME_HINTS) if h in lower), -1)

    hinted = sorted((name for name in texts if hint(name) >= 0), key=hint)
    rest = [name for name in texts if hint(name) < 0]
    found = [*hinted, *rest]
    return found[0] if found else None


def _saved_cql(row: Mapping[str, Any]) -> dict[str, Any] | None:
    query = row.get("query")
    cql = query.get("cql") if isinstance(query, dict) else None
    return cql if isinstance(cql, dict) and cql else None


def shown_filter(state: MapRead, layer_id: str) -> dict[str, Any] | None:
    """What the map shows of a dataset that is in the project as one or more
    layers the user can read: the features any of them shows; None once one
    of them shows every feature (``shownOf``)."""
    filters = [
        _saved_cql(row)
        for _, row in sorted(state.rows.items())
        if str(row.get("layer_id")) == layer_id and not row.get("locked")
    ]
    if not filters or any(f is None for f in filters):
        return None
    distinct = list({json.dumps(f, sort_keys=True): f for f in filters}.values())
    return distinct[0] if len(distinct) == 1 else {"op": "or", "args": distinct}


async def _region(env: ToolEnv, region_id: str, limit: asyncio.Semaphore) -> Outline:
    try:
        async with limit:
            feature = await env.call(
                "catalog", "GET", f"/stac/nuts/{quote(region_id, safe='')}/geometry"
            )
    except ServiceError as exc:
        if exc.status == 404:
            raise InputInvalid(
                f"There is no region {region_id!r}. Look the region's id up "
                "with catalog_find_region."
            ) from exc
        raise ToolFailed(REGIONS_DOWN) from exc
    except ToolFailed as exc:
        raise ToolFailed(REGIONS_DOWN) from exc
    if not isinstance(feature, dict):
        raise ToolFailed(REGIONS_DOWN)
    properties = feature.get("properties")
    name = properties.get("nuts_name") if isinstance(properties, dict) else None
    return Outline(
        id=region_id,
        name=str(name) if name else None,
        geometry=feature.get("geometry"),
    )


async def _regions(
    env: ToolEnv, ids: Sequence[str], limit: asyncio.Semaphore
) -> tuple[Outline, ...]:
    """The regions' outlines, read side by side, at most as many at a time
    as ``limit`` lets; the first failure in the order given is the one
    raised."""
    found = await asyncio.gather(
        *(_region(env, region_id, limit) for region_id in dict.fromkeys(ids)),
        return_exceptions=True,
    )
    for outline in found:
        if isinstance(outline, BaseException):
            raise outline
    return tuple(outline for outline in found if isinstance(outline, Outline))


def _read_failure(exc: ToolFailed, name: str) -> ToolFailed:
    if isinstance(exc, ServiceError) and exc.status in (401, 403):
        return ToolFailed(LOCKED.format(name=name))
    return ToolFailed(FEATURES_DOWN.format(name=name))


async def _layer_features(
    env: ToolEnv,
    project_id: UUID,
    state: MapRead,
    filtered: Mapping[str, Any],
    op: SetArea,
    limit: asyncio.Semaphore,
) -> tuple[str, tuple[Outline, ...]]:
    """The other layer's dataset id and the features that make the area."""
    assert op.features_of is not None
    link = op.features_of.layer_project_id
    row = state.rows.get(link)
    if row is None:
        raise InputInvalid(NO_LAYER.format(layer_project_id=link))
    name = str(row.get("name") or f"layer {link}")
    if row.get("locked"):
        raise ToolFailed(LOCKED.format(name=name))
    if row.get("type") != "feature" or row.get("feature_layer_geometry_type") != (
        "polygon"
    ):
        raise InputInvalid(
            f"{name!r} is not a polygon layer: an area is made of the features "
            "of a layer with polygons."
        )
    if link == filtered.get("id"):
        raise InputInvalid(
            "features_of names the layer being filtered: its own features "
            "cannot be its area."
        )
    layer_id = str(row["layer_id"])
    if layer_id == str(filtered.get("layer_id")):
        raise InputInvalid(
            f"{name!r} holds the same data as the layer being filtered, so its "
            "features cannot be its area."
        )
    if _copy_status(row) in _COPYING:
        raise ToolFailed(STILL_COPYING)
    collection = f"/collections/{layer_id}"
    try:
        async with limit:
            queryables = await env.call("geoapi", "GET", f"{collection}/queryables")
    except ToolFailed as exc:
        raise _read_failure(exc, name) from exc
    fields = {
        field: field_kind(schema)
        for field, schema in ((queryables or {}).get("properties") or {}).items()
        if isinstance(schema, dict) and "$ref" not in schema
    }
    names = _Names(
        _Layer(
            project_id, link, layer_id, name, row.get("feature_layer_geometry_type")
        ),
        fields,
    )
    try:
        asked = _compile(names.filter(op.features_of.filter), fields)
    except InputInvalid as exc:
        raise InputInvalid(f"features_of.filter on {name!r}: {exc.message}") from exc
    shown = shown_filter(state, layer_id)
    parts = [part for part in (shown, json.loads(asked) if asked else None) if part]
    cql = (
        parts[0] if len(parts) == 1 else {"op": "and", "args": parts} if parts else None
    )
    column = name_column(queryables)
    params: dict[str, object] = {"properties": column or ""}
    if cql is not None:
        params["filter"] = json.dumps(cql)
        params["filter-lang"] = "cql2-json"
    try:
        async with limit:
            counted = await env.call(
                "geoapi", "GET", f"{collection}/items", params={**params, "limit": 1}
            )
        matched = counted.get("numberMatched") if isinstance(counted, dict) else None
        if isinstance(matched, int) and not isinstance(matched, bool):
            _check_count(matched, name)
        async with limit:
            page = await env.call(
                "geoapi",
                "GET",
                f"{collection}/items",
                params={**params, "limit": MAX_FEATURES + 1},
            )
    except ToolFailed as exc:
        raise _read_failure(exc, name) from exc
    features = page.get("features") if isinstance(page, dict) else None
    if not isinstance(features, list):
        raise ToolFailed(FEATURES_DOWN.format(name=name))
    _check_count(len(features), name)
    outlines = []
    for feature in features:
        if not isinstance(feature, dict) or feature.get("id") is None:
            continue
        feature_id = str(feature["id"])
        properties = feature.get("properties")
        value = (
            properties.get(column) if column and isinstance(properties, dict) else None
        )
        outlines.append(
            Outline(
                id=feature_id,
                name=feature_id if value is None or value == "" else str(value),
                geometry=feature.get("geometry"),
            )
        )
    return layer_id, tuple(outlines)


def _check_count(count: int, name: str) -> None:
    if count > MAX_FEATURES:
        raise InputInvalid(
            f"{count} features of {name!r} match, and an area takes at most "
            f"{MAX_FEATURES}. Narrow features_of.filter."
        )
    if count == 0:
        raise InputInvalid(
            f"No feature of {name!r} matches, so there is no area to set. "
            "Check features_of.filter."
        )


async def _no_layer() -> tuple[str | None, tuple[Outline, ...]]:
    """What a set_area without features_of reads of another layer."""
    return None, ()


async def _sources(
    env: ToolEnv,
    project_id: UUID,
    state: MapRead,
    filtered: Mapping[str, Any],
    op: SetArea,
    limit: asyncio.Semaphore,
) -> AreaSources:
    bounds = None
    if op.view:
        page = env.page
        viewport = page.viewport if isinstance(page, ProjectMapContext) else None
        if viewport is None or viewport.bbox is None:
            raise ToolFailed(NO_VIEW)
        bounds = tuple(float(value) for value in viewport.bbox)
    features_read: Awaitable[tuple[str | None, tuple[Outline, ...]]] = (
        _layer_features(env, project_id, state, filtered, op, limit)
        if op.features_of is not None
        else _no_layer()
    )
    regions, layer = await asyncio.gather(
        _regions(env, op.regions or (), limit), features_read, return_exceptions=True
    )
    for found in (regions, layer):
        if isinstance(found, BaseException):
            raise found
    assert isinstance(regions, tuple) and isinstance(layer, tuple)
    source, features = layer
    return AreaSources(
        regions=regions,
        layer=source,
        features=features,
        bounds=bounds,  # type: ignore[arg-type]
    )


def _area_operation(op: FilterLayer) -> tuple[int, SetArea] | None:
    return next(
        (
            (number, row)
            for number, row in enumerate(op.rows, start=1)
            if isinstance(row, SetArea)
        ),
        None,
    )


async def read_area_sources(
    env: ToolEnv, project_id: UUID, state: MapRead, operations: Sequence[MapOp]
) -> dict[int, AreaSources | InputInvalid | ToolFailed]:
    """The outlines of every ``set_area``, by the index of its ``filter``
    operation, read at once; a refusal in its place, worded with the row
    operation's number, for the plan to raise. Only a layer the plan does
    not refuse anyway (one the user can read, a feature layer, not being
    copied) has its outlines read, at most ``OUTLINE_READS`` requests at a
    time."""
    limit = asyncio.Semaphore(OUTLINE_READS)

    async def read(
        link: int, number: int, op: SetArea
    ) -> AreaSources | InputInvalid | ToolFailed:
        try:
            return await _sources(env, project_id, state, state.rows[link], op, limit)
        except InputInvalid as exc:
            return InputInvalid(f"Row operation {number}: {exc.message}")
        except ToolFailed as exc:
            return ToolFailed(f"Row operation {number}: {exc.message}")

    wanted: dict[int, Any] = {}
    for index, operation in enumerate(operations):
        if not isinstance(operation, FilterLayer):
            continue
        found = _area_operation(operation)
        row = state.rows.get(operation.layer_project_id)
        if (
            found is None
            or row is None
            or row.get("locked")
            or _copy_status(row) in _COPYING
            or row.get("type") != "feature"
        ):
            continue
        number, op = found
        wanted[index] = read(operation.layer_project_id, number, op)
    read_all = await asyncio.gather(*wanted.values())
    return dict(zip(wanted, read_all, strict=True))
