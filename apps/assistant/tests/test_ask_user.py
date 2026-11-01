"""ask_user (spec §5.1, §5.2): the card's limits, the data-ask part, option
values that never reach the web, and a run that ends after asking."""

import json
import re
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import (
    FunctionToolResultEvent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    ToolReturnPart,
)
from pydantic_ai.models import StreamedResponse
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.usage import RequestUsage

from assistant.agent import RunDeps, build_agent
from assistant.asks import (
    CARD_ID_PATTERN,
    AskHistory,
    AskOption,
    AskUserInput,
    CardAnswer,
    answer_lines,
    answered_adds,
    card_data,
    picked_ids,
    public_args,
    recent_picked_ids,
    unadded_dataset,
    user_chose,
)
from assistant.budget import MAX_RESULT_READS, RESULT_READS, RunBudget, read_allowance
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.encoding.ai_sdk import AiSdkEncoder
from assistant.events import DataPart, ToolCalled, to_ui_message
from assistant.login import Login
from assistant.prompt import (
    ANSWER_NOW_CARD,
    CARD_AFTER_TEXT,
    read_the_result,
    render_note,
)
from assistant.runs.turn import Turn, run_turn
from assistant.tools.ask import (
    ADDS_NAMED,
    ASK_USER,
    ASKED_NOTE,
    FOUND_TITLE_CHARS,
    MAX_NAMED_FOUND,
    ONE_CARD,
    REPEATED_CARD,
    REPORT_FIRST,
    UNKNOWN_TITLE,
)
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import (
    Recorder,
    ScriptedModel,
    fake_clients,
    signed_in,
    stage_note,
    tool_env,
)
from assistant.tools.toolset import (
    LOOK_UPS_USED_UP,
    REPORT_REFUSALS,
    RESULT_READ_TOOLS,
    RESULT_TOO_LARGE,
    _call_key,
)

CARD: dict[str, Any] = {
    "questions": [
        {
            "question": "Which schools should the catchments start from?",
            "header": "Schools",
            "options": [
                {
                    "label": "Schulen (Stand 2019)",
                    "description": "Older list",
                    "value": "32",
                },
                {
                    "label": "Schulen",
                    "description": "The current list",
                    "recommended": True,
                    "value": "31",
                },
            ],
        },
        {
            "question": "Which destinations matter?",
            "header": "Destinations",
            "multi_select": True,
            "options": [
                {
                    "label": "Supermarkets",
                    "description": "Adds it to the project",
                    "value": "eval-supermaerkte-bayern",
                },
                {"label": "Leave it open", "description": "Choose it later"},
            ],
        },
    ]
}


def _question(**changes: Any) -> dict[str, Any]:
    question: dict[str, Any] = {
        "question": "Which one?",
        "header": "Data",
        "options": [{"label": "First"}, {"label": "Second"}],
    }
    question.update(changes)
    return question


def _rejected(card: dict[str, Any]) -> str:
    with pytest.raises(ValidationError) as caught:
        AskUserInput.model_validate(card)
    return str(caught.value)


def test_a_card_has_one_to_four_questions() -> None:
    assert "at least 1" in _rejected({"questions": []})
    assert "at most 4" in _rejected({"questions": [_question()] * 5})
    assert (
        len(AskUserInput.model_validate({"questions": [_question()] * 4}).questions)
        == 4
    )


def test_a_question_is_a_sentence_ending_in_a_question_mark() -> None:
    assert "ends in '?'" in _rejected({"questions": [_question(question="Pick one")]})
    assert "at most 300" in _rejected(
        {"questions": [_question(question="x" * 300 + "?")]}
    )


def test_a_header_is_a_chip_of_at_most_twelve_characters() -> None:
    def header(text: str) -> str:
        card = AskUserInput.model_validate({"questions": [_question(header=text)]})
        return card.questions[0].header

    # Longer ones are cut at the last word end that fits, else at twelve.
    assert header("Destinations!") == "Destinations"
    assert header("Schools near parks") == "Schools near"
    assert header("Data, time and place") == "Data, time"
    assert header("Schools") == "Schools"
    assert "at least 1" in _rejected({"questions": [_question(header="")]})
    assert "valid string" in _rejected({"questions": [_question(header=12)]})


def test_a_long_header_is_shortened() -> None:
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Which data?",
                    "header": "Bevölkerungsdaten",
                    "options": [{"label": "Zensus"}, {"label": "Blocks"}],
                }
            ]
        }
    )
    header = card.questions[0].header
    assert len(header) <= 12
    assert header.startswith("Bevölkerung")


@pytest.mark.parametrize(
    "labels", [["A", "Blocks"], ["Zensus", "zensus "], ["...", "Blocks"]]
)
def test_options_need_distinct_labels_of_two_letters(labels: list[str]) -> None:
    with pytest.raises(ValidationError, match="distinct labels"):
        AskUserInput.model_validate(
            {
                "questions": [
                    {
                        "question": "Which data?",
                        "header": "Data",
                        "options": [{"label": label} for label in labels],
                    }
                ]
            }
        )


@pytest.mark.parametrize(
    "label",
    [
        "Option 1",
        "option 2",
        "Option A",
        "Erste Option",
        "Zweite Option",
        "zweite Variante",
        "Variante 1",
        "Variante 12",
        "Option II",
        "Auswahl A",
        "Choice 2",
        "First option",
        "Placeholder",
        "Platzhalter",
        "Test",
        "test.",
        "Test 1",
        "Test 2",
        "Test A",
        "B",
        "3",
    ],
)
def test_placeholder_labels_are_refused(label: str) -> None:
    """A probe card with generic options ("Erste Option", "Zweite Option")
    passed the two-letter rule and was shown to the user."""
    options = [{"label": "Zensus 2022"}, {"label": label}]
    assert "no placeholders such as 'Option 1' or 'Test'" in _rejected(
        {"questions": [_question(options=options)]}
    )


@pytest.mark.parametrize(
    "labels",
    [
        ["Variante mit Fahrrad", "Variante zu Fuß"],
        ["Option Fahrrad", "Testgebiet Nord"],
        ["Testgebiet 1", "Test-Region"],
        ["Erste Ausbaustufe", "Zweite Ausbaustufe"],
        ["Auswahl der Schulen", "Alle Schulen"],
        ["Ja", "Nein"],
        # Scenarios named by their target year.
        ["Variante 2030", "Option 2035"],
    ],
)
def test_labels_that_only_contain_such_a_word_pass(labels: list[str]) -> None:
    card = AskUserInput.model_validate(
        {"questions": [_question(options=[{"label": label} for label in labels])]}
    )
    assert [option.label for option in card.questions[0].options] == labels


@pytest.mark.parametrize(
    "changes",
    [
        {"header": "Test"},
        {"header": "test?"},
        {"question": "Test?"},
        {"question": " TEST ?"},
    ],
)
def test_a_test_card_is_refused(changes: dict[str, Any]) -> None:
    assert "no test cards" in _rejected({"questions": [_question(**changes)]})


def test_the_probe_card_that_reached_the_user_is_refused() -> None:
    probe = {
        "questions": [
            {
                "question": "Welche Variante?",
                "header": "Test",
                "options": [
                    {"label": "Erste Option", "description": "d"},
                    {"label": "Zweite Option", "description": "d"},
                ],
            }
        ]
    }
    assert "no test cards" in _rejected(probe)
    probe["questions"][0]["header"] = "Variante"
    assert "no placeholders" in _rejected(probe)


def test_a_header_or_question_that_only_contains_test_passes() -> None:
    card = AskUserInput.model_validate(
        {
            "questions": [
                _question(header="Testgebiet", question="Test der Messstellen?")
            ]
        }
    )
    assert card.questions[0].header == "Testgebiet"


#: A card shown before the label rule: one character, and twice the same label.
_OLD_CARD: dict[str, Any] = {
    "questions": [
        {
            "question": "How many minutes?",
            "header": "Minutes",
            "options": [
                {"label": "5", "value": "run:w1"},
                {"label": "5 ", "value": "five"},
            ],
        }
    ]
}


def test_a_stored_card_is_read_back_under_the_rules_it_was_shown_with() -> None:
    """The label rule is for new cards: a stored card that breaks it is still
    read back, and its answer still counts."""
    answer = {"card_id": "ask-c1", "answers": [{"question": 0, "options": [0]}]}
    stored = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": "ask_user",
                    "state": "output",
                    "args": _OLD_CARD,
                    "output": {"card_id": "ask-c1", "status": "asked"},
                }
            ],
        },
        {"role": "user", "parts": [{"type": "answer", "answer": answer}]},
    ]
    history = AskHistory.from_stored(stored)
    card = history.cards["ask-c1"]
    assert [option.label for option in card.questions[0].options] == ["5", "5 "]
    assert user_chose(history, "run:w1")
    assert picked_ids(history) == {"run:w1"}
    assert answer_lines(card, CardAnswer.model_validate(answer)) == (
        "Minutes: 5 (value run:w1)"
    )


def test_a_stored_test_card_is_read_back() -> None:
    probe = {
        "questions": [
            {
                "question": "Test?",
                "header": "Test",
                "options": [{"label": "Erste Option"}, {"label": "Zweite Option"}],
            }
        ]
    }
    card = AskUserInput.model_validate(probe, context={"stored_card": True})
    assert card.questions[0].header == "Test"


async def test_a_new_card_with_such_labels_is_refused() -> None:
    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        raise AssertionError("no card is shown")

    env = tool_env(fake_clients(), emit_data=emit)
    with pytest.raises(InputInvalid, match="distinct labels"):
        await execute(ASK_USER, env, _OLD_CARD, tool_call_id="call-1")


def test_ask_user_runs_once_per_answer() -> None:
    assert ASK_USER.once_per_answer and "one card" in ASK_USER.once_per_answer.lower()


def test_a_question_has_two_to_four_options() -> None:
    assert "at least 2" in _rejected(
        {"questions": [_question(options=[{"label": "First"}])]}
    )
    five = [{"label": f"O{n}"} for n in range(5)]
    assert "at most 4" in _rejected({"questions": [_question(options=five)]})


def test_labels_and_descriptions_are_short() -> None:
    long_label = [{"label": "x" * 61}, {"label": "Second"}]
    assert "at most 60" in _rejected({"questions": [_question(options=long_label)]})
    long_text = [{"label": "First", "description": "x" * 201}, {"label": "Second"}]
    assert "at most 200" in _rejected({"questions": [_question(options=long_text)]})


def test_at_most_one_option_is_recommended_and_it_comes_first() -> None:
    both = [
        {"label": "First", "recommended": True},
        {"label": "Second", "recommended": True},
    ]
    assert "at most one option" in _rejected({"questions": [_question(options=both)]})
    card = AskUserInput.model_validate(CARD)
    assert [o.label for o in card.questions[0].options] == [
        "Schulen",
        "Schulen (Stand 2019)",
    ]


@pytest.mark.parametrize("label", ["Other", "other…", "Andere", "Sonstiges"])
def test_the_model_never_adds_other_the_card_does(label: str) -> None:
    options = [{"label": "First"}, {"label": label}]
    assert "free-text 'Other' itself" in _rejected(
        {"questions": [_question(options=options)]}
    )


async def test_ask_user_shows_the_card_without_values_and_says_to_wait() -> None:
    emitted: list[tuple[str, dict[str, Any], str | None]] = []

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        emitted.append((name, data, part_id))
        return part_id or "m:1"

    env = tool_env(fake_clients(), emit_data=emit)
    result = await execute(ASK_USER, env, CARD, tool_call_id="call-7")
    card_id = result["card_id"]
    # Minted for the card: providers may repeat their tool call ids.
    assert re.fullmatch(CARD_ID_PATTERN, card_id) and "call-7" not in card_id
    assert result == {"card_id": card_id, "status": "asked", "note": ASKED_NOTE}
    [(name, data, part_id)] = emitted
    assert (name, part_id) == ("ask", card_id)
    assert data == card_data(card_id, AskUserInput.model_validate(CARD))
    assert data["questions"][0]["options"][0] == {
        "label": "Schulen",
        "description": "The current list",
        "recommended": True,
    }
    assert "value" not in json.dumps(data)


async def test_ask_user_needs_the_assistant_dock() -> None:
    with pytest.raises(ToolFailed, match="only be asked in the GOAT assistant"):
        await execute(ASK_USER, tool_env(fake_clients()), CARD, tool_call_id="c1")


def test_public_args_drop_values_from_ask_user_only() -> None:
    public = public_args("ask_user", CARD)
    assert "value" not in json.dumps(public)
    assert public["questions"][0]["options"][1]["label"] == "Schulen"
    other = {"questions": [{"options": [{"value": "kept"}]}]}
    assert public_args("core_find", other) == other
    # Arguments that are not a card show nothing: they may be the model's raw
    # text, values included.
    assert public_args("ask_user", {"questions": "not a list"}) == {}
    raw = '{"questions":[{"options":[{"label":"A","value":"31"'
    public = public_args("ask_user", {"INVALID_JSON": raw})
    assert raw not in json.dumps(public) and "31" not in json.dumps(public)


_RAW_OPTIONS = '[{"label":"A","value":"31"},{"label":"B"}]'
_RAW_QUESTION = '{"question":"Q?","options":[{"label":"A","value":"31"}]}'
_RAW_OPTION = '{"label":"A","value":"31"}'


@pytest.mark.parametrize(
    ("args", "shown"),
    [
        (
            {"questions": [{"question": "Q?", "options": _RAW_OPTIONS}]},
            {"questions": [{"question": "Q?"}]},
        ),
        ({"questions": [_RAW_QUESTION]}, {"questions": []}),
        (
            {
                "questions": [
                    {"question": "Q?", "options": [_RAW_OPTION, {"label": "B"}]}
                ]
            },
            {"questions": [{"question": "Q?", "options": [{"label": "B"}]}]},
        ),
        (
            {"questions": [], "values": _RAW_OPTION},
            {"questions": []},
        ),
        (
            {"questions": [{"options": [{"label": "A", "values": "31"}]}]},
            {"questions": [{"options": [{"label": "A"}]}]},
        ),
        (
            {"questions": [{"options": [{"label": "A", "Value": "31"}]}]},
            {"questions": [{"options": [{"label": "A"}]}]},
        ),
        (
            {"questions": [{"question": "Q?", "note": "31"}]},
            {"questions": [{"question": "Q?"}]},
        ),
        (
            {"questions": [{"options": [{"label": {"text": "A", "value": "31"}}]}]},
            {"questions": [{"options": [{}]}]},
        ),
    ],
    ids=[
        "options-as-text",
        "question-as-text",
        "option-as-text",
        "own-key",
        "option-key-values",
        "option-key-Value",
        "question-key-note",
        "label-as-object",
    ],
)
def test_public_args_show_only_the_shapes_of_a_card(
    args: dict[str, Any], shown: dict[str, Any]
) -> None:
    """Rebuilt, not filtered: text where a question, its options or an option
    belongs, keys of the model's own and objects where a card has a plain value
    may hold values."""
    public = public_args("ask_user", args)
    assert public == shown
    assert "31" not in json.dumps(public)


def test_the_stream_never_carries_option_values() -> None:
    chunks = AiSdkEncoder().encode(
        ToolCalled(tool_call_id="c1", tool_name="ask_user", args=CARD)
    )
    assert "eval-supermaerkte-bayern" not in json.dumps(chunks)
    assert chunks[1]["input"] == public_args("ask_user", CARD)


def test_a_reloaded_message_never_carries_option_values() -> None:
    part = {
        "type": "tool",
        "tool_call_id": "c1",
        "tool_name": "ask_user",
        "args": CARD,
        "state": "output",
        "output": {"card_id": "ask-c1", "status": "asked", "note": ASKED_NOTE},
        "error": None,
    }
    message = to_ui_message("m1", "assistant", [part])
    assert "eval-supermaerkte-bayern" not in json.dumps(message)
    assert message["parts"][0]["input"] == public_args("ask_user", CARD)


async def test_after_asking_the_run_offers_no_more_tools() -> None:
    script = ScriptedModel([("ask_user", CARD)], answer="I asked you above.")
    page = parse_context({"surface": "catalog"})
    seen: list[DataPart] = []

    async def emit(event: Any) -> None:
        if isinstance(event, DataPart):
            seen.append(event)

    deps = RunDeps(
        message_id="m1", emit=emit, prompt_note=render_note(page, None, "en")
    )
    deps.env = tool_env(fake_clients(), page=page, emit_data=deps.emit_data)
    result = await build_agent(script.model).run("which data?", deps=deps)
    assert result.output == "I asked you above."
    assert script.infos[0].function_tools != []
    assert script.infos[1].function_tools == []
    assert deps.asked is True
    [part] = seen
    assert part.name == "ask" and part.part_id == part.data["card_id"]


def test_ask_user_is_never_answered_from_an_earlier_call() -> None:
    assert _call_key(BY_WIRE_NAME["ask_user"], CARD) is None


def test_ask_user_is_on_every_page_and_not_on_mcp() -> None:
    assert ASK_USER.wire_name == "ask_user"
    assert ASK_USER.risk == "read" and not ASK_USER.mcp and not ASK_USER.returns_data


async def test_a_shown_card_ends_the_answer_before_the_model_is_called_again() -> None:
    """The card is the end of the answer: no further model call, which with a
    slow model kept the answer running while the card already waited."""
    script = ScriptedModel([("ask_user", CARD)], answer="I asked you above.")
    page = parse_context({"surface": "catalog"})
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    deps = RunDeps(
        message_id="m1", emit=emit, prompt_note=render_note(page, None, "en")
    )
    deps.env = tool_env(fake_clients(), page=page, emit_data=deps.emit_data)
    streamed: list[Any] = []

    async def on_event(event: Any) -> None:
        streamed.append(event)

    turn = await run_turn(
        build_agent(script.model), "which data?", deps=deps, on_event=on_event
    )
    assert len(script.infos) == 1
    assert turn.output is None
    last = turn.messages[-1]
    assert isinstance(last, ModelRequest)
    assert [(p.part_kind, p.tool_name) for p in last.parts] == [
        ("tool-return", "ask_user")
    ]
    assert any(isinstance(e, DataPart) and e.name == "ask" for e in events)
    assert any(isinstance(e, FunctionToolResultEvent) for e in streamed)


async def test_a_second_card_in_the_same_answer_is_refused() -> None:
    """One card per answer: of two cards in one response the first is shown
    and ends the answer; the second is refused with the note, shows nothing
    and names no card id, so the first card's answer still finds its card."""
    second = {"questions": [_question()]}

    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if any(isinstance(message, ModelResponse) for message in messages):
            yield "I asked you above."
            return
        yield {
            0: DeltaToolCall(
                name="ask_user", json_args=json.dumps(CARD), tool_call_id="call-a"
            ),
            1: DeltaToolCall(
                name="ask_user", json_args=json.dumps(second), tool_call_id="call-b"
            ),
        }

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise AssertionError("the run streams")

    page = parse_context({"surface": "catalog"})
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    deps = RunDeps(
        message_id="m1", emit=emit, prompt_note=render_note(page, None, "en")
    )
    deps.env = tool_env(fake_clients(), page=page, emit_data=deps.emit_data)

    async def on_event(event: Any) -> None:
        return None

    turn = await run_turn(
        build_agent(FunctionModel(respond, stream_function=stream)),
        "which data?",
        deps=deps,
        on_event=on_event,
    )
    assert turn.output is None
    [card] = [e for e in events if isinstance(e, DataPart) and e.name == "ask"]
    last = turn.messages[-1]
    assert isinstance(last, ModelRequest)
    shown, refused = last.parts
    assert isinstance(shown, ToolReturnPart) and isinstance(refused, ToolReturnPart)
    assert shown.tool_call_id == "call-a" and isinstance(shown.content, dict)
    assert shown.content["card_id"] == card.part_id
    assert refused.tool_call_id == "call-b" and refused.outcome == "failed"
    assert refused.content == ASK_USER.once_per_answer


async def test_a_run_without_a_card_ends_with_its_answer() -> None:
    script = ScriptedModel(answer="Here is the answer.")
    page = parse_context({"surface": "catalog"})

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(
        message_id="m1", emit=emit, prompt_note=render_note(page, None, "en")
    )
    deps.env = tool_env(fake_clients(), page=page, emit_data=deps.emit_data)

    async def on_event(event: Any) -> None:
        return None

    turn = await run_turn(
        build_agent(script.model), "which data?", deps=deps, on_event=on_event
    )
    assert turn.output == "Here is the answer."
    assert isinstance(turn.messages[-1], ModelResponse)


def test_chosen_cards_lists_the_cards_where_the_value_was_picked() -> None:
    from assistant.asks import AskHistory, CardAnswer, chosen_cards

    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Run it now?",
                    "header": "Run",
                    "options": [
                        {
                            "label": "Run",
                            "description": "Starts it.",
                            "value": "run:w1",
                        },
                        {
                            "label": "Not now",
                            "description": "Leaves it.",
                            "value": "no",
                        },
                    ],
                }
            ]
        }
    )
    picked = CardAnswer.model_validate(
        {"card_id": "ask-c1", "answers": [{"question": 0, "options": [0]}]}
    )
    declined = CardAnswer.model_validate(
        {"card_id": "ask-c2", "answers": [{"question": 0, "options": [1]}]}
    )
    history = AskHistory(
        cards={"ask-c1": card, "ask-c2": card},
        answers={"ask-c1": picked, "ask-c2": declined},
    )
    assert chosen_cards(history, "run:w1") == ["ask-c1"]
    assert chosen_cards(history, "run:w2") == []


def _answered(option: dict[str, Any]) -> AskHistory:
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Which data?",
                    "header": "Data",
                    "options": [option, {"label": "Leave it open", "value": "open"}],
                }
            ]
        }
    )
    answer = CardAnswer.model_validate(
        {"card_id": "ask-c1", "answers": [{"question": 0, "options": [0]}]}
    )
    return AskHistory(cards={"ask-c1": card}, answers={"ask-c1": answer})


def test_a_pick_names_the_ids_it_adds() -> None:
    history = _answered(
        {"label": "Population", "value": "zensus", "adds": ["de_zensus_2022_100m"]}
    )
    assert picked_ids(history) == {"zensus", "de_zensus_2022_100m"}


def test_an_option_left_unpicked_names_nothing() -> None:
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Which data?",
                    "header": "Data",
                    "options": [
                        {"label": "Population", "adds": ["de_zensus"]},
                        {"label": "Leave it open"},
                    ],
                }
            ]
        }
    )
    typed = CardAnswer.model_validate(
        {"card_id": "ask-c1", "answers": [{"question": 0, "other": "de_zensus"}]}
    )
    other = CardAnswer.model_validate(
        {"card_id": "ask-c2", "answers": [{"question": 0, "options": [1]}]}
    )
    history = AskHistory(
        cards={"ask-c1": card, "ask-c2": card},
        answers={"ask-c1": typed, "ask-c2": other},
    )
    assert picked_ids(history) == set()


def test_adds_never_stands_for_a_run() -> None:
    with pytest.raises(ValidationError):
        AskOption.model_validate(
            {"label": "Use it", "adds": ["run:00000000-0000-0000-0000-000000000001"]}
        )
    history = _answered(
        {"label": "Population", "value": "zensus", "adds": ["de_zensus"]}
    )
    # Run permissions and values read an option's value only.
    assert not user_chose(history, "de_zensus")


def test_adds_holds_ids_only() -> None:
    with pytest.raises(ValidationError):
        AskOption.model_validate({"label": "Use it", "adds": ["two words"]})
    with pytest.raises(ValidationError):
        AskOption.model_validate({"label": "Use it", "adds": ["x"] * 26})


@pytest.mark.parametrize("item", [".", ".."])
def test_adds_never_holds_a_dot_segment(item: str) -> None:
    """They fit the id pattern, but would climb out of a lookup's path."""
    with pytest.raises(ValidationError, match="is not a dataset id"):
        AskOption.model_validate({"label": "Use it", "adds": [item]})


CATALOG_ITEM = "de_zensus_2022_100m"
OWN_DATASET = "d1000000-0000-0000-0000-000000000001"


def _adding(*adds: str) -> dict[str, Any]:
    """A card whose first option adds ``adds``; the second option adds the
    first id again, which is looked up once."""
    return {
        "questions": [
            {
                "question": "Which population data should the workflow use?",
                "header": "Population",
                "options": [
                    {"label": "Census grid", "value": "census", "adds": list(adds)},
                    {"label": "Both grids", "value": "both", "adds": list(adds[:1])},
                ],
            }
        ]
    }


def _adds_env(
    catalog: Recorder, core: Recorder | None = None, login: Login | None = None
) -> tuple[Any, list[str]]:
    shown: list[str] = []

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        shown.append(name)
        return part_id or "m:1"

    env = tool_env(
        fake_clients(catalog=catalog, core=core or Recorder()),
        emit_data=emit,
        login=login,
    )
    return env, shown


def _not_found(request: httpx.Request) -> httpx.Response:
    return httpx.Response(404, json={"detail": "Catalog entry not found"})


async def test_a_card_adding_a_truncated_catalog_id_is_refused() -> None:
    catalog = Recorder(
        {("GET", f"/stac/resolve/{CATALOG_ITEM}"): {"kind": "item", "item": {}}}
    )
    catalog.routes[("GET", "/stac/resolve/de_zensus_2022")] = _not_found
    env, shown = _adds_env(catalog)
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, _adding("de_zensus_2022"), tool_call_id="c1")
    assert refused.value.message == (
        "adds names 'de_zensus_2022', which is no catalog dataset and no dataset "
        "you can read: take the id from catalog_search or core_find."
    )
    assert shown == []


#: A catalog dataset's id and one the model shortened from it.
POPULATION = "52ec5eb6-46f7-4d1c-aab3-28a063207aeb"
SHORTENED_ID = "52ec5eb6-46f7-aab3-28a063207aeb"


async def test_a_refused_id_comes_back_with_the_datasets_the_answer_found() -> None:
    """The model corrects the id in one call: the refusal names the catalog
    datasets the answer found by their exact ids, the closest ids first."""
    catalog = Recorder({("GET", f"/stac/resolve/{SHORTENED_ID}"): _not_found})
    env, shown = _adds_env(catalog)
    env.catalog_titles.update(
        {"stop_classes": "Public transport stop classes", POPULATION: "Population"}
    )
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, _adding(SHORTENED_ID), tool_call_id="c1")
    assert refused.value.message == (
        f"adds names '{SHORTENED_ID}', which is no catalog dataset and no dataset "
        "you can read: take the id from catalog_search or core_find. The catalog "
        "datasets this answer found, the closest ids first: "
        f'"Population" (id {POPULATION}), '
        '"Public transport stop classes" (id stop_classes).'
    )
    assert shown == []


async def test_the_datasets_a_refusal_names_are_capped() -> None:
    catalog = Recorder({("GET", f"/stac/resolve/{SHORTENED_ID}"): _not_found})
    env, _ = _adds_env(catalog)
    env.catalog_titles.update(
        {f"layer_{index}": f"Layer {index}" for index in range(MAX_NAMED_FOUND)}
    )
    # Found last, it is named first.
    env.catalog_titles[POPULATION] = "Population"
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, _adding(SHORTENED_ID), tool_call_id="c1")
    message = refused.value.message
    assert f'found, the closest ids first: "Population" (id {POPULATION}), ' in message
    assert message.count("(id ") == MAX_NAMED_FOUND
    assert message.endswith(" and 1 more.")


async def test_each_title_a_refusal_names_is_cut_short() -> None:
    """The refusal names up to ten datasets: a title of a sentence or more
    is cut with an ellipsis, so the refusal stays short; the id stays whole."""
    catalog = Recorder({("GET", f"/stac/resolve/{SHORTENED_ID}"): _not_found})
    env, _ = _adds_env(catalog)
    long_title = "Population per 100 m grid cell " * 6
    env.catalog_titles.update({POPULATION: long_title, "stops": "Stops"})
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, _adding(SHORTENED_ID), tool_call_id="c1")
    message = refused.value.message
    cut = long_title[: FOUND_TITLE_CHARS - 1].rstrip() + "…"
    assert FOUND_TITLE_CHARS == 80 and len(cut) <= FOUND_TITLE_CHARS
    assert f'"{cut}" (id {POPULATION}), "Stops" (id stops).' in message
    assert long_title.strip() not in message


async def test_a_card_adding_known_datasets_is_shown_after_one_lookup_each() -> None:
    """A catalog item and a dataset of the user's own pass; each id is looked
    up once, however many options add it."""
    catalog = Recorder(
        {
            ("GET", f"/stac/resolve/{CATALOG_ITEM}"): {"kind": "item", "item": {}},
            ("GET", f"/stac/resolve/{OWN_DATASET}"): _not_found,
        }
    )
    core = Recorder(
        {("GET", f"/api/v2/layer/{OWN_DATASET}"): {"id": OWN_DATASET, "name": "x"}}
    )
    env, shown = _adds_env(catalog, core)
    result = await execute(
        ASK_USER, env, _adding(CATALOG_ITEM, OWN_DATASET), tool_call_id="c1"
    )
    assert result["status"] == "asked" and shown == ["ask"]
    assert sorted(catalog.paths()) == sorted(
        [f"/stac/resolve/{CATALOG_ITEM}", f"/stac/resolve/{OWN_DATASET}"]
    )
    assert core.paths() == [f"/api/v2/layer/{OWN_DATASET}"]


async def test_a_card_adding_a_dataset_the_user_cannot_read_is_refused() -> None:
    catalog = Recorder({("GET", f"/stac/resolve/{OWN_DATASET}"): _not_found})
    core = Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_DATASET}"): httpx.Response(
                403, json={"detail": "no access"}
            ),
            ("GET", f"/api/v2/bundle/{OWN_DATASET}/layers"): httpx.Response(
                404, json={"detail": "Bundle not found"}
            ),
        }
    )
    env, shown = _adds_env(catalog, core)
    with pytest.raises(InputInvalid, match=f"adds names '{OWN_DATASET}'"):
        await execute(ASK_USER, env, _adding(OWN_DATASET), tool_call_id="c1")
    assert shown == []


async def test_a_catalog_that_fails_lets_the_card_through() -> None:
    """The add tools check the ids again: a lookup the service failed for
    leaves the card to them."""
    catalog = Recorder(
        {
            ("GET", "/stac/resolve/de_zensus_2022"): httpx.Response(
                500, json={"detail": "boom"}
            )
        }
    )
    env, shown = _adds_env(catalog)
    result = await execute(ASK_USER, env, _adding("de_zensus_2022"), tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]


OWN_BUNDLE = "b0000000-0000-0000-0000-0000000000b1"


def _bundle_core(answer: Any) -> Recorder:
    """Core without a layer under OWN_BUNDLE (bundles have their own table),
    and ``answer`` for the bundle's layers."""
    return Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_BUNDLE}"): httpx.Response(
                404, json={"detail": "Layer not found"}
            ),
            ("GET", f"/api/v2/bundle/{OWN_BUNDLE}/layers"): answer,
        }
    )


async def test_a_card_adding_a_bundle_of_the_users_is_shown() -> None:
    catalog = Recorder({("GET", f"/stac/resolve/{OWN_BUNDLE}"): _not_found})
    core = _bundle_core([{"layer_id": OWN_DATASET, "role": "stops"}])
    env, shown = _adds_env(catalog, core)
    result = await execute(ASK_USER, env, _adding(OWN_BUNDLE), tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]
    assert core.paths() == [
        f"/api/v2/layer/{OWN_BUNDLE}",
        f"/api/v2/bundle/{OWN_BUNDLE}/layers",
    ]


async def test_a_card_adding_a_bundle_the_user_cannot_read_is_refused() -> None:
    catalog = Recorder({("GET", f"/stac/resolve/{OWN_BUNDLE}"): _not_found})
    core = _bundle_core(httpx.Response(403, json={"detail": "no access"}))
    env, shown = _adds_env(catalog, core)
    with pytest.raises(InputInvalid, match=f"adds names '{OWN_BUNDLE}'"):
        await execute(ASK_USER, env, _adding(OWN_BUNDLE), tool_call_id="c1")
    assert shown == []


async def test_a_core_that_fails_lets_the_card_through() -> None:
    catalog = Recorder({("GET", f"/stac/resolve/{OWN_DATASET}"): _not_found})
    core = Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_DATASET}"): httpx.Response(
                503, json={"detail": "busy"}
            )
        }
    )
    env, shown = _adds_env(catalog, core)
    result = await execute(ASK_USER, env, _adding(OWN_DATASET), tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]
    assert core.paths() == [f"/api/v2/layer/{OWN_DATASET}"]


async def test_an_expired_sign_in_lets_the_card_through() -> None:
    """Core refuses the sign-in, not the dataset: the add tools will say so."""
    catalog = Recorder({("GET", f"/stac/resolve/{OWN_DATASET}"): _not_found})
    core = Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_DATASET}"): httpx.Response(
                401, json={"detail": "Unauthorized"}
            )
        }
    )
    env, shown = _adds_env(catalog, core, login=signed_in(-60))
    result = await execute(ASK_USER, env, _adding(OWN_DATASET), tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]
    assert core.paths() == [f"/api/v2/layer/{OWN_DATASET}"]


async def test_a_card_adding_more_than_50_datasets_is_refused_unchecked() -> None:
    options = [
        {"label": f"Bundle {name}", "adds": [f"{name}-{n}" for n in range(25)]}
        for name in ("one", "two", "three")
    ]
    card = {"questions": [_question(options=options)]}
    catalog = Recorder()
    env, shown = _adds_env(catalog)
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, card, tool_call_id="c1")
    assert refused.value.message == (
        "The card's options add 75 different datasets; a card adds at most 50: "
        "put fewer ids in it."
    )
    assert catalog.requests == [] and shown == []


# -- the datasets each option adds, by title ---------------------------------------

CENSUS_TITLE = "Zensus 2022 - Bevölkerung"
STOPS_EXPORT = "Priorität C - Bushaltestellen"


async def test_the_shown_card_names_the_datasets_each_option_adds() -> None:
    """Pass 7 (Q36): an option for the census grid added the user's own stop
    export, since only the id's existence was checked. The card's result
    names each option's datasets by title, from the lookups that check them,
    so a wrong id shows before the user picks."""
    catalog = Recorder(
        {
            ("GET", f"/stac/resolve/{CATALOG_ITEM}"): {
                "kind": "collection",
                "collection": {"id": CATALOG_ITEM, "title": CENSUS_TITLE},
                "items": [],
            },
            ("GET", f"/stac/resolve/{OWN_DATASET}"): _not_found,
        }
    )
    core = Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_DATASET}"): {
                "id": OWN_DATASET,
                "name": STOPS_EXPORT,
            }
        }
    )
    env, shown = _adds_env(catalog, core)
    result = await execute(
        ASK_USER, env, _adding(CATALOG_ITEM, OWN_DATASET), tool_call_id="c1"
    )
    assert result["adds"] == [
        {"option": "Census grid", "datasets": [CENSUS_TITLE, STOPS_EXPORT]},
        {"option": "Both grids", "datasets": [CENSUS_TITLE]},
    ]
    assert result["note"] == f"{ASKED_NOTE} {ADDS_NAMED}"
    assert shown == ["ask"]
    # Still one lookup per id and service.
    assert sorted(catalog.paths()) == sorted(
        [f"/stac/resolve/{CATALOG_ITEM}", f"/stac/resolve/{OWN_DATASET}"]
    )
    assert core.paths() == [f"/api/v2/layer/{OWN_DATASET}"]


async def test_a_dataset_whose_title_cannot_be_read_is_named_so() -> None:
    catalog = Recorder(
        {("GET", f"/stac/resolve/{CATALOG_ITEM}"): {"kind": "item", "item": {}}}
    )
    env, _ = _adds_env(catalog)
    result = await execute(ASK_USER, env, _adding(CATALOG_ITEM), tool_call_id="c1")
    assert result["adds"] == [
        {"option": "Census grid", "datasets": [UNKNOWN_TITLE]},
        {"option": "Both grids", "datasets": [UNKNOWN_TITLE]},
    ]


async def test_a_card_that_adds_nothing_names_no_datasets() -> None:
    env, _ = _adds_env(Recorder())
    result = await execute(ASK_USER, env, CARD, tool_call_id="c1")
    assert "adds" not in result
    assert result["note"] == ASKED_NOTE


# -- an option that names a dataset the answer found, without adding it -----------

#: Catalog datasets an answer found (``ToolEnv.catalog_titles``), titles as
#: the catalog has them.
FOUND = {
    CATALOG_ITEM: CENSUS_TITLE,
    "de_zensus_2022_alter": "Zensus 2022 - Durchschnittsalter der Bevölkerung",
    "hh_einzugsbereiche": "Einzugsbereiche von HVV-Haltestellen Hamburg",
    "hh_verwaltungsgrenzen": "ALKIS - Verwaltungsgrenzen Hamburg – Bezirke",
    "hh_bildungsatlas": (
        "Regionaler Bildungsatlas - Kennzahlen zur Bevölkerung der "
        "Statistischen Gebiete Hamburgs"
    ),
    "ch_oev_gueteklassen": "öV-Güteklasse – Solothurn",
}


def _option_card(option: dict[str, Any]) -> dict[str, Any]:
    return {
        "questions": [
            {
                "question": "Which data should the workflow use?",
                "header": "Data",
                "options": [
                    option,
                    {"label": "Leave it open", "description": "Choose it later"},
                ],
            }
        ]
    }


def _found_env() -> tuple[Any, list[str], Recorder]:
    catalog = Recorder(
        {("GET", f"/stac/resolve/{CATALOG_ITEM}"): {"kind": "item", "item": {}}}
    )
    env, shown = _adds_env(catalog)
    env.catalog_titles.update(FOUND)
    return env, shown, catalog


@pytest.mark.parametrize(
    ("label", "named"),
    [
        # The title, or a part of it with its own name.
        ("Zensus 2022 – Bevölkerung", CENSUS_TITLE),
        ("Zensus-2022-Gitterzellen", CENSUS_TITLE),
        ("Verwaltungsgrenzen Hamburg", FOUND["hh_verwaltungsgrenzen"]),
        # Three or more words of one title.
        ("HVV-Haltestellen-Einzugsbereiche", FOUND["hh_einzugsbereiche"]),
        ("Bildungsatlas statistische Gebiete", FOUND["hh_bildungsatlas"]),
    ],
)
async def test_an_option_naming_a_dataset_the_answer_found_must_add_it(
    label: str, named: str
) -> None:
    """Pass 6 and 7: an option named a catalog dataset without its id in
    adds, so the user's pick did not let the next answer add it, and a
    second card only asked to add it."""
    env, shown, catalog = _found_env()
    with pytest.raises(InputInvalid) as refused:
        await execute(
            ASK_USER,
            env,
            _option_card({"label": label, "value": "data"}),
            tool_call_id="c1",
        )
    assert f'The option "{label}" names' in refused.value.message
    assert named in refused.value.message
    assert shown == [] and catalog.requests == []


def test_the_refusal_names_the_dataset_its_id_and_what_to_do() -> None:
    card = AskUserInput.model_validate(
        _option_card({"label": "HVV-Haltestellen-Einzugsbereiche", "value": "hvv"})
    )
    assert unadded_dataset(card, FOUND) == (
        'The option "HVV-Haltestellen-Einzugsbereiche" names the catalog dataset '
        '"Einzugsbereiche von HVV-Haltestellen Hamburg" (id hh_einzugsbereiche), '
        "but adds nothing, so picking it would not let you add the dataset. Put "
        "the id of the dataset it uses in its adds; for a layer already in the "
        "project, its layer_project_id is the value instead."
    )
    several = AskUserInput.model_validate(
        _option_card({"label": "Zensus 2022", "value": "zensus"})
    )
    message = unadded_dataset(several, FOUND)
    assert message is not None
    assert message.startswith(
        'The option "Zensus 2022" names the catalog datasets "Zensus 2022 - '
        'Bevölkerung" (id de_zensus_2022_100m), "Zensus 2022 - '
        'Durchschnittsalter der Bevölkerung" (id de_zensus_2022_alter), but'
    )


@pytest.mark.parametrize(
    "option",
    [
        # It adds the dataset, or its value stands for it or for a layer of
        # the project.
        {"label": "Zensus 2022", "value": "zensus", "adds": [CATALOG_ITEM]},
        {"label": "Zensus 2022", "value": CATALOG_ITEM},
        {"label": "Zensus 2022", "value": "42"},
        {"label": "Zensus 2022", "value": OWN_DATASET},
        # It leaves the dataset out.
        {"label": "Ohne Zensus 2022", "value": "none"},
        {"label": "Zensus 2022 später", "value": "later"},
        # Ordinary choices, also with words of a title found.
        {"label": "Bezirke", "value": "bezirke"},
        {"label": "Stadtteile Hamburgs", "value": "stadtteile"},
        {"label": "ÖV-Güteklassen", "value": "guete"},
        {"label": "HVV-Einzugsbereiche", "value": "hvv"},
        {"label": "Werktag 7–9 Uhr", "value": "am"},
        {"label": "Nur Linienverkehr rechnen", "value": "pt_only"},
        {"label": "Bevölkerung je Bezirk", "value": "districts"},
    ],
)
async def test_options_that_add_or_do_not_name_a_found_dataset_are_shown(
    option: dict[str, Any],
) -> None:
    env, shown, _ = _found_env()
    result = await execute(ASK_USER, env, _option_card(option), tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]


async def test_a_dataset_the_answer_did_not_find_is_not_matched() -> None:
    env, shown = _adds_env(Recorder())
    card = _option_card({"label": "Zensus 2022 – Bevölkerung", "value": "zensus"})
    result = await execute(ASK_USER, env, card, tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]


def test_a_list_of_short_words_names_no_dataset() -> None:
    """Three words of a title name it only with one of more than five
    letters: a list of short ones is a choice of its own (modes of
    transport), not the dataset's name."""
    found = {"hh_hvv_angebot": "HVV: Bus, Bahn, Fähre"}
    modes = AskUserInput.model_validate(
        _option_card({"label": "Bus, Bahn, Fähre", "value": "modes"})
    )
    assert unadded_dataset(modes, found) is None
    named = AskUserInput.model_validate(
        _option_card({"label": "Bildungsatlas statistische Gebiete", "value": "b"})
    )
    assert unadded_dataset(named, FOUND) is not None


def test_a_question_that_offers_a_run_names_no_dataset() -> None:
    """A run option says what the run uses; the run's pick adds nothing,
    and its datasets are in the project already."""
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Should the workflow run now?",
                    "header": "Run",
                    "options": [
                        {
                            "label": "Ja, mit Zensus 2022 ausführen",
                            "value": f"run:{RUN_WORKFLOW}",
                        },
                        {"label": "Nein, Zensus 2022 später", "value": "no"},
                    ],
                }
            ]
        }
    )
    assert unadded_dataset(card, FOUND) is None


def test_the_pick_that_started_the_answer_names_what_it_adds() -> None:
    """The answer to a card that came with the message being answered:
    what its picked options add, and nothing for an answer read back from
    the stored conversation."""
    card = AskUserInput.model_validate(_adding(CATALOG_ITEM, OWN_DATASET))
    earlier = AskUserInput.model_validate(_adding("hh_bezirke"))
    answer = CardAnswer.model_validate(
        {"card_id": "ask-a2", "answers": [{"question": 0, "options": [0]}]}
    )
    earlier_answer = CardAnswer.model_validate(
        {"card_id": "ask-a1", "answers": [{"question": 0, "options": [0]}]}
    )
    history = AskHistory(
        cards={"ask-a1": earlier, "ask-a2": card},
        answers={"ask-a1": earlier_answer},
    ).with_answer(answer)
    assert history.answering == "ask-a2"
    assert answered_adds(history) == [CATALOG_ITEM, OWN_DATASET]
    # Both picks count for the add tools' own check.
    assert "hh_bezirke" in picked_ids(history)
    stored = AskHistory(cards=history.cards, answers=history.answers)
    assert stored.answering is None and answered_adds(stored) == []
    # The second option adds the first id only.
    second = CardAnswer.model_validate(
        {"card_id": "ask-a2", "answers": [{"question": 0, "options": [1]}]}
    )
    picked_second = AskHistory(cards={"ask-a2": card}).with_answer(second)
    assert answered_adds(picked_second) == [CATALOG_ITEM]


# -- a card that offers again what the user picked --------------------------------

DISTRICTS_QUESTION = "Which district boundaries should the analysis use?"
OFFICIAL = "d2000000-0000-0000-0000-000000000001"
STATISTICAL = "d2000000-0000-0000-0000-000000000002"
DISTRICTS_CARD = AskUserInput.model_validate(
    {
        "questions": [
            {
                "question": DISTRICTS_QUESTION,
                "header": "Districts",
                "options": [
                    {"label": "Official districts", "value": "a", "adds": [OFFICIAL]},
                    {"label": "Statistical areas", "value": "s", "adds": [STATISTICAL]},
                ],
            },
            {
                "question": "Which time window?",
                "header": "Time",
                "options": [{"label": "Morning peak"}, {"label": "Afternoon peak"}],
            },
        ]
    }
)
RUN_QUESTION = "Should I run the workflow now?"
#: A card asking to run workflow wf-a, and when.
RUN_CARD = AskUserInput.model_validate(
    {
        "questions": [
            {
                "question": RUN_QUESTION,
                "header": "Run",
                "options": [
                    {"label": "Run now", "value": "run:wf-a"},
                    {"label": "Later", "value": "later"},
                ],
            },
            {
                "question": "Which day?",
                "header": "Day",
                "options": [{"label": "Weekday"}, {"label": "Sunday"}],
            },
        ]
    }
)
PICK_REFUSED = (
    'The user already answered "{question}" (Districts): they chose "Official '
    'districts" (value a). Use that answer. If it did not work or left something '
    "open, say so in your text and ask only what is still open, under a new header "
    "that names it."
)


def _districts_answered(
    options: list[int], other: str | None = None, *, time: list[int] | None = None
) -> AskHistory:
    """The districts card, answered: ``options`` and ``other`` for the
    districts, ``time`` for the time window (left unanswered without)."""
    answers: list[dict[str, Any]] = [
        {"question": 0, "options": options, "other": other},
        {"question": 1, "options": time or []},
    ]
    answer = CardAnswer.model_validate({"card_id": "ask-d1", "answers": answers})
    return AskHistory(cards={"ask-d1": DISTRICTS_CARD}, answers={"ask-d1": answer})


#: The run card answered: run now, on a weekday.
RUN_ANSWERED = AskHistory(
    cards={"ask-r1": RUN_CARD},
    answers={
        "ask-r1": CardAnswer.model_validate(
            {
                "card_id": "ask-r1",
                "answers": [
                    {"question": 0, "options": [0]},
                    {"question": 1, "options": [0]},
                ],
            }
        )
    },
)


def _asking(
    question: str, *options: dict[str, Any], header: str = "Areas"
) -> dict[str, Any]:
    return {
        "questions": [
            {
                "question": question,
                "header": header,
                "options": list(options)
                or [{"label": "Whole city"}, {"label": "Inner city"}],
            }
        ]
    }


def _picks_env(history: AskHistory, used: Sequence[str] = ()) -> tuple[Any, list[str]]:
    """A tool environment with the conversation's cards and answers in
    ``history``, the cards whose run pick was used in ``used``, and a
    catalog that knows both district datasets."""
    catalog = Recorder(
        {
            ("GET", f"/stac/resolve/{OFFICIAL}"): {"kind": "item", "item": {}},
            ("GET", f"/stac/resolve/{STATISTICAL}"): {"kind": "item", "item": {}},
        }
    )
    env, shown = _adds_env(catalog)
    env.asks = history
    env.runs.used_cards.update(used)
    return env, shown


async def _refusal(
    history: AskHistory, card: dict[str, Any], used: Sequence[str] = ()
) -> str:
    env, shown = _picks_env(history, used)
    with pytest.raises(InputInvalid) as refused:
        await execute(ASK_USER, env, card, tool_call_id="c1")
    assert shown == []
    return refused.value.message


async def _shown(
    history: AskHistory, card: dict[str, Any], used: Sequence[str] = ()
) -> None:
    env, shown = _picks_env(history, used)
    result = await execute(ASK_USER, env, card, tool_call_id="c1")
    assert result["status"] == "asked" and shown == ["ask"]


async def test_a_card_offering_the_earlier_pick_again_is_refused_with_the_pick() -> (
    None
):
    """A card reworded an answered question under the same header and offered
    the user's pick again, with its value but without the datasets it adds:
    it is refused, naming the pick, and the model may say why it did not
    work."""
    again = _asking(
        "Which districts should the results be grouped by?",
        {"label": "Official districts", "value": "a"},
        {"label": "Postcode areas", "value": "postcodes"},
        header="Districts",
    )
    assert await _refusal(_districts_answered([0]), again) == PICK_REFUSED.format(
        question=DISTRICTS_QUESTION
    )


@pytest.mark.parametrize(
    "card",
    [
        # The same label, under the same header.
        _asking(
            "Which areas?",
            {"label": " official   DISTRICTS "},
            {"label": "Postcode areas"},
            header="districts",
        ),
        # The same value.
        _asking(
            "Which areas?",
            {"label": "Boundaries from the register", "value": "a"},
            {"label": "Postcode areas"},
            header="Districts",
        ),
        # The same datasets, under the same question.
        _asking(
            DISTRICTS_QUESTION,
            {"label": "Boundaries from the register", "adds": [OFFICIAL]},
            {"label": "Postcode areas"},
        ),
    ],
)
async def test_the_pick_is_found_by_label_value_or_datasets(
    card: dict[str, Any],
) -> None:
    assert await _refusal(_districts_answered([0]), card) == PICK_REFUSED.format(
        question=DISTRICTS_QUESTION
    )


@pytest.mark.parametrize(
    "card",
    [
        # The same question with new options only.
        _asking(
            DISTRICTS_QUESTION,
            {"label": "Grid cells"},
            {"label": "Postcode areas"},
            header="Districts",
        ),
        # The pick did not work, and the card leaves it out.
        _asking(
            "The official districts hold no data here. Which areas instead?",
            {"label": "Statistical areas", "value": "s", "adds": [STATISTICAL]},
            {"label": "Postcode areas"},
            header="Districts",
        ),
        # Another question under the header, in other case and spacing.
        _asking(
            "Which areas should the map compare?",
            {"label": "Grid cells"},
            {"label": "Postcode areas"},
            header="  DISTRICTS ",
        ),
    ],
)
async def test_a_card_under_an_answered_header_is_refused_whatever_it_offers(
    card: dict[str, Any],
) -> None:
    """A header names the topic the user answered: asked again, with the
    same or other options, the same topic took the user a second turn. The
    refusal names the earlier answer; what it left open goes under a header
    that names that."""
    assert await _refusal(_districts_answered([0]), card) == PICK_REFUSED.format(
        question=DISTRICTS_QUESTION
    )


async def test_a_header_answered_in_text_is_refused_with_the_text() -> None:
    card = _asking(
        DISTRICTS_QUESTION,
        {"label": "Official districts"},
        {"label": "Postcode areas"},
        header="Districts",
    )
    history = _districts_answered([], "Only the seven   boroughs")
    assert await _refusal(history, card) == (
        f'The user already answered "{DISTRICTS_QUESTION}" (Districts): they '
        'wrote "Only the seven boroughs". Use that answer. If it did not work or '
        "left something open, say so in your text and ask only what is still "
        "open, under a new header that names it."
    )
    both = _districts_answered([1], "the newer ones")
    assert 'they chose "Statistical areas" (value s) and wrote "the newer ones".' in (
        await _refusal(both, card)
    )


async def test_a_header_answered_in_any_earlier_turn_is_refused() -> None:
    """The header of a card answered turns before the newest one counts as
    well, and of two answers under one header the newer is named."""
    data = AskUserInput.model_validate(
        _asking(
            "Which data should the analysis use?",
            {"label": "Census grid", "value": "zensus"},
            {"label": "District table", "value": "table"},
            header="Data",
        )
    )
    redone = AskUserInput.model_validate(
        _asking(
            "Which boundaries now?",
            {"label": "Statistical areas", "value": "s"},
            {"label": "Postcode areas"},
            header="districts",
        )
    )
    answers = {
        card_id: CardAnswer.model_validate(
            {"card_id": card_id, "answers": [{"question": 0, "options": [0]}]}
        )
        for card_id in ("ask-d1", "ask-x2", "ask-d3")
    }
    older = AskHistory(
        cards={"ask-d1": DISTRICTS_CARD, "ask-x2": data},
        answers={key: answers[key] for key in ("ask-d1", "ask-x2")},
    )
    card = _asking(
        "Which areas?",
        {"label": "Grid cells"},
        {"label": "Postcode areas"},
        header="Districts",
    )
    assert await _refusal(older, card) == PICK_REFUSED.format(
        question=DISTRICTS_QUESTION
    )
    newer = AskHistory(
        cards={**older.cards, "ask-d3": redone},
        answers={**older.answers, "ask-d3": answers["ask-d3"]},
    )
    assert (
        'already answered "Which boundaries now?" (districts): they chose '
        '"Statistical areas" (value s).'
    ) in await _refusal(newer, card)


STOPS_TIME = _asking(
    "Which time window should the stop analysis use?",
    {"label": "Werktag 7-9 Uhr", "value": "am"},
    {"label": "Werktag 16-18 Uhr", "value": "pm"},
    header="Zeitraum",
)
CYCLING_DAY = _asking(
    "Which day should the cycling comparison use?",
    {"label": "Sonntag", "value": "sun"},
    {"label": "Samstag", "value": "sat"},
    header="Zeitraum",
)
STOPS_PICK = CardAnswer.model_validate(
    {"card_id": "ask-z1", "answers": [{"question": 0, "options": [0]}]}
)


def _typed(text: str) -> dict[str, Any]:
    """A message the user typed, as ``Repository.list_messages`` stores it."""
    return {"role": "user", "parts": [{"type": "user_text", "text": text}]}


def _asked(card_id: str, card: dict[str, Any]) -> dict[str, Any]:
    """An answer that showed ``card``, as stored."""
    return {
        "role": "assistant",
        "parts": [
            {
                "type": "tool",
                "tool_name": "ask_user",
                "state": "output",
                "args": card,
                "output": {"card_id": card_id, "status": "asked"},
            }
        ],
    }


def _picked_in(answer: CardAnswer) -> dict[str, Any]:
    """A message that answers a card, as stored."""
    return {
        "role": "user",
        "parts": [
            {"type": "user_text", "text": "Werktag 7-9 Uhr"},
            {"type": "answer", "answer": answer.model_dump(mode="json")},
        ],
    }


async def test_a_header_answered_before_the_users_last_typed_message_may_be_asked() -> (
    None
):
    """A header names a topic within the chain of picks that answers one
    request: once the user typed a new message, a later question may use a
    common header ("Zeitraum") for another analysis."""
    stored = [
        _typed("Wie gut sind die Haltestellen erschlossen?"),
        _asked("ask-z1", STOPS_TIME),
        _picked_in(STOPS_PICK),
        _asked("ask-x2", _asking("Which areas?")),
    ]
    history = AskHistory.from_stored(stored).with_typed_message()
    await _shown(history, CYCLING_DAY)
    # Asked again in a later chain, a question with the pick offered again
    # is still refused, wherever the user answered it.
    refused = await _refusal(history, STOPS_TIME)
    assert refused.startswith(
        f'The user already answered "{STOPS_TIME["questions"][0]["question"]}"'
    )


async def test_within_the_chain_of_picks_a_header_is_not_asked_again() -> None:
    """The cards answered since the user's last typed message, the answer
    that came with this message among them: their headers are taken."""
    stored = [
        _typed("Wie gut sind die Haltestellen erschlossen?"),
        _asked("ask-z1", STOPS_TIME),
    ]
    history = AskHistory.from_stored(stored).with_answer(STOPS_PICK)
    assert (await _refusal(history, CYCLING_DAY)).startswith(
        'The user already answered "Which time window should the stop analysis use?"'
    )
    later = AskHistory.from_stored(
        [
            *stored,
            _picked_in(STOPS_PICK),
            _asked("ask-x2", _asking("Which areas?")),
        ]
    ).with_answer(
        CardAnswer.model_validate(
            {"card_id": "ask-x2", "answers": [{"question": 0, "options": [0]}]}
        )
    )
    assert (await _refusal(later, CYCLING_DAY)).startswith(
        'The user already answered "Which time window should the stop analysis use?"'
    )


@pytest.mark.parametrize(
    ("history", "card"),
    [
        # A new question with new options.
        (_districts_answered([0], time=[0]), _asking("Which part of the city?")),
        # The pick offered again under another header and question.
        (
            _districts_answered([0]),
            _asking(
                "Which layer should the map show?",
                {"label": "Official districts"},
                {"label": "Postcode areas"},
                header="Map",
            ),
        ),
        # Shown, but the user wrote a message instead of answering it.
        (
            AskHistory(cards={"ask-d1": DISTRICTS_CARD}),
            _asking(
                DISTRICTS_QUESTION,
                {"label": "Official districts"},
                {"label": "Postcode areas"},
                header="Districts",
            ),
        ),
        # A question that offers a run, under a header the user answered:
        # each run needs a pick of its own.
        (
            _districts_answered([0]),
            _asking(
                RUN_QUESTION,
                {"label": "Run now", "value": "run:wf-a"},
                {"label": "Later", "value": "later"},
                header="Districts",
            ),
        ),
        # A question of the answered card the user left without a pick.
        (
            _districts_answered([0]),
            _asking(
                "Which time window?",
                {"label": "Morning peak"},
                {"label": "Evening"},
                header="Time",
            ),
        ),
    ],
)
async def test_a_card_that_offers_no_earlier_pick_again_is_shown(
    history: AskHistory, card: dict[str, Any]
) -> None:
    await _shown(history, card)


async def test_a_permission_card_for_another_workflow_is_shown() -> None:
    """A run pick stands for one workflow: the same card for another one
    asks for something new."""
    card = _asking(
        RUN_QUESTION,
        {"label": "Run now", "value": "run:wf-b"},
        {"label": "Later", "value": "later"},
        header="Run",
    )
    await _shown(RUN_ANSWERED, card)


async def test_a_card_to_run_the_same_workflow_again_is_shown() -> None:
    """A run pick allows one run: once used, the workflow runs again only
    after a new pick."""
    card = _asking(
        RUN_QUESTION,
        {"label": "Run now", "value": "run:wf-a"},
        {"label": "Later", "value": "later"},
        header="Run",
    )
    await _shown(RUN_ANSWERED, card, used=["ask-r1"])


#: The run card answered: not now, on a weekday.
RUN_DECLINED = AskHistory(
    cards={"ask-r1": RUN_CARD},
    answers={
        "ask-r1": CardAnswer.model_validate(
            {
                "card_id": "ask-r1",
                "answers": [
                    {"question": 0, "options": [1]},
                    {"question": 1, "options": [0]},
                ],
            }
        )
    },
)


@pytest.mark.parametrize("workflow", ["wf-b", "wf-a"])
async def test_a_run_card_after_a_declined_one_is_shown(workflow: str) -> None:
    """Declining a run is the other half of the run decision: the user
    may want another workflow run, or the same one after all, and a Run card
    offers "Later" again."""
    card = _asking(
        RUN_QUESTION,
        {"label": "Run now", "value": f"run:{workflow}"},
        {"label": "Later", "value": "later"},
        header="Run",
    )
    await _shown(RUN_DECLINED, card)


async def test_the_picks_of_a_card_whose_run_pick_was_used_count_no_more() -> None:
    card = _asking(
        "Which day?", {"label": "Weekday"}, {"label": "Saturday"}, header="Day"
    )
    assert await _refusal(RUN_ANSWERED, card) == (
        'The user already answered "Which day?" (Day): they chose "Weekday". Use '
        "that answer. If it did not work or left something open, say so in your "
        "text and ask only what is still open, under a new header that names it."
    )
    await _shown(RUN_ANSWERED, card, used=["ask-r1"])


STOPS_QUESTION = "Which stops should the workflow use?"


def _stops_left_open(open_option: dict[str, Any]) -> AskHistory:
    """A dataset card, answered with ``open_option``: the user left the
    step open."""
    card = AskUserInput.model_validate(
        _asking(
            STOPS_QUESTION,
            {"label": "Timetable stops", "adds": [OFFICIAL]},
            open_option,
            header="Stops",
        )
    )
    answer = CardAnswer.model_validate(
        {"card_id": "ask-s1", "answers": [{"question": 0, "options": [1]}]}
    )
    return AskHistory(cards={"ask-s1": card}, answers={"ask-s1": answer})


async def test_a_dataset_card_after_leave_it_open_is_shown() -> None:
    """A dataset card offers "Leave it open" beside the datasets it adds.
    That pick adds nothing, so a later dataset card under the same header
    may offer it again."""
    card = _asking(
        STOPS_QUESTION,
        {"label": "Mapped stops", "adds": [STATISTICAL]},
        {"label": "Leave it open"},
        header="Stops",
    )
    await _shown(_stops_left_open({"label": "Leave it open"}), card)


async def test_an_open_pick_with_a_value_still_counts() -> None:
    card = _asking(
        STOPS_QUESTION,
        {"label": "Mapped stops", "adds": [STATISTICAL]},
        {"label": "Leave it open", "value": "open"},
        header="Stops",
    )
    history = _stops_left_open({"label": "Leave it open", "value": "open"})
    assert await _refusal(history, card) == (
        f'The user already answered "{STOPS_QUESTION}" (Stops): they chose "Leave '
        'it open" (value open). Use that answer. If it did not work or left '
        "something open, say so in your text and ask only what is still open, "
        "under a new header that names it."
    )


def test_card_data_and_public_args_hide_adds() -> None:
    args = {
        "questions": [
            {
                "question": "Which data?",
                "header": "Data",
                "options": [
                    {"label": "Population", "adds": ["x1"]},
                    {"label": "Other data", "value": "o"},
                ],
            }
        ]
    }
    card = AskUserInput.model_validate(args)
    assert "adds" not in json.dumps(card_data("ask-c1", card))
    public = public_args("ask_user", args)
    assert "adds" not in json.dumps(public) and "x1" not in json.dumps(public)


def test_recent_picks_come_newest_first() -> None:
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Which data?",
                    "header": "Data",
                    "options": [
                        {"label": "Population", "value": "zensus", "adds": ["z1"]},
                        {"label": "Schools", "value": "schools"},
                    ],
                }
            ]
        }
    )
    first = CardAnswer.model_validate(
        {"card_id": "ask-c1", "answers": [{"question": 0, "options": [1]}]}
    )
    second = CardAnswer.model_validate(
        {"card_id": "ask-c2", "answers": [{"question": 0, "options": [0]}]}
    )
    again = CardAnswer.model_validate(
        {"card_id": "ask-c3", "answers": [{"question": 0, "options": [1]}]}
    )
    history = AskHistory(
        cards={"ask-c1": card, "ask-c2": card, "ask-c3": card},
        answers={"ask-c1": first, "ask-c2": second, "ask-c3": again},
    )
    assert recent_picked_ids(history) == ["schools", "zensus", "z1"]
    assert picked_ids(history) == {"schools", "zensus", "z1"}


# -- a card while a finished run is not yet reported ------------------------------

RUN_PROJECT = "00000000-0000-0000-0000-0000000005e4"
RUN_WORKFLOW = "0b6f0000-0000-0000-0000-00000000f10f"
FINISHED_RUN = {
    "jobID": "j1",
    "processID": "workflow_runner",
    "status": "successful",
    "inputs": {"workflow_id": RUN_WORKFLOW},
    "created": "2026-10-23T08:41:30Z",
    "result": {
        "status": "success",
        "node_results": {"tool-walk": {"status": "success", "feature_count": 3}},
    },
}
#: One response of the scripted model: text and tool calls, in this order.
Response = list[str | tuple[str, dict[str, Any]]]


@dataclass
class Answered:
    turn: Turn
    #: The cards shown, as their data-ask parts.
    shown: list[DataPart]
    deps: RunDeps
    #: What each model call was offered, in order.
    infos: list[AgentInfo]
    #: The note on the run's stage each model call ended with, in order; None
    #: in a look-up step (``stage_note``).
    notes: list[str | None]


async def _answer(*responses: Response) -> tuple[Turn, list[DataPart]]:
    answered = await _answer_run(*responses)
    return answered.turn, answered.shown


#: A model call's usage as the provider reports it: input tokens, the input
#: read from the cache, output tokens.
Usage = tuple[int, int, int]


class _Metered(FunctionModel):
    """A streamed model whose ``n``-th call reports ``usages[n]`` (the
    estimate of the function model after the last)."""

    def __init__(self, stream: Any, usages: Sequence[Usage]) -> None:
        super().__init__(stream_function=stream)
        self.usages = usages
        self.calls = 0

    @asynccontextmanager
    async def request_stream(
        self, *args: Any, **kwargs: Any
    ) -> AsyncIterator[StreamedResponse]:
        n, self.calls = self.calls, self.calls + 1
        async with super().request_stream(*args, **kwargs) as response:
            if n < len(self.usages):
                input_tokens, cached, output = self.usages[n]
                response._usage = RequestUsage(
                    input_tokens=input_tokens,
                    cache_read_tokens=cached,
                    output_tokens=output,
                )
            yield response


def _finished_run(saved: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """``FINISHED_RUN`` with ``saved`` export steps that each saved a layer,
    and the workflow's nodes."""
    exports = [f"save-{n}" for n in range(saved)]
    nodes: list[dict[str, Any]] = [
        {
            "id": "tool-walk",
            "type": "tool",
            "data": {"type": "tool", "processId": "buffer"},
        },
        *(
            {"id": node, "type": "export", "data": {"type": "export", "label": node}}
            for node in exports
        ),
    ]
    results = {
        **FINISHED_RUN["result"]["node_results"],
        **{
            node: {"status": "success", "feature_count": 3, "layer_project_id": 100 + n}
            for n, node in enumerate(exports)
        },
    }
    job = {**FINISHED_RUN, "result": {"status": "success", "node_results": results}}
    return job, nodes


async def _answer_run(
    *responses: Response,
    budget: RunBudget | None = None,
    usages: Sequence[Usage] = (),
    saved: int = 0,
    layers: list[dict[str, Any]] | None = None,
    created: Sequence[str] = (),
    asks: AskHistory | None = None,
    core_routes: dict[tuple[str, str], Any] | None = None,
    catalog: Recorder | None = None,
) -> Answered:
    """One answer on a workflow page whose model gives ``responses`` in order,
    then a closing text, under the run's limits as the run manager sets them
    from ``budget``. The open project's workflow has a finished run that
    saved ``saved`` layers, and the project's ``layers`` can be listed. The
    workflows in ``created`` were created in this answer; ``asks`` holds the
    conversation's cards and answers, ``core_routes`` more of core's
    answers, and ``catalog`` the catalog."""
    job, nodes = _finished_run(saved)
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{RUN_PROJECT}/workflow/{RUN_WORKFLOW}"): {
                "id": RUN_WORKFLOW,
                "config": {"nodes": nodes, "edges": []},
            },
            ("GET", f"/api/v2/project/{RUN_PROJECT}"): {"name": "Run project"},
            ("GET", f"/api/v2/project/{RUN_PROJECT}/layer"): layers or [],
            ("GET", f"/api/v2/project/{RUN_PROJECT}/group"): [],
            **(core_routes or {}),
        }
    )
    # Listed while it was still going: workflow_run waits for it instead of
    # starting one, and its status is the finished run.
    processes = Recorder(
        {
            ("GET", "/jobs"): {"jobs": [{**job, "status": "running"}]},
            ("GET", "/jobs/j1"): job,
            ("GET", "/processes"): {"processes": []},
        }
    )

    infos: list[AgentInfo] = []
    notes: list[str | None] = []

    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        infos.append(info)
        notes.append(stage_note(messages))
        step = sum(isinstance(message, ModelResponse) for message in messages)
        if step >= len(responses):
            yield "The run buffered 3 features."
            return
        for index, item in enumerate(responses[step]):
            if isinstance(item, str):
                yield item
            else:
                name, args = item
                yield {
                    index: DeltaToolCall(
                        name=name,
                        json_args=json.dumps(args),
                        tool_call_id=f"call-{step}-{index}",
                    )
                }

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise AssertionError("the run streams")

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
        fake_clients(core=core, processes=processes, catalog=catalog),
        page=page,
        emit_data=deps.emit_data,
    )
    deps.env.workflows_created.update(created)
    deps.env.runs.created.update(created)
    if asks is not None:
        deps.env.asks = asks

    async def on_event(event: Any) -> None:
        return None

    model = (
        _Metered(stream, usages)
        if usages
        else FunctionModel(respond, stream_function=stream)
    )
    turn = await run_turn(
        build_agent(model),
        "Run it",
        deps=deps,
        on_event=on_event,
        usage_limits=budget.usage_limits() if budget is not None else None,
    )
    return Answered(turn=turn, shown=shown, deps=deps, infos=infos, notes=notes)


def _results(turn: Turn, tool: str) -> list[ToolReturnPart]:
    return [
        part
        for message in turn.messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == tool
    ]


def _card_results(turn: Turn) -> list[ToolReturnPart]:
    return _results(turn, "ask_user")


def _run_finished(turn: Turn, tool: str = "workflow_last_run") -> bool:
    [run] = _results(turn, tool)
    return isinstance(run.content, dict) and run.content["status"] == "succeeded"


LAST_RUN_CALL = ("workflow_last_run", {"workflow_id": RUN_WORKFLOW})


@pytest.mark.parametrize("tool", ["workflow_run", "workflow_last_run"])
async def test_a_card_before_the_finished_runs_numbers_is_refused(tool: str) -> None:
    """A finished run's numbers come first: a card right after its result is
    not shown, and the model writes its answer instead."""
    call = (tool, {"workflow_id": RUN_WORKFLOW})
    turn, shown = await _answer([call], [("ask_user", CARD)])
    assert _run_finished(turn, tool)
    assert shown == []
    [refused] = _card_results(turn)
    assert refused.outcome == "failed" and refused.content == REPORT_FIRST
    assert turn.output == "The run buffered 3 features."


def test_the_refusal_fits_a_read_of_how_a_layer_was_made() -> None:
    """workflow_last_run also arms the refusal when it only checks how a layer
    the answer considers was made: the refusal asks for what the result tells,
    which is a run's numbers only when the question is about them."""
    assert "write the text first (what the result tells you:" in REPORT_FIRST
    assert "a run's numbers, what failed" in REPORT_FIRST
    assert "what it says about a layer you consider" in REPORT_FIRST
    assert "report what the run found" not in REPORT_FIRST


def test_the_refusal_says_how_the_card_passes() -> None:
    """A model that knows a response with text alone ends its answer kept
    its card and sent it again without text: the refusal says the text and
    the card go in one response, text first."""
    assert REPORT_FIRST.startswith("This card was not shown. In the same response,")
    assert "then call ask_user" in REPORT_FIRST
    assert "A response with text alone ends the answer without the card." in (
        REPORT_FIRST
    )
    assert REPEATED_CARD == (
        "The card was refused because this response has no text: write the text "
        "in this response, then the card."
    )


async def test_a_card_in_the_same_response_as_the_run_is_refused() -> None:
    """Text written before the run's result reports nothing of it."""
    turn, shown = await _answer(["Let me run it.", LAST_RUN_CALL, ("ask_user", CARD)])
    assert _run_finished(turn)
    assert shown == []
    [refused] = _card_results(turn)
    assert refused.outcome == "failed" and refused.content == REPORT_FIRST


async def test_a_card_after_the_runs_numbers_are_written_is_shown() -> None:
    turn, shown = await _answer(
        [LAST_RUN_CALL], ["The run buffered 3 features.", ("ask_user", CARD)]
    )
    assert _run_finished(turn)
    assert len(shown) == 1
    [asked] = _card_results(turn)
    assert asked.outcome != "failed" and isinstance(asked.content, dict)
    assert asked.content["card_id"] == shown[0].part_id
    assert turn.output is None


async def test_a_card_before_any_run_is_shown() -> None:
    turn, shown = await _answer([("ask_user", CARD)])
    assert len(shown) == 1
    assert turn.output is None


def _card(question: str) -> tuple[str, dict[str, Any]]:
    return ("ask_user", {"questions": [_question(question=question)]})


def _retries(turn: Turn, tool: str) -> list[RetryPromptPart]:
    return [
        part
        for message in turn.messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, RetryPromptPart) and part.tool_name == tool
    ]


async def test_the_gate_refuses_a_card_at_most_twice_per_result() -> None:
    """A model that kept sending its card without the text looped on the
    refusal until its budget was gone: the third card in a row after the
    same result is shown."""
    assert REPORT_REFUSALS == 2
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [_card("Which first?")],
        [_card("Which second?")],
        [_card("Which third?")],
    )
    first, second, third = _card_results(answered.turn)
    assert first.outcome == "failed" and first.content == REPORT_FIRST
    assert second.outcome == "failed" and second.content == REPORT_FIRST
    assert third.outcome != "failed" and isinstance(third.content, dict)
    assert [part.part_id for part in answered.shown] == [third.content["card_id"]]


async def test_an_identical_repeat_of_a_refused_card_is_told_what_is_missing() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL], [("ask_user", CARD)], [("ask_user", CARD)]
    )
    first, second = _card_results(answered.turn)
    assert first.content == REPORT_FIRST
    assert second.outcome == "failed" and second.content == REPEATED_CARD
    assert answered.shown == []


async def test_a_changed_card_gets_the_full_refusal_again() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL], [_card("Which first?")], [_card("Which second?")]
    )
    assert [part.content for part in _card_results(answered.turn)] == [
        REPORT_FIRST,
        REPORT_FIRST,
    ]


async def test_each_result_to_report_gets_its_own_refusals() -> None:
    """The count is per result: a second finished run's result starts it
    again."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [_card("Which first?")],
        [_card("Which second?")],
        [("workflow_run", {"workflow_id": RUN_WORKFLOW})],
        [_card("Which third?")],
    )
    assert _run_finished(answered.turn, "workflow_run")
    assert [part.content for part in _card_results(answered.turn)] == [REPORT_FIRST] * 3
    assert answered.shown == []


async def test_a_card_with_placeholder_labels_gets_the_label_error_first() -> None:
    """A probe card ("x?", options "A" and "B") is told what is wrong with
    it, not to report the run, and leaves the gate's count alone."""
    placeholder = {"questions": [_question(options=[{"label": "A"}, {"label": "B"}])]}
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [("ask_user", placeholder)],
        [_card("Which first?")],
        [_card("Which second?")],
    )
    [retry] = _retries(answered.turn, "ask_user")
    assert "no placeholders" in str(retry.content)
    assert [part.content for part in _card_results(answered.turn)] == [
        REPORT_FIRST,
        REPORT_FIRST,
    ]


async def test_a_second_card_is_refused_before_its_labels_are_checked() -> None:
    placeholder = {"questions": [_question(options=[{"label": "A"}, {"label": "B"}])]}
    answered = await _answer_run(
        ["Which schools?", ("ask_user", CARD), ("ask_user", placeholder)]
    )
    shown, second = _card_results(answered.turn)
    assert isinstance(shown.content, dict)
    assert second.outcome == "failed" and second.content == ONE_CARD
    assert _retries(answered.turn, "ask_user") == []


async def test_refused_cards_take_none_of_the_answers_look_ups() -> None:
    """Refused before the look-ups count it: each refused card still costs a
    model call, but no tool call of the run's limit."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [_card("Which first?")],
        [_card("Which second?")],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    assert len(_card_results(answered.turn)) == 2
    # The run's read only.
    assert list(answered.deps.admitted_calls.values()) == [1]


# -- reading a finished run's result past the look-up budget ----------------------

READ_CALL: tuple[str, dict[str, Any]] = ("project_get_layers", {})
#: The instruction of a step that reads the result of a run without saved
#: layers.
READ_THE_RESULT = read_the_result(RESULT_READS)
LOOK_UP: Response = [("core_page_context", {})]


def _offered(info: AgentInfo) -> set[str]:
    return {tool.name for tool in info.function_tools}


def _stage(note: str | None) -> str:
    """The stage a model call's note names (``assistant.agent.stage_note``):
    "look up" for a call without one."""
    if note is None:
        return "look up"
    reading = any(
        read_the_result(reads) in note
        for reads in range(RESULT_READS, MAX_RESULT_READS + 1)
    )
    stage = "read" if reading else "answer"
    return f"{stage} or ask" if ANSWER_NOW_CARD in note else stage


def test_the_result_is_read_with_the_project_reads_and_tool_descriptions() -> None:
    assert RESULT_READS == 3
    # The count is per result, also at the second and third read.
    assert "at most 3 calls in all" in READ_THE_RESULT
    assert "at most 5 calls in all" in read_the_result(5)
    assert "card" not in READ_THE_RESULT
    # It names the reads: every call offers every tool of the page.
    assert "workflow_describe_tool" in READ_THE_RESULT
    assert "project_group_statistics" in READ_THE_RESULT
    assert "budget" not in READ_THE_RESULT
    assert CARD_AFTER_TEXT == (
        "Write the text first and the card after it, in the same response."
    )
    assert "project_get_layers" in RESULT_READ_TOOLS
    assert "project_group_statistics" in RESULT_READ_TOOLS
    # What a result's scale or field means, from the tool that made it.
    assert "workflow_describe_tool" in RESULT_READ_TOOLS
    assert BY_WIRE_NAME["workflow_describe_tool"].returns_data is False
    for name in RESULT_READ_TOOLS:
        assert BY_WIRE_NAME[name].risk == "read"
    # Not a proposal, and not a run read, which would arm the gate again.
    assert "map_propose_view" not in RESULT_READ_TOOLS
    assert "workflow_last_run" not in RESULT_READ_TOOLS


async def test_past_its_budget_an_answer_still_reads_its_runs_result() -> None:
    """An answer whose look-ups were spent right after its run was offered
    only the card, and could not read its own result: it may still read it
    with the project tools, up to three calls."""
    answered = await _answer_run(
        # Five tool calls kept in reserve of 30: the run is the 25th.
        *[LOOK_UP] * 24,
        [LAST_RUN_CALL],
        [READ_CALL],
        ["The run buffered 3 features.", ("ask_user", CARD)],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    reading = answered.notes[25]
    assert _stage(reading) == "read or ask"
    assert READ_THE_RESULT in str(reading) and CARD_AFTER_TEXT in str(reading)
    [read] = _results(answered.turn, "project_get_layers")
    assert read.outcome != "failed"
    assert _stage(answered.notes[26]) == "read or ask"
    # Every call offers the same tools; the stage refuses the others as they
    # run.
    assert all(_offered(info) == _offered(answered.infos[0]) for info in answered.infos)
    assert len(answered.shown) == 1


async def test_the_result_reads_run_past_the_tool_call_limit() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [READ_CALL],
        [READ_CALL, READ_CALL, READ_CALL],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    # The run took the run's only tool call; no card fits after it.
    assert answered.notes[1] == READ_THE_RESULT
    reads = _results(answered.turn, "project_get_layers")
    assert [read.outcome != "failed" for read in reads] == [True, True, True, False]
    assert reads[-1].content == LOOK_UPS_USED_UP
    assert list(answered.deps.admitted_calls.values()) == [1 + RESULT_READS]
    # Its reads used, the answer writes its text.
    assert _stage(answered.notes[3]) == "answer"
    assert answered.turn.output == "The run buffered 3 features."


DESCRIBE_CALL: tuple[str, dict[str, Any]] = (
    "workflow_describe_tool",
    {"tool_ids": ["buffer"]},
)


async def test_the_description_of_the_tool_is_one_of_the_reads() -> None:
    """Past its budget, an answer reads which way a result's scale runs, or
    what a field means, from the description of the tool that made it,
    instead of asking the user."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [DESCRIBE_CALL],
        [READ_CALL, READ_CALL, READ_CALL],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    assert _stage(answered.notes[1]) == "read"
    [described] = _results(answered.turn, "workflow_describe_tool")
    assert described.outcome != "failed"
    reads = _results(answered.turn, "project_get_layers")
    assert [read.outcome != "failed" for read in reads] == [True, True, False]
    assert reads[-1].content == LOOK_UPS_USED_UP


async def test_a_reported_result_ends_its_reads() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL],
        ["The run buffered 3 features.", READ_CALL],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    assert _stage(answered.notes[1]) == "read"
    assert _stage(answered.notes[2]) == "answer"


async def test_without_a_result_to_report_the_budget_ends_the_reads() -> None:
    answered = await _answer_run(
        [READ_CALL],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    assert _stage(answered.notes[1]) == "answer"


#: A run whose result arrives as its token budget is spent, on a provider
#: that reads nothing from its cache: the run's call at 50,000 tokens. The
#: first read step reports a smaller context, which would let the budget
#: allow a look-up again.
RUN_ON_TOKENS: tuple[Usage, Usage] = ((50_000, 0, 1_000), (20_000, 0, 500))
#: After the run's call (51,000 spent, a context of about 51,200 with its
#: result), a look-up and the two calls after it would need about 229,600:
#: the look-ups are spent. Two calls of that context fit (about 161,400: the
#: read step and the answer step), so its result is read.
READ_ON_TOKENS = RunBudget(max_tokens=220_000, max_tool_calls=30)


async def test_when_tokens_end_the_look_ups_the_result_is_read_while_two_calls_fit() -> (
    None
):
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [READ_CALL],
        [READ_CALL],
        budget=READ_ON_TOKENS,
        # The second read step reads its input from the cache and writes a
        # long output: after it, the read step and the answer step no longer
        # fit (about 237,900), the answer step does (about 185,000).
        usages=[*RUN_ON_TOKENS, (20_600, 20_000, 50_000), (70_700, 0, 1_000)],
    )
    stages = [_stage(note) for note in answered.notes]
    # Still reading after the smaller read step, not looking things up.
    assert stages == ["look up", "read or ask", "read or ask", "answer or ask"]
    assert READ_THE_RESULT in str(answered.notes[1])
    assert len(_results(answered.turn, "project_get_layers")) == 2
    assert answered.turn.output == "The run buffered 3 features."


async def test_a_run_that_read_past_its_budget_looks_nothing_else_up() -> None:
    """Once the result is reported, the read step's smaller context would let
    the budget allow a look-up with every tool again."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        ["The run buffered 3 features.", READ_CALL],
        budget=READ_ON_TOKENS,
        usages=RUN_ON_TOKENS,
    )
    assert _stage(answered.notes[1]) == "read or ask"
    assert _stage(answered.notes[2]) == "answer or ask"


async def test_a_read_step_needs_room_for_itself_and_the_answer_step() -> None:
    """At 200,000, the read step and the answer step fit after the run's call
    (about 161,400): the room a look-up keeps after it."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [READ_CALL],
        budget=RunBudget(max_tokens=200_000, max_tool_calls=30),
        usages=RUN_ON_TOKENS,
    )
    assert _stage(answered.notes[1]) == "read or ask"
    assert READ_THE_RESULT in str(answered.notes[1])
    assert answered.turn.output == "The run buffered 3 features."


#: Look-ups whose context grows by 4,000 tokens a call from 20,000 to 48,000,
#: each reading the call before it from the cache, then the run's call at
#: 50,000: an answer that built and ran a workflow, as the live evaluations
#: measure it. About 67,800 weighted tokens after the run's call.
LOOK_UPS_THEN_RUN: list[Usage] = [
    *((size, size - 4_000, 500) for size in range(20_000, 52_000, 4_000)),
    (50_000, 48_000, 1_000),
]


async def test_at_the_default_budget_an_answer_that_ran_its_workflow_looks_on() -> None:
    """After the run's call, about 67,800 weighted tokens in, one more
    look-up and the read step and the answer step after it still fit (about
    117,700 of 200,000): each reads the answer so far from the cache, so the
    answer reads its result with every tool."""
    defaults = AssistantSettings.model_fields
    budget = RunBudget(
        max_tokens=defaults["run_max_tokens"].default,
        max_tool_calls=defaults["run_max_tool_calls"].default,
    )
    answered = await _answer_run(
        *[LOOK_UP] * 8,
        [LAST_RUN_CALL],
        budget=budget,
        usages=LOOK_UPS_THEN_RUN,
    )
    assert answered.notes == [None] * 10
    everything = _offered(answered.infos[0])
    assert all(_offered(info) == everything for info in answered.infos)


async def test_with_its_reads_used_the_card_still_comes_after_the_text() -> None:
    """Offered only the card while the run's result is not yet in its text,
    the step is told to write the text first, in the same response."""
    answered = await _answer_run(
        # Five tool calls kept in reserve of 30: the run is the 25th.
        *[LOOK_UP] * 24,
        [LAST_RUN_CALL],
        [READ_CALL] * RESULT_READS,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    answering = answered.notes[26]
    assert _stage(answering) == "answer or ask"
    assert CARD_AFTER_TEXT in str(answering)


async def test_without_a_result_to_report_the_card_still_comes_after_the_text() -> None:
    """Every step that may show the card asks for the text first: cards
    that came alone left the user a question with nothing said before it."""
    answered = await _answer_run(
        *[LOOK_UP] * 25,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    answering = answered.notes[25]
    assert _stage(answering) == "answer or ask"
    assert str(answering).endswith(f"{ANSWER_NOW_CARD} {CARD_AFTER_TEXT}")


async def test_two_cards_in_one_response_take_one_refusal() -> None:
    """The count is of responses: a response with two cards and no text gets
    one round of the refusal, not both."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [_card("Which first?"), _card("Which second?")],
        [_card("Which third?")],
        [_card("Which fourth?")],
    )
    results = _card_results(answered.turn)
    assert [part.content for part in results[:3]] == [REPORT_FIRST] * 3
    assert results[3].outcome != "failed" and isinstance(results[3].content, dict)
    assert len(answered.shown) == 1


async def test_a_read_that_reaches_the_limit_leaves_the_card_of_its_response() -> None:
    """The card offered with the reads is not crowded out by a read in the
    same response that takes the last tool call."""
    answered = await _answer_run(
        # One tool call kept in reserve of six: the run is the fifth.
        *[LOOK_UP] * 4,
        [LAST_RUN_CALL],
        ["The run buffered 3 features.", READ_CALL, ("ask_user", CARD)],
        budget=RunBudget(max_tokens=10**9, max_tool_calls=6),
    )
    assert _stage(answered.notes[5]) == "read or ask"
    [card] = _card_results(answered.turn)
    assert card.outcome != "failed" and isinstance(card.content, dict)
    assert len(answered.shown) == 1


def test_a_result_may_be_read_once_per_saved_layer_and_once_more() -> None:
    """Three reads were too few for a run that saved four layers: the
    allowance is one read per saved layer and one more, at least three and at
    most six."""
    assert [read_allowance(saved) for saved in range(8)] == [3, 3, 3, 4, 5, 6, 6, 6]
    assert MAX_RESULT_READS == 6


async def test_a_run_with_four_saved_layers_may_read_five_times() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [READ_CALL] * 6,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
        saved=4,
    )
    assert answered.notes[1] == read_the_result(5)
    reads = _results(answered.turn, "project_get_layers")
    assert [read.outcome != "failed" for read in reads] == [True] * 5 + [False]
    assert reads[-1].content == LOOK_UPS_USED_UP
    assert list(answered.deps.admitted_calls.values()) == [1 + 5]


async def test_the_allowance_is_not_exceeded() -> None:
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [READ_CALL] * 4,
        [READ_CALL] * 4,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
        saved=9,
    )
    reads = _results(answered.turn, "project_get_layers")
    assert [read.outcome != "failed" for read in reads] == [True] * 6 + [False] * 2
    assert list(answered.deps.admitted_calls.values()) == [1 + MAX_RESULT_READS]


async def test_reads_past_the_cap_in_a_batch_after_a_run_count_against_the_allowance() -> (
    None
):
    """A batch of reads in a step that may still look things up reached the
    run's tool-call limit halfway: the reads past it ran while the run's
    result was unreported, up to the result's allowance, which the read
    steps after it share."""
    answered = await _answer_run(
        # Five tool calls kept in reserve of 30: the run is the 24th, and the
        # next step may still look up.
        *[LOOK_UP] * 23,
        [LAST_RUN_CALL],
        [READ_CALL] * 10,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=30),
    )
    assert _stage(answered.notes[24]) == "look up"
    reads = _results(answered.turn, "project_get_layers")
    # Six within the limit, three past it, and the batch's last is refused.
    assert sum(read.outcome != "failed" for read in reads) == 6 + RESULT_READS
    assert [read.content for read in reads].count(LOOK_UPS_USED_UP) == 1
    assert list(answered.deps.admitted_calls.values()) == [30 + RESULT_READS]
    # The allowance is spent: no read step follows, and the answer writes.
    assert _stage(answered.notes[25]) == "answer"
    assert answered.turn.output == "The run buffered 3 features."


async def test_a_read_past_the_cap_is_held_to_the_answers_room() -> None:
    """Admitted past the tool-call limit, a read's result still has to
    leave the answer step its room."""
    answered = await _answer_run(
        [LAST_RUN_CALL],
        [LOOK_UP[0], READ_CALL],
        budget=RunBudget(max_tokens=60_000, max_tool_calls=2),
        usages=[(2_000, 0, 100), (3_000, 0, 100)],
        layers=[{"id": 7, "name": "x" * 120_000, "type": "feature"}],
    )
    assert _stage(answered.notes[1]) == "look up"
    [read] = _results(answered.turn, "project_get_layers")
    assert read.outcome == "failed" and read.content == RESULT_TOO_LARGE
    assert _stage(answered.notes[2]) == "answer"


async def test_a_read_in_the_response_that_ran_the_workflow_takes_none_of_its_reads() -> (
    None
):
    """A read that runs after workflow_run in the same response was written
    before the model saw the result: past the limit it does not run, and
    the result keeps all of its reads."""
    answered = await _answer_run(
        [("workflow_run", {"workflow_id": RUN_WORKFLOW}), READ_CALL],
        [READ_CALL] * 4,
        budget=RunBudget(max_tokens=10**9, max_tool_calls=1),
    )
    assert _run_finished(answered.turn, "workflow_run")
    reads = _results(answered.turn, "project_get_layers")
    assert [read.outcome != "failed" for read in reads] == [False] + [True] * 3 + [
        False
    ]
    assert reads[0].content == LOOK_UPS_USED_UP
