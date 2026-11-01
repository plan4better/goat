"""What the assistant reads about GOAT's analysis tools when it builds a
workflow (spec §3): ``workflow_tools`` lists them, ``workflow_describe_tool``
gives their layer inputs and settings. On the Map and Workflows pages.

``GET /processes`` is asked on every call: it leaves out tools in beta for a
user outside the beta. A tool's description (``GET /processes/{id}``) is the
same for every user and changes only with a deployment of processes, so it is
cached per language for ``DESCRIPTION_TTL_SECONDS``. Neither returns data
values: tools, settings and their names only.
"""

import asyncio
import time
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.surfaces import Surface
from assistant.tools.http import ServiceError
from assistant.tools.runtime import ToolEnv, ToolSpec
from assistant.workflows import tool_info
from assistant.workflows.draft import TOOL_ID_PATTERN
from assistant.workflows.tool_info import LayerInputInfo, SettingInfo

#: The pages of the workflows pack.
WORKFLOW_SURFACES: frozenset[Surface] = frozenset({"project.map", "project.workflows"})
DESCRIPTION_TTL_SECONDS = 600.0
MAX_DESCRIBED = 6
#: ``GET /processes`` cuts its list at ``limit`` (100 unless asked) and has no
#: paging; this is the largest limit it takes, so the toolbox is never cut.
PROCESS_LIST_LIMIT = 1000
NOT_OFFERED = (
    "No tool with this id is offered to the user; pick one from workflow_tools."
)

_descriptions: dict[tuple[str, str], tuple[float, dict[str, Any] | None]] = {}


def clear_description_cache() -> None:
    _descriptions.clear()


def language_header(env: ToolEnv) -> dict[str, str]:
    """Processes answers in the user's interface language."""
    return {"Accept-Language": env.locale}


async def description(env: ToolEnv, tool_id: str) -> dict[str, Any] | None:
    """A tool's process description in the user's language; None for a tool
    processes does not know."""
    key = (env.locale, tool_id)
    now = time.monotonic()
    cached = _descriptions.get(key)
    if cached is not None and now - cached[0] < DESCRIPTION_TTL_SECONDS:
        return cached[1]
    try:
        found = await env.call(
            "processes", "GET", f"/processes/{tool_id}", headers=language_header(env)
        )
    except ServiceError as exc:
        if exc.status != 404:
            raise
        found = None
    described = found if isinstance(found, dict) else None
    _descriptions[key] = (now, described)
    return described


async def offered(env: ToolEnv) -> list[dict[str, Any]]:
    """The tools of the user's toolbox: ``GET /processes`` for this user,
    without the ones hidden from the toolbox (the sync analytics, imports).
    An answer without a list of tools fails like an unreachable processes:
    read as an empty toolbox, it would refuse every tool."""
    listing = await env.call(
        "processes",
        "GET",
        "/processes",
        params={"limit": PROCESS_LIST_LIMIT},
        headers=language_header(env),
    )
    rows = listing.get("processes") if isinstance(listing, dict) else None
    if not isinstance(rows, list):
        raise ToolFailed("processes sent no list of tools; try again in a moment.")
    return [
        row
        for row in rows
        if isinstance(row, dict)
        and isinstance(row.get("id"), str)
        and not row.get("x-ui-toolbox-hidden")
    ]


class WorkflowToolsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolSummary(BaseModel):
    id: str
    title: str
    summary: str | None = None
    category: str | None = None
    beta: bool | None = None
    layer_inputs: list[LayerInputInfo]


class ToolList(BaseModel):
    tools: list[ToolSummary]
    note: str = (
        "Read the settings of the tools you use with workflow_describe_tool, "
        "several in one call."
    )


async def _layer_inputs(env: ToolEnv, tool_id: str) -> list[LayerInputInfo]:
    """A tool's layer inputs for the list; none when its description cannot be
    read now, so one tool does not take the whole list down
    (``workflow_describe_tool`` then says what failed)."""
    try:
        found = await description(env, tool_id)
    except ToolFailed:
        return []
    return tool_info.layer_inputs(found) if found else []


async def _tools(env: ToolEnv, args: WorkflowToolsInput) -> ToolList:
    rows = await offered(env)
    inputs = await asyncio.gather(*(_layer_inputs(env, str(row["id"])) for row in rows))
    return ToolList(
        tools=[
            ToolSummary(
                id=str(row["id"]),
                title=str(row.get("title") or row["id"]),
                summary=tool_info.summary(row.get("description")),
                category=str(row["x-ui-category"])
                if row.get("x-ui-category")
                else None,
                beta=True if row.get("x-ui-beta") else None,
                layer_inputs=layer_inputs,
            )
            for row, layer_inputs in zip(rows, inputs, strict=True)
        ]
    )


WORKFLOW_TOOL_LIST: ToolSpec[WorkflowToolsInput, ToolList] = ToolSpec(
    name="workflow.tools",
    description=(
        "List GOAT's analysis tools a workflow can use: id, title, one line on "
        "what it does, and the layer inputs a step connects to (layer_inputs). "
        "Read the settings of the ones you use with workflow_describe_tool."
    ),
    input_model=WorkflowToolsInput,
    output_model=ToolList,
    run=_tools,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
)


ToolId = Annotated[str, Field(pattern=TOOL_ID_PATTERN)]


class DescribeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool_ids: list[ToolId] = Field(
        min_length=1,
        max_length=MAX_DESCRIBED,
        description="Tool ids from workflow_tools; all the tools you use, in one call.",
    )


class ToolDetails(BaseModel):
    id: str
    title: str | None = None
    description: str | None = None
    layer_inputs: list[LayerInputInfo] | None = None
    settings: list[SettingInfo] | None = None
    #: A heatmap's settings of each opportunity (``opportunity_<N>_<name>``).
    per_opportunity: list[SettingInfo] | None = None
    note: str | None = None


class ToolDetailsList(BaseModel):
    tools: list[ToolDetails]


def _details(tool_id: str, found: dict[str, Any]) -> ToolDetails:
    per_opportunity = tool_info.opportunity_settings(found)
    text = " ".join(str(found.get("description") or "").split())
    return ToolDetails(
        id=tool_id,
        title=str(found.get("title") or tool_id),
        description=text or None,
        layer_inputs=tool_info.layer_inputs(found),
        settings=tool_info.settings(found),
        per_opportunity=per_opportunity,
        note=tool_info.OPPORTUNITY_NOTE if per_opportunity is not None else None,
    )


async def _described(env: ToolEnv, tool_id: str) -> dict[str, Any] | None:
    try:
        return await description(env, tool_id)
    except ToolFailed as exc:
        raise ToolFailed(f"Could not describe {tool_id}: {exc.message}") from exc


async def _describe(env: ToolEnv, args: DescribeInput) -> ToolDetailsList:
    available = {str(row["id"]) for row in await offered(env)}
    wanted = list(dict.fromkeys(args.tool_ids))
    known = [tool_id for tool_id in wanted if tool_id in available]
    described = await asyncio.gather(*(_described(env, tool_id) for tool_id in known))
    found = dict(zip(known, described, strict=True))
    tools: list[ToolDetails] = []
    for tool_id in wanted:
        details = found.get(tool_id)
        tools.append(
            _details(tool_id, details)
            if details is not None
            else ToolDetails(id=tool_id, note=NOT_OFFERED)
        )
    return ToolDetailsList(tools=tools)


DESCRIBE_TOOL: ToolSpec[DescribeInput, ToolDetailsList] = ToolSpec(
    name="workflow.describe_tool",
    description=(
        "Describe GOAT analysis tools for a workflow draft: each one's layer "
        "inputs and settings (name, type, required, choices, default, when it is "
        "shown, which layer input a field setting reads). Several tools in one "
        "call. Use only the inputs and settings it lists."
    ),
    input_model=DescribeInput,
    output_model=ToolDetailsList,
    run=_describe,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
)

TOOL_CATALOG_TOOLS = (WORKFLOW_TOOL_LIST, DESCRIBE_TOOL)
