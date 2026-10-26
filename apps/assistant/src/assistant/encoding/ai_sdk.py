"""Neutral run events → Vercel AI SDK UI message stream (v7; wire equals v6).

The only module that knows the wire protocol (spec §6.2). Chunk shapes follow
Pydantic AI's Vercel adapter (``pydantic_ai.ui.vercel_ai.response_types``),
which is the reference; the web contract test is what proves them.
"""

import json
from collections.abc import Iterable
from typing import Any

from assistant.asks import public_args
from assistant.events import (
    DataPart,
    RunEnded,
    RunEvent,
    RunStarted,
    StepStarted,
    TextDelta,
    TextEnded,
    TextStarted,
    ToolApprovalRequested,
    ToolCalled,
    ToolFailed,
    ToolReturned,
    UsageReported,
)

UI_MESSAGE_STREAM_HEADERS: dict[str, str] = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    # Proxies (nginx, Caddy) must not buffer the stream.
    "x-accel-buffering": "no",
}

SSE_DONE = "data: [DONE]\n\n"


def sse(chunk: dict[str, Any]) -> str:
    return f"data: {json.dumps(chunk, separators=(',', ':'), default=str)}\n\n"


class AiSdkEncoder:
    """Stateful per stream: it closes an open step before the next one or the end."""

    def __init__(self) -> None:
        self._step_open = False

    def _close_step(self) -> list[dict[str, Any]]:
        if not self._step_open:
            return []
        self._step_open = False
        return [{"type": "finish-step"}]

    def encode(self, event: RunEvent) -> list[dict[str, Any]]:
        if isinstance(event, RunStarted):
            start: dict[str, Any] = {"type": "start", "messageId": event.message_id}
            if event.run_id is not None:
                start["messageMetadata"] = {"run_id": event.run_id}
            return [start]
        if isinstance(event, StepStarted):
            chunks = self._close_step()
            self._step_open = True
            return [*chunks, {"type": "start-step"}]
        if isinstance(event, TextStarted):
            return [{"type": "text-start", "id": event.part_id}]
        if isinstance(event, TextDelta):
            return [{"type": "text-delta", "id": event.part_id, "delta": event.delta}]
        if isinstance(event, TextEnded):
            return [{"type": "text-end", "id": event.part_id}]
        if isinstance(event, ToolCalled):
            return [
                {
                    "type": "tool-input-start",
                    "toolCallId": event.tool_call_id,
                    "toolName": event.tool_name,
                    "dynamic": True,
                },
                {
                    "type": "tool-input-available",
                    "toolCallId": event.tool_call_id,
                    "toolName": event.tool_name,
                    "input": public_args(event.tool_name, event.args),
                    "dynamic": True,
                },
            ]
        if isinstance(event, ToolReturned):
            return [
                {
                    "type": "tool-output-available",
                    "toolCallId": event.tool_call_id,
                    "output": event.output,
                    "dynamic": True,
                }
            ]
        if isinstance(event, ToolFailed):
            return [
                {
                    "type": "tool-output-error",
                    "toolCallId": event.tool_call_id,
                    "errorText": event.error,
                    "dynamic": True,
                }
            ]
        if isinstance(event, ToolApprovalRequested):
            return [
                {
                    "type": "tool-approval-request",
                    "approvalId": event.approval_id,
                    "toolCallId": event.tool_call_id,
                }
            ]
        if isinstance(event, DataPart):
            return [
                {"type": f"data-{event.name}", "id": event.part_id, "data": event.data}
            ]
        if isinstance(event, UsageReported):
            return [
                {
                    "type": "message-metadata",
                    "messageMetadata": {"usage": event.model_dump(exclude={"type"})},
                }
            ]
        if isinstance(event, RunEnded):
            chunks = self._close_step()
            if event.status == "succeeded":
                return [*chunks, {"type": "finish"}]
            # The part a reloaded message has (``to_ui_message``): the live answer
            # and the stored one end the same way, and the dock reads one part.
            status_part = {
                "type": "data-run-status",
                "data": {
                    "status": event.status,
                    "error": event.error,
                    "code": event.code,
                },
            }
            if event.status == "failed":
                return [
                    *chunks,
                    status_part,
                    {"type": "error", "errorText": event.error or "The run failed."},
                ]
            return [*chunks, status_part, {"type": "abort"}]
        raise TypeError(f"Unhandled event {type(event).__name__}")


def encode_stream(events: Iterable[RunEvent]) -> str:
    """A complete SSE body for a finished event list (used by fixtures and tests)."""
    encoder = AiSdkEncoder()
    lines: list[str] = []
    for event in events:
        for chunk in encoder.encode(event):
            lines.append(sse(chunk))
    body = "".join(lines)
    return body + SSE_DONE
