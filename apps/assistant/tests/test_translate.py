from pydantic_ai import Agent, AgentRunResultEvent, RunContext
from pydantic_ai.exceptions import ToolFailed as PydanticToolFailed
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.test import TestModel
from pydantic_core import ValidationError

from assistant.agent import INSTRUCTIONS, PartIds, RunDeps, build_agent
from assistant.events import (
    DataPart,
    RunEvent,
    StepStarted,
    TextDelta,
    TextEnded,
    TextStarted,
    ToolCalled,
    ToolFailed,
    ToolReturned,
)
from assistant.runs.translate import EventTranslator
from assistant.tools.toolset import _ARGUMENTS_VALIDATOR


async def _run(prompt: str, agent: Agent[RunDeps, str] | None = None) -> list[RunEvent]:
    events: list[RunEvent] = []
    part_ids = PartIds("m1")

    async def emit(event: RunEvent) -> None:
        events.append(event)

    agent = agent or build_agent("test")
    translator = EventTranslator(part_ids)
    deps = RunDeps(message_id="m1", emit=emit, part_ids=part_ids)
    async with agent.run_stream_events(prompt, deps=deps) as stream:
        async for event in stream:
            if not isinstance(event, AgentRunResultEvent):
                events.extend(translator.translate(event))
    return events


def _proposing_agent() -> Agent[RunDeps, str]:
    agent: Agent[RunDeps, str] = Agent(
        TestModel(), deps_type=RunDeps, instructions=INSTRUCTIONS
    )

    @agent.tool(name="show_card")
    async def show_card(ctx: RunContext[RunDeps], /, title: str) -> str:
        await ctx.deps.emit_data("proposal", {"title": title, "rows": []})
        return "shown"

    return agent


async def test_text_answer_becomes_text_events() -> None:
    events = await _run("hello")
    assert isinstance(events[0], StepStarted)
    texts = [e for e in events if isinstance(e, TextDelta)]
    assert texts and all(e.part_id.startswith("m1:") for e in texts)
    assert any(isinstance(e, TextStarted) for e in events)
    assert any(isinstance(e, TextEnded) for e in events)


async def test_tool_calls_and_data_parts() -> None:
    # The proposing agent exposes one tool, which TestModel calls once.
    events = await _run("propose something", _proposing_agent())
    calls = [e for e in events if isinstance(e, ToolCalled)]
    returns = [e for e in events if isinstance(e, ToolReturned)]
    data = [e for e in events if isinstance(e, DataPart)]
    assert [c.tool_name for c in calls] == ["show_card"]
    assert returns and returns[0].tool_call_id == calls[0].tool_call_id
    assert data and data[0].name == "proposal"
    # A new step starts after the tool result, before the final text.
    step_indexes = [i for i, e in enumerate(events) if isinstance(e, StepStarted)]
    assert len(step_indexes) >= 2
    # Data and text parts draw from one counter, so their ids never collide.
    text_ids = {e.part_id for e in events if isinstance(e, TextStarted)}
    assert data[0].part_id == "m1:1"
    assert text_ids == {"m1:2"}


async def test_tool_raising_tool_failed_becomes_failure() -> None:
    agent: Agent[None, str] = Agent(TestModel(custom_output_text="done"))

    @agent.tool(name="boom")
    async def boom(ctx: RunContext[None], /) -> str:
        raise PydanticToolFailed("kaboom")

    translator = EventTranslator(PartIds("m1"))
    events: list[RunEvent] = []
    async with agent.run_stream_events("go") as stream:
        async for event in stream:
            if not isinstance(event, AgentRunResultEvent):
                events.extend(translator.translate(event))
    failed = [e for e in events if isinstance(e, ToolFailed)]
    assert [f.error for f in failed] == ["kaboom"]
    assert not any(isinstance(e, ToolReturned) for e in events)


def _text_start(index: int, content: str = "") -> PartStartEvent:
    return PartStartEvent(index=index, part=TextPart(content=content))


def _text_delta(index: int, delta: str) -> PartDeltaEvent:
    return PartDeltaEvent(index=index, delta=TextPartDelta(content_delta=delta))


def _text_end(index: int, content: str = "") -> PartEndEvent:
    return PartEndEvent(index=index, part=TextPart(content=content))


def _feed(translator: EventTranslator, *stream: object) -> list[RunEvent]:
    events: list[RunEvent] = []
    for event in stream:
        events.extend(translator.translate(event))  # type: ignore[arg-type]
    return events


def test_text_tool_text_in_one_response_is_one_step() -> None:
    call = ToolCallPart(tool_name="t", args={"a": 1}, tool_call_id="c1")
    events = _feed(
        EventTranslator(PartIds("m")),
        _text_start(0),
        _text_delta(0, "a"),
        _text_end(0, "a"),
        PartStartEvent(index=1, part=call),
        PartEndEvent(index=1, part=call),
        FunctionToolCallEvent(part=call),
    )
    assert [type(e) for e in events].count(StepStarted) == 1
    assert isinstance(events[0], StepStarted)
    starts = [e for e in events if isinstance(e, TextStarted)]
    assert len(starts) == 1 and starts[0].part_id == "m:1"
    assert [type(e).__name__ for e in events] == [
        "StepStarted",
        "TextStarted",
        "TextDelta",
        "TextEnded",
        "ToolCalled",
    ]


def test_two_text_parts_in_one_response_get_distinct_ids() -> None:
    events = _feed(
        EventTranslator(PartIds("m")),
        _text_start(0),
        _text_delta(0, "a"),
        _text_start(1, "b"),
        _text_delta(1, "c"),
        _text_end(0, "a"),
        _text_end(1, "bc"),
    )
    started = [e.part_id for e in events if isinstance(e, TextStarted)]
    ended = [e.part_id for e in events if isinstance(e, TextEnded)]
    assert started == ["m:1", "m:2"]
    assert ended == ["m:1", "m:2"]
    deltas = [(e.part_id, e.delta) for e in events if isinstance(e, TextDelta)]
    assert deltas == [("m:1", "a"), ("m:2", "b"), ("m:2", "c")]
    assert sum(isinstance(e, StepStarted) for e in events) == 1


def test_retry_prompt_result_becomes_tool_failed() -> None:
    retry = RetryPromptPart(content="bad arguments", tool_name="t", tool_call_id="c1")
    events = _feed(EventTranslator(PartIds("m")), FunctionToolResultEvent(part=retry))
    assert len(events) == 1
    assert isinstance(events[0], ToolFailed)
    assert events[0].tool_call_id == "c1"
    assert "bad arguments" in events[0].error


def _json_invalid(tool_name: str) -> RetryPromptPart:
    """The retry pydantic-ai builds for arguments that are not JSON (a call cut
    off mid-card): each error's ``input`` is the raw text."""
    raw = '{"questions":[{"options":[{"label":"A","value":"31"'
    try:
        _ARGUMENTS_VALIDATOR.validate_json(raw)
    except ValidationError as exc:
        return RetryPromptPart.from_error(exc, tool_name=tool_name, tool_call_id="c1")
    raise AssertionError("the arguments parsed")


def test_an_ask_card_that_is_not_json_fails_without_its_values() -> None:
    """The web shows the error text; the model keeps pydantic-ai's full retry."""
    events = _feed(
        EventTranslator(PartIds("m")),
        FunctionToolResultEvent(part=_json_invalid("ask_user")),
    )
    [failed] = events
    assert isinstance(failed, ToolFailed)
    assert "json_invalid" in failed.error and "31" not in failed.error


def test_other_tools_keep_their_whole_retry_text() -> None:
    retry = _json_invalid("catalog_search")
    [failed] = _feed(EventTranslator(PartIds("m")), FunctionToolResultEvent(part=retry))
    assert isinstance(failed, ToolFailed)
    assert failed.error == retry.model_response() and "31" in failed.error


def test_denied_tool_return_becomes_tool_failed() -> None:
    denied = ToolReturnPart(
        tool_name="t", content="not allowed", tool_call_id="c1", outcome="denied"
    )
    events = _feed(EventTranslator(PartIds("m")), FunctionToolResultEvent(part=denied))
    assert [type(e) for e in events] == [ToolFailed]
    assert isinstance(events[0], ToolFailed)
    assert events[0].error == "not allowed"


def test_next_response_after_tool_result_starts_a_new_step_with_fresh_ids() -> None:
    call = ToolCallPart(tool_name="t", args={}, tool_call_id="c1")
    ok = ToolReturnPart(tool_name="t", content="ok", tool_call_id="c1")
    translator = EventTranslator(PartIds("m"))
    first = _feed(
        translator,
        _text_start(0),
        _text_end(0),
        FunctionToolCallEvent(part=call),
        FunctionToolResultEvent(part=ok),
    )
    second = _feed(translator, _text_start(0), _text_delta(0, "x"), _text_end(0, "x"))
    assert sum(isinstance(e, StepStarted) for e in first) == 1
    assert isinstance(second[0], StepStarted)
    first_ids = {e.part_id for e in first if isinstance(e, TextStarted)}
    second_ids = {e.part_id for e in second if isinstance(e, TextStarted)}
    assert first_ids == {"m:1"} and second_ids == {"m:2"}
    assert any(isinstance(e, TextDelta) and e.part_id == "m:2" for e in second)
