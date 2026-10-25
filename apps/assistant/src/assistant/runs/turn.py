"""One answer of the agent, streamed step by step, that ends where a card was shown.

The card's tool tells the model to end its answer, but the agent would still
call the model once more to let it do so: with a model that reasons before it
replies, the answer kept running for many seconds while the card already
waited for the user. A shown card therefore ends the answer before that call.
The tool's result stays in the history, so the next answer sees the card it
asked with. RunManager and the eval harness run the agent through here, so the
evals measure what users get.

An answer whose model gave no text (only reasoning, or nothing) until
Pydantic AI gave up on it fails, unless its latest finished workflow run's
result is a run of ``workflow_run`` that succeeded and saved layers, with no
text written since: the run card and the layers are there for the user, so
the answer ends with ``NO_ANSWER_CAVEAT`` instead, and the log says why. The
dock shows it in the user's language by its kind, and the next answer reads it
in the history after everything the run found.
"""

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.exceptions import (
    ContentFilterError,
    IncompleteToolCall,
    UnexpectedModelBehavior,
)
from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolReturnPart,
)
from pydantic_ai.usage import RunUsage, UsageLimits

from assistant.agent import RunDeps
from assistant.asks import ASK_TOOL
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.toolset import silent
from assistant.tools.workflow_runs import RUN

logger = logging.getLogger(__name__)

#: The caveat kind of an answer that ends with ``NO_ANSWER_CAVEAT``.
NO_ANSWER = "no_answer"
#: The end of an answer whose model wrote nothing after a workflow run that
#: saved layers. The dock shows the text of its kind (``NO_ANSWER``) in the
#: user's language; this one goes to the model's history.
NO_ANSWER_CAVEAT = (
    "The assistant could not write this answer. The workflow run is shown above, "
    "and the layers it saved are in the project. Ask for the numbers to get them "
    "in a new answer."
)


@dataclass
class Turn:
    #: The answer's own messages, for the conversation's history.
    messages: list[ModelMessage]
    #: The answer the model ended with; None when a shown card ended it.
    output: str | None


def card_shown(event: AgentStreamEvent) -> bool:
    """Whether ``event`` is a card the user was shown (not a refused one)."""
    if not isinstance(event, FunctionToolResultEvent):
        return False
    part = event.part
    if not isinstance(part, ToolReturnPart) or part.tool_name != ASK_TOOL:
        return False
    # The tool layer hands its results on serialized, as the model gets them.
    content = part.content
    status = (
        content.get("status")
        if isinstance(content, dict)
        else getattr(content, "status", None)
    )
    return status == "asked"


async def run_turn(
    agent: Agent[RunDeps, str],
    prompt: str | Sequence[Any],
    *,
    deps: RunDeps,
    on_event: Callable[[AgentStreamEvent], Awaitable[None]],
    message_history: list[ModelMessage] | None = None,
    usage_limits: UsageLimits | None = None,
    usage: RunUsage | None = None,
) -> Turn:
    """Run one answer, handing each streamed event to ``on_event``."""
    asked = False
    async with agent.iter(
        prompt,
        deps=deps,
        message_history=message_history,
        usage_limits=usage_limits,
        usage=usage,
    ) as run:
        try:
            async for node in run:
                if asked and Agent.is_model_request_node(node):
                    # The request that would go to the model next carries the
                    # tools' results; it joins the history without being sent.
                    return Turn(
                        messages=[*run.new_messages(), node.request], output=None
                    )
                if Agent.is_model_request_node(node) or Agent.is_call_tools_node(node):
                    async with node.stream(run.ctx) as stream:
                        async for event in stream:
                            await on_event(event)
                            asked = asked or card_shown(event)
        except UnexpectedModelBehavior as exc:
            closed = _closed_without_text(exc, run.new_messages())
            if closed is None:
                raise
            logger.warning(
                "Message %s: no text after a workflow run that saved layers (%s); "
                "the answer ends with the fixed text",
                deps.message_id,
                exc,
            )
            await deps.emit_data(
                "caveat", {"kind": NO_ANSWER, "text": NO_ANSWER_CAVEAT}
            )
            return Turn(messages=closed, output=NO_ANSWER_CAVEAT)
        if run.result is None:
            raise RuntimeError("the agent run ended without a result")
        return Turn(messages=run.new_messages(), output=str(run.result.output))


def _closed_without_text(
    exc: UnexpectedModelBehavior, messages: list[ModelMessage]
) -> list[ModelMessage] | None:
    """The answer's messages ended with ``NO_ANSWER_CAVEAT``, when ``exc``
    ended with a response without text or a tool call an answer whose
    latest finished workflow run's result is one the dock shows with its run
    card, succeeded and with saved layers, and no text written since; None
    otherwise. A refusal of the provider's filter and a tool call cut off at
    the token limit stay failures."""
    if isinstance(exc, (ContentFilterError, IncompleteToolCall)):
        return None
    last = messages[-1] if messages else None
    if not isinstance(last, ModelResponse) or not silent(last):
        return None
    shown = _shown_run_result(messages)
    if shown is None or any(
        isinstance(message, ModelResponse) and _has_text(message)
        for message in messages[shown:]
    ):
        return None
    ended = replace(last, parts=[*last.parts, TextPart(content=NO_ANSWER_CAVEAT)])
    return [*messages[:-1], ended]


def _shown_run_result(messages: list[ModelMessage]) -> int | None:
    """The index of the message with the answer's latest finished workflow
    run's result (``ToolSpec.report_first``), when it is a result of
    ``workflow_run``, which shows the run card, that succeeded and saved
    layers; None otherwise."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if not isinstance(message, ModelRequest):
            continue
        for part in reversed(message.parts):
            if not isinstance(part, ToolReturnPart) or not isinstance(
                part.content, dict
            ):
                continue
            spec = BY_WIRE_NAME.get(part.tool_name)
            if spec is None or spec.report_first is None:
                continue
            if not spec.report_first(part.content):
                continue
            result = part.content
            if (
                spec is RUN
                and result.get("status") == "succeeded"
                and bool(result.get("saved"))
            ):
                return index
            return None
    return None


def _has_text(response: ModelResponse) -> bool:
    return any(
        isinstance(part, TextPart) and part.content.strip() for part in response.parts
    )
