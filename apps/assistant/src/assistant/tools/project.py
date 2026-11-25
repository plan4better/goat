"""The read-only project pack (spec §7.2, §9.1.1, §10).

The read tools take a project ID, defaulting to the project of the page, so other
projects the user can open are readable as sources.

Layers are always resolved through core's layer list of that project, with the
user's token: core checks the project and marks layers the user cannot read as
locked. Only layer IDs from that list ever reach geoapi and processes, and never
a locked one. This matters because neither checks per layer today: processes
runs its sync analytics for any caller, and geoapi's read check only logs unless
ENFORCE_READ_AUTHZ is set. So the model never passes a layer UUID, only
(project_id, layer_project_id).
"""

import asyncio
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, overload
from uuid import UUID

from goatlib.filter.rows import read_rows
from goatlib.style.summary import summarize
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_ai.exceptions import ToolFailed

from assistant.context import (
    BasemapInfo,
    ProjectMapContext,
    advised_tone,
    project_of,
)
from assistant.maps.filter_area import layer_labels
from assistant.maps.filter_rows import CUSTOM, FilterBrief, brief
from assistant.maps.state import MapRead, read_map
from assistant.maps.state import core_read as _core
from assistant.surfaces import Surface
from assistant.tools.filters import (
    FILTER_EXAMPLES,
    FILTERABLE_KINDS,
    FeatureFilter,
    describe_filter,
    field_kind,
    to_cql2,
    unknown_field,
)
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.workflows.tool_info import JOINED_PREFIX

#: Every project mode, and pages without a project (Home, content, settings),
#: where the tools need an explicit project_id (Decision T16).
PROJECT_SURFACES: frozenset[Surface] = frozenset(
    {"project.map", "project.workflows", "project.layouts", "project.dashboard", "none"}
)

_NUMERIC = {"integer", "number"}
_DATA_LAYER_TYPES = {"feature", "table"}
SAMPLE_MAX = 10
SAMPLE_FIELDS_MAX = 20
_SAMPLE_VALUE_CHARS = 200
#: Values listed per categorical field.
UNIQUE_VALUES = 50
#: A catalog layer whose copy into GOAT is queued or running
#: (``other_properties.catalog_materialize.status`` of core's layer row) has no
#: data to read yet.
STILL_COPYING = (
    "This layer is still being copied into GOAT. Try again in a moment; until "
    "then its data cannot be read."
)
_COPYING = frozenset({"pending", "running"})
#: How often, and how many seconds apart, project_get_fields lists the
#: project's layers again while a catalog layer is being copied: the copy
#: starts when the dataset is added, a workflow is written from the fields,
#: and each read the model makes again resends the whole answer. Bounded, so
#: a slow copy still ends in ``STILL_COPYING``.
COPY_POLLS = 5
COPY_POLL_SECONDS = 5


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: UUID | None = Field(
        default=None,
        description=(
            "Leave it out for the open project; another project's id reads that one "
            "as a source."
        ),
    )


class LayerInput(ProjectInput):
    layer_project_id: int = Field(
        ge=1,
        description="The layer's ID within the project (layer_project_id from project_get_layers).",
    )


class FilteredLayerInput(LayerInput):
    filter: FeatureFilter | None = Field(
        default=None,
        description=f"Only features matching this filter. {FILTER_EXAMPLES}",
    )
    as_drawn: bool = Field(
        default=False,
        description=(
            "true: only the features the map draws, under the layer's saved "
            "filter (its rows and area that are switched on), area included; "
            "with filter, both apply. A layer without a saved filter is read "
            "whole."
        ),
    )


def _project_id(env: ToolEnv, given: UUID | None) -> UUID:
    if given is not None:
        return given
    current = project_of(env.page)
    if current is None:
        raise InputInvalid(
            "No project is open on this page; pass project_id (core_find finds projects by name)."
        )
    return current


@dataclass(frozen=True)
class _Layer:
    project_id: UUID
    layer_project_id: int
    layer_id: str
    name: str
    geometry_type: str | None
    #: The layer's saved filter as core stores it (``query``), and how an
    #: area's summary names the project's layers (``layer_labels``).
    query: Any = field(default=None, compare=False)
    labels: Mapping[str, str] = field(default_factory=dict, compare=False)


def _copy_status(row: Mapping[str, Any]) -> str | None:
    """The status of a catalog layer's copy into GOAT (``pending``,
    ``running``, ``ready`` or ``failed``); None for any other layer."""
    props = row.get("other_properties")
    doc = props.get("catalog_materialize") if isinstance(props, dict) else None
    status = doc.get("status") if isinstance(doc, dict) else None
    return status if isinstance(status, str) else None


async def _readable_layer(
    env: ToolEnv, args: LayerInput, *, wait_for_copy: bool = False
) -> _Layer:
    """The layer ``args`` names, if its data can be read. ``wait_for_copy``:
    a catalog layer still being copied is listed again, ``COPY_POLLS`` times
    ``COPY_POLL_SECONDS`` apart, before the read says so."""
    for _ in range(COPY_POLLS if wait_for_copy else 0):
        try:
            return await _listed_layer(env, args)
        except ToolFailed as exc:
            if exc.message != STILL_COPYING:
                raise
        await asyncio.sleep(COPY_POLL_SECONDS)
    return await _listed_layer(env, args)


async def _listed_layer(env: ToolEnv, args: LayerInput) -> _Layer:
    project_id = _project_id(env, args.project_id)
    rows = await _core(env, f"/{project_id}/layer")
    for row in rows:
        if row.get("id") != args.layer_project_id:
            continue
        name = str(row.get("name") or f"layer {args.layer_project_id}")
        if row.get("locked"):
            raise ToolFailed(
                f"{name!r} is in the project, but the user has no access to its data."
            )
        if _copy_status(row) in _COPYING:
            raise ToolFailed(STILL_COPYING)
        if row.get("type") not in _DATA_LAYER_TYPES:
            raise ToolFailed(
                f"{name!r} is a {row.get('type')} layer; only feature and table layers have data to read."
            )
        return _Layer(
            project_id,
            args.layer_project_id,
            str(row["layer_id"]),
            name,
            row.get("feature_layer_geometry_type"),
            query=row.get("query"),
            labels=layer_labels(
                {r["id"]: r for r in rows if isinstance(r.get("id"), int)}
            ),
        )
    raise InputInvalid(
        f"There is no layer {args.layer_project_id} in project {project_id}. "
        "Call project_get_layers to list the layers."
    )


async def _fields(env: ToolEnv, layer: _Layer) -> dict[str, str]:
    """``{field: kind}`` (``field_kind``); the geometry (a ``$ref``) is left out."""
    doc = await env.call("geoapi", "GET", f"/collections/{layer.layer_id}/queryables")
    return {
        name: field_kind(schema)
        for name, schema in (doc.get("properties") or {}).items()
        if isinstance(schema, dict) and "$ref" not in schema
    }


class _Names:
    """The field names the model gives for one layer, resolved against its
    fields. A name the layer does not have reads ``join_<name>`` when the
    layer has that field: the model often names a joined field without its
    prefix. Everything after the resolution (the field's kind, the
    request) sees the name that is read, so a read of ``x`` is checked
    exactly as a read of ``join_x``."""

    def __init__(self, layer: _Layer, fields: Mapping[str, str]) -> None:
        self.layer = layer
        self.fields = fields
        #: ``{given: read}`` for each name read with the prefix.
        self.read: dict[str, str] = {}

    @overload
    def name(self, given: str) -> str: ...
    @overload
    def name(self, given: None) -> None: ...
    def name(self, given: str | None) -> str | None:
        """The field ``given`` reads; a name the layer has neither way stays
        as given, for the caller's check to name."""
        if given is None or given in self.fields:
            return given
        joined = JOINED_PREFIX + given
        if joined not in self.fields:
            return given
        self.read[given] = joined
        return joined

    def filter(self, feature_filter: FeatureFilter | None) -> FeatureFilter | None:
        if feature_filter is None:
            return None
        return feature_filter.model_copy(
            update={
                "conditions": [
                    condition.model_copy(update={"field": self.name(condition.field)})
                    for condition in feature_filter.conditions
                ]
            }
        )

    def notes(self) -> list[str]:
        """One per name read with the prefix."""
        return [
            f"{self.layer.name!r} has no field {given!r}; read {joined!r} in its place."
            for given, joined in self.read.items()
        ]


async def _names(env: ToolEnv, layer: _Layer, *, needed: bool = True) -> _Names:
    """The layer's field names to resolve against; without ``needed`` (a call
    that names no field), its fields are not read."""
    return _Names(layer, await _fields(env, layer) if needed else {})


def _note(*parts: str | None) -> str | None:
    return " ".join(part for part in parts if part) or None


def _compile(
    feature_filter: FeatureFilter | None, fields: Mapping[str, str]
) -> str | None:
    """The filter checked against the layer's fields, as the CQL2-JSON string
    the services take; None without a filter."""
    return (
        None if feature_filter is None else json.dumps(to_cql2(feature_filter, fields))
    )


async def _cql(
    env: ToolEnv,
    layer: _Layer,
    feature_filter: FeatureFilter | None,
    fields: Mapping[str, str] | None = None,
) -> str | None:
    """``fields``: the layer's fields when the caller has read them; read here
    otherwise, since the filter is checked against them."""
    if feature_filter is None:
        return None
    return _compile(
        feature_filter, fields if fields is not None else await _fields(env, layer)
    )


def saved_filter(query_cql: Any) -> dict[str, Any] | None:
    """A layer's saved filter as the map draws it (``query.cql``: its rows and
    area that are switched on): an object with keys, else none (the web's
    ``isCql``)."""
    return query_cql if isinstance(query_cql, dict) and query_cql else None


def _saved(layer: _Layer, as_drawn: bool) -> dict[str, Any] | None:
    """The layer's saved filter when ``as_drawn`` asks for it."""
    query = layer.query if as_drawn else None
    return saved_filter(query.get("cql")) if isinstance(query, dict) else None


def _drawn_words(layer: _Layer, fields: Mapping[str, str]) -> str:
    """The saved filter the map draws, in the words project_get_layers shows
    it: the rows that are on, joined by its match, and the area when it is
    on."""
    shown = brief(layer.query, fields, layers=layer.labels)
    parts: list[str] = []
    if shown is not None:
        joined = (" and " if shown.match == "all" else " or ").join(
            row.text for row in shown.rows if row.on
        )
        if joined:
            parts.append(joined)
        notes = read_rows(layer.query, None).area_notes
        if shown.area is not None and not (isinstance(notes, dict) and "off" in notes):
            parts.append(f"area: {shown.area}")
    return f"the layer's filter as the map draws it ({'; '.join(parts)})"


def _where(
    layer: _Layer,
    fields: Mapping[str, str],
    feature_filter: FeatureFilter | None,
    as_drawn: bool,
) -> tuple[dict[str, Any] | None, str]:
    """The filter the services take, as a CQL2-JSON object (None: every
    feature), and its words for the answer: the given filter checked against
    the layer's fields, and with ``as_drawn`` the layer's saved filter as
    core stores it, both under ``and``."""
    given = None if feature_filter is None else to_cql2(feature_filter, fields)
    words = describe_filter(feature_filter)
    saved = _saved(layer, as_drawn)
    if saved is None:
        return given, words
    drawn = _drawn_words(layer, fields)
    if given is None:
        return saved, drawn
    return {"op": "and", "args": [saved, given]}, f"{drawn} and {words}"


def _text(where: dict[str, Any] | None) -> str | None:
    """A filter as the CQL2-JSON text the services take."""
    return None if where is None else json.dumps(where)


def _distinct_total(result: Any) -> int:
    """The ``total`` of a unique-values answer. A missing or malformed one is an
    error, never zero: zero would pass for a field with few values."""
    total = result.get("total") if isinstance(result, dict) else None
    if not isinstance(total, int) or isinstance(total, bool):
        raise ToolFailed("The analytics service answered without a distinct count.")
    return total


async def _analytics(env: ToolEnv, process: str, inputs: dict[str, Any]) -> Any:
    body = {
        "inputs": {key: value for key, value in inputs.items() if value is not None}
    }
    return await env.call(
        "processes", "POST", f"/processes/{process}/execution", json_body=body
    )


# -- project.get_layers --------------------------------------------------------


class NamedStyle(BaseModel):
    id: str
    name: str


class StyleBrief(BaseModel):
    """The style the map draws for a layer."""

    id: str
    name: str
    #: The look in one line (``goatlib.style.summary.summarize``).
    summary: str
    #: The issues core sent with it, by level: ``error`` and ``damaged`` are
    #: errors; ``info`` is not counted.
    errors: int = 0
    warnings: int = 0
    #: The layer's other named styles.
    others: list[NamedStyle] = []


class LayerInfo(BaseModel):
    layer_project_id: int
    name: str
    type: str
    geometry_type: str | None = None
    group: str | None = None
    #: The user has no access to this dataset: listed, but its data cannot be read.
    locked: bool = False
    #: How many features the dataset has, when core knows it without counting
    #: (a catalog dataset's copy records it).
    feature_count: int | None = None
    #: The dataset's bounding box [west, south, east, north] in degrees,
    #: rounded to EXTENT_DECIMALS, when core has one.
    extent: list[float] | None = None
    #: The layer selected on the map the user sent this message from; set on
    #: that layer only (None is left out of the result).
    selected: bool | None = None
    #: Shown on the map (in the layer panel; a hidden group hides it too).
    visible: bool | None = None
    position: Literal["top", "below_labels", "below_roads"] | None = None
    group_id: int | None = None
    #: The place among its siblings in the layer tree, 0 on top.
    order: int | None = None
    #: None for a locked layer or a table.
    style: StyleBrief | None = None
    #: The layer's filter in this project, row by row, when it has one.
    filter: FilterBrief | None = None


class GroupInfo(BaseModel):
    id: int
    name: str
    parent_id: int | None = None
    #: Shown on the map; a hidden group hides its layers whatever their own
    #: flag says.
    visible: bool | None = None
    #: The place among its siblings in the layer tree, 0 on top.
    order: int | None = None


class BasemapBrief(BaseModel):
    """A basemap by id; name, tone and imagery when the page offers it."""

    id: str
    name: str | None = None
    tone: Literal["light", "dark"] | None = None
    imagery: bool | None = None


class ViewInfo(BaseModel):
    #: [longitude, latitude].
    center: list[float] | None = None
    zoom: float | None = None
    pitch: float | None = None
    bearing: float | None = None
    mode: Literal["2d", "3d"] | None = None
    projection: Literal["mercator", "globe"] | None = None


class MapBrief(BaseModel):
    """The open map: what the page shows now, else what core stores."""

    basemap: BasemapBrief | None
    #: The basemaps the project offers, as the page lists them.
    basemaps: list[BasemapBrief]
    view: ViewInfo | None
    #: The 3D settings; "automatic" when the project has none.
    scene: Literal["automatic"] | dict[str, Any]


class ProjectLayers(BaseModel):
    project_id: UUID
    name: str
    groups: list[GroupInfo]
    #: In the layer tree's order, top first.
    layers: list[LayerInfo]
    #: The open map; only for the project of the map page.
    map: MapBrief | None = None


#: Decimals a layer's extent keeps: a hundredth of a degree (about a kilometre)
#: tells a city's data from a country's, and keeps the layer list short.
EXTENT_DECIMALS = 2
_WKT_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _recorded_feature_count(row: Mapping[str, Any]) -> int | None:
    """The feature count core sends without counting: the one a catalog
    dataset's copy records (``other_properties.catalog_materialize``, which
    core serves from the dataset). Core keeps none for other layers, and
    counting each layer on every call would read whole tables."""
    other = row.get("other_properties")
    status = other.get("catalog_materialize") if isinstance(other, dict) else None
    count = status.get("feature_count") if isinstance(status, dict) else None
    if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
        return count
    return None


def layer_extent(row: Mapping[str, Any]) -> list[float] | None:
    """The bounding box of the extent core sends as WKT (a multipolygon in
    WGS84), rounded to EXTENT_DECIMALS; None without one, or for anything
    that is not a box in degrees."""
    wkt = row.get("extent")
    if not isinstance(wkt, str):
        return None
    numbers = [float(n) for n in _WKT_NUMBER.findall(wkt.split(";")[-1])]
    if not numbers or len(numbers) % 2:
        return None
    xs, ys = numbers[0::2], numbers[1::2]
    west, south, east, north = min(xs), min(ys), max(xs), max(ys)
    if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
        return None
    return [round(value, EXTENT_DECIMALS) for value in (west, south, east, north)]


def _style_brief(read: MapRead, layer_project_id: int) -> StyleBrief | None:
    styles = read.styles.get(layer_project_id) or {}
    active = styles.get("active")
    if not isinstance(active, dict) or active.get("id") is None:
        return None
    issues = [issue for issue in active.get("issues") or [] if isinstance(issue, dict)]
    document = active.get("document")
    return StyleBrief(
        id=str(active["id"]),
        name=str(active.get("name") or ""),
        summary=summarize(document) if isinstance(document, dict) else "",
        errors=sum(issue.get("level") in ("error", "damaged") for issue in issues),
        warnings=sum(issue.get("level") == "warning" for issue in issues),
        others=[
            NamedStyle(id=str(other["id"]), name=str(other.get("name") or ""))
            for other in styles.get("others") or []
            if isinstance(other, dict) and other.get("id") is not None
        ],
    )


def _all_custom(stored: FilterBrief) -> FilterBrief:
    return stored.model_copy(
        update={
            "rows": [row.model_copy(update={"text": CUSTOM}) for row in stored.rows]
        }
    )


async def _filter_briefs(
    env: ToolEnv, project_id: UUID, rows: Mapping[int, Mapping[str, Any]]
) -> dict[int, FilterBrief]:
    """Each filtered layer's filter in words. The words need the layer's
    field types: one fields read per filtered layer, all at once; a layer
    whose read fails shows its rows as "custom". A locked layer is never
    read, and its filter is withheld as core withholds its other details.
    An area's features are named by their layer's name and number."""
    layers = layer_labels(rows)
    stored = {
        link: found
        for link, row in rows.items()
        if not row.get("locked")
        and (found := brief(row.get("query"), {}, layers=layers)) is not None
    }

    async def worded(link: int) -> FilterBrief:
        row = rows[link]
        try:
            fields = await _fields(
                env,
                _Layer(
                    project_id,
                    link,
                    str(row["layer_id"]),
                    str(row.get("name") or ""),
                    row.get("feature_layer_geometry_type"),
                ),
            )
        # A refused or unreadable answer, or a row without its dataset.
        except (ToolFailed, KeyError, AttributeError, TypeError):
            return _all_custom(stored[link])
        return brief(row.get("query"), fields, layers=layers) or stored[link]

    links = list(stored)
    return dict(zip(links, await asyncio.gather(*map(worded, links)), strict=True))


def _number(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return None


def _view(page: ProjectMapContext, document: Mapping[str, Any]) -> ViewInfo | None:
    """The page's live view; the view core stores for the user when the page
    sends none."""
    if page.viewport is not None:
        port = page.viewport
        return ViewInfo(
            center=list(port.center),
            zoom=port.zoom,
            pitch=port.pitch,
            bearing=port.bearing,
            mode=page.view_mode,
            projection=page.projection,
        )
    stored = document.get("view")
    stored = stored if isinstance(stored, dict) else {}
    center = stored.get("center")
    mode, projection = stored.get("mode"), stored.get("projection")
    view = ViewInfo(
        center=[float(n) for n in center]
        if isinstance(center, list)
        and len(center) == 2
        and all(_number(n) is not None for n in center)
        else None,
        zoom=_number(stored.get("zoom")),
        pitch=_number(stored.get("pitch")),
        bearing=_number(stored.get("bearing")),
        mode=page.view_mode or (mode if mode in ("2d", "3d") else None),
        projection=page.projection
        or (projection if projection in ("mercator", "globe") else None),
    )
    return view if view.model_dump(exclude_none=True) else None


def _offered(basemap: BasemapInfo) -> BasemapBrief:
    return BasemapBrief(
        id=basemap.id,
        name=basemap.name,
        tone=advised_tone(basemap),
        imagery=basemap.imagery,
    )


def _map_brief(page: ProjectMapContext, read: MapRead) -> MapBrief:
    offered = [_offered(basemap) for basemap in page.basemaps]
    shown = read.project.get("basemap")
    basemap = (
        next((b for b in offered if b.id == shown), BasemapBrief(id=shown))
        if isinstance(shown, str) and shown
        else None
    )
    scene = read.document.get("scene")
    return MapBrief(
        basemap=basemap,
        basemaps=offered,
        view=_view(page, read.document),
        scene=scene if isinstance(scene, dict) else "automatic",
    )


async def _get_layers(env: ToolEnv, args: ProjectInput) -> ProjectLayers:
    project_id = _project_id(env, args.project_id)
    read = await read_map(env, project_id)
    group_names = {group["id"]: group["name"] for group in read.groups}
    # Only the open project has a selection and a map; a source project read
    # by its ID has neither.
    page = (
        env.page
        if isinstance(env.page, ProjectMapContext) and env.page.project_id == project_id
        else None
    )
    selected = page.selected_layer_project_id if page is not None else None
    filters = await _filter_briefs(env, project_id, read.rows)
    # The tree's order; a row the document does not list yet (a layer just
    # added) comes last, without map state.
    tree = read.tree()
    placed = [
        item for item in tree if item["type"] == "layer" and item["id"] in read.rows
    ]
    tree_order = {item["id"]: item["order"] for item in tree if item["type"] == "group"}
    group_entries = read.group_entries()
    listed = {item["id"] for item in placed}
    order = [(item["id"], item) for item in placed] + [
        (link, None) for link in read.rows if link not in listed
    ]
    layers: list[LayerInfo] = []
    for link, item in order:
        row = read.rows[link]
        entry = read.entry(link) if item is not None else None
        locked = bool(row.get("locked"))
        group_id = (
            item["parent_id"] if item is not None else row.get("layer_project_group_id")
        )
        layers.append(
            LayerInfo(
                layer_project_id=link,
                name=row.get("name") or f"layer {link}",
                type=row.get("type") or "unknown",
                geometry_type=row.get("feature_layer_geometry_type"),
                group=group_names.get(group_id),
                locked=locked,
                # Withheld for a locked layer, as core withholds its other
                # details.
                feature_count=None if locked else _recorded_feature_count(row),
                extent=None if locked else layer_extent(row),
                selected=True if selected is not None and link == selected else None,
                visible=bool(entry.get("visible", True)) if entry is not None else None,
                position=entry.get("position", "top") if entry is not None else None,
                group_id=group_id,
                order=item["order"] if item is not None else None,
                style=None
                if locked or row.get("type") == "table" or item is None
                else _style_brief(read, link),
                filter=filters.get(link),
            )
        )
    return ProjectLayers(
        project_id=project_id,
        name=read.project.get("name") or str(project_id),
        groups=[
            GroupInfo(
                id=g["id"],
                name=g["name"],
                parent_id=g.get("parent_id"),
                # Core writes a group's flag always; an absent one reads as
                # the default, shown.
                visible=bool(entry.get("visible", True))
                if (entry := group_entries.get(g["id"])) is not None
                else None,
                order=tree_order.get(g["id"]),
            )
            for g in read.groups
        ],
        layers=layers,
        map=_map_brief(page, read) if page is not None else None,
    )


GET_LAYERS: ToolSpec[ProjectInput, ProjectLayers] = ToolSpec(
    name="project.get_layers",
    description=(
        "List a project's layers and groups in the layer tree's order: names, "
        "types, geometry types, each layer's extent (bounding box) and feature "
        "count when known, which layers the user cannot read (locked) and which "
        "one is selected on the map. Each layer also shows its map state: shown "
        "or hidden, position, place in the tree, its drawn style in one line with "
        "its other named styles, and its filter as numbered rows in words; groups "
        "show whether they are shown and their place. A layer is drawn only when "
        "it and its group are shown. On the "
        "map page it also names the basemap, the basemaps on offer, the view and "
        "the 3D scene. Call this first; other project tools take the "
        "layer_project_id it returns."
    ),
    input_model=ProjectInput,
    output_model=ProjectLayers,
    run=_get_layers,
    surfaces=PROJECT_SURFACES,
)


# -- project.get_fields --------------------------------------------------------


class FieldInfo(BaseModel):
    name: str
    #: ``string``, ``number``, ``integer``, ``boolean``, ``date-time`` or another JSON type.
    type: str
    #: Whether filters may use it (``FILTERABLE_KINDS``).
    filterable: bool


class LayerFields(BaseModel):
    layer: str
    fields: list[FieldInfo]
    geometry_type: str | None = None


async def _get_fields(env: ToolEnv, args: LayerInput) -> LayerFields:
    layer = await _readable_layer(env, args, wait_for_copy=True)
    fields = await _fields(env, layer)
    return LayerFields(
        layer=layer.name,
        fields=[
            FieldInfo(name=name, type=kind, filterable=kind in FILTERABLE_KINDS)
            for name, kind in fields.items()
        ],
        geometry_type=layer.geometry_type,
    )


GET_FIELDS: ToolSpec[LayerInput, LayerFields] = ToolSpec(
    name="project.get_fields",
    description=(
        "List a layer's fields (attribute names), their types, and which of them "
        "filters can use."
    ),
    input_model=LayerInput,
    output_model=LayerFields,
    run=_get_fields,
    surfaces=PROJECT_SURFACES,
)


# -- project.count_features ----------------------------------------------------


class FeatureCount(BaseModel):
    layer: str
    filter: str
    count: int
    #: Set when a field was read with the join prefix.
    note: str | None = None


async def _count(env: ToolEnv, args: FilteredLayerInput) -> FeatureCount:
    layer = await _readable_layer(env, args)
    names = await _names(
        env,
        layer,
        needed=args.filter is not None or _saved(layer, args.as_drawn) is not None,
    )
    feature_filter = names.filter(args.filter)
    where, words = _where(layer, names.fields, feature_filter, args.as_drawn)
    result = await _analytics(
        env, "feature-count", {"collection": layer.layer_id, "filter": _text(where)}
    )
    return FeatureCount(
        layer=layer.name,
        filter=words,
        count=int(result["count"]),
        note=_note(*names.notes()),
    )


COUNT_FEATURES: ToolSpec[FilteredLayerInput, FeatureCount] = ToolSpec(
    name="project.count_features",
    description=(
        "Count a layer's features, optionally only those matching a filter. The "
        "layer's saved filter in the project applies only with as_drawn true, "
        "which counts what the map shows."
    ),
    input_model=FilteredLayerInput,
    output_model=FeatureCount,
    run=_count,
    surfaces=PROJECT_SURFACES,
)


# -- project.field_statistics --------------------------------------------------


#: The class break methods: a style's (``goatlib.style.models.classify.
#: NUMERIC_METHODS``) and the analytics endpoint's ``standard_deviation``
#: (``goatlib.analysis.schemas.statistics.ClassBreakMethod``, which imports
#: DuckDB and so is not read here).
StatisticsMethod = Literal[
    "quantile",
    "equal_interval",
    "natural_breaks",
    "std_dev",
    "standard_deviation",
    "heads_and_tails",
    "geometric_interval",
]
#: The endpoint reads a method it does not know as quantile.
_ENDPOINT_METHODS: dict[str, str] = {"std_dev": "standard_deviation"}
_STYLE_METHODS: dict[str, str] = {"standard_deviation": "std_dev"}


class StatisticsInput(FilteredLayerInput):
    field: str = Field(
        description="The field to describe, as project_get_fields lists it."
    )
    method: StatisticsMethod = Field(
        default="quantile",
        description=(
            "Classification method for numeric fields, by the style's method "
            "names: quantile, equal_interval, natural_breaks, std_dev, "
            "heads_and_tails or geometric_interval (standard_deviation is read "
            "as std_dev)."
        ),
    )
    breaks: int = Field(
        default=5,
        ge=2,
        le=10,
        description="Number of class break points (the values form breaks + 1 classes).",
    )


class ValueCount(BaseModel):
    #: Text, whatever the field's type.
    value: str | None
    count: int


class FieldStatistics(BaseModel):
    layer: str
    field: str
    kind: Literal["numeric", "categorical"]
    filter: str
    #: The features the filter keeps that have a value in the field, and
    #: those that have none.
    count: int
    empty: int
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    std_dev: float | None = None
    method: str | None = None
    breaks: list[float] | None = None
    distinct_count: int | None = None
    values: list[ValueCount] | None = None
    note: str | None = None


def _features(result: Any, key: str) -> int:
    """A number of features in an analytics answer; a missing or malformed
    one is an error, never zero."""
    value = result.get(key) if isinstance(result, dict) else None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ToolFailed("The analytics service answered without a feature count.")
    return value


async def _field_statistics(env: ToolEnv, args: StatisticsInput) -> FieldStatistics:
    layer = await _readable_layer(env, args)
    names = await _names(env, layer)
    fields = names.fields
    field = names.name(args.field)
    if field not in fields:
        raise InputInvalid(unknown_field(field, fields))
    feature_filter = names.filter(args.filter)
    where, described = _where(layer, fields, feature_filter, args.as_drawn)
    cql = _text(where)
    note = _note(*names.notes())
    if fields[field] in _NUMERIC:
        # The histogram counts the features and those without a value in
        # one request; one bin is the least it computes besides.
        result, counted = await asyncio.gather(
            _analytics(
                env,
                "class-breaks",
                {
                    "collection": layer.layer_id,
                    "attribute": field,
                    "method": _ENDPOINT_METHODS.get(args.method, args.method),
                    # Internal break points: ``breaks + 1`` classes.
                    "breaks": args.breaks,
                    "filter": cql,
                },
            ),
            _analytics(
                env,
                "histogram",
                {
                    "collection": layer.layer_id,
                    "column": field,
                    "num_bins": 1,
                    "filter": cql,
                },
            ),
        )
        total = _features(counted, "total_rows")
        empty = _features(counted, "missing_count")
        method = result.get("method")
        return FieldStatistics(
            layer=layer.name,
            field=field,
            kind="numeric",
            filter=described,
            count=total - empty,
            empty=empty,
            min=result.get("min"),
            max=result.get("max"),
            mean=result.get("mean"),
            std_dev=result.get("std_dev"),
            method=_STYLE_METHODS.get(method, method)
            if isinstance(method, str)
            else None,
            breaks=result.get("breaks"),
            note=note,
        )
    # unique-values leaves out the features without a value: two counts,
    # all features and those without a value, as the legend counts them.
    without = {"op": "isNull", "args": [{"property": field}]}
    result, all_counted, empty_counted = await asyncio.gather(
        _analytics(
            env,
            "unique-values",
            {
                "collection": layer.layer_id,
                "attribute": field,
                "order": "descendent",
                "limit": UNIQUE_VALUES,
                "filter": cql,
            },
        ),
        _analytics(env, "feature-count", {"collection": layer.layer_id, "filter": cql}),
        _analytics(
            env,
            "feature-count",
            {
                "collection": layer.layer_id,
                "filter": json.dumps(
                    without
                    if where is None
                    else {"op": "and", "args": [where, without]}
                ),
            },
        ),
    )
    empty = _features(empty_counted, "count")
    return FieldStatistics(
        layer=layer.name,
        field=field,
        kind="categorical",
        filter=described,
        count=max(0, _features(all_counted, "count") - empty),
        empty=empty,
        distinct_count=_distinct_total(result),
        values=[
            ValueCount(
                value=None if v["value"] is None else str(v["value"]),
                count=int(v["count"]),
            )
            for v in result.get("values", [])
        ],
        note=note,
    )


FIELD_STATISTICS: ToolSpec[StatisticsInput, FieldStatistics] = ToolSpec(
    name="project.field_statistics",
    description=(
        "Describe one field of a layer. Numeric fields: minimum, maximum, mean, "
        "standard deviation and class breaks computed by GOAT (breaks N gives N "
        "break points, so N + 1 classes). The breaks describe the distribution and "
        "may serve, rounded, as limits for manual classes or for workflow "
        "settings; do not invent limits without them. A style with a computed "
        "method takes the method and the count, and the server computes its "
        "classes. Other fields: the number of distinct values and the "
        f"{UNIQUE_VALUES} most frequent ones with their counts. Values come back "
        "as text, whatever the field's type. Both answers carry count (the "
        "features with a value) and empty (those without one) under the given "
        "filter, so no separate count is needed. The layer's saved filter in the "
        "project applies only with as_drawn true: read a filtered layer's numbers "
        "with it to class what the map shows."
    ),
    input_model=StatisticsInput,
    output_model=FieldStatistics,
    run=_field_statistics,
    surfaces=PROJECT_SURFACES,
)


# -- project.area_statistics ---------------------------------------------------


class AreaStatisticsInput(FilteredLayerInput):
    group_by: str | None = Field(
        default=None,
        description="A field whose values form groups: the area per value, largest first (at most 100).",
    )


class AreaGroup(BaseModel):
    group: str | None
    feature_count: int
    total_area: float | None = None
    mean_area: float | None = None


class AreaStatistics(BaseModel):
    layer: str
    filter: str
    feature_count: int
    total_area: float | None = None
    mean_area: float | None = None
    min_area: float | None = None
    max_area: float | None = None
    unit: str = "m²"
    #: With group_by: the area per value of the field, largest total first, as
    #: many as processes lists (MAX_GROUPS); groups_total counts all of them.
    groups: list[AreaGroup] | None = None
    groups_total: int | None = None
    note: str | None = None


def _area_group(item: Mapping[str, Any]) -> AreaGroup:
    count = int(item.get("feature_count") or 0)
    area = item.get("total_area")
    return AreaGroup(
        group=_group_value(item.get("grouped_value")),
        feature_count=count,
        total_area=area,
        mean_area=area / count if area is not None and count else None,
    )


async def _area_statistics(env: ToolEnv, args: AreaStatisticsInput) -> AreaStatistics:
    layer = await _readable_layer(env, args)
    if layer.geometry_type != "polygon":
        raise ToolFailed(
            f"Area statistics need a polygon layer; {layer.name!r} has {layer.geometry_type} features."
        )
    names = await _names(
        env,
        layer,
        needed=args.group_by is not None
        or args.filter is not None
        or _saved(layer, args.as_drawn) is not None,
    )
    group_by = names.name(args.group_by)
    if group_by is not None and group_by not in names.fields:
        raise InputInvalid(unknown_field(group_by, names.fields))
    feature_filter = names.filter(args.filter)
    where, words = _where(layer, names.fields, feature_filter, args.as_drawn)
    cql = _text(where)
    total, smallest, largest = await asyncio.gather(
        *(
            _analytics(
                env,
                "area-statistics",
                {
                    "collection": layer.layer_id,
                    "operation": operation,
                    "filter": cql,
                    # The sum call answers the groups as well; the smallest and
                    # largest stay over the whole (filtered) layer.
                    "group_by_column": group_by if operation == "sum" else None,
                },
            )
            for operation in ("sum", "min", "max")
        )
    )
    count = int(total.get("feature_count") or 0)
    area = total.get("total_area")
    groups: list[AreaGroup] | None = None
    groups_total: int | None = None
    note: str | None = None
    if group_by is not None:
        groups = [
            _area_group(item)
            for item in total.get("groups") or []
            if isinstance(item, dict)
        ]
        listed = total.get("total_groups")
        groups_total = listed if isinstance(listed, int) else len(groups)
        if any(group.group is None for group in groups):
            # Sent without its group key, the row could pass for a total.
            note = (
                f"A row without group holds the features with no value in {group_by!r}."
            )
    return AreaStatistics(
        layer=layer.name,
        filter=words,
        feature_count=count,
        total_area=area,
        mean_area=area / count if area is not None and count else None,
        min_area=smallest.get("result"),
        max_area=largest.get("result"),
        unit=total.get("unit") or "m²",
        groups=groups,
        groups_total=groups_total,
        note=_note(*names.notes(), note),
    )


AREA_STATISTICS: ToolSpec[AreaStatisticsInput, AreaStatistics] = ToolSpec(
    name="project.area_statistics",
    description=(
        "Area of a polygon layer's features: count, total, mean, smallest and "
        "largest, in square metres. With group_by, the area per value of a field. "
        "Areas are measured on the ellipsoid in m²."
    ),
    input_model=AreaStatisticsInput,
    output_model=AreaStatistics,
    run=_area_statistics,
    surfaces=PROJECT_SURFACES,
)


# -- project.sample_features ---------------------------------------------------


class SampleInput(FilteredLayerInput):
    fields: list[str] = Field(
        default_factory=list,
        max_length=SAMPLE_FIELDS_MAX,
        description=f"Fields to include (at most {SAMPLE_FIELDS_MAX}); empty for the first {SAMPLE_FIELDS_MAX}.",
    )
    limit: int = Field(default=5, description=f"Features to return (1-{SAMPLE_MAX}).")


class SampleFeature(BaseModel):
    #: GOAT's id of the row (geoapi's feature id). Named apart from the
    #: properties: data often has a field ``id`` of its own, with other values.
    feature_id: Any
    properties: dict[str, Any]


class FeatureSample(BaseModel):
    layer: str
    filter: str
    number_matched: int | None = None
    features: list[SampleFeature] = Field(default_factory=list)


def _short(value: Any) -> Any:
    if isinstance(value, str) and len(value) > _SAMPLE_VALUE_CHARS:
        return value[:_SAMPLE_VALUE_CHARS] + "…"
    return value


async def _sample(env: ToolEnv, args: SampleInput) -> FeatureSample:
    layer = await _readable_layer(env, args)
    fields = await _fields(env, layer)
    for name in args.fields:
        if name not in fields:
            raise InputInvalid(unknown_field(name, fields))
    selected = args.fields or list(fields)[:SAMPLE_FIELDS_MAX]
    params: dict[str, object] = {
        "limit": max(1, min(args.limit, SAMPLE_MAX)),
        "properties": selected,
    }
    where, words = _where(layer, fields, args.filter, args.as_drawn)
    if where is not None:
        params["filter"] = json.dumps(where)
        params["filter-lang"] = "cql2-json"
    body = await env.call(
        "geoapi", "GET", f"/collections/{layer.layer_id}/items", params=params
    )
    features = [
        SampleFeature(
            feature_id=feature.get("id"),
            properties={
                key: _short(value)
                for key, value in (feature.get("properties") or {}).items()
            },
        )
        for feature in body.get("features", [])
    ]
    return FeatureSample(
        layer=layer.name,
        filter=words,
        number_matched=body.get("numberMatched"),
        features=features,
    )


SAMPLE_FEATURES: ToolSpec[SampleInput, FeatureSample] = ToolSpec(
    name="project.sample_features",
    description=(
        f"A few features of a layer (at most {SAMPLE_MAX}), attributes only, no "
        "geometry, to see what the data looks like. Not for counting: use "
        "project_count_features. A feature's feature_id is GOAT's row id, not a "
        "field: filters take the fields under properties."
    ),
    input_model=SampleInput,
    output_model=FeatureSample,
    run=_sample,
    surfaces=PROJECT_SURFACES,
)


# -- project.get_workflows / project.get_layouts -------------------------------

_TEXT_CHARS = 200


def _clip_text(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    return value if len(value) <= _TEXT_CHARS else value[:_TEXT_CHARS] + "…"


class WorkflowInfo(BaseModel):
    id: str
    name: str
    description: str | None = None
    is_default: bool | None = None
    #: The analysis tools its steps run, e.g. catchment_area, buffer.
    tools: list[str] = Field(default_factory=list)
    #: The names of the datasets it starts from.
    inputs: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class ProjectWorkflows(BaseModel):
    project_id: UUID
    project_name: str
    workflows: list[WorkflowInfo]


def _workflow(row: dict[str, Any]) -> WorkflowInfo:
    nodes = [
        node
        for node in ((row.get("config") or {}).get("nodes") or [])
        if isinstance(node, dict)
    ]
    data = [node.get("data") or {} for node in nodes]
    tools = [str(d["processId"]) for d in data if isinstance(d.get("processId"), str)]
    inputs = [str(d["layerName"]) for d in data if isinstance(d.get("layerName"), str)]
    return WorkflowInfo(
        id=str(row.get("id")),
        name=str(row.get("name") or ""),
        description=_clip_text(row.get("description")),
        is_default=True if row.get("is_default") else None,
        tools=list(dict.fromkeys(tools)),
        inputs=list(dict.fromkeys(inputs)),
        updated_at=row.get("updated_at"),
    )


async def _get_workflows(env: ToolEnv, args: ProjectInput) -> ProjectWorkflows:
    project_id = _project_id(env, args.project_id)
    project, rows = await asyncio.gather(
        _core(env, f"/{project_id}"), _core(env, f"/{project_id}/workflow")
    )
    return ProjectWorkflows(
        project_id=project_id,
        project_name=str(project.get("name") or ""),
        workflows=[_workflow(row) for row in rows or []],
    )


GET_WORKFLOWS: ToolSpec[ProjectInput, ProjectWorkflows] = ToolSpec(
    name="project.get_workflows",
    description=(
        "List a project's workflows (chains of analysis steps in its Workflows "
        "mode): names, descriptions, the analysis tools they run and the datasets "
        "they start from. Pass project_id for a project other than the open one. "
        "Show the ones your answer points to with core_show_items (kind workflow)."
    ),
    input_model=ProjectInput,
    output_model=ProjectWorkflows,
    run=_get_workflows,
    surfaces=PROJECT_SURFACES,
)


class LayoutInfo(BaseModel):
    id: str
    name: str
    description: str | None = None
    is_default: bool | None = None
    #: e.g. "A4 landscape".
    page: str | None = None
    #: What is on the page, e.g. map, legend, text.
    elements: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class ProjectLayouts(BaseModel):
    project_id: UUID
    project_name: str
    layouts: list[LayoutInfo]


def _layout(row: dict[str, Any]) -> LayoutInfo:
    config = row.get("config") or {}
    page = config.get("page") or {}
    size = " ".join(
        str(part) for part in (page.get("size"), page.get("orientation")) if part
    )
    kinds = [
        str(element["type"])
        for element in (config.get("elements") or [])
        if isinstance(element, dict) and isinstance(element.get("type"), str)
    ]
    return LayoutInfo(
        id=str(row.get("id")),
        name=str(row.get("name") or ""),
        description=_clip_text(row.get("description")),
        is_default=True if row.get("is_default") else None,
        page=size or None,
        elements=list(dict.fromkeys(kinds)),
        updated_at=row.get("updated_at"),
    )


async def _get_layouts(env: ToolEnv, args: ProjectInput) -> ProjectLayouts:
    project_id = _project_id(env, args.project_id)
    project, rows = await asyncio.gather(
        _core(env, f"/{project_id}"), _core(env, f"/{project_id}/report-layout")
    )
    return ProjectLayouts(
        project_id=project_id,
        project_name=str(project.get("name") or ""),
        layouts=[_layout(row) for row in rows or []],
    )


GET_LAYOUTS: ToolSpec[ProjectInput, ProjectLayouts] = ToolSpec(
    name="project.get_layouts",
    description=(
        "List a project's print layouts (pages in its Layouts mode): names, page "
        "size and what is on the page. Pass project_id for a project other than "
        "the open one. Show the ones your answer points to with core_show_items "
        "(kind layout)."
    ),
    input_model=ProjectInput,
    output_model=ProjectLayouts,
    run=_get_layouts,
    surfaces=PROJECT_SURFACES,
)


# -- project.group_statistics --------------------------------------------------

GroupOperation = Literal["count", "sum", "mean", "min", "max"]
GroupOrder = Literal["value", "share"]
#: The groups a result lists at most, as its rows.
MAX_GROUPS = 100
#: The groups of a share's denominator read at most (processes' aggregation-stats
#: takes a limit of up to 1000): a row's group may come anywhere in the other
#: layer's list, and only the rows go to the model. Rows ranked by share read
#: as many of the first layer's groups: processes sorts by value, and a small
#: group with the highest share comes last in that order.
DENOMINATOR_GROUPS = 1000
SHARE_DECIMALS = 6


class ShareOf(BaseModel):
    model_config = ConfigDict(extra="forbid")

    layer_project_id: int = Field(
        ge=1,
        description=(
            "The other layer, in the same project; the same layer with its own "
            "filter is fine."
        ),
    )
    operation: GroupOperation = Field(
        default="sum", description="Its statistic, as operation."
    )
    field: str | None = Field(
        default=None, description="Its field the statistic is of; left out for count."
    )
    group_by: str | None = Field(
        default=None,
        description=(
            "Its field holding the same values as the first layer's group_by; left "
            "out to divide every row by the other layer's total."
        ),
    )
    filter: FeatureFilter | None = Field(
        default=None,
        description=(
            "Its own filter, for the denominator only (the first layer's filter "
            "and as_drawn do not apply to it). " + FILTER_EXAMPLES
        ),
    )


class GroupStatisticsInput(FilteredLayerInput):
    operation: GroupOperation = Field(
        description="sum, mean, min or max of field, or count of features."
    )
    field: str | None = Field(
        default=None,
        description="The numeric field the statistic is of; left out for count.",
    )
    group_by: str | None = Field(
        default=None,
        description=(
            "The field whose values form the groups; left out for one row over the "
            "whole (filtered) layer."
        ),
    )
    then_by: str | None = Field(
        default=None, description="A second field: groups inside each group_by value."
    )
    share_of: ShareOf | None = Field(
        default=None,
        description=(
            "Divide each row's value by a statistic of another layer, or of the "
            "same layer with its own filter: with share_of.group_by, its value for "
            "the same group (residents per district and band by residents per "
            "district); without, its total."
        ),
    )
    order_by: GroupOrder = Field(
        default="value",
        description=(
            "value: the rows by their value; share (needs share_of): by their "
            "share, the rows without a share last. Rank by share for the groups "
            "with the highest or lowest share: a small group can hold the "
            "highest share."
        ),
    )
    lowest_first: bool = Field(
        default=False, description="The lowest value or share first."
    )
    limit: int = Field(
        default=MAX_GROUPS,
        ge=1,
        le=MAX_GROUPS,
        description=f"The rows to return, the first in order_by (1-{MAX_GROUPS}).",
    )

    @model_validator(mode="after")
    def _groups_need_group_by(self) -> "GroupStatisticsInput":
        if self.order_by == "share" and self.share_of is None:
            raise ValueError("order_by share needs share_of: the shares it ranks by")
        if self.group_by is None:
            if self.then_by is not None:
                raise ValueError("then_by needs group_by: it groups inside group_by")
            if self.share_of is not None and self.share_of.group_by is not None:
                raise ValueError(
                    "share_of.group_by needs group_by: a grouped denominator "
                    "matches groups of the first layer"
                )
        return self


class GroupRow(BaseModel):
    group: str | None
    then: str | None = None
    value: float | None
    denominator: float | None = None
    share: float | None = None


class GroupStatistics(BaseModel):
    layer: str
    operation: GroupOperation
    field: str | None = None
    group_by: str | None
    then_by: str | None = None
    filter: str
    rows: list[GroupRow]
    #: Groups before the limit (the input's, at most MAX_GROUPS).
    groups: int
    features: int
    #: With share_of.group_by: distinct group values the other layer has no
    #: group for.
    #: Counted only when the other layer's list of groups is complete, never
    #: for the null group; left out when that list was cut at
    #: DENOMINATOR_GROUPS (it may hold them further down), so it never reads
    #: as all matched.
    unmatched: int | None = None
    note: str | None = None


def _null_notes(
    rows: list[GroupRow], group_by: str | None, then_by: str | None
) -> list[str]:
    """A row of the features with no value in a grouping field is sent without
    that key, so it could pass for a total: the note names the field. Without
    group_by the one row has no group by design, and there is nothing to name."""
    if group_by is None:
        return []
    notes = []
    if any(row.group is None for row in rows):
        notes.append(
            f"A row without group holds the features with no value in {group_by!r}."
        )
    if then_by is not None and any(row.then is None for row in rows):
        notes.append(
            f"A row without then holds the features with no value in {then_by!r}."
        )
    return notes


def _group_value(value: Any) -> str | None:
    return None if value is None else str(value)


def _number_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _need_fields(
    fields: Mapping[str, str],
    layer: _Layer,
    operation: str,
    field: str | None,
    *groups: str | None,
) -> None:
    if operation != "count":
        if field is None:
            raise InputInvalid(
                f"{operation} needs field: the numeric field the statistic is of."
            )
        if field not in fields:
            raise InputInvalid(
                f"{layer.name!r} has no field {field!r}; project_get_fields lists them."
            )
        if fields[field] not in _NUMERIC:
            raise InputInvalid(
                f"{field!r} is not numeric; {operation} needs a number field."
            )
    for name in groups:
        if name is not None and name not in fields:
            raise InputInvalid(
                f"{layer.name!r} has no field {name!r}; project_get_fields lists them."
            )


def _aggregation(
    layer: _Layer,
    operation: str,
    field: str | None,
    group_by: str | None,
    then_by: str | None,
    cql: str | None,
    limit: int = MAX_GROUPS,
    lowest_first: bool = False,
) -> dict[str, Any]:
    return {
        "collection": layer.layer_id,
        "operation": operation,
        "operation_column": field if operation != "count" else None,
        "group_by_column": group_by,
        "group_by_secondary_column": then_by,
        "filter": cql,
        "order": "ascendent" if lowest_first else "descendent",
        "limit": limit,
    }


def _items(answer: Any) -> list[dict[str, Any]]:
    items = answer.get("items") if isinstance(answer, dict) else None
    return [item for item in items or [] if isinstance(item, dict)]


def _lists_every_group(answer: Any, listed: int, limit: int) -> bool:
    """Whether an aggregation answer with ``listed`` non-null groups holds all
    of them. ``total_items`` is a COUNT(DISTINCT), which leaves the null group
    out, so it is compared with the non-null groups. Without a total, a list
    shorter than the request's ``limit`` was not cut."""
    total = answer.get("total_items") if isinstance(answer, dict) else None
    if isinstance(total, int) and not isinstance(total, bool):
        return total <= listed
    return len(_items(answer)) < limit


def _ranked_by_share(rows: list[GroupRow], lowest_first: bool) -> list[GroupRow]:
    """The rows by share, the highest first unless ``lowest_first``, and the
    rows without a share last in either order. The sort is stable, so rows of
    the same share keep processes' order, the largest value first."""
    shared = sorted(
        (row for row in rows if row.share is not None),
        key=lambda row: row.share or 0.0,
        reverse=not lowest_first,
    )
    return shared + [row for row in rows if row.share is None]


async def _group_statistics(
    env: ToolEnv, args: GroupStatisticsInput
) -> GroupStatistics:
    layer = await _readable_layer(env, args)
    names = await _names(env, layer)
    # A count reads no field: a stray one is neither resolved nor noted.
    field = names.name(args.field) if args.operation != "count" else args.field
    group_by = names.name(args.group_by)
    then_by = names.name(args.then_by)
    feature_filter = names.filter(args.filter)
    _need_fields(names.fields, layer, args.operation, field, group_by, then_by)
    where, words = _where(layer, names.fields, feature_filter, args.as_drawn)
    cql = _text(where)
    read_as = names.notes()
    by_share = args.order_by == "share"
    # Ranked by share, the groups are read in processes' order (by value),
    # as many as a denominator, and sorted here once the shares exist.
    answer = await _analytics(
        env,
        "aggregation-stats",
        _aggregation(
            layer,
            args.operation,
            field,
            group_by,
            then_by,
            cql,
            limit=DENOMINATOR_GROUPS if by_share else args.limit,
            lowest_first=args.lowest_first and not by_share,
        ),
    )
    rows = [
        GroupRow(
            group=_group_value(item.get("grouped_value")),
            then=_group_value(item.get("grouped_secondary_value")),
            value=_number_value(item.get("operation_value")),
        )
        for item in _items(answer)
    ]
    read = len(rows)
    listed = sum(1 for row in rows if row.group is not None)
    read_cut = (
        by_share
        and read >= DENOMINATOR_GROUPS
        and not _lists_every_group(answer, listed, DENOMINATOR_GROUPS)
    )

    def counted(count: int, kind: str = "group") -> str:
        # Ranked by share, the notes count every group read, while the limit
        # keeps fewer rows.
        if by_share:
            return f"{count} {kind}(s) of the {read} read"
        return f"{count} {kind}(s)"

    notes: list[str] = []
    unmatched: int | None = None
    zeros: list[str] = []
    if args.share_of is not None:
        share = args.share_of
        other = await _readable_layer(
            env,
            LayerInput(
                project_id=args.project_id, layer_project_id=share.layer_project_id
            ),
        )
        other_names = await _names(env, other)
        share_field = (
            other_names.name(share.field) if share.operation != "count" else share.field
        )
        share_group_by = other_names.name(share.group_by)
        share_filter = other_names.filter(share.filter)
        _need_fields(
            other_names.fields, other, share.operation, share_field, share_group_by
        )
        # Once each: the same layer may be divided by its own fields.
        read_as = list(dict.fromkeys([*read_as, *other_names.notes()]))
        if share.layer_project_id != args.layer_project_id:
            notes.append(
                f"Numerator and denominator are read from two layers "
                f"({layer.name!r}, {other.name!r}). If the layers come from "
                "different sources, check that both count the same population "
                "(source and year)."
            )
        # The first layer's filter never reaches the denominator: share_of
        # names its own, so the same layer can be divided by its whole.
        share_cql = await _cql(env, other, share_filter, other_names.fields)
        totals = await _analytics(
            env,
            "aggregation-stats",
            _aggregation(
                other,
                share.operation,
                share_field,
                share_group_by,
                None,
                share_cql,
                limit=DENOMINATOR_GROUPS,
            ),
        )
        if share_group_by is None:
            # One total for every row, the row without a group included: its
            # features are part of the whole as much as any group's.
            whole = next(
                (_number_value(item.get("operation_value")) for item in _items(totals)),
                None,
            )
            undivided_rows = 0
            for row in rows:
                row.denominator = whole
                if row.value is not None and whole:
                    row.share = round(row.value / whole, SHARE_DECIMALS)
                else:
                    undivided_rows += 1
            if undivided_rows:
                notes.append(
                    f"{counted(undivided_rows, 'row')} have no value or a "
                    "denominator of 0, so they have no share."
                )
        else:
            # The null group is no value to match: its features have none, in
            # either layer.
            denominators: dict[str, float | None] = {}
            for item in _items(totals):
                key = _group_value(item.get("grouped_value"))
                if key is not None:
                    denominators[key] = _number_value(item.get("operation_value"))
            missing: set[str] = set()
            undivided: set[str] = set()
            for row in rows:
                if row.group is None:
                    continue
                if row.group not in denominators:
                    missing.add(row.group)
                    continue
                denominator = denominators[row.group]
                row.denominator = denominator
                if row.value is not None and denominator:
                    row.share = round(row.value / denominator, SHARE_DECIMALS)
                else:
                    undivided.add(row.group)
            complete = _lists_every_group(totals, len(denominators), DENOMINATOR_GROUPS)
            unmatched = len(missing) if complete else None
            if missing and complete:
                notes.append(
                    f"{counted(len(missing))} have no matching value of "
                    f"{share_group_by!r} in {other.name!r}, so they have no share."
                )
            elif missing:
                notes.append(
                    f"{counted(len(missing))} have no share: {other.name!r} has "
                    f"more than {DENOMINATOR_GROUPS} values of {share_group_by!r}, "
                    f"and only its first {DENOMINATOR_GROUPS} (largest first) are "
                    "matched."
                )
            if undivided:
                notes.append(
                    f"{counted(len(undivided))} have no value or a denominator of "
                    "0, so they have no share."
                )
            if by_share and args.operation in ("sum", "count") and not read_cut:
                # A group with no features in the first layer has no row, but
                # its count or sum is 0, and so is its share: a filtered
                # numerator (residents in reach) leaves such groups out, and
                # the lowest shares would miss them. Only the other layer's
                # groups tell which; a cut list of them may hold more.
                seen = {row.group for row in rows}
                zeros = [
                    key
                    for key, denominator in denominators.items()
                    if key not in seen and denominator
                ]
                unchecked = (
                    f" Check their names against the {len(missing)} group(s) "
                    "without a match first."
                    if missing
                    else ""
                )
                if zeros and then_by is None:
                    rows += [
                        GroupRow(
                            group=key,
                            value=0.0,
                            denominator=denominators[key],
                            share=0.0,
                        )
                        for key in zeros
                    ]
                    notes.append(
                        f"{len(zeros)} group(s) of {other.name!r} have no features "
                        f"in {layer.name!r}: their rows hold 0 and a share of 0."
                        + unchecked
                    )
                elif zeros:
                    notes.append(
                        f"{len(zeros)} group(s) of {other.name!r} have no features "
                        f"in {layer.name!r}, so a share of 0, but no row: then_by "
                        "has no value for them." + unchecked
                    )
                    zeros = []
                if not complete:
                    notes.append(
                        f"Groups with no features among the values of "
                        f"{share_group_by!r} in {other.name!r} beyond its first "
                        f"{DENOMINATOR_GROUPS} are not ranked."
                    )
        # A sum or count over the same statistic of its whole never passes
        # 100 %: a share above it comes from a numerator and a denominator
        # assigned in different ways. The note counts those rows and names
        # none of them, nor any value. A ratio of means may pass 1.
        if share.operation == args.operation and args.operation in ("sum", "count"):
            above = sum(1 for row in rows if row.share is not None and row.share > 1)
            if above and group_by is None:
                notes.append(
                    "The share is above 100 %: numerator and denominator were "
                    "counted from different features. Rebuild the share from one "
                    "assignment before you answer; never present a share above "
                    "100 %."
                )
            elif above:
                notes.append(
                    f"{counted(above)} have a share above 100 %: numerator and "
                    "denominator were assigned to the groups differently. Rebuild "
                    "the share from one assignment, both counted per group the "
                    "same way, before you answer; never present a share above "
                    "100 %."
                )
    if by_share:
        if read_cut:
            notes.append(
                f"{layer.name!r} has more than {DENOMINATOR_GROUPS} groups: the "
                f"ranking by share covers the {DENOMINATOR_GROUPS} with the "
                "largest values, not the others, nor the groups with no "
                "features."
            )
        rows = _ranked_by_share(rows, args.lowest_first)
    rows = rows[: args.limit]
    notes += _null_notes(rows, group_by, then_by)
    total_items = answer.get("total_items") if isinstance(answer, dict) else None
    total_count = answer.get("total_count") if isinstance(answer, dict) else None
    return GroupStatistics(
        layer=layer.name,
        operation=args.operation,
        field=field,
        group_by=group_by,
        then_by=then_by,
        filter=words,
        rows=rows,
        groups=(int(total_items) if isinstance(total_items, int) else read)
        + len(zeros),
        features=int(total_count) if isinstance(total_count, int) else 0,
        unmatched=unmatched,
        note=_note(*read_as, *notes),
    )


GROUP_STATISTICS: ToolSpec[GroupStatisticsInput, GroupStatistics] = ToolSpec(
    name="project.group_statistics",
    description=(
        "A statistic of a layer per group: sum, mean, min or max of a numeric "
        "field, or the count of features, per value of group_by and optionally per "
        "value of then_by inside each (up to 100 groups, largest value first; "
        "lowest_first turns the order, limit keeps the first N). Without "
        "group_by, one row for the whole (filtered) layer. With share_of, each "
        "row's value is divided on the server by a statistic of another layer "
        "with its own operation (sum by default): its value for the same group "
        "with share_of.group_by, e.g. residents per district and band by "
        "residents per district, or its total without. share_of takes its own "
        "filter for the denominator, e.g. residents in a catchment over all "
        "residents. Use those shares, never compute them yourself. Groups "
        "without a share, and shares above 100 %, are counted in the note. "
        "For the groups with the highest or lowest share, set order_by share "
        "(with lowest_first for the lowest) and limit to the N asked for: the "
        "rows then come by share, a group of share_of.group_by with no features "
        "at 0 (count or sum), the groups without a share last, so a small group "
        "with the highest share comes first, not far down a list sorted by "
        "value. The layer's saved filter in the project applies only with "
        "as_drawn true."
    ),
    input_model=GroupStatisticsInput,
    output_model=GroupStatistics,
    run=_group_statistics,
    surfaces=PROJECT_SURFACES,
)

PROJECT_TOOLS: tuple[ToolSpec[Any, Any], ...] = (
    GET_LAYERS,
    GET_FIELDS,
    COUNT_FEATURES,
    FIELD_STATISTICS,
    GROUP_STATISTICS,
    AREA_STATISTICS,
    SAMPLE_FEATURES,
    GET_WORKFLOWS,
    GET_LAYOUTS,
)
