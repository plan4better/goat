"""Earlier answers' tool results and reasoning, trimmed before each model call.

Every model call of an answer sends the whole conversation again. In a long
conversation the search results and the reasoning of earlier answers then make
up most of each call: slower, dearer, and soon past the run's token limit. So
results of earlier answers go to the model shortened to their counts, and
their reasoning is left out; what the answers said, and the items they showed
as cards, stay whole, so a follow-up can still name them. What an answer read
about a dataset (its catalog record, a layer's fields) stays whole up to a
cap, once per call: shortened, the next answer would read it again. The
current answer is never touched (some providers need its reasoning back while
it calls tools), nor is what came before it changed by it, so its calls keep
their cached prefix; the stored history (``assistant.message.model_messages``)
keeps everything.
"""

import json
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    ModelResponse,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

#: Tools whose results are what the user was shown: kept whole.
SHOWN_TOOLS = frozenset(
    {
        "catalog_show_records",
        "core_show_items",
        "ask_user",
        "workflow_create",
        "workflow_create_from_template",
    }
)
#: Tools whose results stay whole in later answers: the cards the user was
#: shown, and loaded skills, which would otherwise be loaded again each turn.
KEPT_TOOLS = SHOWN_TOOLS | {"skills_load"}
#: Tools whose results stay whole in later answers up to ``KEPT_READ_CHARS``:
#: what the answer read about a dataset, which a later answer would otherwise
#: read again. Of the same call made in several earlier answers, the newest
#: result stays whole (``_kept_reads``).
KEPT_READS = frozenset({"catalog_get_record", "project_get_fields"})
#: Every call resends the whole conversation, so a kept result costs its
#: length again in each later call of each later answer. A dataset's record
#: or a layer's fields fit; the record of a bundle, which lists its datasets,
#: grows with them and is shortened as any other result.
KEPT_READ_CHARS = 6000
#: A result this long or shorter is cheaper to keep than to shorten.
SHORT_RESULT_CHARS = 1500
#: A shortened text result keeps its start.
TEXT_KEPT_CHARS = 300
#: A shortened result's scalar values longer than this are left out.
SCALAR_CHARS = 120
SHORTENED = (
    "Result of an earlier answer, shortened to its counts; call the tool again for "
    "the details."
)


def _summary(content: Any) -> Any:
    """The result's counts and short values, without the lists themselves."""
    if isinstance(content, dict):
        summary: dict[str, Any] = {"shortened": SHORTENED}
        for key, value in content.items():
            if isinstance(value, list):
                summary[key] = f"{len(value)} items"
            elif isinstance(value, (int, float, bool)) or value is None:
                summary[key] = value
            elif isinstance(value, str) and len(value) <= SCALAR_CHARS:
                summary[key] = value
        return summary
    if isinstance(content, list):
        return {"shortened": SHORTENED, "items": f"{len(content)} items"}
    text = str(content)
    return f"{text[:TEXT_KEPT_CHARS]}… ({SHORTENED})"


def _shortened(part: ToolReturnPart, keep_read: bool) -> ToolReturnPart:
    if part.tool_name in KEPT_TOOLS:
        return part
    kept = KEPT_READ_CHARS if keep_read else SHORT_RESULT_CHARS
    if len(part.model_response_str()) <= kept:
        return part
    return replace(part, content=_summary(part.content))


def _starts_a_turn(message: ModelMessage) -> bool:
    return isinstance(message, ModelRequest) and any(
        isinstance(part, UserPromptPart) for part in message.parts
    )


def _without_reasoning(message: ModelResponse) -> ModelResponse:
    parts = [part for part in message.parts if not isinstance(part, ThinkingPart)]
    # A response of reasoning only stays as it is: a response needs a part.
    if not parts or len(parts) == len(message.parts):
        return message
    return replace(message, parts=parts)


def _kept_reads(messages: list[ModelMessage]) -> set[int]:
    """The results of ``KEPT_READS`` calls in ``messages`` that stay whole,
    by ``id``: of the same call (tool and arguments), the newest result. A
    result is matched to its call in the response just before it."""
    calls: dict[str, str] = {}
    newest: dict[str, int] = {}
    for message in messages:
        if isinstance(message, ModelResponse):
            calls = {
                part.tool_call_id: (
                    f"{part.tool_name} "
                    f"{json.dumps(part.args_as_dict(), sort_keys=True, default=str)}"
                )
                for part in message.parts
                if isinstance(part, ToolCallPart) and part.tool_name in KEPT_READS
            }
            continue
        for part in message.parts:
            if isinstance(part, ToolReturnPart) and part.tool_name in KEPT_READS:
                newest[calls.get(part.tool_call_id, str(id(part)))] = id(part)
    return set(newest.values())


def shorten_earlier_results(messages: list[ModelMessage]) -> list[ModelMessage]:
    """``messages`` with the long tool results before the newest user message
    shortened and the reasoning there left out. Same messages in the same
    order: only their parts change."""
    current = max(
        (index for index, message in enumerate(messages) if _starts_a_turn(message)),
        default=0,
    )
    kept = _kept_reads(messages[:current])
    out: list[ModelMessage] = []
    for index, message in enumerate(messages):
        if index >= current:
            out.append(message)
            continue
        if isinstance(message, ModelResponse):
            out.append(_without_reasoning(message))
            continue
        parts: list[ModelRequestPart] = [
            _shortened(part, id(part) in kept)
            if isinstance(part, ToolReturnPart)
            else part
            for part in message.parts
        ]
        out.append(replace(message, parts=parts))
    return out
