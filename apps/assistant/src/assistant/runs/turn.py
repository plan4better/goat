"""One answer of the agent, streamed step by step, that ends where a card was shown.

The card's tool tells the model to end its answer, but the agent would still
call the model once more to let it do so: with a model that reasons before it
replies, the answer kept running for many seconds while the card already
waited for the user. A shown card therefore ends the answer before that call.
The tool's result stays in the history, so the next answer sees the card it
asked with. RunManager and the eval harness run the agent through here, so the
evals measure what users get.
"""

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ToolReturnPart,
)
from pydantic_ai.usage import RunUsage, UsageLimits

from assistant.agent import RunDeps
from assistant.asks import ASK_TOOL


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
        async for node in run:
            if asked and Agent.is_model_request_node(node):
                # The request that would go to the model next carries the
                # tools' results; it joins the history without being sent.
                return Turn(messages=[*run.new_messages(), node.request], output=None)
            if Agent.is_model_request_node(node) or Agent.is_call_tools_node(node):
                async with node.stream(run.ctx) as stream:
                    async for event in stream:
                        await on_event(event)
                        asked = asked or card_shown(event)
        if run.result is None:
            raise RuntimeError("the agent run ended without a result")
        return Turn(messages=run.new_messages(), output=str(run.result.output))
