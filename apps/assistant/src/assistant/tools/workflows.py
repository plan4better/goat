"""The workflows pack (spec §3, §4, §5.3): check a workflow draft and create it
in the open project, create one from a template, and add a catalog dataset or
one of the user's own datasets the user picked in a card. On the Map and
Workflows pages, never over MCP.

Every write goes into the project of the page: no tool takes a project id, so
text inside a dataset, a template or a tool description cannot make the
assistant write into another project. Only layers of that project the user
can read reach processes: a locked layer is refused before anything is sent,
and a tool's layer input is fed only by a connection, never by a setting. A
draft takes only the tools of the user's toolbox, as workflow_tools lists them.
A write called again with the same arguments in the conversation returns its
first result (``assistant.tools.toolset``); its audit row keeps what it
created (``created()``).
"""

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import quote
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import RUN_PREFIX, recent_picked_ids
from assistant.context import RECORD_ID_PATTERN, project_of
from assistant.tools.ask import in_catalog, users_dataset
from assistant.tools.core import ShownItem, ShownItemGroup
from assistant.tools.filters import FeatureFilter, field_kind, to_cql2
from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.policy import MIN_RESTRICTED_GROUP
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.tools.workflow_tools import (
    WORKFLOW_SURFACES,
    description,
    language_header,
    offered,
)
from assistant.workflows import tool_info
from assistant.workflows.draft import (
    MAX_STEPS,
    TOOL_ID_PATTERN,
    Converted,
    DatasetStep,
    Draft,
    DraftError,
    ProjectLayer,
    Region,
    ToolStep,
    downstream,
    open_steps,
    region_from_feature,
    to_config,
)
from assistant.workflows.issues import (
    DraftIssue,
    band_issues,
    counted_steps,
    draft_issues,
    filter_field_issues,
    matrix_pair_issues,
    note_issues,
    split_issues,
    starting_point_issues,
)

VIEWER_WORKFLOWS = "You can view this project but not create workflows in it."
VIEWER_LAYERS = "You can view this project but not add datasets to it."
TEMPLATE_REFUSED = (
    "The template is not shared with you, or you can view this project but not "
    "create workflows in it."
)
NO_CONSENT = (
    "Not added: the user has not picked this catalog dataset in a card. Ask with "
    "ask_user, the dataset as an option (its catalog id as the value, or in "
    "adds), and add it once they picked it."
)
ADDED_NOTE = (
    "Added to the project. Its data is copied in the background: until it is "
    "ready, the check does not judge the fields of steps that read it."
)
NOT_PICKED_DATASET = (
    "Not added: the user has not picked this dataset in a card. Ask with ask_user, "
    "the dataset as an option (its id as the value, or in adds), and add it once "
    "they picked it."
)
CANNOT_READ_DATASET = "Not added: the user cannot read this dataset."
#: The note on an added dataset of the user's: its data is in GOAT already.
ADDED_DATASET_NOTE = "Added to the project."
NO_TEMPLATE = "There is no such template; find one with workflow_find_templates."
MAX_TEMPLATES = 10
#: Core finds a template whose name or description holds the search text as
#: one piece, so the query's words are searched too: this many at most, each
#: of at least ``MIN_SEARCH_WORD_CHARS`` characters.
MAX_SEARCH_WORDS = 4
MIN_SEARCH_WORD_CHARS = 3
#: When no search finds a template, the workflow templates the user can use
#: are listed instead (most recently changed first), this many at most: their
#: texts are often in another language than the query, and the model judges
#: the fit from them. When the searches find fewer, the other usable ones are
#: listed beside the hits, up to this many in all, so a weak hit does not
#: hide them.
MAX_LISTED_TEMPLATES = 20
_NOTHING_MATCHED = (
    "No template's name or description holds the query or one of its words"
)
ALL_TEMPLATES = (
    _NOTHING_MATCHED + ", so these are all {total} workflow templates the user can "
    "use. Their texts may be in another language than the query: judge from them "
    "whether one fits, or build a draft with workflow_create."
)
FIRST_TEMPLATES = (
    _NOTHING_MATCHED + ", so these are the {shown} most recently changed of the "
    "{total} workflow templates the user can use. Their texts may be in another "
    "language than the query: judge from them whether one fits, or build a draft "
    "with workflow_create."
)
NO_TEMPLATES = (
    _NOTHING_MATCHED + ", and the user can use no workflow template: build a "
    "draft with workflow_create."
)
OTHER_TEMPLATES = (
    "templates hold the query or one of its words; other_templates are "
    "{shown} more of the {total} workflow templates the user can use, most "
    "recently changed first. A hit can be weak, and template texts may be in "
    "another language than the query: judge from both lists whether one fits, "
    "or build a draft with workflow_create."
)
#: The note on a later search in the same answer (``ToolSpec.once_per_answer``).
TEMPLATES_SEARCHED = (
    "Templates were already searched in this answer, so this call did not search "
    "again: this is the first search's result, whatever the words. Choose from "
    "it, or build a draft with workflow_create."
)
#: Template text is written by other users: every piece reaching the model is
#: clipped, and the lists are capped.
_TEMPLATE_TEXT_CHARS = 200
_TEMPLATE_LABEL_CHARS = 80
MAX_TEMPLATE_INPUTS = 20
MAX_TEMPLATE_CATEGORIES = 10
#: The longest input key a binding can name.
_BINDING_KEY_CHARS = 200
#: The check's messages about a template's workflow quote its author's text
#: (a step's name, a setting's value), so they are clipped too.
_TEMPLATE_ISSUE_CHARS = 400
NO_PROJECT = "Open a project first: workflows are created in the open project."
NOT_READABLE = "The project does not exist or the user cannot open it."
NOT_CHECKED = (
    "The draft could not be checked right now; it is unchecked. workflow_create "
    "checks it again."
)
READY = "No issue stops workflow_create; open issues are the user's to resolve."
CHECK_UNAVAILABLE = (
    "Not created: the draft could not be checked right now. Try again in a moment."
)
#: Blocking issues named in a refused create.
MAX_LISTED_ISSUES = 10
#: What the draft tools say about a draft's notes.
NOTE_RULE = (
    "Give every workflow you create one short note (notes) of at most three "
    "short lines: what it answers and how to read its results, e.g. which "
    "result holds the answer or what the bands mean. State only what the steps "
    "fix, such as a join's `join_` prefix. Never put data values or personal "
    "data in a note, nor counts that come from the data (rows, classes or "
    "features)."
)
TEMPLATE_NOT_CHECKED = (
    "Not created: the workflow the template makes could not be checked right "
    "now. Try again in a moment."
)
#: The remedy for an issue a binding causes.
TEMPLATE_FIX = (
    "Bind another layer to the input, or build the workflow as a draft with "
    "workflow_create and limit the dataset step with filter.area: a binding "
    "takes no filter."
)
#: The remedy for an issue of the template itself, which no binding fixes.
TEMPLATE_ELSEWHERE = (
    "Use another template (workflow_find_templates), or build the workflow as "
    "a draft with workflow_create."
)


def open_project(env: ToolEnv) -> UUID:
    """The project of the page: the only project the pack writes into."""
    project_id = project_of(env.page)
    if project_id is None:
        raise ToolFailed(NO_PROJECT)
    return project_id


async def project_layers(
    env: ToolEnv, project_id: UUID
) -> tuple[dict[int, ProjectLayer], dict[int, str]]:
    """The project's readable layers, and the names of the locked ones, both
    by layer_project_id. Core answers 401 for a project the user cannot open."""
    try:
        rows = await env.call("core", "GET", f"/api/v2/project/{project_id}/layer")
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403, 404):
            raise ToolFailed(NOT_READABLE) from exc
        raise
    layers: dict[int, ProjectLayer] = {}
    locked: dict[int, str] = {}
    for row in rows or []:
        if not isinstance(row, dict) or not isinstance(row.get("id"), int):
            continue
        name = str(row.get("name") or f"layer {row['id']}")
        if row.get("locked"):
            locked[row["id"]] = name
        elif row.get("layer_id"):
            layers[row["id"]] = ProjectLayer(
                layer_project_id=row["id"],
                layer_id=str(row["layer_id"]),
                name=name,
                type=row.get("type"),
                geometry_type=row.get("feature_layer_geometry_type"),
            )
    return layers, locked


def _dataset_steps(draft: Draft) -> list[DatasetStep]:
    return [step for step in draft.steps if isinstance(step, DatasetStep)]


async def _region(env: ToolEnv, nuts_id: str) -> Region:
    try:
        feature = await env.call("catalog", "GET", f"/stac/nuts/{nuts_id}/geometry")
    except ServiceError as exc:
        if exc.status == 404:
            raise InputInvalid(
                f"There is no region {nuts_id!r}; find it with catalog_find_region."
            ) from exc
        raise
    try:
        return region_from_feature(
            nuts_id, feature if isinstance(feature, dict) else {}
        )
    except DraftError as exc:
        raise ToolFailed(
            f"The catalog sent no boundary for region {nuts_id!r}."
        ) from exc


async def _regions(env: ToolEnv, draft: Draft) -> dict[str, Region]:
    ids = sorted(
        {
            step.filter.area
            for step in _dataset_steps(draft)
            if step.filter is not None and step.filter.area is not None
        }
    )
    regions = await asyncio.gather(*(_region(env, nuts_id) for nuts_id in ids))
    return {region.nuts_id: region for region in regions}


#: Tool id -> its process description; None for a tool processes does not know.
Descriptions = Mapping[str, dict[str, Any] | None]


async def _descriptions(env: ToolEnv, tool_ids: Iterable[str]) -> Descriptions | None:
    """The description of each tool, in the user's language; None when they
    cannot be read now. They name the steps without a label, and say which
    settings are layer inputs or field settings."""
    tools = sorted(set(tool_ids))
    try:
        found = await asyncio.gather(*(description(env, tool) for tool in tools))
    except ToolFailed:
        return None
    return dict(zip(tools, found, strict=True))


async def _toolbox(env: ToolEnv) -> frozenset[str] | None:
    """The ids of the tools in the user's toolbox; None when the list cannot
    be read now."""
    try:
        return frozenset(str(row["id"]) for row in await offered(env))
    except ToolFailed:
        return None


def _refuse_tools_outside(draft: Draft, toolbox: frozenset[str]) -> None:
    """Processes describes, checks and runs every tool it knows, also the
    ones the user's toolbox leaves out (hidden ones, beta tools for a user
    outside the beta), so a draft is held to the toolbox here. An id
    processes does not know is outside it too."""
    outside = [
        f"step {step.id!r} uses {step.tool!r}"
        for step in draft.steps
        if isinstance(step, ToolStep) and step.tool not in toolbox
    ]
    if outside:
        raise InputInvalid(
            f"Not in the user's toolbox: {'; '.join(outside)}. Use only tools "
            "that workflow_tools lists."
        )


def _titles(descriptions: Descriptions | None) -> dict[str, str]:
    return {
        tool: str(described["title"])
        for tool, described in (descriptions or {}).items()
        if described and described.get("title")
    }


def _refuse_layer_settings(draft: Draft, descriptions: Descriptions) -> None:
    """A layer reaches a tool only through a connection, so a layer id set
    as a setting cannot pass by the step's ``layer``, the connections and the
    refusal of a locked layer."""
    for step in draft.steps:
        if not isinstance(step, ToolStep):
            continue
        described = descriptions.get(step.tool)
        if described is None:
            continue
        handles = {info.name for info in tool_info.layer_inputs(described)}
        named = [key for key in step.settings if key in handles]
        if named:
            raise InputInvalid(
                f"step {step.id!r}: the settings set the layer input(s) "
                f"{', '.join(named)} of {step.tool}. Leave them out of settings "
                "and connect a dataset step to that input instead (a connection "
                f'with "to": "{step.id}" and "input": "{named[0]}").'
            )


@dataclass(frozen=True)
class Prepared:
    draft: Draft
    converted: Converted
    layers: Mapping[int, ProjectLayer]
    regions: Mapping[str, Region]
    #: None when the tools' descriptions could not be read: the draft then
    #: cannot be checked (``check``).
    descriptions: Descriptions | None
    #: The tools of the user's toolbox; None when they could not be read,
    #: and the draft cannot be checked either.
    toolbox: frozenset[str] | None


async def prepare(env: ToolEnv, project_id: UUID, draft: Draft) -> Prepared:
    """The draft converted with the project's layers, the regions'
    boundaries and the tools' descriptions. A tool outside the user's
    toolbox, a layer the user cannot read, one that is not in the project, or
    a layer input set as a setting goes back to the model."""
    (layers, locked), regions, descriptions, toolbox = await asyncio.gather(
        project_layers(env, project_id),
        _regions(env, draft),
        _descriptions(
            env, (step.tool for step in draft.steps if isinstance(step, ToolStep))
        ),
        _toolbox(env),
    )
    if toolbox is not None:
        _refuse_tools_outside(draft, toolbox)
    for step in _dataset_steps(draft):
        if step.layer is not None and step.layer in locked:
            raise InputInvalid(
                f"step {step.id!r}: {locked[step.layer]!r} is in the project, but the "
                "user has no access to its data. Choose another layer or leave the "
                "step open (layer null)."
            )
    if descriptions is not None:
        _refuse_layer_settings(draft, descriptions)
    try:
        # A fresh salt: every call converts once, with ids of its own, so the
        # create saves the config its check checked and no two workflows
        # share a node id.
        converted = to_config(
            draft,
            layers=layers,
            regions=regions,
            titles=_titles(descriptions),
            salt=uuid4().hex,
        )
    except DraftError as exc:
        raise InputInvalid(str(exc)) from exc
    return Prepared(draft, converted, layers, regions, descriptions, toolbox)


async def _layer_fields(env: ToolEnv, layer: ProjectLayer) -> dict[str, str] | None:
    """The layer's field names and their kinds (``field_kind``); None while
    geoapi cannot read them (a catalog dataset whose data is still being
    copied). A layer with no field besides its geometry counts as not read:
    geoapi lists no field of a table its catalog snapshot does not see yet,
    such as the table of a catalog dataset just added."""
    try:
        doc = await env.call(
            "geoapi", "GET", f"/collections/{layer.layer_id}/queryables"
        )
    except ToolFailed:
        return None
    properties = doc.get("properties") if isinstance(doc, dict) else None
    if not isinstance(properties, dict):
        return None
    fields = {
        name: field_kind(schema)
        for name, schema in properties.items()
        if isinstance(schema, dict) and "$ref" not in schema
    }
    return fields or None


#: Dataset step id -> its layer's fields and their kinds (``_layer_fields``).
Fields = Mapping[str, Mapping[str, str] | None]


async def _filter_fields(
    env: ToolEnv, prepared: Prepared
) -> dict[str, dict[str, str] | None]:
    """The fields of the layer of each dataset step with ``where`` conditions."""
    filtered = [
        (step.id, prepared.layers[step.layer])
        for step in _dataset_steps(prepared.draft)
        if step.layer is not None and step.filter is not None and step.filter.where
    ]
    found = await asyncio.gather(*(_layer_fields(env, layer) for _, layer in filtered))
    return {
        step_id: fields for (step_id, _), fields in zip(filtered, found, strict=True)
    }


def _step_cql(
    step: DatasetStep, fields: Mapping[str, str], regions: Mapping[str, Region]
) -> dict[str, Any] | None:
    """The dataset step's filter as CQL2-JSON: its area as an ``s_intersects``
    on ``geom`` (processes maps it to the geometry column) and each condition
    checked against the layer's fields, all of them required; None without a
    filter. Raises ``InputInvalid`` for a condition the fields do not take."""
    if step.filter is None:
        return None
    parts: list[dict[str, Any]] = []
    if step.filter.area is not None:
        geometry = regions[step.filter.area].geometry
        parts.append({"op": "s_intersects", "args": [{"property": "geom"}, geometry]})
    for condition in step.filter.where:
        one = FeatureFilter.model_validate({"conditions": [condition.model_dump()]})
        parts.append(to_cql2(one, fields))
    return parts[0] if len(parts) == 1 else {"op": "and", "args": parts}


async def _count(
    env: ToolEnv,
    prepared: Prepared,
    step: DatasetStep,
    fields: Mapping[str, str] | None,
) -> int | None:
    """The features of the step's layer that its filter keeps; None when they
    cannot be counted now: its conditions' fields cannot be read or do not
    take them, or processes answers without a count."""
    if step.layer is None:
        return None
    if step.filter is not None and step.filter.where and fields is None:
        return None
    try:
        cql = _step_cql(step, fields or {}, prepared.regions)
    except InputInvalid:
        return None
    inputs: dict[str, Any] = {"collection": prepared.layers[step.layer].layer_id}
    if cql is not None:
        inputs["filter"] = json.dumps(cql)
    try:
        answer = await env.call(
            "processes",
            "POST",
            "/processes/feature-count/execution",
            json_body={"inputs": inputs},
        )
    except ToolFailed:
        return None
    count = answer.get("count") if isinstance(answer, dict) else None
    return count if isinstance(count, int) and not isinstance(count, bool) else None


def _withheld(env: ToolEnv, step: DatasetStep, count: int) -> bool:
    """Whether the data policy keeps the step's count from the model, as
    ``project_count_features`` does: under Restricted, a filtered count below
    ``MIN_RESTRICTED_GROUP``, since "none" against "one" says whether a
    feature exists."""
    return (
        env.data_policy == "restricted"
        and step.filter is not None
        and count < MIN_RESTRICTED_GROUP
    )


async def _dataset_counts(
    env: ToolEnv, prepared: Prepared, fields: Fields
) -> dict[str, int]:
    """The features of each dataset step that a catchment's start points or
    a matrix's origins or destinations are made of (``counted_steps``:
    directly or through merge and centroid steps), counted through processes
    with the step's filter, once per dataset step and concurrently. A count
    that cannot be read is left out, and with it every sum it is part of
    (the run's own limit still holds); so is a count the data policy
    withholds (``_withheld``), which the issues' messages would name. Rows
    of any other step's result exist only once the run gets there."""
    by_id = {step.id: step for step in prepared.draft.steps}
    datasets = [
        step
        for step_id in counted_steps(prepared.draft)
        if isinstance(step := by_id.get(step_id), DatasetStep)
        and step.layer is not None
        and step.layer in prepared.layers
    ]
    found = await asyncio.gather(
        *(_count(env, prepared, step, fields.get(step.id)) for step in datasets)
    )
    return {
        step.id: count
        for step, count in zip(datasets, found, strict=True)
        if count is not None and not _withheld(env, step, count)
    }


async def _checked(
    env: ToolEnv, project_id: UUID, converted: Converted
) -> list[DraftIssue] | None:
    """The issues of the converted config as the editor's check sees them,
    by the steps' ids in ``converted``; None when the check could not run
    now. A config processes refuses goes back to the model."""
    config = converted.config
    try:
        answer = await env.call(
            "processes",
            "POST",
            "/workflows/check",
            json_body={
                "project_id": str(project_id),
                "nodes": config.get("nodes", []),
                "edges": config.get("edges", []),
                "variables": config.get("variables", []),
            },
            headers=language_header(env),
        )
    except ServiceError as exc:
        # A 400 or 422 is processes' verdict on the draft itself: the same
        # draft gets it again, so the model has to change the draft.
        if exc.status in (400, 422):
            raise InputInvalid(exc.message) from exc
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403, 404):
            raise ToolFailed(NOT_READABLE) from exc
        return None
    except ToolFailed:
        return None
    rows = answer.get("issues") if isinstance(answer, dict) else None
    if not isinstance(rows, list):
        return None
    return draft_issues([row for row in rows if isinstance(row, dict)], converted)


async def check(
    env: ToolEnv, project_id: UUID, prepared: Prepared
) -> list[DraftIssue] | None:
    """The issues of the converted draft as the editor's check sees them,
    plus the assistant's own checks of the filters' fields, the catchments'
    start points and the matrices' pairs; None when the check could not run
    now. A draft processes refuses goes back to the model."""
    if prepared.descriptions is None or prepared.toolbox is None:
        return None
    issues = await _checked(env, project_id, prepared.converted)
    if issues is None:
        return None
    # One read of each filtered layer's fields serves both checks.
    fields = await _filter_fields(env, prepared)
    counts = await _dataset_counts(env, prepared, fields)
    names = {
        step_id: None if known is None else list(known)
        for step_id, known in fields.items()
    }
    labels = prepared.converted.labels
    return (
        issues
        + filter_field_issues(prepared.draft, names, labels)
        + starting_point_issues(prepared.draft, counts, labels)
        + matrix_pair_issues(prepared.draft, counts, labels)
    )


#: A heatmap's numbered opportunity handle; processes names the settings of
#: the opportunity on handle N ``opportunity_<N>_<name>``.
_OPPORTUNITY_HANDLE = re.compile(r"opportunity_layer_(\d+)_id")


@dataclass(frozen=True)
class LayerSettings:
    """Per draft step id, what of its tool reads a layer still to be chosen:
    the input is connected from a step left open (or from one that reads
    from it), so the check cannot judge it yet."""

    #: The field settings reading such an input: ``setting_required`` on
    #: them stays open. A heatmap's per-opportunity settings are not among
    #: them: processes reports their problems as ``setting_invalid`` only.
    fields: dict[str, frozenset[str]]
    #: Every setting such a layer can make invalid: the fed inputs, the
    #: field settings and the list settings whose items read them, each
    #: setting of an opportunity on a fed handle, and ``opportunities`` when
    #: every connected opportunity is fed so (processes reports an
    #: opportunity's own validation there when it names none of its
    #: settings, and cannot say which opportunity). ``setting_invalid`` on
    #: them stays open.
    invalid: dict[str, frozenset[str]]


@dataclass(frozen=True)
class Graph:
    """What the create gate reads of a workflow, by step id: a draft's
    (``draft_graph``) or a config's (``config_graph``)."""

    #: The steps whose layer is still to be chosen, and every step that
    #: reads from one (``draft.open_steps``).
    open_ids: frozenset[str]
    #: Tool step id -> its tool.
    tools: Mapping[str, str]
    #: (from, to, input) of each connection into a named input.
    connections: tuple[tuple[str, str, str], ...]


def draft_graph(draft: Draft) -> Graph:
    return Graph(
        open_ids=open_steps(draft),
        tools={
            step.id: step.tool for step in draft.steps if isinstance(step, ToolStep)
        },
        connections=tuple(
            (connection.source, connection.target, connection.input)
            for connection in draft.connections
            if connection.input is not None
        ),
    )


def layer_settings(graph: Graph, descriptions: Descriptions | None) -> LayerSettings:
    """What of each tool step's tool reads a layer still to be chosen, from
    the tools' descriptions; a tool without one is left out."""
    descriptions = descriptions or {}
    fed: dict[str, set[str]] = {}
    connected: dict[str, set[str]] = {}
    for source, target, handle in graph.connections:
        connected.setdefault(target, set()).add(handle)
        if source in graph.open_ids:
            fed.setdefault(target, set()).add(handle)
    fields: dict[str, frozenset[str]] = {}
    invalid: dict[str, frozenset[str]] = {}
    for step_id, tool in graph.tools.items():
        if step_id not in fed:
            continue
        described = descriptions.get(tool)
        if described is None:
            continue
        inputs = fed[step_id]
        names = frozenset(
            name
            for name, reads in tool_info.field_inputs(described).items()
            if reads in inputs
        )
        if names:
            fields[step_id] = names
        lists = {
            name
            for name, reads in tool_info.list_field_inputs(described).items()
            if reads & inputs
        }
        numbers = [
            matched.group(1)
            for matched in map(_OPPORTUNITY_HANDLE.fullmatch, inputs)
            if matched
        ]
        opportunities = {
            f"opportunity_{number}_{name}"
            for number in numbers
            for name in tool_info.opportunity_fields(described)
        }
        handles = {
            handle
            for handle in connected[step_id]
            if _OPPORTUNITY_HANDLE.fullmatch(handle)
        }
        if numbers and handles <= inputs:
            opportunities.add(tool_info.OPPORTUNITIES)
        invalid[step_id] = frozenset(inputs | names | lists | opportunities)
    return LayerSettings(fields, invalid)


def _split(
    graph: Graph, descriptions: Descriptions | None, issues: list[DraftIssue]
) -> tuple[list[DraftIssue], list[DraftIssue]]:
    """``(blocking, open)`` as ``workflow_create`` judges them (spec §4.4)."""
    settings = layer_settings(graph, descriptions)
    return split_issues(
        issues,
        graph.open_ids,
        field_settings=settings.fields,
        layer_settings=settings.invalid,
    )


def area_notes(prepared: Prepared) -> list[str]:
    """What the answer says about an area stored as a bounding box."""
    notes: list[str] = []
    for step in _dataset_steps(prepared.draft):
        if step.filter is None or step.filter.area is None:
            continue
        region = prepared.regions[step.filter.area]
        if region.as_box:
            notes.append(
                f"{prepared.converted.labels[step.id]}: the area is the bounding box of "
                f"{region.name}, not its boundary, which is too detailed to store in a "
                "workflow. Features inside the box but outside the region are kept too."
            )
    return notes


class DraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draft: Draft = Field(
        description=(
            "The whole workflow: name, steps (dataset, tool, export), connections, "
            "variables and notes, as the build-a-workflow skill describes."
        )
    )


class DraftCheck(BaseModel):
    checked: bool
    issues: list[DraftIssue] = Field(default_factory=list)
    #: Issues that stop workflow_create (spec §4.4).
    blocking: int = 0
    #: Issues of steps left open, which the user resolves in the editor.
    open: int = 0
    notes: list[str] | None = None
    note: str | None = None


def _advice(draft: Draft) -> list[DraftIssue]:
    """The assistant's own advice on top of the editor's check: warnings,
    which neither stop workflow_create nor are the user's to resolve."""
    return [*band_issues(draft), *note_issues(draft)]


async def _check_draft(env: ToolEnv, args: DraftInput) -> DraftCheck:
    project_id = open_project(env)
    prepared = await prepare(env, project_id, args.draft)
    notes = area_notes(prepared) or None
    issues = await check(env, project_id, prepared)
    if issues is None:
        return DraftCheck(checked=False, notes=notes, note=NOT_CHECKED)
    issues = [*issues, *_advice(prepared.draft)]
    blocking, still_open = _split(
        draft_graph(prepared.draft), prepared.descriptions, issues
    )
    return DraftCheck(
        checked=True,
        issues=issues,
        blocking=len(blocking),
        open=len(still_open),
        notes=notes,
        note=None if blocking else READY,
    )


CHECK_DRAFT: ToolSpec[DraftInput, DraftCheck] = ToolSpec(
    name="workflow.check_draft",
    description=(
        "Check a workflow draft the way the Workflows editor checks a workflow, "
        "before creating it. The issues come back by your step ids; a one-step "
        "issue's message starts with the step's name. Nothing is saved. " + NOTE_RULE
    ),
    input_model=DraftInput,
    output_model=DraftCheck,
    run=_check_draft,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
)


class CreatedWorkflow(BaseModel):
    id: str
    name: str
    project_id: str


class OpenIssue(BaseModel):
    #: The name of the step it concerns; left out for the whole workflow.
    step: str | None = None
    code: str
    message: str


class WorkflowCreated(BaseModel):
    workflow: CreatedWorkflow
    #: What the user still has to choose in the editor.
    open_issues: list[OpenIssue]
    #: The card the dock shows, in the shape of core_show_items' result.
    groups: list[ShownItemGroup]
    notes: list[str] | None = None
    #: The assistant's own advice on the draft (``_advice``), so a create
    #: with no check before it hears it too; not the user's to resolve.
    warnings: list[OpenIssue] | None = None

    def created(self) -> dict[str, Any]:
        return {
            "kind": "workflow",
            "ids": [self.workflow.id],
            "project_id": self.workflow.project_id,
        }


def workflow_card(workflow: CreatedWorkflow) -> list[ShownItemGroup]:
    return [
        ShownItemGroup(
            items=[
                ShownItem(
                    kind="workflow",
                    id=workflow.id,
                    project_id=workflow.project_id,
                    name=workflow.name,
                )
            ]
        )
    ]


def _open_issue(issue: DraftIssue, labels: Mapping[str, str]) -> OpenIssue:
    step = labels.get(issue.steps[0]) if issue.steps else None
    return OpenIssue(step=step, code=issue.code, message=issue.message)


def _warning(issue: DraftIssue, labels: Mapping[str, str]) -> OpenIssue:
    """A warning by the step it concerns; one about several steps names them
    in its message."""
    step = labels.get(issue.steps[0]) if len(issue.steps) == 1 else None
    return OpenIssue(step=step, code=issue.code, message=issue.message)


async def _create(env: ToolEnv, args: DraftInput) -> WorkflowCreated:
    project_id = open_project(env)
    prepared = await prepare(env, project_id, args.draft)
    issues = await check(env, project_id, prepared)
    if issues is None:
        raise ToolFailed(CHECK_UNAVAILABLE)
    blocking, still_open = _split(
        draft_graph(prepared.draft), prepared.descriptions, issues
    )
    if blocking:
        listed = " ".join(issue.message for issue in blocking[:MAX_LISTED_ISSUES])
        raise ToolFailed(
            f"Not created: {len(blocking)} issue(s) must be fixed first. {listed} "
            "Fix the draft and call workflow_create again."
        )
    try:
        row = await env.call(
            "core",
            "POST",
            f"/api/v2/project/{project_id}/workflow",
            json_body={
                "name": args.draft.name,
                "description": None,
                "is_default": False,
                "config": prepared.converted.config,
            },
        )
    except ServiceError as exc:
        # Core answers 401 for missing rights too, not only 403.
        if exc.status in (401, 403):
            raise ToolFailed(VIEWER_WORKFLOWS) from exc
        raise
    workflow = CreatedWorkflow(
        id=str(row["id"]),
        name=str(row.get("name") or args.draft.name),
        project_id=str(row.get("project_id") or project_id),
    )
    env.runs.created.add(workflow.id)
    labels = prepared.converted.labels
    return WorkflowCreated(
        workflow=workflow,
        open_issues=[_open_issue(issue, labels) for issue in still_open],
        groups=workflow_card(workflow),
        notes=area_notes(prepared) or None,
        warnings=[_warning(i, labels) for i in _advice(prepared.draft)] or None,
    )


CREATE: ToolSpec[DraftInput, WorkflowCreated] = ToolSpec(
    name="workflow.create",
    description=(
        "Create the draft as a new workflow in the open project. It is checked "
        "again first and refused while an issue remains that the user cannot "
        "resolve by choosing the layers of the steps left open. It does not start "
        "the workflow: workflow_run does, or the user with Run. Answers with the "
        "workflow, the issues left open for the user, and warnings on the draft "
        "for you. When it answers, the workflow exists: never create it again "
        "for a warning, and mention a warning in your answer when it matters. "
        + NOTE_RULE
    ),
    input_model=DraftInput,
    output_model=WorkflowCreated,
    run=_create,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
)

# -- templates -------------------------------------------------------------------


class FindTemplatesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(
        min_length=2,
        max_length=100,
        description=(
            "The analysis in a few words, e.g. 'schools walking': a template "
            "whose name or description holds the whole text or one of its words "
            "is found. German and English words can go in one query."
        ),
    )


class TemplateInputInfo(BaseModel):
    #: The key a binding names (``bindings`` of workflow_create_from_template).
    key: str
    label: str
    #: The template asks for a layer here: bind one, or it stays open.
    needs_binding: bool
    layer_type: str | None = None
    geometry_type: str | None = None


class TemplateInfo(BaseModel):
    id: str
    name: str
    description: str | None = None
    categories: list[str] = Field(default_factory=list)
    inputs: list[TemplateInputInfo] = Field(default_factory=list)


class FoundTemplates(BaseModel):
    templates: list[TemplateInfo]
    #: Set when no search found a template, so ``templates`` lists the usable
    #: ones instead, and with ``other_templates``: what the lists hold.
    note: str | None = None
    #: Beside a few hits: the other workflow templates the user can use.
    other_templates: list[TemplateInfo] | None = None


def _clip(text: Any, chars: int = _TEMPLATE_TEXT_CHARS) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    line = " ".join(text.split())
    return line if len(line) <= chars else line[: chars - 1] + "…"


def _label(item: dict[str, Any]) -> str:
    return (
        _clip(item.get("label"), _TEMPLATE_LABEL_CHARS)
        or _clip(item.get("key"), _TEMPLATE_LABEL_CHARS)
        or ""
    )


def _inputs(row: dict[str, Any]) -> list[TemplateInputInfo]:
    """Every input of the template a binding can name."""
    found: list[TemplateInputInfo] = []
    for item in row.get("inputs") or []:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if not isinstance(key, str) or not 0 < len(key) <= _BINDING_KEY_CHARS:
            continue
        found.append(
            TemplateInputInfo(
                key=key,
                label=_label(item),
                needs_binding=item.get("mode") == "ask",
                layer_type=_clip(item.get("layer_type"), _TEMPLATE_LABEL_CHARS),
                geometry_type=_clip(item.get("geometry_type"), _TEMPLATE_LABEL_CHARS),
            )
        )
    return found


def _template(row: dict[str, Any]) -> TemplateInfo:
    categories = row.get("categories")
    return TemplateInfo(
        id=str(row.get("id")),
        name=_clip(row.get("name")) or "",
        description=_clip(row.get("description")),
        categories=[
            category
            for category in (
                _clip(text, _TEMPLATE_LABEL_CHARS)
                for text in (categories if isinstance(categories, list) else [])[
                    :MAX_TEMPLATE_CATEGORIES
                ]
            )
            if category
        ],
        inputs=_inputs(row)[:MAX_TEMPLATE_INPUTS],
    )


def _searches(query: str) -> list[str]:
    """The whole query, then its words in order: each word of at least
    ``MIN_SEARCH_WORD_CHARS`` characters that is not, ignoring case, equal to
    an earlier search; ``MAX_SEARCH_WORDS`` words at most."""
    whole = " ".join(query.split())
    searches = [whole]
    for word in whole.split():
        if len(searches) > MAX_SEARCH_WORDS:
            break
        if len(word) >= MIN_SEARCH_WORD_CHARS and word.casefold() not in {
            search.casefold() for search in searches
        }:
            searches.append(word)
    return searches


async def _find_templates(env: ToolEnv, args: FindTemplatesInput) -> FoundTemplates:
    # The usable templates are listed beside the searches, in the same round
    # trip: for a query no search finds a template for, or a few hits.
    *pages, listed = await asyncio.gather(
        *(
            env.call(
                "core",
                "GET",
                "/api/v2/template",
                params={
                    "kind": "workflow",
                    "search": search,
                    "source": "all",
                    "size": MAX_TEMPLATES,
                },
            )
            for search in _searches(args.query)
        ),
        _usable_page(env),
    )
    # The whole query's hits first, then each word's, every template once.
    rows: dict[str, dict[str, Any]] = {}
    for page in pages:
        for row in _rows(page):
            rows.setdefault(str(row.get("id")), row)
    if not rows:
        if isinstance(listed, ToolFailed):
            raise listed
        return _usable_templates(listed)
    hits = list(rows.values())[:MAX_TEMPLATES]
    found = FoundTemplates(templates=[_template(row) for row in hits])
    # Hits enough to fill the list, or no list to add: the hits alone.
    if len(rows) >= MAX_LISTED_TEMPLATES or isinstance(listed, ToolFailed):
        return found
    shown = {str(row.get("id")) for row in hits}
    others = [row for row in _rows(listed) if str(row.get("id")) not in shown][
        : MAX_LISTED_TEMPLATES - len(hits)
    ]
    if not others:
        return found
    found.other_templates = [_template(row) for row in others]
    found.note = OTHER_TEMPLATES.format(
        shown=len(others), total=_total(listed, len(hits) + len(others))
    )
    return found


def _rows(page: Any) -> list[dict[str, Any]]:
    items = page.get("items") if isinstance(page, dict) else None
    return [row for row in items or [] if isinstance(row, dict)]


def _total(page: Any, at_least: int) -> int:
    """Core's count of the usable templates, at least the ones seen."""
    total = page.get("total") if isinstance(page, dict) else None
    return total if isinstance(total, int) and total >= at_least else at_least


async def _usable_page(env: ToolEnv) -> Any:
    """Core's page of the workflow templates the user can use, without a
    search, most recently changed first; its failure as a value, so the
    searches' hits still come back when only the list cannot be read."""
    try:
        return await env.call(
            "core",
            "GET",
            "/api/v2/template",
            params={"kind": "workflow", "source": "all", "size": MAX_LISTED_TEMPLATES},
        )
    except ToolFailed as exc:
        return exc


def _usable_templates(page: Any) -> FoundTemplates:
    """The workflow templates the user can use, for a query no search found
    one for (``_usable_page``)."""
    templates = [_template(row) for row in _rows(page)[:MAX_LISTED_TEMPLATES]]
    total = _total(page, len(templates))
    if not templates:
        note = NO_TEMPLATES
    elif total > len(templates):
        note = FIRST_TEMPLATES.format(shown=len(templates), total=total)
    else:
        note = ALL_TEMPLATES.format(total=total)
    return FoundTemplates(templates=templates, note=note)


FIND_TEMPLATES: ToolSpec[FindTemplatesInput, FoundTemplates] = ToolSpec(
    name="workflow.find_templates",
    description=(
        "Find workflow templates that fit an analysis, with the inputs each asks "
        "for. A fitting template is preferred over a new draft: templates are "
        "tested. When no template's name or description holds the query or one "
        "of its words, it lists the workflow templates the user can use instead; "
        "beside a few hits, other_templates lists the other ones. It searches "
        "once per answer: a later call returns the first call's result."
    ),
    input_model=FindTemplatesInput,
    output_model=FoundTemplates,
    run=_find_templates,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    # A rephrased query searches the same names and descriptions, and each
    # call takes one of the answer's look-ups: the first call's result (its
    # hits, or the usable templates when it found none) answers the later ones.
    once_per_answer=TEMPLATES_SEARCHED,
)


class FromTemplateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: UUID = Field(description="A template id from workflow_find_templates.")
    bindings: dict[
        Annotated[str, Field(min_length=1, max_length=_BINDING_KEY_CHARS)],
        Annotated[int, Field(ge=1)],
    ] = Field(
        default_factory=dict,
        max_length=20,
        description=(
            "For each input to fill: its key -> the project layer "
            "(layer_project_id from project_get_layers). Inputs that need a layer "
            "and are not bound stay open for the user."
        ),
    )
    name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        description="A name for the workflow; default: the template's.",
    )


async def _workflow_template(env: ToolEnv, template_id: UUID) -> dict[str, Any]:
    """The template as the user may read it, refused unless it makes a
    workflow: core puts a layout template into the project's layouts."""
    try:
        found = await env.call("core", "GET", f"/api/v2/template/{template_id}")
    except ServiceError as exc:
        if exc.status in (401, 403):
            raise ToolFailed(TEMPLATE_REFUSED) from exc
        if exc.status == 404:
            raise InputInvalid(NO_TEMPLATE) from exc
        raise
    row: dict[str, Any] = found if isinstance(found, dict) else {}
    kind = row.get("payload_kind")
    if kind != "workflow":
        refused = (
            "Only workflow templates can be used; find one with "
            "workflow_find_templates."
        )
        if kind in ("layout", "project"):
            refused = f"The template is a {kind} template. {refused}"
        raise InputInvalid(refused)
    return row


def _added_notes(used: dict[str, Any]) -> list[str]:
    """What the use put into the project besides the workflow: the layers
    linked for the template's datasets, and the copies core makes of the
    copied ones (a copy job that did not start makes none)."""
    added = {i for i in used.get("added_layer_project_ids") or [] if isinstance(i, int)}
    started = [
        job
        for job in used.get("copy_jobs") or []
        if isinstance(job, dict) and not job.get("error")
    ]
    for job in started:
        added.update(
            i for i in job.get("layer_project_ids") or [] if isinstance(i, int)
        )
    if not added:
        return []
    note = (
        "The template also added layers to the project (layer_project_ids "
        f"{', '.join(map(str, sorted(added)))}); read them with project_get_layers."
    )
    if started:
        note += (
            " Copies of the template's datasets are being made in the background: "
            "until a copy is ready, its layer shows the template's dataset, read-only."
        )
    return [note]


#: The input a connection without a target handle feeds, as the runner
#: reads it (``workflow_checks.DEFAULT_TARGET_HANDLE`` in processes).
_DEFAULT_HANDLE = "input_layer_id"


def _node_data(node: Mapping[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


def _node_kind(node: Mapping[str, Any]) -> str:
    """The step's type as the runner reads it: ``data.type``, else ``type``."""
    return str(_node_data(node).get("type") or node.get("type") or "")


def _items(value: Any) -> list[dict[str, Any]]:
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def config_graph(config: Mapping[str, Any], waiting: Iterable[str] = ()) -> Graph:
    """The gate's graph of an editor config: a dataset step without a layer
    is open, as the check reports it (``layer_not_chosen``), and so is each
    step of ``waiting``, whose layer is not readable yet."""
    nodes = _items(config.get("nodes"))
    connections = tuple(
        (
            str(edge["source"]),
            str(edge["target"]),
            str(edge.get("targetHandle") or _DEFAULT_HANDLE),
        )
        for edge in _items(config.get("edges"))
        if edge.get("source") is not None and edge.get("target") is not None
    )
    unchosen = [
        *waiting,
        *(
            str(node.get("id"))
            for node in nodes
            if _node_kind(node) == "dataset"
            and (
                _node_data(node).get("unresolved") is True
                or not _node_data(node).get("layerId")
            )
        ),
    ]
    return Graph(
        open_ids=downstream(
            unchosen, ((source, target) for source, target, _ in connections)
        ),
        tools={
            str(node.get("id")): tool
            for node in nodes
            if _node_kind(node) == "tool"
            and isinstance(tool := _node_data(node).get("processId"), str)
        },
        connections=connections,
    )


def _step_name(node: Mapping[str, Any], titles: Mapping[str, str]) -> str:
    """The step's name as processes names it in its messages: its label; for
    a tool step whose label is empty or the tool's id (the editor's label of
    a new step), the tool's title; else its type. Clipped: the template's
    author wrote it."""
    data, kind = _node_data(node), _node_kind(node)
    label = data.get("label")
    name = label if isinstance(label, str) and label.strip() else None
    tool = data.get("processId")
    if kind == "tool" and isinstance(tool, str) and name in (None, tool):
        name = titles.get(tool, name)
    return _clip(name or kind, _TEMPLATE_LABEL_CHARS) or "step"


def _named(
    config: Mapping[str, Any], titles: Mapping[str, str]
) -> tuple[dict[str, Any], dict[str, str]]:
    """The config with each step's name as its label, and the names by step
    id: the check's messages then start with the names the answer quotes."""
    nodes: list[Any] = []
    names: dict[str, str] = {}
    for node in config.get("nodes") or []:
        if isinstance(node, dict) and node.get("id") is not None:
            name = _step_name(node, titles)
            names[str(node["id"])] = name
            node = {**node, "data": {**_node_data(node), "label": name}}
        nodes.append(node)
    return {**config, "nodes": nodes}, names


def _empty_copy_steps(
    template: Mapping[str, Any], config: Mapping[str, Any], bound: Iterable[str]
) -> frozenset[str]:
    """The steps that read the dataset of an empty copy the use makes, not
    the user's copy: an input the user did not bind whose step still names
    the template's own dataset. Core shares no empty copy's dataset, so the
    user may not read it; the copy job points the step at the copy."""
    bound_keys = set(bound)
    sources = {
        item["key"]: str(item.get("layer_id"))
        for item in _items(template.get("inputs"))
        if isinstance(item.get("key"), str)
        and item.get("mode") == "copy"
        and item.get("copy_content") is False
        and item.get("key") not in bound_keys
    }
    return frozenset(
        str(node.get("id"))
        for node in _items(config.get("nodes"))
        if _node_kind(node) == "dataset"
        and isinstance(key := _node_data(node).get("templateInput"), str)
        and key in sources
        and str(_node_data(node).get("layerId")) == sources[key]
    )


async def _check_template(
    env: ToolEnv,
    project_id: UUID,
    config: Mapping[str, Any],
    waiting: frozenset[str] = frozenset(),
) -> tuple[list[DraftIssue], list[DraftIssue], dict[str, str]]:
    """The issues of the workflow a template makes, as the check sees them,
    split as ``workflow_create`` splits a draft's: ``(blocking, open, the
    steps' names)``. A step without a layer is open like a draft step left
    open, and so is a step of ``waiting`` (``_empty_copy_steps``), whose
    ``layer_not_readable`` is no issue: its copy is on the way, as the
    answer's notes say. That of a tool step it feeds stays: core's preview
    clears the settings naming the copy's dataset by entry, so the step
    names some other layer the user cannot read. Refused when it cannot be
    checked now or when processes refuses the config itself."""
    graph = config_graph(config, waiting)
    # A tool id outside the pattern names no tool processes knows; at most
    # as many tools as a draft can hold are described.
    tools = sorted(
        {tool for tool in graph.tools.values() if re.fullmatch(TOOL_ID_PATTERN, tool)}
    )[:MAX_STEPS]
    descriptions = await _descriptions(env, tools)
    if descriptions is None:
        raise ToolFailed(TEMPLATE_NOT_CHECKED)
    checked, names = _named(config, _titles(descriptions))
    ids = {step_id: step_id for step_id in names}
    try:
        issues = await _checked(
            env,
            project_id,
            Converted(config=checked, node_ids=ids, step_of=ids, labels=names),
        )
    except InputInvalid as exc:
        # Processes refused the config itself: the template's author wrote
        # it, so no other call of this tool gets past it.
        cause = exc.__cause__
        detail = cause.detail if isinstance(cause, ServiceError) else exc.message
        raise ToolFailed(
            "Not created: the template's workflow is damaged "
            f"({_clip(detail, _TEMPLATE_ISSUE_CHARS)}). {TEMPLATE_ELSEWHERE}"
        ) from exc
    if issues is None:
        raise ToolFailed(TEMPLATE_NOT_CHECKED)
    clipped = [
        issue.model_copy(
            update={
                "message": _clip(issue.message, _TEMPLATE_ISSUE_CHARS) or issue.code
            }
        )
        for issue in issues
        if not (
            issue.code == "layer_not_readable"
            and issue.steps
            and set(issue.steps) <= waiting
        )
    ]
    blocking, still_open = _split(graph, descriptions, clipped)
    return blocking, still_open, names


def _input_steps(config: Mapping[str, Any]) -> dict[str, list[str]]:
    """The dataset steps of each template input, by the input's key."""
    steps: dict[str, list[str]] = {}
    for node in _items(config.get("nodes")):
        key = _node_data(node).get("templateInput")
        if _node_kind(node) == "dataset" and isinstance(key, str):
            steps.setdefault(key, []).append(str(node.get("id")))
    return steps


def _refusal(
    blocking: list[DraftIssue], config: Mapping[str, Any], bound: Iterable[str]
) -> Exception:
    """A refused use: the issues, and what to do instead. An issue of a
    bound input's step or of a step that reads from one may go with another
    binding; any other is the template's own, which no binding fixes."""
    listed = " ".join(issue.message for issue in blocking[:MAX_LISTED_ISSUES])
    refused = f"Not created: {len(blocking)} issue(s) must be fixed first. {listed}"
    by_input = _input_steps(config)
    reached = downstream(
        (step for key in bound for step in by_input.get(key, [])),
        ((source, target) for source, target, _ in config_graph(config).connections),
    )
    if any(set(issue.steps) & reached for issue in blocking):
        return InputInvalid(f"{refused} {TEMPLATE_FIX}")
    return ToolFailed(
        f"{refused} The template cannot be used as it is. {TEMPLATE_ELSEWHERE}"
    )


def _left_open(
    preview: Mapping[str, Any],
    still_open: list[DraftIssue],
    names: Mapping[str, str],
) -> list[OpenIssue]:
    """The issues left open for the user: the check's, and each input the
    use leaves unresolved that the check did not name (processes checks
    nothing in a workflow without a tool step)."""
    found = [_open_issue(issue, names) for issue in still_open]
    named = {
        step
        for issue in still_open
        if issue.code == "layer_not_chosen"
        for step in issue.steps
    }
    by_input = _input_steps(preview.get("config") or {})
    for item in _items(preview.get("unresolved_inputs")):
        key = item.get("key")
        steps = by_input.get(key, []) if isinstance(key, str) else []
        if named & set(steps):
            continue
        label = names.get(steps[0], "") if steps else ""
        label = label or _label(item)
        found.append(
            OpenIssue(
                step=label or None,
                code="layer_not_chosen",
                message=f"{label}: no layer is chosen.",
            )
        )
    return found


async def _post_use(env: ToolEnv, path: str, body: dict[str, Any]) -> Any:
    """A POST to the template's use or its preview, which take the same
    rights: read on the template, write on the project."""
    try:
        return await env.call("core", "POST", path, json_body=body)
    except ServiceError as exc:
        if exc.status in (401, 403):
            raise ToolFailed(TEMPLATE_REFUSED) from exc
        if exc.status == 404:
            raise InputInvalid(NO_TEMPLATE) from exc
        if exc.status == 422:
            raise InputInvalid(
                f"The template cannot be used in this project: {exc.detail}"
            ) from exc
        raise


async def _from_template(env: ToolEnv, args: FromTemplateInput) -> WorkflowCreated:
    project_id = open_project(env)
    template = await _workflow_template(env, args.template_id)
    # Core skips a binding whose key the template does not have: the input
    # would stay open, and a corrected call would make a second workflow.
    keys = [item.key for item in _inputs(template)]
    unknown = sorted(set(args.bindings) - set(keys))
    if unknown:
        listed = ", ".join(keys[:MAX_TEMPLATE_INPUTS])
        if len(keys) > MAX_TEMPLATE_INPUTS:
            listed += ", …"
        raise InputInvalid(
            f"The template has no input {', '.join(map(repr, unknown))}. Its inputs: "
            f"{listed or 'none'}."
        )
    layers, locked = await project_layers(env, project_id)
    bindings: dict[str, str] = {}
    for key, layer_project_id in args.bindings.items():
        if layer_project_id in locked:
            raise InputInvalid(
                f"{locked[layer_project_id]!r} is in the project, but the user has no "
                "access to its data; bind another layer."
            )
        layer = layers.get(layer_project_id)
        if layer is None:
            raise InputInvalid(
                f"There is no layer {layer_project_id} in the project; call "
                "project_get_layers."
            )
        bindings[key] = layer.layer_id
    use = f"/api/v2/template/{args.template_id}/use"
    body: dict[str, Any] = {"project_id": str(project_id), "bindings": bindings}
    # Checked before it exists: the preview is the config the use writes.
    preview = await _post_use(env, f"{use}/preview", dict(body))
    config = preview.get("config") if isinstance(preview, dict) else None
    if not isinstance(config, dict):
        raise ToolFailed(TEMPLATE_NOT_CHECKED)
    blocking, still_open, names = await _check_template(
        env, project_id, config, _empty_copy_steps(template, config, args.bindings)
    )
    if blocking:
        raise _refusal(blocking, config, args.bindings)
    if args.name is not None:
        body["name"] = args.name
    used = await _post_use(env, use, body)
    workflow_id = used.get("workflow_id") if isinstance(used, dict) else None
    if not workflow_id:
        raise ToolFailed("The template made no workflow.")
    # Named as core names it, so nothing is read after the write: a failing
    # read would hide a workflow that exists.
    workflow = CreatedWorkflow(
        id=str(workflow_id),
        name=args.name or _clip(template.get("name")) or "",
        project_id=str(project_id),
    )
    env.runs.created.add(workflow.id)
    return WorkflowCreated(
        workflow=workflow,
        open_issues=_left_open(preview, still_open, names),
        groups=workflow_card(workflow),
        notes=_added_notes(used) or None,
    )


CREATE_FROM_TEMPLATE: ToolSpec[FromTemplateInput, WorkflowCreated] = ToolSpec(
    name="workflow.create_from_template",
    description=(
        "Create a workflow in the open project from a workflow template, its "
        "inputs bound to project layers. The workflow it makes is checked first, "
        "as workflow_create checks a draft, and refused while an issue remains "
        "that the user cannot resolve by choosing the layers of the inputs left "
        "unbound. Answers with the workflow and the issues left open for the "
        "user. It does not start the workflow: workflow_run does, or the user "
        "with Run."
    ),
    input_model=FromTemplateInput,
    output_model=WorkflowCreated,
    run=_from_template,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
)

# -- catalog datasets --------------------------------------------------------------

#: How many picked ids are looked up as bundles at most, the newest picks
#: first.
MAX_BUNDLE_LOOKUPS = 10
_RECORD_ID = re.compile(RECORD_ID_PATTERN)


def _may_be_bundle(item: str) -> bool:
    """Whether a picked id may name a bundle: a picked value is any short key,
    so only a record id that is no dot segment goes into a lookup's path, and
    a workflow run's value never names a dataset."""
    return (
        _RECORD_ID.fullmatch(item) is not None
        and item not in (".", "..")
        and not item.startswith(RUN_PREFIX)
    )


async def dataset_picked(
    env: ToolEnv,
    dataset_id: str,
    *,
    members: Callable[[str], Awaitable[set[str]]],
    candidate: Callable[[str], bool] | None = None,
) -> bool:
    """Whether the user picked this dataset in a card: an option's value or
    adds names it, or names a bundle it belongs to. ``members`` lists a
    bundle's datasets (an empty set for an id that is no bundle);
    ``candidate`` tells which ids ``members`` can find a bundle under at all.
    Both filters apply before the lookups are capped, so newer picks of ids
    that name no bundle do not push an older bundle pick out."""
    picked = recent_picked_ids(env.asks)
    if dataset_id in picked:
        return True
    candidates = [
        item
        for item in picked
        if _may_be_bundle(item) and (candidate is None or candidate(item))
    ]
    found = await asyncio.gather(
        *(members(item) for item in candidates[:MAX_BUNDLE_LOOKUPS])
    )
    return any(dataset_id in ids for ids in found)


def _catalog_members(env: ToolEnv) -> Callable[[str], Awaitable[set[str]]]:
    """The datasets of a catalog bundle, as the catalog resolves its id: the
    ids of its members (the catalog sends a capped list), an empty set for a
    dataset, an unknown id or a catalog that does not answer."""

    async def members(item_id: str) -> set[str]:
        if not _may_be_bundle(item_id):
            return set()
        try:
            resolved = await env.call(
                "catalog", "GET", f"/stac/resolve/{quote(item_id, safe='')}"
            )
        except ToolFailed:
            return set()
        if not isinstance(resolved, dict) or resolved.get("kind") != "collection":
            return set()
        return {
            str(member["id"])
            for member in resolved.get("items") or []
            if isinstance(member, dict) and member.get("id")
        }

    return members


class AddCatalogLayerInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    catalog_id: str = Field(
        pattern=RECORD_ID_PATTERN,
        description=(
            "The catalog dataset the user picked in your card, an id from "
            "catalog_search: the picked option's value, one of its adds, or a "
            "member of the bundle it names."
        ),
    )


class AddedLayer(BaseModel):
    layer_project_id: int
    name: str
    type: str | None = None
    geometry_type: str | None = None


class AddedLayers(BaseModel):
    project_id: str
    layers: list[AddedLayer]
    note: str = ADDED_NOTE

    def created(self) -> dict[str, Any]:
        return {
            "kind": "layer",
            "ids": [str(layer.layer_project_id) for layer in self.layers],
            "project_id": self.project_id,
        }


def _added_layers(project_id: UUID, rows: Any, note: str) -> AddedLayers:
    """The project layers core's add answered with: its rows that have a
    layer_project_id."""
    return AddedLayers(
        project_id=str(project_id),
        layers=[
            AddedLayer(
                layer_project_id=row["id"],
                name=str(row.get("name") or ""),
                type=row.get("type"),
                geometry_type=row.get("feature_layer_geometry_type"),
            )
            for row in rows or []
            if isinstance(row, dict) and isinstance(row.get("id"), int)
        ],
        note=note,
    )


async def _add_catalog_layer(env: ToolEnv, args: AddCatalogLayerInput) -> AddedLayers:
    project_id = open_project(env)
    # The user's pick in a card, read from the stored conversation: never the
    # model's word, never a typed reply (spec §5.3).
    if not await dataset_picked(env, args.catalog_id, members=_catalog_members(env)):
        raise ToolFailed(NO_CONSENT)
    try:
        rows = await env.call(
            "core",
            "POST",
            f"/api/v2/project/{project_id}/layer-catalog",
            # One id as a string: the endpoint takes repeated keys, and a list
            # here would be joined with commas into one value.
            params={"catalog_ids": args.catalog_id},
        )
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403):
            raise ToolFailed(VIEWER_LAYERS) from exc
        # Core answers 404 both for an id the catalog does not have and for a
        # trashed project; only the first is the model's to fix.
        if exc.status == 404 and exc.detail.startswith("Catalog item not found"):
            if await users_dataset(env, args.catalog_id):
                raise InputInvalid(own_dataset(args.catalog_id)) from exc
            raise InputInvalid(
                f"The catalog has no dataset {args.catalog_id!r}."
            ) from exc
        if exc.status == 404:
            raise ToolFailed(NOT_READABLE) from exc
        raise
    return _added_layers(project_id, rows, ADDED_NOTE)


ADD_CATALOG_LAYER: ToolSpec[AddCatalogLayerInput, AddedLayers] = ToolSpec(
    name="project.add_catalog_layer",
    description=(
        "Add a catalog dataset to the open project, only one the user picked in "
        "your ask_user card (its option's value or adds, or a bundle it belongs "
        "to). Answers with the new layers and their layer_project_ids."
    ),
    input_model=AddCatalogLayerInput,
    output_model=AddedLayers,
    run=_add_catalog_layer,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
)

# -- the user's own datasets -------------------------------------------------------


def _is_uuid(item: str) -> bool:
    """Whether a picked id is a UUID, the only id a bundle in GOAT has."""
    try:
        UUID(item)
    except ValueError:
        return False
    return True


def catalog_dataset(item: str) -> str:
    """The failure of ``project_add_dataset`` for an id the catalog has."""
    return (
        f"Not added: {item!r} is a catalog dataset or bundle, not one of the "
        "user's own: project_add_catalog_layer adds it, or a bundle's datasets."
    )


def own_dataset(item: str) -> str:
    """The failure of ``project_add_catalog_layer`` for a dataset of the
    user's own."""
    return (
        f"The catalog has no dataset {item!r}: it is one of the user's own, and "
        "project_add_dataset adds it."
    )


def _bundle_members(env: ToolEnv) -> Callable[[str], Awaitable[set[str]]]:
    """The datasets of a bundle in GOAT, as core lists its layers: their layer
    ids; an empty set for an id that is no UUID, a dataset, an unknown id or a
    bundle the user cannot read."""

    async def members(item_id: str) -> set[str]:
        try:
            bundle_id = UUID(item_id)
        except ValueError:
            return set()
        try:
            rows = await env.call("core", "GET", f"/api/v2/bundle/{bundle_id}/layers")
        except ToolFailed:
            return set()
        return {
            str(row["layer_id"])
            for row in (rows if isinstance(rows, list) else [])
            if isinstance(row, dict) and row.get("layer_id")
        }

    return members


class AddDatasetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: UUID = Field(
        description=(
            "One of the user's own datasets the user picked in your card: the id "
            "core_find returned for it (a dataset, not a bundle)."
        )
    )


async def _add_dataset(env: ToolEnv, args: AddDatasetInput) -> AddedLayers:
    project_id = open_project(env)
    dataset_id = str(args.dataset_id)
    # The user's pick in a card, read from the stored conversation, as for a
    # catalog dataset.
    if not await dataset_picked(
        env, dataset_id, members=_bundle_members(env), candidate=_is_uuid
    ):
        raise ToolFailed(NOT_PICKED_DATASET)
    # Core links any existing layer it is sent, without checking that the
    # user can read it: the read is checked here, before the add.
    try:
        await env.call("core", "GET", f"/api/v2/layer/{dataset_id}")
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403, 404, 422):
            # A catalog id in the card's adds looks like the user's: only
            # the catalog can tell, asked on this failure alone.
            if await in_catalog(env, dataset_id):
                raise ToolFailed(catalog_dataset(dataset_id)) from exc
            raise ToolFailed(CANNOT_READ_DATASET) from exc
        raise
    try:
        rows = await env.call(
            "core",
            "POST",
            f"/api/v2/project/{project_id}/layer",
            params={"layer_ids": dataset_id},
        )
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403):
            raise ToolFailed(VIEWER_LAYERS) from exc
        if exc.status == 404:
            raise ToolFailed(NOT_READABLE) from exc
        raise
    return _added_layers(project_id, rows, ADDED_DATASET_NOTE)


ADD_DATASET: ToolSpec[AddDatasetInput, AddedLayers] = ToolSpec(
    name="project.add_dataset",
    description=(
        "Add one of the user's own datasets (from core_find) to the open project, "
        "only one the user picked in your ask_user card. Answers with the new layer "
        "and its layer_project_id. Catalog datasets: project_add_catalog_layer."
    ),
    input_model=AddDatasetInput,
    output_model=AddedLayers,
    run=_add_dataset,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
)

WORKFLOW_TOOLS: tuple[ToolSpec[Any, Any], ...] = (
    CHECK_DRAFT,
    CREATE,
    FIND_TEMPLATES,
    CREATE_FROM_TEMPLATE,
    ADD_CATALOG_LAYER,
    ADD_DATASET,
)
