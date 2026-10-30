"""The stages of an answer keep the provider's cached prefix, and the budget
holds with production numbers.

Every model call of an answer offers the same tools and sends the same system
text, so the provider reads the answer so far from its cache; the stage rules
apply when a call runs (``assistant.tools.toolset``), and the note on the
stage is the last content of the request (``assistant.agent.StageNote``). The
budget counts the calls that end an answer at the share the newest call read
from the cache (``assistant.budget``). The token numbers are the production
ones: the run limit from the settings, a first call of about 40,000 input
tokens, 2,000 to 6,000 more per call, and 90 % of a call's input read from the
cache while its prefix holds."""

import json
import math
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from typing import Any

import httpx2
import pytest
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import StreamedResponse
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RequestUsage, RunUsage

from assistant.agent import STAGE_KEY, RunDeps, build_agent
from assistant.asks import AskHistory, AskUserInput, CardAnswer
from assistant.budget import (
    CACHE_READ_WEIGHT,
    RESULT_READS,
    RunBudget,
    next_call,
    weighted_tokens,
)
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.events import DataPart
from assistant.llm.endpoints import EndpointPolicy
from assistant.llm.providers import Target, open_models
from assistant.prompt import (
    ADD_WHAT_WAS_PICKED,
    ANSWER_NOW,
    ANSWER_NOW_CARD,
    CARD_AFTER_TEXT,
    RUN_WHAT_YOU_BUILT,
    as_note,
    read_the_result,
    render_note,
    with_note,
)
from assistant.runs.turn import Turn, run_turn
from assistant.tools.ask import REPEATED_CARD, REPORT_FIRST
from assistant.tools.testing import Recorder, fake_clients, stage_note, tool_env
from assistant.tools.toolset import (
    ANSWER_STEP_REFUSALS,
    STAGE_REFUSALS,
    Stage,
    _tool,
    answer_step,
    runnable_workflows,
)
from assistant.tools.workflow_runs import RUN
from tests.test_ask_user import (
    CARD,
    LAST_RUN_CALL,
    LOOK_UP,
    READ_CALL,
    RUN_PROJECT,
    RUN_WORKFLOW,
    Response,
    _answer_run,
    _finished_run,
    _results,
    _retries,
    _stage,
)
from tests.test_history_budget import (
    PROVIDER_CHARS_PER_TOKEN,
    _profile_core,
    _sent_chars,
)

DEFAULTS = AssistantSettings.model_fields
#: The run's limits as the settings set them.
PRODUCTION = RunBudget(
    max_tokens=DEFAULTS["run_max_tokens"].default,
    max_tool_calls=DEFAULTS["run_max_tool_calls"].default,
)
#: The first call's input: the instructions, the tools and the conversation.
FIRST_CALL = 40_000
#: What a call writes, its reasoning among it.
OUTPUT = 700
#: The share of a call's input read from the cache while its prefix holds.
CACHED_SHARE = 0.9
GROWTHS = [2_000, 3_000, 4_000, 5_000, 6_000]
#: A look-up whose result the provider counts at about ``growth - OUTPUT``
#: tokens (``_answer``): with the output of the call that made it, a call
#: grows by about ``growth`` tokens.
SIZED_LOOK_UP: Response = [("core_whoami", {})]

ANSWER = "The run buffered 3 features."


@dataclass
class _Call:
    tools: list[str]
    instructions: str | None
    #: The stage note the call's request ended with; None in a look-up step.
    note: str | None
    usage: RequestUsage
    #: The request's tool_choice setting; None when it set none.
    tool_choice: Any = None
    #: What the call was sent, its stage note left out: what the next call
    #: sends again first while the prefix holds.
    prefix: Any = None


def _sent_again(messages: list[ModelMessage], note: str | None) -> Any:
    """``messages`` as the provider reads them, without the stage note that
    ended them: the note is not in the history the next call sends."""
    if note is not None:
        last = messages[-1]
        assert isinstance(last, ModelRequest)
        messages = [*messages[:-1], replace(last, parts=list(last.parts[:-1]))]
    return ModelMessagesTypeAdapter.dump_python(messages, mode="json")


#: What the model does in a call: from the call's number and its stage note.
Act = Callable[[int, str | None], Response]


class _Production(FunctionModel):
    """A streamed model with a provider's usage at production numbers: the
    first call reads ``FIRST_CALL`` input tokens, each later call the input
    and output of the call before it and the results it sends (at
    ``PROVIDER_CHARS_PER_TOKEN``), and every call writes ``OUTPUT``. A call
    reads ``share(n)`` of its input from the cache while its prefix holds:
    it offers the same tools with the same instructions as the call before
    it and starts with the messages that call was sent; the first call reads
    it from the conversation before the answer. What it does is ``act``'s
    choice; a request with tool_choice "none" gets text only, as a provider
    gives it, unless the model ignores that (``honors_tool_choice``)."""

    def __init__(
        self,
        act: Act,
        *,
        share: Callable[[int], float],
        honors_tool_choice: bool = True,
    ) -> None:
        super().__init__(stream_function=self._stream)
        self.act, self.share = act, share
        self.honors_tool_choice = honors_tool_choice
        self.calls: list[_Call] = []

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        n = len(self.calls)
        tools = [tool.name for tool in info.function_tools]
        note = stage_note(messages)
        prefix = _sent_again(messages, note)
        previous_call = self.calls[-1] if self.calls else None
        held = previous_call is None or (
            tools == previous_call.tools
            and info.instructions == previous_call.instructions
            and prefix[: len(previous_call.prefix)] == previous_call.prefix
        )
        if self.calls:
            previous = self.calls[-1].usage
            sent = math.ceil(_sent_chars(messages[-1]) / PROVIDER_CHARS_PER_TOKEN)
            input_tokens = previous.input_tokens + previous.output_tokens + sent
        else:
            input_tokens = FIRST_CALL
        cached = round(self.share(n) * input_tokens) if held else 0
        usage = RequestUsage(
            input_tokens=input_tokens, cache_read_tokens=cached, output_tokens=OUTPUT
        )
        tool_choice = (info.model_settings or {}).get("tool_choice")
        self.calls.append(
            _Call(tools, info.instructions, note, usage, tool_choice, prefix)
        )
        response = self.act(n, note)
        if tool_choice == "none" and self.honors_tool_choice:
            response = [item for item in response if isinstance(item, str)] or [ANSWER]
        for index, item in enumerate(response):
            if isinstance(item, str):
                yield item
            else:
                name, args = item
                yield {
                    index: DeltaToolCall(
                        name=name,
                        json_args=json.dumps(args),
                        tool_call_id=f"call-{n}-{index}",
                    )
                }

    @asynccontextmanager
    async def request_stream(
        self, *args: Any, **kwargs: Any
    ) -> AsyncIterator[StreamedResponse]:
        async with super().request_stream(*args, **kwargs) as response:
            response._usage = self.calls[-1].usage
            yield response


@dataclass
class _Answered:
    turn: Turn
    model: _Production
    usage: RunUsage
    deps: RunDeps
    shown: list[DataPart] = field(default_factory=list)

    def notes(self) -> list[str | None]:
        return [call.note for call in self.model.calls]

    def looked_up(self) -> float:
        """The weighted tokens of the answer's look-up calls."""
        return sum(
            _weighted(call.usage) for call in self.model.calls if call.note is None
        )


def _weighted(usage: RequestUsage) -> float:
    cached = usage.cache_read_tokens
    return (
        usage.input_tokens - cached + cached * CACHE_READ_WEIGHT + usage.output_tokens
    )


async def _answer(
    act: Act,
    *,
    growth: int,
    share: float | Callable[[int], float] = CACHED_SHARE,
    budget: RunBudget = PRODUCTION,
    created: Sequence[str] = (),
    honors_tool_choice: bool = True,
) -> _Answered:
    """One answer on a workflow page under ``budget``, as the run manager runs
    it. The open project's workflow has a finished run that saved a layer, and
    a look-up (``SIZED_LOOK_UP``) grows the next call by about ``growth``
    tokens. The workflows in ``created`` were created in this answer."""
    job, nodes = _finished_run(1)
    padding = PROVIDER_CHARS_PER_TOKEN * (growth - OUTPUT)
    core = Recorder(
        {
            **_profile_core(padding).routes,
            ("GET", f"/api/v2/project/{RUN_PROJECT}/workflow/{RUN_WORKFLOW}"): {
                "id": RUN_WORKFLOW,
                "config": {"nodes": nodes, "edges": []},
            },
            ("GET", f"/api/v2/project/{RUN_PROJECT}"): {"name": "Run project"},
            ("GET", f"/api/v2/project/{RUN_PROJECT}/layer"): [],
            ("GET", f"/api/v2/project/{RUN_PROJECT}/group"): [],
        }
    )
    processes = Recorder(
        {
            ("GET", "/jobs"): {"jobs": [{**job, "status": "running"}]},
            ("GET", "/jobs/j1"): job,
            ("GET", "/processes"): {"processes": []},
        }
    )
    page = parse_context({"surface": "project.workflows", "project_id": RUN_PROJECT})
    shown: list[DataPart] = []

    async def emit(event: Any) -> None:
        if isinstance(event, DataPart) and event.name == "ask":
            shown.append(event)

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        prompt_note=render_note(page, None, "en"),
        budget=budget,
    )
    deps.env = tool_env(
        fake_clients(core=core, processes=processes),
        page=page,
        emit_data=deps.emit_data,
    )
    deps.env.workflows_created.update(created)
    deps.env.runs.created.update(created)

    async def on_event(event: Any) -> None:
        return None

    model = _Production(
        act,
        share=share if callable(share) else lambda n: share,
        honors_tool_choice=honors_tool_choice,
    )
    usage = RunUsage()
    turn = await run_turn(
        build_agent(model),
        with_note(deps.prompt_note, "How many features did the run buffer?"),
        deps=deps,
        on_event=on_event,
        usage_limits=budget.usage_limits(),
        usage=usage,
    )
    return _Answered(turn=turn, model=model, usage=usage, deps=deps, shown=shown)


def _look_up_then_answer(n: int, note: str | None) -> Response:
    return SIZED_LOOK_UP if note is None else [ANSWER]


# -- one tool list and one system text, the note after the history ---------------


#: The production model's name and route: DeepSeek through OpenRouter.
OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash-1017"


def _without_cache_markers(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_cache_markers(item)
            for key, item in value.items()
            if key != "cache_control"
        }
    if isinstance(value, list):
        return [_without_cache_markers(item) for item in value]
    return value


#: An assistant message that looks the page up, as the provider sends it.
LOOK_UP_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": None,
    "tool_calls": [
        {
            "id": "call",
            "type": "function",
            "function": {"name": "core_page_context", "arguments": "{}"},
        }
    ],
}
FOUND = "Here is what I found."


async def _through_openrouter(
    reply: Callable[[int, dict[str, Any]], dict[str, Any]],
) -> tuple[Any, list[dict[str, Any]]]:
    """A run on the production model's route (DeepSeek through OpenRouter)
    against a fake endpoint: call ``n`` with request body ``body`` gets the
    assistant message ``reply(n, body)``, with a provider's usage (a first
    call of ``FIRST_CALL`` tokens, 6,000 more each call, ``CACHED_SHARE``
    read from the cache). The run's result and the request bodies."""
    bodies: list[dict[str, Any]] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        bodies.append(body)
        n = len(bodies) - 1
        message = reply(n, body)
        if message.get("tool_calls"):
            message = {
                **message,
                "tool_calls": [
                    {**call, "id": f"call-{n}"} for call in message["tool_calls"]
                ],
            }
        prompt = FIRST_CALL + n * 6_000
        return httpx2.Response(
            200,
            json={
                "id": f"c{n}",
                "object": "chat.completion",
                "created": 0,
                "model": OPENROUTER_MODEL,
                "provider": "DeepSeek",
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": (
                            "tool_calls" if message.get("tool_calls") else "stop"
                        ),
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt,
                    "completion_tokens": OUTPUT,
                    "total_tokens": prompt + OUTPUT,
                    "prompt_tokens_details": {
                        "cached_tokens": round(CACHED_SHARE * prompt)
                    },
                },
            },
        )

    models = open_models(
        Target(
            connection_id=None,
            provider="openai_compatible",
            model=OPENROUTER_MODEL,
            base_url="https://openrouter.ai/api/v1",
            credentials={"api_key": "sk-test"},
        ),
        EndpointPolicy(),
        transport=httpx2.MockTransport(endpoint),
    )
    page = parse_context(None)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(), page=page),
        prompt_note=render_note(page, None, "en"),
        budget=PRODUCTION,
    )
    try:
        result = await build_agent(models.main).run(
            with_note(deps.prompt_note, "where am I?"), deps=deps
        )
    finally:
        await models.aclose()
    return result, bodies


def _noted(body: dict[str, Any]) -> bool:
    """Whether a request body ends with the note to answer now."""
    last = body["messages"][-1]
    return last["role"] == "user" and ANSWER_NOW in str(last["content"])


async def test_the_provider_gets_one_tool_list_and_one_system_text_and_the_note_last() -> (
    None
):
    """Through the production mapping (OpenAI's chat format, OpenRouter): a
    look-up call and the answer step send the same tools and the same system
    text, each request starts with the whole request before it, and the
    stage note is the last message, so the provider reads everything before
    it from its cache."""

    def reply(n: int, body: dict[str, Any]) -> dict[str, Any]:
        if _noted(body):
            return {"role": "assistant", "content": FOUND}
        return LOOK_UP_MESSAGE

    result, bodies = await _through_openrouter(reply)
    assert result.output == "Here is what I found."
    *looking, answering = [_without_cache_markers(body) for body in bodies]
    assert len(looking) >= 2
    # The same tools in every call, all of the page's.
    tools = [json.dumps(body["tools"], sort_keys=True) for body in bodies]
    assert len(set(tools)) == 1 and "ask_user" in tools[0] and "core_find" in tools[0]
    # The same system text first in every call.
    systems = [
        [m for m in body["messages"] if m["role"] == "system"] for body in bodies
    ]
    assert all(system == systems[0] and system for system in systems)
    assert all(body["messages"][0]["role"] == "system" for body in bodies)
    # Each request starts with the whole request before it: the cached prefix.
    for before, after in zip(bodies, bodies[1:]):
        sent = _without_cache_markers(before["messages"])
        assert _without_cache_markers(after["messages"][: len(sent)]) == sent
    # A look-up step ends with its results; the answer step with the note.
    assert all(body["messages"][-1]["role"] == "tool" for body in looking[1:])
    assert all(ANSWER_NOW not in json.dumps(body) for body in looking)
    assert answering["messages"][-1] == {
        "role": "user",
        "content": as_note(f"{ANSWER_NOW} {ANSWER_NOW_CARD} {CARD_AFTER_TEXT}"),
    }
    assert answering["messages"][-2]["role"] == "tool"
    # The stage recorded in the history is not sent.
    assert all(STAGE_KEY not in json.dumps(body) for body in bodies)
    stored = [m for m in result.all_messages() if isinstance(m, ModelRequest)]
    assert [(m.metadata or {}).get(STAGE_KEY) for m in stored] == [
        *["look up"] * len(looking),
        "answer or ask",
    ]


async def test_after_a_refused_step_the_provider_gets_tool_choice_none() -> None:
    """The step after one whose calls were all refused answers in text: the
    request sends tool_choice "none" with the same tools, so the provider
    still reads its prefix from the cache."""

    def reply(n: int, body: dict[str, Any]) -> dict[str, Any]:
        if _noted(body) and body.get("tool_choice") != "none":
            return LOOK_UP_MESSAGE
        if _noted(body):
            return {"role": "assistant", "content": FOUND}
        return LOOK_UP_MESSAGE

    result, bodies = await _through_openrouter(reply)
    assert result.output == FOUND
    *before, refused, answering = bodies
    assert refused.get("tool_choice") in (None, "auto")
    assert answering["tool_choice"] == "none"
    assert answering["tools"] == bodies[0]["tools"]
    sent = _without_cache_markers(refused["messages"][:-1])
    assert _without_cache_markers(answering["messages"][: len(sent)]) == sent


async def test_every_stage_offers_the_same_tools_and_instructions() -> None:
    """Look-ups, the read step and the answer step: one tool list and one
    instruction text, so the provider reads each call's prefix from its
    cache."""
    answered = await _answer(_run_then_read(at=3), growth=4_000)
    reading = next(note for note in answered.notes() if note is not None)
    assert read_the_result(RESULT_READS) in reading
    first = answered.model.calls[0]
    assert "workflow_run" in first.tools and "ask_user" in first.tools
    for call in answered.model.calls:
        assert (call.tools, call.instructions) == (first.tools, first.instructions)
        assert call.usage.cache_read_tokens > 0


# -- the stage rules at call time ---------------------------------------------------


@dataclass(frozen=True)
class _Refused:
    #: The responses before the one in the stage.
    before: list[Response]
    #: The response in the stage: a call the stage does not allow.
    call: tuple[str, dict[str, Any]]
    max_tool_calls: int


REFUSED: dict[Stage, _Refused] = {
    # The look-ups are spent (five of 30 tool calls kept), the result of the
    # run is unreported: it may be read, or the user asked.
    "read or ask": _Refused(
        [*[LOOK_UP] * 24, [LAST_RUN_CALL]], ("core_page_context", {}), 30
    ),
    # The run took the run's only tool call: no card fits.
    "read": _Refused([[LAST_RUN_CALL]], ("ask_user", CARD), 1),
    "answer or ask": _Refused([LOOK_UP] * 25, ("core_page_context", {}), 30),
    "answer": _Refused([LOOK_UP], ("ask_user", CARD), 1),
}


@pytest.mark.parametrize("stage", list(REFUSED))
async def test_a_call_the_stage_does_not_allow_is_refused_and_counted(
    stage: Stage,
) -> None:
    case = REFUSED[stage]
    answered = await _answer_run(
        *case.before,
        [case.call],
        budget=RunBudget(
            max_tokens=PRODUCTION.max_tokens, max_tool_calls=case.max_tool_calls
        ),
    )
    name = case.call[0]
    refused = _results(answered.turn, name)[-1]
    assert refused.outcome == "failed" and refused.content == STAGE_REFUSALS[stage]
    assert "\n" not in STAGE_REFUSALS[stage]
    assert answered.shown == []
    # Counted toward the run's tool-call limit.
    assert list(answered.deps.admitted_calls.values()) == [len(case.before) + 1]
    assert answered.turn.output == "The run buffered 3 features."


def test_each_refusal_says_what_to_do_instead() -> None:
    assert set(STAGE_REFUSALS) == {"read or ask", "read", "answer or ask", "answer"}
    for stage, refusal in STAGE_REFUSALS.items():
        assert refusal.startswith("This call did not run")
        assert "budget" not in refusal.lower()
        assert ("ask_user" in refusal) is stage.endswith("ask")
        assert ("workflow_describe_tool" in refusal) is stage.startswith("read")


# -- the budget with production numbers --------------------------------------------


@pytest.mark.parametrize("growth", GROWTHS)
async def test_an_answer_reading_from_the_cache_looks_up_past_half_its_limit(
    growth: int,
) -> None:
    """At 90 % read from the cache, the look-ups go on past 100,000 weighted
    tokens: the calls that end the answer are counted at the share the newest
    call read from the cache. The answer still ends within the limit."""
    answered = await _answer(_look_up_then_answer, growth=growth)
    assert answered.turn.output == ANSWER
    assert answered.looked_up() > 100_000
    assert weighted_tokens(answered.usage) <= PRODUCTION.max_tokens
    notes = answered.notes()
    assert all(note is not None for note in notes[_first_note(answered) :])


@pytest.mark.parametrize("growth", GROWTHS)
async def test_without_cache_reads_an_answer_still_ends_within_the_limit(
    growth: int,
) -> None:
    """A provider that reports no cache reads: the calls that end the answer
    are sized at their whole context."""
    answered = await _answer(_look_up_then_answer, growth=growth, share=0.0)
    assert answered.turn.output == ANSWER
    assert weighted_tokens(answered.usage) <= PRODUCTION.max_tokens


def _run_then_read(at: int, run: Response = (LAST_RUN_CALL,)) -> Act:
    """Looks up, runs the workflow in call ``at`` (``run``), and looks up on
    until the look-ups end; then reads the run's result once and writes its
    answer."""
    read = False

    def act(n: int, note: str | None) -> Response:
        nonlocal read
        if note is None:
            return list(run) if n == at else SIZED_LOOK_UP
        if not read and read_the_result(RESULT_READS) in note:
            read = True
            return [READ_CALL]
        return [ANSWER]

    return act


@pytest.mark.parametrize("share", [CACHED_SHARE, 0.0])
@pytest.mark.parametrize("growth", GROWTHS)
async def test_a_finished_runs_result_is_read_after_the_last_look_up(
    growth: int, share: float
) -> None:
    """The answer runs its workflow in a look-up and looks up on without
    writing about it, or runs it in its last look-up: the step after the
    look-ups may still read the result, and the answer that follows fits."""
    dry = await _answer(_look_up_then_answer, growth=growth, share=share)
    last = _first_note(dry) - 1
    runs: list[tuple[int, Response]] = [
        *((at, [LAST_RUN_CALL]) for at in range(max(last - 2, 0), last + 1)),
        # The dry run's last look-up and the run in one step: no look-up
        # follows it.
        (last, [*SIZED_LOOK_UP, LAST_RUN_CALL]),
    ]
    for at, run in runs:
        answered = await _answer(_run_then_read(at, run), growth=growth, share=share)
        notes = answered.notes()
        assert notes[at] is None
        reading = notes[_first_note(answered)]
        assert read_the_result(RESULT_READS) in reading, (at, notes)
        [read] = _results(answered.turn, READ_CALL[0])
        assert read.outcome != "failed"
        assert answered.turn.output == ANSWER
        assert weighted_tokens(answered.usage) <= PRODUCTION.max_tokens
    # The run took the last look-up.
    assert _first_note(answered) == last + 1


def _first_note(answered: _Answered) -> int:
    """The number of the answer's first call after its look-ups."""
    return next(n for n, note in enumerate(answered.notes()) if note is not None)


async def test_no_stage_flips_back_to_look_ups() -> None:
    """Once an answer's look-ups are over they stay over, also when the
    answer step reads far more from the cache than the look-ups did, which
    leaves the budget room for another look-up on paper."""
    # Without cache reads, the look-ups end early; the first answer step is
    # found in a dry run. From it on, every call reads 99 % from the cache.
    dry = await _answer(_look_up_then_answer, growth=4_000, share=0.0)
    first = _first_note(dry)

    def share(n: int) -> float:
        return 0.99 if n >= first else 0.0

    def act(n: int, note: str | None) -> Response:
        if note is None:
            return SIZED_LOOK_UP
        # The answer step tries one more look-up.
        return [("core_page_context", {})] if n == first else [ANSWER]

    answered = await _answer(act, growth=4_000, share=share)
    notes = answered.notes()
    assert notes[:first] == [None] * first
    assert all(note is not None for note in notes[first:])
    assert len(notes) == first + 2
    refused = _results(answered.turn, "core_page_context")[-1]
    assert refused.content == STAGE_REFUSALS["answer or ask"]
    assert answered.turn.output == ANSWER


# -- calls past the plan ------------------------------------------------------------


def _insisting(tries: int | None = None) -> Act:
    """Looks things up while it may; after the look-ups, calls
    core_page_context again, ``tries`` times or every time, then writes its
    answer."""
    made = 0

    def act(n: int, note: str | None) -> Response:
        nonlocal made
        if note is None:
            return SIZED_LOOK_UP
        if tries is None or made < tries:
            made += 1
            return [("core_page_context", {})]
        return [ANSWER]

    return act


@pytest.mark.parametrize("share", [CACHED_SHARE, 0.0])
@pytest.mark.parametrize("growth", GROWTHS)
async def test_after_a_step_of_refused_calls_the_answer_comes_in_text(
    growth: int, share: float
) -> None:
    """A model that keeps calling what the step that answers refuses: each
    attempt is a model call of the whole context. After a step whose calls
    were all refused, the next call is sent with tool_choice "none" and the
    same tools, so the provider still reads its prefix from the cache, and
    the answer comes in text."""
    answered = await _answer(_insisting(), growth=growth, share=share)
    assert answered.turn.output == ANSWER
    first = _first_note(answered)
    calls = answered.model.calls
    assert len(calls) == first + 2
    [refused] = _results(answered.turn, "core_page_context")
    assert refused.content == STAGE_REFUSALS[_stage(calls[first].note)]
    assert [call.tool_choice for call in calls] == [None] * (first + 1) + ["none"]
    assert calls[-1].tools == calls[0].tools
    assert _stage(calls[-1].note) == "answer"
    assert (calls[-1].usage.cache_read_tokens > 0) is (share > 0)
    assert weighted_tokens(answered.usage) <= PRODUCTION.max_tokens


async def test_a_step_with_a_call_that_ran_is_not_cut_short() -> None:
    """Only a step whose calls were all refused ends in text: one that ran
    a workflow beside a refused second run still reads its result."""
    answered = await _answer_run(
        *SPENT,
        [RUN_CALL, OTHER_RUN_CALL],
        budget=PRODUCTION,
        created=[RUN_WORKFLOW, OTHER_WORKFLOW],
    )
    assert _stage(answered.notes[26]) == "read or ask"


@pytest.mark.parametrize("growth", GROWTHS)
async def test_without_cache_reads_two_refused_look_ups_still_end_in_an_answer(
    growth: int,
) -> None:
    """A provider that caches nothing, and a model that calls a refused tool
    in two steps (its provider ignores tool_choice): two calls of the whole
    context past the plan. The hard limit leaves room for one such call
    beyond the plan's, so the run answers."""
    answered = await _answer(
        _insisting(2), growth=growth, share=0.0, honors_tool_choice=False
    )
    assert len(_results(answered.turn, "core_page_context")) == 2
    assert answered.turn.output == ANSWER


@pytest.mark.parametrize("growth", GROWTHS)
async def test_without_cache_reads_two_refused_cards_still_end_in_an_answer(
    growth: int,
) -> None:
    """A provider that caches nothing; the workflow runs in the answer's
    last look-up, and the model then sends its card without text twice,
    both refused until the result is written about (``REPORT_FIRST``): two
    calls past the plan. The hard limit leaves room for one call of the
    whole context beyond the plan's, so the run answers."""
    dry = await _answer(_look_up_then_answer, growth=growth, share=0.0)
    last = _first_note(dry) - 1
    cards = 0

    def act(n: int, note: str | None) -> Response:
        nonlocal cards
        if note is None:
            return [*SIZED_LOOK_UP, LAST_RUN_CALL] if n == last else SIZED_LOOK_UP
        if ANSWER_NOW_CARD in note and cards < 2:
            cards += 1
            return [("ask_user", CARD)]
        return [ANSWER]

    answered = await _answer(act, growth=growth, share=0.0)
    refused = _results(answered.turn, "ask_user")
    assert [part.content for part in refused] == [REPORT_FIRST, REPEATED_CARD]
    assert answered.turn.output == ANSWER


async def test_a_run_the_answer_step_started_is_not_offered_again() -> None:
    """A run the step that answers started counts once started, whatever
    came of it: one that failed is not offered again."""
    answered = await _answer_run(
        *SPENT,
        [OTHER_RUN_CALL],
        [OTHER_RUN_CALL],
        budget=PRODUCTION,
        created=[OTHER_WORKFLOW],
    )
    assert RUN_WHAT_YOU_BUILT in str(answered.notes[25])
    failed, again = _results(answered.turn, "workflow_run")
    assert failed.outcome == "failed"
    assert failed.content != ANSWER_STEP_REFUSALS["workflow_run"]
    assert RUN_WHAT_YOU_BUILT not in str(answered.notes[26])
    assert again.content == ANSWER_STEP_REFUSALS["workflow_run"]


async def test_a_run_that_failed_still_takes_its_step() -> None:
    """One run per step: a second workflow does not run in the step of one
    that failed."""
    answered = await _answer_run(
        *SPENT,
        [OTHER_RUN_CALL, RUN_CALL],
        budget=PRODUCTION,
        created=[OTHER_WORKFLOW, RUN_WORKFLOW],
    )
    failed, second = _results(answered.turn, "workflow_run")
    assert failed.outcome == "failed"
    assert failed.content != ANSWER_STEP_REFUSALS["workflow_run"]
    assert second.content == ANSWER_STEP_REFUSALS["workflow_run"]


# -- a cache miss at the answer step -----------------------------------------------


async def test_an_answer_step_that_misses_the_cache_still_answers() -> None:
    """The calls that end an answer are planned at the cache reads of the
    newest call. A provider that misses its cache on the answer step charges
    its whole context: the hard limit leaves room for that one call, so the
    run answers, and the plan stays the same."""
    over = []
    for growth in GROWTHS:
        cached = await _answer(_look_up_then_answer, growth=growth)
        first = _first_note(cached)

        def share(n: int, first: int = first) -> float:
            return CACHED_SHARE if n < first else 0.0

        missed = await _answer(_look_up_then_answer, growth=growth, share=share)
        assert missed.turn.output == ANSWER
        assert missed.notes() == cached.notes()
        assert missed.model.calls[first].usage.cache_read_tokens == 0
        over.append(weighted_tokens(missed.usage) > PRODUCTION.max_tokens)
    # Past the planned tokens: without the room the miss would fail the run.
    assert any(over)


# -- what the step that answers may still do ---------------------------------------

RUN_CALL: tuple[str, dict[str, Any]] = ("workflow_run", {"workflow_id": RUN_WORKFLOW})
OTHER_WORKFLOW = "0b6f0000-0000-0000-0000-00000000f11f"
OTHER_RUN_CALL: tuple[str, dict[str, Any]] = (
    "workflow_run",
    {"workflow_id": OTHER_WORKFLOW},
)
#: Look-ups that spend the run's tool calls (five of 30 kept in reserve): the
#: step after them, number 25, answers, with room for a card.
SPENT: list[Response] = [LOOK_UP] * 25


async def test_the_answer_step_runs_the_workflow_this_answer_built() -> None:
    """Pass 7 (Q29, Q31, Q38, Q43): the look-ups ended right after the
    workflow was created, and the only move left was a card asking whether
    to run it. The step that answers may still run it, and the result is
    read before the answer."""
    answered = await _answer_run(
        *SPENT, [RUN_CALL], budget=PRODUCTION, created=[RUN_WORKFLOW]
    )
    note = answered.notes[25]
    assert _stage(note) == "answer or ask"
    assert RUN_WHAT_YOU_BUILT in str(note)
    [run] = _results(answered.turn, "workflow_run")
    assert run.outcome != "failed"
    assert isinstance(run.content, dict) and run.content["status"] == "succeeded"
    assert _stage(answered.notes[26]) == "read or ask"
    assert answered.turn.output == ANSWER


@pytest.mark.parametrize(
    ("before", "call", "created", "offered"),
    [
        # A workflow this answer did not create, beside one it did.
        (SPENT, OTHER_RUN_CALL, [RUN_WORKFLOW], True),
        # A workflow of the project the answer did not create.
        (SPENT, RUN_CALL, [], False),
        # The answer ran it already and wrote about its result.
        (
            [[RUN_CALL], [ANSWER, *LOOK_UP], *[LOOK_UP] * 23],
            RUN_CALL,
            [RUN_WORKFLOW],
            False,
        ),
    ],
)
async def test_the_answer_step_runs_no_other_workflow(
    before: list[Response],
    call: tuple[str, dict[str, Any]],
    created: list[str],
    offered: bool,
) -> None:
    answered = await _answer_run(*before, [call], budget=PRODUCTION, created=created)
    note = answered.notes[25]
    assert _stage(note) == "answer or ask"
    assert (RUN_WHAT_YOU_BUILT in str(note)) is offered
    refused = _results(answered.turn, "workflow_run")[-1]
    assert refused.outcome == "failed"
    assert refused.content == ANSWER_STEP_REFUSALS["workflow_run"]
    assert answered.turn.output == ANSWER


async def test_the_answer_step_runs_one_workflow_before_its_result_is_read() -> None:
    """Two workflows built in the answer: the step runs one, whose result
    takes the room kept for reading, and refuses the other."""
    answered = await _answer_run(
        *SPENT,
        [RUN_CALL, OTHER_RUN_CALL],
        budget=PRODUCTION,
        created=[RUN_WORKFLOW, OTHER_WORKFLOW],
    )
    first, second = _results(answered.turn, "workflow_run")
    assert first.outcome != "failed"
    assert second.outcome == "failed"
    assert second.content == ANSWER_STEP_REFUSALS["workflow_run"]
    assert _stage(answered.notes[26]) == "read or ask"


#: The newest call of a run near its limits: a context of 100,000 tokens,
#: 90 % of them read from the cache. A step that answers from it costs
#: 19,703 (10,703 uncached and 90,000 read from the cache).
NEAR_THE_LIMIT = RequestUsage(
    input_tokens=100_000, cache_read_tokens=90_000, output_tokens=OUTPUT
)


def _step(
    deps: RunDeps, messages: list[ModelMessage], spent: int
) -> RunContext[RunDeps]:
    """Step 2 of a run that has spent ``spent`` weighted tokens, as it is
    prepared (``messages`` end with its request) or as its calls run
    (``messages`` end with its response)."""
    return RunContext(
        deps=deps,
        model=TestModel(),
        usage=RunUsage(requests=2, input_tokens=spent),
        messages=messages,
        run_id="r1",
        run_step=2,
        tool_call_id="c2",
    )


@pytest.mark.parametrize(("spent", "runs"), [(140_000, True), (165_000, False)])
async def test_the_answer_step_runs_what_it_built_only_while_its_result_can_be_read(
    spent: int, runs: bool
) -> None:
    """The step that answers runs a workflow the answer built only while a
    step that reads the run's result and the answer step still fit: twice
    19,703 and 8,000 for answering, which 140,000 spent leaves and 165,000
    does not, though the answer step alone fits both. Decided as the step
    is prepared, so the note that offers the run and the call agree."""

    async def emit(event: Any) -> None:
        return None

    page = parse_context({"surface": "project.workflows", "project_id": RUN_PROJECT})
    env = tool_env(fake_clients(), page=page)
    env.workflows_created.add(RUN_WORKFLOW)
    deps = RunDeps(message_id="m1", emit=emit, budget=PRODUCTION, env=env)
    looked_up: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart("Run it")], run_id="r1"),
        ModelResponse(
            parts=[ToolCallPart("core_page_context", {}, tool_call_id="c1")],
            usage=NEAR_THE_LIMIT,
            run_id="r1",
        ),
        ModelRequest(
            parts=[ToolReturnPart("core_page_context", "page", tool_call_id="c1")],
            run_id="r1",
        ),
    ]
    prepared = _step(deps, looked_up, spent)
    call = next_call(looked_up, "r1")
    assert PRODUCTION.spent(prepared.usage, call)
    assert PRODUCTION.answer_fits(prepared.usage, call)
    assert answer_step(prepared) == "answer or ask"
    assert PRODUCTION.read_fits(prepared.usage, call) is runs
    assert runnable_workflows(prepared) == ([RUN_WORKFLOW] if runs else [])
    running = _step(
        deps,
        [
            *looked_up,
            ModelResponse(
                parts=[ToolCallPart(*RUN_CALL, tool_call_id="c2")],
                usage=NEAR_THE_LIMIT,
                run_id="r1",
            ),
        ],
        spent + 20_000,
    )
    if runs:
        # The step's own call does not undo what its preparation decided.
        assert runnable_workflows(running) == [RUN_WORKFLOW]
        return
    with pytest.raises(ToolFailed) as refused:
        await _tool(RUN).function(running, **RUN_CALL[1])  # type: ignore[call-arg]
    assert refused.value.message == ANSWER_STEP_REFUSALS["workflow_run"]
    # Counted toward the run's tool-call limit.
    assert deps.admitted_calls == {"r1": 1}


@pytest.mark.parametrize("share", [CACHED_SHARE, 0.0])
@pytest.mark.parametrize("growth", GROWTHS)
async def test_the_first_answer_step_runs_what_the_answer_built(
    growth: int, share: float
) -> None:
    """With production numbers, also on a provider without caching: the
    step after the look-ups runs the workflow the answer built, and the
    answer that follows fits. Reading from the cache, a step that reads the
    run's result comes before it; otherwise it does when it still fits, and
    the answer reads the run's summary."""
    read = False

    def act(n: int, note: str | None) -> Response:
        nonlocal read
        if note is None:
            return SIZED_LOOK_UP
        if RUN_WHAT_YOU_BUILT in note:
            return [RUN_CALL]
        if not read and read_the_result(RESULT_READS) in note:
            read = True
            return [READ_CALL]
        return [ANSWER]

    answered = await _answer(act, growth=growth, share=share, created=[RUN_WORKFLOW])
    [run] = _results(answered.turn, "workflow_run")
    assert run.outcome != "failed"
    reads = _results(answered.turn, READ_CALL[0])
    assert all(read.outcome != "failed" for read in reads)
    if share == CACHED_SHARE:
        assert len(reads) == 1
    assert answered.turn.output == ANSWER
    assert weighted_tokens(answered.usage) <= PRODUCTION.max_tokens


CENSUS = "de_zensus_2022_100m"
DISTRICTS = "hh_bezirke"
ADD_CENSUS: tuple[str, dict[str, Any]] = (
    "project_add_catalog_layer",
    {"catalog_id": CENSUS},
)
ADD_DISTRICTS: tuple[str, dict[str, Any]] = (
    "project_add_catalog_layer",
    {"catalog_id": DISTRICTS},
)
ADDED = {
    ("POST", f"/api/v2/project/{RUN_PROJECT}/layer-catalog"): [
        {"id": 501, "name": "Zensus 2022 - Bevölkerung", "type": "feature"}
    ]
}


def _picks(
    *, answering: bool, earlier: str = DISTRICTS, now: str = CENSUS
) -> AskHistory:
    """An earlier card where the user picked the district table (``earlier``
    in its adds), and a card where they picked the census grid (``now``);
    with ``answering``, this message answers that second card."""

    def card(header: str, label: str, dataset: str) -> AskUserInput:
        return AskUserInput.model_validate(
            {
                "questions": [
                    {
                        "question": f"Which {header.lower()} should the workflow use?",
                        "header": header,
                        "options": [
                            {"label": label, "value": "picked", "adds": [dataset]},
                            {"label": "Leave it open", "description": "Later"},
                        ],
                    }
                ]
            }
        )

    def picked(card_id: str) -> CardAnswer:
        return CardAnswer.model_validate(
            {"card_id": card_id, "answers": [{"question": 0, "options": [0]}]}
        )

    cards = {
        "ask-p1": card("Areas", "District table", earlier),
        "ask-p2": card("Residents", "Census grid", now),
    }
    history = AskHistory(cards=cards, answers={"ask-p1": picked("ask-p1")})
    if answering:
        return history.with_answer(picked("ask-p2"))
    return AskHistory(
        cards=cards, answers={**history.answers, "ask-p2": picked("ask-p2")}
    )


async def test_the_answer_step_adds_the_datasets_the_user_just_picked() -> None:
    """Pass 7 (Q25, Q30, Q36, Q43): adding the data the user picked was a
    look-up, so an answer started by the pick could end with a card that
    only asked to add it."""
    answered = await _answer_run(
        *SPENT,
        [ADD_CENSUS],
        budget=PRODUCTION,
        asks=_picks(answering=True),
        core_routes=ADDED,
    )
    assert ADD_WHAT_WAS_PICKED in str(answered.notes[25])
    [added] = _results(answered.turn, "project_add_catalog_layer")
    assert added.outcome != "failed"
    assert isinstance(added.content, dict)
    assert added.content["layers"][0]["layer_project_id"] == 501
    # Added, it is not offered again.
    assert ADD_WHAT_WAS_PICKED not in str(answered.notes[26])


@pytest.mark.parametrize(
    ("call", "answering"),
    [
        # Picked in an earlier card, not in the one that started the answer.
        (ADD_DISTRICTS, True),
        # The pick is the conversation's, but no card answer came with this
        # message.
        (ADD_CENSUS, False),
    ],
)
async def test_the_answer_step_adds_nothing_else(
    call: tuple[str, dict[str, Any]], answering: bool
) -> None:
    answered = await _answer_run(
        *SPENT,
        [call],
        budget=PRODUCTION,
        asks=_picks(answering=answering),
        core_routes=ADDED,
    )
    assert (ADD_WHAT_WAS_PICKED in str(answered.notes[25])) is answering
    refused = _results(answered.turn, "project_add_catalog_layer")[-1]
    assert refused.outcome == "failed"
    assert refused.content == ANSWER_STEP_REFUSALS["project_add_catalog_layer"]


CENSUS_BUNDLE = "de_zensus_2022"
DISTRICTS_BUNDLE = "hh_verwaltungsgrenzen"


def _bundle(item: str, *members: str) -> dict[str, Any]:
    return {
        "kind": "collection",
        "collection": {"id": item, "title": item},
        "items": [{"id": member} for member in members],
    }


@pytest.mark.parametrize(
    ("dataset", "added"),
    [
        # A member of the bundle the pick that started the answer adds.
        ("de_zensus_2022_100m", True),
        # A member of a bundle picked in an earlier card.
        ("hh_bezirke", False),
    ],
)
async def test_the_answer_step_adds_a_member_of_the_bundle_just_picked(
    dataset: str, added: bool
) -> None:
    """The step accepts what the add tool's own check accepts for the pick
    that started the answer: an option that adds a bundle lets each of its
    members be added."""
    catalog = Recorder(
        {
            ("GET", f"/stac/resolve/{CENSUS_BUNDLE}"): _bundle(
                CENSUS_BUNDLE, "de_zensus_2022_100m", "de_zensus_2022_alter"
            ),
            ("GET", f"/stac/resolve/{DISTRICTS_BUNDLE}"): _bundle(
                DISTRICTS_BUNDLE, "hh_bezirke"
            ),
        }
    )
    answered = await _answer_run(
        *SPENT,
        [("project_add_catalog_layer", {"catalog_id": dataset})],
        budget=PRODUCTION,
        asks=_picks(answering=True, earlier=DISTRICTS_BUNDLE, now=CENSUS_BUNDLE),
        core_routes=ADDED,
        catalog=catalog,
    )
    [result] = _results(answered.turn, "project_add_catalog_layer")
    if added:
        assert result.outcome != "failed"
        assert isinstance(result.content, dict) and result.content["layers"]
        # The step's check found the pick; the add tool's own check does not
        # look the bundles up again.
        assert catalog.paths().count(f"/stac/resolve/{CENSUS_BUNDLE}") == 1
        assert f"/stac/resolve/{DISTRICTS_BUNDLE}" not in catalog.paths()
    else:
        assert result.outcome == "failed"
        assert result.content == ANSWER_STEP_REFUSALS["project_add_catalog_layer"]
        # Only the pick that started the answer was read: an earlier card's
        # bundle was not looked up.
        assert f"/stac/resolve/{CENSUS_BUNDLE}" in catalog.paths()
        assert f"/stac/resolve/{DISTRICTS_BUNDLE}" not in catalog.paths()


@pytest.mark.parametrize(
    "call",
    [
        ("workflow_run", {"workflow_id": "the new workflow"}),
        ("project_add_catalog_layer", {"catalog_id": CENSUS, "layer": 1}),
    ],
)
async def test_a_call_of_the_answer_step_with_invalid_arguments_gets_their_error(
    call: tuple[str, dict[str, Any]],
) -> None:
    """Not the stage's refusal, which would not say what to fix: nothing
    runs either way."""
    answered = await _answer_run(
        *SPENT,
        [call],
        budget=PRODUCTION,
        created=[RUN_WORKFLOW],
        asks=_picks(answering=True),
    )
    [retry] = _retries(answered.turn, call[0])
    assert "Invalid arguments" in str(retry.content)
    assert _results(answered.turn, call[0]) == []


def test_the_answer_steps_refusals_say_what_it_still_allows() -> None:
    for tool, refusal in ANSWER_STEP_REFUSALS.items():
        assert refusal.startswith("This call did not run")
        assert "budget" not in refusal.lower()
        assert tool in refusal and "ask_user" in refusal
        assert "\n" not in refusal
