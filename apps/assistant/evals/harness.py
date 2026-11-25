"""Runs one eval task with a model: the production agent, prompt, tool layer
and limits, against the fixed backends, and records what happened.

Every message of a task is answered as the run manager answers it
(``assistant.runs.manager``): the conversation is kept as the app stores it,
the rows of its messages (``Repository.list_messages``: the user's text, page
and card answer, and the answer's parts folded from its events) and the
answers' model messages (``Repository.history``, as JSON). Each run reads its
cards, writes, workflow runs, typed texts and loaded skills from those rows
with the app's own functions, and the agent gets the model messages back as
the app reloads them, so its history processing shortens earlier answers as
in the app (``assistant.history``). A task of several messages
(``conversation``) answers them in turn, each in a turn of its own.

A message with ``answer_card`` runs a second time when its answer showed a
card: the eval user answers it (``auto_answer``) and the run gets the answer
the way the app renders it (``assistant.asks.answer_lines``). A task with
``undo`` has the eval user press Undo under the last answer, as the dock does
(``assistant.undo``), over the audit rows the answer's calls left. A task on
the map project (``map_states``) records the project as core held it before
each turn, when a card was answered, after each turn and after the Undo."""

import asyncio
import json
import time
from collections.abc import AsyncGenerator, AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
from pydantic import ValidationError
from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    UserPromptPart,
)
from pydantic_ai.models import (
    Model,
    ModelRequestParameters,
    StreamedResponse,
)
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import RequestUsage, RunUsage
from pydantic_core import to_jsonable_python

from assistant.agent import PartIds, RunDeps, build_agent
from assistant.asks import (
    ASK_TOOL,
    AskHistory,
    AskUserInput,
    CardAnswer,
    QuestionAnswer,
    answer_lines,
    typed_texts,
)
from assistant.budget import RunBudget
from assistant.clock import AnswerClock
from assistant.config import AssistantSettings
from assistant.context import PageContext, dump_context, parse_context
from assistant.events import DataPart, RunEvent, fold_parts
from assistant.login import StaticLogin
from assistant.prompt import render_note, with_note
from assistant.repo import Repository
from assistant.runs.translate import EventTranslator
from assistant.runs.turn import run_turn
from assistant.tools.runtime import ToolEnv, client_secrets
from assistant.tools.skills import loaded_skills
from assistant.tools.toolset import (
    ANSWER_STEP_REFUSALS,
    LOOK_UPS_USED_UP,
    RESULT_TOO_LARGE,
    STAGE_REFUSALS,
    earlier_writes,
)
from assistant.undo import NothingToUndo, UndoRefused, UndoUnderWay, undo_run
from assistant.workflows.runs import ConversationRuns
from evals.backends import Backends
from evals.map_backends import MapState
from evals.map_fixture import MAP_PROJECT_ID, MAP_VIEW_PROJECT_ID
from evals.tasks import EvalTask, Message

#: The eval user; the fixed backends answer for anyone.
EVAL_USER = UUID(int=0xE7A1)


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]
    result: Any
    failed: bool


#: The failures of a call refused because the answer had no room left for it
#: (``assistant.tools.toolset``): by the stage of its step, with its look-ups
#: used up, or with a result too large for what was left.
ROOM_REFUSALS: tuple[str, ...] = (
    *STAGE_REFUSALS.values(),
    *ANSWER_STEP_REFUSALS.values(),
    LOOK_UPS_USED_UP,
    RESULT_TOO_LARGE,
)


def refused_for_room(calls: Iterable[ToolCall]) -> list[str]:
    """The tools of the calls refused because the answer had no room left
    for them, in order, one entry per call."""
    refused = []
    for call in calls:
        if not call.failed:
            continue
        text = (
            call.result
            if isinstance(call.result, str)
            else json.dumps(call.result, ensure_ascii=False, default=str)
        )
        if any(refusal in text for refusal in ROOM_REFUSALS):
            refused.append(call.name)
    return refused


@dataclass
class TurnReport:
    """One message of the eval user and its answer, with the answer after a
    card the eval user answered in it."""

    #: What the eval user typed.
    prompt: str
    #: What the dock showed of the turn's last answer.
    answer: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    #: Tokens of the turn's runs, as the budget counted them: the cache
    #: reads are those the model reported, none for a request the task
    #: makes cold (``ColdCacheDouble``).
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    #: Model requests of the turn's runs.
    requests: int = 0
    #: Runs of the turn: two when the eval user answered a card.
    runs: int = 0
    #: The map project before the turn, when the eval user answered a card
    #: (before the answer), and after the turn (``MapState.snapshot``).
    map_before: dict[str, Any] | None = None
    map_before_answer: dict[str, Any] | None = None
    map_after: dict[str, Any] | None = None

    @property
    def refused_for_room(self) -> list[str]:
        return refused_for_room(self.tool_calls)


@dataclass
class Transcript:
    task_id: str
    answer: str
    tool_calls: list[ToolCall]
    proposals: list[dict[str, Any]]
    requests: dict[str, list[httpx.Request]] = field(repr=False)
    error: str | None
    input_tokens: int
    output_tokens: int
    seconds: float
    first_text_seconds: float | None
    #: Of ``input_tokens``, read from the provider's prompt cache.
    cache_read_tokens: int = 0
    #: The workflows core saved during the run, as it stored them.
    saved: list[dict[str, Any]] = field(default_factory=list)
    #: The providers that answered the model calls, with how many each, and
    #: what they billed, where a gateway such as OpenRouter reports them.
    providers: dict[str, int] = field(default_factory=dict)
    cost: float | None = None
    #: Model responses of reasoning only (no text, no tool call), and the times
    #: the agent asked the model again: each costs a model call and time
    #: without failing the task.
    reasoning_only: int = 0
    retries: int = 0
    #: How the eval user's Undo went (a task with ``undo``): "undone",
    #: "changed_since", "not_restored" (something did not come back: a style
    #: core stored nothing of, a removed layer, an added group in use, a
    #: change of the map core refused),
    #: "nothing_to_undo" or the code of a refusal.
    undo: str | None = None
    #: The map project as core held it (``MapState.snapshot``) before the
    #: run, when the eval user answered a card (before the answer), after
    #: the run, and after the eval user's Undo.
    map_before: dict[str, Any] | None = None
    map_before_answer: dict[str, Any] | None = None
    map_after: dict[str, Any] | None = None
    map_undone: dict[str, Any] | None = None
    #: Each message of the eval user and its answer, in order; the fields
    #: above hold the whole task (the answer and the card of its last turn).
    turns: list[TurnReport] = field(default_factory=list)


def turn_view(transcript: Transcript, turn: int | str | None) -> Transcript | None:
    """What a check that names ``turn`` grades (``evals.tasks._Graded``):
    the transcript as if the task had ended with that turn, its answer,
    calls, tokens and snapshots that turn's, its earlier turns kept in
    ``turns``; the whole transcript for "all", for a transcript of one turn
    and for one made by hand. None for a turn the transcript has not (a run
    that failed before it)."""
    turns = transcript.turns
    if turn == "all" or len(turns) <= 1:
        return transcript
    number = len(turns) if turn is None else int(turn)
    if not 1 <= number <= len(turns):
        return None
    graded = turns[number - 1]
    return replace(
        transcript,
        answer=graded.answer,
        tool_calls=graded.tool_calls,
        input_tokens=graded.input_tokens,
        output_tokens=graded.output_tokens,
        cache_read_tokens=graded.cache_read_tokens,
        map_before=graded.map_before,
        map_before_answer=graded.map_before_answer,
        map_after=graded.map_after,
        turns=turns[:number],
    )


def _cold(usage: RequestUsage) -> RequestUsage:
    return replace(usage, cache_read_tokens=0, cache_audio_read_tokens=0)


class ColdCacheDouble(WrapperModel):
    """A test double around the model under test, for the tasks that ask for
    it (``cold_requests``): the chosen requests of a run report no cache
    reads, as if the provider had missed its cache there, so the run's budget
    plans and counts them as such. A provider cannot be told to miss; the
    budget reads the usage the model reports (``assistant.budget``), on the
    response and in the run's usage. While a response streams, the checks of
    the token limit still see the reads the provider reported; the response
    and the run's usage get none once it ended."""

    def __init__(self, wrapped: Model) -> None:
        super().__init__(wrapped)
        self._cold: frozenset[int] = frozenset()
        self._requests = 0

    def start_run(self, cold: Sequence[int]) -> None:
        """A new run whose requests ``cold`` (counted from 1) miss the cache."""
        self._cold = frozenset(cold)
        self._requests = 0

    def _next_is_cold(self) -> bool:
        self._requests += 1
        return self._requests in self._cold

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        cold = self._next_is_cold()
        response = await super().request(
            messages, model_settings, model_request_parameters
        )
        return replace(response, usage=_cold(response.usage)) if cold else response

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: Any = None,
    ) -> AsyncGenerator[StreamedResponse]:
        cold = self._next_is_cold()
        async with super().request_stream(
            messages, model_settings, model_request_parameters, run_context
        ) as stream:
            if cold:
                events = stream._get_event_iterator

                async def missed() -> AsyncIterator[Any]:
                    # The provider sets the usage as the response streams;
                    # once it ended, the reads go before the agent reads it.
                    async for event in events():
                        yield event
                    stream._usage = _cold(stream._usage)

                stream._get_event_iterator = missed  # type: ignore[method-assign]
            yield stream


class AuditRows:
    """The audit rows of one task's calls, in memory: what the tool runtime
    writes (``insert_tool_call``) and what the dock's Undo reads and marks
    (``assistant.undo``), as the assistant's tables hold them."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def insert_tool_call(self, **row: Any) -> None:
        self.rows.append({**row, "id": uuid4()})

    async def undo_records(self, run_id: UUID) -> list[tuple[UUID, dict[str, Any]]]:
        return [
            (row["id"], dict(row["undo"]))
            for row in self.rows
            if row["run_id"] == run_id and row.get("undo") is not None
        ]

    async def calls_before(
        self, run_id: UUID
    ) -> list[tuple[UUID, list[dict[str, Any]]]]:
        """The calls of the task's other runs, by run, the oldest first, as
        ``Repository.calls_before`` gives them: every row belongs to the
        task's one conversation."""
        found: dict[UUID, list[dict[str, Any]]] = {}
        for row in self.rows:
            if row["run_id"] == run_id:
                continue
            undo = row.get("undo")
            found.setdefault(row["run_id"], []).append(
                {
                    "id": row["id"],
                    "tool": row.get("tool"),
                    "status": row.get("status"),
                    "args": dict(row.get("args_summary") or {}),
                    "created": row.get("created") is not None,
                    "undo": dict(undo) if undo is not None else None,
                }
            )
        return list(found.items())

    async def claim_undo(self, ids: list[UUID]) -> list[UUID]:
        claimed = []
        for row in self.rows:
            undo = row.get("undo")
            if (
                row["id"] in ids
                and undo is not None
                and "undone_at" not in undo
                and "undoing_at" not in undo
            ):
                row["undo"] = {**undo, "undoing_at": time.time()}
                claimed.append(row["id"])
        return claimed

    async def finish_undo(self, ids: list[UUID]) -> None:
        for row in self.rows:
            if row["id"] in ids and row.get("undo") is not None:
                kept = {k: v for k, v in row["undo"].items() if k != "undoing_at"}
                row["undo"] = {**kept, "undone_at": time.time()}

    async def release_undo(self, ids: list[UUID]) -> None:
        for row in self.rows:
            if row["id"] in ids and row.get("undo") is not None:
                row["undo"] = {
                    key: value
                    for key, value in row["undo"].items()
                    if key != "undoing_at"
                }


async def press_undo(audit: AuditRows, services: Any, run_id: UUID) -> str:
    """The eval user's Undo under an answer: how it went, in one word."""
    try:
        outcome = await undo_run(
            cast(Repository, audit), services, "eval-token", run_id, force=False
        )
    except NothingToUndo as exc:
        return "already_undone" if exc.undone else "nothing_to_undo"
    except UndoUnderWay:
        return "undo_in_progress"
    except UndoRefused as exc:
        return exc.code
    if outcome.changed or outcome.changed_styles or outcome.changed_map:
        return "changed_since"
    return "not_restored" if outcome.not_restored else "undone"


def _text(messages: Iterable[ModelMessage]) -> str:
    """The text of an answer's model responses, in order, as the dock shows
    it: each response's text a paragraph of its own, the text written before
    a tool call too; a response of whitespace only adds nothing."""
    texts = (
        "".join(part.content for part in message.parts if isinstance(part, TextPart))
        for message in messages
        if isinstance(message, ModelResponse)
    )
    return "\n\n".join(text.strip() for text in texts if text.strip())


def stalls(messages: Iterable[ModelMessage]) -> tuple[int, int]:
    """How many of a run's model responses held reasoning only (nothing to show
    or run), and how many times the agent asked the model again (a reply it
    could not use, or a tool call with invalid arguments)."""
    reasoning_only = retries = 0
    for message in messages:
        if isinstance(message, ModelResponse):
            reasoning_only += all(isinstance(p, ThinkingPart) for p in message.parts)
        else:
            retries += sum(isinstance(p, RetryPromptPart) for p in message.parts)
    return reasoning_only, retries


def answered_by(
    messages: Iterable[ModelMessage],
) -> tuple[dict[str, int], float | None]:
    """The providers that answered a run's model calls and what they billed in
    all, as a gateway reports them on each response (``provider_details``:
    OpenRouter routes one model to many providers). The cost is None when no
    response carried one."""
    providers: dict[str, int] = {}
    cost: float | None = None
    for message in messages:
        if not isinstance(message, ModelResponse):
            continue
        details = message.provider_details or {}
        name = details.get("downstream_provider")
        if name:
            providers[str(name)] = providers.get(str(name), 0) + 1
        billed = details.get("cost")
        if isinstance(billed, int | float) and not isinstance(billed, bool):
            cost = (cost or 0.0) + float(billed)
    return providers, cost


def _content(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


class _ToolLog:
    """The run's tool calls, built from the stream as it happens, so a run that
    fails halfway still shows what it did (the safety checks read this).

    Every call is kept: some providers number tool call ids per answer and so
    reuse them, also within one turn. A result belongs to the latest call
    with its id that has none yet."""

    def __init__(self) -> None:
        self._calls: list[ToolCall] = []
        self._waiting: list[tuple[str, ToolCall]] = []

    def see(self, event: Any) -> None:
        if isinstance(event, FunctionToolCallEvent):
            part = event.part
            call = ToolCall(part.tool_name, part.args_as_dict(), None, False)
            self._calls.append(call)
            self._waiting.append((part.tool_call_id, call))
        elif isinstance(event, FunctionToolResultEvent):
            reply = event.part
            waiting = [
                index
                for index, (call_id, _) in enumerate(self._waiting)
                if call_id == reply.tool_call_id
            ]
            if not waiting:
                return
            _, call = self._waiting.pop(waiting[-1])
            call.result = _content(reply.content)
            # A ToolFailed from the tool: the model sees the failure and the run goes on.
            # Anything but success (failed, denied, interrupted), as runs/translate.py reads it.
            call.failed = isinstance(reply, RetryPromptPart) or (
                getattr(reply, "outcome", "success") != "success"
            )

    @property
    def calls(self) -> list[ToolCall]:
        return list(self._calls)


def _is_text(event: Any) -> bool:
    if isinstance(event, PartStartEvent):
        return isinstance(event.part, TextPart) and bool(event.part.content)
    return isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta)


class Conversation:
    """A task's conversation as the app stores it: the rows of its messages
    (``Repository.list_messages``) and the model messages of its answers
    (``Repository.history``), as JSON."""

    def __init__(self, page: PageContext) -> None:
        self.page = page
        self.rows: list[dict[str, Any]] = []
        self.model_messages: list[Any] = []

    def user_row(self, text: str, answer: CardAnswer | None) -> dict[str, Any]:
        """A user message's row as ``RunManager.start_run`` stores it."""
        parts: list[dict[str, Any]] = [{"type": "user_text", "text": text}]
        if self.page.surface != "none" or self.page.sources:
            parts.append({"type": "context", "context": dump_context(self.page)})
        if answer is not None:
            parts.append({"type": "answer", "answer": answer.model_dump(mode="json")})
        return {"role": "user", "parts": parts}

    def previous_page(self) -> PageContext | None:
        """The page stored with the latest user message
        (``Repository.last_user_context``)."""
        for row in reversed(self.rows):
            if row["role"] != "user":
                continue
            for part in row["parts"]:
                if part.get("type") == "context":
                    return parse_context(part["context"])
            return None
        return None

    def history(self) -> list[ModelMessage]:
        """The model messages a run continues, as the app reloads them."""
        return ModelMessagesTypeAdapter.validate_python(self.model_messages)

    def add_text_turns(self, task: EvalTask) -> None:
        """The task's text-only earlier turns (``history``) as the app
        replays them: each user text with the note of its time, then the
        answer."""
        for turn in task.history:
            note = render_note(self.page, self.previous_page(), task.locale, turn.user)
            self.add(
                self.user_row(turn.user, None),
                [{"type": "text", "text": turn.assistant}],
                [
                    ModelRequest(
                        parts=[UserPromptPart(content=with_note(note, turn.user))]
                    ),
                    ModelResponse(parts=[TextPart(content=turn.assistant)]),
                ],
            )

    def add(
        self,
        user: dict[str, Any],
        parts: list[dict[str, Any]],
        messages: list[ModelMessage],
    ) -> None:
        """An answered message: its row, the answer's parts and its model
        messages, stored as ``RunManager`` stores them."""
        self.rows += [user, {"role": "assistant", "parts": parts}]
        self.model_messages += to_jsonable_python(messages)


def auto_answer(
    card_id: str,
    card: AskUserInput,
    value: str | None = None,
    declines: str | None = None,
) -> tuple[CardAnswer, str]:
    """The eval user's answer to a card: every question with the option of
    ``value`` where it offers one, the first option without the value
    ``declines`` where it offers that, else its first option, the recommended
    one when there is one (``AskQuestion`` puts it first), and the text the
    dock sends with it."""

    def pick(options: Sequence[Any]) -> int:
        values = [option.value for option in options]
        if value is not None and value in values:
            return values.index(value)
        if declines is not None and declines in values:
            return next(i for i, given in enumerate(values) if given != declines)
        return 0

    picks = [pick(question.options) for question in card.questions]
    answer = CardAnswer(
        card_id=card_id,
        answers=[
            QuestionAnswer(question=index, options=[pick])
            for index, pick in enumerate(picks)
        ],
    )
    text = ". ".join(
        f"{question.header}: {question.options[pick].label}"
        for question, pick in zip(card.questions, picks, strict=True)
    )
    return answer, text


def map_states(task: EvalTask) -> tuple[dict[str, MapState], MapState | None]:
    """Fresh states of the map project and of its viewer copy for a task,
    and the one the task works on: that of the project its page names, the
    map project's for any other task of the map suite, None for a task off
    the map project. That state starts on the basemap the page shows."""
    states = {MAP_PROJECT_ID: MapState(), MAP_VIEW_PROJECT_ID: MapState()}
    project_id = str(task.context.get("project_id", ""))
    watched = states.get(project_id)
    if watched is None and task.suite == "map":
        watched = states[MAP_PROJECT_ID]
    basemap = task.context.get("basemap")
    if watched is not None and isinstance(basemap, dict) and basemap.get("id"):
        watched.basemap = str(basemap["id"])
    return states, watched


def _shown_card(calls: list[ToolCall]) -> tuple[str, AskUserInput] | None:
    """The last card the run showed, with its id."""
    for call in reversed(calls):
        if call.name != ASK_TOOL or call.failed or not isinstance(call.result, dict):
            continue
        try:
            return str(call.result["card_id"]), AskUserInput.model_validate(call.args)
        except (KeyError, ValidationError):
            return None
    return None


async def run_task(
    task: EvalTask, model: Model, backends: Backends, settings: AssistantSettings
) -> Transcript:
    page = parse_context(task.context)
    maps, watched = map_states(task)
    services, requests, saved = backends.clients(maps=maps)
    events: list[RunEvent] = []
    cold = (
        ColdCacheDouble(model)
        if any(reply.cold_requests for reply in task.messages)
        else None
    )
    agent = build_agent(cold if cold is not None else model)
    budget = RunBudget(
        max_tokens=settings.run_max_tokens,
        max_tool_calls=settings.run_max_tool_calls,
    )
    started = time.monotonic()
    first_text: float | None = None
    error: str | None = None
    log = _ToolLog()
    #: One per run, as each run of the app has its own limits.
    usages: list[RunUsage] = []
    #: Each run's own messages, for the providers that answered them.
    answered: list[ModelMessage] = []
    conversation = Conversation(page)
    conversation.add_text_turns(task)
    #: The audit rows of the task's calls, and the run of the last answer.
    audit = AuditRows()
    last_run: UUID | None = None
    undo: str | None = None
    turns: list[TurnReport] = []
    map_undone: dict[str, Any] | None = None

    def snapshot() -> dict[str, Any] | None:
        return watched.snapshot() if watched is not None else None

    async def run(
        text: str,
        answer: CardAnswer | None,
        report: TurnReport,
        cold_requests: Sequence[int],
    ) -> None:
        """One run of the conversation, as RunManager starts and executes it:
        its own limits and time, and what it reads of the conversation from
        the stored rows and model messages."""
        nonlocal first_text, last_run
        rows = conversation.rows
        asks = AskHistory.from_stored(rows)
        answer_text = ""
        if answer is None:
            asks = asks.with_typed_message()
        else:
            card = asks.cards[answer.card_id]
            asks, answer_text = asks.with_answer(answer), answer_lines(card, answer)
        clock = AnswerClock(settings.run_wait_max_seconds)
        last_run = uuid4()
        message_id = str(uuid4())
        env = ToolEnv(
            services=services,
            login=StaticLogin("eval-token"),
            user_id=EVAL_USER,
            page=page,
            locale=task.locale,
            run_id=last_run,
            repo=cast(Repository, audit),
            extra_secrets=client_secrets(settings),
            asks=asks,
            typed=typed_texts(rows, text, answer),
            skills=loaded_skills(rows),
            clock=clock,
            runs=ConversationRuns.from_stored(rows),
        )
        run_events: list[RunEvent] = []

        async def emit(event: RunEvent) -> None:
            events.append(event)
            run_events.append(event)

        part_ids = PartIds(message_id)
        deps = RunDeps(
            message_id=message_id,
            emit=emit,
            part_ids=part_ids,
            env=env,
            prompt_note=render_note(
                page, conversation.previous_page(), task.locale, text
            ),
            prompt_answer=answer_text,
            prompt_text=text,
            prompt_locale=task.locale,
            budget=budget,
        )
        env.emit_data = deps.emit_data
        deps.earlier_results.update(earlier_writes(rows))
        translator = EventTranslator(part_ids, deps.response_texts)
        history = conversation.history()
        user = conversation.user_row(text, answer)
        # The caller's usage, as RunManager does: tokens of a run that fails
        # or times out are still counted.
        usage = RunUsage()
        usages.append(usage)
        calls = len(log.calls)
        report.runs += 1
        if cold is not None:
            cold.start_run(cold_requests)

        async def on_event(event: AgentStreamEvent) -> None:
            nonlocal first_text
            log.see(event)
            if first_text is None and _is_text(event):
                first_text = time.monotonic() - started
            for translated in translator.translate(event):
                await emit(translated)

        try:
            async with asyncio.timeout(settings.run_max_seconds) as deadline:
                clock.timeout = deadline
                result = await run_turn(
                    agent,
                    with_note(deps.prompt_note, text, answer_text),
                    deps=deps,
                    on_event=on_event,
                    message_history=history,
                    # One per run, as each run of the app has its own: the
                    # limit's margin follows the run's own requests.
                    usage_limits=budget.usage_limits(),
                    usage=usage,
                )
        finally:
            report.tool_calls += log.calls[calls:]
            report.input_tokens += usage.input_tokens
            report.output_tokens += usage.output_tokens
            report.cache_read_tokens += usage.cache_read_tokens
            report.requests += usage.requests
        # What the dock shows: the text of every response of the answer, the
        # one before a card that ended it too.
        report.answer = _text(result.messages)
        # The replaced responses and the requests that asked again count too:
        # each cost a model call.
        answered.extend([*result.messages, *result.replaced])
        conversation.add(user, fold_parts(run_events), result.messages)

    try:
        for reply in task.messages:
            text = reply.text if isinstance(reply, Message) else task.prompt
            report = TurnReport(prompt=text, map_before=snapshot())
            turns.append(report)
            await run(text, None, report, reply.cold_requests)
            shown = _shown_card(report.tool_calls) if reply.answer_card else None
            if shown is not None:
                card_id, card = shown
                answer, typed = auto_answer(
                    card_id, card, reply.answer_value, reply.answer_declines
                )
                report.map_before_answer = snapshot()
                await run(typed, answer, report, ())
            report.map_after = snapshot()
        if task.undo and last_run is not None:
            undo = await press_undo(audit, services, last_run)
            map_undone = snapshot()
    except Exception as exc:  # a failed run is a failed task, not a failed eval
        error = f"{type(exc).__name__}: {exc}"
    finally:
        await services.aclose()
    if turns and turns[-1].map_after is None:
        # A run that failed: what it stored before it failed.
        turns[-1].map_after = snapshot()
    providers, cost = answered_by(answered)
    reasoning_only, retries = stalls(answered)
    last = turns[-1] if turns else TurnReport(prompt=task.prompt)
    return Transcript(
        task_id=task.id,
        answer=last.answer,
        tool_calls=log.calls,
        proposals=[
            e.data for e in events if isinstance(e, DataPart) and e.name == "proposal"
        ],
        requests=requests,
        error=error,
        input_tokens=sum(usage.input_tokens for usage in usages),
        output_tokens=sum(usage.output_tokens for usage in usages),
        seconds=time.monotonic() - started,
        first_text_seconds=first_text,
        cache_read_tokens=sum(usage.cache_read_tokens for usage in usages),
        saved=saved,
        providers=providers,
        cost=cost,
        reasoning_only=reasoning_only,
        retries=retries,
        undo=undo,
        map_before=turns[0].map_before if turns else snapshot(),
        map_before_answer=last.map_before_answer,
        map_after=last.map_after,
        map_undone=map_undone,
        turns=turns,
    )
