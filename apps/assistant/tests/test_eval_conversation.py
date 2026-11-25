"""Tasks of several messages: the harness answers each message for real and
keeps the conversation between them as the app does, the checks grade the
turn they name, and the cold-cache double makes chosen requests report no
cache reads to the budget. Scripted models stand in for a provider."""

import json
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

import pytest
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters, StreamedResponse
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings

from assistant.config import AssistantSettings
from assistant.history import SHORTENED
from assistant.skills import BUILT_IN
from assistant.tools.testing import ScriptedModel, TurnModel
from assistant.tools.toolset import (
    ANSWER_STEP_REFUSALS,
    LOOK_UPS_USED_UP,
    RESULT_TOO_LARGE,
    STAGE_REFUSALS,
)
from evals.backends import Backends, write_eval_catalog
from evals.graders import Grade, grade
from evals.harness import ToolCall, Transcript, TurnReport, refused_for_room, run_task
from evals.judge import ModelJudge, apply_judge
from evals.report import build_report
from evals.tasks import EvalTask, load_tasks


@pytest.fixture(scope="module")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-conversation")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


def _task(
    prompt: str,
    conversation: list[dict[str, Any]],
    checks: list[dict[str, Any]],
    **fields: Any,
) -> EvalTask:
    """A map task of the given messages on the map project's page."""
    page = next(t for t in load_tasks("map") if t.id == "map-01").context
    return EvalTask.model_validate(
        {
            "id": "map-99",
            "suite": "map",
            "context": page,
            "conversation": conversation,
            "prompt": prompt,
            "checks": checks,
            **fields,
        }
    )


def _returns(messages: list[ModelMessage], tool: str) -> list[ToolReturnPart]:
    return [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == tool
    ]


def _opacity(value: float) -> dict[str, Any]:
    return {
        "layer_project_id": 31,
        "operations": [{"op": "set", "path": "/symbol/fill/opacity", "value": value}],
    }


OUTLINE = {
    "layer_project_id": 31,
    "operations": [
        {
            "op": "set",
            "path": "/symbol/outline",
            "value": {"color": "#333333", "width": 0.5},
        }
    ],
}
LANGUAGE = {"kind": "language", "expected": "en"}


# ---- the conversation between turns ---------------------------------------------------


async def test_the_next_turn_gets_the_earlier_calls_as_production_sends_them(
    backends: Backends, settings: AssistantSettings
) -> None:
    """The second answer reads the first one's calls and results from the
    stored conversation, through the agent's own history processing: the
    loaded skill whole, a long read shortened to its counts."""
    task = _task(
        "Make them a bit lighter.",
        [{"text": "Which layers does this map have?"}],
        [LANGUAGE],
    )
    model = TurnModel(
        [
            (
                [("skills_load", {"name": "style-a-map"}), ("project_get_layers", {})],
                "The map has eleven layers.",
            ),
            ([], "Nothing to change yet."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    second = [m for m in model.requests if _returns(m, "skills_load")][-1]
    [skill] = _returns(second, "skills_load")
    assert isinstance(skill.content, dict)
    assert skill.content["text"] == BUILT_IN["style-a-map"].instructions
    [layers] = _returns(second, "project_get_layers")
    assert isinstance(layers.content, dict)
    assert layers.content["shortened"] == SHORTENED
    # The first answer's own requests saw the read whole.
    first = [m for m in model.requests if _returns(m, "project_get_layers")][0]
    assert "shortened" not in _returns(first, "project_get_layers")[0].content
    assert [turn.prompt for turn in transcript.turns] == [
        "Which layers does this map have?",
        "Make them a bit lighter.",
    ]


async def test_the_skill_a_turn_loaded_counts_in_the_next_turns(
    backends: Backends, settings: AssistantSettings
) -> None:
    """style_update needs the styling skill in the conversation: loaded in the
    first turn, it is not loaded again, and the stand-in keeps the style
    between the turns."""
    task = _task(
        "Give them a dark outline too.",
        [{"text": "Make the districts half transparent."}],
        [LANGUAGE],
    )
    model = TurnModel(
        [
            (
                [
                    ("skills_load", {"name": "style-a-map"}),
                    ("style_update", _opacity(0.5)),
                ],
                "The districts are half transparent now.",
            ),
            ([("style_update", OUTLINE)], "They have a dark outline now."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls), [
        (c.name, c.result) for c in transcript.tool_calls if c.failed
    ]
    first, second = transcript.turns
    assert [c.name for c in first.tool_calls] == ["skills_load", "style_update"]
    assert [c.name for c in second.tool_calls] == ["style_update"]
    assert first.map_after == second.map_before
    assert transcript.map_before == first.map_before
    assert transcript.map_after == second.map_after
    assert second.map_after is not None
    link = second.map_after["layers"][31]
    document = second.map_after["styles"][link["active_style_id"]]["document"]
    assert document["symbol"]["fill"]["opacity"] == 0.5
    assert document["symbol"]["outline"]["width"] == 0.5
    # Each turn reports its own runs, requests and tokens.
    assert (first.runs, first.requests) == (1, 3)
    assert (second.runs, second.requests) == (1, 2)
    assert first.input_tokens > 0 and second.output_tokens > 0
    assert transcript.input_tokens == first.input_tokens + second.input_tokens
    assert transcript.answer == second.answer == "They have a dark outline now."


REMOVE = {"operations": [{"op": "remove_layer", "layer_project_id": 39}]}
REMOVE_CARD = {
    "questions": [
        {
            "question": "Remove the layer Old boundaries from the project?",
            "header": "Remove",
            "options": [
                {"label": "Remove it", "value": "remove_layer:39"},
                {"label": "Keep it"},
            ],
        }
    ]
}


async def test_a_card_declined_in_an_earlier_turn_is_in_the_conversation(
    backends: Backends, settings: AssistantSettings
) -> None:
    """A turn whose card the eval user answers runs twice; declined, the
    second run gets the pick of the option without the value, and the layer
    stays until a later pick."""
    task = _task(
        "OK, remove it after all.",
        [
            {
                "text": "Remove the old boundaries layer.",
                "answer_card": True,
                "answer_declines": "remove_layer:39",
            }
        ],
        [{"kind": "map", "removed": [39]}, LANGUAGE],
    )
    model = TurnModel(
        [
            (
                [("map_update", REMOVE), ("ask_user", REMOVE_CARD)],
                "Should I remove it?",
            ),
            ([], "I kept the layer."),
            ([("map_update", REMOVE)], "It is removed."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    first, second = transcript.turns
    assert first.runs == 2 and second.runs == 1
    sent = json.dumps([getattr(m, "parts", []) for m in model.requests[2]], default=str)
    assert "Remove: Keep it" in sent
    assert first.map_after is not None and 39 in first.map_after["layers"]
    [again] = second.tool_calls
    assert again.result["applied"] == []
    assert second.map_after is not None and 39 in second.map_after["layers"]
    grades = await grade(task, transcript, backends)
    assert [g.passed for g in grades] == [False, True]


@pytest.mark.parametrize("typed", [True, False])
async def test_a_pick_counts_as_consent_only_until_the_next_typed_message(
    typed: bool, backends: Backends, settings: AssistantSettings
) -> None:
    """The eval user picks the removal, and the answer to the pick removes
    nothing. The removal in the answer to the pick itself runs; after a
    typed message it asks again (``AskHistory`` chains, read from the stored
    rows)."""
    removal = [("map_update", REMOVE)]
    task = _task(
        "Go ahead and remove it now.",
        [
            {
                "text": "Remove the old boundaries layer.",
                "answer_card": True,
                "answer_value": "remove_layer:39",
            }
        ],
        [{"kind": "map", "removed": [39]}, LANGUAGE],
    )
    model = TurnModel(
        [
            (
                [("map_update", REMOVE), ("ask_user", REMOVE_CARD)],
                "Should I remove it?",
            ),
            ([] if typed else removal, "Done."),
            (removal, "It is removed."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    first, second = transcript.turns
    if not typed:
        assert first.map_after is not None and 39 not in first.map_after["layers"]
        return
    assert first.map_after is not None and 39 in first.map_after["layers"]
    [again] = second.tool_calls
    assert again.result["applied"] == []
    assert again.result["confirm"][0]["value"] == "remove_layer:39"
    assert second.map_after is not None and 39 in second.map_after["layers"]


# ---- checks per turn ------------------------------------------------------------------


async def test_checks_grade_the_last_turn_or_the_turn_they_name(
    backends: Backends, settings: AssistantSettings
) -> None:
    def tools(**check: Any) -> dict[str, Any]:
        return {"kind": "tools", **check}

    def style(**check: Any) -> dict[str, Any]:
        return {"kind": "style", "layer_project_id": 31, "where": "same", **check}

    opacity = {"path": "/symbol/fill/opacity", "equals": 0.5}
    outline = {"path": "/symbol/outline/width", "equals": 0.5}
    task = _task(
        "Give them a dark outline too.",
        [{"text": "Make the districts half transparent."}],
        [
            tools(called=["style_update"], not_called=["skills_load"]),
            tools(turn=1, called=["skills_load", "style_update"]),
            tools(turn=2, called=["skills_load"]),
            tools(
                turn="all", at_most={"style_update": 2}, skill_loads={"style-a-map": 1}
            ),
            tools(turn="all", at_most={"style_update": 1}),
            style(turn=1, paths=[opacity], unchanged=["/symbol/outline"]),
            style(paths=[opacity, outline], unchanged=["/symbol/fill/opacity"]),
            style(turn=2, unchanged=["/symbol/outline"]),
            style(turn="all", paths=[opacity, outline]),
            {"kind": "answer", "turn": 1, "all_of": ["transparent"]},
            {"kind": "answer", "all_of": ["transparent"]},
            {"kind": "map", "turn": 2, "writes": "none"},
            LANGUAGE,
        ],
    )
    model = TurnModel(
        [
            (
                [
                    ("skills_load", {"name": "style-a-map"}),
                    ("style_update", _opacity(0.5)),
                ],
                "The districts are half transparent now.",
            ),
            ([("style_update", OUTLINE)], "They have a dark outline now."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    grades = await grade(task, transcript, backends)
    assert [g.passed for g in grades] == [
        True,
        True,
        False,
        True,
        False,
        True,
        True,
        False,
        True,
        True,
        False,
        False,
        True,
    ], [(g.check, g.detail) for g in grades]


def test_a_check_may_not_name_a_turn_the_task_has_not() -> None:
    with pytest.raises(ValueError, match="turn 3 of 2"):
        _task("Fine.", [{"text": "Hello there."}], [{**LANGUAGE, "turn": 3}])
    with pytest.raises(ValueError, match="answer_declines needs answer_card"):
        _task("Fine.", [{"text": "Hello.", "answer_declines": "x"}], [LANGUAGE])


async def test_a_hand_made_transcript_is_one_turn_for_every_check(
    backends: Backends,
) -> None:
    """A transcript without turns (made by hand) is graded whole, whatever
    turn a check names."""
    task = _task(
        "Fine.",
        [{"text": "Hello there."}],
        [{"kind": "answer", "turn": 1, "all_of": ["done"]}, LANGUAGE],
    )
    transcript = Transcript(
        task_id=task.id,
        answer="All done here, nothing else to do.",
        tool_calls=[],
        proposals=[],
        requests={},
        error=None,
        input_tokens=0,
        output_tokens=0,
        seconds=0.0,
        first_text_seconds=None,
    )
    assert [g.passed for g in await grade(task, transcript, backends)] == [True, True]


# ---- refused for lack of room ---------------------------------------------------------


def _failed(result: Any, name: str = "style_update") -> ToolCall:
    return ToolCall(name, {}, result, True)


def test_a_refusal_for_lack_of_room_is_told_from_other_failures() -> None:
    refusals = [
        *STAGE_REFUSALS.values(),
        ANSWER_STEP_REFUSALS["style_update"],
        LOOK_UPS_USED_UP,
        RESULT_TOO_LARGE,
    ]
    for text in refusals:
        assert refused_for_room([_failed(text)]) == ["style_update"], text
    assert (
        refused_for_room([ToolCall("style_update", {}, LOOK_UPS_USED_UP, False)]) == []
    )
    assert refused_for_room([_failed("The layer was not found.")]) == []
    assert refused_for_room(
        [_failed({"detail": LOOK_UPS_USED_UP}, "project_count")]
    ) == ["project_count"]


async def test_the_room_check_fails_a_run_with_a_call_refused_and_passes_one_without(
    backends: Backends, settings: AssistantSettings
) -> None:
    """With room for two tool calls, a third call of the answer is refused by
    its stage: the check fails on it, and passes the run of two calls."""
    tight = settings.model_copy(update={"run_max_tool_calls": 2})
    calls = [
        ("skills_load", {"name": "style-a-map"}),
        ("style_update", _opacity(0.5)),
        ("style_update", OUTLINE),
    ]
    task = _task(
        "Make the districts half transparent with a dark outline.",
        [],
        [{"kind": "tools", "not_refused_for_room": True}, LANGUAGE],
    )
    # ScriptedModel: past the look-ups the stage note joins the request as a
    # user prompt part, which a TurnModel would take for a new turn.
    model = ScriptedModel(calls, "The districts are half transparent now.")
    transcript = await run_task(task, model.model, backends, tight)
    assert transcript.error is None, transcript.error
    assert transcript.turns[-1].refused_for_room == ["style_update"]
    [room, _] = await grade(task, transcript, backends)
    assert room.passed is False and "style_update" in room.detail
    model = ScriptedModel(calls[:2], "The districts are half transparent now.")
    transcript = await run_task(task, model.model, backends, tight)
    assert transcript.turns[-1].refused_for_room == []
    [room, _] = await grade(task, transcript, backends)
    assert room.passed is True


# ---- the cold cache ------------------------------------------------------------------


class _WarmCache(WrapperModel):
    """A test double: every request reports half its input as read from the
    provider's cache, as a provider that caches does."""

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: Any = None,
    ) -> AsyncGenerator[StreamedResponse]:
        async with self.wrapped.request_stream(
            messages, model_settings, model_request_parameters, run_context
        ) as stream:
            events = stream._get_event_iterator

            async def warm() -> AsyncIterator[Any]:
                async for event in events():
                    yield event
                usage = stream._usage
                stream._usage = replace(
                    usage, cache_read_tokens=usage.input_tokens // 2
                )

            stream._get_event_iterator = warm  # type: ignore[method-assign]
            yield stream


async def test_the_cold_requests_of_a_turn_report_no_cache_reads_to_the_budget(
    backends: Backends, settings: AssistantSettings
) -> None:
    """The second request of the first answer reports no cache reads: so the
    run's usage counts them (the budget's ``weighted_tokens``), and the
    stored response carries them (the budget's ``next_call``); the other
    requests keep what the provider reported."""
    task = _task(
        "Thanks.",
        [{"text": "Which layers does this map have?", "cold_requests": [2]}],
        [LANGUAGE],
    )
    model = TurnModel(
        [
            (
                [("project_get_layers", {}), ("project_get_layers", {"x": 1})],
                "The map has eleven layers.",
            ),
            ([], "You are welcome."),
        ]
    )
    transcript = await run_task(task, _WarmCache(model.model), backends, settings)
    assert transcript.error is None, transcript.error
    later = model.requests[-1]
    responses = [m for m in later if isinstance(m, ModelResponse)]
    first_turn = responses[:3]
    reads = [r.usage.cache_read_tokens for r in first_turn]
    assert reads[0] > 0 and reads[1] == 0 and reads[2] > 0
    assert transcript.turns[0].cache_read_tokens == reads[0] + reads[2]
    assert transcript.turns[1].cache_read_tokens > 0
    # Without the option the same requests report their reads.
    plain = _task("Thanks.", [{"text": "Which layers does this map have?"}], [LANGUAGE])
    model = TurnModel(
        [
            (
                [("project_get_layers", {}), ("project_get_layers", {"x": 1})],
                "The map has eleven layers.",
            ),
            ([], "You are welcome."),
        ]
    )
    transcript = await run_task(plain, _WarmCache(model.model), backends, settings)
    responses = [m for m in model.requests[-1] if isinstance(m, ModelResponse)]
    assert all(r.usage.cache_read_tokens > 0 for r in responses[:3])


# ---- the report ----------------------------------------------------------------------


def test_the_report_lists_each_turn_of_a_conversation() -> None:
    task = _task("Thanks.", [{"text": "Hello there."}], [LANGUAGE])
    turns = [
        TurnReport(
            prompt="Hello there.",
            answer="Hi.",
            tool_calls=[_failed(LOOK_UPS_USED_UP)],
            input_tokens=10,
            output_tokens=2,
            cache_read_tokens=4,
            requests=2,
            runs=1,
        ),
        TurnReport(prompt="Thanks.", answer="You are welcome.", requests=1, runs=1),
    ]
    transcript = Transcript(
        task_id=task.id,
        answer="You are welcome.",
        tool_calls=turns[0].tool_calls,
        proposals=[],
        requests={},
        error=None,
        input_tokens=10,
        output_tokens=2,
        seconds=1.0,
        first_text_seconds=None,
        turns=turns,
    )
    from datetime import UTC, datetime

    report = build_report(
        {"model": "m"}, None, [(task, transcript, [])], datetime.now(UTC)
    )
    [entry] = report["tasks"]
    assert entry["turns"] == [
        {
            "tools": ["style_update"],
            "refused_for_room": ["style_update"],
            "input_tokens": 10,
            "output_tokens": 2,
            "cache_read_tokens": 4,
            "requests": 2,
            "answer": "Hi.",
        },
        {
            "tools": [],
            "refused_for_room": [],
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "requests": 1,
            "answer": "You are welcome.",
        },
    ]


# ---- the judge -----------------------------------------------------------------------


def _two_turns() -> Transcript:
    turns = [
        TurnReport(prompt="Hello there.", answer="Hi, how can I help?"),
        TurnReport(prompt="Undo that.", answer="Use the undo button below."),
    ]
    return Transcript(
        task_id="map-99",
        answer=turns[-1].answer,
        tool_calls=[],
        proposals=[],
        requests={},
        error=None,
        input_tokens=0,
        output_tokens=0,
        seconds=0.0,
        first_text_seconds=None,
        turns=turns,
    )


async def test_the_judge_reads_the_turn_its_check_names_after_the_earlier_ones() -> (
    None
):
    task = _task(
        "Undo that.",
        [{"text": "Hello there."}],
        [
            {"kind": "judge", "rubric": "The answer names the undo button."},
            {"kind": "judge", "turn": 1, "rubric": "The answer greets the user."},
        ],
    )
    sent: list[dict[str, Any]] = []

    async def verdict(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        [request] = [m for m in messages if isinstance(m, ModelRequest)]
        prompt = next(p for p in request.parts if isinstance(p, UserPromptPart))
        assert isinstance(prompt.content, str)
        sent.append(json.loads(prompt.content))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    info.output_tools[0].name, {"passed": True, "reason": "Fine."}
                )
            ]
        )

    grades = [Grade("judge", None, "judge"), Grade("judge", None, "judge")]
    decided = await apply_judge(
        task, _two_turns(), grades, ModelJudge(FunctionModel(verdict))
    )
    assert [g.passed for g in decided] == [True, True]
    last, first = sent
    assert (last["question"], last["answer"]) == (
        "Undo that.",
        "Use the undo button below.",
    )
    assert last["earlier"] == [
        {"user": "Hello there.", "assistant": "Hi, how can I help?"}
    ]
    assert (first["question"], first["answer"]) == (
        "Hello there.",
        "Hi, how can I help?",
    )
    assert "earlier" not in first
