"""How a run ends, as the dock reads it (spec §10: run errors in the UI language)."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import (
    ContentFilterError,
    IncompleteToolCall,
    ModelAPIError,
    UsageLimitExceeded,
)
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaThinkingCalls,
    DeltaThinkingPart,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)

from assistant.agent import INSTRUCTIONS, RunDeps, build_agent
from assistant.budget import RunBudget
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.encoding.ai_sdk import AiSdkEncoder
from assistant.events import (
    DataPart,
    RunEnded,
    RunEvent,
    RunStarted,
    TextDelta,
    TextStarted,
    ToolReturned,
    UsageReported,
    fold_parts,
    to_ui_message,
)
from assistant.llm.failures import (
    FailureKind,
    ProviderFailure,
    failure_code,
    user_message,
)
from assistant.llm.providers import OpenModels, Target
from assistant.login import StaticLogin
from assistant.prompt import NO_ANSWER_TEXT
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.runs.turn import NO_ANSWER_CAVEAT
from assistant.tools.testing import Recorder, fake_clients, tool_env
from assistant.tools.toolset import TOOL_RETRIES
from tests.test_manager import _gated_agent

USER = UUID(int=1)


async def _conversation(repo: Repository) -> UUID:
    return UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )


async def _ended(repo: Repository, run_id: UUID) -> RunEnded:
    events = [event for _, event in await repo.list_events(run_id)]
    ended = events[-1]
    assert isinstance(ended, RunEnded)
    return ended


async def test_a_timed_out_run_ends_with_its_code(
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
    conversation_id = await _conversation(repo)
    run_id, message_id = await manager.start_run(conversation_id, USER, "go", None)
    await manager.wait(run_id)

    ended = await _ended(repo, run_id)
    assert (ended.status, ended.code) == ("failed", "run_timeout")
    stored = [
        m
        for m in await repo.list_messages(conversation_id, exclude_message_id=None)
        if m["id"] == message_id
    ]
    assert stored[0]["parts"][-1] == {
        "type": "run_status",
        "status": "failed",
        "error": "The run took longer than allowed.",
        "code": "run_timeout",
    }


def _failing_opener(error: Exception) -> Callable[[Target], OpenModels]:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        raise error
        yield ""  # an async generator

    def open_(target: Target) -> OpenModels:
        model = FunctionModel(stream_function=stream)
        return OpenModels(main=model)

    return open_


async def test_a_provider_failure_ends_with_the_code_of_its_message(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        opener=_failing_opener(ModelAPIError("test", "Connection error.")),
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await manager.wait(run_id)
    ended = await _ended(repo, run_id)
    # The test connection is GOAT AI, not an organization's own one.
    assert (ended.status, ended.code, ended.error) == (
        "failed",
        "goat_ai_unreachable",
        "GOAT AI isn't reachable right now.",
    )


@pytest.mark.parametrize("own", [True, False])
@pytest.mark.parametrize(
    "kind", ["rejected", "blocked", "unreachable", "busy", "error"]
)
def test_every_failure_has_a_code_matching_its_message(
    kind: FailureKind, own: bool
) -> None:
    failure = ProviderFailure(kind, None, "")
    code = failure_code(failure, own=own)
    message = user_message(failure, own=own)
    if kind == "rejected":
        assert code == "ai_unavailable"
        return
    assert code.startswith("provider_" if own else "goat_ai_")
    assert message.startswith("Your organization's AI provider" if own else "GOAT AI")
    suffix = {
        "blocked": "unreachable",
        "unreachable": "unreachable",
        "busy": "busy",
        "error": "error",
    }[kind]
    assert code.endswith(suffix)


async def _failed_run(
    repo: Repository,
    settings: AssistantSettings,
    factory: Callable[[str], Agent[RunDeps, str]],
) -> RunEnded:
    manager = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=factory
    )
    run_id, _ = await manager.start_run(await _conversation(repo), USER, "go", None)
    await manager.wait(run_id)
    return await _ended(repo, run_id)


async def test_a_usage_limit_ends_with_run_limit(
    repo: Repository, settings: AssistantSettings
) -> None:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        raise UsageLimitExceeded("too many requests")
        yield ""  # an async generator

    def factory(_: str) -> Agent[RunDeps, str]:
        return Agent(
            FunctionModel(stream_function=stream),
            deps_type=RunDeps,
            instructions=INSTRUCTIONS,
        )

    ended = await _failed_run(repo, settings, factory)
    assert (ended.status, ended.code) == ("failed", "run_limit")
    assert ended.error is not None
    assert ended.error.startswith("The run hit a limit: too many requests")


async def test_a_timeout_outside_the_deadline_is_an_internal_error(
    repo: Repository, settings: AssistantSettings
) -> None:
    def factory(_: str) -> Agent[RunDeps, str]:
        raise TimeoutError("upstream timed out")

    ended = await _failed_run(repo, settings, factory)
    assert (ended.status, ended.code, ended.error) == (
        "failed",
        "internal_error",
        "The assistant failed unexpectedly.",
    )


async def test_an_unexpected_exception_is_an_internal_error(
    repo: Repository, settings: AssistantSettings
) -> None:
    def factory(_: str) -> Agent[RunDeps, str]:
        raise RuntimeError("secret detail")

    ended = await _failed_run(repo, settings, factory)
    assert (ended.status, ended.code, ended.error) == (
        "failed",
        "internal_error",
        "The assistant failed unexpectedly.",
    )


@pytest.mark.parametrize(
    "ended",
    [
        RunEnded(status="failed", error="slow", code="run_timeout"),
        RunEnded(status="cancelled"),
    ],
)
def test_live_and_stored_endings_carry_the_same_data(ended: RunEnded) -> None:
    usage = UsageReported(
        model="m", provider="p", input_tokens=3, output_tokens=2, cache_read_tokens=1
    )
    events = [
        RunStarted(message_id="m1"),
        TextStarted(part_id="m1:1"),
        TextDelta(part_id="m1:1", delta="Hi"),
        usage,
        ended,
    ]
    encoder = AiSdkEncoder()
    chunks = [chunk for event in events for chunk in encoder.encode(event)]
    live_status = next(c for c in chunks if c["type"] == "data-run-status")
    live_usage = next(c for c in chunks if c["type"] == "message-metadata")

    stored = to_ui_message("m1", "assistant", fold_parts(events))
    stored_status = next(p for p in stored["parts"] if p["type"] == "data-run-status")
    assert live_status["data"] == stored_status["data"]
    assert live_usage["messageMetadata"] == stored["metadata"]


SHOWN_PROJECT = UUID(int=0x5E4)
SHOWN_LAYERS = Recorder(
    {
        ("GET", f"/api/v2/project/{SHOWN_PROJECT}"): {"name": "Erreichbarkeit"},
        ("GET", f"/api/v2/project/{SHOWN_PROJECT}/layer"): [
            {
                "id": 34,
                "name": "Supermärkte",
                "layer_id": str(UUID(int=34)),
                "type": "feature",
                "feature_layer_geometry_type": "point",
            }
        ],
    }
)
SHOW_SHOPS = {
    "groups": [
        {"items": [{"kind": "layer", "id": "34", "project_id": str(SHOWN_PROJECT)}]}
    ]
}


def _ends_after_the_card(closing: list[str]) -> tuple[FunctionModel, list[list[Any]]]:
    """A model that shows a layer as a card and then answers with the texts
    of ``closing`` in turn, the last one for good. Records what each call
    was sent after the card."""
    sent: list[list[Any]] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        responses = sum(isinstance(m, ModelResponse) for m in messages)
        if responses == 0:
            call = ToolCallPart(
                tool_name="core_show_items", args=SHOW_SHOPS, tool_call_id="c0"
            )
            return ModelResponse(parts=[call])
        sent.append(list(messages[-1].parts))
        text = closing[min(responses - 1, len(closing) - 1)]
        return ModelResponse(parts=[TextPart(content=text)])

    return FunctionModel(respond), sent


def _deps() -> RunDeps:
    async def emit(event: Any) -> None:
        return None

    return RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(core=SHOWN_LAYERS)),
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )


async def test_an_answer_that_ends_after_its_cards_without_text_is_asked_for_it() -> (
    None
):
    """wf-08: after core_show_items the model's last response was a single
    space. Pydantic AI takes any text that is not empty as the answer, so the
    run ended with the cards and no word on them. Text of only whitespace is
    asked for again."""
    model, sent = _ends_after_the_card(
        [" ", "Der Workflow ist angelegt; du startest ihn mit Run."]
    )
    result = await build_agent(model).run("Erstelle einen Workflow.", deps=_deps())
    assert result.output == "Der Workflow ist angelegt; du startest ihn mit Run."
    [retry] = [part for part in sent[1] if isinstance(part, RetryPromptPart)]
    assert retry.content == NO_ANSWER_TEXT


async def test_a_model_that_never_writes_the_text_ends_as_it_answered() -> None:
    """The text is asked for while retries are left; the last attempt's answer
    ends the run, as before, instead of failing it after the cards were
    shown."""
    model, sent = _ends_after_the_card([" "])
    result = await build_agent(model).run("Build a workflow.", deps=_deps())
    assert result.output == " "
    assert len(sent) == 1 + TOOL_RETRIES


def test_the_request_for_the_text_says_what_to_write() -> None:
    assert "no text" in NO_ANSWER_TEXT
    # A model that wrote its answer before the cards closes without repeating it.
    assert "if your text before the cards said that" in NO_ANSWER_TEXT
    assert (
        "Write" in NO_ANSWER_TEXT and "language of the user's message" in NO_ANSWER_TEXT
    )


# -- an answer whose model writes no text after its results -----------------------

SILENT_PROJECT = "00000000-0000-0000-0000-0000000005e5"
SILENT_WORKFLOW = "0b6f0000-0000-0000-0000-00000000f110"
RUN_CALL = ("workflow_run", {"workflow_id": SILENT_WORKFLOW})
LAST_RUN_CALL = ("workflow_last_run", {"workflow_id": SILENT_WORKFLOW})


def _job(status: str, saved: int) -> dict[str, Any]:
    """The workflow's run as processes reports it, ended with ``status``,
    with ``saved`` export steps that each saved a layer."""
    results: dict[str, Any] = {"tool-walk": {"status": "success", "feature_count": 3}}
    for n in range(saved):
        results[f"save-{n}"] = {
            "status": "success",
            "feature_count": 3,
            "layer_project_id": 100 + n,
        }
    return {
        "jobID": "j1",
        "processID": "workflow_runner",
        "status": status,
        "inputs": {"workflow_id": SILENT_WORKFLOW},
        "created": "2026-10-25T11:12:30Z",
        "result": {"status": "success", "node_results": results},
    }


def _nodes(saved: int) -> list[dict[str, Any]]:
    return [
        {
            "id": "tool-walk",
            "type": "tool",
            "data": {"type": "tool", "processId": "buffer"},
        },
        *(
            {"id": f"save-{n}", "type": "export", "data": {"type": "export"}}
            for n in range(saved)
        ),
    ]


def _thinks_only(
    first_call: tuple[str, dict[str, Any]] | None,
    *,
    raises: Exception | None = None,
    writes: str | None = None,
) -> FunctionModel:
    """A model that makes ``first_call`` when given, and then gives only
    reasoning: no text and no tool call, as the answer step got in a live
    run after a workflow run had finished. ``raises``: raised by the call
    after ``first_call`` instead. ``writes``: the call after ``first_call``
    writes it and looks something up, before the reasoning only."""

    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls | DeltaThinkingCalls]:
        responses = sum(isinstance(message, ModelResponse) for message in messages)
        if first_call is not None and responses == 0:
            name, args = first_call
            yield {
                0: DeltaToolCall(
                    name=name, json_args=json.dumps(args), tool_call_id="c0"
                )
            }
            return
        if raises is not None:
            raise raises
        if writes is not None and responses == 1:
            yield writes
            yield {1: DeltaToolCall(name="core_page_context", tool_call_id="c1")}
            return
        yield {0: DeltaThinkingPart(content="The numbers are in the layer.")}

    return FunctionModel(stream_function=stream)


@dataclass
class Silent:
    ended: RunEnded
    events: list[RunEvent]
    #: The conversation's history after the answer.
    history: list[ModelMessage]
    message_id: UUID


async def _silent_answer(
    repo: Repository,
    settings: AssistantSettings,
    model: FunctionModel,
    *,
    status: str = "successful",
    saved: int = 1,
    then: FunctionModel | None = None,
) -> Silent:
    """One answer on a workflow page whose ``model`` runs or reads the
    workflow's run, which ended with ``status`` and saved ``saved`` layers
    (it is still going when listed, so workflow_run waits for it). With
    ``then``, a next answer on ``then`` follows in the same conversation,
    and that one is returned instead."""
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{SILENT_PROJECT}/workflow/{SILENT_WORKFLOW}"): {
                "id": SILENT_WORKFLOW,
                "config": {"nodes": _nodes(saved), "edges": []},
            },
        }
    )
    job = _job(status, saved)
    processes = Recorder(
        {
            ("GET", "/jobs"): {"jobs": [{**job, "status": "running"}]},
            ("GET", "/jobs/j1"): job,
            ("GET", "/processes"): {"processes": []},
        }
    )
    models = [model, *([then] if then is not None else [])]
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(models.pop(0)),
        tool_services=fake_clients(core=core, processes=processes),
    )
    conversation = UUID(
        str(
            (
                await repo.create_conversation(
                    USER, "project.workflows", UUID(SILENT_PROJECT), None
                )
            )["id"]
        )
    )
    for text in ["Was hat der Lauf ergeben?", "Welche Zahlen?"][: 1 + bool(then)]:
        run_id, message_id = await manager.start_run(
            conversation,
            USER,
            text,
            parse_context(
                {"surface": "project.workflows", "project_id": SILENT_PROJECT}
            ),
            locale="de",
            login=StaticLogin("token"),
            target=UUID(SILENT_PROJECT),
        )
        await manager.wait(run_id)
    return Silent(
        ended=await _ended(repo, run_id),
        events=[event for _, event in await repo.list_events(run_id)],
        history=ModelMessagesTypeAdapter.validate_python(
            await repo.history(conversation)
        ),
        message_id=message_id,
    )


def _caveats(events: list[RunEvent]) -> list[DataPart]:
    return [e for e in events if isinstance(e, DataPart) and e.name == "caveat"]


async def test_an_answer_without_text_after_a_run_that_saved_layers_ends_with_a_fixed_text(
    repo: Repository, settings: AssistantSettings, caplog: pytest.LogCaptureFixture
) -> None:
    """A live answer ended as internal_error after a run that saved its
    layers: the answer step got only reasoning until Pydantic AI gave up on
    its output retries. The run card and the layers are there, so the answer
    ends with a fixed text the dock shows in the user's language, the run
    completes, and the log says why."""
    caplog.set_level(logging.WARNING, logger="assistant.runs.turn")
    answer = await _silent_answer(repo, settings, _thinks_only(RUN_CALL))
    assert (answer.ended.status, answer.ended.code, answer.ended.error) == (
        "succeeded",
        None,
        None,
    )
    caveats = _caveats(answer.events)
    assert [caveat.data for caveat in caveats] == [
        {"kind": "no_answer", "text": NO_ANSWER_CAVEAT}
    ]
    # After the run card and the run's result: the last of the answer's parts.
    assert any(
        isinstance(e, DataPart) and e.name == "workflow-run" for e in answer.events
    )
    assert answer.events.index(caveats[0]) > max(
        answer.events.index(e)
        for e in answer.events
        if isinstance(e, ToolReturned) or isinstance(e, DataPart) and e != caveats[0]
    )
    # The next answer reads the run's result and what the dock showed.
    assert any(
        isinstance(part, ToolReturnPart) and part.tool_name == "workflow_run"
        for message in answer.history
        for part in message.parts
    )
    last = answer.history[-1]
    assert isinstance(last, ModelResponse)
    assert last.parts[-1] == TextPart(content=NO_ANSWER_CAVEAT)
    [logged] = [r for r in caplog.records if r.name == "assistant.runs.turn"]
    assert logged.levelno == logging.WARNING
    assert str(answer.message_id) in logged.getMessage()
    assert "Exceeded maximum output retries (3)" in logged.getMessage()


async def test_the_next_answer_reads_the_fixed_text_and_the_runs_result(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The user asks for the numbers: the next answer gets the run's result
    and the fixed text in its history, and answers."""
    sent: list[list[ModelMessage]] = []

    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        sent.append(list(messages))
        yield "163 von 218 Flächen liegen teils außerhalb."

    answer = await _silent_answer(
        repo,
        settings,
        _thinks_only(RUN_CALL),
        then=FunctionModel(stream_function=stream),
    )
    assert (answer.ended.status, answer.ended.code) == ("succeeded", None)
    [request] = sent
    parts = [part for message in request for part in message.parts]
    assert TextPart(content=NO_ANSWER_CAVEAT) in parts
    assert any(
        isinstance(part, ToolReturnPart) and part.tool_name == "workflow_run"
        for part in parts
    )
    assert answer.history[-1].parts == [
        TextPart(content="163 von 218 Flächen liegen teils außerhalb.")
    ]


@pytest.mark.parametrize(
    ("model", "status", "saved"),
    [
        # No result at all.
        (_thinks_only(None), "successful", 1),
        # A run that failed: no layers, no numbers.
        (_thinks_only(RUN_CALL), "failed", 0),
        # A run that saved no layer.
        (_thinks_only(RUN_CALL), "successful", 0),
        # A run read with workflow_last_run, which shows no run card.
        (_thinks_only(LAST_RUN_CALL), "successful", 1),
        # Text written after the result: the answer is not empty.
        (_thinks_only(RUN_CALL, writes="The run saved one layer."), "successful", 1),
    ],
)
async def test_without_a_shown_run_that_saved_layers_and_no_text_since_it_still_fails(
    repo: Repository,
    settings: AssistantSettings,
    model: FunctionModel,
    status: str,
    saved: int,
) -> None:
    answer = await _silent_answer(repo, settings, model, status=status, saved=saved)
    assert (answer.ended.status, answer.ended.code) == ("failed", "internal_error")
    assert _caveats(answer.events) == []


@pytest.mark.parametrize(
    ("raised", "code"),
    [
        (ContentFilterError("Content filter triggered.", body="{}"), "internal_error"),
        (IncompleteToolCall("The tool call was cut off."), "internal_error"),
        (ModelAPIError("test", "Connection error."), "goat_ai_unreachable"),
    ],
)
async def test_other_failures_after_a_run_that_saved_layers_still_fail(
    repo: Repository, settings: AssistantSettings, raised: Exception, code: str
) -> None:
    """A provider's filter, a tool call cut off at the token limit and a
    provider that cannot be reached end the answer as before."""
    answer = await _silent_answer(repo, settings, _thinks_only(RUN_CALL, raises=raised))
    assert (answer.ended.status, answer.ended.code) == ("failed", code)
    assert _caveats(answer.events) == []


def test_the_fixed_text_says_what_happened_and_what_to_do() -> None:
    assert NO_ANSWER_CAVEAT.startswith("The assistant could not write this answer.")
    assert "workflow run is shown above" in NO_ANSWER_CAVEAT
    assert "layers it saved" in NO_ANSWER_CAVEAT
    assert "Ask for the numbers" in NO_ANSWER_CAVEAT
