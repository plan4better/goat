"""The assistant's agent: GOAT's tools (assistant.tools), the prompt of
assistant.prompt, models from the model layer (assistant.llm)."""

import asyncio
import functools
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from pydantic_ai import Agent, CallToolsNode, ModelRequestNode, RunContext
from pydantic_ai.capabilities import (
    AbstractCapability,
    AgentNode,
    NodeResult,
    ProcessHistory,
    WrapModelRequestHandler,
)
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import Model, ModelRequestContext
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.instrumented import InstrumentationSettings
from pydantic_ai.models.test import TestModel
from pydantic_ai.result import FinalResult
from pydantic_graph import End

from assistant.budget import RunBudget, StepGuard
from assistant.events import DataPart, RunEvent
from assistant.history import shorten_earlier_results
from assistant.llm.types import DataPolicy
from assistant.prompt import (
    ADD_WHAT_WAS_PICKED,
    ANSWER_IN_TEXT,
    ANSWER_NOW,
    ANSWER_NOW_CARD,
    CARD_AFTER_TEXT,
    INSTRUCTIONS,
    NO_ANSWER_TEXT,
    RUN_WHAT_YOU_BUILT,
    as_note,
    read_the_result,
    static_instructions,
)
from assistant.surfaces import Locale
from assistant.tools.runtime import ToolEnv
from assistant.tools.toolset import (
    SILENT_RESPONSES,
    TOOL_RETRIES,
    Stage,
    answer_step,
    card_failed,
    goat_toolset,
    pickable_datasets,
    prepared_stage,
    read_allowance_of,
    response_text,
    runnable_workflows,
    silent_responses,
    step_refused,
    written_so_far,
)

__all__ = [
    "CLOSING_TEXT",
    "INSTRUCTIONS",
    "STAGE_KEY",
    "PartIds",
    "RunDeps",
    "StageNote",
    "build_agent",
    "dev_model",
]


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
    #: The run's limits; near them the model is told to answer, or to ask with
    #: a card, and its other calls are refused as they run (assistant.budget).
    #: None: no early answer (the hard limits still apply).
    budget: RunBudget | None = None
    #: Results by call (assistant.tools.toolset): a repeated call gets the
    #: earlier result instead of a second request. Read tools' results of this
    #: answer, and write tools' of the whole conversation (the run manager adds
    #: those of earlier answers). The fallback model takes over before a tool
    #: ran, so it finds only those of earlier answers.
    earlier_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: The model showed the user a card (``ask_user``): the answer ends there
    #: and waits for theirs (``runs/turn.py``); a run that goes on is offered
    #: no more tools (``assistant.tools.toolset``).
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
    #: look-up budget (``assistant.budget.read_allowance``): in a step prepared
    #: for them, and past the tool-call limit in any other step. There from
    #: the first such read or step on.
    result_reads: dict[str | None, int] = field(default_factory=dict)
    #: By run id: the reads past the look-up budget the result in
    #: ``unreported`` gets (``assistant.budget.read_allowance``).
    read_allowances: dict[str | None, int] = field(default_factory=dict)
    #: By run id: the latest step prepared (its number) and its stage
    #: (``assistant.tools.toolset.answer_step``), decided once per step; the
    #: step's calls are held to it as they run.
    stages: dict[str | None, tuple[int, Stage]] = field(default_factory=dict)
    #: By run id: the latest step prepared in the stage "answer or ask" while
    #: a step that reads a run's result and the answer step still fit
    #: (``assistant.budget.RunBudget.read_fits``), decided with the stage:
    #: only then may the step run a workflow this answer built, so its result
    #: is read before the answer (``assistant.tools.toolset.runnable_workflows``).
    run_room: dict[str | None, int] = field(default_factory=dict)
    #: By run id: the workflows this answer started a run of, each with its
    #: step, whatever came of the run (``assistant.tools.toolset._note_run``).
    run_attempts: dict[str | None, dict[str, int]] = field(default_factory=dict)
    #: By run id: the newest step past the look-ups that made calls, and
    #: whether one of them ran: not refused by its stage, by the tool-call
    #: limit or by the reads its result has left, and for a display tool,
    #: showed its cards (``assistant.tools.toolset._note_stage_call``).
    stage_calls: dict[str | None, tuple[int, bool]] = field(default_factory=dict)
    #: By run id: the step past the look-ups whose calls were all refused
    #: and whose response held no text (``StageNote.after_node_run``). The
    #: run's later steps answer (``assistant.tools.toolset.answer_step``),
    #: and a second such step ends the run.
    insisted: dict[str | None, int] = field(default_factory=dict)
    #: The runs (their ids) whose next model call is not made: it ends the
    #: run with ``CLOSING_TEXT`` (``StageNote``).
    closing: set[str | None] = field(default_factory=set)
    #: By run id: the step past the look-ups in which a call of a display
    #: tool returned (``assistant.tools.toolset.DISPLAY_TOOLS``); their calls
    #: in a later step are refused.
    shown_steps: dict[str | None, int] = field(default_factory=dict)
    #: By run id: the newest step past the look-ups in which a display
    #: tool's call failed (invalid arguments, a service that failed): a step
    #: of failed or refused calls that wrote text still gets one more step,
    #: for the corrected call (``StageNote.after_node_run``).
    failed_cards: dict[str | None, int] = field(default_factory=dict)
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


def stage_note(ctx: RunContext[RunDeps]) -> str:
    """The note for the model call being prepared of a run near its limits,
    or whose responses held neither text nor a tool call
    (``assistant.tools.toolset.answer_step``); nothing in a look-up step."""
    stage = answer_step(ctx)
    if stage is None or stage == "look up":
        return ""
    if stage in ("read or ask", "read"):
        lead = read_the_result(read_allowance_of(ctx))
    elif silent_responses(ctx.messages, ctx.run_id) >= SILENT_RESPONSES:
        lead = ANSWER_IN_TEXT
    else:
        lead = ANSWER_NOW
    if stage == "answer or ask" and not ctx.deps.asked:
        # What the step still runs besides the card (assistant.tools.toolset).
        if runnable_workflows(ctx):
            lead = f"{lead} {RUN_WHAT_YOU_BUILT}"
        if pickable_datasets(ctx):
            lead = f"{lead} {ADD_WHAT_WAS_PICKED}"
    # Named only while the stage lets the card run (assistant.tools.toolset),
    # always with the text before it: a card that comes alone leaves the user
    # a question with nothing said before it.
    if stage in ("read or ask", "answer or ask") and not ctx.deps.asked:
        return f"{lead} {ANSWER_NOW_CARD} {CARD_AFTER_TEXT}"
    return lead


#: The key of a request's stage (``answer_step``) in its metadata in the
#: run's history: the note is not stored, and the metadata is not sent.
STAGE_KEY = "goat_stage"

#: The answer's text when its run ends on calls that did not run and the
#: model wrote none in the whole answer (``StageNote``), in the interface
#: language (``ToolEnv.locale``).
CLOSING_TEXT: dict[Locale, str] = {
    "en": "This answer could not be completed. Please ask again.",
    "de": "Diese Antwort konnte nicht abgeschlossen werden. Bitte fragen Sie noch einmal.",
}


@dataclass
class StageNote(AbstractCapability[RunDeps]):
    """Sends the note on the run's stage (``stage_note``) as the last content
    of the model call, after the conversation: the instructions and the tools
    stay the same in every call of an answer, so the provider reads all that
    comes before the note from its cache.

    The note goes into the request the model is sent, not into the run's
    history: a later call, and the next answer, never see an earlier note.
    Pydantic AI stores what ``before_model_request`` (a history processor)
    returns as the run's history; ``wrap_model_request`` comes after that.
    The note is a GOAT note (``prompt.as_note``) in a user message, after the
    results of the newest call's tools. The request in the history records
    the stage in its metadata instead (``STAGE_KEY``). Nothing else of a call
    changes with the stage: not the tools, not the tool choice.

    A model that keeps calling what its stage refuses would make a model
    call of the whole context for each attempt, so such a run ends
    (``after_node_run``): the calls of a step past the look-ups were all
    refused, and the step wrote text (its answer, which the user has seen),
    or it is the second such step without text. The run then ends with the
    text written so far, or without any, with ``CLOSING_TEXT`` in place of
    the next model call."""

    async def wrap_model_request(
        self,
        ctx: RunContext[RunDeps],
        *,
        request_context: ModelRequestContext,
        handler: WrapModelRequestHandler,
    ) -> ModelResponse:
        note = stage_note(ctx)
        stage = prepared_stage(ctx)
        stored = ctx.messages[-1] if ctx.messages else None
        if stage is not None and isinstance(stored, ModelRequest):
            stored.metadata = {**(stored.metadata or {}), STAGE_KEY: stage}
        if ctx.run_id in ctx.deps.closing:
            # Returned in place of the model's response: Pydantic AI streams
            # it as one and stores it, and it ends the run as text does.
            env = ctx.deps.env
            locale: Locale = env.locale if env is not None else "en"
            return ModelResponse(parts=[TextPart(CLOSING_TEXT[locale])])
        messages = request_context.messages
        if note and messages and isinstance(messages[-1], ModelRequest):
            last = messages[-1]
            noted = replace(last, parts=[*last.parts, UserPromptPart(as_note(note))])
            request_context.messages = [*messages[:-1], noted]
        return await handler(request_context)

    async def after_node_run(
        self,
        ctx: RunContext[RunDeps],
        *,
        node: "AgentNode[RunDeps]",
        result: "NodeResult[RunDeps]",
    ) -> "NodeResult[RunDeps]":
        """Ends a run whose step past the look-ups had none of its calls run:
        with the step's text, or at a second such step with the text written
        so far; without any, the next call ends it (``RunDeps.closing``).
        After a first such step without text, or with a card that failed
        (one more step for the corrected call), the run answers
        (``RunDeps.insisted``)."""
        if not isinstance(node, CallToolsNode) or not isinstance(
            result, ModelRequestNode
        ):
            return result
        if not step_refused(ctx):
            return result
        text = response_text(node.model_response)
        if (not text or card_failed(ctx)) and ctx.run_id not in ctx.deps.insisted:
            ctx.deps.insisted[ctx.run_id] = ctx.run_step
            return result
        text = text or written_so_far(ctx)
        if not text:
            ctx.deps.closing.add(ctx.run_id)
            return result
        # As Pydantic AI ends a run on an output tool: the results of the
        # step's calls join the history, so no call is left without one. The
        # request records the stage of the step it ends (``STAGE_KEY``).
        stage = prepared_stage(ctx)
        ctx.messages.append(
            ModelRequest(
                parts=result.request.parts,
                timestamp=datetime.now(UTC),
                run_id=ctx.run_id,
                conversation_id=ctx.conversation_id,
                metadata={STAGE_KEY: stage} if stage is not None else None,
            )
        )
        return End(FinalResult(text))


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
    travels in the user message, the note on the run's stage after the
    conversation), GOAT's tools for the run's surface in a fixed order."""
    agent: Agent[RunDeps, str] = Agent(
        dev_model(model) if isinstance(model, str) else model,
        deps_type=RunDeps,
        instructions=static_instructions(),
        toolsets=[goat_toolset()],
        capabilities=[
            # Earlier answers' long tool results go to the model as counts.
            ProcessHistory(shorten_earlier_results),
            StageNote(),
        ],
        # Also the budget for a tool name the surface does not offer: a history
        # from another page can make the model call one (spec §4.8).
        retries=TOOL_RETRIES,
    )
    agent.output_validator(ends_with_text)
    agent.instrument = instrumentation()
    return agent
