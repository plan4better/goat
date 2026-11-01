"""The answer to a card (spec §5.2, §5.3): checked against the stored card,
stored with the user message, given to the model with its values, returned to
the web as metadata, and the only thing that counts as consent."""

import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)

from assistant.agent import RunDeps, build_agent
from assistant.asks import (
    AskHistory,
    AskUserInput,
    CardAnswer,
    QuestionAnswer,
    answer_lines,
    answer_problem,
    card_data,
    user_chose,
)
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.events import (
    DataPart,
    ToolCalled,
    ToolFailed,
    ToolReturned,
    fold_parts,
    to_ui_message,
)
from assistant.prompt import ANSWER_CLOSE, ANSWER_INTRO, ANSWER_OPEN, with_note
from assistant.repo import Repository
from assistant.runs.manager import InvalidAnswer, RunManager
from assistant.tools.testing import ScriptedModel, fake_clients

USER = UUID(int=1)
Api = Any  # conftest.ApiFactory
Projects = Any  # conftest.ProjectFactory

CARD_ARGS: dict[str, Any] = {
    "questions": [
        {
            "question": "Which schools should the catchments start from?",
            "header": "Schools",
            "options": [
                {"label": "Schulen (Stand 2019)", "value": "32"},
                {"label": "Schulen", "recommended": True, "value": "31"},
            ],
        },
        {
            "question": "Which destinations matter?",
            "header": "Destinations",
            "multi_select": True,
            "options": [
                {"label": "Supermarkets", "value": "eval-supermaerkte-bayern"},
                {"label": "Schools Bavaria", "value": "eval-schulen-bayern"},
                {"label": "Leave it open"},
            ],
        },
    ]
}
CARD = AskUserInput.model_validate(CARD_ARGS)
#: Card ids as ``ask_user`` mints them; never derived from the tool call id.
CARD_ID = "ask-5d1f0c3e8a2b4c6d9e7f1a2b3c4d5e6f"
LATER_ID = "ask-9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d"
ANSWER = CardAnswer(
    card_id=CARD_ID,
    answers=[
        QuestionAnswer(question=0, options=[0]),
        QuestionAnswer(question=1, options=[0, 1]),
    ],
)
ASKED_PARTS: list[dict[str, Any]] = [
    {
        "type": "tool",
        "tool_call_id": "call-1",
        "tool_name": "ask_user",
        "args": CARD_ARGS,
        "state": "output",
        "output": {"card_id": CARD_ID, "status": "asked"},
        "error": None,
    },
    {
        "type": "data",
        "name": "ask",
        "id": CARD_ID,
        "data": card_data(CARD_ID, CARD),
    },
]
#: A card of a later answer whose provider reused the tool call id "call-1".
LATER_ARGS: dict[str, Any] = {
    "questions": [
        {
            "question": "Which stops should the catchments start from?",
            "header": "Stops",
            "options": [
                {"label": "Bus stops", "value": "eval-bus-stops"},
                {"label": "Tram stops", "value": "eval-tram-stops"},
            ],
        },
        {
            "question": "Which parks matter?",
            "header": "Parks",
            "multi_select": True,
            "options": [
                {"label": "City parks", "value": "eval-city-parks"},
                {"label": "Forests", "value": "eval-forests"},
            ],
        },
    ]
}
LATER_PARTS: list[dict[str, Any]] = [
    {
        **ASKED_PARTS[0],
        "args": LATER_ARGS,
        "output": {"card_id": LATER_ID, "status": "asked"},
    },
    {
        **ASKED_PARTS[1],
        "id": LATER_ID,
        "data": card_data(LATER_ID, AskUserInput.model_validate(LATER_ARGS)),
    },
]


def _assistant(*parts: dict[str, Any]) -> dict[str, Any]:
    return {"role": "assistant", "parts": list(parts)}


def _user(*parts: dict[str, Any]) -> dict[str, Any]:
    return {"role": "user", "parts": list(parts)}


def test_the_answer_lines_carry_labels_and_values() -> None:
    assert answer_lines(CARD, ANSWER) == (
        "Schools: Schulen (value 31)\n"
        "Destinations: Supermarkets (value eval-supermaerkte-bayern), "
        "Schools Bavaria (value eval-schulen-bayern)"
    )


def test_other_text_is_one_line_and_an_empty_reply_is_left_out() -> None:
    answer = CardAnswer(
        card_id=CARD_ID,
        answers=[
            QuestionAnswer(question=0),
            QuestionAnswer(question=1, options=[2], other="e-scooter\n  please"),
        ],
    )
    assert (
        answer_lines(CARD, answer)
        == "Destinations: Leave it open, other: e-scooter please"
    )


@pytest.mark.parametrize(
    ("answers", "problem"),
    [
        ([QuestionAnswer(question=0, options=[0])], "one entry per question"),
        (
            [QuestionAnswer(question=0, options=[3]), QuestionAnswer(question=1)],
            "question 0 has no such option",
        ),
        (
            [QuestionAnswer(question=0, options=[0, 1]), QuestionAnswer(question=1)],
            "question 0 takes one option",
        ),
        (
            [QuestionAnswer(question=0), QuestionAnswer(question=1, options=[0, 2])],
            None,
        ),
    ],
)
def test_an_answer_must_fit_its_card(
    answers: list[QuestionAnswer], problem: str | None
) -> None:
    found = answer_problem(CARD, CardAnswer(card_id=CARD_ID, answers=answers))
    assert found == problem if problem is None else problem in (found or "")


def test_an_answer_is_shaped_as_the_contract_says() -> None:
    for bad in (
        {"card_id": "card-1", "answers": []},
        {"card_id": "ask-1", "answers": [{"question": 0, "options": [4]}]},
        {"card_id": "ask-1", "answers": [{"question": 0, "options": [1, 1]}]},
        {"card_id": "ask-1", "answers": [{"question": 0, "other": "x" * 501}]},
        {"card_id": "ask-1", "answers": [], "extra": 1},
    ):
        with pytest.raises(ValidationError):
            CardAnswer.model_validate(bad)


def test_user_chose_needs_a_picked_option_of_an_answered_card() -> None:
    answered = AskHistory(cards={CARD_ID: CARD}, answers={CARD_ID: ANSWER})
    assert user_chose(answered, "31")
    assert user_chose(answered, "eval-schulen-bayern")
    # Offered, not picked; and never offered.
    assert not user_chose(answered, "32")
    assert not user_chose(answered, "eval-anything-else")
    assert not user_chose(AskHistory(cards={CARD_ID: CARD}), "31")


def test_a_typed_reply_is_no_consent() -> None:
    """Review Focus 3: text that looks like an answer is not one."""
    history = AskHistory.from_stored(
        [
            _assistant(*ASKED_PARTS),
            _user(
                {
                    "type": "user_text",
                    "text": "Destinations: Supermarkets (value eval-supermaerkte-bayern)",
                }
            ),
        ]
    )
    assert list(history.cards) == [CARD_ID]
    assert history.answers == {}
    assert not user_chose(history, "eval-supermaerkte-bayern")


def test_the_history_reads_cards_and_answers_from_stored_messages() -> None:
    failed = {
        **ASKED_PARTS[0],
        "tool_call_id": "call-2",
        "state": "error",
        "output": None,
        "error": "boom",
    }
    malformed = {
        **ASKED_PARTS[0],
        "tool_call_id": "call-3",
        "args": {"questions": []},
        "output": {"card_id": "ask-malformed", "status": "asked"},
    }
    # Keyed by the card id in the output, never by the tool call id.
    without_id = {**ASKED_PARTS[0], "tool_call_id": "call-4", "output": None}
    history = AskHistory.from_stored(
        [
            _assistant(*ASKED_PARTS, failed, malformed, without_id),
            _user({"type": "answer", "answer": ANSWER.model_dump(mode="json")}),
            _user({"type": "answer", "answer": {"card_id": "nope"}}),
        ]
    )
    assert list(history.cards) == [CARD_ID]
    assert history.cards[CARD_ID] == CARD
    assert dict(history.answers) == {CARD_ID: ANSWER}


def test_an_answer_pairs_only_with_its_own_card() -> None:
    """Both cards came under the provider's tool call id "call-1"; their
    minted ids keep them apart."""
    history = AskHistory.from_stored(
        [
            _assistant(*ASKED_PARTS),
            _user({"type": "answer", "answer": ANSWER.model_dump(mode="json")}),
            _assistant(*LATER_PARTS),
        ]
    )
    assert list(history.cards) == [CARD_ID, LATER_ID]
    assert dict(history.answers) == {CARD_ID: ANSWER}
    assert user_chose(history, "31")
    # The later card's options at the indexes picked on the first are no picks.
    assert not user_chose(history, "eval-bus-stops")
    assert not user_chose(history, "eval-city-parks")


def test_a_card_id_two_parts_carry_names_no_card() -> None:
    """Never minted twice; if it were, an answer could not say which card it
    was given to (fail closed)."""
    duplicate = {**LATER_PARTS[0], "output": ASKED_PARTS[0]["output"]}
    history = AskHistory.from_stored(
        [
            _assistant(*ASKED_PARTS),
            _user({"type": "answer", "answer": ANSWER.model_dump(mode="json")}),
            _assistant(duplicate),
        ]
    )
    assert history.cards == {}
    assert not user_chose(history, "31")
    assert not user_chose(history, "eval-bus-stops")


def test_the_answer_reaches_the_model_in_its_own_block() -> None:
    lines = answer_lines(CARD, ANSWER)
    assert with_note("Current page: x.", "Schools: Schulen", lines) == [
        "<goat-note>\nCurrent page: x.\n</goat-note>",
        "Schools: Schulen",
        f"{ANSWER_OPEN}\n{ANSWER_INTRO}\n{lines}\n{ANSWER_CLOSE}",
    ]
    assert with_note("", "hi") == "hi"


def test_a_reloaded_user_message_carries_its_answer_as_metadata() -> None:
    answer = ANSWER.model_dump(mode="json")
    message = to_ui_message(
        "u1",
        "user",
        [
            {"type": "user_text", "text": "Schools: Schulen"},
            {"type": "answer", "answer": answer},
        ],
    )
    assert message == {
        "id": "u1",
        "role": "user",
        "parts": [{"type": "text", "text": "Schools: Schulen"}],
        "metadata": {"answer": answer},
    }


def _factory(script: ScriptedModel) -> Any:
    def factory(model: Model | str) -> Agent[RunDeps, str]:
        return build_agent(script.model)

    return factory


async def _asked(repo: Repository, parts: list[dict[str, Any]] | None = None) -> UUID:
    """A conversation whose last answer showed the card (``ASKED_PARTS``)."""
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    conversation_id = UUID(str(conversation["id"]))
    run_id, _ = await repo.begin_run(
        conversation_id,
        USER,
        [{"type": "user_text", "text": "Build it"}],
        "test",
        "test",
        3,
    )
    assert await repo.finish_run(run_id, "succeeded", None, parts or ASKED_PARTS, [])
    return conversation_id


def _prompt(request: list[ModelMessage]) -> list[str]:
    for message in reversed(request):
        for part in reversed(getattr(message, "parts", [])):
            if isinstance(part, UserPromptPart):
                content = part.content
                return (
                    [content] if isinstance(content, str) else [str(c) for c in content]
                )
    return []


PAGE = {
    "surface": "project.workflows",
    "project_id": "00000000-0000-0000-0000-0000000005e4",
}


async def test_an_answer_reaches_the_model_with_its_values_and_is_stored(
    repo: Repository, settings: AssistantSettings
) -> None:
    script = ScriptedModel(answer="Thanks, I will build it.")
    manager = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=_factory(script)
    )
    conversation_id = await _asked(repo)
    run_id, _ = await manager.start_run(
        conversation_id,
        USER,
        "Schools: Schulen. Destinations: Supermarkets, Schools Bavaria",
        parse_context(PAGE),
        answer=ANSWER,
    )
    await manager.wait(run_id)
    prompt = _prompt(script.requests[0])
    assert (
        f"{ANSWER_OPEN}\n{ANSWER_INTRO}\n{answer_lines(CARD, ANSWER)}\n{ANSWER_CLOSE}"
        in prompt
    )
    messages = await repo.list_messages(conversation_id, None)
    user = [m for m in messages if m["role"] == "user"][-1]
    assert {"type": "answer", "answer": ANSWER.model_dump(mode="json")} in user["parts"]


async def test_an_answer_to_an_unknown_or_answered_card_is_refused(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=_factory(ScriptedModel()),
    )
    conversation_id = await _asked(repo)
    before = len(await repo.list_messages(conversation_id, None))
    unknown = ANSWER.model_copy(update={"card_id": "ask-nope"})
    with pytest.raises(InvalidAnswer, match="no such card"):
        await manager.start_run(
            conversation_id, USER, "x", parse_context(PAGE), answer=unknown
        )
    unfit = CardAnswer(card_id=CARD_ID, answers=[QuestionAnswer(question=0)])
    with pytest.raises(InvalidAnswer, match="one entry per question"):
        await manager.start_run(
            conversation_id, USER, "x", parse_context(PAGE), answer=unfit
        )
    assert len(await repo.list_messages(conversation_id, None)) == before
    run_id, _ = await manager.start_run(
        conversation_id, USER, "Schools: Schulen", parse_context(PAGE), answer=ANSWER
    )
    await manager.wait(run_id)
    with pytest.raises(InvalidAnswer, match="answered already"):
        await manager.start_run(
            conversation_id, USER, "again", parse_context(PAGE), answer=ANSWER
        )


async def test_an_answer_to_a_card_id_two_parts_carry_is_refused(
    repo: Repository, settings: AssistantSettings
) -> None:
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=_factory(ScriptedModel()),
    )
    conversation_id = await _asked(repo)
    run_id, _ = await manager.start_run(
        conversation_id, USER, "Schools: Schulen", parse_context(PAGE), answer=ANSWER
    )
    await manager.wait(run_id)
    # A later answer's card under the same card id (never minted twice).
    duplicate = {**LATER_PARTS[0], "output": ASKED_PARTS[0]["output"]}
    run_id, _ = await repo.begin_run(
        conversation_id,
        USER,
        [{"type": "user_text", "text": "Now the parks"}],
        "test",
        "test",
        3,
    )
    assert await repo.finish_run(run_id, "succeeded", None, [duplicate], [])
    before = len(await repo.list_messages(conversation_id, None))
    with pytest.raises(InvalidAnswer, match="no such card"):
        await manager.start_run(
            conversation_id,
            USER,
            "Stops: Bus stops",
            parse_context(PAGE),
            answer=ANSWER,
        )
    assert len(await repo.list_messages(conversation_id, None)) == before


#: Pydantic AI's arguments of a call that is not JSON: the model's raw text,
#: here a card cut off in its first option.
CUT_OFF = {
    "INVALID_JSON": '{"questions":[{"question":"Which schools?","header":"Schools",'
    '"options":[{"label":"Schulen","value":"eval-cut-off"'
}


async def test_a_retry_under_the_same_id_shows_an_answerable_card(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A provider may reuse the id of a call that was not JSON for its retry.
    The answer then holds two parts under one id but showed one card: that
    card is answered, and it counts."""
    parts = fold_parts(
        [
            ToolCalled(tool_call_id="call-1", tool_name="ask_user", args=CUT_OFF),
            ToolFailed(tool_call_id="call-1", error="json_invalid"),
            ToolCalled(tool_call_id="call-1", tool_name="ask_user", args=CARD_ARGS),
            DataPart(name="ask", part_id=CARD_ID, data=card_data(CARD_ID, CARD)),
            ToolReturned(
                tool_call_id="call-1",
                output={"card_id": CARD_ID, "status": "asked"},
            ),
        ]
    )
    assert [part["state"] for part in parts if part["type"] == "tool"] == [
        "error",
        "output",
    ]
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=_factory(ScriptedModel()),
    )
    conversation_id = await _asked(repo, parts)
    run_id, _ = await manager.start_run(
        conversation_id, USER, "Schools: Schulen", parse_context(PAGE), answer=ANSWER
    )
    await manager.wait(run_id)
    history = AskHistory.from_stored(await repo.list_messages(conversation_id, None))
    assert user_chose(history, "31")
    assert user_chose(history, "eval-schulen-bayern")
    assert not user_chose(history, "eval-cut-off")


async def test_the_run_route_takes_an_answer_and_returns_it_without_values(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    project = await make_project("Erreichbarkeit")
    conversation_id = await _asked(repo)
    page = {"surface": "project.workflows", "project_id": str(project)}
    async with api() as client:
        response = await client.post(
            f"/conversations/{conversation_id}/runs",
            json={
                "message": {
                    "text": "Schools: Schulen. Destinations: Supermarkets, Schools Bavaria",
                    "answer": ANSWER.model_dump(mode="json"),
                },
                "context": page,
            },
        )
        assert response.status_code == 200, response.text
        body = (await client.get(f"/conversations/{conversation_id}")).json()
    users = [m for m in body["messages"] if m["role"] == "user"]
    assert users[-1]["metadata"]["answer"] == ANSWER.model_dump(mode="json")
    shown = json.dumps(body["messages"])
    assert '"value"' not in shown and "eval-supermaerkte-bayern" not in shown


async def test_an_invalid_answer_is_a_422_the_web_can_recognise(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    project = await make_project("Erreichbarkeit")
    conversation_id = await _asked(repo)
    async with api() as client:
        response = await client.post(
            f"/conversations/{conversation_id}/runs",
            json={
                "message": {
                    "text": "x",
                    "answer": {"card_id": "ask-nope", "answers": []},
                },
                "context": {"surface": "project.workflows", "project_id": str(project)},
            },
        )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_answer"


class _PerResponseIds:
    """A provider that numbers its tool calls per response: every answer asks
    its card under the call id ``call_0``. It asks with the next card when the
    newest message is the user's, and answers otherwise."""

    def __init__(self, *cards: dict[str, Any]) -> None:
        self.cards = list(cards)

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, stream_function=self._stream)

    def _card(self, messages: list[ModelMessage]) -> dict[str, Any] | None:
        newest = getattr(messages[-1], "parts", [])
        if not self.cards or not any(isinstance(p, UserPromptPart) for p in newest):
            return None
        return self.cards.pop(0)

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        card = self._card(messages)
        if card is None:
            return ModelResponse(parts=[TextPart(content="Waiting for your choice.")])
        return ModelResponse(
            parts=[ToolCallPart(tool_name="ask_user", args=card, tool_call_id="call_0")]
        )

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        card = self._card(messages)
        if card is None:
            yield "Waiting for your choice."
            return
        yield {
            0: DeltaToolCall(
                name="ask_user", json_args=json.dumps(card), tool_call_id="call_0"
            )
        }


async def test_cards_asked_under_one_provider_call_id_keep_their_own_answers(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A provider that numbers its calls per response asks every card under
    ``call_0``. The tool mints each card its own id, so each answer pairs with
    the card it was given to and lends no consent to the other."""
    provider = _PerResponseIds(CARD_ARGS, LATER_ARGS)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda model: build_agent(provider.model),
        tool_services=fake_clients(),
    )
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    conversation_id = UUID(str(conversation["id"]))

    async def say(text: str, answer: CardAnswer | None = None) -> AskHistory:
        run_id, _ = await manager.start_run(
            conversation_id, USER, text, parse_context(PAGE), answer=answer
        )
        await manager.wait(run_id)
        return AskHistory.from_stored(await repo.list_messages(conversation_id, None))

    [first] = (await say("Build it")).cards
    history = await say(
        "Schools: Schulen. Destinations: Supermarkets, Schools Bavaria",
        ANSWER.model_copy(update={"card_id": first}),
    )
    [second] = [card_id for card_id in history.cards if card_id != first]
    stored = await repo.list_messages(conversation_id, None)
    calls = [
        p["tool_call_id"] for m in stored for p in m["parts"] if p["type"] == "tool"
    ]
    assert calls == ["call_0", "call_0"]
    # Picked on the first card; the second card's options at those indexes are not.
    assert user_chose(history, "31") and user_chose(history, "eval-schulen-bayern")
    assert not user_chose(history, "eval-bus-stops")
    later = CardAnswer(
        card_id=second,
        answers=[
            QuestionAnswer(question=0, options=[1]),
            QuestionAnswer(question=1, options=[1]),
        ],
    )
    history = await say("Stops: Tram stops. Parks: Forests", later)
    assert user_chose(history, "eval-tram-stops") and user_chose(
        history, "eval-forests"
    )
    assert not user_chose(history, "eval-bus-stops")
    assert not user_chose(history, "eval-city-parks")
    assert user_chose(history, "31") and not user_chose(history, "32")
