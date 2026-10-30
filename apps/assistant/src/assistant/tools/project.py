"""The read-only project pack (spec §7.2, §9.1.1, §10).

The read tools take a project ID, defaulting to the project of the page, so other
projects the user can open are readable as sources. The map-view proposal is the
exception: it only targets the project that is open.

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
from dataclasses import dataclass
from typing import Any, Literal, overload
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_ai.exceptions import ToolFailed

from assistant.context import ProjectMapContext, project_of
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
from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.policy import LOW_CARDINALITY_LIMIT, MIN_RESTRICTED_GROUP, Withheld
from assistant.tools.proposals import (
    MapCamera,
    MapViewPayload,
    Proposal,
    ProposalRow,
    ProposalShown,
    ProposalTarget,
    proposal_row,
    show,
)
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.workflows.tool_info import JOINED_PREFIX

#: Every project mode, and pages without a project (Home, content, settings),
#: where the tools need an explicit project_id (Decision T16).
PROJECT_SURFACES: frozenset[Surface] = frozenset(
    {"project.map", "project.workflows", "project.layouts", "project.dashboard", "none"}
)

_NUMERIC = {"integer", "number"}
_RESTRICTED_METHODS = {"quantile", "equal_interval"}
_DATA_LAYER_TYPES = {"feature", "table"}
SAMPLE_MAX = 10
SAMPLE_FIELDS_MAX = 20
_SAMPLE_VALUE_CHARS = 200
#: Values listed per categorical field; also the Restricted cardinality limit.
UNIQUE_VALUES = LOW_CARDINALITY_LIMIT
#: A server extent narrower than this (a single point, or features on one
#: meridian or parallel) is widened to it before it becomes a map view, because
#: a zero-sized box cannot be fitted. In degrees, roughly 200 m.
_MIN_EXTENT_DEGREES = 0.004
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


def _project_id(env: ToolEnv, given: UUID | None) -> UUID:
    if given is not None:
        return given
    current = project_of(env.page)
    if current is None:
        raise InputInvalid(
            "No project is open on this page; pass project_id (core_find finds projects by name)."
        )
    return current


async def _core(env: ToolEnv, path: str) -> Any:
    try:
        return await env.call("core", "GET", f"/api/v2/project{path}")
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        # Core's authorization answers 401 for "no access" too.
        if exc.status in (401, 403, 404):
            raise ToolFailed(
                "The project does not exist or the user cannot open it."
            ) from exc
        raise


@dataclass(frozen=True)
class _Layer:
    project_id: UUID
    layer_project_id: int
    layer_id: str
    name: str
    geometry_type: str | None


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
    for row in await _core(env, f"/{project_id}/layer"):
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
    Restricted guards, the request) sees the name that is read, so a read of
    ``x`` is checked exactly as a read of ``join_x``."""

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
        """One per name read with the prefix. They name fields, never values,
        so they are sent under Restricted too."""
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


#: What a filter may do under Restricted: pick categories, never compare values.
#: "Count where einwohner >= X", asked for X after X, spells out a value that
#: the policy withholds, one feature at a time or the whole layer in order.
_RESTRICTED_FILTER_OPS = frozenset({"=", "!=", "in", "is_null", "is_not_null"})


async def _guard_restricted_filter(
    env: ToolEnv, layer: _Layer, feature_filter: FeatureFilter | None
) -> None:
    """Under Restricted, a filter only selects categories: equality, set and
    null conditions on fields with at most LOW_CARDINALITY_LIMIT distinct
    values over the whole layer (the fields whose values Restricted lists)."""
    if env.data_policy != "restricted" or feature_filter is None:
        return
    for condition in feature_filter.conditions:
        if condition.op not in _RESTRICTED_FILTER_OPS:
            raise InputInvalid(
                f"The data policy (Restricted) allows no {condition.op!r} in a filter: "
                "comparing values would reveal values it withholds. Filter by "
                "categories only (=, !=, in, is_null, is_not_null), or answer without "
                "the filter."
            )
    picks = [c for c in feature_filter.conditions if c.op in ("=", "!=", "in")]
    fields = sorted({c.field for c in picks})
    answers = await asyncio.gather(
        *(
            _analytics(
                env,
                "unique-values",
                {
                    "collection": layer.layer_id,
                    "attribute": field,
                    "order": "descendent",
                    "limit": UNIQUE_VALUES,
                },
            )
            for field in fields
        )
    )
    counts: dict[str, dict[str, int]] = {}
    for field, answer in zip(fields, answers):
        if _distinct_total(answer) > LOW_CARDINALITY_LIMIT:
            raise InputInvalid(
                f"The data policy (Restricted) allows filters on category fields "
                f"only; {field!r} has more than {LOW_CARDINALITY_LIMIT} distinct "
                "values, so filtering by it could single out features."
            )
        counts[field] = {
            str(v["value"]): int(v["count"])
            for v in answer.get("values", [])
            if v.get("value") is not None
        }
    # A category held by fewer than MIN_RESTRICTED_GROUP features singles them
    # out: "name = Mitte" picks one district, "name != Südwest" leaves all but
    # one, and a maximum over the rest is then the second largest value.
    for condition in picks:
        values: list[Any] = (
            list(condition.value)
            if isinstance(condition.value, list)
            else [condition.value]
        )
        for value in values:
            held = counts[condition.field].get(str(value), 0)
            if held < MIN_RESTRICTED_GROUP:
                raise InputInvalid(
                    f"The data policy (Restricted) allows filtering only by values "
                    f"that at least {MIN_RESTRICTED_GROUP} features share; "
                    f"{condition.field} {value!r} is shared by fewer, so the filter "
                    "could single out features."
                )


async def _cql(
    env: ToolEnv,
    layer: _Layer,
    feature_filter: FeatureFilter | None,
    fields: Mapping[str, str] | None = None,
) -> str | None:
    """``fields``: the layer's fields when the caller has read them. The
    filter is checked against them first, so an unknown field gets its
    fixable message before the Restricted guard asks processes."""
    if feature_filter is None:
        return None
    cql = _compile(
        feature_filter, fields if fields is not None else await _fields(env, layer)
    )
    await _guard_restricted_filter(env, layer, feature_filter)
    return cql


def _with_value(
    feature_filter: FeatureFilter | None, fields: Mapping[str, str], field: str
) -> str:
    """The filter ANDed with "``field`` is not null" (without a filter, that
    condition alone), as a CQL2-JSON string. Class breaks, minimum and maximum
    skip rows where the field is null, so the group size that guards them must
    count those rows only: a filter padded with "or the field is null" would
    otherwise look like a large group."""
    present = {
        "op": "not",
        "args": [{"op": "isNull", "args": [{"property": field}]}],
    }
    if feature_filter is None:
        return json.dumps(present)
    return json.dumps({"op": "and", "args": [to_cql2(feature_filter, fields), present]})


def _feature_count(result: Any) -> int:
    """The ``count`` of a feature-count answer. A missing or malformed one is an
    error: the group-size guards must never run on a guess."""
    count = result.get("count") if isinstance(result, dict) else None
    if not isinstance(count, int) or isinstance(count, bool):
        raise ToolFailed("The analytics service answered without a feature count.")
    return count


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
    #: The layer's filter in this project (CQL2-JSON), when it has one.
    filter: dict[str, Any] | None = None
    #: Under Restricted, the filter's text is replaced by this: its literals are
    #: values picked from the dataset.
    has_filter: bool | None = None
    #: The layer selected on the map the user sent this message from; set on
    #: that layer only (None is left out of the result).
    selected: bool | None = None


class GroupInfo(BaseModel):
    id: int
    name: str
    parent_id: int | None = None


class ProjectLayers(BaseModel):
    project_id: UUID
    name: str
    groups: list[GroupInfo]
    layers: list[LayerInfo]

    def restricted(self) -> "ProjectLayers":
        return self.model_copy(
            update={
                "layers": [
                    layer.model_copy(update={"filter": None, "has_filter": True})
                    if layer.filter is not None
                    else layer.model_copy()
                    for layer in self.layers
                ]
            }
        )


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


def _extent(row: Mapping[str, Any]) -> list[float] | None:
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


async def _get_layers(env: ToolEnv, args: ProjectInput) -> ProjectLayers:
    project_id = _project_id(env, args.project_id)
    project, rows, groups = await asyncio.gather(
        _core(env, f"/{project_id}"),
        _core(env, f"/{project_id}/layer"),
        _core(env, f"/{project_id}/group"),
    )
    group_names = {group["id"]: group["name"] for group in groups}
    # Only the open project has a selection; a source project read by its ID has none.
    selected = (
        env.page.selected_layer_project_id
        if isinstance(env.page, ProjectMapContext) and env.page.project_id == project_id
        else None
    )
    layers: list[LayerInfo] = []
    # In the project's layer order already (core sorts by layer_order).
    for row in rows:
        locked = bool(row.get("locked"))
        layers.append(
            LayerInfo(
                layer_project_id=row["id"],
                name=row.get("name") or f"layer {row['id']}",
                type=row.get("type") or "unknown",
                geometry_type=row.get("feature_layer_geometry_type"),
                group=group_names.get(row.get("layer_project_group_id")),
                locked=locked,
                # Withheld for a locked layer, as core withholds its other
                # details.
                feature_count=None if locked else _recorded_feature_count(row),
                extent=None if locked else _extent(row),
                filter=(row.get("query") or {}).get("cql"),
                selected=True
                if selected is not None and row["id"] == selected
                else None,
            )
        )
    return ProjectLayers(
        project_id=project_id,
        name=project.get("name") or str(project_id),
        groups=[
            GroupInfo(id=g["id"], name=g["name"], parent_id=g.get("parent_id"))
            for g in groups
        ],
        layers=layers,
    )


GET_LAYERS: ToolSpec[ProjectInput, ProjectLayers] = ToolSpec(
    name="project.get_layers",
    description=(
        "List a project's layers and groups: names, types, geometry types, each "
        "layer's filter, its extent (bounding box) and feature count when known, "
        "which layers the user cannot read (locked) and which one is selected on "
        "the map. Call this first; other project tools take the layer_project_id "
        "it returns."
    ),
    input_model=ProjectInput,
    output_model=ProjectLayers,
    run=_get_layers,
    surfaces=PROJECT_SURFACES,
    returns_data=True,
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
    returns_data=False,
)


# -- project.count_features ----------------------------------------------------


class FeatureCount(BaseModel):
    layer: str
    filter: str
    count: int | None
    #: Set when the count is withheld (Restricted, a filter, a small group),
    #: or a field was read with the join prefix.
    note: str | None = None
    #: Whether a filter was applied; not shown to the model.
    filtered: bool = Field(default=False, exclude=True)
    #: The notes on names read with the join prefix (``_Names.notes``), for
    #: the Restricted form to keep; never serialized.
    read_as: list[str] = Field(default_factory=list, exclude=True)

    def restricted(self) -> "FeatureCount":
        # Counts are allowed under Restricted (spec §4.7), except a filtered one
        # below the group size: even category filters, combined, can single out
        # a feature, and "none" against "one" says whether it exists. A copy,
        # because the policy treats a reduction that returns the same object as
        # no reduction.
        if (
            self.filtered
            and self.count is not None
            and self.count < MIN_RESTRICTED_GROUP
        ):
            return self.model_copy(
                update={
                    "count": None,
                    "note": _note(
                        *self.read_as,
                        f"The filter matches fewer than {MIN_RESTRICTED_GROUP} "
                        "features; the data policy (Restricted) withholds the exact number.",
                    ),
                }
            )
        return self.model_copy()


async def _count(env: ToolEnv, args: FilteredLayerInput) -> FeatureCount:
    layer = await _readable_layer(env, args)
    names = await _names(env, layer, needed=args.filter is not None)
    feature_filter = names.filter(args.filter)
    cql = await _cql(env, layer, feature_filter, names.fields)
    read_as = names.notes()
    result = await _analytics(
        env, "feature-count", {"collection": layer.layer_id, "filter": cql}
    )
    return FeatureCount(
        layer=layer.name,
        filter=describe_filter(feature_filter),
        count=int(result["count"]),
        note=_note(*read_as),
        filtered=args.filter is not None,
        read_as=read_as,
    )


COUNT_FEATURES: ToolSpec[FilteredLayerInput, FeatureCount] = ToolSpec(
    name="project.count_features",
    description=(
        "Count a layer's features, optionally only those matching a filter. The "
        "layer's own filter in the project is not applied; pass it as a filter if "
        "the count should match what the map shows."
    ),
    input_model=FilteredLayerInput,
    output_model=FeatureCount,
    run=_count,
    surfaces=PROJECT_SURFACES,
    returns_data=True,
)


# -- project.field_statistics --------------------------------------------------


class StatisticsInput(FilteredLayerInput):
    field: str = Field(
        description="The field to describe, as project_get_fields lists it."
    )
    method: Literal[
        "quantile", "equal_interval", "standard_deviation", "heads_and_tails"
    ] = Field(
        default="quantile", description="Classification method for numeric fields."
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
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    std_dev: float | None = None
    method: str | None = None
    breaks: list[float] | None = None
    #: How many features the filter matches with a value in the field; set
    #: only under Restricted with a filter, where it decides whether the
    #: numbers may be shown.
    feature_count: int | None = None
    distinct_count: int | None = None
    values: list[ValueCount] | None = None
    note: str | None = None
    #: Whether the field has few distinct values over the whole layer, not only
    #: over the filtered features. Set under Restricted; never serialized.
    low_cardinality: bool | None = Field(default=None, exclude=True)
    #: The break points allowed under Restricted: ``points + 1`` classes of at
    #: least MIN_RESTRICTED_GROUP features with a value each. Never
    #: serialized. Fewer than two (the fewest the service computes) means no
    #: breaks may be shown.
    points: int | None = Field(default=None, exclude=True)
    #: The notes on names read with the join prefix (``_Names.notes``), for
    #: the Restricted form to keep; never serialized.
    read_as: list[str] = Field(default_factory=list, exclude=True)

    def restricted(self) -> "FieldStatistics":
        if self.kind == "numeric":
            notes = [
                *self.read_as,
                "Mean and standard deviation are withheld by the data policy (Restricted).",
            ]
            update: dict[str, Any] = {"mean": None, "std_dev": None}
            if self.method not in _RESTRICTED_METHODS:
                # Breaks from other methods are built on the mean and deviation.
                update["breaks"] = None
            if (
                self.feature_count is not None
                and self.feature_count < MIN_RESTRICTED_GROUP
            ):
                update.update(min=None, max=None, breaks=None)
                notes.append(
                    f"The filter matches fewer than {MIN_RESTRICTED_GROUP} features "
                    "with a value, so minimum, maximum and class breaks are withheld too."
                )
            elif update.get("breaks", self.breaks) is not None and (
                self.points is None or self.points < 2
            ):
                update["breaks"] = None
                notes.append(
                    "Class breaks are withheld too: each class must hold at least "
                    f"{MIN_RESTRICTED_GROUP} features with a value, and there are too "
                    "few for three classes."
                )
            return self.model_copy(update={**update, "note": " ".join(notes)})
        low = (
            self.low_cardinality
            if self.low_cardinality is not None
            else self.distinct_count is not None
            and self.distinct_count <= LOW_CARDINALITY_LIMIT
        )
        if low:
            return self.model_copy()
        return self.model_copy(
            update={
                "values": None,
                "note": _note(
                    *self.read_as,
                    "Values are withheld by the data policy (Restricted): the field has "
                    f"more than {LOW_CARDINALITY_LIMIT} distinct values.",
                ),
            }
        )


async def _field_statistics(env: ToolEnv, args: StatisticsInput) -> FieldStatistics:
    layer = await _readable_layer(env, args)
    names = await _names(env, layer)
    fields = names.fields
    field = names.name(args.field)
    if field not in fields:
        raise InputInvalid(unknown_field(field, fields))
    feature_filter = names.filter(args.filter)
    cql = _compile(feature_filter, fields)
    await _guard_restricted_filter(env, layer, feature_filter)
    described = describe_filter(feature_filter)
    read_as = names.notes()
    restricted = env.data_policy == "restricted"
    if fields[field] in _NUMERIC:
        method = args.method
        if restricted and method not in _RESTRICTED_METHODS:
            # Mean-based breaks sit at the mean and multiples of the standard
            # deviation, which Restricted withholds (Decision T20).
            method = "quantile"
        valued: int | None = None
        points = args.breaks
        if restricted:
            # Counted first: the number of break points depends on it.
            valued = _feature_count(
                await _analytics(
                    env,
                    "feature-count",
                    {
                        "collection": layer.layer_id,
                        "filter": _with_value(feature_filter, fields, field),
                    },
                )
            )
            points = min(args.breaks, valued // MIN_RESTRICTED_GROUP - 1)
        result = await _analytics(
            env,
            "class-breaks",
            {
                "collection": layer.layer_id,
                "attribute": field,
                "method": method,
                # Internal break points: ``points + 1`` classes. Fewer than two:
                # still asked for two, for the minimum and maximum; the breaks
                # are withheld (FieldStatistics.restricted).
                "breaks": max(points, 2),
                "filter": cql,
            },
        )
        return FieldStatistics(
            layer=layer.name,
            field=field,
            kind="numeric",
            filter=described,
            min=result.get("min"),
            max=result.get("max"),
            mean=result.get("mean"),
            std_dev=result.get("std_dev"),
            method=result.get("method"),
            breaks=result.get("breaks"),
            feature_count=valued if cql is not None else None,
            points=points if restricted else None,
            note=_note(*read_as),
            read_as=read_as,
        )
    values_call = _analytics(
        env,
        "unique-values",
        {
            "collection": layer.layer_id,
            "attribute": field,
            "order": "descendent",
            "limit": UNIQUE_VALUES,
            "filter": cql,
        },
    )
    low_cardinality: bool | None = None
    if restricted and cql is not None:
        # The filtered distinct count says little about the field: a filter on
        # one person's id leaves a single name. Cardinality is judged on the
        # whole layer.
        result, whole = await asyncio.gather(
            values_call,
            _analytics(
                env,
                "unique-values",
                {
                    "collection": layer.layer_id,
                    "attribute": field,
                    "order": "descendent",
                    "limit": 1,
                },
            ),
        )
        low_cardinality = _distinct_total(whole) <= LOW_CARDINALITY_LIMIT
    else:
        result = await values_call
    return FieldStatistics(
        layer=layer.name,
        field=field,
        kind="categorical",
        filter=described,
        distinct_count=_distinct_total(result),
        values=[
            ValueCount(
                value=None if v["value"] is None else str(v["value"]),
                count=int(v["count"]),
            )
            for v in result.get("values", [])
        ],
        note=_note(*read_as),
        low_cardinality=low_cardinality,
        read_as=read_as,
    )


FIELD_STATISTICS: ToolSpec[StatisticsInput, FieldStatistics] = ToolSpec(
    name="project.field_statistics",
    description=(
        "Describe one field of a layer. Numeric fields: minimum, maximum, mean, "
        "standard deviation and class breaks computed by GOAT (use these breaks for "
        "classes, do not invent your own). Other fields: the number of distinct "
        f"values and the {UNIQUE_VALUES} most frequent ones with their counts. Values "
        "come back as text, whatever the field's type."
    ),
    input_model=StatisticsInput,
    output_model=FieldStatistics,
    run=_field_statistics,
    surfaces=PROJECT_SURFACES,
    returns_data=True,
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
    #: Whether a filter was applied; never serialized.
    filtered: bool = Field(default=False, exclude=True)
    #: The notes on names read with the join prefix (``_Names.notes``), for
    #: the Restricted form to keep; never serialized.
    read_as: list[str] = Field(default_factory=list, exclude=True)

    def restricted(self) -> "AreaStatistics":
        update: dict[str, Any] = {
            "total_area": None,
            "mean_area": None,
            # A group's area is the total of its features' areas.
            "groups": None,
            "groups_total": None,
        }
        note = "Total and mean area are withheld by the data policy (Restricted)."
        if self.groups is not None:
            note += " So is the area per group: it is a total too."
        if self.filtered and self.feature_count < MIN_RESTRICTED_GROUP:
            update.update(min_area=None, max_area=None)
            note += (
                f" The filter matches fewer than {MIN_RESTRICTED_GROUP} features, so "
                "smallest and largest area are withheld too."
            )
        return self.model_copy(update={**update, "note": _note(*self.read_as, note)})


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
        env, layer, needed=args.group_by is not None or args.filter is not None
    )
    group_by = names.name(args.group_by)
    if group_by is not None and group_by not in names.fields:
        raise InputInvalid(unknown_field(group_by, names.fields))
    feature_filter = names.filter(args.filter)
    # The filter cannot name the geometry (it is not a filterable field), so it
    # cannot be padded with rows that have none: the count the group-size guard
    # reads is the number of features the filter matches.
    cql = await _cql(env, layer, feature_filter, names.fields)
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
    read_as = names.notes()
    return AreaStatistics(
        layer=layer.name,
        filter=describe_filter(feature_filter),
        feature_count=count,
        total_area=area,
        mean_area=area / count if area is not None and count else None,
        min_area=smallest.get("result"),
        max_area=largest.get("result"),
        unit=total.get("unit") or "m²",
        groups=groups,
        groups_total=groups_total,
        note=_note(*read_as, note),
        filtered=args.filter is not None,
        read_as=read_as,
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
    returns_data=True,
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

    def restricted(self) -> Withheld:
        return Withheld(
            reason=(
                "Individual features are withheld by the data policy (Restricted). "
                "Use project_count_features or project_field_statistics instead."
            )
        )


def _short(value: Any) -> Any:
    if isinstance(value, str) and len(value) > _SAMPLE_VALUE_CHARS:
        return value[:_SAMPLE_VALUE_CHARS] + "…"
    return value


async def _sample(env: ToolEnv, args: SampleInput) -> FeatureSample:
    layer = await _readable_layer(env, args)
    if env.data_policy == "restricted":
        # Withheld by the policy anyway (FeatureSample.restricted): do not read rows at all.
        return FeatureSample(layer=layer.name, filter=describe_filter(args.filter))
    fields = await _fields(env, layer)
    for name in args.fields:
        if name not in fields:
            raise InputInvalid(unknown_field(name, fields))
    selected = args.fields or list(fields)[:SAMPLE_FIELDS_MAX]
    params: dict[str, object] = {
        "limit": max(1, min(args.limit, SAMPLE_MAX)),
        "properties": selected,
    }
    if args.filter is not None:
        params["filter"] = _compile(args.filter, fields)
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
        filter=describe_filter(args.filter),
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
    returns_data=True,
)


# -- map.propose_view ----------------------------------------------------------


class ProposeViewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(
        min_length=1,
        max_length=80,
        description="A short title for the card, in the user's language.",
    )
    bbox: list[float] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="[west, south, east, north] in WGS84.",
    )
    center: list[float] | None = Field(
        default=None, min_length=2, max_length=2, description="[longitude, latitude]."
    )
    zoom: float | None = Field(
        default=None, ge=0, le=22, description="Zoom level, with center."
    )
    bearing: float = Field(
        default=0, ge=-180, le=180, description="Map rotation in degrees, with center."
    )
    pitch: float = Field(
        default=0, ge=0, le=85, description="Map tilt in degrees, with center."
    )
    fit_layer_project_id: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Fit the view to this layer's features (GOAT computes the extent); "
            "a layer with geometry, not a table. Give the layer_project_id of a "
            "layer of the open project."
        ),
    )
    filter: FeatureFilter | None = Field(
        default=None,
        description=(
            "With fit_layer_project_id: fit only the features matching this filter. "
            f"{FILTER_EXAMPLES}"
        ),
    )


def _check_bbox(bbox: list[float]) -> tuple[float, float, float, float]:
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise InputInvalid(
            "bbox must be [west, south, east, north] with west < east and south < north in WGS84."
        )
    return west, south, east, north


def _widen(
    low: float, high: float, floor: float, ceiling: float
) -> tuple[float, float]:
    """``low..high`` at least ``_MIN_EXTENT_DEGREES`` wide, kept inside the bounds."""
    if high - low >= _MIN_EXTENT_DEGREES:
        return low, high
    middle = (low + high) / 2
    low, high = middle - _MIN_EXTENT_DEGREES / 2, middle + _MIN_EXTENT_DEGREES / 2
    if low < floor:
        return floor, floor + _MIN_EXTENT_DEGREES
    if high > ceiling:
        return ceiling - _MIN_EXTENT_DEGREES, ceiling
    return low, high


def _extent_bbox(raw: list[float]) -> tuple[float, float, float, float]:
    """A layer's extent as a map view. One feature that is a point, or features
    on one meridian or parallel, give a box with no width or height: it is
    widened (the model's own bbox stays strictly checked)."""
    try:
        west, south, east, north = (float(value) for value in raw)
        if not (west <= east and south <= north):
            raise ValueError
        west, east = _widen(west, east, -180.0, 180.0)
        south, north = _widen(south, north, -90.0, 90.0)
        return _check_bbox([west, south, east, north])
    except (ValueError, InputInvalid) as exc:
        raise ToolFailed("The layer's extent cannot be shown as a map view.") from exc


async def _propose_view(env: ToolEnv, args: ProposeViewInput) -> ProposalShown:
    modes = [
        args.bbox is not None,
        args.center is not None,
        args.fit_layer_project_id is not None,
    ]
    if sum(modes) != 1:
        raise InputInvalid(
            "Pass exactly one of bbox, center with zoom, or fit_layer_project_id."
        )
    if args.filter is not None and args.fit_layer_project_id is None:
        raise InputInvalid("filter goes with fit_layer_project_id.")
    if args.center is None and (args.zoom is not None or args.bearing or args.pitch):
        raise InputInvalid("zoom, bearing and pitch go with center.")
    # Only the project that is open can be moved, so the layer is looked up there.
    project_id = project_of(env.page)
    if project_id is None:
        raise InputInvalid("No project is open on this page.")
    rows: list[ProposalRow] = []
    camera: MapCamera | None = None
    bbox: tuple[float, float, float, float] | None = None
    if args.center is not None:
        if args.zoom is None:
            raise InputInvalid("center needs a zoom.")
        longitude, latitude = args.center
        if not (-180 <= longitude <= 180 and -85.06 <= latitude <= 85.06):
            raise InputInvalid("center must be [longitude, latitude] in WGS84.")
        camera = MapCamera(
            center=(longitude, latitude),
            zoom=args.zoom,
            bearing=args.bearing,
            pitch=args.pitch,
        )
        rows += [
            proposal_row("center", f"{longitude:.5f}, {latitude:.5f}"),
            proposal_row("zoom", f"{args.zoom:g}"),
        ]
    elif args.bbox is not None:
        bbox = _check_bbox(args.bbox)
        rows.append(proposal_row("bbox", ", ".join(f"{value:.5f}" for value in bbox)))
    elif args.fit_layer_project_id is not None:
        layer = await _readable_layer(
            env,
            LayerInput(
                project_id=project_id, layer_project_id=args.fit_layer_project_id
            ),
        )
        if layer.geometry_type is None:
            # A table: the services have no extent to compute for it.
            raise ToolFailed(
                f"{layer.name!r} has no geometry to show on the map. Fit the view "
                "to a layer with geometry, or pass bbox or center with zoom."
            )
        cql = await _cql(env, layer, args.filter)
        extent = await _analytics(
            env, "extent", {"collection": layer.layer_id, "filter": cql}
        )
        if not extent.get("bbox"):
            raise ToolFailed("No features match, so there is nothing to show.")
        bbox = _extent_bbox(list(extent["bbox"]))
        rows.append(proposal_row("layer", layer.name))
        if args.filter is not None:
            rows.append(proposal_row("filter", describe_filter(args.filter)))
    project = await _core(env, f"/{project_id}")
    name = project.get("name")
    rows.insert(0, proposal_row("project", name or str(project_id)))
    proposal = Proposal(
        kind="map.view",
        surface="project.map",
        target=ProposalTarget(project_id=project_id, name=name),
        title=args.title,
        rows=rows,
        payload=MapViewPayload(
            project_id=project_id,
            camera=camera,
            bbox=bbox,
            layer_project_id=args.fit_layer_project_id,
        ),
    )
    return await show(env, proposal)


PROPOSE_VIEW: ToolSpec[ProposeViewInput, ProposalShown] = ToolSpec(
    name="map.propose_view",
    description=(
        "Suggest a map view of the open project: a bounding box, a center and zoom, "
        "or the extent of one of its layers' features. Shows a card; the map moves "
        "only if the user applies it."
    ),
    input_model=ProposeViewInput,
    output_model=ProposalShown,
    run=_propose_view,
    surfaces=frozenset({"project.map"}),
    returns_data=False,
    risk="propose",
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
    returns_data=False,
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
    returns_data=False,
)


# -- project.group_statistics --------------------------------------------------

GroupOperation = Literal["count", "sum", "mean", "min", "max"]
#: The groups a result lists at most, as its rows.
MAX_GROUPS = 100
#: The groups of a share's denominator read at most (processes' aggregation-stats
#: takes a limit of up to 1000): a row's group may come anywhere in the other
#: layer's list, and only the rows go to the model.
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
            "does not apply to it). " + FILTER_EXAMPLES
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

    @model_validator(mode="after")
    def _groups_need_group_by(self) -> "GroupStatisticsInput":
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
    #: Groups before the limit of MAX_GROUPS.
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
    with_share: bool = Field(default=False, exclude=True)
    #: Whether a filter was applied; never serialized.
    filtered: bool = Field(default=False, exclude=True)
    #: Whether group_by and then_by have few distinct values over the whole
    #: layer, not only over the filtered features. Set under Restricted with a
    #: filter; never serialized.
    low_cardinality: bool | None = Field(default=None, exclude=True)
    #: The notes on names read with the join prefix (``_Names.notes``), for
    #: the Restricted form to keep; never serialized.
    read_as: list[str] = Field(default_factory=list, exclude=True)

    def restricted(self) -> BaseModel:
        # Restricted sends counts, never sums or means (spec §4.7): only counts
        # per group, of fields with few values, and no count of a group so small
        # it singles out its features. A copy, because the policy treats a
        # reduction that returns the same object as no reduction. Without a
        # filter, few groups means few values of each field; with one, the
        # whole layer decides (low_cardinality), and a filter that matches
        # fewer than MIN_RESTRICTED_GROUP features sends nothing: its total
        # and its groups would say how many, which project.count_features
        # withholds.
        if (
            self.operation != "count"
            or self.with_share
            or self.groups > LOW_CARDINALITY_LIMIT
            or (
                self.filtered
                and (
                    self.low_cardinality is not True
                    or self.features < MIN_RESTRICTED_GROUP
                )
            )
        ):
            return Withheld()
        rows = [
            row
            if row.value is None or row.value >= MIN_RESTRICTED_GROUP
            else row.model_copy(update={"value": None})
            for row in self.rows
        ]
        hidden = sum(1 for row in rows if row.value is None) - sum(
            1 for row in self.rows if row.value is None
        )
        # The note is built here, not taken from the full result: only these
        # parts of it may leave under Restricted.
        notes = [*self.read_as, *_null_notes(self.rows, self.group_by, self.then_by)]
        if hidden:
            notes.append(
                f"{hidden} group(s) have fewer than {MIN_RESTRICTED_GROUP} features; "
                "the data policy (Restricted) withholds their counts."
            )
        return self.model_copy(update={"rows": rows, "note": " ".join(notes) or None})


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
) -> dict[str, Any]:
    return {
        "collection": layer.layer_id,
        "operation": operation,
        "operation_column": field if operation != "count" else None,
        "group_by_column": group_by,
        "group_by_secondary_column": then_by,
        "filter": cql,
        "order": "descendent",
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
    cql = await _cql(env, layer, feature_filter, names.fields)
    read_as = names.notes()
    low_cardinality: bool | None = None
    if env.data_policy == "restricted" and cql is not None:
        # The filtered groups say little about the fields: a filter on one
        # district leaves few names of a field that holds one per feature.
        # Cardinality is judged on the whole layer, as in field statistics.
        grouping = [name for name in (group_by, then_by) if name is not None]
        wholes = await asyncio.gather(
            *(
                _analytics(
                    env,
                    "unique-values",
                    {
                        "collection": layer.layer_id,
                        "attribute": name,
                        "order": "descendent",
                        "limit": 1,
                    },
                )
                for name in grouping
            )
        )
        low_cardinality = all(
            _distinct_total(whole) <= LOW_CARDINALITY_LIMIT for whole in wholes
        )
    answer = await _analytics(
        env,
        "aggregation-stats",
        _aggregation(layer, args.operation, field, group_by, then_by, cql),
    )
    rows = [
        GroupRow(
            group=_group_value(item.get("grouped_value")),
            then=_group_value(item.get("grouped_secondary_value")),
            value=_number_value(item.get("operation_value")),
        )
        for item in _items(answer)
    ]
    notes: list[str] = []
    unmatched: int | None = None
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
                    f"{undivided_rows} row(s) have no value or a denominator of 0, "
                    "so they have no share."
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
                    f"{len(missing)} group(s) have no matching value of "
                    f"{share_group_by!r} in {other.name!r}, so they have no share."
                )
            elif missing:
                notes.append(
                    f"{len(missing)} group(s) have no share: {other.name!r} has more "
                    f"than {DENOMINATOR_GROUPS} values of {share_group_by!r}, and only "
                    f"its first {DENOMINATOR_GROUPS} (largest first) are matched."
                )
            if undivided:
                notes.append(
                    f"{len(undivided)} group(s) have no value or a denominator of 0, "
                    "so they have no share."
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
                    f"{above} group(s) have a share above 100 %: numerator and "
                    "denominator were assigned to the groups differently. Rebuild "
                    "the share from one assignment, both counted per group the "
                    "same way, before you answer; never present a share above "
                    "100 %."
                )
    notes += _null_notes(rows, group_by, then_by)
    total_items = answer.get("total_items") if isinstance(answer, dict) else None
    total_count = answer.get("total_count") if isinstance(answer, dict) else None
    return GroupStatistics(
        layer=layer.name,
        operation=args.operation,
        field=field,
        group_by=group_by,
        then_by=then_by,
        filter=describe_filter(feature_filter),
        rows=rows,
        groups=int(total_items) if isinstance(total_items, int) else len(rows),
        features=int(total_count) if isinstance(total_count, int) else 0,
        unmatched=unmatched,
        note=_note(*read_as, *notes),
        with_share=args.share_of is not None,
        filtered=cql is not None,
        low_cardinality=low_cardinality,
        read_as=read_as,
    )


GROUP_STATISTICS: ToolSpec[GroupStatisticsInput, GroupStatistics] = ToolSpec(
    name="project.group_statistics",
    description=(
        "A statistic of a layer per group: sum, mean, min or max of a numeric "
        "field, or the count of features, per value of group_by and optionally per "
        "value of then_by inside each (up to 100 groups, largest first). Without "
        "group_by, one row for the whole (filtered) layer. With share_of, each "
        "row's value is divided on the server by a statistic of another layer "
        "with its own operation (sum by default): its value for the same group "
        "with share_of.group_by, e.g. residents per district and band by "
        "residents per district, or its total without. share_of takes its own "
        "filter for the denominator, e.g. residents in a catchment over all "
        "residents. Use those shares, never compute them yourself. Groups "
        "without a share, and shares above 100 %, are counted in the note. "
        "Under the Restricted data "
        "policy only counts are sent."
    ),
    input_model=GroupStatisticsInput,
    output_model=GroupStatistics,
    run=_group_statistics,
    surfaces=PROJECT_SURFACES,
    returns_data=True,
)

PROJECT_TOOLS: tuple[ToolSpec[Any, Any], ...] = (
    GET_LAYERS,
    GET_FIELDS,
    COUNT_FEATURES,
    FIELD_STATISTICS,
    GROUP_STATISTICS,
    AREA_STATISTICS,
    SAMPLE_FEATURES,
    PROPOSE_VIEW,
    GET_WORKFLOWS,
    GET_LAYOUTS,
)
