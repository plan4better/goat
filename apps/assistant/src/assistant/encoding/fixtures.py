"""Golden streams shared with the web contract test (spec §6.2, Task 2).

Regenerate after any encoder change:
``uv run python -m assistant.encoding.fixtures`` (from the repo root or apps/assistant).
"""

from pathlib import Path

from assistant.encoding.ai_sdk import encode_stream
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
    ToolReturned,
    UsageReported,
)

FIXTURE_DIR = (
    Path(__file__).resolve().parents[4]
    / "web"
    / "lib"
    / "assistant"
    / "__tests__"
    / "fixtures"
)

_M = "0b3c6f0e-6a1d-4b8f-9a77-1d2f3e4a5b6c"
_R = "5d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a"

SCENARIOS: dict[str, list[RunEvent]] = {
    "text_only": [
        RunStarted(message_id=_M, run_id=_R),
        StepStarted(),
        TextStarted(part_id=f"{_M}:1"),
        TextDelta(part_id=f"{_M}:1", delta="Three datasets "),
        TextDelta(part_id=f"{_M}:1", delta="match."),
        TextEnded(part_id=f"{_M}:1"),
        UsageReported(model="test", input_tokens=10, output_tokens=4),
        RunEnded(status="succeeded"),
    ],
    "tool_and_proposal": [
        RunStarted(message_id=_M),
        StepStarted(),
        ToolCalled(
            tool_call_id="call-1", tool_name="catalog_search", args={"q": "radverkehr"}
        ),
        ToolReturned(tool_call_id="call-1", output={"numberMatched": 3}),
        StepStarted(),
        DataPart(
            name="proposal",
            part_id=f"{_M}:1",
            data={
                "title": "Put these on the page",
                "rows": [{"k": "SEARCH", "v": "Berlin"}],
            },
        ),
        TextStarted(part_id=f"{_M}:2"),
        TextDelta(part_id=f"{_M}:2", delta="Done."),
        TextEnded(part_id=f"{_M}:2"),
        RunEnded(status="succeeded"),
    ],
    "approval": [
        RunStarted(message_id=_M),
        StepStarted(),
        ToolCalled(
            tool_call_id="call-9", tool_name="analysis_start", args={"tool": "buffer"}
        ),
        ToolApprovalRequested(tool_call_id="call-9", approval_id="approval-9"),
        RunEnded(status="succeeded"),
    ],
    "cancelled": [
        RunStarted(message_id=_M),
        StepStarted(),
        TextStarted(part_id=f"{_M}:1"),
        TextDelta(part_id=f"{_M}:1", delta="Partial"),
        RunEnded(status="cancelled"),
    ],
    "failed": [
        RunStarted(message_id=_M),
        StepStarted(),
        RunEnded(
            status="failed",
            error="Your organization's AI provider isn't reachable.",
            code="provider_unreachable",
        ),
    ],
}


def render_fixture(name: str) -> str:
    return encode_stream(SCENARIOS[name])


def write_fixtures() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for name in SCENARIOS:
        (FIXTURE_DIR / f"{name}.sse").write_text(render_fixture(name))


if __name__ == "__main__":
    write_fixtures()
