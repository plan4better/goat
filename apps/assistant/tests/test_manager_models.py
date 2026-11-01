"""Runs on the organization's model (spec §4.5, §4.6, §11)."""

import logging
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic_ai import Agent, RunContext
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.instrumented import InstrumentationSettings
from pydantic_ai.models.test import TestModel

from assistant.agent import INSTRUCTIONS, RunDeps, build_agent, dev_model
from assistant.app import AppServices, create_app
from assistant.auth import Principal, get_principal
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.events import DataPart, TextDelta, UsageReported
from assistant.llm.providers import ConnectionFields, OpenModels, Target
from assistant.llm.resolution import AssistantUnavailable
from assistant.llm.vault import SecretBox
from assistant.org_repo import OrgSettingsRepository
from assistant.repo import Repository
from assistant.runs.manager import FALLBACK_CAVEAT, RunManager
from assistant.runs.titles import MAX_TITLE_CHARS, clean_title

USER = UUID(int=1)
ADMIN = UUID(int=3)
ORG = UUID(int=100)
KEY = "sk-own-abcd1234"


def _failing(error: Exception, *, first: str | None = None) -> Callable[[], Model]:
    """A model that fails with ``error``, after streaming ``first`` if given."""

    def build() -> Model:
        async def stream(
            messages: list[ModelMessage], info: AgentInfo
        ) -> AsyncIterator[str]:
            if first is not None:
                yield first
            raise error

        return FunctionModel(stream_function=stream)

    return build


def _opener(own: Callable[[], Model]) -> Callable[[Target], OpenModels]:
    """GOAT AI on the test model; the organization's connection on ``own``."""

    def open_(target: Target) -> OpenModels:
        if target.connection_id is None:
            return OpenModels(main=dev_model("test"))
        return OpenModels(main=own())

    return open_


async def _activate(
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
    *,
    fallback: bool = False,
    data_policy: str = "standard",
) -> UUID:
    box = SecretBox.from_settings(settings)
    assert box is not None
    row = await org_repo.create_connection(
        ORG,
        name="Own",
        fields=ConnectionFields(
            "openai_compatible", "https://llm.example.org/v1", None, "own-model"
        ),
        credentials_encrypted=box.encrypt({"api_key": KEY}),
    )
    connection_id = UUID(str(row["id"]))
    await org_repo.record_test(ORG, connection_id, ok=True, error=None, capabilities={})
    await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=connection_id,
        data_policy=data_policy,  # type: ignore[arg-type]
        allow_default_fallback=fallback,
        updated_by=ADMIN,
    )
    return connection_id


async def _conversation(repo: Repository) -> UUID:
    return UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )


async def _usage(repo: Repository) -> list[tuple[str, str, str, UUID | None]]:
    rows = await repo.db.pool.fetch(
        f"SELECT purpose, provider, model, connection_id FROM {repo.db.t('usage')} "
        "ORDER BY purpose"
    )
    return [(r["purpose"], r["provider"], r["model"], r["connection_id"]) for r in rows]


async def _run(manager: RunManager, repo: Repository) -> dict[str, Any]:
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "hello", None)
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None
    return run


async def test_run_uses_the_active_connection(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    connection_id = await _activate(org_repo, settings)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(lambda: TestModel(custom_output_text="Own answer.")),
    )
    run = await _run(manager, repo)
    assert (run["status"], run["provider"], run["model"]) == (
        "succeeded",
        "openai_compatible",
        "own-model",
    )
    assert await _usage(repo) == [
        ("background", "openai_compatible", "own-model", connection_id),
        ("main", "openai_compatible", "own-model", connection_id),
    ]
    events = [e for _, e in await repo.list_events(run["id"])]
    usage = next(e for e in events if isinstance(e, UsageReported))
    assert (usage.provider, usage.model) == ("openai_compatible", "own-model")


async def test_runs_are_refused_when_ai_is_disabled(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await org_repo.save_settings(
        ORG,
        enabled=False,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    with pytest.raises(AssistantUnavailable) as caught:
        await manager.start_run(await _conversation(repo), USER, "hello", None)
    assert caught.value.reason == "disabled"
    assert await repo.db.pool.fetchval(f"SELECT count(*) FROM {repo.db.t('run')}") == 0
    assert (
        await repo.db.pool.fetchval(f"SELECT count(*) FROM {repo.db.t('message')}") == 0
    )


async def test_fallback_before_any_output_is_announced(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _activate(org_repo, settings, fallback=True)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(_failing(ModelAPIError("own-model", "Connection error."))),
    )
    run = await _run(manager, repo)
    assert (run["status"], run["provider"], run["model"]) == (
        "succeeded",
        "test",
        "test",
    )
    events = [e for _, e in await repo.list_events(run["id"])]
    caveat = next(e for e in events if isinstance(e, DataPart))
    assert caveat.name == "caveat"
    assert caveat.data == {"kind": "fallback", "text": FALLBACK_CAVEAT}
    first_text = next(i for i, e in enumerate(events) if isinstance(e, TextDelta))
    assert events.index(caveat) < first_text
    assert ("main", "test", "test", None) in await _usage(repo)


async def test_no_fallback_once_the_answer_has_started(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _activate(org_repo, settings, fallback=True)
    error = ModelAPIError("own-model", "Connection error.")
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(_failing(error, first="Half an ")),
    )
    run = await _run(manager, repo)
    assert (run["status"], run["provider"]) == ("failed", "openai_compatible")
    assert run["error"] == "Your organization's AI provider isn't reachable right now."
    events = [e for _, e in await repo.list_events(run["id"])]
    assert not any(isinstance(e, DataPart) for e in events)


async def test_no_fallback_once_a_tool_call_has_started(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    """A tool call the stream began may already have acted: replaying the turn
    on another model could run the tool twice."""
    await _activate(org_repo, settings, fallback=True)
    ran: list[str] = []

    def own() -> Model:
        async def stream(
            messages: list[ModelMessage], info: AgentInfo
        ) -> AsyncIterator[DeltaToolCalls | str]:
            yield {0: DeltaToolCall(name="peek", json_args="{}", tool_call_id="call-1")}
            raise ModelAPIError("own-model", "Connection error.")

        return FunctionModel(stream_function=stream)

    def factory(model: Model | str) -> Agent[RunDeps, str]:
        agent: Agent[RunDeps, str] = Agent(
            model, deps_type=RunDeps, instructions=INSTRUCTIONS
        )

        @agent.tool(name="peek")
        async def peek(ctx: RunContext[RunDeps], /) -> str:
            ran.append("peek")
            return "ok"

        return agent

    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=factory,
        opener=_opener(own),
    )
    run = await _run(manager, repo)
    assert (run["status"], run["provider"]) == ("failed", "openai_compatible")
    events = [e for _, e in await repo.list_events(run["id"])]
    assert not any(isinstance(e, DataPart) for e in events)
    assert len(ran) <= 1


async def test_an_unreachable_provider_leaves_the_test_result_alone(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    connection_id = await _activate(org_repo, settings)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(_failing(ModelAPIError("own-model", "Connection error."))),
    )
    run = await _run(manager, repo)
    assert run["status"] == "failed"
    connection = await org_repo.get_connection(ORG, connection_id)
    assert connection is not None
    assert connection["last_test_ok"] is True
    assert connection["last_test_error"] is None


async def test_a_failing_fallback_reports_goat_ai(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _activate(org_repo, settings, fallback=True)
    error = ModelAPIError("model", "Connection error.")

    def open_(target: Target) -> OpenModels:
        model = _failing(error)()
        return OpenModels(main=model)

    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a", opener=open_)
    run = await _run(manager, repo)
    assert (run["status"], run["provider"], run["model"]) == ("failed", "test", "test")
    assert run["error"] == "GOAT AI isn't reachable right now."


async def test_no_fallback_unless_the_admin_enabled_it(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _activate(org_repo, settings, fallback=False)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(_failing(ModelAPIError("own-model", "Connection error."))),
    )
    run = await _run(manager, repo)
    assert run["status"] == "failed"
    assert run["error"] == "Your organization's AI provider isn't reachable right now."
    assert run["provider"] == "openai_compatible"
    assert await _usage(repo) == []


async def test_a_rejected_key_marks_the_connection(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    connection_id = await _activate(org_repo, settings)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_opener(
            _failing(ModelHTTPError(401, "own-model", {"error": "bad key"}))
        ),
    )
    run = await _run(manager, repo)
    assert (run["status"], run["error"]) == ("failed", "AI is unavailable right now.")
    connection = await org_repo.get_connection(ORG, connection_id)
    assert connection is not None
    assert connection["last_test_ok"] is False
    assert (
        connection["last_test_error"]
        == "The provider rejected the credentials (HTTP 401)."
    )


async def test_failures_never_log_the_key(
    repo: Repository,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await _activate(org_repo, settings)
    echo = ModelHTTPError(400, "own-model", {"error": f"key {KEY} is not allowed here"})
    manager = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", opener=_opener(_failing(echo))
    )
    with caplog.at_level(logging.WARNING, logger="assistant.runs.manager"):
        run = await _run(manager, repo)
    assert run["status"] == "failed"
    assert KEY not in caplog.text
    assert "is not allowed here" in caplog.text
    assert KEY not in (run["error"] or "")


async def test_unexpected_failures_never_log_the_key(
    repo: Repository,
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await _activate(org_repo, settings)

    def broken(model: Model | str) -> Agent[RunDeps, str]:
        # Not a provider failure the classifier knows: the generic path logs it.
        raise RuntimeError(f"client built with {KEY}")

    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=broken,
        opener=_opener(lambda: TestModel()),
    )
    with caplog.at_level(logging.WARNING, logger="assistant.runs.manager"):
        run = await _run(manager, repo)
    assert (run["status"], run["error"]) == (
        "failed",
        "The assistant failed unexpectedly.",
    )
    assert f"Run {run['id']} failed" in caplog.text
    assert "client built with" in caplog.text
    assert KEY not in caplog.text


async def test_a_run_that_was_ended_elsewhere_writes_no_title(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")

    async def lost(*args: Any, **kwargs: Any) -> bool:
        return False  # another party (the sweeper) ended the run first

    monkeypatch.setattr(manager.repo, "finish_run", lost)
    conversation_id = await _conversation(repo)
    run_id, _ = await manager.start_run(conversation_id, USER, "hello", None)
    await manager.wait(run_id)
    conversation = await repo.get_conversation(conversation_id, USER)
    assert conversation is not None and conversation["title"] is None
    assert [purpose for purpose, *_ in await _usage(repo)] == ["main"]


async def test_the_first_run_writes_a_title_with_the_model_that_answers(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    conversation_id = await _conversation(repo)
    for text in ("Which datasets cover cycling in Berlin?", "And in Munich?"):
        run_id, _ = await manager.start_run(conversation_id, USER, text, None)
        await manager.wait(run_id)
    conversation = await repo.get_conversation(conversation_id, USER)
    assert conversation is not None and conversation["title"] == "Here is a test answer"
    purposes = [purpose for purpose, *_ in await _usage(repo)]
    assert purposes == ["background", "main", "main"]  # one title, two answers


def test_clean_title() -> None:
    assert clean_title('\n  "Cycling data in Berlin."\nSecond line') == (
        "Cycling data in Berlin"
    )
    assert clean_title("  \n ** \n") is None
    long = clean_title("word " * 40)
    assert long is not None and len(long) == MAX_TITLE_CHARS and long.endswith("…")


async def test_the_data_policy_reaches_the_tools(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=None,
        data_policy="restricted",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    seen: list[str] = []

    def factory(model: Model | str) -> Agent[RunDeps, str]:
        agent: Agent[RunDeps, str] = Agent(
            TestModel(), deps_type=RunDeps, instructions=INSTRUCTIONS
        )

        @agent.tool(name="peek")
        async def peek(ctx: RunContext[RunDeps], /) -> str:
            seen.append(ctx.deps.data_policy)
            return "ok"

        return agent

    manager = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=factory
    )
    await _run(manager, repo)
    assert seen == ["restricted"]


async def test_the_run_endpoint_refuses_when_ai_is_disabled(
    repo: Repository, org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await org_repo.save_settings(
        ORG,
        enabled=False,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    bus = InMemoryEventBus()
    services = AppServices(
        db=repo.db, repo=repo, bus=bus, runs=RunManager(repo, bus, settings, owner="t")
    )
    app = create_app(settings, services=services)
    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id=USER, token=None
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        response = await client.post(
            f"/conversations/{conversation['id']}/runs",
            json={"message": {"id": "u1", "text": "hi"}},
        )
    assert response.status_code == 403
    assert response.json()["detail"] == {
        "code": "ai_unavailable",
        "reason": "disabled",
        "message": "AI is unavailable.",
    }


async def test_the_run_endpoint_is_503_without_a_model(
    repo: Repository, settings: AssistantSettings
) -> None:
    no_model = settings.model_copy(update={"default_provider": "none"})
    bus = InMemoryEventBus()
    services = AppServices(
        db=repo.db, repo=repo, bus=bus, runs=RunManager(repo, bus, no_model, owner="t")
    )
    app = create_app(no_model, services=services)
    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id=USER, token=None
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t"
    ) as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        response = await client.post(
            f"/conversations/{conversation['id']}/runs",
            json={"message": {"id": "u1", "text": "hi"}},
        )
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "no_connection"


# -- history of runs ended elsewhere (the sweeper, a stop during start) -------


def _recording_factory(
    seen: list[list[ModelMessage]],
) -> Callable[[Model | str], Agent[RunDeps, str]]:
    def factory(model: Model | str) -> Agent[RunDeps, str]:
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

    return factory


async def test_a_swept_turn_stays_in_the_next_runs_history(
    repo: Repository, settings: AssistantSettings
) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(
        conversation_id,
        USER,
        [{"type": "user_text", "text": "first question"}],
        "test",
        "test",
        3,
    )
    await repo.mark_running(
        run_id, "dead-replica", datetime.now(timezone.utc) - timedelta(seconds=1)
    )
    await repo.append_event(run_id, 1, TextDelta(part_id="p", delta="half an answer"))
    seen: list[list[ModelMessage]] = []
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=_recording_factory(seen),
    )
    assert await manager.sweep_once() == 1
    second_id, _ = await manager.start_run(conversation_id, USER, "follow up", None)
    await manager.wait(second_id)
    assert len(seen) == 1
    first, answer = seen[0][0], seen[0][1]
    assert isinstance(first, ModelRequest)
    assert [p.content for p in first.parts if isinstance(p, UserPromptPart)] == [
        "first question"
    ]
    assert isinstance(answer, ModelResponse)
    assert [p.content for p in answer.parts if isinstance(p, TextPart)] == [
        "half an answer"
    ]


async def test_a_run_ended_before_it_started_keeps_the_question(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    real_begin_run = repo.begin_run

    async def begin_then_stop(*args: Any, **kwargs: Any) -> tuple[UUID, UUID]:
        result = await real_begin_run(*args, **kwargs)
        manager._stopping = True
        return result

    manager.repo.begin_run = begin_then_stop  # type: ignore[method-assign]
    conversation_id = await _conversation(repo)
    with pytest.raises(RuntimeError, match="shutting down"):
        await manager.start_run(conversation_id, USER, "lost question", None)
    history = await repo.history(conversation_id)
    assert [m["kind"] for m in history] == ["request"]
    assert history[0]["parts"][0]["content"] == "lost question"


# -- tracing ------------------------------------------------------------------


def test_agents_are_traced_without_content_when_otel_is_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_ENABLED", "true")
    instrument = build_agent("test").instrument
    assert isinstance(instrument, InstrumentationSettings)
    assert instrument.include_content is False


def test_agents_are_not_traced_when_otel_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_ENABLED", "false")
    assert build_agent("test").instrument is None
    monkeypatch.delenv("OTEL_ENABLED")
    assert build_agent("test").instrument is None
