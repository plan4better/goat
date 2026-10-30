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
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any
from uuid import UUID

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
#: Generic option labels in English or German, matched whole on the label
#: in lower case: a noun such as "Option" with a number of one or two digits
#: (a year names a scenario), a letter or a numeral, an ordinal with such a
#: noun, or a placeholder word. A label that only contains one of the words
#: ("Variante mit Fahrrad") names a choice.
_PLACEHOLDER_NOUN = r"(?:option|variante|auswahl|choice|alternative|möglichkeit|test)"
_PLACEHOLDER_NUMBER = (
    r"(?:\d{1,2}|[a-z]|ii|iii|iv|eins|zwei|drei|vier|one|two|three|four)"
)
_PLACEHOLDER_LABEL = re.compile(
    rf"{_PLACEHOLDER_NOUN} ?#?\(?{_PLACEHOLDER_NUMBER}\)?"
    r"|(?:erste|zweite|dritte|vierte|first|second|third|fourth|[1-4]\.)[rsn]?"
    rf" {_PLACEHOLDER_NOUN}"
    r"|placeholder|platzhalter|test|dummy"
)
#: Kept off the end of a label, header or question before the rules above.
_TRAILING_MARKS = " .…:!?"
LABEL_RULE = (
    "options need distinct labels of at least two letters that name the choice, "
    "no placeholders such as 'Option 1' or 'Test'"
)
TEST_CARD_RULE = "no test cards: the header and the question say what the user chooses"


def _plain(text: str) -> str:
    """``text`` in lower case, with single spaces and no closing marks."""
    return " ".join(text.split()).rstrip(_TRAILING_MARKS).casefold()


def _placeholder(label: str) -> bool:
    return (
        sum(ch.isalnum() for ch in label) < 2
        or _PLACEHOLDER_LABEL.fullmatch(_plain(label)) is not None
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
        if not (info.context or {}).get(_STORED_CARD):
            if "test" in (_plain(self.header), _plain(self.question)):
                raise ValueError(TEST_CARD_RULE)
            labels = [option.label.strip().casefold() for option in self.options]
            if len(set(labels)) != len(labels) or any(
                _placeholder(option.label) for option in self.options
            ):
                raise ValueError(LABEL_RULE)
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
    #: The card whose answer came with the message being answered
    #: (``with_answer``); None when it came with none. The stored history
    #: never sets it: an answer read back belongs to an earlier message.
    answering: str | None = None
    #: The cards answered since the user's last typed message, the answer
    #: that came with the message being answered among them: the chain of
    #: picks that answers one request (``repeated_question``). None: every
    #: answered card, for a history not read from a conversation.
    chain: frozenset[str] | None = None

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
        chain: set[str] = set()
        for message in messages:
            role = message.get("role")
            parts = message.get("parts") or []
            if role == "user" and not any(
                isinstance(part, dict) and part.get("type") == "answer"
                for part in parts
            ):
                # A typed message starts a new chain of picks.
                chain = set()
            for part in parts:
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
                    chain.add(answer.card_id)
        return cls(
            cards={key: card for key, card in cards.items() if key not in shared},
            answers=answers,
            chain=frozenset(chain),
        )

    def with_answer(self, answer: CardAnswer) -> "AskHistory":
        """With ``answer``, the answer that came with the message being
        answered."""
        return AskHistory(
            cards=self.cards,
            answers={**self.answers, answer.card_id: answer},
            answering=answer.card_id,
            chain=None if self.chain is None else self.chain | {answer.card_id},
        )

    def with_typed_message(self) -> "AskHistory":
        """As it stands when the message being answered was typed, with no
        card answer: a new chain of picks starts."""
        return replace(self, answering=None, chain=frozenset())


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


@dataclass(frozen=True)
class _Answered:
    """A question of an answered card, with what the user gave for it."""

    card_id: str
    question: AskQuestion
    #: The options picked that count (``_answers``), in the card's order.
    picks: list[AskOption]
    #: The free text written for it, on one line; empty when none.
    other: str


def _offers_run(question: AskQuestion) -> bool:
    """Whether ``question`` offers a workflow run (``RUN_PREFIX``)."""
    return any(
        (option.value or "").startswith(RUN_PREFIX) for option in question.options
    )


def _answers(history: AskHistory, used_cards: Collection[str]) -> Iterator[_Answered]:
    """The questions of the answered cards of this conversation, each with
    what the user picked and wrote for it, in the order the cards were
    answered. A question that offers a workflow run (``RUN_PREFIX``) is left
    out, the decline as well as the run, and so is every question of a card
    whose run pick was used (``used_cards``): a run needs a new pick each
    time, another workflow one of its own, and a user who declined may want
    it run after all. A pick with neither ``value`` nor ``adds`` beside
    options that add datasets ("Leave it open") does not count: it chose no
    data, and the next dataset card offers it again."""
    for card_id, answer in history.answers.items():
        card = history.cards.get(card_id)
        if card is None or card_id in used_cards:
            continue
        for reply in answer.answers:
            if reply.question >= len(card.questions):
                continue
            question = card.questions[reply.question]
            if _offers_run(question):
                continue
            adds_data = any(option.adds for option in question.options)
            picks = [
                question.options[index]
                for index in reply.options
                if index < len(question.options)
            ]
            yield _Answered(
                card_id=card_id,
                question=question,
                picks=[
                    option
                    for option in picks
                    if not (adds_data and option.value is None and not option.adds)
                ],
                other=" ".join((reply.other or "").split()),
            )


def _offers_again(option: AskOption, picked: AskOption) -> bool:
    """Whether ``option`` is the option ``picked``: the same label (case and
    spaces aside), the same value, or the same datasets added."""
    return (
        _plain(option.label) == _plain(picked.label)
        or (option.value is not None and option.value == picked.value)
        or (bool(option.adds) and set(option.adds) == set(picked.adds))
    )


#: The refusal of a card that asks again what the user answered
#: (``repeated_question``).
ASKED_AGAIN = (
    'The user already answered "{question}" ({header}): they {answer}. Use that '
    "answer. If it did not work or left something open, say so in your text and "
    "ask only what is still open, under a new header that names it."
)


def _asked_again(earlier: _Answered) -> str:
    """The refusal naming ``earlier``'s answer: its picks with their values,
    and the text written for it."""
    given: list[str] = []
    if earlier.picks:
        picked = ", ".join(
            f'"{option.label}"' + (f" (value {option.value})" if option.value else "")
            for option in earlier.picks
        )
        given.append(f"chose {picked}")
    if earlier.other:
        given.append(f'wrote "{earlier.other}"')
    return ASKED_AGAIN.format(
        question=earlier.question.question,
        header=earlier.question.header,
        answer=" and ".join(given),
    )


def repeated_question(
    history: AskHistory, card: AskUserInput, used_cards: Collection[str] = ()
) -> str | None:
    """Why ``card`` asks again what the user answered in this conversation,
    naming the answer, or None when it does not. A header names a topic
    within the chain of picks that answers one request
    (``AskHistory.chain``): a question under the header of a question the
    user picked an option for or wrote an answer to in that chain (case and
    spaces aside) asks that topic again whatever it offers, and the newest
    such answer is named. After a typed message, a common header ("Period")
    may name another topic. A question with the words of an answered one,
    in any earlier card of the conversation, asks it again when it offers
    the option picked there again. A question the user left open, in a card
    they answered or one they replied to in their message instead, may be
    asked again, and so may a question that offers a workflow run.
    ``used_cards``: as ``_answers``."""
    answered = [
        earlier
        for earlier in _answers(history, used_cards)
        if earlier.picks or earlier.other
    ]
    chained = [
        earlier
        for earlier in answered
        if history.chain is None or earlier.card_id in history.chain
    ]
    for question in card.questions:
        if _offers_run(question):
            continue
        header = [
            earlier
            for earlier in chained
            if _plain(earlier.question.header) == _plain(question.header)
        ]
        if header:
            return _asked_again(header[-1])
        for earlier in answered:
            if _plain(earlier.question.question) == _plain(question.question) and any(
                _offers_again(option, picked)
                for option in question.options
                for picked in earlier.picks
            ):
                return _asked_again(earlier)
    return None


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


def answered_pick(history: AskHistory) -> AskHistory:
    """``history`` with only the answer that came with the message being
    answered (``AskHistory.answering``): what the tools that act on a pick
    may read for the pick that started this answer. No answer when the
    message came without one."""
    answer = history.answers.get(history.answering) if history.answering else None
    return replace(
        history, answers={answer.card_id: answer} if answer is not None else {}
    )


def answered_adds(history: AskHistory) -> list[str]:
    """The datasets the options picked in the card answer that came with the
    message being answered add (``AskHistory.answering``), each once; none
    when the message came without one."""
    return list(
        dict.fromkeys(
            item
            for card_id, option in _picked_options(history)
            if card_id == history.answering
            for item in option.adds
        )
    )


# -- an option that names a dataset without adding it ------------------------------

#: A word of a label or a title: letters and digits, cut at anything else
#: (spaces, dashes, punctuation, underscores).
_WORD = re.compile(r"[^\W_]+")
#: Where a title splits into parts that can be named on their own: a dash
#: or a bar between spaces, a colon before one, and brackets.
_TITLE_PART = re.compile(r"\s[-–—|]\s|:\s|[()\[\]]")
#: Words that name nothing on their own (German and English).
_FILLER = frozenset(
    "der die das den dem des ein eine einer eines einem einen und oder von vom "
    "zu zur zum im in am an auf aus bei mit für je pro nach über sowie als "
    "the of for and or on at to by with a an from per".split()
)
#: Words of a label that leave something out or for later: such an option
#: names a dataset it does not use.
_LEAVES_OUT = frozenset(
    "ohne kein keine keinen keiner nicht weglassen auslassen statt anstatt "
    "später offen without no not skip omit instead later open".split()
)


def _words(text: str) -> set[str]:
    """The words of ``text`` that name something, in lower case, a long
    word without a final n or s, so a plural or a genitive matches."""
    words = _WORD.findall(text.casefold())
    return {
        word[:-1] if len(word) > 5 and word[-1] in "ns" else word
        for word in words
        if word not in _FILLER
    }


def _naming(word: str) -> bool:
    """A word that names a part of a title on its own: four letters or more,
    or a number."""
    return len(word) >= 4 or any(ch.isdigit() for ch in word)


def label_names(label: str, title: str) -> bool:
    """Whether an option's ``label`` names the dataset called ``title``,
    counted narrowly, so an ordinary choice ("Bezirke", "ÖV-Güteklassen")
    beside a dataset of such words is not one: the label holds the whole
    title (two words or more, one of five letters or more), or a part of it
    of two words or more that each name something (``_naming``), or the label
    is three words or more, all of the title's, one of them longer than five
    letters: a list of short words ("Bus, Bahn, Fähre") is a choice of its
    own. A label that leaves data out names none."""
    plain = _WORD.findall(label.casefold())
    if _LEAVES_OUT & set(plain):
        return False
    words = _words(label)
    whole = _words(title)
    if len(whole) >= 2 and any(len(word) >= 5 for word in whole) and whole <= words:
        return True
    for part in _TITLE_PART.split(title):
        named = _words(part)
        if len(named) >= 2 and all(_naming(word) for word in named) and named <= words:
            return True
    return len(words) >= 3 and words <= whole and any(len(word) > 5 for word in plain)


#: Datasets an option's refusal names at most.
_NAMED_DATASETS = 3


def _stands_for_data(option: AskOption, found: Mapping[str, str]) -> bool:
    """Whether a pick of ``option`` lets the add tools add data: it adds
    some, or its value is a dataset's id (one the answer found, or a UUID of
    the user's own) or a layer_project_id of the open project."""
    value = option.value or ""
    if option.adds or value.isdigit() or value in found:
        return True
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def unadded_dataset(card: AskUserInput, found: Mapping[str, str]) -> str | None:
    """Why ``card`` cannot be shown: an option's label names a catalog
    dataset the answer found (``found``: titles by id, ``label_names``)
    while a pick of it lets no tool add one (``_stands_for_data``). The pick
    would leave the next answer without the user's consent to add it, and a
    second card that only asks to add it. A question that offers a workflow
    run is left out: its options say what the run uses, which the project
    holds already. None when no option does."""
    for question in card.questions:
        if _offers_run(question):
            continue
        for option in question.options:
            if _stands_for_data(option, found):
                continue
            named = [
                (item, title)
                for item, title in found.items()
                if label_names(option.label, title)
            ]
            if not named:
                continue
            listed = ", ".join(
                f'"{title}" (id {item})' for item, title in named[:_NAMED_DATASETS]
            )
            if len(named) > _NAMED_DATASETS:
                listed += f" and {len(named) - _NAMED_DATASETS} more"
            kind = "dataset" if len(named) == 1 else "datasets"
            return (
                f'The option "{option.label}" names the catalog {kind} {listed}, '
                "but adds nothing, so picking it would not let you add the "
                "dataset. Put the id of the dataset it uses in its adds; for a "
                "layer already in the project, its layer_project_id is the "
                "value instead."
            )
    return None
