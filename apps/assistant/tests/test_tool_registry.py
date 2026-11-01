"""Registry invariants and the Pydantic AI adapter (spec §7.1, §7.3, §8.1, §8.3)."""

import re
from typing import Any

from pydantic_ai.messages import RetryPromptPart, ToolReturnPart

from assistant.agent import INSTRUCTIONS, RunDeps, build_agent
from assistant.context import parse_context
from assistant.prompt import SKILLS_INDEX, render_note
from assistant.surfaces import SURFACES
from assistant.tools.registry import ALL_TOOLS, BY_WIRE_NAME, MCP_TOOLS, tools_for
from assistant.tools.testing import (
    RecordingTransport,
    ScriptedModel,
    fake_clients,
    tool_env,
)
from assistant.tools.toolset import REPEATED_CALL

_URLISH = {"url", "href", "uri", "link", "endpoint", "host"}


def _walk(schema: Any) -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    if isinstance(schema, dict):
        for name, sub in (schema.get("properties") or {}).items():
            found.append((name, sub))
        for value in schema.values():
            found.extend(_walk(value))
    elif isinstance(schema, list):
        for value in schema:
            found.extend(_walk(value))
    return found


def test_names_are_unique_namespaced_and_sorted() -> None:
    names = [spec.wire_name for spec in ALL_TOOLS]
    assert names == sorted(names) and len(set(names)) == len(names)
    for spec in ALL_TOOLS:
        assert re.fullmatch(
            r"(core|catalog|project|map|ask|skills|workflow)\.[a-z_]+", spec.name
        )
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", spec.wire_name)
        assert BY_WIRE_NAME[spec.wire_name] is spec
        assert len(spec.description) >= 20


def test_every_argument_is_described() -> None:
    for spec in ALL_TOOLS:
        for name, sub in spec.json_schema().get("properties", {}).items():
            assert "description" in sub, f"{spec.wire_name}.{name}"


def test_packs_per_surface_follow_the_spec() -> None:
    def names(surface: str) -> set[str]:
        return {spec.wire_name for spec in tools_for(surface)}  # type: ignore[arg-type]

    core = {
        "ask_user",
        "core_find",
        "core_find_layers",
        "core_page_context",
        "core_show_items",
        "core_whoami",
        "skills_load",
    }
    catalog_read = {
        "catalog_describe",
        "catalog_find_region",
        "catalog_get_record",
        "catalog_search",
        "catalog_show_records",
        "catalog_suggest_terms",
    }
    project_read = {
        "project_area_statistics",
        "project_count_features",
        "project_field_statistics",
        "project_get_fields",
        "project_get_layers",
        "project_get_layouts",
        "project_get_workflows",
        "project_group_statistics",
        "project_sample_features",
    }
    # The public catalog is searchable from every page, and a filter suggestion
    # is offered everywhere: off the catalog page its card opens the catalog.
    catalog = catalog_read | {"catalog_propose_filters"}
    # Spec 2026-10-17 §3: the workflows pack, on the two pages that build workflows.
    workflows = {
        "project_add_catalog_layer",
        "project_add_dataset",
        "workflow_check_draft",
        "workflow_create",
        "workflow_create_from_template",
        "workflow_describe_tool",
        "workflow_find_templates",
        "workflow_get",
        "workflow_last_run",
        "workflow_run",
        "workflow_tools",
        "workflow_update",
    }
    # Decision T16: Home reads other projects (with an explicit project_id).
    # Only the map can apply a view proposal.
    expected = {
        "catalog": core | catalog,
        "none": core | catalog | project_read,
        "project.map": core | catalog | project_read | {"map_propose_view"} | workflows,
        "project.workflows": core | catalog | project_read | workflows,
        "project.layouts": core | catalog | project_read,
        "project.dashboard": core | catalog | project_read,
    }
    assert set(expected) == set(SURFACES)
    for surface, wire_names in expected.items():
        assert names(surface) == wire_names, surface
    for surface in SURFACES:
        # The spec's target is 10-20 per page (§7.3); the map and Workflows pages
        # carry the workflows pack (with runs, edits and both add tools), the
        # card and the skills, 36 on the map. Raising this again is a decision,
        # not a fix.
        assert len(tools_for(surface)) <= 36
        assert [s.wire_name for s in tools_for(surface)] == sorted(
            s.wire_name for s in tools_for(surface)
        )


def test_mcp_publishes_the_five_read_only_catalog_tools() -> None:
    assert {spec.wire_name for spec in MCP_TOOLS} == {
        "catalog_search",
        "catalog_describe",
        "catalog_get_record",
        "catalog_suggest_terms",
        "catalog_find_region",
    }
    assert all(spec.risk == "read" and not spec.returns_data for spec in MCP_TOOLS)


#: The write tools (spec 2026-10-17 §3): they create, run a workflow or change
#: one; none deletes what exists, beyond a step removed in a workflow edit.
WRITE_TOOLS = {
    "project_add_catalog_layer",
    "project_add_dataset",
    "workflow_create",
    "workflow_create_from_template",
    "workflow_run",
    "workflow_update",
}


def test_risk_classes() -> None:
    for spec in ALL_TOOLS:
        if spec.wire_name in WRITE_TOOLS:
            assert (spec.risk, spec.scope) == ("write", "goat:write"), spec.wire_name
        else:
            assert spec.risk == ("propose" if "propose" in spec.name else "read")
            assert spec.scope == "goat:read"


def test_write_tools_take_no_project_id() -> None:
    """The project a write goes into is the page's: no argument can name another."""
    writes = [spec for spec in ALL_TOOLS if spec.risk == "write"]
    assert {spec.wire_name for spec in writes} == WRITE_TOOLS
    for spec in writes:
        names = {name for name, _ in _walk(spec.json_schema())}
        assert "project_id" not in names, spec.wire_name


def test_what_a_write_makes_stale_are_tools_whose_results_repeat() -> None:
    """A name in ``ToolSpec.invalidates`` that names no tool, or one whose
    repeated call runs again anyway, would silently keep a stale result: the
    reads of a workflow, and its run, whose repeat in an answer returns the
    earlier summary (``ToolSpec.repeatable``)."""
    named = {name for spec in ALL_TOOLS for name in spec.invalidates}
    assert named == {
        "workflow_get",
        "project_get_workflows",
        "workflow_run",
        "workflow_last_run",
    }
    for name in named:
        spec = BY_WIRE_NAME[name]
        assert spec.risk == "read" or spec.repeatable is not None, name


def test_every_data_tool_has_a_restricted_form() -> None:
    for spec in ALL_TOOLS:
        if spec.returns_data:
            assert hasattr(spec.output_model, "restricted"), spec.wire_name


def test_no_tool_can_send_data_out() -> None:
    """Spec §8.3: no tool takes a URL, so none can fetch or send anywhere."""
    for spec in ALL_TOOLS:
        for name, sub in _walk(spec.json_schema()):
            assert name.lower() not in _URLISH, f"{spec.wire_name}.{name}"
            assert sub.get("format") not in ("uri", "url"), f"{spec.wire_name}.{name}"


def test_no_tool_takes_a_layer_uuid() -> None:
    """Review Focus 1: layers are named by (project_id, layer_project_id) only."""
    for spec in ALL_TOOLS:
        assert "layer_id" not in {
            name for name, _ in _walk(spec.json_schema())
        }, spec.wire_name


def _deps(page: Any, transport: Any = None) -> RunDeps:
    async def emit(event: Any) -> None:
        return None

    return RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(catalog=transport), page=page),
        prompt_note=render_note(page, None, "de"),
    )


async def test_the_model_sees_fixed_instructions_the_tools_in_order_and_the_note_in_the_message() -> (
    None
):
    from assistant.prompt import with_note

    script = ScriptedModel()
    agent = build_agent(script.model)
    page = parse_context({"surface": "catalog", "q": "rad"})
    deps = _deps(page)
    await agent.run(with_note(deps.prompt_note, "hi"), deps=deps)
    await agent.run(with_note(deps.prompt_note, "hi again"), deps=deps)
    first, second = script.infos
    names = [tool.name for tool in first.function_tools]
    assert names == [spec.wire_name for spec in tools_for("catalog")]
    assert names == [tool.name for tool in second.function_tools]
    # Only the fixed instructions, identical in every request: the cached prefix.
    for info in (first, second):
        parts = info.model_request_parameters.instruction_parts or []
        # The skills index follows the instructions in the same cached part.
        assert [(p.content, p.dynamic) for p in parts] == [
            (f"{INSTRUCTIONS}\n\n{SKILLS_INDEX}", False)
        ]
    # The note leads the user message.
    note = script.note(0)
    assert note.startswith("<goat-note>\nInterface language: German")
    assert "Answer in the language of the user's newest message" in INSTRUCTIONS


def test_the_instructions_and_page_notes_name_only_tools_that_exist() -> None:
    """A renamed or removed tool must not linger in the prompt: a model told to
    call a tool it doesn't have improvises with the others."""
    from assistant.prompt import (
        _DOCUMENT_LIMITS,
        _NO_PROJECT,
        _OPEN_PROJECT,
        _WORKFLOWS_PAGE_LIMITS,
    )

    text = " ".join(
        (
            INSTRUCTIONS,
            _DOCUMENT_LIMITS,
            _WORKFLOWS_PAGE_LIMITS,
            _NO_PROJECT,
            _OPEN_PROJECT,
        )
    )
    # project_id is an argument, not a tool.
    named = set(
        re.findall(r"\b(?:catalog|core|project|workflow|ask|skills)_[a-z_]+\b", text)
    ) - {"project_id"}
    assert named, "the prompt names tools"
    assert named <= set(BY_WIRE_NAME), named - set(BY_WIRE_NAME)


async def test_without_a_tool_env_no_goat_tools_are_offered() -> None:
    script = ScriptedModel()

    async def emit(event: Any) -> None:
        return None

    await build_agent(script.model).run("hi", deps=RunDeps(message_id="m1", emit=emit))
    assert script.infos[0].function_tools == []


async def test_invalid_arguments_go_back_to_the_model(
    catalog_transport: RecordingTransport,
) -> None:
    script = ScriptedModel([("catalog_suggest_terms", {})])
    await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    retry = [
        part
        for message in script.requests[1]
        for part in getattr(message, "parts", [])
        if isinstance(part, RetryPromptPart)
    ]
    assert retry and "prefix" in str(retry[0].content)
    assert catalog_transport.requests == []


async def test_repeated_invalid_arguments_fail_the_call_not_the_run(
    catalog_transport: RecordingTransport,
) -> None:
    """Decision T22: after the last retry the call fails and the model goes on."""
    script = ScriptedModel(
        [("catalog_suggest_terms", {})] * 4, answer="I could not check that word."
    )
    result = await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    assert result.output == "I could not check that word."
    last_request = script.requests[-1]
    texts = [
        str(getattr(part, "content", ""))
        for message in last_request
        for part in getattr(message, "parts", [])
    ]
    assert any("Gave up after 4 invalid calls" in text for text in texts)
    assert catalog_transport.requests == []


async def test_a_tool_call_runs_through_execute(
    catalog_transport: RecordingTransport,
) -> None:
    script = ScriptedModel([("catalog_suggest_terms", {"prefix": "radver"})])
    await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    assert [r.url.path for r in catalog_transport.requests] == ["/stac/suggest"]


async def test_an_argument_named_ctx_reaches_execute(
    catalog_transport: RecordingTransport,
) -> None:
    script = ScriptedModel([("catalog_suggest_terms", {"ctx": 1, "prefix": "rad"})])
    result = await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    assert result.output == "done"
    retry = _retries(script)
    assert retry and "ctx" in str(retry[0].content)
    assert catalog_transport.requests == []


async def test_a_tool_of_another_surface_does_not_end_the_run(
    catalog_transport: RecordingTransport,
) -> None:
    """History from another page can name tools this page does not offer."""
    script = ScriptedModel([("map_propose_view", {})] * 2, answer="ok")
    result = await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    assert result.output == "ok"


async def test_arguments_that_are_not_an_object_go_back_to_the_model(
    catalog_transport: RecordingTransport,
) -> None:
    script = ScriptedModel([("catalog_suggest_terms", "[1, 2]")], answer="fixed")
    result = await build_agent(script.model).run(
        "hi", deps=_deps(parse_context({"surface": "catalog"}), catalog_transport)
    )
    assert result.output == "fixed"
    retry = _retries(script)
    assert retry and "JSON object" in str(retry[0].content)
    assert catalog_transport.requests == []


async def test_a_repeated_read_call_gets_the_earlier_result(
    catalog_transport: RecordingTransport,
) -> None:
    """The same question again, defaults spelled out or not, is answered from
    the first call: one request, and the model is told it repeated itself."""
    script = ScriptedModel(
        [
            ("catalog_suggest_terms", {"prefix": "radver"}),
            ("catalog_suggest_terms", {"prefix": "radver", "limit": 10}),
            ("catalog_suggest_terms", {"prefix": "radver", "limit": 3}),
        ]
    )
    deps = _deps(parse_context({"surface": "catalog"}), catalog_transport)
    await build_agent(script.model).run("hi", deps=deps)
    assert [r.url.path for r in catalog_transport.requests] == ["/stac/suggest"] * 2
    first, repeated, other = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert repeated == {**first, "repeated_call": REPEATED_CALL}
    assert "repeated_call" not in first and "repeated_call" not in other


def test_proposals_and_cards_are_never_answered_from_an_earlier_call() -> None:
    from assistant.tools.toolset import _call_key

    shown = BY_WIRE_NAME["core_show_items"]
    proposal = BY_WIRE_NAME["map_propose_view"]
    assert proposal.risk == "propose"
    assert _call_key(proposal, {"title": "Munich", "center": [11.5, 48.1]}) is None
    assert (
        _call_key(shown, {"groups": [{"items": [{"kind": "project", "id": "p"}]}]})
        is None
    )
    assert _call_key(BY_WIRE_NAME["catalog_suggest_terms"], {"prefix": 1}) is None


def _retries(script: ScriptedModel) -> list[RetryPromptPart]:
    return [
        part
        for message in script.requests[1]
        for part in getattr(message, "parts", [])
        if isinstance(part, RetryPromptPart)
    ]
