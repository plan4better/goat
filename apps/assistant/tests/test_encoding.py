import json

from assistant.encoding.ai_sdk import SSE_DONE, AiSdkEncoder, encode_stream, sse
from assistant.encoding.fixtures import FIXTURE_DIR, SCENARIOS, render_fixture
from assistant.events import (
    DataPart,
    RunEnded,
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


def test_text_run_encodes_start_step_text_and_finish() -> None:
    encoder = AiSdkEncoder()
    chunks = [
        chunk
        for event in [
            RunStarted(message_id="m1"),
            StepStarted(),
            TextStarted(part_id="m1:1"),
            TextDelta(part_id="m1:1", delta="Hi"),
            TextEnded(part_id="m1:1"),
            RunEnded(status="succeeded"),
        ]
        for chunk in encoder.encode(event)
    ]
    assert chunks == [
        {"type": "start", "messageId": "m1"},
        {"type": "start-step"},
        {"type": "text-start", "id": "m1:1"},
        {"type": "text-delta", "id": "m1:1", "delta": "Hi"},
        {"type": "text-end", "id": "m1:1"},
        {"type": "finish-step"},
        {"type": "finish"},
    ]


def test_tool_data_and_approval_chunks() -> None:
    encoder = AiSdkEncoder()
    assert encoder.encode(
        ToolCalled(tool_call_id="c1", tool_name="catalog_search", args={"q": "x"})
    ) == [
        {
            "type": "tool-input-start",
            "toolCallId": "c1",
            "toolName": "catalog_search",
            "dynamic": True,
        },
        {
            "type": "tool-input-available",
            "toolCallId": "c1",
            "toolName": "catalog_search",
            "input": {"q": "x"},
            "dynamic": True,
        },
    ]
    assert encoder.encode(ToolReturned(tool_call_id="c1", output=[1])) == [
        {
            "type": "tool-output-available",
            "toolCallId": "c1",
            "output": [1],
            "dynamic": True,
        }
    ]
    assert encoder.encode(
        ToolApprovalRequested(tool_call_id="c1", approval_id="a1")
    ) == [{"type": "tool-approval-request", "approvalId": "a1", "toolCallId": "c1"}]
    assert encoder.encode(DataPart(name="proposal", part_id="m1:2", data={"k": 1})) == [
        {"type": "data-proposal", "id": "m1:2", "data": {"k": 1}}
    ]


def test_cancelled_and_failed_runs_end_with_a_run_status_part() -> None:
    """The live stream ends with the part a reloaded message has."""
    assert AiSdkEncoder().encode(RunEnded(status="cancelled")) == [
        {
            "type": "data-run-status",
            "data": {"status": "cancelled", "error": None, "code": None},
        },
        {"type": "abort"},
    ]
    assert AiSdkEncoder().encode(
        RunEnded(status="failed", error="boom", code="internal_error")
    ) == [
        {
            "type": "data-run-status",
            "data": {"status": "failed", "error": "boom", "code": "internal_error"},
        },
        {"type": "error", "errorText": "boom"},
    ]


def test_usage_stays_message_metadata() -> None:
    assert AiSdkEncoder().encode(
        UsageReported(model="m", provider="test", input_tokens=3, output_tokens=2)
    ) == [
        {
            "type": "message-metadata",
            "messageMetadata": {
                "usage": {
                    "model": "m",
                    "input_tokens": 3,
                    "output_tokens": 2,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "provider": "test",
                }
            },
        }
    ]


def test_the_start_names_the_run_as_message_metadata() -> None:
    # The dock's Undo of a live answer names its run.
    assert AiSdkEncoder().encode(RunStarted(message_id="m1", run_id="r1")) == [
        {"type": "start", "messageId": "m1", "messageMetadata": {"run_id": "r1"}}
    ]


def test_sse_framing() -> None:
    assert sse({"type": "finish"}) == 'data: {"type":"finish"}\n\n'
    assert SSE_DONE == "data: [DONE]\n\n"
    body = encode_stream([RunStarted(message_id="m1"), RunEnded(status="succeeded")])
    lines = [line for line in body.split("\n\n") if line]
    assert lines[-1] == "data: [DONE]"
    assert json.loads(lines[0].removeprefix("data: ")) == {
        "type": "start",
        "messageId": "m1",
    }


def test_golden_fixtures_are_up_to_date() -> None:
    """The web contract test parses these files; regenerate with
    ``uv run python -m assistant.encoding.fixtures`` after changing the encoder."""
    for name in SCENARIOS:
        path = FIXTURE_DIR / f"{name}.sse"
        assert path.read_text() == render_fixture(name), f"{path} is stale"
