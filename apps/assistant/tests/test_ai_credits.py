"""AI credits: the check before a GOAT AI answer, the charge after it and the
hosting line saved with it. Core's own functions run on stand-ins of its
tables (conftest); the tiers here are the test's, never core's defaults."""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from typing import Any
from uuid import UUID

import pytest
from pydantic_ai import Agent, RunContext
from pydantic_ai.exceptions import ModelAPIError, UsageLimitExceeded
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from assistant import credits as credits_module
from assistant.agent import INSTRUCTIONS, RunDeps, dev_model
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.credits import AiCreditsUsedUp, Pool, answer_steps, charged
from assistant.db import Database
from assistant.events import (
    DataPart,
    RunEnded,
    RunErrorCode,
    RunStatus,
    TextDelta,
    ToolCalled,
    UsageReported,
)
from assistant.llm.providers import ConnectionFields, OpenModels, Target
from assistant.llm.vault import SecretBox
from assistant.org_repo import OrgSettingsRepository
from assistant.repo import Repository
from assistant.runs.manager import Charge, RunManager, _Emitter
from tests.conftest import ApiFactory

USER = UUID(int=1)
ADMIN = UUID(int=3)
ORG = UUID(int=100)

#: The test's own price list: no step costs 1.5, any step 4.
TIERS = [{"max_steps": 0, "credits": 1.5}, {"max_steps": None, "credits": 4}]
NO_STEP, WITH_STEPS = 1.5, 4.0

RESET = datetime(2026, 12, 1)
TRIAL_END = datetime(2026, 11, 30, 12, 0)


# -- the rule ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code", "steps", "expected"),
    [
        ("succeeded", None, 0, True),
        ("succeeded", None, 12, True),
        # Limits the question ran into: charged by their steps like an answer.
        ("failed", "run_limit", 0, True),
        ("failed", "run_limit", 30, True),
        # Out of time once the answer did something; before its first step it
        # is a provider that hung.
        ("failed", "run_timeout", 0, False),
        ("failed", "run_timeout", 1, True),
        ("failed", "run_timeout", 3, True),
        # Failures on our side are free, whatever was done before them.
        ("failed", "internal_error", 5, False),
        ("failed", "ai_unavailable", 5, False),
        ("failed", "provider_unreachable", 5, False),
        ("failed", "provider_busy", 5, False),
        ("failed", "provider_error", 5, False),
        ("failed", "goat_ai_unreachable", 5, False),
        ("failed", "goat_ai_busy", 5, False),
        ("failed", "goat_ai_error", 5, False),
        ("failed", None, 5, False),
        # A stop counts once the answer did something.
        ("cancelled", None, 0, False),
        ("cancelled", None, 1, True),
        ("interrupted", None, 0, False),
        ("interrupted", None, 7, False),
    ],
)
def test_which_answers_are_charged(
    status: RunStatus, code: RunErrorCode | None, steps: int, expected: bool
) -> None:
    assert charged(status, code, steps) is expected


def test_steps_are_the_answers_tool_calls() -> None:
    events: list[Any] = [
        ToolCalled(tool_call_id="a", tool_name="x", args={}),
        TextDelta(part_id="p", delta="hi"),
        ToolCalled(tool_call_id="b", tool_name="y", args={}),
        ToolCalled(tool_call_id="a", tool_name="x", args={}),
    ]
    assert answer_steps(events) == 2
    assert answer_steps([]) == 0


# -- helpers -----------------------------------------------------------------


def _agent(
    *, tool_calls: int = 0, then: str | BaseException | asyncio.Event = "Done."
) -> Agent[RunDeps, str]:
    """GOAT AI on a scripted model: ``tool_calls`` calls of ``ping``, one per
    response, then a text, an exception, or a first word and a wait for the
    event."""

    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        made = sum(isinstance(message, ModelResponse) for message in messages)
        if made < tool_calls:
            yield {
                0: DeltaToolCall(
                    name="ping", json_args="{}", tool_call_id=f"call-{made}"
                )
            }
            return
        if isinstance(then, BaseException):
            raise then
        if isinstance(then, asyncio.Event):
            yield "first "
            await then.wait()
            yield "second"
            return
        yield then

    agent: Agent[RunDeps, str] = Agent(
        FunctionModel(stream_function=stream),
        deps_type=RunDeps,
        instructions=INSTRUCTIONS,
    )

    @agent.tool(name="ping")
    async def ping(ctx: RunContext[RunDeps], /) -> str:
        return "pong"

    return agent


def _manager(
    repo: Repository,
    settings: AssistantSettings,
    agent: Callable[[], Agent[RunDeps, str]] | None = None,
    **kwargs: Any,
) -> RunManager:
    if agent is not None:
        kwargs["agent_factory"] = lambda _: agent()
    return RunManager(repo, InMemoryEventBus(), settings, owner="a", **kwargs)


async def _terms(db: Database) -> None:
    await db.pool.execute(
        f"INSERT INTO {db.customer('billing_terms')} (id, ai_credit_tiers) "
        "VALUES (1, $1)",
        TIERS,
    )


async def _pool(
    db: Database,
    total: float | None,
    used: float = 0,
    *,
    on_trial: bool = False,
    renewal: datetime | None = None,
    reset: datetime | None = None,
) -> None:
    await db.pool.execute(
        f"UPDATE {db.customer('organization')} SET total_ai_credits = $2, "
        "used_ai_credits = $3, on_trial = $4, plan_renewal_date = $5, "
        "credits_reset_at = $6 WHERE id = $1",
        ORG,
        total,
        used,
        on_trial,
        renewal,
        reset,
    )


async def _used(db: Database) -> float:
    return float(
        await db.pool.fetchval(
            f"SELECT used_ai_credits FROM {db.customer('organization')} WHERE id = $1",
            ORG,
        )
    )


async def _ledger(db: Database) -> list[dict[str, Any]]:
    rows = await db.pool.fetch(
        f"SELECT * FROM {db.customer('credit_usage')} ORDER BY id"
    )
    return [dict(row) for row in rows]


async def _conversation(repo: Repository) -> UUID:
    return UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )


async def _run(manager: RunManager, repo: Repository) -> dict[str, Any]:
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "hi", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None
    return run


async def _usage_event(repo: Repository, run_id: UUID) -> UsageReported:
    events = [event for _, event in await repo.list_events(run_id)]
    return next(event for event in events if isinstance(event, UsageReported))


async def _stored_usage(repo: Repository, run: dict[str, Any]) -> dict[str, Any]:
    messages = await repo.list_messages(run["conversation_id"], exclude_message_id=None)
    answer = next(m for m in messages if m["id"] == run["assistant_message_id"])
    part: dict[str, Any] = next(p for p in answer["parts"] if p["type"] == "usage")
    return part


async def _until(check: Callable[[], Awaitable[bool]], timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.02)


def _has_text(repo: Repository, run_id: UUID) -> Callable[[], Awaitable[bool]]:
    async def check() -> bool:
        return any(isinstance(e, TextDelta) for _, e in await repo.list_events(run_id))

    return check


async def _activate(
    org_repo: OrgSettingsRepository, settings: AssistantSettings, *, fallback: bool
) -> UUID:
    box = SecretBox.from_settings(settings)
    assert box is not None
    row = await org_repo.create_connection(
        ORG,
        name="Own",
        fields=ConnectionFields(
            "openai_compatible", "https://llm.example.org/v1", None, "own-model"
        ),
        credentials_encrypted=box.encrypt({"api_key": "sk-own-abcd1234"}),
    )
    connection_id = UUID(str(row["id"]))
    await org_repo.record_test(ORG, connection_id, ok=True, error=None, capabilities={})
    await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=connection_id,
        data_policy="standard",
        allow_default_fallback=fallback,
        updated_by=ADMIN,
    )
    return connection_id


def _opener(own: Callable[[], Model]) -> Callable[[Target], OpenModels]:
    """GOAT AI on the test model; the organization's connection on ``own``."""

    def open_(target: Target) -> OpenModels:
        if target.connection_id is None:
            return OpenModels(main=dev_model("test"))
        return OpenModels(main=own())

    return open_


def _unreachable() -> Model:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        raise ModelAPIError("own-model", "Connection error.")
        yield ""  # an async generator

    return FunctionModel(stream_function=stream)


# -- the check before an answer ----------------------------------------------


async def test_an_answer_runs_while_ai_credits_are_left(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _pool(db, 10, 9.5, reset=RESET)
    run = await _run(_manager(repo, settings), repo)
    assert run["status"] == "succeeded"


async def test_no_answer_once_the_ai_credits_are_used_up(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _pool(db, 10, 10, reset=RESET)
    manager = _manager(repo, settings)
    conversation_id = await _conversation(repo)
    with pytest.raises(AiCreditsUsedUp) as refused:
        await manager.start_run(conversation_id, USER, "hi", None)
    assert (refused.value.resets_on, refused.value.on_trial) == (RESET, False)
    # Refused before anything is stored.
    assert await repo.list_messages(conversation_id, exclude_message_id=None) == []
    assert await repo.active_run(conversation_id) is None


async def test_a_trial_that_used_its_ai_credits_names_its_end(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    # A trial's credits last the trial: the date is the trial's end, not a reset.
    await _pool(db, 100, 120, on_trial=True, renewal=TRIAL_END, reset=RESET)
    with pytest.raises(AiCreditsUsedUp) as refused:
        await _manager(repo, settings).start_run(
            await _conversation(repo), USER, "hi", None
        )
    assert (refused.value.resets_on, refused.value.on_trial) == (TRIAL_END, True)


@pytest.mark.parametrize("unknown", [False, True])
async def test_an_organization_without_a_limit_is_never_refused(
    repo: Repository, db: Database, settings: AssistantSettings, unknown: bool
) -> None:
    await _pool(db, None, 500)
    if unknown:
        await db.pool.execute(f"DELETE FROM {db.customer('organization')}")
    run = await _run(_manager(repo, settings), repo)
    assert run["status"] == "succeeded"


async def test_a_failing_check_lets_the_answer_run_and_logs_once(
    repo: Repository,
    db: Database,
    settings: AssistantSettings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await _pool(db, 10, 10, reset=RESET)
    manager = _manager(repo, settings)
    real_pool = manager.credits.pool

    async def broken(organization_id: UUID) -> Pool:
        raise ConnectionError("database gone")

    manager.credits.pool = broken  # type: ignore[method-assign]
    with caplog.at_level(logging.DEBUG, logger="assistant.credits"):
        assert (await _run(manager, repo))["status"] == "succeeded"
        assert (await _run(manager, repo))["status"] == "succeeded"
        failures = [r for r in caplog.records if "AI credit check failed" in r.message]
        assert [r.levelno for r in failures] == [logging.WARNING, logging.DEBUG]
        # Once it works again it refuses again, and a later failure warns again.
        manager.credits.pool = real_pool  # type: ignore[method-assign]
        with pytest.raises(AiCreditsUsedUp):
            await manager.start_run(await _conversation(repo), USER, "hi", None)
        manager.credits.pool = broken  # type: ignore[method-assign]
        await _run(manager, repo)
    failures = [r for r in caplog.records if "AI credit check failed" in r.message]
    assert [r.levelno for r in failures] == [
        logging.WARNING,
        logging.DEBUG,
        logging.WARNING,
    ]


async def test_a_slow_check_lets_the_answer_run(
    repo: Repository,
    db: Database,
    settings: AssistantSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _pool(db, 10, 10, reset=RESET)
    monkeypatch.setattr(credits_module, "CHECK_TIMEOUT_SECONDS", 0.05)
    manager = _manager(repo, settings)

    async def slow(organization_id: UUID) -> Pool:
        await asyncio.sleep(5)
        raise AssertionError("not reached")

    manager.credits.pool = slow  # type: ignore[method-assign]
    assert (await _run(manager, repo))["status"] == "succeeded"


async def test_an_own_connection_is_never_checked(
    repo: Repository,
    db: Database,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
) -> None:
    await _pool(db, 10, 10, reset=RESET)
    await _activate(org_repo, settings, fallback=False)
    manager = _manager(
        repo,
        settings,
        opener=_opener(lambda: TestModel(custom_output_text="Own answer.")),
    )
    looked: list[UUID] = []
    real_pool = manager.credits.pool

    async def counting(organization_id: UUID) -> Pool:
        looked.append(organization_id)
        return await real_pool(organization_id)

    manager.credits.pool = counting  # type: ignore[method-assign]
    run = await _run(manager, repo)
    assert (run["status"], run["provider"]) == ("succeeded", "openai_compatible")
    assert looked == []
    assert await _ledger(db) == []


async def test_without_ai_credits_an_own_connection_loses_its_fallback(
    repo: Repository,
    db: Database,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
) -> None:
    await _pool(db, 10, 10, reset=RESET)
    await _activate(org_repo, settings, fallback=True)
    manager = _manager(repo, settings, opener=_opener(_unreachable))
    run = await _run(manager, repo)
    # The own provider's error, not GOAT AI's answer.
    assert (run["status"], run["provider"]) == ("failed", "openai_compatible")
    events = [e for _, e in await repo.list_events(run["id"])]
    assert not any(isinstance(e, DataPart) for e in events)
    assert events[-1] == RunEnded(
        status="failed", error=run["error"], code="provider_unreachable"
    )
    assert await _ledger(db) == []


async def test_a_fallback_answer_is_charged(
    repo: Repository,
    db: Database,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
) -> None:
    await _terms(db)
    await _pool(db, 10, 3, reset=RESET)
    await _activate(org_repo, settings, fallback=True)
    manager = _manager(repo, settings, opener=_opener(_unreachable))
    run = await _run(manager, repo)
    assert (run["status"], run["provider"]) == ("succeeded", "test")
    assert [row["cost"] for row in await _ledger(db)] == [NO_STEP]
    assert await _used(db) == 3 + NO_STEP
    event = await _usage_event(repo, run["id"])
    assert (event.goat_ai, event.ai_credits, event.steps) == (True, NO_STEP, 0)


# -- the charge after an answer ------------------------------------------------


async def test_an_answer_is_charged_by_its_steps(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    await _pool(db, 10, 1, reset=RESET)
    manager = _manager(repo, settings, lambda: _agent(tool_calls=2))
    run = await _run(manager, repo)
    assert run["status"] == "succeeded"
    [row] = await _ledger(db)
    assert (row["organization_id"], row["user_id"]) == (ORG, USER)
    assert (row["category"], row["action"], row["unit_type"]) == (
        "ai",
        "assistant_answer",
        "steps",
    )
    assert (row["unit"], row["cost"]) == (2, WITH_STEPS)
    payload = row["payload"]
    assert payload["run_id"] == str(run["id"])
    assert payload["conversation_id"] == str(run["conversation_id"])
    assert (payload["model"], payload["provider"]) == ("test", "test")
    assert set(payload) == {
        "run_id",
        "conversation_id",
        "model",
        "provider",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
    }
    assert payload["input_tokens"] > 0
    assert await _used(db) == 1 + WITH_STEPS
    event = await _usage_event(repo, run["id"])
    assert (event.goat_ai, event.ai_credits, event.steps) == (True, WITH_STEPS, 2)
    stored = await _stored_usage(repo, run)
    assert (stored["goat_ai"], stored["ai_credits"], stored["steps"]) == (
        True,
        WITH_STEPS,
        2,
    )


async def test_an_answer_without_a_step_costs_the_first_tier(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    run = await _run(_manager(repo, settings, lambda: _agent()), repo)
    assert [(row["unit"], row["cost"]) for row in await _ledger(db)] == [(0, NO_STEP)]
    event = await _usage_event(repo, run["id"])
    assert (event.ai_credits, event.steps) == (NO_STEP, 0)


async def test_an_organization_without_a_limit_is_still_recorded(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    """Counted, never refused: the Usage page shows its answers."""
    await _terms(db)
    await _run(_manager(repo, settings, lambda: _agent(tool_calls=1)), repo)
    assert [row["cost"] for row in await _ledger(db)] == [WITH_STEPS]
    assert await _used(db) == WITH_STEPS


async def test_a_stopped_answer_with_steps_is_charged(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    gate = asyncio.Event()
    manager = _manager(repo, settings, lambda: _agent(tool_calls=1, then=gate))
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(_has_text(repo, run_id))
    await manager.cancel(run_id)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "cancelled"
    assert [(row["unit"], row["cost"]) for row in await _ledger(db)] == [
        (1, WITH_STEPS)
    ]
    event = await _usage_event(repo, run_id)
    assert (event.ai_credits, event.steps) == (WITH_STEPS, 1)


async def test_a_stopped_answer_without_a_step_is_free(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    gate = asyncio.Event()
    manager = _manager(repo, settings, lambda: _agent(then=gate))
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(_has_text(repo, run_id))
    await manager.cancel(run_id)
    await manager.wait(run_id)
    assert await _ledger(db) == []
    event = await _usage_event(repo, run_id)
    assert event.goat_ai is True
    assert (event.ai_credits, event.steps) == (None, None)
    run = await repo.get_run(run_id)
    assert run is not None
    stored = await _stored_usage(repo, run)
    assert "ai_credits" not in stored and "steps" not in stored


async def test_an_answer_that_hit_the_run_limit_is_charged(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    manager = _manager(
        repo,
        settings,
        lambda: _agent(tool_calls=1, then=UsageLimitExceeded("too many requests")),
    )
    run = await _run(manager, repo)
    assert run["status"] == "failed"
    events = [e for _, e in await repo.list_events(run["id"])]
    assert events[-1].code == "run_limit"  # type: ignore[union-attr]
    assert [(row["unit"], row["cost"]) for row in await _ledger(db)] == [
        (1, WITH_STEPS)
    ]


async def test_an_answer_that_ran_out_of_time_after_a_step_is_charged(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    short = settings.model_copy(update={"run_max_seconds": 1})
    manager = _manager(repo, short, lambda: _agent(tool_calls=1, then=asyncio.Event()))
    run = await _run(manager, repo)
    events = [e for _, e in await repo.list_events(run["id"])]
    assert events[-1].code == "run_timeout"  # type: ignore[union-attr]
    assert [(row["unit"], row["cost"]) for row in await _ledger(db)] == [
        (1, WITH_STEPS)
    ]
    event = await _usage_event(repo, run["id"])
    assert (event.ai_credits, event.steps) == (WITH_STEPS, 1)


async def test_a_provider_that_hangs_until_the_deadline_is_free(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    short = settings.model_copy(update={"run_max_seconds": 0})
    manager = _manager(repo, short, lambda: _agent(then=asyncio.Event()))
    run = await _run(manager, repo)
    events = [e for _, e in await repo.list_events(run["id"])]
    assert events[-1].code == "run_timeout"  # type: ignore[union-attr]
    assert await _ledger(db) == []


async def test_a_charge_reaches_the_answer_without_reported_tokens(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Some providers report no usage: the answer still shows its charge."""
    manager = _manager(repo, settings)
    run_id, _ = await repo.begin_run(
        await _conversation(repo), USER, [], "test", "test", 3
    )
    emit = _Emitter(repo, InMemoryEventBus(), run_id)
    goat_ai = manager.resolver.goat_ai()
    assert goat_ai is not None
    await manager._record_usage(
        run_id,
        USER,
        ORG,
        goat_ai,
        RunUsage(),
        emit,
        Charge(ai_credits=4.0, steps=2),
        active=True,
    )
    event = await _usage_event(repo, run_id)
    assert (event.input_tokens, event.ai_credits, event.steps) == (0, 4.0, 2)
    # Without a charge and without tokens there is nothing to report.
    other, _ = await repo.begin_run(
        await _conversation(repo), USER, [], "test", "test", 3
    )
    await manager._record_usage(
        other,
        USER,
        ORG,
        goat_ai,
        RunUsage(),
        _Emitter(repo, InMemoryEventBus(), other),
        active=True,
    )
    assert await repo.list_events(other) == []


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ModelAPIError("test", "Connection error."), "goat_ai_unreachable"),
        (RuntimeError("bug"), "internal_error"),
    ],
)
async def test_an_answer_that_failed_on_our_side_is_free(
    repo: Repository,
    db: Database,
    settings: AssistantSettings,
    error: Exception,
    code: str,
) -> None:
    await _terms(db)
    manager = _manager(repo, settings, lambda: _agent(tool_calls=2, then=error))
    run = await _run(manager, repo)
    events = [e for _, e in await repo.list_events(run["id"])]
    assert sum(isinstance(e, ToolCalled) for e in events) == 2
    assert events[-1].code == code  # type: ignore[union-attr]
    assert await _ledger(db) == []
    assert await _used(db) == 0


async def test_an_interrupted_answer_is_free(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _terms(db)
    gate = asyncio.Event()
    manager = _manager(repo, settings, lambda: _agent(tool_calls=1, then=gate))
    await manager.start()
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(_has_text(repo, run_id))
    await manager.stop()
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    assert await _ledger(db) == []


async def test_an_answer_whose_lease_was_lost_is_free(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    """Swept as interrupted while its owner still ran it: the owner's stop is
    not the user's."""
    await _terms(db)
    gate = asyncio.Event()
    fast = settings.model_copy(update={"lease_heartbeat_seconds": 1})
    manager = _manager(repo, fast, lambda: _agent(tool_calls=1, then=gate))
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(_has_text(repo, run_id))
    await db.pool.execute(
        f"UPDATE {db.t('run')} SET lease_expires_at = now() - interval '1 minute' "
        "WHERE id = $1",
        run_id,
    )
    assert await manager.sweep_once() == 1
    await asyncio.wait_for(manager.wait(run_id), timeout=5)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    assert await _ledger(db) == []


async def test_an_own_connection_answer_is_free(
    repo: Repository,
    db: Database,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
) -> None:
    await _terms(db)
    await _activate(org_repo, settings, fallback=True)
    manager = _manager(
        repo,
        settings.model_copy(update={"default_hosted_in": "EU"}),
        opener=_opener(lambda: TestModel(custom_output_text="Own answer.")),
    )
    run = await _run(manager, repo)
    assert run["status"] == "succeeded"
    assert await _ledger(db) == []
    event = await _usage_event(repo, run["id"])
    assert (event.goat_ai, event.hosted_in, event.ai_credits, event.steps) == (
        False,
        None,
        None,
        None,
    )
    hosted = await db.pool.fetchval(
        f"SELECT hosted_in FROM {db.t('usage')} WHERE run_id = $1 AND purpose = 'main'",
        run["id"],
    )
    assert hosted is None


async def test_a_run_is_charged_once(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    """A second charge of the same run (a run ended twice) books nothing."""
    await _terms(db)
    manager = _manager(repo, settings, lambda: _agent(tool_calls=1))
    run = await _run(manager, repo)
    again = await manager.credits.charge(ORG, USER, run["id"], 1, {"again": True})
    assert again == 0
    assert len(await _ledger(db)) == 1
    assert await _used(db) == WITH_STEPS


async def test_a_failing_charge_is_logged_once_and_the_answer_stands(
    repo: Repository,
    db: Database,
    settings: AssistantSettings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A missing grant fails every charge: one warning, not a traceback per
    answer, until a charge works again."""
    await _terms(db)
    manager = _manager(repo, settings)
    real_charge = manager.credits.charge

    async def broken(*args: Any) -> float:
        raise ConnectionError("permission denied")

    def failures() -> list[int]:
        return [
            r.levelno for r in caplog.records if "charging its AI credits" in r.message
        ]

    manager.credits.charge = broken  # type: ignore[method-assign]
    with caplog.at_level(logging.DEBUG, logger="assistant.credits"):
        run = await _run(manager, repo)
        assert run["status"] == "succeeded"
        event = await _usage_event(repo, run["id"])
        assert (event.goat_ai, event.ai_credits, event.steps) == (True, None, None)
        await _run(manager, repo)
        assert failures() == [logging.WARNING, logging.DEBUG]
        manager.credits.charge = real_charge  # type: ignore[method-assign]
        await _run(manager, repo)
        assert len(await _ledger(db)) == 1
        manager.credits.charge = broken  # type: ignore[method-assign]
        await _run(manager, repo)
    assert failures() == [logging.WARNING, logging.DEBUG, logging.WARNING]
    assert not [r for r in caplog.records if r.exc_info and r.levelno < logging.WARNING]


async def test_an_answer_ended_elsewhere_before_its_end_is_free(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    """Swept or taken over while its owner still ran it, and finished before the
    owner noticed: stored as interrupted, so it is not charged."""
    await _terms(db)
    gate = asyncio.Event()
    manager = _manager(repo, settings, lambda: _agent(tool_calls=1, then=gate))
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await _until(_has_text(repo, run_id))
    # Ended elsewhere without an event, so the owner's answer goes on to its end.
    assert await repo.finish_run(run_id, "interrupted", None, [], [])
    gate.set()
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"
    assert await _ledger(db) == []
    assert await _used(db) == 0


# -- the hosting line ----------------------------------------------------------


async def test_a_goat_ai_answer_saves_where_its_model_is_hosted(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    hosted = settings.model_copy(update={"default_hosted_in": "EU"})
    run = await _run(_manager(repo, hosted), repo)
    rows = await db.pool.fetch(
        f"SELECT purpose, hosted_in FROM {db.t('usage')} WHERE run_id = $1",
        run["id"],
    )
    # The answer's record; the conversation title is not an answer.
    assert {row["purpose"]: row["hosted_in"] for row in rows} == {
        "main": "EU",
        "background": None,
    }
    assert (await _usage_event(repo, run["id"])).hosted_in == "EU"
    assert (await _stored_usage(repo, run))["hosted_in"] == "EU"


async def test_without_a_hosting_setting_no_place_is_saved(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    run = await _run(_manager(repo, settings), repo)
    hosted = await db.pool.fetchval(
        f"SELECT hosted_in FROM {db.t('usage')} WHERE run_id = $1 AND purpose = 'main'",
        run["id"],
    )
    assert hosted is None
    assert (await _usage_event(repo, run["id"])).hosted_in is None
    assert "hosted_in" not in await _stored_usage(repo, run)


# -- the run route -------------------------------------------------------------


async def test_the_run_route_refuses_with_the_reset_date(
    api: ApiFactory, repo: Repository, db: Database
) -> None:
    await _pool(db, 10, 12, reset=RESET)
    async with api() as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        response = await client.post(
            f"/conversations/{conversation['id']}/runs",
            json={"message": {"id": "u1", "text": "hi"}},
        )
    assert response.status_code == 402
    assert response.json() == {
        "detail": {
            "code": "ai_credits_used_up",
            "message": "The organization's AI credits are used up.",
            "resets_on": "2026-12-01T00:00:00",
            "on_trial": False,
        }
    }
    assert (
        await repo.list_messages(UUID(conversation["id"]), exclude_message_id=None)
        == []
    )


async def test_the_run_route_names_a_trials_end(api: ApiFactory, db: Database) -> None:
    await _pool(db, 100, 100, on_trial=True, renewal=TRIAL_END)
    async with api() as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        response = await client.post(
            f"/conversations/{conversation['id']}/runs",
            json={"message": {"id": "u1", "text": "hi"}},
        )
    assert response.status_code == 402
    detail = response.json()["detail"]
    assert (detail["resets_on"], detail["on_trial"]) == ("2026-11-30T12:00:00", True)
