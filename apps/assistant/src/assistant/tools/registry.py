"""All tools, in one fixed order (spec §7.3).

Sorted by wire name, so the tool list a provider sees is the same in every run
of a surface and prompt caching keeps working. New packs are added to
``ALL_TOOLS`` (spec §14: the registry takes extra packs).

A page can offer some of its tools only once the conversation loaded a skill
(``SKILL_TOOLS``): every request carries the definitions of the tools it
offers, and a conversation that never loads the skill never calls them.
"""

from collections.abc import Collection, Mapping
from typing import Any

from assistant.surfaces import Surface
from assistant.tools.ask import ASK_USER
from assistant.tools.catalog import CATALOG_TOOLS
from assistant.tools.core import CORE_TOOLS
from assistant.tools.docs import DOCS_READ
from assistant.tools.map_edits import MAP_TOOLS
from assistant.tools.project import PROJECT_TOOLS
from assistant.tools.runtime import ToolSpec
from assistant.tools.skills import SKILLS_LOAD
from assistant.tools.styles import STYLE_TOOLS
from assistant.tools.undo import UNDO_TOOLS
from assistant.tools.workflow_edits import UPDATE, WORKFLOW_EDIT_TOOLS
from assistant.tools.workflow_runs import RUN, WORKFLOW_RUN_TOOLS
from assistant.tools.workflow_tools import TOOL_CATALOG_TOOLS, WORKFLOW_TOOL_LIST
from assistant.tools.workflows import (
    CHECK_DRAFT,
    CREATE,
    CREATE_FROM_TEMPLATE,
    FIND_TEMPLATES,
    WORKFLOW_TOOLS,
)

ALL_TOOLS: tuple[ToolSpec[Any, Any], ...] = tuple(
    sorted(
        (
            *CORE_TOOLS,
            ASK_USER,
            SKILLS_LOAD,
            DOCS_READ,
            *CATALOG_TOOLS,
            *PROJECT_TOOLS,
            *STYLE_TOOLS,
            *MAP_TOOLS,
            *TOOL_CATALOG_TOOLS,
            *WORKFLOW_TOOLS,
            *WORKFLOW_RUN_TOOLS,
            *WORKFLOW_EDIT_TOOLS,
            *UNDO_TOOLS,
        ),
        key=lambda spec: spec.wire_name,
    )
)
BY_WIRE_NAME: dict[str, ToolSpec[Any, Any]] = {
    spec.wire_name: spec for spec in ALL_TOOLS
}
MCP_TOOLS: tuple[ToolSpec[Any, Any], ...] = tuple(
    spec for spec in ALL_TOOLS if spec.mcp
)


def tools_for(surface: Surface) -> tuple[ToolSpec[Any, Any], ...]:
    return tuple(spec for spec in ALL_TOOLS if surface in spec.surfaces)


#: The tools a page offers only once the conversation loaded a skill, by
#: surface and skill. On the map page the tools that build, check, change and
#: run workflows come with ``build-a-workflow``, which says how to use them;
#: the reads of workflows (``project_get_workflows``, ``workflow_get``,
#: ``workflow_last_run``, ``workflow_describe_tool`` for what a run's result
#: fields mean) stay, since they answer questions without building anything.
#: The Workflows page offers them all from the start.
SKILL_TOOLS: Mapping[Surface, Mapping[str, frozenset[str]]] = {
    "project.map": {
        "build-a-workflow": frozenset(
            spec.wire_name
            for spec in (
                CHECK_DRAFT,
                CREATE,
                CREATE_FROM_TEMPLATE,
                FIND_TEMPLATES,
                RUN,
                UPDATE,
                WORKFLOW_TOOL_LIST,
            )
        ),
    },
}


def withheld_tools(surface: Surface, skills: Collection[str] | None) -> frozenset[str]:
    """The tools of ``surface`` a request withholds: those of the skills in
    ``SKILL_TOOLS`` the conversation has not loaded. ``skills`` None (not
    known: over MCP, and in a run whose conversation was not read) withholds
    none."""
    if skills is None:
        return frozenset()
    return frozenset(
        name
        for skill, names in SKILL_TOOLS.get(surface, {}).items()
        if skill not in skills
        for name in names
    )


def skill_of(surface: Surface, wire_name: str) -> str | None:
    """The skill that brings the tool ``wire_name`` on ``surface``; None for
    a tool offered without one."""
    for skill, names in SKILL_TOOLS.get(surface, {}).items():
        if wire_name in names:
            return skill
    return None


def offered_tools(
    surface: Surface, skills: Collection[str] | None = None
) -> tuple[ToolSpec[Any, Any], ...]:
    """The tools a request on ``surface`` offers (``withheld_tools``), in a
    fixed order: the tools no skill brings in registry order, then those a
    skill brings, so the definitions before them stay the same when a skill
    loads and the provider still reads them from its cache."""
    withheld = withheld_tools(surface, skills)
    brought = {
        name for names in SKILL_TOOLS.get(surface, {}).values() for name in names
    }
    tools = tools_for(surface)
    return tuple(
        spec
        for spec in (
            *(spec for spec in tools if spec.wire_name not in brought),
            *(spec for spec in tools if spec.wire_name in brought),
        )
        if spec.wire_name not in withheld
    )
