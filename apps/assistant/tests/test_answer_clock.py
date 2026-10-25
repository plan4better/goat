"""The answer's one clock (spec 2026-10-23 §5): a waiting run moves the
answer's deadline to the wait limit from its start, never earlier."""

import asyncio
from typing import Any
from uuid import UUID

import pytest
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import Agent
from pydantic_ai.toolsets import FunctionToolset

from assistant.agent import RunDeps
from assistant.bus import InMemoryEventBus
from assistant.clock import AnswerClock
from assistant.config import AssistantSettings
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.surfaces import SURFACES
from assistant.tools.runtime import ToolEnv, ToolSpec
from assistant.tools.testing import ScriptedModel, fake_clients
from assistant.tools.toolset import _tool

USER = UUID(int=1)


async def test_extend_lets_the_answer_outlast_its_first_deadline() -> None:
    clock = AnswerClock(wait_max_seconds=0.4)
    async with asyncio.timeout(0.1) as deadline:
        clock.timeout = deadline
        clock.extend()
        await asyncio.sleep(0.2)


async def test_the_extended_deadline_still_ends_the_answer() -> None:
    clock = AnswerClock(wait_max_seconds=0.2)
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.1) as deadline:
            clock.timeout = deadline
            clock.extend()
            await asyncio.sleep(0.6)


async def test_extend_never_moves_the_deadline_earlier() -> None:
    clock = AnswerClock(wait_max_seconds=0.05)
    async with asyncio.timeout(0.5) as deadline:
        clock.timeout = deadline
        before = deadline.when()
        clock.extend()
        assert deadline.when() == before


async def test_remaining_counts_down_and_is_none_without_a_deadline() -> None:
    clock = AnswerClock(wait_max_seconds=1)
    assert clock.remaining() is None
    async with asyncio.timeout(0.5) as deadline:
        clock.timeout = deadline
        remaining = clock.remaining()
        assert remaining is not None and 0 < remaining <= 0.5


class _WaitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    extend: bool = Field(description="Whether to extend the answer's deadline.")


class _Waited(BaseModel):
    waited: bool = True


async def _wait_a_while(env: ToolEnv, args: _WaitIn) -> _Waited:
    if args.extend:
        assert env.clock is not None
        env.clock.extend()
    await asyncio.sleep(4.5)
    return _Waited()


WAIT = ToolSpec(
    name="core.wait_a_while",
    description="Waits, for the clock's tests.",
    input_model=_WaitIn,
    output_model=_Waited,
    run=_wait_a_while,
    surfaces=frozenset(SURFACES),
    returns_data=False,
)


async def _run(
    repo: Repository, settings: AssistantSettings, extend: bool
) -> dict[str, Any]:
    script = ScriptedModel([("core_wait_a_while", {"extend": extend})], answer="ok")

    def factory(_: Any) -> Agent[RunDeps, str]:
        return Agent(
            script.model,
            deps_type=RunDeps,
            toolsets=[FunctionToolset([_tool(WAIT)], max_retries=3)],
        )

    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings.model_copy(update={"run_max_seconds": 3, "run_wait_max_seconds": 9}),
        owner="a",
        agent_factory=factory,
        tool_services=fake_clients(),
    )
    conversation = UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )
    run_id, _ = await manager.start_run(conversation, USER, "wait", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None
    return run


async def test_a_tool_that_extends_the_clock_outlasts_run_max_seconds(
    repo: Repository, settings: AssistantSettings
) -> None:
    run = await _run(repo, settings, extend=True)
    assert run["status"] == "succeeded"


async def test_without_extending_the_answer_ends_at_run_max_seconds(
    repo: Repository, settings: AssistantSettings
) -> None:
    run = await _run(repo, settings, extend=False)
    assert run["status"] == "failed"
    assert run["error"] == "The run took longer than allowed."
