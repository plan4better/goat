from datetime import datetime, timedelta, timezone

from assistant.events import (
    EVENT_ADAPTER,
    DataPart,
    RunEnded,
    RunStarted,
    TextDelta,
    TextEnded,
    TextStarted,
    ToolCalled,
    ToolReturned,
    UsageReported,
    fold_parts,
    to_ui_message,
)


def test_event_round_trips_through_the_adapter() -> None:
    event = ToolCalled(tool_call_id="c1", tool_name="catalog_search", args={"q": "rad"})
    dumped = EVENT_ADAPTER.dump_python(event, mode="json")
    assert dumped["type"] == "tool_called"
    assert EVENT_ADAPTER.validate_python(dumped) == event


def test_fold_parts_concatenates_text_and_keeps_order() -> None:
    events = [
        RunStarted(message_id="m1"),
        TextStarted(part_id="m1:1"),
        TextDelta(part_id="m1:1", delta="Hel"),
        TextDelta(part_id="m1:1", delta="lo"),
        TextEnded(part_id="m1:1"),
        ToolCalled(tool_call_id="c1", tool_name="catalog_search", args={"q": "rad"}),
        ToolReturned(tool_call_id="c1", output={"count": 3}),
        DataPart(name="proposal", part_id="m1:2", data={"title": "Filters"}),
        RunEnded(status="succeeded"),
    ]
    assert fold_parts(events) == [
        {"type": "text", "id": "m1:1", "text": "Hello"},
        {
            "type": "tool",
            "tool_call_id": "c1",
            "tool_name": "catalog_search",
            "args": {"q": "rad"},
            "state": "output",
            "output": {"count": 3},
            "error": None,
        },
        {
            "type": "data",
            "name": "proposal",
            "id": "m1:2",
            "data": {"title": "Filters"},
        },
    ]


def test_fold_parts_marks_an_unfinished_run() -> None:
    events = [RunStarted(message_id="m1"), RunEnded(status="interrupted")]
    assert fold_parts(events) == [
        {"type": "run_status", "status": "interrupted", "error": None, "code": None}
    ]


def test_fold_parts_keeps_the_failure_code() -> None:
    events = [
        RunStarted(message_id="m1"),
        RunEnded(status="failed", error="slow", code="run_timeout"),
    ]
    assert fold_parts(events)[-1] == {
        "type": "run_status",
        "status": "failed",
        "error": "slow",
        "code": "run_timeout",
    }


def test_fold_parts_keeps_one_usage_part_with_summed_tokens() -> None:
    events = [
        RunStarted(message_id="m1"),
        UsageReported(model="a", provider="p", input_tokens=10, output_tokens=4),
        UsageReported(
            model="b",
            provider="p",
            input_tokens=5,
            output_tokens=1,
            cache_read_tokens=2,
        ),
        RunEnded(status="succeeded"),
    ]
    assert fold_parts(events) == [
        {
            "type": "usage",
            "model": "b",
            "provider": "p",
            "input_tokens": 15,
            "output_tokens": 5,
            "cache_read_tokens": 2,
            "cache_write_tokens": 0,
        }
    ]


def test_to_ui_message_puts_usage_into_metadata_and_keeps_the_code() -> None:
    parts = [
        {"type": "text", "id": "m1:1", "text": "Hi"},
        {
            "type": "usage",
            "model": "m",
            "provider": "test",
            "input_tokens": 3,
            "output_tokens": 2,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        },
        {
            "type": "run_status",
            "status": "failed",
            "error": "slow",
            "code": "run_timeout",
        },
    ]
    message = to_ui_message("m1", "assistant", parts)
    assert message["metadata"] == {
        "usage": {
            "model": "m",
            "provider": "test",
            "input_tokens": 3,
            "output_tokens": 2,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
    }
    assert message["parts"] == [
        {"type": "text", "text": "Hi", "state": "done"},
        {
            "type": "data-run-status",
            "data": {"status": "failed", "error": "slow", "code": "run_timeout"},
        },
    ]
    # Parts stored before codes existed still render.
    old = to_ui_message(
        "m2",
        "assistant",
        [{"type": "run_status", "status": "cancelled", "error": None}],
    )
    assert old["parts"][0]["data"] == {
        "status": "cancelled",
        "error": None,
        "code": None,
    }
    assert "metadata" not in old


def test_to_ui_message_maps_neutral_parts() -> None:
    parts = [
        {"type": "text", "id": "m1:1", "text": "Hello"},
        {
            "type": "tool",
            "tool_call_id": "c1",
            "tool_name": "catalog_search",
            "args": {"q": "rad"},
            "state": "output",
            "output": {"count": 3},
            "error": None,
        },
        {
            "type": "data",
            "name": "proposal",
            "id": "m1:2",
            "data": {"title": "Filters"},
        },
    ]
    assert to_ui_message("m1", "assistant", parts) == {
        "id": "m1",
        "role": "assistant",
        "parts": [
            {"type": "text", "text": "Hello", "state": "done"},
            {
                "type": "dynamic-tool",
                "toolName": "catalog_search",
                "toolCallId": "c1",
                "state": "output-available",
                "input": {"q": "rad"},
                "output": {"count": 3},
            },
            {"type": "data-proposal", "id": "m1:2", "data": {"title": "Filters"}},
        ],
    }


def test_to_ui_message_keeps_the_user_text_and_page_context() -> None:
    parts = [
        {"type": "user_text", "text": "find bike data"},
        {"type": "context", "context": {"surface": "catalog", "search": "Berlin"}},
    ]
    assert to_ui_message("u1", "user", parts)["parts"] == [
        {"type": "text", "text": "find bike data"},
        {"type": "data-context", "data": {"surface": "catalog", "search": "Berlin"}},
    ]


def test_to_ui_message_carries_the_stored_time_in_utc() -> None:
    usage = {
        "type": "usage",
        "model": "m",
        "provider": None,
        "input_tokens": 1,
        "output_tokens": 1,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }
    # An aware time in another zone (asyncpg itself returns UTC), with the
    # microseconds a row has: the dock gets UTC to the millisecond, the precision
    # every browser parses.
    created = datetime(
        2026, 10, 19, 10, 8, 30, 123456, tzinfo=timezone(timedelta(hours=2))
    )
    answer = to_ui_message("m1", "assistant", [usage], created_at=created)
    assert answer["metadata"]["created_at"] == "2026-10-19T08:08:30.123+00:00"
    # The other metadata stays.
    assert answer["metadata"]["usage"]["model"] == "m"
    user = to_ui_message(
        "u1", "user", [{"type": "user_text", "text": "hi"}], created_at=created
    )
    assert user["metadata"] == {"created_at": "2026-10-19T08:08:30.123+00:00"}
    # Without a time the message has no metadata at all.
    assert "metadata" not in to_ui_message(
        "u2", "user", [{"type": "user_text", "text": "hi"}]
    )


def test_fold_parts_keeps_the_last_data_part_of_an_id() -> None:
    """A run's progress is sent again under its id; the stored message keeps
    one part with the last data, where the first one stood."""
    events = [
        DataPart(
            name="workflow-run",
            part_id="workflow-run:j1",
            data={"status": "running", "done": 0},
        ),
        TextStarted(part_id="t1"),
        TextDelta(part_id="t1", delta="Läuft."),
        DataPart(
            name="workflow-run",
            part_id="workflow-run:j1",
            data={"status": "succeeded", "done": 2},
        ),
    ]
    parts = fold_parts(events)
    data = [part for part in parts if part["type"] == "data"]
    assert data == [
        {
            "type": "data",
            "name": "workflow-run",
            "id": "workflow-run:j1",
            "data": {"status": "succeeded", "done": 2},
        }
    ]
    assert parts[0]["type"] == "data"
