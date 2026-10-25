"""GOAT's own event format for agent runs.

Stored in ``assistant.run_event`` and folded into ``assistant.message.parts``.
Deliberately independent of any wire protocol: ``assistant.encoding`` turns
these into the AI SDK stream when sending, so a protocol switch only changes
the encoder and old conversations stay replayable (spec §6.2).
"""

from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter

from assistant.asks import public_args


class RunStarted(BaseModel):
    type: Literal["run_started"] = "run_started"
    message_id: str


class StepStarted(BaseModel):
    type: Literal["step_started"] = "step_started"


class TextStarted(BaseModel):
    type: Literal["text_started"] = "text_started"
    part_id: str


class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    part_id: str
    delta: str


class TextEnded(BaseModel):
    type: Literal["text_ended"] = "text_ended"
    part_id: str


class ToolCalled(BaseModel):
    type: Literal["tool_called"] = "tool_called"
    tool_call_id: str
    tool_name: str
    args: dict[str, Any]


class ToolReturned(BaseModel):
    type: Literal["tool_returned"] = "tool_returned"
    tool_call_id: str
    output: Any


class ToolFailed(BaseModel):
    type: Literal["tool_failed"] = "tool_failed"
    tool_call_id: str
    error: str


class ToolApprovalRequested(BaseModel):
    type: Literal["tool_approval_requested"] = "tool_approval_requested"
    tool_call_id: str
    approval_id: str


class DataPart(BaseModel):
    """A GOAT-specific part: a proposal, a caveat, a job note (spec §6.2)."""

    type: Literal["data"] = "data"
    name: str
    part_id: str
    data: dict[str, Any]


class UsageReported(BaseModel):
    type: Literal["usage"] = "usage"
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    #: The provider type of the connection that served the run (spec §10 per-answer details).
    provider: str | None = None


RunStatus = Literal["succeeded", "failed", "cancelled", "interrupted"]

#: Why a failed run failed. The web app shows its own text for each code (EN/DE);
#: the English ``error`` stays for logs and for clients without a translation.
RunErrorCode = Literal[
    "run_timeout",
    "run_limit",
    "internal_error",
    "ai_unavailable",
    "provider_unreachable",
    "provider_busy",
    "provider_error",
    "goat_ai_unreachable",
    "goat_ai_busy",
    "goat_ai_error",
]


class RunEnded(BaseModel):
    type: Literal["run_ended"] = "run_ended"
    status: RunStatus
    error: str | None = None
    code: RunErrorCode | None = None


RunEvent = Annotated[
    RunStarted
    | StepStarted
    | TextStarted
    | TextDelta
    | TextEnded
    | ToolCalled
    | ToolReturned
    | ToolFailed
    | ToolApprovalRequested
    | DataPart
    | UsageReported
    | RunEnded,
    Field(discriminator="type"),
]

EVENT_ADAPTER: TypeAdapter[RunEvent] = TypeAdapter(RunEvent)


def fold_parts(events: list[RunEvent]) -> list[dict[str, Any]]:
    """Collapse a run's events into the stored, neutral message parts.

    Order follows first appearance. A run that did not succeed gets a trailing
    ``run_status`` part with its code, so a reloaded transcript says why it
    stopped; usage is kept as one ``usage`` part for the per-answer details.
    """
    parts: list[dict[str, Any]] = []
    texts: dict[str, dict[str, Any]] = {}
    tools: dict[str, dict[str, Any]] = {}
    usage: dict[str, Any] | None = None
    for event in events:
        if isinstance(event, TextStarted):
            texts[event.part_id] = {"type": "text", "id": event.part_id, "text": ""}
            parts.append(texts[event.part_id])
        elif isinstance(event, TextDelta):
            if event.part_id not in texts:
                texts[event.part_id] = {"type": "text", "id": event.part_id, "text": ""}
                parts.append(texts[event.part_id])
            texts[event.part_id]["text"] += event.delta
        elif isinstance(event, ToolCalled):
            tools[event.tool_call_id] = {
                "type": "tool",
                "tool_call_id": event.tool_call_id,
                "tool_name": event.tool_name,
                "args": event.args,
                "state": "called",
                "output": None,
                "error": None,
            }
            parts.append(tools[event.tool_call_id])
        elif isinstance(event, ToolReturned) and event.tool_call_id in tools:
            tools[event.tool_call_id].update(state="output", output=event.output)
        elif isinstance(event, ToolFailed) and event.tool_call_id in tools:
            tools[event.tool_call_id].update(state="error", error=event.error)
        elif isinstance(event, ToolApprovalRequested) and event.tool_call_id in tools:
            tools[event.tool_call_id].update(
                state="approval_requested", approval_id=event.approval_id
            )
        elif isinstance(event, DataPart):
            # A part sent again under its id (a run's progress) replaces the
            # earlier one where it stood, as the web app's stream does.
            earlier = next(
                (
                    part
                    for part in parts
                    if part.get("type") == "data" and part.get("id") == event.part_id
                ),
                None,
            )
            if earlier is not None:
                earlier.update(name=event.name, data=event.data)
            else:
                parts.append(
                    {
                        "type": "data",
                        "name": event.name,
                        "id": event.part_id,
                        "data": event.data,
                    }
                )
        elif isinstance(event, UsageReported):
            # One usage part per message: per-answer details show the run's total
            # (spec §10), and the model of the last report.
            if usage is None:
                usage = {
                    "type": "usage",
                    "model": event.model,
                    "provider": event.provider,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                }
                parts.append(usage)
            usage["model"] = event.model
            usage["provider"] = event.provider
            usage["input_tokens"] += event.input_tokens
            usage["output_tokens"] += event.output_tokens
            usage["cache_read_tokens"] += event.cache_read_tokens
            usage["cache_write_tokens"] += event.cache_write_tokens
        elif isinstance(event, RunEnded) and event.status != "succeeded":
            parts.append(
                {
                    "type": "run_status",
                    "status": event.status,
                    "error": event.error,
                    "code": event.code,
                }
            )
    return parts


_TOOL_STATES = {
    "called": "input-available",
    "output": "output-available",
    "error": "output-error",
    "approval_requested": "approval-requested",
}


def to_ui_message(
    message_id: str,
    role: str,
    parts: list[dict[str, Any]],
    created_at: datetime | None = None,
) -> dict[str, Any]:
    """Render stored neutral parts as an AI SDK ``UIMessage`` for ``useChat``.

    Tools render as ``dynamic-tool`` parts: the web app does not declare tool
    types statically, so every GOAT tool is dynamic from its point of view.
    ``created_at`` (the message's time) goes into the metadata as ISO 8601 in
    UTC to the millisecond, for the time the dock shows under the message.
    """
    ui_parts: list[dict[str, Any]] = []
    metadata: dict[str, Any] | None = None
    for part in parts:
        if part["type"] == "text":
            ui_parts.append({"type": "text", "text": part["text"], "state": "done"})
        elif part["type"] == "tool":
            ui_part: dict[str, Any] = {
                "type": "dynamic-tool",
                "toolName": part["tool_name"],
                "toolCallId": part["tool_call_id"],
                "state": _TOOL_STATES[part["state"]],
                "input": public_args(part["tool_name"], part["args"]),
            }
            if part["state"] == "output":
                ui_part["output"] = part["output"]
            if part["state"] == "error":
                ui_part["errorText"] = part["error"]
            if part["state"] == "approval_requested":
                ui_part["approval"] = {"id": part["approval_id"]}
            ui_parts.append(ui_part)
        elif part["type"] == "data":
            ui_parts.append(
                {"type": f"data-{part['name']}", "id": part["id"], "data": part["data"]}
            )
        elif part["type"] == "run_status":
            ui_parts.append(
                {
                    "type": "data-run-status",
                    "data": {
                        "status": part["status"],
                        "error": part["error"],
                        # Parts folded before codes existed have none.
                        "code": part.get("code"),
                    },
                }
            )
        elif part["type"] == "usage":
            # The live stream carries usage as message metadata; a reloaded
            # message carries it the same way (keys as in UsageReported).
            metadata = {
                **(metadata or {}),
                "usage": {key: value for key, value in part.items() if key != "type"},
            }
        elif part["type"] == "user_text":
            ui_parts.append({"type": "text", "text": part["text"]})
        elif part["type"] == "context":
            # The page context the message was sent with (spec §6.3); the dock
            # renders it as context chips when a conversation is reopened.
            ui_parts.append({"type": "data-context", "data": part["context"]})
        elif part["type"] == "answer":
            # The user's answer to a card (assistant.asks): the dock shows the
            # card answered from it.
            metadata = {**(metadata or {}), "answer": part["answer"]}
    if created_at is not None:
        metadata = {
            **(metadata or {}),
            "created_at": created_at.astimezone(timezone.utc).isoformat(
                timespec="milliseconds"
            ),
        }
    message: dict[str, Any] = {"id": message_id, "role": role, "parts": ui_parts}
    if metadata is not None:
        message["metadata"] = metadata
    return message
