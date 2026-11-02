"""The script sync writes to Windmill at a path: a tool's generated wrapper,
or the workflow runner's or finalize step's script. The workflow chain tests
run these scripts in place of Windmill (tests/integration/tools/chains)."""

import inspect
import logging
from typing import Any

import pytest
from goatlib.tools.buffer import BufferToolParams
from goatlib.tools.codegen import generate_windmill_script
from goatlib.tools.registry import TOOL_REGISTRY
from goatlib.tools.sync_windmill import (
    WORKFLOW_SCRIPTS,
    WindmillSyncer,
    windmill_script,
)

from ..windmill_fake import BUFFER_AS_READ, FakeWindmill

pytestmark = pytest.mark.unit


def test_a_tool_path_gives_its_generated_wrapper() -> None:
    assert windmill_script("f/goat/tools/buffer") == generate_windmill_script(
        "goatlib.tools.buffer", BufferToolParams
    )


def test_a_path_sync_writes_nothing_at_has_no_script() -> None:
    with pytest.raises(KeyError):
        windmill_script("f/goat/tools/no_such_tool")


def _syncer(windmill: FakeWindmill) -> WindmillSyncer:
    syncer = WindmillSyncer("http://windmill.test", "token")
    syncer.client = windmill.client()
    return syncer


def _written_by(sync: str) -> dict[str, str]:
    """The scripts a sync writes, by path, against a Windmill that has none."""
    windmill = FakeWindmill()
    getattr(_syncer(windmill), sync)()
    return {body["path"]: body["content"] for body in windmill.created}


def test_sync_writes_the_workflow_scripts_windmill_script_gives() -> None:
    assert _written_by("sync_workflow_scripts") == dict(WORKFLOW_SCRIPTS)


def test_every_script_sync_writes_is_the_one_windmill_script_gives() -> None:
    written = _written_by("sync_all")
    assert set(WORKFLOW_SCRIPTS) <= set(written)
    assert {path: windmill_script(path) for path in written} == written


def test_the_finalize_script_names_its_arguments_and_takes_no_others() -> None:
    namespace: dict[str, Any] = {}
    script = windmill_script("f/goat/tools/finalize_layer")
    exec(compile(script, "finalize_layer", "exec"), namespace)
    parameters = inspect.signature(namespace["main"]).parameters.values()
    assert "delete_temp" not in {parameter.name for parameter in parameters}
    assert all(
        parameter.kind is not inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )


# A sync writes a script in place and never deletes one: the path always
# resolves to a script, and Windmill keeps the script's version history.

BUFFER = next(t for t in TOOL_REGISTRY if t.name == "buffer")
ALL_PATHS = [t.windmill_path for t in TOOL_REGISTRY] + list(WORKFLOW_SCRIPTS)


def _buffer_as_read(**changes: Any) -> dict[str, Any]:
    """Buffer as Windmill reads it back once the sync wrote it from this
    goatlib, with ``changes`` made to it since."""
    return {
        **BUFFER_AS_READ,
        "content": windmill_script(BUFFER.windmill_path),
        **changes,
    }


def test_a_missing_script_is_created_without_a_parent() -> None:
    windmill = FakeWindmill()

    result = _syncer(windmill).sync_tool(BUFFER)

    assert result["status"] == "synced"
    (body,) = windmill.created
    assert body["path"] == BUFFER.windmill_path
    assert body["content"] == windmill_script(BUFFER.windmill_path)
    assert "parent_hash" not in body
    assert "auto_parent" not in body


def test_an_unchanged_script_is_not_written() -> None:
    windmill = FakeWindmill({BUFFER.windmill_path: _buffer_as_read()})

    result = _syncer(windmill).sync_tool(BUFFER)

    assert result["status"] == "unchanged"
    assert windmill.writes() == []


@pytest.mark.parametrize(
    "change",
    [
        {"content": "def main(): pass\n"},
        {"tag": "workflows"},
        {"tag": None},
        {"summary": "Old name"},
        {"description": "Old description"},
        {"language": "bun"},
    ],
    ids=["content", "tag", "no-tag", "summary", "description", "language"],
)
def test_a_changed_script_is_a_new_version_on_the_current_one(
    change: dict[str, Any],
) -> None:
    windmill = FakeWindmill({BUFFER.windmill_path: _buffer_as_read(**change)})

    result = _syncer(windmill).sync_tool(BUFFER)

    assert result["status"] == "synced"
    (body,) = windmill.created
    # The version read is the parent: Windmill tells versions apart by it.
    # auto_parent makes Windmill take the version current when it writes
    # instead, so a version deployed since the read does not fail the sync.
    assert body["parent_hash"] == BUFFER_AS_READ["hash"]
    assert body["auto_parent"] is True
    assert body["content"] == windmill_script(BUFFER.windmill_path)
    assert body["tag"] == BUFFER.worker_tag


def test_a_hand_edit_is_replaced_by_the_version_goatlib_writes() -> None:
    # Going back to content an earlier version had is a new version only
    # with the version read as its parent: Windmill refuses a second version
    # with the same content and parent.
    windmill = FakeWindmill()
    _syncer(windmill).sync_tool(BUFFER)
    first = windmill.scripts[BUFFER.windmill_path]
    fields = ("path", "summary", "description", "language", "tag")
    edited = {field: first[field] for field in fields}
    edited.update(content="# edited in the Windmill UI\n", parent_hash=first["hash"])
    windmill.client().post(
        "http://windmill.test/api/w/goat/scripts/create", json=edited
    )
    by_hand = windmill.scripts[BUFFER.windmill_path]["hash"]

    result = _syncer(windmill).sync_tool(BUFFER)

    assert result["status"] == "synced"
    restored = windmill.scripts[BUFFER.windmill_path]
    assert restored["content"] == windmill_script(BUFFER.windmill_path)
    assert restored["parent_hashes"] == [by_hand, first["hash"]]


@pytest.mark.parametrize(
    "state",
    [
        {"archived": True},
        {"lock_error_logs": "ERROR: No matching distribution found"},
        {"lock": None},
    ],
    ids=["archived", "failed-dependency-job", "no-lock"],
)
def test_a_script_that_cannot_run_is_deployed_again(state: dict[str, Any]) -> None:
    # Windmill does not run an archived script by its path, nor one whose
    # dependency job failed or never ran; the sync deploys it again.
    windmill = FakeWindmill({BUFFER.windmill_path: _buffer_as_read(**state)})

    result = _syncer(windmill).sync_tool(BUFFER)

    assert result["status"] == "synced"
    (body,) = windmill.created
    assert body["parent_hash"] == BUFFER_AS_READ["hash"]
    assert body["auto_parent"] is True


def test_sync_never_deletes_a_script() -> None:
    windmill = FakeWindmill()
    _syncer(windmill).sync_all()
    for script in windmill.scripts.values():
        script["content"] = "old"
    windmill.requests.clear()

    results = _syncer(windmill).sync_all()

    assert {r["status"] for r in results} == {"synced"}
    assert windmill.writes() == ["scripts/create"] * len(ALL_PATHS)


def test_a_second_sync_writes_nothing(caplog: pytest.LogCaptureFixture) -> None:
    windmill = FakeWindmill()
    _syncer(windmill).sync_all()
    windmill.requests.clear()

    with caplog.at_level(logging.INFO):
        results = _syncer(windmill).sync_all()

    assert {r["status"] for r in results} == {"unchanged"}
    assert windmill.writes() == []
    assert f"Done: {len(ALL_PATHS)} unchanged" in caplog.text


def test_a_refused_create_is_logged_with_its_reason_and_the_others_still_sync(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reason = "Bad request: A script with hash 1a2b with same parent_hash has been found"
    windmill = FakeWindmill(refuse={BUFFER.windmill_path: (400, reason)})

    with caplog.at_level(logging.INFO):
        results = {r["path"]: r for r in _syncer(windmill).sync_all()}

    assert results.pop(BUFFER.windmill_path)["status"] == "failed"
    assert {r["status"] for r in results.values()} == {"synced"}
    assert {body["path"] for body in windmill.created} == set(results)
    (failure,) = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert BUFFER.windmill_path in failure.getMessage()
    assert "400" in failure.getMessage() and reason in failure.getMessage()
    assert f"Done: {len(ALL_PATHS) - 1} synced, 1 failed" in caplog.text


def test_a_script_windmill_cannot_read_is_reported_with_its_reason_and_not_written(
    caplog: pytest.LogCaptureFixture,
) -> None:
    windmill = FakeWindmill(refuse_reads=(500, "Internal: database down"))

    with caplog.at_level(logging.INFO):
        assert _syncer(windmill).sync_tool(BUFFER)["status"] == "failed"

    assert windmill.writes() == []
    assert "500" in caplog.text and "Internal: database down" in caplog.text


def test_a_dry_run_writes_nothing_and_counts_its_scripts(
    caplog: pytest.LogCaptureFixture,
) -> None:
    windmill = FakeWindmill()

    with caplog.at_level(logging.INFO):
        results = _syncer(windmill).sync_all(dry_run=True)

    assert {r["status"] for r in results} == {"dry-run"}
    assert windmill.requests == []
    assert f"Done: {len(ALL_PATHS)} dry-run" in caplog.text
