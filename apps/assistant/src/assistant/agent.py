"""The assistant's agent: GOAT's tools (assistant.tools), the prompt of
assistant.prompt, models from the model layer (assistant.llm)."""

import asyncio
import functools
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.messages import ModelMessage, RetryPromptPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.instrumented import InstrumentationSettings
from pydantic_ai.models.test import TestModel

from assistant.budget import RunBudget, StepGuard
from assistant.events import DataPart, RunEvent
from assistant.history import shorten_earlier_results
from assistant.llm.types import DataPolicy
from assistant.prompt import (
    ANSWER_IN_TEXT,
    ANSWER_NOW,
    ANSWER_NOW_CARD,
    CARD_AFTER_TEXT,
    INSTRUCTIONS,
    NO_ANSWER_TEXT,
    READ_THE_RESULT,
    static_instructions,
)
from assistant.tools.runtime import ToolEnv
from assistant.tools.toolset import (
    SILENT_RESPONSES,
    TOOL_RETRIES,
    answer_step,
    goat_toolset,
    silent_responses,
)

__all__ = ["INSTRUCTIONS", "PartIds", "RunDeps", "build_agent", "dev_model"]


class PartIds:
    """``{message_id}:{n}`` part IDs, stable across replay (spec §6.2)."""

    def __init__(self, message_id: str) -> None:
        self._message_id = message_id
        self._n = 0

    def next(self) -> str:
        self._n += 1
        return f"{self._message_id}:{self._n}"


@dataclass
class RunDeps:
    message_id: str
    emit: Callable[[RunEvent], Awaitable[None]]
    part_ids: PartIds | None = None
    #: The organization's data policy (spec §4.7); the tool layer (plan 3)
    #: filters what data-returning tools send to the model by it.
    data_policy: DataPolicy = "restricted"
    #: The run's tool environment (assistant.tools.runtime); None runs without
    #: GOAT's tools (the run machinery's own tests).
    env: ToolEnv | None = None
    #: The run's note: UI language and page context (assistant.prompt.render_note).
    #: It goes into the user message (assistant.prompt.with_note), not the
    #: instructions, so the cached prefix stays the same between messages.
    prompt_note: str = ""
    #: The user's answer to a card, as the model reads it (assistant.asks);
    #: it follows the text of the user message (assistant.prompt.with_note).
    prompt_answer: str = ""
    #: The run's limits; near them the model answers, or asks with a card, and
    #: is offered no other tool (assistant.budget). None: no early answer (the
    #: hard limits still apply).
    budget: RunBudget | None = None
    #: Results by call (assistant.tools.toolset): a repeated call gets the
    #: earlier result instead of a second request. Read tools' results of this
    #: answer, and write tools' of the whole conversation (the run manager adds
    #: those of earlier answers). The fallback model takes over before a tool
    #: ran, so it finds only those of earlier answers.
    earlier_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: The model showed the user a card (``ask_user``): the run offers no more
    #: tools (``assistant.tools.toolset``), so the answer ends and waits for theirs.
    asked: bool = False
    #: What the current step's tool calls may still add to the run
    #: (``assistant.budget.StepGuard``); a new one at each step's first call.
    step: StepGuard | None = None
    #: The run (its id) in which a result was refused for its size: its
    #: look-ups are over, and its next model call answers
    #: (``assistant.tools.toolset``).
    refused_run: str | None = None
    #: Calls refused for good, by call (as ``earlier_results``), with the size
    #: in bytes of the result refused (0 when none was) and the refusal: the
    #: same call is refused again without running. A result too large, and a
    #: call the service failed twice for (``failed_calls``).
    refused_results: dict[str, tuple[int, str]] = field(default_factory=dict)
    #: How often a service failed for a call, by call (as ``earlier_results``):
    #: a 429 or 5xx answer, no answer in time, or none at all
    #: (``assistant.tools.http.service_failed``).
    failed_calls: dict[str, int] = field(default_factory=dict)
    #: The calls let run, by run id, failed and invalid ones included: what
    #: the run's tool-call limit counts (``assistant.budget.StepGuard``).
    admitted_calls: dict[str | None, int] = field(default_factory=dict)
    #: The catalog searches in a row that found nothing, by run id: from
    #: ``FRUITLESS_SEARCHES`` on, the answer's catalog searches do not run
    #: (``assistant.tools.toolset``).
    fruitless_searches: dict[str | None, int] = field(default_factory=dict)
    #: By run id: how many responses of the run there were when a tool
    #: returned a result the answer reports before it asks
    #: (``ToolSpec.report_first``). ``ask_user`` is refused until a later
    #: response of the run holds text (``assistant.tools.toolset``), in at
    #: most ``REPORT_REFUSALS`` responses per result.
    unreported: dict[str | None, int] = field(default_factory=dict)
    #: By run id: the cards refused for the result in ``unreported``, each
    #: with the step that made it and the canonical JSON of its arguments:
    #: the refusals count per step, and an identical repeat is told what is
    #: missing (``assistant.tools.ask.REPEATED_CARD``).
    refused_cards: dict[str | None, list[tuple[int, str]]] = field(default_factory=dict)
    #: By run id: the reads of the result in ``unreported`` made past the
    #: look-up budget (``assistant.budget.RESULT_READS``); there from the
    #: first step prepared for them on.
    result_reads: dict[str | None, int] = field(default_factory=dict)
    #: The step (run id, step number) prepared for reading a finished run's
    #: result past the look-up budget: its reads count as such
    #: (``assistant.tools.toolset.RESULT_READ_TOOLS``). Matched by the step
    #: number, which Pydantic AI (2.52) keeps the same for preparing a step's
    #: tools and for running its calls (``ToolManager.for_run_step``); it
    #: prepares them again within a step only when a capability's
    #: availability changes, which this agent's capabilities do not.
    reading_step: tuple[str | None, int] | None = None

    def __post_init__(self) -> None:
        if self.part_ids is None:
            self.part_ids = PartIds(self.message_id)

    async def emit_data(
        self, name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        assert self.part_ids is not None
        part_id = part_id or self.part_ids.next()
        await self.emit(DataPart(name=name, part_id=part_id, data=data))
        return part_id


async def _demo_stream(
    messages: list[ModelMessage], info: AgentInfo
) -> AsyncIterator[str | DeltaToolCalls]:
    """Development model: where it is offered (every page) it proposes filters
    once, then gives a slow answer (long enough to reload mid-run)."""
    last_parts = getattr(messages[-1], "parts", [])
    answered = any(
        isinstance(part, (ToolReturnPart, RetryPromptPart)) for part in last_parts
    )
    offered = {tool.name for tool in info.function_tools}
    if not answered and "catalog_propose_filters" in offered:
        yield {
            0: DeltaToolCall(
                name="catalog_propose_filters",
                json_args='{"title": "Cycling networks", "q": "Radverkehr"}',
            )
        }
        return
    for word in ("This ", "is ", "a ", "slow ", "demo ", "answer. ") * 10:
        await asyncio.sleep(0.4)
        yield word


def dev_model(model_name: str) -> Model:
    if model_name == "demo":
        return FunctionModel(stream_function=_demo_stream)
    if model_name == "test":
        return TestModel(custom_output_text="Here is a test answer.")
    raise ValueError(f"Unknown development model {model_name!r} (use 'test' or 'demo')")


@functools.cache
def _content_free_tracing() -> InstrumentationSettings:
    return InstrumentationSettings(include_content=False)


def instrumentation() -> InstrumentationSettings | None:
    """Tracing for an agent (spec §3): one trace per run with a span per model
    and tool call, never prompts, answers or tool results. On only with
    ``OTEL_ENABLED``, the switch ``goatobs.setup_observability`` reads; read at
    call time, so it follows the environment of the process."""
    enabled = os.environ.get("OTEL_ENABLED", "").lower() in ("true", "1", "yes")
    return _content_free_tracing() if enabled else None


def answer_now(ctx: RunContext[RunDeps]) -> str:
    """The instruction for a run near its limits, or whose responses held
    neither text nor a tool call; nothing otherwise, so the fixed
    instructions stay the cached prefix."""
    stage = answer_step(ctx)
    if stage is None or stage == "look up":
        return ""
    if stage in ("read or ask", "read"):
        lead = READ_THE_RESULT
    elif silent_responses(ctx.messages, ctx.run_id) >= SILENT_RESPONSES:
        lead = ANSWER_IN_TEXT
    else:
        lead = ANSWER_NOW
    # Named only while the card is offered (assistant.tools.toolset).
    if stage == "read or ask" and not ctx.deps.asked:
        return f"{lead} {ANSWER_NOW_CARD} {CARD_AFTER_TEXT}"
    if stage == "answer or ask" and not ctx.deps.asked:
        return f"{lead} {ANSWER_NOW_CARD}"
    return lead


def ends_with_text(ctx: RunContext[RunDeps], output: str) -> str:
    """Asks again for an answer whose last response holds only whitespace:
    Pydantic AI asks again only after a response without any text, and takes
    a single space as the answer, so an answer could end after its cards
    without a word on them. The last retry's answer is taken as it is: a run
    that fails at that point would lose an answer the user has partly seen."""
    if output.strip() or ctx.partial_output or ctx.retry >= ctx.max_retries:
        return output
    raise ModelRetry(NO_ANSWER_TEXT)


def build_agent(model: Model | str) -> Agent[RunDeps, str]:
    """The assistant's agent on ``model``; a string selects a development model
    (``test`` or ``demo``). Fixed instructions only (cached; the run's note
    travels in the user message), GOAT's tools for the run's surface in a
    fixed order."""
    agent: Agent[RunDeps, str] = Agent(
        dev_model(model) if isinstance(model, str) else model,
        deps_type=RunDeps,
        instructions=[*static_instructions(), answer_now],
        toolsets=[goat_toolset()],
        # Earlier answers' long tool results go to the model as counts.
        capabilities=[ProcessHistory(shorten_earlier_results)],
        # Also the budget for a tool name the surface does not offer: a history
        # from another page can make the model call one (spec §4.8).
        retries=TOOL_RETRIES,
    )
    agent.output_validator(ends_with_text)
    agent.instrument = instrumentation()
    return agent
