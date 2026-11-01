"""Pydantic AI stream events → GOAT neutral events.

Pydantic AI has no "step" event: a new model request starts implicitly after
tool results. The translator emits ``StepStarted`` at the beginning and on the
first part of each response that follows tool results. Part indexes restart per
response, so the index → part-id map is reset with each step.
"""

from dataclasses import replace
from typing import cast

from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ToolReturnPart,
)
from pydantic_core import ErrorDetails

from assistant.agent import PartIds
from assistant.asks import ASK_TOOL
from assistant.events import (
    RunEvent,
    StepStarted,
    TextDelta,
    TextEnded,
    TextStarted,
    ToolCalled,
    ToolFailed,
    ToolReturned,
)


class EventTranslator:
    def __init__(self, part_ids: PartIds) -> None:
        self._part_ids = part_ids
        self._text_parts: dict[int, str] = {}
        self._needs_step = True

    def _step(self) -> list[RunEvent]:
        if not self._needs_step:
            return []
        self._needs_step = False
        self._text_parts.clear()
        return [StepStarted()]

    def translate(self, event: AgentStreamEvent) -> list[RunEvent]:
        if isinstance(event, PartStartEvent):
            out = self._step()
            if isinstance(event.part, TextPart):
                part_id = self._part_ids.next()
                self._text_parts[event.index] = part_id
                out.append(TextStarted(part_id=part_id))
                if event.part.content:
                    out.append(TextDelta(part_id=part_id, delta=event.part.content))
            return out
        if isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
            open_id = self._text_parts.get(event.index)
            if open_id is None or not event.delta.content_delta:
                return []
            return [TextDelta(part_id=open_id, delta=event.delta.content_delta)]
        if isinstance(event, PartEndEvent) and isinstance(event.part, TextPart):
            ended_id = self._text_parts.get(event.index)
            return [TextEnded(part_id=ended_id)] if ended_id else []
        if isinstance(event, FunctionToolCallEvent):
            out = self._step()
            out.append(
                ToolCalled(
                    tool_call_id=event.part.tool_call_id,
                    tool_name=event.part.tool_name,
                    args=event.part.args_as_dict(),
                )
            )
            return out
        if isinstance(event, FunctionToolResultEvent):
            self._needs_step = True
            if isinstance(event.part, ToolReturnPart):
                # A tool that raised ToolFailed, and denied or interrupted calls,
                # arrive as a return part with a non-success outcome.
                if event.part.outcome != "success":
                    return [
                        ToolFailed(
                            tool_call_id=event.tool_call_id,
                            error=event.part.model_response_str(wrap_if_error=False),
                        )
                    ]
                return [
                    ToolReturned(
                        tool_call_id=event.tool_call_id,
                        output=event.part.model_response_object(),
                    )
                ]
            if isinstance(event.part, RetryPromptPart):
                return [
                    ToolFailed(
                        tool_call_id=event.tool_call_id,
                        error=_retry_text(event.part),
                    )
                ]
        return []


def _retry_text(part: RetryPromptPart) -> str:
    """The retry as the web sees it. Arguments that are not JSON fail in
    pydantic-ai's own validation, whose errors carry the raw arguments as
    ``input``: for an ask card those hold the option values, which stay on the
    server (``assistant.asks``). The model still gets the whole retry, from the
    message history."""
    if part.tool_name != ASK_TOOL or isinstance(part.content, str):
        return part.model_response()
    errors = [
        cast(
            ErrorDetails, {key: value for key, value in error.items() if key != "input"}
        )
        for error in part.content
    ]
    return replace(part, content=errors).model_response()
