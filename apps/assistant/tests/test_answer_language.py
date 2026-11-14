"""An answer in the other language than the user's message (English or German)
is asked for again, once (``assistant.agent.ends_with_text``), and only when
both languages are clear (``assistant.language``)."""

import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from assistant.agent import RunDeps, build_agent
from assistant.budget import RunBudget
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.events import TextReplaced, TextStarted, to_ui_message
from assistant.language import clear_language
from assistant.prompt import NO_ANSWER_TEXT, answer_in_language
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools.toolset import TOOL_RETRIES
from evals.tasks import LanguageCheck, load_tasks

USER = UUID(int=1)

ENGLISH_QUESTION = "How many bike paths are in the Radwege layer of this project?"
GERMAN_QUESTION = "Wie viele Radwege gibt es in diesem Projekt?"
GERMAN_ANSWER = (
    "Der Layer Radwege hat 16 Radwege. Die meisten sind Schutzstreifen, und für "
    "die übrigen ist keine Art eingetragen. Sie können die Werte in der Tabelle "
    "des Layers nachsehen."
)
ENGLISH_ANSWER = (
    "The Radwege layer has 16 bike paths. Most of them are protected lanes, and "
    "for the rest there is no type set. You can check the values in the layer's "
    "table."
)


class Answers:
    """A model that answers with the texts in turn, the last one for good, and
    records the parts of the request each answer was sent."""

    def __init__(self, *texts: str) -> None:
        self.texts = texts
        self.sent: list[list[Any]] = []

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, stream_function=self._stream)

    def _text(self, messages: list[ModelMessage]) -> str:
        self.sent.append(list(messages[-1].parts))
        answered = sum(isinstance(m, ModelResponse) for m in messages)
        return self.texts[min(answered, len(self.texts) - 1)]

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(content=self._text(messages))])

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        yield self._text(messages)

    def retries(self) -> list[str]:
        return [
            str(part.content)
            for parts in self.sent
            for part in parts
            if isinstance(part, RetryPromptPart)
        ]


def _deps(message: str, answer: str = "") -> RunDeps:
    async def emit(event: Any) -> None:
        return None

    return RunDeps(
        message_id="m1", emit=emit, prompt_text=message, prompt_answer=answer
    )


async def test_an_answer_in_the_other_language_is_asked_for_again_once() -> None:
    answers = Answers(GERMAN_ANSWER, ENGLISH_ANSWER)
    result = await build_agent(answers.model).run(
        ENGLISH_QUESTION, deps=_deps(ENGLISH_QUESTION)
    )
    assert result.output == ENGLISH_ANSWER
    assert answers.retries() == [answer_in_language("en", "de")]


async def test_a_german_message_gets_its_german_answer_asked_for() -> None:
    answers = Answers(ENGLISH_ANSWER, GERMAN_ANSWER)
    result = await build_agent(answers.model).run(
        GERMAN_QUESTION, deps=_deps(GERMAN_QUESTION)
    )
    assert result.output == GERMAN_ANSWER
    assert answers.retries() == [answer_in_language("de", "en")]


async def test_the_retry_is_not_repeated_and_its_answer_goes_out() -> None:
    """A second answer in the wrong language goes out as it is: the user
    gets an answer, never a loop."""
    answers = Answers(GERMAN_ANSWER, GERMAN_ANSWER, ENGLISH_ANSWER)
    result = await build_agent(answers.model).run(
        ENGLISH_QUESTION, deps=_deps(ENGLISH_QUESTION)
    )
    assert result.output == GERMAN_ANSWER
    assert len(answers.sent) == 2
    assert answers.retries() == [answer_in_language("en", "de")]


async def test_the_language_retry_counts_with_the_retries_for_text() -> None:
    """After the retries for an answer without text, none is left for the
    language: the answer goes out."""
    blank = [" "] * TOOL_RETRIES
    answers = Answers(*blank, GERMAN_ANSWER, ENGLISH_ANSWER)
    result = await build_agent(answers.model).run(
        ENGLISH_QUESTION, deps=_deps(ENGLISH_QUESTION)
    )
    assert result.output == GERMAN_ANSWER
    assert answers.retries() == [NO_ANSWER_TEXT] * TOOL_RETRIES


async def test_no_retry_when_another_answer_step_does_not_fit() -> None:
    """The retry is one more call of the whole context after an answer the
    user has seen: near the run's token limit it would end the run at that
    limit, so the answer goes out."""
    answers = Answers(GERMAN_ANSWER, ENGLISH_ANSWER)
    deps = _deps(ENGLISH_QUESTION)
    deps.budget = RunBudget(max_tokens=1, max_tool_calls=30)
    result = await build_agent(answers.model).run(ENGLISH_QUESTION, deps=deps)
    assert result.output == GERMAN_ANSWER
    assert answers.retries() == []


async def test_a_german_answer_in_a_list_is_asked_for_again() -> None:
    """The text after a title's colon is prose and counts."""
    listed = (
        "- Radwege: Der Layer hat 16 Radwege, und die meisten sind Schutzstreifen.\n"
        "- Lücken: Für die übrigen ist keine Art eingetragen."
    )
    answers = Answers(listed, ENGLISH_ANSWER)
    result = await build_agent(answers.model).run(
        ENGLISH_QUESTION, deps=_deps(ENGLISH_QUESTION)
    )
    assert result.output == ENGLISH_ANSWER
    assert answers.retries() == [answer_in_language("en", "de")]


async def test_an_answer_in_the_message_language_is_not_asked_for_again() -> None:
    answers = Answers(ENGLISH_ANSWER, GERMAN_ANSWER)
    result = await build_agent(answers.model).run(
        ENGLISH_QUESTION, deps=_deps(ENGLISH_QUESTION)
    )
    assert result.output == ENGLISH_ANSWER
    assert answers.retries() == []


@pytest.mark.parametrize(
    ("message", "answer", "card"),
    [
        # Under three words the interface language decides (prompt.py), also
        # for words that show one.
        ("Radwege Leipzig", ENGLISH_ANSWER, ""),
        ("How many?", GERMAN_ANSWER, ""),
        # A card's answer: the text is the picked options' labels, which can
        # read as a sentence.
        (
            "Which data: the supermarkets and the schools of the city",
            GERMAN_ANSWER,
            "Data: the supermarkets and the schools of the city (value both)",
        ),
        # A message that asks for the other language, or to translate.
        ("Write a German description of this layer", GERMAN_ANSWER, ""),
        ("Can you translate the layer's description for me?", GERMAN_ANSWER, ""),
        ("Beschreibe diesen Layer bitte auf Englisch.", ENGLISH_ANSWER, ""),
        # A message that shows no clear language.
        ("15 minute workflow in Munich", GERMAN_ANSWER, ""),
        ("Show me Zählstellen für den Radverkehr", GERMAN_ANSWER, ""),
        # Answers of names, numbers, code and dataset titles.
        (ENGLISH_QUESTION, "Radwege: 16 (Schutzstreifen 9, Radfahrstreifen 7).", ""),
        (
            ENGLISH_QUESTION,
            "**Radwege der Stadt Leipzig** und **Zählstellen für den Radverkehr**",
            "",
        ),
        (
            ENGLISH_QUESTION,
            "I found these:\n\n| Name | Art |\n|---|---|\n| Weg an der Elster "
            "und der Pleiße | für den Radverkehr |\n| Weg an den Teichen | für die "
            "Schule |",
            "",
        ),
        (
            ENGLISH_QUESTION,
            "```sql\nSELECT * FROM radwege WHERE art = 'für die Schule und den "
            "Weg' AND der = 1\n```",
            "",
        ),
        # German titles listed in an English answer: a title is no prose.
        (
            ENGLISH_QUESTION,
            "I found three datasets:\n- Zählstellen für den Radverkehr\n- Radwege "
            "der Stadt und des Landkreises\n- Fahrradständer an den Haltestellen "
            "der Linie 4\n1. Bäume an der Straße und auf den Plätzen",
            "",
        ),
    ],
)
async def test_a_doubtful_case_is_not_asked_for_again(
    message: str, answer: str, card: str
) -> None:
    answers = Answers(answer, "Not asked.")
    result = await build_agent(answers.model).run(message, deps=_deps(message, card))
    assert result.output == answer
    assert answers.retries() == []


def test_no_eval_prompt_reads_as_the_other_language() -> None:
    """Every prompt of the eval set whose answer is graded on its language
    reads as that language or as none, never as the other one."""
    for task in load_tasks():
        for check in task.checks:
            if isinstance(check, LanguageCheck):
                assert clear_language(task.prompt, 2) in (check.expected, None), task.id


async def test_the_run_manager_hands_the_message_to_the_check(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The production path: RunManager gives the validation the user's
    message, and the answer it asked for again replaces the first one: the
    stream names the replaced text part, the stored message keeps it marked
    and the reloaded one leaves it out, and the next turn's model history
    holds only the answer that replaced it."""
    answers = Answers(GERMAN_ANSWER, ENGLISH_ANSWER)
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(answers.model),
    )
    conversation = await repo.create_conversation(USER, "catalog", None, None)
    conversation_id = UUID(str(conversation["id"]))
    run_id, message_id = await manager.start_run(
        conversation_id, USER, ENGLISH_QUESTION, None
    )
    await manager.wait(run_id)
    assert answers.retries() == [answer_in_language("en", "de")]

    events = [event for _, event in await repo.list_events(run_id)]
    started = [event.part_id for event in events if isinstance(event, TextStarted)]
    [replaced] = [event for event in events if isinstance(event, TextReplaced)]
    assert replaced.part_ids == started[:1]
    assert events.index(replaced) < events.index(
        next(
            e for e in events if isinstance(e, TextStarted) and e.part_id == started[1]
        )
    )

    [stored] = [
        message
        for message in await repo.list_messages(
            conversation_id, exclude_message_id=None
        )
        if message["id"] == message_id
    ]
    texts = [part for part in stored["parts"] if part["type"] == "text"]
    assert [(part["text"], part.get("replaced")) for part in texts] == [
        (GERMAN_ANSWER, True),
        (ENGLISH_ANSWER, None),
    ]
    shown = to_ui_message(str(message_id), "assistant", stored["parts"])["parts"]
    assert [part["text"] for part in shown if part["type"] == "text"] == [
        ENGLISH_ANSWER
    ]

    history = json.dumps(await repo.history(conversation_id), ensure_ascii=False)
    assert ENGLISH_ANSWER in history
    assert GERMAN_ANSWER not in history
    assert answer_in_language("en", "de") not in history
