"""Write tools (spec §3): one key per call however the result is kept, the
first result again for a repeat anywhere in the conversation, and the audit
of what was created."""

import asyncio
import dataclasses
from collections.abc import Callable
from typing import Any, get_args
from uuid import UUID

import httpx
import pytest
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from assistant.agent import RunDeps
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.db import Database
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.surfaces import SURFACES
from assistant.tools import toolset
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.runtime import InputInvalid, Risk, ToolEnv, ToolSpec, execute
from assistant.tools.testing import (
    Recorder,
    ScriptedModel,
    TurnModel,
    fake_clients,
    tool_env,
)
from assistant.tools.toolset import REPEATED_WRITE, _call_key, _tool, earlier_writes

USER = UUID(int=1)


class CreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="The thing's name.")
    size: int = Field(default=1, description="Its size.")


class Created(BaseModel):
    id: str
    name: str

    def created(self) -> dict[str, Any]:
        return {"kind": "thing", "ids": [self.id], "project_id": "p1"}


async def _create(env: ToolEnv, args: CreateIn) -> Created:
    row = await env.call(
        "core", "POST", "/api/v2/things", json_body={"name": args.name}
    )
    return Created(id=str(row["id"]), name=args.name)


CREATE_THING: ToolSpec[CreateIn, Created] = ToolSpec(
    name="workflow.create_thing",
    description="Create a thing, for the tests of write tools.",
    input_model=CreateIn,
    output_model=Created,
    run=_create,
    surfaces=frozenset(SURFACES),
    returns_data=False,
    risk="write",
    scope="goat:write",
)


async def _create_slowly(env: ToolEnv, args: CreateIn) -> Created:
    # A real service takes a while: two calls run together overlap here.
    await asyncio.sleep(0.05)
    return await _create(env, args)


SLOW_CREATE_THING = dataclasses.replace(CREATE_THING, run=_create_slowly)


def _things() -> Recorder:
    recorder = Recorder()

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"id": f"t{len(recorder.requests)}"})

    recorder.routes[("POST", "/api/v2/things")] = answer
    return recorder


def _agent(
    model: Model, spec: ToolSpec[CreateIn, Created] = CREATE_THING
) -> Agent[RunDeps, str]:
    return Agent(
        model,
        deps_type=RunDeps,
        toolsets=[FunctionToolset([_tool(spec)], max_retries=3)],
    )


def _tool_part(
    name: str, args: dict[str, Any], output: Any, state: str = "output"
) -> dict[str, Any]:
    return {
        "type": "tool",
        "tool_call_id": f"c-{name}-{len(str(output))}",
        "tool_name": name,
        "args": args,
        "state": state,
        "output": output,
        "error": None,
    }


def test_the_risk_classes_include_write() -> None:
    assert get_args(Risk) == ("read", "propose", "write")


def test_a_write_call_has_a_key_even_when_its_result_is_kept_as_a_card(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        toolset, "SHOWN_TOOLS", toolset.SHOWN_TOOLS | {"workflow_create_thing"}
    )
    assert _call_key(CREATE_THING, {"name": "A"}) == _call_key(
        CREATE_THING, {"name": "A", "size": 1}
    )
    assert _call_key(CREATE_THING, {"name": "A"}) is not None
    assert _call_key(CREATE_THING, {"name": 3}) is None
    assert _call_key(BY_WIRE_NAME["map_propose_view"], {}) is None


def test_earlier_writes_keep_the_first_result_of_each_write_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        toolset, "BY_WIRE_NAME", {**BY_WIRE_NAME, "workflow_create_thing": CREATE_THING}
    )
    first = {"id": "t1", "name": "A"}
    messages = [
        {"role": "user", "parts": [{"type": "user_text", "text": "make A"}]},
        {
            "role": "assistant",
            "parts": [
                _tool_part("workflow_create_thing", {"name": "A"}, first),
                _tool_part("workflow_create_thing", {"name": "B"}, None, state="error"),
                _tool_part("core_whoami", {}, {"name": "me"}),
            ],
        },
        {
            "role": "assistant",
            "parts": [
                _tool_part(
                    "workflow_create_thing",
                    {"name": "A", "size": 1},
                    {**first, "repeated_call": REPEATED_WRITE},
                )
            ],
        },
    ]
    key = _call_key(CREATE_THING, {"name": "A"})
    assert earlier_writes(messages) == {key: first}


def test_a_repeated_write_says_how_to_have_a_removed_result_again() -> None:
    """The first result comes back also when the user has removed what it
    created since; the note says how to have it again: a dataset by hand, a
    workflow under a changed name (a new call)."""
    note = " ".join(REPEATED_WRITE.split())
    assert "removed" in note
    assert "by hand" in note and "Add to project" in note
    assert "changed name" in note
    assert "—" not in note and "–" not in note


async def test_a_repeated_write_in_one_answer_creates_once() -> None:
    things = _things()
    script = ScriptedModel(
        [
            ("workflow_create_thing", {"name": "A"}),
            ("workflow_create_thing", {"name": "A", "size": 1}),
        ]
    )

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=tool_env(fake_clients(core=things)))
    await _agent(script.model).run("make A", deps=deps)
    assert things.paths() == ["/api/v2/things"]
    first, repeated = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert repeated == {**first, "repeated_call": REPEATED_WRITE}


async def test_two_identical_writes_in_one_response_create_once() -> None:
    """Review Focus 1: the calls of one response run concurrently; a write
    runs alone, so its twin finds the first result instead of creating."""
    things = _things()

    def both_at_once(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if any(isinstance(message, ModelResponse) for message in messages):
            return ModelResponse(parts=[TextPart(content="done")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="workflow_create_thing",
                    args={"name": "A"},
                    tool_call_id=f"call-{n}",
                )
                for n in (1, 2)
            ]
        )

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=tool_env(fake_clients(core=things)))
    result = await _agent(FunctionModel(both_at_once), SLOW_CREATE_THING).run(
        "make A", deps=deps
    )
    assert things.paths() == ["/api/v2/things"]
    returned = {
        part.tool_call_id: part.content
        for message in result.all_messages()
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    }
    assert returned == {
        "call-1": {"id": "t1", "name": "A"},
        "call-2": {"id": "t1", "name": "A", "repeated_call": REPEATED_WRITE},
    }


def _factory(model: TurnModel) -> Callable[[Model | str], Agent[RunDeps, str]]:
    def factory(_: Model | str) -> Agent[RunDeps, str]:
        return _agent(model.model)

    return factory


async def test_a_write_repeated_in_a_later_answer_returns_the_first_result(
    repo: Repository,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review Focus 1: "try again" in a later answer creates nothing twice."""
    monkeypatch.setattr(
        toolset, "BY_WIRE_NAME", {**BY_WIRE_NAME, "workflow_create_thing": CREATE_THING}
    )
    things = _things()
    model = TurnModel(
        [
            ([("workflow_create_thing", {"name": "A"})], "Created A."),
            ([("workflow_create_thing", {"name": "A", "size": 1})], "A exists."),
        ]
    )
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=_factory(model),
        tool_services=fake_clients(core=things),
    )
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    conversation_id = UUID(str(conversation["id"]))
    page = parse_context(
        {
            "surface": "project.workflows",
            "project_id": "00000000-0000-0000-0000-0000000005e4",
        }
    )
    for text in ("make A", "try again"):
        run_id, _ = await manager.start_run(conversation_id, USER, text, page)
        await manager.wait(run_id)
    assert things.paths() == ["/api/v2/things"]
    messages = await repo.list_messages(conversation_id, None)
    outputs = [
        part["output"]
        for message in messages
        for part in message["parts"]
        if part.get("type") == "tool"
    ]
    assert outputs == [
        {"id": "t1", "name": "A"},
        {"id": "t1", "name": "A", "repeated_call": REPEATED_WRITE},
    ]


async def test_the_audit_records_what_a_write_created(
    repo: Repository, db: Database
) -> None:
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    run_id, _ = await repo.begin_run(
        UUID(str(conversation["id"])),
        USER,
        [{"type": "user_text", "text": "make A"}],
        "test",
        "test",
        3,
    )
    env = tool_env(fake_clients(core=_things()), repo=repo, run_id=run_id)
    await execute(CREATE_THING, env, {"name": "A"}, tool_call_id="c1")
    # A call that creates nothing: no skill of that name.
    with pytest.raises(InputInvalid):
        await execute(
            BY_WIRE_NAME["skills_load"], env, {"name": "none"}, tool_call_id="c2"
        )
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT tool, status, created FROM {db.t('tool_call')} ORDER BY created_at"
        )
    assert [dict(row) for row in rows] == [
        {
            "tool": "workflow_create_thing",
            "status": "ok",
            "created": {"kind": "thing", "ids": ["t1"], "project_id": "p1"},
        },
        {"tool": "skills_load", "status": "invalid", "created": None},
    ]


class CreatedUnreadably(Created):
    def created(self) -> dict[str, Any]:
        raise KeyError("ids")


async def _create_unreadably(env: ToolEnv, args: CreateIn) -> CreatedUnreadably:
    made = await _create(env, args)
    return CreatedUnreadably(id=made.id, name=made.name)


async def test_a_write_whose_created_fails_still_returns_its_result(
    repo: Repository, db: Database, caplog: pytest.LogCaptureFixture
) -> None:
    """The thing exists: the model must see it, so only the audit row goes
    without what was created."""
    spec = dataclasses.replace(
        CREATE_THING,
        output_model=CreatedUnreadably,
        run=_create_unreadably,
    )
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    run_id, _ = await repo.begin_run(
        UUID(str(conversation["id"])),
        USER,
        [{"type": "user_text", "text": "make A"}],
        "test",
        "test",
        3,
    )
    env = tool_env(fake_clients(core=_things()), repo=repo, run_id=run_id)
    result = await execute(spec, env, {"name": "A"}, tool_call_id="c1")
    assert result == {"id": "t1", "name": "A"}
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT tool, status, created FROM {db.t('tool_call')}"
        )
    assert [dict(row) for row in rows] == [
        {"tool": "workflow_create_thing", "status": "ok", "created": None}
    ]
    assert "workflow_create_thing" in caplog.text


RUN_THING = dataclasses.replace(
    CREATE_THING,
    name="workflow.run_thing",
    repeatable="You ran this earlier in this answer; this is its result again.",
)


def test_earlier_writes_leave_out_repeatable_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run repeated in a later answer runs again: its first result is not
    carried into later answers."""
    monkeypatch.setattr(
        toolset, "BY_WIRE_NAME", {**BY_WIRE_NAME, "workflow_run_thing": RUN_THING}
    )
    messages = [
        {
            "role": "assistant",
            "parts": [
                _tool_part(
                    "workflow_run_thing", {"name": "A"}, {"id": "t1", "name": "A"}
                )
            ],
        }
    ]
    assert earlier_writes(messages) == {}


async def test_a_repeatable_write_repeated_in_one_answer_runs_once_with_its_note() -> (
    None
):
    things = _things()
    script = ScriptedModel(
        [("workflow_run_thing", {"name": "A"}), ("workflow_run_thing", {"name": "A"})]
    )

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=tool_env(fake_clients(core=things)))
    await _agent(script.model, RUN_THING).run("run A", deps=deps)
    assert things.paths() == ["/api/v2/things"]
    first, repeated = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert repeated == {**first, "repeated_call": RUN_THING.repeatable}
