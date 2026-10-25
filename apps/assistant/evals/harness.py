"""Runs one eval task with a model: the production agent, prompt, tool layer
and limits, against the fixed backends, and records what happened.

A task with ``answer_card`` runs a second turn when the first showed a card:
the eval user answers it (``auto_answer``) and the turn gets the answer the
way the app renders it (``assistant.asks.answer_lines``)."""

import asyncio
import json
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import httpx
from pydantic import ValidationError
from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
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
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from assistant.agent import RunDeps, build_agent
from assistant.asks import (
    ASK_TOOL,
    AskHistory,
    AskUserInput,
    CardAnswer,
    QuestionAnswer,
    answer_lines,
)
from assistant.budget import RunBudget
from assistant.clock import AnswerClock
from assistant.config import AssistantSettings
from assistant.context import PageContext, parse_context
from assistant.events import DataPart, RunEvent
from assistant.login import StaticLogin
from assistant.prompt import render_note, with_note
from assistant.runs.turn import run_turn
from assistant.tools.runtime import ToolEnv, client_secrets
from assistant.tools.toolset import earlier_writes
from assistant.workflows.runs import ConversationRuns
from evals.backends import Backends
from evals.tasks import EvalTask

#: The eval user; the fixed backends answer for anyone.
EVAL_USER = UUID(int=0xE7A1)


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]
    result: Any
    failed: bool


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


def _text(messages: Iterable[ModelMessage]) -> str:
    """The text of an answer's model responses, in order."""
    return "".join(
        part.content
        for message in messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, TextPart)
    )


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


def _written(calls: list[ToolCall]) -> dict[str, dict[str, Any]]:
    """The results of the write calls that succeeded, by call key, as the
    run manager seeds a run with those of the conversation
    (``toolset.earlier_writes`` over the stored parts)."""
    stored = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": call.name,
                    "args": call.args,
                    "output": call.result,
                    "state": "output",
                }
                for call in calls
                if not call.failed
            ],
        }
    ]
    return earlier_writes(stored)


def _is_text(event: Any) -> bool:
    if isinstance(event, PartStartEvent):
        return isinstance(event.part, TextPart) and bool(event.part.content)
    return isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta)


def _history(task: EvalTask, page: PageContext) -> list[ModelMessage]:
    """The task's earlier turns as the app replays them: each user text with
    the note of its time, then the answer."""
    messages: list[ModelMessage] = []
    for turn in task.history:
        note = render_note(page, page if messages else None, task.locale, turn.user)
        messages.append(
            ModelRequest(parts=[UserPromptPart(content=with_note(note, turn.user))])
        )
        messages.append(ModelResponse(parts=[TextPart(content=turn.assistant)]))
    return messages


def auto_answer(card_id: str, card: AskUserInput) -> tuple[CardAnswer, str]:
    """The eval user's answer to a card: every question with its first
    option, the recommended one when there is one (``AskQuestion`` puts it
    first), and the text the dock sends with it."""
    answer = CardAnswer(
        card_id=card_id,
        answers=[
            QuestionAnswer(question=index, options=[0])
            for index in range(len(card.questions))
        ],
    )
    text = ". ".join(
        f"{question.header}: {question.options[0].label}" for question in card.questions
    )
    return answer, text


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
    services, requests, saved = backends.clients()
    events: list[RunEvent] = []

    async def emit(event: RunEvent) -> None:
        events.append(event)

    agent = build_agent(model)
    budget = RunBudget(
        max_tokens=settings.run_max_tokens,
        max_tool_calls=settings.run_max_tool_calls,
    )
    limits = budget.usage_limits()
    started = time.monotonic()
    first_text: float | None = None
    output = ""
    error: str | None = None
    log = _ToolLog()
    #: One per turn, as each run of the app has its own limits.
    usages: list[RunUsage] = []
    #: Each turn's own messages, for the providers that answered them.
    answered: list[ModelMessage] = []
    #: What the conversation created and ran, shared by its turns as the
    #: stored conversation is in the app (ConversationRuns.from_stored).
    runs = ConversationRuns()

    async def turn(
        prompt: str,
        history: list[ModelMessage],
        previous: PageContext | None,
        asks: AskHistory,
        answer: str,
        written: dict[str, dict[str, Any]],
    ) -> list[ModelMessage]:
        """One run of the conversation, as RunManager runs it: its own limits
        and time, the conversation's earlier write results (``written``)."""
        nonlocal first_text, output
        clock = AnswerClock(settings.run_wait_max_seconds)
        env = ToolEnv(
            services=services,
            login=StaticLogin("eval-token"),
            user_id=EVAL_USER,
            data_policy=task.data_policy,
            page=page,
            locale=task.locale,
            extra_secrets=client_secrets(settings),
            asks=asks,
            clock=clock,
            runs=runs,
        )
        deps = RunDeps(
            message_id=str(uuid4()),
            emit=emit,
            data_policy=task.data_policy,
            env=env,
            prompt_note=render_note(page, previous, task.locale, prompt),
            prompt_answer=answer,
            budget=budget,
        )
        env.emit_data = deps.emit_data
        deps.earlier_results.update(written)
        # The caller's usage, as RunManager does: tokens of a run that fails
        # or times out are still counted.
        usage = RunUsage()
        usages.append(usage)

        async def on_event(event: AgentStreamEvent) -> None:
            nonlocal first_text
            log.see(event)
            if first_text is None and _is_text(event):
                first_text = time.monotonic() - started

        async with asyncio.timeout(settings.run_max_seconds) as deadline:
            clock.timeout = deadline
            result = await run_turn(
                agent,
                with_note(deps.prompt_note, prompt, answer),
                deps=deps,
                on_event=on_event,
                message_history=history or None,
                usage_limits=limits,
                usage=usage,
            )
        # A shown card ends the answer: its text is what came before the card.
        output = result.output if result.output is not None else _text(result.messages)
        answered.extend(result.messages)
        return [*history, *result.messages]

    try:
        messages = await turn(
            task.prompt,
            _history(task, page),
            page if task.history else None,
            AskHistory(),
            "",
            {},
        )
        first = log.calls
        shown = _shown_card(first) if task.answer_card else None
        if shown is not None:
            card_id, card = shown
            answer, text = auto_answer(card_id, card)
            await turn(
                text,
                messages,
                page,
                AskHistory(cards={card_id: card}, answers={card_id: answer}),
                answer_lines(card, answer),
                _written(first),
            )
    except Exception as exc:  # a failed run is a failed task, not a failed eval
        error = f"{type(exc).__name__}: {exc}"
    finally:
        await services.aclose()
    providers, cost = answered_by(answered)
    reasoning_only, retries = stalls(answered)
    return Transcript(
        task_id=task.id,
        answer=output,
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
    )
