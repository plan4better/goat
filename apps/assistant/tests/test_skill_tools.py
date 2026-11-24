"""Tools a page offers only once the conversation loaded a skill
(``assistant.tools.registry.SKILL_TOOLS``): on the map page, the tools that
build, change and run workflows come with ``build-a-workflow``."""

import json
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import RetryPromptPart, ToolReturnPart

from assistant.agent import RunDeps, build_agent
from assistant.budget import RunBudget
from assistant.context import parse_context
from assistant.login import StaticLogin
from assistant.prompt import MAP_WORKFLOWS, render_note, with_note
from assistant.surfaces import SURFACES
from assistant.tools.registry import (
    BY_WIRE_NAME,
    MCP_TOOLS,
    SKILL_TOOLS,
    offered_tools,
    tools_for,
)
from assistant.tools.runtime import ToolEnv
from assistant.tools.testing import Recorder, ScriptedModel, fake_clients
from assistant.tools.toolset import _tool, answer_writes, skill_first

MAP_PROJECT = "00000000-0000-0000-0000-0000000000aa"
MAP_PAGE = parse_context({"surface": "project.map", "project_id": MAP_PROJECT})
WORKFLOWS_PAGE = parse_context(
    {"surface": "project.workflows", "project_id": MAP_PROJECT}
)
SKILL = "build-a-workflow"
#: The tools the map page offers once ``build-a-workflow`` is loaded.
DEFERRED = {
    "workflow_check_draft",
    "workflow_create",
    "workflow_create_from_template",
    "workflow_find_templates",
    "workflow_run",
    "workflow_tools",
    "workflow_update",
}
#: The bound on the definitions a map page request offers before the skill
#: is loaded, in characters of name, description and JSON schema.
REDUCED_CHARS = 78_000


def _chars(names: list[str]) -> int:
    return sum(
        len(
            json.dumps(
                {
                    "name": name,
                    "description": BY_WIRE_NAME[name].description,
                    "parameters": BY_WIRE_NAME[name].json_schema(),
                },
                ensure_ascii=False,
            )
        )
        for name in names
    )


def _names(surface: Any, skills: set[str] | None) -> list[str]:
    return [spec.wire_name for spec in offered_tools(surface, skills)]


def test_the_map_page_offers_the_workflow_builders_only_with_the_skill() -> None:
    assert SKILL_TOOLS == {"project.map": {SKILL: frozenset(DEFERRED)}}
    full = [spec.wire_name for spec in tools_for("project.map")]
    reduced = _names("project.map", set())
    assert set(full) - set(reduced) == DEFERRED
    assert _chars(reduced) < REDUCED_CHARS < _chars(full)
    # The reads of workflows stay: listing, reading one, its latest run, and
    # what a tool's result fields mean.
    assert {
        "project_get_workflows",
        "workflow_get",
        "workflow_last_run",
        "workflow_describe_tool",
    } <= set(reduced)
    # Kept tools in registry order, the skill's tools after them: the
    # definitions before them stay the same when the skill loads.
    loaded = _names("project.map", {SKILL})
    assert loaded[: len(reduced)] == reduced
    assert sorted(loaded) == sorted(full)
    assert loaded[len(reduced) :] == sorted(DEFERRED)
    assert reduced == [name for name in full if name not in DEFERRED]
    # Another skill brings none of them.
    assert _names("project.map", {"style-a-map"}) == reduced


def test_unknown_skills_and_other_pages_offer_every_tool_of_the_page() -> None:
    """Over MCP and in a run whose conversation was not read the skills are
    not known (None): nothing is withheld. No other page withholds any."""
    assert set(_names("project.map", None)) == {
        spec.wire_name for spec in tools_for("project.map")
    }
    for surface in SURFACES:
        if surface == "project.map":
            continue
        assert _names(surface, set()) == [s.wire_name for s in tools_for(surface)]
    # The MCP endpoint lists its own fixed set.
    assert {spec.wire_name for spec in MCP_TOOLS} == {
        "catalog_search",
        "catalog_describe",
        "catalog_get_record",
        "catalog_suggest_terms",
        "catalog_find_region",
    }


def _deps(
    page: Any, skills: set[str] | None, recorder: Recorder | None = None
) -> RunDeps:
    async def emit(event: Any) -> None:
        return None

    env = ToolEnv(
        services=fake_clients(processes=recorder, core=recorder),
        login=StaticLogin(None),
        user_id=UUID(int=1),
        page=page,
        skills=skills,
    )
    return RunDeps(
        message_id="m1",
        emit=emit,
        env=env,
        prompt_note=render_note(page, None, "en"),
    )


def _offered(script: ScriptedModel, request: int) -> list[str]:
    return [tool.name for tool in script.infos[request].function_tools]


async def test_the_skill_loaded_in_one_step_brings_its_tools_in_the_next() -> None:
    script = ScriptedModel([("skills_load", {"name": SKILL})], answer="ready")
    deps = _deps(MAP_PAGE, set())
    await build_agent(script.model).run(with_note(deps.prompt_note, "hi"), deps=deps)
    first, second = _offered(script, 0), _offered(script, 1)
    assert first == _names("project.map", set())
    assert not DEFERRED & set(first)
    assert second == _names("project.map", {SKILL})
    assert DEFERRED <= set(second)


async def test_a_skill_loaded_in_an_earlier_answer_offers_its_tools_at_once() -> None:
    script = ScriptedModel(answer="ok")
    deps = _deps(MAP_PAGE, {SKILL})
    await build_agent(script.model).run(with_note(deps.prompt_note, "hi"), deps=deps)
    assert _offered(script, 0) == _names("project.map", {SKILL})


async def test_the_workflows_page_offers_its_tools_without_the_skill() -> None:
    script = ScriptedModel(answer="ok")
    deps = _deps(WORKFLOWS_PAGE, set())
    await build_agent(script.model).run(with_note(deps.prompt_note, "hi"), deps=deps)
    assert _offered(script, 0) == [s.wire_name for s in tools_for("project.workflows")]


async def test_a_withheld_tool_named_anyway_is_refused_with_the_skill_to_load() -> None:
    recorder = Recorder()
    script = ScriptedModel(
        [("workflow_tools", {}), ("workflow_run", {"workflow_id": "x"})],
        answer="ok",
    )
    deps = _deps(MAP_PAGE, set(), recorder)
    deps.budget = RunBudget(max_tokens=400_000, max_tool_calls=40)
    result = await build_agent(script.model).run(
        with_note(deps.prompt_note, "hi"), deps=deps
    )
    assert result.output == "ok"
    texts = [
        str(part.content)
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, (ToolReturnPart, RetryPromptPart))
    ]
    assert texts == [
        skill_first("workflow_tools", SKILL),
        skill_first("workflow_run", SKILL),
    ]
    assert "skills_load" in texts[0] and SKILL in texts[0]
    assert recorder.paths() == []
    # Counted like calls that ran: a model that insists reaches the
    # tool-call limit.
    assert sum(deps.admitted_calls.values()) == 2


async def test_a_call_made_in_the_step_that_loads_the_skill_is_refused() -> None:
    """What a step may call is decided as its request is made: a withheld
    tool named next to skills_load in one response is still refused, also
    once the skill has loaded."""
    deps = _deps(MAP_PAGE, set())
    deps.withheld[None] = (1, frozenset(DEFERRED))
    assert deps.env is not None
    deps.env.skills = {SKILL}
    ctx: Any = SimpleNamespace(
        deps=deps, run_id=None, run_step=1, tool_call_id="c1", messages=[]
    )
    tool = _tool(BY_WIRE_NAME["workflow_tools"])
    with pytest.raises(ToolFailed) as refused:
        await tool.function(ctx)  # type: ignore[call-arg]
    assert str(refused.value) == skill_first("workflow_tools", SKILL)


def test_the_step_that_answers_offers_only_the_changes_the_page_offers() -> None:
    """The note that offers the change names workflow_update only once the
    skill brought it."""
    for skills, expected in (
        (set(), ["style_update", "map_update", "undo_changes"]),
        ({SKILL}, ["style_update", "map_update", "workflow_update", "undo_changes"]),
    ):
        deps = _deps(MAP_PAGE, skills)
        deps.run_room["r1"] = 3
        ctx: Any = SimpleNamespace(deps=deps, run_id="r1", run_step=3, messages=[])
        assert answer_writes(ctx) == expected


def test_the_map_page_offers_at_most_forty_one_tools_in_all() -> None:
    assert len(tools_for("project.map")) <= 41
    assert len(offered_tools("project.map", {SKILL})) == len(tools_for("project.map"))


def test_the_map_note_says_the_workflow_tools_come_with_the_skill() -> None:
    note = render_note(MAP_PAGE, None, "en")
    assert MAP_WORKFLOWS in note.splitlines()
    assert "skills_load" in MAP_WORKFLOWS and SKILL in MAP_WORKFLOWS
    for surface_page in (WORKFLOWS_PAGE, parse_context({"surface": "catalog"})):
        assert MAP_WORKFLOWS not in render_note(surface_page, None, "en")
