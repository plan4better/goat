"""Syncing a task's schedule to Windmill keeps what operators set there.

Whether a schedule runs, the arguments it runs with (a base-data mirror, a
bounding box), a pause and error handlers are set in the Windmill UI. A sync
runs on every deploy and must update the cron, not reset those. Windmill's
update replaces every field it does not receive.
"""

import json
import logging
from typing import Any

import httpx
import pytest
from goatlib.tasks.registry import TASK_REGISTRY
from goatlib.tasks.sync_windmill import WindmillTaskSyncer, generate_task_script

from ..windmill_fake import GENERATE_THUMBNAILS_AS_READ, FakeWindmill

SCHEDULED = next(t for t in TASK_REGISTRY if t.schedule)


def _syncer(
    existing: dict[str, Any] | None, after: dict[str, Any] | None = None
) -> tuple[WindmillTaskSyncer, list]:
    """A syncer against a fake Windmill holding `existing` as the schedule, and
    `after` once it was updated (default: the update as sent)."""
    sent: list[tuple[str, dict[str, Any]]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/schedules/get/" in path:
            if existing is None:
                return httpx.Response(404)
            if sent:
                return httpx.Response(200, json=after or {**existing, **sent[-1][1]})
            return httpx.Response(200, json=existing)
        sent.append((path, json.loads(request.content)))
        return httpx.Response(200, json={})

    syncer = WindmillTaskSyncer("http://windmill.test", "token")
    syncer.client = httpx.Client(transport=httpx.MockTransport(handle))
    return syncer, sent


@pytest.mark.unit
def test_an_update_keeps_the_arguments_set_in_windmill() -> None:
    args = {"source": "s3://mirror/goat-base-data/", "bbox": [11.4, 48.0, 11.8, 48.3]}
    syncer, sent = _syncer({"args": args, "enabled": True, "schedule": "0 0 1 * * *"})

    assert syncer._create_or_update_schedule(SCHEDULED) is not None

    ((path, body),) = sent
    assert "/schedules/update/" in path
    assert body["args"] == args
    assert "enabled" not in body


@pytest.mark.unit
def test_an_update_keeps_a_pause_and_error_handling() -> None:
    kept = {
        "paused_until": "2026-11-01T00:00:00Z",
        "on_failure": "script/f/goat/notify",
        "on_failure_times": 2,
        "retry": {"constant": {"attempts": 3, "seconds": 60}},
        "no_flow_overlap": True,
        "tag": "tools",
    }
    syncer, sent = _syncer(
        {**kept, "args": {}, "enabled": True, "schedule": "0 0 1 * * *"}
    )

    syncer._create_or_update_schedule(SCHEDULED)

    ((_, body),) = sent
    assert {k: body[k] for k in kept} == kept
    assert body["schedule"] == SCHEDULED.schedule


@pytest.mark.unit
def test_an_update_keeps_who_the_schedule_runs_as() -> None:
    syncer, sent = _syncer(
        {"args": {}, "schedule": "0 0 1 * * *", "permissioned_as": "u/operator"}
    )

    syncer._create_or_update_schedule(SCHEDULED)

    ((_, body),) = sent
    assert body["permissioned_as"] == "u/operator"
    assert body["preserve_permissioned_as"] is True


@pytest.mark.unit
def test_a_schedule_without_a_run_as_user_sends_none() -> None:
    syncer, sent = _syncer({"args": {}, "schedule": "0 0 1 * * *"})

    syncer._create_or_update_schedule(SCHEDULED)

    ((_, body),) = sent
    assert "permissioned_as" not in body
    assert "preserve_permissioned_as" not in body


@pytest.mark.unit
def test_a_run_as_user_windmill_did_not_keep_is_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    existing = {"args": {}, "schedule": "0 0 1 * * *", "permissioned_as": "u/operator"}
    syncer, _ = _syncer(existing, after={**existing, "permissioned_as": "u/syncer"})

    syncer._create_or_update_schedule(SCHEDULED)

    assert "now runs as u/syncer instead of u/operator" in caplog.text


@pytest.mark.unit
def test_an_unchanged_schedule_is_not_updated() -> None:
    syncer, sent = _syncer({"schedule": SCHEDULED.schedule, "timezone": "UTC"})

    assert syncer._create_or_update_schedule(SCHEDULED) is not None

    assert sent == []


@pytest.mark.unit
def test_a_new_schedule_starts_with_no_arguments() -> None:
    syncer, sent = _syncer(None)

    assert syncer._create_or_update_schedule(SCHEDULED) is not None

    ((path, body),) = sent
    assert "/schedules/create" in path
    assert body["args"] == {}


# A task's script is written in place, as a tool's is: never deleted, a new
# version only when it changed (tests/unit/tools/test_windmill_scripts.py).

TASK_PATHS = [t.windmill_path for t in TASK_REGISTRY]
SCHEDULE_PATH = f"f/goat/schedules/{SCHEDULED.name}"
UNCHANGED_SCHEDULE = {"schedule": SCHEDULED.schedule, "timezone": "UTC"}


def _task_syncer(windmill: FakeWindmill) -> WindmillTaskSyncer:
    syncer = WindmillTaskSyncer("http://windmill.test", "token")
    syncer.client = windmill.client()
    return syncer


def _scheduled_as_read(**changes: Any) -> dict[str, Any]:
    """The scheduled task's script as Windmill reads it back once the sync
    wrote it from this goatlib, with ``changes`` made to it since."""
    assert GENERATE_THUMBNAILS_AS_READ["path"] == SCHEDULED.windmill_path
    return {
        **GENERATE_THUMBNAILS_AS_READ,
        "content": generate_task_script(SCHEDULED),
        **changes,
    }


@pytest.mark.unit
def test_a_missing_task_script_is_created_without_a_parent() -> None:
    windmill = FakeWindmill()

    result = _task_syncer(windmill).sync_task(SCHEDULED)

    assert result["status"] == "synced"
    (body,) = windmill.created
    assert body["path"] == SCHEDULED.windmill_path
    assert "parent_hash" not in body
    assert "auto_parent" not in body
    assert windmill.writes() == ["scripts/create", "schedules/create"]


@pytest.mark.unit
def test_an_unchanged_task_script_is_not_written_but_its_schedule_is_synced() -> None:
    windmill = FakeWindmill({SCHEDULED.windmill_path: _scheduled_as_read()})

    result = _task_syncer(windmill).sync_task(SCHEDULED)

    assert result["status"] == "unchanged"
    assert windmill.writes() == ["schedules/create"]
    assert result["schedule"]["path"] == SCHEDULE_PATH


@pytest.mark.unit
@pytest.mark.parametrize(
    "change",
    [{"content": "def main(): pass\n"}, {"tag": "other"}],
    ids=["content", "tag"],
)
def test_a_changed_task_script_is_a_new_version_on_the_current_one(
    change: dict[str, Any],
) -> None:
    windmill = FakeWindmill(
        {SCHEDULED.windmill_path: _scheduled_as_read(**change)},
        {SCHEDULE_PATH: UNCHANGED_SCHEDULE},
    )

    result = _task_syncer(windmill).sync_task(SCHEDULED)

    assert result["status"] == "synced"
    (body,) = windmill.created
    assert body["parent_hash"] == GENERATE_THUMBNAILS_AS_READ["hash"]
    assert body["auto_parent"] is True
    assert body["tag"] == SCHEDULED.worker_tag
    assert windmill.writes() == ["scripts/create"]


@pytest.mark.unit
def test_the_task_sync_never_deletes_a_script() -> None:
    windmill = FakeWindmill()
    _task_syncer(windmill).sync_all()
    for script in windmill.scripts.values():
        script["content"] = "old"
    windmill.requests.clear()

    results = _task_syncer(windmill).sync_all()

    assert {r["status"] for r in results} == {"synced"}
    assert windmill.writes() == ["scripts/create"] * len(TASK_PATHS)


@pytest.mark.unit
def test_a_second_task_sync_writes_nothing(caplog: pytest.LogCaptureFixture) -> None:
    windmill = FakeWindmill()
    _task_syncer(windmill).sync_all()
    windmill.requests.clear()

    with caplog.at_level(logging.INFO):
        results = _task_syncer(windmill).sync_all()

    assert {r["status"] for r in results} == {"unchanged"}
    assert windmill.writes() == []
    assert f"Done: {len(TASK_PATHS)} unchanged" in caplog.text


@pytest.mark.unit
def test_a_refused_task_script_is_logged_with_its_reason_and_the_others_still_sync(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reason = "Bad request: Path conflict"
    windmill = FakeWindmill(refuse={SCHEDULED.windmill_path: (400, reason)})

    with caplog.at_level(logging.INFO):
        results = {r["path"]: r for r in _task_syncer(windmill).sync_all()}

    assert results.pop(SCHEDULED.windmill_path)["status"] == "failed"
    assert {r["status"] for r in results.values()} == {"synced"}
    assert {body["path"] for body in windmill.created} == set(results)
    assert "400" in caplog.text and reason in caplog.text


@pytest.mark.unit
def test_a_task_dry_run_writes_nothing() -> None:
    windmill = FakeWindmill()

    results = _task_syncer(windmill).sync_all(dry_run=True)

    assert {r["status"] for r in results} == {"dry-run"}
    assert windmill.requests == []


@pytest.mark.unit
@pytest.mark.parametrize("task_def", TASK_REGISTRY, ids=lambda t: t.name)
def test_every_task_main_runs_without_being_awaited(task_def: Any) -> None:
    # The generated Windmill script returns main(...) as is: an async main
    # would hand Windmill an unawaited coroutine and do nothing.
    import importlib
    import inspect

    main = importlib.import_module(task_def.module_path).main
    assert not inspect.iscoroutinefunction(main)
