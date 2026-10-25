"""A long conversation stays affordable: earlier answers' long tool results
go to the model as counts (assistant.history), and a run near its limits
answers with what it found instead of failing (assistant.budget)."""

import json
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ToolFailed, UsageLimitExceeded
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ThinkingPart,
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

from assistant.agent import RunDeps, build_agent
from assistant.budget import (
    MAX_RESULT_READS,
    NextCall,
    RunBudget,
    next_call,
    weighted_tokens,
)
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.history import SHORTENED, shorten_earlier_results
from assistant.prompt import (
    ANSWER_IN_TEXT,
    ANSWER_NOW,
    ANSWER_NOW_CARD,
    render_note,
    with_note,
)
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools.http import ServiceClients
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.testing import Recorder, ScriptedModel, fake_clients, tool_env
from assistant.tools.toolset import (
    LOOK_UPS_USED_UP,
    RESULT_TOO_LARGE,
    SERVICE_FAILED_TWICE,
    _tool,
    silent_responses,
)

USER = UUID(int=1)

WORKFLOWS = {
    "projects": [],
    "workflows": [
        {"id": str(n), "name": f"Workflow {n}", "description": "d" * 200}
        for n in range(20)
    ],
    "total": 20,
    "query": "Anna",
}


def _call(tool: str, call_id: str) -> ModelResponse:
    return ModelResponse(
        parts=[ToolCallPart(tool_name=tool, args={}, tool_call_id=call_id)]
    )


def _result(tool: str, call_id: str, content: Any) -> ModelRequest:
    return ModelRequest(
        parts=[ToolReturnPart(tool_name=tool, content=content, tool_call_id=call_id)]
    )


def _content(message: ModelMessage) -> Any:
    [part] = message.parts
    assert isinstance(part, ToolReturnPart)
    return part.content


def test_earlier_long_results_are_shortened_to_their_counts() -> None:
    shown = {
        "groups": [{"title": "Tool 3", "items": [{"id": "w1", "name": "Huff"}] * 30}]
    }
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="workflows from Anna?")]),
        _call("core_find", "c1"),
        _result("core_find", "c1", WORKFLOWS),
        _call("core_whoami", "c2"),
        _result("core_whoami", "c2", {"name": "Tom"}),
        _call("core_show_items", "c3"),
        _result("core_show_items", "c3", shown),
        ModelResponse(parts=[TextPart(content="Here are her workflows.")]),
        # The current answer: its results stay whole.
        ModelRequest(parts=[UserPromptPart(content="and her layouts?")]),
        _call("core_find", "c4"),
        _result("core_find", "c4", WORKFLOWS),
    ]

    sent = shorten_earlier_results(messages)

    assert len(sent) == len(messages)
    assert _content(sent[2]) == {
        "shortened": SHORTENED,
        "projects": "0 items",
        "workflows": "20 items",
        "total": 20,
        "query": "Anna",
    }
    # Short results, and what the user was shown as cards, stay whole.
    assert _content(sent[4]) == {"name": "Tom"}
    assert _content(sent[6]) == shown
    # The answers' own words, and the current answer, are untouched.
    assert sent[7] is messages[7]
    assert _content(sent[10]) == WORKFLOWS
    # The input is not changed: the stored history keeps everything.
    assert _content(messages[2]) == WORKFLOWS


def test_earlier_reasoning_is_left_out_and_the_current_kept() -> None:
    earlier = ModelResponse(
        parts=[
            ThinkingPart(content="long reasoning " * 200),
            TextPart(content="She has 20."),
        ]
    )
    only_reasoning = ModelResponse(parts=[ThinkingPart(content="hm")])
    current = ModelResponse(
        parts=[
            ThinkingPart(content="now"),
            ToolCallPart(tool_name="core_find", args={}),
        ]
    )
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="q")]),
        earlier,
        only_reasoning,
        ModelRequest(parts=[UserPromptPart(content="next")]),
        current,
    ]
    sent = shorten_earlier_results(messages)
    assert sent[1].parts == [TextPart(content="She has 20.")]
    assert sent[2] is only_reasoning
    assert sent[4] is current


def test_a_long_text_or_list_result_keeps_its_start_or_its_count() -> None:
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="q")]),
        _call("catalog_get_record", "c1"),
        _result("catalog_get_record", "c1", "x" * 5000),
        _call("project_sample_features", "c2"),
        _result("project_sample_features", "c2", [{"a": "y" * 100}] * 40),
        ModelResponse(parts=[TextPart(content="a")]),
        ModelRequest(parts=[UserPromptPart(content="next")]),
    ]
    sent = shorten_earlier_results(messages)
    text = _content(sent[2])
    assert text.startswith("x" * 300) and text.endswith(f"({SHORTENED})")
    assert _content(sent[4]) == {"shortened": SHORTENED, "items": "40 items"}


async def test_the_model_gets_earlier_results_shortened_in_a_real_run() -> None:
    page = parse_context(None)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m2",
        emit=emit,
        env=tool_env(fake_clients(), page=page),
        prompt_note=render_note(page, None, "en"),
    )
    history: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="workflows from Anna?")]),
        _call("core_find", "c1"),
        _result("core_find", "c1", WORKFLOWS),
        ModelResponse(parts=[TextPart(content="She has 20.")]),
    ]
    script = ScriptedModel()
    result = await build_agent(script.model).run(
        with_note(deps.prompt_note, "which are newest?"),
        deps=deps,
        message_history=history,
    )
    [request] = script.requests
    assert _content(request[2])["shortened"] == SHORTENED
    assert result.output == "done"


NO_CALL = NextCall(newest=RequestUsage(), raw=0, growth=0)
SMALL = NextCall(newest=RequestUsage(input_tokens=10), raw=20, growth=10)
#: A look-up step of a long run: the newest call read most of its 40,000
#: input tokens from the cache, its results add 2,000, its steps grew 3,000.
CACHED = RequestUsage(
    input_tokens=40_000, cache_read_tokens=35_000, output_tokens=1_000
)
LONG = NextCall(newest=CACHED, raw=43_000, growth=3_000)


def _spent_so_far(weighted: int) -> RunUsage:
    """Six calls of a run whose weighted count is ``weighted``: 150,000 input
    tokens, 120,000 of them read from the cache, and the rest output."""
    output = weighted - 30_000 - 12_000
    return RunUsage(
        requests=6,
        input_tokens=150_000,
        cache_read_tokens=120_000,
        output_tokens=output,
    )


@pytest.mark.parametrize(
    ("usage", "call", "spent"),
    [
        (RunUsage(), NO_CALL, False),
        (RunUsage(requests=3, tool_calls=24, input_tokens=30), SMALL, False),
        # Five tool calls kept in reserve of 30.
        (RunUsage(requests=3, tool_calls=25, input_tokens=30), SMALL, True),
        # 47,000 spent; the look-up 12,500 (3,500 uncached, 35,000 read from
        # the cache, 1,000 output); then the answer and the closing call at
        # 43,000 plus a step of at least 8,000 each, and 8,000 for answering:
        # 169,500. Four times the newest call would have spent it.
        (_spent_so_far(47_000), LONG, False),
        # 202,000 at 79,500 spent: neither half the step nor half the
        # allowance for answering would fit it.
        (_spent_so_far(79_500), LONG, True),
        # The run's largest step counts when it is larger than the floor:
        # 20,000 each, 206,500 at 60,000 spent.
        (
            _spent_so_far(60_000),
            NextCall(newest=CACHED, raw=43_000, growth=20_000),
            True,
        ),
        # A look-up after a call that read nothing from the cache reads
        # nothing either: 44,000 for it, 201,000 at 47,000 spent.
        (
            _spent_so_far(47_000),
            NextCall(
                newest=RequestUsage(input_tokens=40_000, output_tokens=1_000),
                raw=43_000,
                growth=3_000,
            ),
            True,
        ),
    ],
)
def test_one_more_look_up_only_when_what_follows_it_fits(
    usage: RunUsage, call: NextCall, spent: bool
) -> None:
    budget = RunBudget(max_tokens=200_000, max_tool_calls=30)
    assert budget.spent(usage, call) is spent


@pytest.mark.parametrize(
    ("usage", "can_ask"),
    [
        # The answer step and the closing call at 43,000 each, and 8,000 for
        # answering: 194,000 at 100,000 spent.
        (_spent_so_far(100_000), True),
        # 204,000: only the answer step fits, which answers in text.
        (_spent_so_far(110_000), False),
        # No tool call left for the card.
        (RunUsage(requests=6, tool_calls=30, input_tokens=1_000), False),
    ],
)
def test_the_card_is_offered_only_when_both_calls_fit(
    usage: RunUsage, can_ask: bool
) -> None:
    budget = RunBudget(max_tokens=200_000, max_tool_calls=30)
    assert budget.can_ask(usage, LONG) is can_ask


@pytest.mark.parametrize(
    ("usage", "fits"),
    [
        # The read step and the answer step at 43,000 each, and 8,000 for
        # answering: 200,000 at 106,000 spent.
        (_spent_so_far(106_000), True),
        # 201,000.
        (_spent_so_far(107_000), False),
    ],
)
def test_a_read_past_the_look_ups_needs_room_for_two_calls(
    usage: RunUsage, fits: bool
) -> None:
    """The read step is sized as the answer step and its spare are: a silent
    answer after a run gets the fixed ending (runs/turn.py), not a retry."""
    budget = RunBudget(max_tokens=200_000, max_tool_calls=30)
    assert budget.read_fits(usage, LONG) is fits
    assert budget.answer_fits(usage, LONG) is fits


def test_cache_reads_count_at_a_tenth_and_the_rest_fully() -> None:
    usage = RunUsage(
        input_tokens=1000,
        cache_read_tokens=800,
        cache_write_tokens=100,
        output_tokens=50,
    )
    # Uncached input (cache writes among it) and output count fully.
    assert weighted_tokens(usage) == pytest.approx(200 + 50 + 80)
    assert weighted_tokens(RunUsage(input_tokens=300, output_tokens=20)) == 320


def test_the_hard_limit_counts_tokens_as_the_budget_does() -> None:
    limits = RunBudget(max_tokens=1000, max_tool_calls=30).usage_limits()
    # The run's own limit is kept call by call (StepGuard); this one only
    # stops a single step of more calls than the run's whole limit, with
    # room for the most reads of a run's result past it and one more call
    # of their step.
    assert limits.tool_calls_limit == 2 * 30 + MAX_RESULT_READS + 1
    # Without tool calls there is no run's result to read.
    assert (
        RunBudget(max_tokens=1000, max_tool_calls=0).usage_limits().tool_calls_limit
        == 0
    )
    # Checked while a response streams, too.
    assert limits.has_token_limits()
    # 100 uncached, 30 output and 2900 read from the cache count as 420.
    cached = RunUsage(
        requests=3, input_tokens=3000, cache_read_tokens=2900, output_tokens=30
    )
    limits.check_before_request(cached)
    limits.check_tokens(cached)
    uncached = RunUsage(requests=1, input_tokens=990, output_tokens=20)
    with pytest.raises(UsageLimitExceeded, match="1000"):
        limits.check_tokens(uncached)
    with pytest.raises(UsageLimitExceeded, match="1000"):
        limits.check_before_request(uncached)


def _response(input_tokens: int, output_tokens: int, run_id: str) -> ModelResponse:
    usage = RequestUsage(input_tokens=input_tokens, output_tokens=output_tokens)
    return ModelResponse(parts=[TextPart(content="a")], usage=usage, run_id=run_id)


def _returns(chars: int, run_id: str) -> ModelRequest:
    part = ToolReturnPart(tool_name="core_find", content="x" * chars, tool_call_id="c")
    return ModelRequest(parts=[part], run_id=run_id)


def test_the_next_call_is_sized_from_the_runs_messages() -> None:
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="q")], run_id="r1"),
        _response(90_000, 500, "r1"),
        ModelRequest(parts=[UserPromptPart(content="next")], run_id="r2"),
        _response(10_000, 200, "r2"),
        _returns(4_000, "r2"),
        _response(13_000, 300, "r2"),
        # The request the next call sends: the newest call's results.
        _returns(7_000, "r2"),
    ]
    call = next_call(messages, "r2")
    assert call.newest == messages[5].usage
    # The newest call's input and output, and its results at 1.75 characters
    # per token.
    assert call.raw == 13_000 + 300 + 4_000
    # The step between the inputs of the run's two calls.
    assert call.growth == 3_000


def test_a_run_that_continues_a_conversation_has_no_call_of_its_own_yet() -> None:
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="q")], run_id="r1"),
        _response(90_000, 500, "r1"),
        ModelRequest(parts=[UserPromptPart(content="x" * 1_750)], run_id="r2"),
    ]
    call = next_call(messages, "r2")
    assert (call.newest, call.raw, call.growth) == (RequestUsage(), 1_000, 0)


def test_a_small_tool_call_limit_keeps_a_smaller_reserve() -> None:
    budget = RunBudget(max_tokens=10**9, max_tool_calls=1)
    assert budget.spent(RunUsage(requests=1, tool_calls=0), SMALL) is False
    assert budget.spent(RunUsage(requests=1, tool_calls=1), SMALL) is True


async def test_near_its_limits_a_run_answers_and_may_only_ask() -> None:
    page = parse_context(None)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(), page=page),
        prompt_note=render_note(page, None, "en"),
        # One tool call kept in reserve of six: tools for five.
        budget=RunBudget(max_tokens=10**9, max_tool_calls=6),
    )
    script = ScriptedModel(calls=[("core_page_context", {})] * 5)
    result = await build_agent(script.model).run(
        with_note(deps.prompt_note, "where am I?"), deps=deps
    )
    assert result.output == "done"

    def instructions(index: int) -> str:
        parts = script.infos[index].model_request_parameters.instruction_parts or []
        return "\n".join(part.content for part in parts)

    assert script.infos[0].function_tools and ANSWER_NOW not in instructions(0)
    # After five calls: only the card, and the model is told to answer.
    assert [tool.name for tool in script.infos[5].function_tools] == ["ask_user"]
    assert f"{ANSWER_NOW} {ANSWER_NOW_CARD}" in instructions(5)


async def test_a_second_response_without_text_or_a_tool_call_ends_the_look_ups() -> (
    None
):
    """A response with only reasoning (or nothing) is asked again by Pydantic
    AI with the same tools, and a model that gave one often gives the next
    alike: four in a row failed a run ("Exceeded maximum output retries",
    wf-04). The first is asked again as it is; after the second the next call
    is the answer step, which may only ask or answer."""
    page = parse_context(None)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(), page=page),
        prompt_note=render_note(page, None, "en"),
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    offered: list[list[str]] = []
    instructions: list[str] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        offered.append(sorted(tool.name for tool in info.function_tools))
        parts = info.model_request_parameters.instruction_parts or []
        instructions.append("\n".join(part.content for part in parts))
        step = len(offered) - 1
        if step == 0:
            call = ToolCallPart(
                tool_name="core_page_context", args={}, tool_call_id="c0"
            )
            return ModelResponse(parts=[call])
        if step in (1, 2):
            return ModelResponse(parts=[ThinkingPart(content="Ask which layer.")])
        return ModelResponse(parts=[TextPart(content="Which of the two layers?")])

    result = await build_agent(FunctionModel(respond)).run(
        with_note(deps.prompt_note, "where am I?"), deps=deps
    )
    assert result.output == "Which of the two layers?"
    assert len(offered) == 4
    # The first such response is asked again with the same tools.
    assert len(offered[2]) > 1 and offered[2] == offered[1]
    assert ANSWER_IN_TEXT not in instructions[2]
    # After the second: only the card, and the model is told to answer.
    assert offered[3] == ["ask_user"]
    assert f"{ANSWER_IN_TEXT} {ANSWER_NOW_CARD}" in instructions[3]
    assert ANSWER_NOW not in instructions[3]


def test_a_response_with_a_tool_call_or_text_is_not_silent() -> None:
    def response(*parts: Any) -> ModelResponse:
        return ModelResponse(parts=list(parts), run_id="r")

    messages: list[ModelMessage] = [
        response(ThinkingPart(content="hm")),
        response(TextPart(content=" \n")),
        response(),
        response(
            ThinkingPart(content="hm"),
            ToolCallPart(tool_name="core_whoami", args={}, tool_call_id="c1"),
        ),
        response(TextPart(content="Hello.")),
        # Another run's answer does not count.
        ModelResponse(parts=[TextPart(content=" ")], run_id="earlier"),
    ]
    assert silent_responses(messages, "r") == 3


def test_the_answer_now_step_says_to_ask_with_the_card() -> None:
    assert "ask_user" in ANSWER_NOW_CARD
    assert "instead of asking in text" in ANSWER_NOW_CARD
    # After responses without text it says why the look-ups are over.
    assert "neither text" in ANSWER_IN_TEXT and "Answer now" in ANSWER_IN_TEXT


async def test_at_its_tool_call_limit_a_run_is_not_offered_the_card() -> None:
    """The card is one more tool call: past the hard limit it would fail the
    run instead of asking."""

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients()),
        # No tool call kept in reserve of one.
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    script = ScriptedModel(calls=[("core_page_context", {})])
    result = await build_agent(script.model).run("where am I?", deps=deps)
    assert result.output == "done"
    assert script.infos[1].function_tools == []
    # Nor told to ask with it.
    parts = script.infos[1].model_request_parameters.instruction_parts or []
    [answer_now] = [p.content for p in parts if p.content.startswith(ANSWER_NOW)]
    assert answer_now == ANSWER_NOW and "ask_user" not in answer_now


CARD: dict[str, Any] = {
    "questions": [
        {
            "question": "Which schools should the catchments start from?",
            "header": "Schools",
            "options": [
                {"label": "Schulen (Stand 2019)", "value": "32"},
                {"label": "Schulen", "recommended": True, "value": "31"},
            ],
        }
    ]
}


async def test_a_run_out_of_budget_still_asks_with_the_card(
    repo: Repository, settings: AssistantSettings
) -> None:
    # One tool call kept in reserve of six: five look-ups, then the card.
    script = ScriptedModel(
        calls=[*[("core_page_context", {})] * 5, ("ask_user", CARD)],
        answer="I asked you above.",
    )
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings.model_copy(update={"run_max_tool_calls": 6}),
        owner="a",
        agent_factory=lambda _: build_agent(script.model),
        tool_services=fake_clients(),
    )
    conversation = await repo.create_conversation(USER, "catalog", None, None)
    conversation_id = UUID(str(conversation["id"]))
    run_id, _ = await manager.start_run(conversation_id, USER, "which schools?", None)
    await manager.wait(run_id)

    run = await repo.get_run(run_id)
    assert run is not None and (run["status"], run["error"]) == ("succeeded", None)
    assert [tool.name for tool in script.infos[5].function_tools] == ["ask_user"]
    # The card ends the answer: no model call follows it.
    assert len(script.infos) == 6
    [message] = [
        m
        for m in await repo.list_messages(conversation_id, None)
        if m["role"] == "assistant"
    ]
    [asked] = [p for p in message["parts"] if p.get("tool_name") == "ask_user"]
    assert asked["state"] == "output" and asked["output"]["status"] == "asked"
    [card] = [p for p in message["parts"] if p["type"] == "data"]
    assert card["name"] == "ask" and card["id"] == asked["output"]["card_id"]


def _delta(name: str, args: str, call_id: str) -> DeltaToolCall:
    return DeltaToolCall(name=name, json_args=args, tool_call_id=call_id)


#: Characters per token of the provider's own count of the results a call
#: sends: coarser than the budget's estimate, as with real tokenizers.
PROVIDER_CHARS_PER_TOKEN = 2


def _sent_chars(message: ModelMessage) -> int:
    """The characters of the results a request sends."""
    if not isinstance(message, ModelRequest):
        return 0
    return sum(
        len(part.model_response_str())
        if isinstance(part, ToolReturnPart)
        else len(part.model_response())
        for part in message.parts
        if isinstance(part, (ToolReturnPart, RetryPromptPart))
    )


class _Provider(FunctionModel):
    """A streamed model that looks things up while it may (in call ``n`` with
    ``parallel[n]`` calls at once of ``tools[n]``, by default one call of
    ``look_up``), asks with the card when
    that is the only tool left (``asks``) and answers otherwise. Its usage is
    a provider's: the first call reads ``start`` input tokens, every call
    writes ``growth`` output tokens (plus ``spikes[n]`` in call ``n``), and
    the next call reads the previous call's input and output and the results
    it sends, so the run's messages show how the context grows. With
    ``cached`` a call reads the previous call's input from the cache when it
    offers the same tools; a changed tool list misses the cache."""

    def __init__(
        self,
        *,
        start: int,
        growth: int,
        cached: bool = True,
        asks: bool = False,
        spikes: dict[int, int] | None = None,
        look_up: str = "core_page_context",
        parallel: dict[int, int] | None = None,
        tools: dict[int, str] | None = None,
    ) -> None:
        super().__init__(stream_function=self._stream)
        self.start, self.growth, self.cached, self.asks = start, growth, cached, asks
        self.spikes = spikes or {}
        self.look_up = look_up
        self.parallel = parallel or {}
        self.tools = tools or {}
        #: Per call: the tools offered, the instructions, and (input tokens,
        #: cache reads, output tokens).
        self.offered: list[list[str]] = []
        self.instructions: list[str] = []
        self.usages: list[tuple[int, int, int]] = []

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        names = [tool.name for tool in info.function_tools]
        hit = self.cached and bool(self.offered) and self.offered[-1] == names
        n = len(self.usages)
        if self.usages:
            previous_input, _, previous_output = self.usages[-1]
            sent = math.ceil(_sent_chars(messages[-1]) / PROVIDER_CHARS_PER_TOKEN)
            input_tokens = previous_input + previous_output + sent
        else:
            previous_input, input_tokens = 0, self.start
        output = self.growth + self.spikes.get(n, 0)
        self.usages.append((input_tokens, previous_input if hit else 0, output))
        self.offered.append(names)
        self.instructions.append(info.instructions or "")
        if names == ["ask_user"] and self.asks:
            yield {0: _delta("ask_user", json.dumps(CARD), f"call-{n}")}
        elif self.look_up in names:
            tool = self.tools.get(n, self.look_up)
            yield {
                i: _delta(tool, "{}", f"call-{n}-{i}")
                for i in range(self.parallel.get(n, 1))
            }
        else:
            yield "Here is what I found."

    @asynccontextmanager
    async def request_stream(
        self, *args: Any, **kwargs: Any
    ) -> AsyncIterator[StreamedResponse]:
        async with super().request_stream(*args, **kwargs) as response:
            # Set once the stream function ran to its first item, before the
            # stream: the streamed text's own estimate is added as it arrives.
            input_tokens, cached, output = self.usages[-1]
            response._usage = RequestUsage(
                input_tokens=input_tokens,
                cache_read_tokens=cached,
                output_tokens=output,
            )
            yield response


async def _run(
    repo: Repository,
    settings: AssistantSettings,
    model: FunctionModel,
    services: ServiceClients | None = None,
    **limits: int,
) -> dict[str, Any]:
    """A run through the run manager on ``model`` (and the tools on
    ``services``) with the settings changed by ``limits``; the run as stored."""
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings.model_copy(update=limits),
        owner="a",
        agent_factory=lambda _: build_agent(model),
        tool_services=services or fake_clients(),
    )
    conversation = await repo.create_conversation(USER, "catalog", None, None)
    run_id, _ = await manager.start_run(
        UUID(str(conversation["id"])), USER, "which schools?", None
    )
    await manager.wait(run_id)
    run = await repo.get_run(run_id)
    assert run is not None
    return dict(run)


async def test_the_answer_now_step_fits_although_it_misses_the_cache(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The step that answers offers other tools and instructions than the
    calls before it, so the provider reads none of it from its cache: the
    budget keeps room for its whole context."""
    model = _Provider(start=20_000, growth=3_000)
    run = await _run(repo, settings, model)
    assert run["status"] == "succeeded", run["error"]
    assert model.offered[-1] == ["ask_user"] and model.usages[-1][1] == 0


async def test_a_card_at_the_answer_now_step_ends_the_answer(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The card offered at the answer step is the answer's last call: no call
    to close it follows."""
    model = _Provider(start=20_000, growth=3_000, asks=True)
    run = await _run(repo, settings, model)
    assert run["status"] == "succeeded", run["error"]
    assert model.offered[-1] == ["ask_user"]
    assert ANSWER_NOW_CARD in model.instructions[-1]


async def test_a_run_reading_from_the_cache_is_not_stopped_at_its_raw_tokens(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Every call after the first reads its input from the cache: the run
    looks things up until its tool calls run short, far past the token limit
    counted raw."""
    model = _Provider(start=5_000, growth=0)
    run = await _run(repo, settings, model, run_max_tokens=80_000)
    assert run["status"] == "succeeded", run["error"]
    # 25 look-ups (five of 30 tool calls kept in reserve), then the answer.
    assert model.offered.count(model.offered[0]) == 25
    assert sum(tokens for tokens, _, _ in model.usages) > 80_000


async def test_a_run_past_the_weighted_limit_fails_on_it(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Pydantic AI checks the weighted count itself: the run ends at the token
    limit while its raw tokens stay far under the raw backstop."""
    model = _Provider(start=900, growth=0, cached=False)
    run = await _run(repo, settings, model, run_max_tokens=1_000)
    assert run["status"] == "failed"
    assert run["error"].startswith(
        "The run hit a limit: Exceeded the token limit of 1000"
    )
    assert sum(tokens for tokens, _, _ in model.usages) < 10_000


async def test_when_only_the_answer_fits_the_run_answers_in_text(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A look-up whose results are larger than any step before leaves room
    for the answer step but not for a card and the call that closes it."""
    model = _Provider(start=20_000, growth=2_000, asks=True, spikes={9: 20_000})
    run = await _run(repo, settings, model)
    assert run["status"] == "succeeded", run["error"]
    assert model.offered[-1] == [] and ["ask_user"] not in model.offered
    assert ANSWER_NOW in model.instructions[-1]
    assert ANSWER_NOW_CARD not in model.instructions[-1]


async def _stored_tools(repo: Repository, run: dict[str, Any]) -> list[dict[str, Any]]:
    """The tool parts of the run's answer as stored."""
    messages = await repo.list_messages(UUID(str(run["conversation_id"])), None)
    [answer] = [m for m in messages if m["role"] == "assistant"]
    return [part for part in answer["parts"] if part["type"] == "tool"]


async def _audited(repo: Repository, run: dict[str, Any]) -> list[tuple[str, str]]:
    """The audit rows of the run's tool calls: (status, error)."""
    async with repo.db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT status, error FROM {repo.db.t('tool_call')} WHERE run_id = $1",
            run["id"],
        )
    return [(row["status"], row["error"]) for row in rows]


async def test_a_step_past_the_tool_call_budget_runs_what_fits_and_answers(
    repo: Repository, settings: AssistantSettings
) -> None:
    """24 of 30 tool calls pass the check, and the next step makes eight at
    once: six run, two are refused, and the run answers."""
    model = _Provider(start=5_000, growth=0, parallel={24: 8})
    run = await _run(repo, settings, model)
    assert run["status"] == "succeeded", run["error"]
    step = [
        p
        for p in await _stored_tools(repo, run)
        if p["tool_call_id"].startswith("call-24-")
    ]
    assert [p["state"] for p in step].count("output") == 6
    assert [p["error"] for p in step if p["state"] == "error"] == [LOOK_UPS_USED_UP] * 2
    assert model.offered[-1] == []
    refused = [row for row in await _audited(repo, run) if row[0] != "ok"]
    assert refused == [("error", LOOK_UPS_USED_UP)] * 2


def _profile_core(name_chars: int) -> Recorder:
    """A core whose core_whoami result carries a name of ``name_chars``."""
    return Recorder(
        {
            ("GET", "/api/v2/users/profile"): {"firstname": "x" * name_chars},
            ("GET", "/api/v2/users/organization"): {"name": "Org"},
        }
    )


def _profile(name_chars: int) -> ServiceClients:
    """Services whose core_whoami result carries a name of ``name_chars``."""
    return fake_clients(core=_profile_core(name_chars))


async def test_a_step_whose_results_would_cross_the_reserve_answers(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Six large results at once would leave no room for the answer: the step
    sends those that leave room for the answer step, and the run answers in
    text, without room for a card."""
    model = _Provider(
        start=20_000, growth=2_000, parallel={5: 6}, tools={5: "core_whoami"}
    )
    run = await _run(repo, settings, model, _profile(40_000))
    assert run["status"] == "succeeded", run["error"]
    step = [
        p
        for p in await _stored_tools(repo, run)
        if p["tool_call_id"].startswith("call-5-")
    ]
    # About 54,600 spent and a context of about 32,500; each result is about
    # 22,900 tokens: four leave the answer step its room, the fifth would not.
    assert [p["state"] for p in step].count("output") == 4
    assert [p["error"] for p in step if p["state"] == "error"] == [RESULT_TOO_LARGE] * 2
    refused = [row[:2] for row in await _audited(repo, run) if row[0] != "ok"]
    assert refused == [("error", RESULT_TOO_LARGE)] * 2
    assert model.offered[-1] == [] and len(model.offered) == 7


async def test_a_large_result_makes_the_next_call_the_answer_step(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The results the next call sends count before that call: one large
    result makes the very next call the answer step."""
    model = _Provider(start=20_000, growth=1_000, tools={2: "core_whoami"})
    run = await _run(repo, settings, model, _profile(80_000))
    assert run["status"] == "succeeded", run["error"]
    assert len(model.offered[2]) > 1 and model.offered[3:] == [["ask_user"]]


async def test_a_large_first_step_still_gets_a_result_it_can_answer_from(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A run that continues a long conversation starts near its limit: a
    result that leaves room for the answer step is sent though no card fits,
    and the run answers from it in text."""
    model = _Provider(start=76_000, growth=0, tools={0: "core_whoami"})
    run = await _run(repo, settings, model, _profile(16_000))
    assert run["status"] == "succeeded", run["error"]
    [whoami] = await _stored_tools(repo, run)
    assert whoami["state"] == "output"
    assert len(model.offered) == 2 and model.offered[1] == []


async def test_a_refused_result_ends_the_look_ups(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A result too large for what is left is refused, and the next call is
    the answer step: a model that would call for it again is not offered the
    tool, which ran once."""
    core = _profile_core(350_000)
    model = _Provider(
        start=10_000, growth=0, tools={n: "core_whoami" for n in range(2, 60)}
    )
    run = await _run(repo, settings, model, fake_clients(core=core))
    assert run["status"] == "succeeded", run["error"]
    assert [p["state"] for p in await _stored_tools(repo, run)][2] == "error"
    assert len(model.offered) == 4 and model.offered[3] == ["ask_user"]
    assert core.paths().count("/api/v2/users/profile") == 1


async def test_a_refused_call_is_refused_again_without_running(
    repo: Repository,
) -> None:
    """Within the run, the same call as a refused one (a step's calls after a
    write run once the write is done) is refused without asking the service
    again, and both audit rows record the refused result's size."""
    core = _profile_core(350_000)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(core=core), repo=repo),
        budget=RunBudget(max_tokens=200_000, max_tool_calls=30),
    )
    usage = RunUsage(requests=1, input_tokens=10_000)
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="who am I?")], run_id="r1"),
        ModelResponse(
            parts=[ToolCallPart(tool_name="core_whoami", args={}, tool_call_id="c1")],
            usage=RequestUsage(input_tokens=10_000),
            run_id="r1",
        ),
    ]
    whoami = _tool(BY_WIRE_NAME["core_whoami"])
    for call_id in ("refused-1", "refused-2"):
        ctx = RunContext(
            deps=deps,
            model=TestModel(),
            usage=usage,
            messages=messages,
            run_id="r1",
            run_step=1,
            tool_call_id=call_id,
        )
        with pytest.raises(ToolFailed, match="too large"):
            await whoami.function(ctx)  # type: ignore[call-arg]
    assert core.paths().count("/api/v2/users/profile") == 1
    async with repo.db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT tool_call_id, status, error, result_bytes FROM {repo.db.t('tool_call')} "
            "WHERE tool_call_id LIKE 'refused-%' ORDER BY created_at"
        )
    sizes = {row["result_bytes"] for row in rows}
    assert [(r["status"], r["error"]) for r in rows] == [
        ("error", RESULT_TOO_LARGE)
    ] * 2
    assert len(sizes) == 1 and sizes.pop() > 350_000


#: Calls 2 to 59 ask core_whoami (the loops below).
WHOAMI_FROM_CALL_2 = {n: "core_whoami" for n in range(2, 60)}


async def test_a_repeated_result_over_the_cap_ends_at_the_tool_call_limit(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A model that asks again for a result too large to send: the repeat is
    refused without asking the service again, every call counts toward the
    run's tool-call limit, and the run answers once it is near."""
    core = _profile_core(500_000)
    model = _Provider(start=10_000, growth=0, tools=WHOAMI_FROM_CALL_2)
    run = await _run(repo, settings, model, fake_clients(core=core))
    assert run["status"] == "succeeded", run["error"]
    assert core.paths().count("/api/v2/users/profile") == 1
    # Five of 30 kept in reserve: 25 calls, then the answer step.
    assert len(model.offered) == 26 and model.offered[-1] == ["ask_user"]


async def test_a_repeated_failing_call_ends_at_the_tool_call_limit(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A model that asks a failing service again and again: the first retry
    still asks it, a call it failed twice is refused without asking it
    again, every call counts toward the run's tool-call limit, and the run
    answers once it is near."""
    core = _profile_core(100)
    core.routes[("GET", "/api/v2/users/profile")] = httpx.Response(
        503, json={"detail": "down"}
    )
    model = _Provider(start=10_000, growth=0, tools=WHOAMI_FROM_CALL_2)
    run = await _run(repo, settings, model, fake_clients(core=core))
    assert run["status"] == "succeeded", run["error"]
    assert len(model.offered) == 26 and model.offered[-1] == ["ask_user"]
    assert core.paths().count("/api/v2/users/profile") == 2
    errors = [
        p["error"]
        for p in await _stored_tools(repo, run)
        if p["tool_name"] == "core_whoami"
    ]
    assert len(errors) == 23 and SERVICE_FAILED_TWICE not in errors[:2]
    assert errors[2:] == [SERVICE_FAILED_TWICE] * 21
    refused = [
        row for row in await _audited(repo, run) if row[1] == SERVICE_FAILED_TWICE
    ]
    assert len(refused) == 21


def _raises(exc: Exception) -> Any:
    """A fake service answer that fails before any response, as a timeout or
    a refused connection does."""

    def respond(request: httpx.Request) -> httpx.Response:
        raise exc

    return respond


@pytest.mark.parametrize(
    ("answer", "requests"),
    [
        # The service failed: a first retry runs, the next repeat does not.
        (httpx.Response(503, json={"detail": "down"}), 2),
        (httpx.Response(429, json={"detail": "slow down"}), 2),
        (_raises(httpx.ConnectError("refused")), 2),
        (_raises(httpx.ReadTimeout("slow")), 2),
        # The service answered: not its failure, so every repeat runs and
        # counts toward the tool-call limit as before.
        (httpx.Response(404, json={"detail": "no profile"}), 4),
    ],
    ids=["503", "429", "unreachable", "timeout", "404"],
)
async def test_a_call_the_service_failed_twice_is_not_run_again(
    answer: Any, requests: int
) -> None:
    async def emit(event: Any) -> None:
        return None

    core = _profile_core(100)
    core.routes[("GET", "/api/v2/users/profile")] = answer
    deps = RunDeps(
        message_id="m1",
        emit=emit,
        env=tool_env(fake_clients(core=core)),
        budget=RunBudget(max_tokens=200_000, max_tool_calls=30),
    )
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="who am I?")], run_id="r1"),
        ModelResponse(
            parts=[ToolCallPart(tool_name="core_whoami", args={}, tool_call_id="c1")],
            usage=RequestUsage(input_tokens=1_000),
            run_id="r1",
        ),
    ]
    whoami = _tool(BY_WIRE_NAME["core_whoami"])
    refusals: list[str] = []
    for n in range(4):
        ctx = RunContext(
            deps=deps,
            model=TestModel(),
            usage=RunUsage(requests=1, input_tokens=1_000),
            messages=messages,
            run_id="r1",
            run_step=n + 1,
            tool_call_id=f"call-{n}",
        )
        with pytest.raises(ToolFailed) as failed:
            await whoami.function(ctx)  # type: ignore[call-arg]
        refusals.append(failed.value.message)
    assert core.paths().count("/api/v2/users/profile") == requests
    assert refusals.count(SERVICE_FAILED_TWICE) == 4 - requests
    # Refused or not, each call counts toward the tool-call limit.
    assert deps.admitted_calls == {"r1": 4}
