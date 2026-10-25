"""The card the assistant asks the user with, ``ask_user`` (spec §5).

A card holds up to four questions the user answers together; the dock adds a
free-text field to each. An option may carry a ``value`` the asking side
attaches (a layer_project_id, a catalog id, a template id) and ``adds``, the
datasets picking it authorises. Both stay on the server: the stream and the
stored transcript the web reads leave them out (``public_args``), and the model
gets the value back with the user's answer (``answer_lines``). ``user_chose``
and ``picked_ids`` read the stored history, never the model's words; only
``picked_ids`` reads ``adds``, so an option's ``adds`` never stands for a value
such as a workflow run's.
"""

import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)

from assistant.context import RECORD_ID_PATTERN

#: The tool's wire name.
ASK_TOOL = "ask_user"
#: A card's id is this prefix and an id ``ask_user`` mints for the card
#: (``assistant.tools.ask``).
CARD_PREFIX = "ask-"
CARD_ID_PATTERN = r"^ask-[A-Za-z0-9_.:-]{1,200}$"
MAX_QUESTIONS = 4
MAX_OPTIONS = 4
MAX_HEADER_CHARS = 12
#: Left off the end of a shortened header.
_HEADER_TRAILING = " ,;:/-"
#: Validation context key of a card read back from the stored history
#: (``AskHistory.from_stored``): the label rule is for new cards, so a card
#: shown before it stays answerable.
_STORED_CARD = "stored_card"
MAX_OTHER_CHARS = 500
MAX_ADDS = 25
#: The prefix of a value that stands for a workflow run
#: (``assistant.workflows.runs.RUN_VALUE``); never one of ``adds``.
RUN_PREFIX = "run:"
_RECORD_ID = re.compile(RECORD_ID_PATTERN)
#: Labels of the free-text option the card adds by itself.
_OTHER_LABELS = frozenset(
    {
        "other",
        "others",
        "something else",
        "andere",
        "anderes",
        "sonstiges",
        "etwas anderes",
    }
)


class AskOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=60, description="One to five words.")
    description: str = Field(
        default="", max_length=200, description="What choosing it means."
    )
    recommended: bool = Field(
        default=False, description="At most one per question; it is shown first."
    )
    value: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description=(
            "What the choice stands for, never shown to the user: a "
            "layer_project_id, a catalog id or a template id. It comes back with "
            "the answer. When the option adds datasets, their ids go in adds and "
            "value may be any short key."
        ),
    )
    adds: list[str] = Field(
        default_factory=list,
        max_length=MAX_ADDS,
        description=(
            "The datasets choosing it adds: catalog ids or ids of the user's own "
            "datasets, as the add tools take them. Never shown to the user."
        ),
    )

    @field_validator("label")
    @classmethod
    def _not_other(cls, label: str) -> str:
        if label.strip().rstrip(".…").casefold() in _OTHER_LABELS:
            raise ValueError("the card adds a free-text 'Other' itself; leave it out")
        return label

    @field_validator("adds")
    @classmethod
    def _dataset_ids(cls, adds: list[str]) -> list[str]:
        for item in adds:
            # A dot segment fits the pattern, but in a lookup's path it would
            # name another route.
            if not _RECORD_ID.fullmatch(item) or item in (".", ".."):
                raise ValueError(f"{item!r} is not a dataset id")
            if item.startswith(RUN_PREFIX):
                raise ValueError("adds names datasets, never a workflow run")
        return adds


class AskQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(
        min_length=1, max_length=300, description="A full sentence ending in '?'."
    )
    header: str = Field(
        min_length=1,
        max_length=MAX_HEADER_CHARS,
        description="A short chip naming the question, at most 12 characters, e.g. 'Schools'.",
    )
    options: list[AskOption] = Field(min_length=2, max_length=MAX_OPTIONS)
    multi_select: bool = Field(
        default=False, description="True when the user may pick several options."
    )

    @field_validator("header", mode="before")
    @classmethod
    def _short_header(cls, header: Any) -> Any:
        """A longer chip is cut at the last word end that fits, else at the
        limit; anything else is left for the field's own checks."""
        if not isinstance(header, str) or len(header) <= MAX_HEADER_CHARS:
            return header
        space = header.rfind(" ", 0, MAX_HEADER_CHARS + 1)
        words = header[:space].rstrip(_HEADER_TRAILING) if space > 0 else ""
        return words or header[:MAX_HEADER_CHARS]

    @field_validator("question")
    @classmethod
    def _is_a_question(cls, question: str) -> str:
        if not question.strip().endswith("?"):
            raise ValueError("a question ends in '?'")
        return question

    @model_validator(mode="after")
    def _recommended_first(self, info: ValidationInfo) -> "AskQuestion":
        labels = [option.label.strip().casefold() for option in self.options]
        if not (info.context or {}).get(_STORED_CARD) and (
            len(set(labels)) != len(labels)
            or any(
                sum(ch.isalnum() for ch in option.label) < 2 for option in self.options
            )
        ):
            raise ValueError(
                "options need distinct labels of at least two letters, no placeholders"
            )
        recommended = [option for option in self.options if option.recommended]
        if len(recommended) > 1:
            raise ValueError("at most one option of a question is recommended")
        if recommended:
            # The card shows it first, and an answer counts options in this
            # order, whichever order the model wrote them in.
            rest = [option for option in self.options if not option.recommended]
            self.options = [recommended[0], *rest]
        return self


class AskUserInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    questions: list[AskQuestion] = Field(
        min_length=1,
        max_length=MAX_QUESTIONS,
        description="Up to four questions, answered together, in this order.",
    )


def card_data(card_id: str, card: AskUserInput) -> dict[str, Any]:
    """The ``data-ask`` part the dock renders: the card without its values and
    the ids its options add."""
    return {
        "card_id": card_id,
        "questions": [
            {
                "question": question.question,
                "header": question.header,
                "multi_select": question.multi_select,
                "options": [
                    {
                        "label": option.label,
                        "description": option.description,
                        "recommended": option.recommended,
                    }
                    for option in question.options
                ],
            }
            for question in card.questions
        ],
    }


def public_args(tool_name: str, args: Mapping[str, Any]) -> dict[str, Any]:
    """A tool call's arguments as the web may see them: the option values and
    ``adds`` of an ``ask_user`` card stay on the server."""
    if tool_name != ASK_TOOL:
        return dict(args)
    # Rebuilt from the keys and shapes of a card, not filtered: anything else
    # may hold values (malformed or cut-off JSON arrives as the model's raw
    # text, ``INVALID_JSON``; a question or an option may come as a JSON string,
    # a key may be misspelled or the model's own, a label an object), so none
    # of it is shown.
    questions = args.get("questions")
    if not isinstance(questions, list):
        return {}
    return {
        "questions": [
            _public_question(question)
            for question in questions
            if isinstance(question, dict)
        ]
    }


#: The keys of a card the web may see; an option's ``value`` and ``adds`` are
#: not among them.
_QUESTION_KEYS = frozenset({"question", "header", "multi_select"})
_OPTION_KEYS = frozenset({"label", "description", "recommended"})


def _is_plain(value: Any) -> bool:
    return value is None or isinstance(value, (str, bool, int, float))


def _public_question(question: Mapping[str, Any]) -> dict[str, Any]:
    public: dict[str, Any] = {}
    for key, value in question.items():
        if key == "options":
            if isinstance(value, list):
                public[key] = [
                    _public_option(option)
                    for option in value
                    if isinstance(option, dict)
                ]
        elif key in _QUESTION_KEYS and _is_plain(value):
            public[key] = value
    return public


def _public_option(option: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in option.items()
        if key in _OPTION_KEYS and _is_plain(value)
    }


class QuestionAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: int = Field(ge=0, lt=MAX_QUESTIONS)
    #: Option indexes, in the card's order (the recommended option first).
    options: list[int] = Field(default_factory=list, max_length=MAX_OPTIONS)
    other: str | None = Field(default=None, max_length=MAX_OTHER_CHARS)

    @field_validator("options")
    @classmethod
    def _distinct_indexes(cls, options: list[int]) -> list[int]:
        if any(index < 0 or index >= MAX_OPTIONS for index in options):
            raise ValueError(f"option indexes are 0 to {MAX_OPTIONS - 1}")
        if len(set(options)) != len(options):
            raise ValueError("an option is picked once")
        return options


class CardAnswer(BaseModel):
    """The user's answer to a card: ``RunMessage.answer`` (contract)."""

    model_config = ConfigDict(extra="forbid")

    card_id: str = Field(pattern=CARD_ID_PATTERN)
    #: One entry per question of the card, in order.
    answers: list[QuestionAnswer] = Field(max_length=MAX_QUESTIONS)


def answer_problem(card: AskUserInput, answer: CardAnswer) -> str | None:
    """Why ``answer`` does not fit ``card``, or None when it does."""
    if [reply.question for reply in answer.answers] != list(range(len(card.questions))):
        return "the answer has one entry per question of the card, in order"
    for reply, question in zip(answer.answers, card.questions, strict=True):
        if any(index >= len(question.options) for index in reply.options):
            return f"question {reply.question} has no such option"
        if len(reply.options) > 1 and not question.multi_select:
            return f"question {reply.question} takes one option"
    return None


def _picked(option: AskOption) -> str:
    return f"{option.label} (value {option.value})" if option.value else option.label


def answer_lines(card: AskUserInput, answer: CardAnswer) -> str:
    """One line per answered question, as the model reads it:
    ``<header>: <label> (value <value>), …`` and ``other: <text>``. The free
    text is kept on its line; a question without options or text is left out.
    ``answer`` must fit ``card`` (``answer_problem``)."""
    lines: list[str] = []
    for reply in answer.answers:
        question = card.questions[reply.question]
        picks = [_picked(question.options[index]) for index in reply.options]
        other = " ".join((reply.other or "").split())
        if other:
            picks.append(f"other: {other}")
        if picks:
            lines.append(f"{question.header}: {', '.join(picks)}")
    return "\n".join(lines)


@dataclass(frozen=True)
class AskHistory:
    """The cards asked in a conversation and the answers given to them, both
    by card id."""

    cards: Mapping[str, AskUserInput] = field(default_factory=dict)
    answers: Mapping[str, CardAnswer] = field(default_factory=dict)

    @classmethod
    def from_stored(cls, messages: Sequence[Mapping[str, Any]]) -> "AskHistory":
        """From ``Repository.list_messages`` rows: an assistant message's
        ``ask_user`` tool part whose call returned is a card, under the card id
        in its output (its stored arguments keep the values); a user message's
        ``answer`` part is an answer. A part that does not validate is skipped;
        of two answers to one card the first counts. A card id is minted per
        card, so two cards never share one; one that two parts carried would
        not say which card an answer was given to, and names no card."""
        cards: dict[str, AskUserInput] = {}
        answers: dict[str, CardAnswer] = {}
        shown: set[str] = set()
        shared: set[str] = set()
        for message in messages:
            role = message.get("role")
            for part in message.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                if (
                    role == "assistant"
                    and part.get("type") == "tool"
                    and part.get("tool_name") == ASK_TOOL
                    and part.get("state") == "output"
                ):
                    output = part.get("output")
                    card_id = (
                        output.get("card_id") if isinstance(output, dict) else None
                    )
                    if not isinstance(card_id, str):
                        continue
                    if card_id in shown:
                        shared.add(card_id)
                    shown.add(card_id)
                    try:
                        card = AskUserInput.model_validate(
                            part.get("args") or {}, context={_STORED_CARD: True}
                        )
                    except ValidationError:
                        continue
                    cards[card_id] = card
                elif role == "user" and part.get("type") == "answer":
                    try:
                        answer = CardAnswer.model_validate(part.get("answer") or {})
                    except ValidationError:
                        continue
                    answers.setdefault(answer.card_id, answer)
        return cls(
            cards={key: card for key, card in cards.items() if key not in shared},
            answers=answers,
        )

    def with_answer(self, answer: CardAnswer) -> "AskHistory":
        return AskHistory(
            cards=self.cards, answers={**self.answers, answer.card_id: answer}
        )


def _picked_options(history: AskHistory) -> Iterator[tuple[str, AskOption]]:
    """The options the user picked in the answered cards of this conversation,
    each with its card id, in the order the cards were answered. A typed reply
    is no pick: it is text."""
    for card_id, answer in history.answers.items():
        card = history.cards.get(card_id)
        if card is None:
            continue
        for reply in answer.answers:
            if reply.question >= len(card.questions):
                continue
            options = card.questions[reply.question].options
            for index in reply.options:
                if index < len(options):
                    yield card_id, options[index]


def chosen_cards(history: AskHistory, value: str) -> list[str]:
    """The answered cards of this conversation that offered an option with
    ``value`` and where the user picked it, by card id, in the order they were
    answered. Reads an option's ``value`` only, never its ``adds``."""
    found: list[str] = []
    for card_id, option in _picked_options(history):
        if option.value == value and card_id not in found:
            found.append(card_id)
    return found


def user_chose(history: AskHistory, value: str) -> bool:
    """Whether an answered card of this conversation offered an option with
    ``value`` and the user picked it."""
    return bool(chosen_cards(history, value))


def recent_picked_ids(history: AskHistory) -> list[str]:
    """Every id the user picked in an answered card of this conversation, each
    once, the newest pick first: a picked option's ``value`` and each of its
    ``adds``."""
    picks = list(_picked_options(history))
    ids = (
        item
        for _, option in reversed(picks)
        for item in (option.value, *option.adds)
        if item
    )
    return list(dict.fromkeys(ids))


def picked_ids(history: AskHistory) -> set[str]:
    """Every id the user picked in an answered card of this conversation: a
    picked option's ``value`` and each of its ``adds``."""
    return set(recent_picked_ids(history))
