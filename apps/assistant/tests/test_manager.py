import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel

from assistant.agent import INSTRUCTIONS, RunDeps
from assistant.bus import EventBus, InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.events import (
    RunEnded,
    RunEvent,
    RunStarted,
    TextDelta,
    ToolCalled,
    ToolReturned,
)
from assistant.llm.providers import default_target
from assistant.llm.resolution import Resolution
from assistant.repo import (
    ConversationBusy,
    ConversationNotFound,
    Repository,
    UserRunLimit,
)
from assistant.runs import manager as manager_module
from assistant.runs.manager import RunManager, _Emitter, _partial_history

USER = UUID(int=1)


def _gated_agent(gate: asyncio.Event) -> Agent[RunDeps, str]:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield "first "
        await gate.wait()
        yield "second"

    return Agent(
        FunctionModel(stream_function=stream),
        deps_type=RunDeps,
        instructions=INSTRUCTIONS,
    )


def _one_tool_agent(model: Any) -> Agent[RunDeps, str]:
    """An agent whose TestModel calls its one tool: enough to hit a tool-call limit."""
    agent: Agent[RunDeps, str] = Agent(
        TestModel(), deps_type=RunDeps, instructions=INSTRUCTIONS
    )

    @agent.tool(name="ping")
    async def ping(ctx: RunContext[RunDeps], /) -> str:
        return "pong"

    return agent


async def _conversation(repo: Repository) -> UUID:
    return UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )


async def test_run_succeeds_folds_and_records_usage(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    conversation_id = await _conversation(repo)
    run_id, message_id = await manager.start_run(conversation_id, USER, "hello", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "succeeded"
    events = [e for _, e in await repo.list_events(run_id)]
    # The start names the run, for the dock's Undo of the live answer.
    start = events[0]
    assert isinstance(start, RunStarted)
    assert (start.message_id, start.run_id) == (str(message_id), str(run_id))
    assert events[-1] == RunEnded(status="succeeded")
    messages = await repo.list_messages(conversation_id, exclude_message_id=None)
    assert messages[-1]["id"] == message_id
    assert any(p["type"] == "text" for p in messages[-1]["parts"])
    assert await repo.history(
        conversation_id
    )  # model messages stored for the next turn
    async with repo.db.pool.acquire() as conn:
        assert (
            await conn.fetchval(
                f"SELECT count(*) FROM {repo.db.t('usage')} WHERE purpose = 'main'"
            )
            == 1
        )


async def test_second_run_in_conversation_is_refused(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    conversation_id = await _conversation(repo)
    run_id, _ = await manager.start_run(conversation_id, USER, "one", None)
    with pytest.raises(ConversationBusy):
        await manager.start_run(conversation_id, USER, "two", None)
    gate.set()
    await manager.wait(run_id)


async def test_user_run_limit_and_unknown_conversation_propagate(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    limited = settings.model_copy(update={"user_max_concurrent_runs": 1})
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        limited,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "one", None)
    with pytest.raises(UserRunLimit):
        await manager.start_run(await _conversation(repo), USER, "two", None)
    with pytest.raises(ConversationNotFound):
        await manager.start_run(UUID(int=99), USER, "three", None)
    gate.set()
    await manager.wait(run_id)


async def test_cancel_ends_the_run_as_cancelled(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(lambda: _has_text(repo, run_id))
    await manager.cancel(run_id)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "cancelled"
    events = [e for _, e in await repo.list_events(run_id)]
    assert events[-1] == RunEnded(status="cancelled")


async def test_cancel_from_other_replica(
    repo: Repository, settings: AssistantSettings
) -> None:
    bus = InMemoryEventBus()
    gate = asyncio.Event()
    owner = RunManager(
        repo, bus, settings, owner="a", agent_factory=lambda _: _gated_agent(gate)
    )
    other = RunManager(repo, bus, settings, owner="b")
    await owner.start()
    await other.start()
    try:
        run_id, _ = await owner.start_run(await _conversation(repo), USER, "go", None)
        await _until(lambda: _has_text(repo, run_id))
        await other.cancel(run_id)  # not running here: goes through the control channel
        await owner.wait(run_id)
        run = await repo.get_run(run_id)
        assert run is not None and run["status"] == "cancelled"
    finally:
        await owner.stop()
        await other.stop()


async def test_sweep_marks_interrupted(
    repo: Repository, settings: AssistantSettings
) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [], "test", "test", 3
    )
    await repo.mark_running(
        run_id, "dead-replica", datetime.now(timezone.utc) - timedelta(seconds=1)
    )
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    assert await manager.sweep_once() == 1
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    events = [e for _, e in await repo.list_events(run_id)]
    assert events[-1] == RunEnded(status="interrupted")
    assert (
        await repo.active_run(conversation_id) is None
    )  # the conversation accepts new messages
    assert await manager.sweep_once() == 0  # nothing left to end


async def test_sweep_ends_stale_queued_run_with_a_single_event(
    repo: Repository, settings: AssistantSettings
) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    await _age_run(repo, run_id)
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    assert await manager.sweep_once() == 1
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    assert await repo.list_events(run_id) == [(1, RunEnded(status="interrupted"))]


async def test_execute_stops_when_the_run_was_swept_before_it_started(
    repo: Repository, settings: AssistantSettings
) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [], "test", "test", 3
    )
    await _age_run(repo, run_id)
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    assert await manager.sweep_once() == 1
    goat_ai = default_target(settings)
    assert goat_ai is not None
    resolution = Resolution(
        organization_id=UUID(int=100),
        data_policy="standard",
        main=goat_ai,
        fallback=None,
    )
    await manager._execute(
        run_id, conversation_id, message_id, USER, "late", resolution
    )
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    assert await repo.list_events(run_id) == [(1, RunEnded(status="interrupted"))]
    async with repo.db.pool.acquire() as conn:
        assert await conn.fetchval(f"SELECT count(*) FROM {repo.db.t('usage')}") == 0


async def test_run_swept_while_owner_is_running_ends_once(
    repo: Repository, settings: AssistantSettings, caplog: pytest.LogCaptureFixture
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    conversation_id = await _conversation(repo)
    run_id, message_id = await manager.start_run(conversation_id, USER, "go", None)
    await _until(lambda: _has_text(repo, run_id))
    await _expire_lease(repo, run_id)
    assert await manager.sweep_once() == 1
    with caplog.at_level(logging.INFO, logger="assistant.runs.manager"):
        gate.set()
        await manager.wait(run_id)  # the owner's finish_run lost the compare-and-set
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    events = [e for _, e in await repo.list_events(run_id)]
    assert sum(isinstance(e, RunEnded) for e in events) == 1
    assert events[-1] == RunEnded(status="interrupted")
    messages = await repo.list_messages(conversation_id, exclude_message_id=None)
    assert messages[-1]["id"] == message_id
    # The owner's next event collided with the sweeper's RunEnded on the seq key.
    # The failure is logged with its (credential-masked) traceback appended.
    messages_logged = [(r.levelno, r.getMessage()) for r in caplog.records]
    assert any(
        level == logging.ERROR and message.startswith(f"Run {run_id} failed\n")
        for level, message in messages_logged
    )
    assert (
        logging.INFO,
        f"Run {run_id} was already ended by another party",
    ) in messages_logged


async def test_run_swept_while_owner_is_running_stops_at_the_next_heartbeat(
    repo: Repository, settings: AssistantSettings, caplog: pytest.LogCaptureFixture
) -> None:
    gate = asyncio.Event()  # never set: only the lost lease can end the owner
    fast = settings.model_copy(update={"lease_heartbeat_seconds": 1})
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        fast,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(lambda: _has_text(repo, run_id))
    await _expire_lease(repo, run_id)
    with caplog.at_level(logging.INFO, logger="assistant.runs.manager"):
        assert await manager.sweep_once() == 1
        await asyncio.wait_for(manager.wait(run_id), timeout=5)
    assert not gate.is_set()
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    events = [e for _, e in await repo.list_events(run_id)]
    assert sum(isinstance(e, RunEnded) for e in events) == 1
    assert events[-1] == RunEnded(status="interrupted")
    messages_logged = [r.getMessage() for r in caplog.records]
    assert f"Run {run_id} lost its lease; cancelling it here" in messages_logged
    assert f"Run {run_id} was already ended by another party" in messages_logged


async def test_sweep_retries_when_a_live_owner_takes_the_next_seq(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id, _ = await repo.begin_run(
        await _conversation(repo), USER, [], "test", "test", 3
    )
    await _age_run(repo, run_id)
    original = repo.next_seq
    calls = 0

    async def racing_next_seq(rid: UUID) -> int:
        nonlocal calls
        calls += 1
        seq = await original(rid)
        if calls == 1:  # a live owner inserts at the number the sweeper just read
            await repo.append_event(rid, seq, TextDelta(part_id="p", delta="late"))
        return seq

    monkeypatch.setattr(repo, "next_seq", racing_next_seq)
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    assert await manager.sweep_once() == 1
    assert calls == 2
    events = [e for _, e in await repo.list_events(run_id)]
    assert events == [
        TextDelta(part_id="p", delta="late"),
        RunEnded(status="interrupted"),
    ]


async def test_sweep_logs_an_error_when_the_end_cannot_be_recorded(
    repo: Repository,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    run_id, _ = await repo.begin_run(
        await _conversation(repo), USER, [], "test", "test", 3
    )
    await _age_run(repo, run_id)
    await repo.append_event(run_id, 1, TextDelta(part_id="p", delta="taken"))

    async def always_taken(rid: UUID) -> int:
        return 1

    monkeypatch.setattr(repo, "next_seq", always_taken)
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    with caplog.at_level(logging.ERROR, logger="assistant.runs.manager"):
        assert await manager.sweep_once() == 1
    assert f"Run {run_id} was swept but its RunEnded event could not be recorded" in [
        r.getMessage() for r in caplog.records
    ]


async def test_cancel_right_after_start_run_is_recorded_as_cancelled(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await manager.cancel(run_id)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "cancelled"
    events = [e for _, e in await repo.list_events(run_id)]
    assert events[-1] == RunEnded(status="cancelled")


async def test_start_run_is_refused_while_stopping(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    await manager.stop()
    with pytest.raises(RuntimeError):
        await manager.start_run(await _conversation(repo), USER, "late", None)


async def test_start_run_does_not_hang_when_the_task_is_cancelled_before_it_starts(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    real_create_task = asyncio.create_task

    def cancelling_create_task(coro: Any, **kwargs: Any) -> asyncio.Task[Any]:
        task = real_create_task(coro, **kwargs)
        if "_execute" in getattr(coro, "__qualname__", ""):
            task.cancel()  # before its first step: the body never runs
        return task

    monkeypatch.setattr(manager_module.asyncio, "create_task", cancelling_create_task)
    conversation_id = await _conversation(repo)
    with pytest.raises(RuntimeError, match="shutting down"):
        await asyncio.wait_for(manager.start_run(conversation_id, USER, "go", None), 2)
    monkeypatch.undo()
    run = await _only_run(repo, conversation_id)
    assert run["status"] == "interrupted"
    assert await repo.list_events(run["id"]) == [(1, RunEnded(status="interrupted"))]
    assert await repo.active_run(conversation_id) is None


async def test_start_run_ends_the_run_when_stop_began_during_begin_run(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    real_begin_run = repo.begin_run

    class _StoppingRepo:
        def __getattr__(self, name: str) -> Any:
            return getattr(repo, name)

        async def begin_run(self, *args: Any, **kwargs: Any) -> tuple[UUID, UUID]:
            result = await real_begin_run(*args, **kwargs)
            manager._stopping = True
            return result

    manager.repo = _StoppingRepo()  # type: ignore[assignment]
    conversation_id = await _conversation(repo)
    with pytest.raises(RuntimeError, match="shutting down"):
        await manager.start_run(conversation_id, USER, "go", None)
    run = await _only_run(repo, conversation_id)
    assert run["status"] == "interrupted"
    assert await repo.list_events(run["id"]) == [(1, RunEnded(status="interrupted"))]
    assert manager._tasks == {}


async def test_run_timeout_is_reported_as_too_long(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    short = settings.model_copy(update={"run_max_seconds": 0})
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        short,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "failed"
    assert run["error"] == "The run took longer than allowed."


async def test_other_timeouts_are_generic_failures(
    repo: Repository, settings: AssistantSettings, caplog: pytest.LogCaptureFixture
) -> None:
    def broken_factory(_: str) -> Agent[RunDeps, str]:
        raise TimeoutError("upstream timed out")

    manager = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=broken_factory
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    with caplog.at_level(logging.ERROR, logger="assistant.runs.manager"):
        await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "failed"
    assert run["error"] == "The assistant failed unexpectedly."
    assert any(
        r.getMessage().startswith(f"Run {run_id} failed with a timeout\n")
        for r in caplog.records
    )


class _FlakyBus:
    """Delegates to an in-memory bus, but the first subscription breaks once it
    is being read."""

    def __init__(self) -> None:
        self.inner = InMemoryEventBus()
        self.subscribe_calls = 0

    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        await self.inner.publish(channel, message)

    def subscribe(
        self, channel: str
    ) -> AbstractAsyncContextManager[AsyncIterator[dict[str, Any]]]:
        self.subscribe_calls += 1
        if self.subscribe_calls > 1:
            return self.inner.subscribe(channel)

        @asynccontextmanager
        async def broken() -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
            async def messages() -> AsyncIterator[dict[str, Any]]:
                raise ConnectionError("subscription lost")
                yield {}

            yield messages()

        return broken()

    async def close(self) -> None:
        await self.inner.close()


async def test_control_listener_resubscribes_after_a_broken_subscription(
    repo: Repository,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(manager_module, "CONTROL_RESUBSCRIBE_DELAY", 0.01)
    flaky = _FlakyBus()
    bus: EventBus = flaky  # type: ignore[assignment]
    gate = asyncio.Event()
    owner = RunManager(
        repo, bus, settings, owner="a", agent_factory=lambda _: _gated_agent(gate)
    )
    other = RunManager(repo, flaky.inner, settings, owner="b")
    with caplog.at_level(logging.WARNING, logger="assistant.runs.manager"):
        await owner.start()
        await other.start()
        try:
            await _until(_calls_at_least(flaky, 2))
            run_id, _ = await owner.start_run(
                await _conversation(repo), USER, "go", None
            )
            await _until(lambda: _has_text(repo, run_id))
            await other.cancel(run_id)
            await owner.wait(run_id)
            run = await repo.get_run(run_id)
            assert run is not None and run["status"] == "cancelled"
        finally:
            await owner.stop()
            await other.stop()
    assert "The control subscription failed; resubscribing" in [
        r.getMessage() for r in caplog.records
    ]


async def test_stop_interrupts_local_runs(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    await manager.start()
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(lambda: _has_text(repo, run_id))
    await manager.stop()
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    events = [e for _, e in await repo.list_events(run_id)]
    assert events[-1] == RunEnded(status="interrupted")


async def test_tool_call_limit_fails_the_run(
    repo: Repository, settings: AssistantSettings
) -> None:
    limited = settings.model_copy(update={"run_max_tool_calls": 0})
    manager = RunManager(
        repo, InMemoryEventBus(), limited, owner="a", agent_factory=_one_tool_agent
    )
    run_id, _ = await manager.start_run(
        await _conversation(repo), USER, "propose", None
    )
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "failed"
    assert run["error"]


async def _only_run(repo: Repository, conversation_id: UUID) -> dict[str, Any]:
    async with repo.db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT * FROM {repo.db.t('run')} WHERE conversation_id = $1",
            conversation_id,
        )
    assert len(rows) == 1
    return dict(rows[0])


def _calls_at_least(bus: _FlakyBus, n: int) -> Callable[[], Awaitable[bool]]:
    async def check() -> bool:
        return bus.subscribe_calls >= n

    return check


async def _expire_lease(repo: Repository, run_id: UUID) -> None:
    async with repo.db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {repo.db.t('run')} SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
            run_id,
        )


async def _age_run(repo: Repository, run_id: UUID) -> None:
    async with repo.db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {repo.db.t('run')} SET created_at = now() - interval '10 minutes' WHERE id = $1",
            run_id,
        )


async def _has_text(repo: Repository, run_id: UUID) -> bool:
    return any(isinstance(e, TextDelta) for _, e in await repo.list_events(run_id))


async def _until(check: Callable[[], Awaitable[bool]], timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.02)


async def _usage_rows(repo: Repository, run_id: UUID) -> list[dict[str, Any]]:
    async with repo.db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT purpose, input_tokens, output_tokens FROM {repo.db.t('usage')} "
            "WHERE run_id = $1",
            run_id,
        )
    return [dict(r) for r in rows]


async def test_cancelled_run_records_usage_once(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(lambda: _has_text(repo, run_id))
    await manager.cancel(run_id)
    await manager.wait(run_id)
    rows = await _usage_rows(repo, run_id)
    assert len(rows) == 1
    assert rows[0]["purpose"] == "main"
    assert rows[0]["input_tokens"] > 0 or rows[0]["output_tokens"] > 0


async def test_run_over_a_limit_records_usage_once(
    repo: Repository, settings: AssistantSettings
) -> None:
    limited = settings.model_copy(update={"run_max_tokens": 1})
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        limited,
        owner="a",
        agent_factory=lambda _: _chatty_agent(),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "failed"
    assert "limit" in (run["error"] or "")
    rows = await _usage_rows(repo, run_id)
    assert len(rows) == 1
    assert rows[0]["input_tokens"] > 0 or rows[0]["output_tokens"] > 0


async def test_completed_run_still_records_usage_once(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "hi", None)
    await manager.wait(run_id)
    # The first run of a conversation also names it (purpose "background").
    rows = await _usage_rows(repo, run_id)
    assert [row["purpose"] for row in rows].count("main") == 1


def _chatty_agent() -> Agent[RunDeps, str]:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield "some words that cost tokens"

    return Agent(
        FunctionModel(stream_function=stream),
        deps_type=RunDeps,
        instructions=INSTRUCTIONS,
    )


async def test_cancelled_turn_stays_in_the_next_runs_history(
    repo: Repository, settings: AssistantSettings
) -> None:
    gate = asyncio.Event()
    conversation_id = await _conversation(repo)
    first = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: _gated_agent(gate),
    )
    run_id, _ = await first.start_run(conversation_id, USER, "first question", None)
    await _until(lambda: _has_text(repo, run_id))
    await first.cancel(run_id)
    await first.wait(run_id)

    seen: list[list[ModelMessage]] = []

    def factory(_: str) -> Agent[RunDeps, str]:
        async def stream(
            messages: list[ModelMessage], info: AgentInfo
        ) -> AsyncIterator[str | DeltaToolCalls]:
            seen.append(list(messages))
            yield "ok"

        return Agent(
            FunctionModel(stream_function=stream),
            deps_type=RunDeps,
            instructions=INSTRUCTIONS,
        )

    second = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=factory
    )
    second_id, _ = await second.start_run(conversation_id, USER, "follow up", None)
    await second.wait(second_id)
    assert len(seen) == 1
    history = seen[0]
    requests = [m for m in history if isinstance(m, ModelRequest)]
    assert [p.content for p in requests[0].parts if hasattr(p, "content")] == [
        "first question"
    ]
    responses = [m for m in history if isinstance(m, ModelResponse)]
    assert responses and isinstance(responses[0].parts[0], TextPart)
    assert responses[0].parts[0].content == "first "


def test_partial_history_omits_the_response_without_text() -> None:
    assert [m["kind"] for m in _partial_history("hello", [])] == ["request"]
    with_text = _partial_history(
        "hello",
        [TextDelta(part_id="p", delta="par"), TextDelta(part_id="p", delta="t")],
    )
    assert [m["kind"] for m in with_text] == ["request", "response"]
    assert with_text[1]["parts"][0]["content"] == "part"


def test_a_stopped_answer_keeps_what_it_showed_the_user() -> None:
    """A card, a created workflow: the next answer must see them, or an answer to
    the card points at nothing and the workflow is created again. Look-ups that
    showed nothing are left out, as the history shortens them anyway."""
    card = {"questions": [{"header": "Create", "question": "Create it?"}]}
    events: list[RunEvent] = [
        ToolCalled(tool_call_id="c1", tool_name="catalog_search", args={"q": "x"}),
        ToolReturned(tool_call_id="c1", output={"items": []}),
        ToolCalled(tool_call_id="c2", tool_name="ask_user", args=card),
        ToolReturned(tool_call_id="c2", output={"status": "asked"}),
        ToolCalled(tool_call_id="c3", tool_name="ask_user", args=card),
        TextDelta(part_id="p", delta="The card is below."),
    ]
    history = ModelMessagesTypeAdapter.validate_python(
        _partial_history("hello", events)
    )
    assert [type(m).__name__ for m in history] == [
        "ModelRequest",
        "ModelResponse",
        "ModelRequest",
        "ModelResponse",
    ]
    call = history[1].parts[0]
    assert isinstance(call, ToolCallPart)
    assert (call.tool_name, call.args, call.tool_call_id) == ("ask_user", card, "c2")
    returned = history[2].parts[0]
    assert isinstance(returned, ToolReturnPart)
    assert (returned.tool_call_id, returned.content) == ("c2", {"status": "asked"})
    assert history[3].parts[0] == TextPart(content="The card is below.")


class _FailingRepo:
    """Delegates to the repository; the first ``append_event`` fails."""

    def __init__(self, inner: Repository, error: Exception) -> None:
        self.inner = inner
        self.error = error
        self.attempts: list[int] = []

    async def append_event(self, run_id: UUID, seq: int, event: RunEvent) -> None:
        self.attempts.append(seq)
        if len(self.attempts) == 1:
            raise self.error
        await self.inner.append_event(run_id, seq, event)


async def test_emitter_failed_insert_leaves_no_event_and_no_gap(
    repo: Repository, settings: AssistantSettings
) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(
        conversation_id, USER, [{"type": "user_text", "text": "x"}], "test", "m", 3
    )
    failing = _FailingRepo(repo, RuntimeError("db down"))
    emit = _Emitter(failing, InMemoryEventBus(), run_id)  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="db down"):
        await emit(TextDelta(part_id="p", delta="lost"))
    assert emit.events == []
    await emit(TextDelta(part_id="p", delta="kept"))
    assert failing.attempts == [1, 1]  # the number was reused, not skipped
    assert [seq for seq, _ in await repo.list_events(run_id)] == [1]
    assert len(emit.events) == 1


async def test_emitter_skips_a_number_another_writer_took(
    repo: Repository, settings: AssistantSettings
) -> None:
    import asyncpg

    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(
        conversation_id, USER, [{"type": "user_text", "text": "x"}], "test", "m", 3
    )
    failing = _FailingRepo(repo, asyncpg.UniqueViolationError("seq taken"))
    emit = _Emitter(failing, InMemoryEventBus(), run_id)  # type: ignore[arg-type]
    with pytest.raises(asyncpg.UniqueViolationError):
        await emit(TextDelta(part_id="p", delta="lost"))
    await emit(TextDelta(part_id="p", delta="kept"))
    assert failing.attempts == [1, 2]
