"""One execution path for every tool call (spec §7.1, §7.5)."""

import asyncio
import json
from typing import Any
from uuid import UUID

import pytest
from pydantic import BaseModel, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.db import Database
from assistant.login import LoginFailed, StaticLogin
from assistant.repo import Repository
from assistant.tools.runtime import (
    MAX_RESULT_BYTES,
    InputInvalid,
    ToolEnv,
    ToolSpec,
    execute,
    summarize_args,
)
from assistant.tools.testing import fake_clients, tool_env

USER = UUID(int=1)


class EchoIn(BaseModel):
    text: str = Field(description="Text to echo.")
    times: int = Field(default=1, ge=1, le=3, description="How often.")


class EchoOut(BaseModel):
    echoed: str


async def _echo(env: ToolEnv, args: EchoIn) -> EchoOut:
    return EchoOut(echoed=args.text * args.times)


async def _huge(env: ToolEnv, args: EchoIn) -> EchoOut:
    return EchoOut(echoed="x" * (MAX_RESULT_BYTES + 1))


async def _broken(env: ToolEnv, args: EchoIn) -> EchoOut:
    raise RuntimeError("database password is hunter2")


def _spec(run: Any, output: type[BaseModel] = EchoOut) -> ToolSpec[Any, Any]:
    return ToolSpec(
        name="test.echo",
        description="Echo a text.",
        input_model=EchoIn,
        output_model=output,
        run=run,
        surfaces=frozenset({"none"}),
    )


async def _audit(db: Database) -> list[dict[str, Any]]:
    async with db.pool.acquire() as conn:
        return [
            dict(r)
            for r in await conn.fetch(
                f"SELECT * FROM {db.t('tool_call')} ORDER BY created_at, tool_call_id"
            )
        ]


async def test_a_call_runs_and_is_audited(repo: Repository, db: Database) -> None:
    env = tool_env(fake_clients(), repo=repo)
    payload = await execute(
        _spec(_echo),
        env,
        {"text": "ab", "times": 2},
        tool_call_id="call-1",
    )
    assert payload == {"echoed": "abab"}
    [row] = await _audit(db)
    assert (row["tool"], row["tool_call_id"], row["status"], row["error"]) == (
        "test_echo",
        "call-1",
        "ok",
        None,
    )
    assert row["result_bytes"] == len(
        json.dumps(payload, separators=(",", ":")).encode()
    )
    assert row["args_summary"] == {"text": "ab", "times": 2}
    assert row["run_id"] is None and row["user_id"] == USER


async def test_invalid_arguments_tell_the_model_what_to_fix(
    repo: Repository, db: Database
) -> None:
    env = tool_env(fake_clients(), repo=repo)
    with pytest.raises(InputInvalid) as caught:
        await execute(_spec(_echo), env, {"times": 9})
    assert "text" in caught.value.message and "times" in caught.value.message
    [row] = await _audit(db)
    assert row["status"] == "invalid"


async def test_an_oversized_result_is_refused(repo: Repository, db: Database) -> None:
    env = tool_env(fake_clients(), repo=repo)
    with pytest.raises(ToolFailed, match="too large"):
        await execute(_spec(_huge), env, {"text": "a"})
    [row] = await _audit(db)
    assert row["status"] == "error"
    assert row["result_bytes"] > MAX_RESULT_BYTES


async def test_an_unexpected_error_does_not_leak(
    repo: Repository, db: Database
) -> None:
    env = tool_env(fake_clients(), repo=repo)
    with pytest.raises(ToolFailed) as caught:
        await execute(_spec(_broken), env, {"text": "a"})
    assert "hunter2" not in caught.value.message
    [row] = await _audit(db)
    assert row["error"] == "internal error"


async def test_a_failing_audit_does_not_fail_the_tool() -> None:
    class BrokenRepo:
        async def insert_tool_call(self, **kwargs: Any) -> None:
            raise RuntimeError("database down")

    env = tool_env(fake_clients(), repo=BrokenRepo())  # type: ignore[arg-type]
    assert await execute(_spec(_echo), env, {"text": "a"}) == {"echoed": "a"}


async def test_an_expired_login_is_a_tool_failure() -> None:
    class Expired:
        async def bearer(self) -> str | None:
            raise LoginFailed("Keycloak refused the token request (HTTP 400).")

        def secrets(self) -> list[str]:
            return []

    async def _calls(env: ToolEnv, args: EchoIn) -> EchoOut:
        await env.call("core", "GET", "/x")
        return EchoOut(echoed="never")

    env = tool_env(fake_clients(), login=Expired())
    with pytest.raises(ToolFailed, match="sign-in has expired"):
        await execute(_spec(_calls), env, {"text": "a"})


async def test_a_cancelled_call_is_audited_as_cancelled(
    repo: Repository, db: Database
) -> None:
    started = asyncio.Event()

    async def _slow(env: ToolEnv, args: EchoIn) -> EchoOut:
        started.set()
        await asyncio.sleep(60)
        return EchoOut(echoed="late")

    env = tool_env(fake_clients(), repo=repo)
    task = asyncio.create_task(execute(_spec(_slow), env, {"text": "a"}))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    [row] = await _audit(db)
    assert (row["status"], row["error"]) == ("error", "cancelled")


class _Rows:
    """The audit rows a call leaves, in memory."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def insert_tool_call(self, **row: Any) -> None:
        self.rows.append(row)


class _Written(BaseModel):
    echoed: str

    def undo(self) -> dict[str, Any] | None:
        return {"kind": "test", "from": "result"}


def _landing(stop: BaseException | None) -> Any:
    """A write tool whose first write lands, then ``stop`` ends the call (None:
    it returns its result)."""

    async def run(env: ToolEnv, args: EchoIn) -> _Written:
        env.landed.keep(lambda: {"kind": "test", "from": "holder", "text": args.text})
        if stop is not None:
            raise stop
        return _Written(echoed=args.text)

    return run


@pytest.mark.parametrize(
    ("stop", "raised"),
    [
        (asyncio.CancelledError(), asyncio.CancelledError),
        (ToolFailed("core refused the second write"), ToolFailed),
        (RuntimeError("boom"), ToolFailed),
        (InputInvalid("a late refusal"), InputInvalid),
    ],
)
async def test_a_call_that_ends_after_a_landed_write_keeps_its_undo_record(
    stop: BaseException, raised: type[BaseException]
) -> None:
    rows = _Rows()
    env = tool_env(fake_clients(), repo=rows)  # type: ignore[arg-type]
    with pytest.raises(raised):
        await execute(_spec(_landing(stop), _Written), env, {"text": "a"})
    [row] = rows.rows
    assert row["undo"] == {"kind": "test", "from": "holder", "text": "a"}
    assert row["status"] in ("error", "invalid")


async def test_a_returned_result_s_undo_record_comes_before_the_holder() -> None:
    rows = _Rows()
    env = tool_env(fake_clients(), repo=rows)  # type: ignore[arg-type]
    await execute(_spec(_landing(None), _Written), env, {"text": "a"})
    [row] = rows.rows
    assert row["undo"] == {"kind": "test", "from": "result"}


async def test_a_call_stopped_before_any_write_leaves_no_undo_record() -> None:
    async def _stopped(env: ToolEnv, args: EchoIn) -> EchoOut:
        raise asyncio.CancelledError()

    rows = _Rows()
    env = tool_env(fake_clients(), repo=rows)  # type: ignore[arg-type]
    with pytest.raises(asyncio.CancelledError):
        await execute(_spec(_stopped), env, {"text": "a"})
    [row] = rows.rows
    assert row["undo"] is None


async def test_each_call_gets_its_own_undo_holder() -> None:
    seen: list[Any] = []

    async def _sees(env: ToolEnv, args: EchoIn) -> EchoOut:
        seen.append(env.landed)
        return EchoOut(echoed="a")

    env = tool_env(fake_clients())
    await execute(_spec(_sees), env, {"text": "a"})
    await execute(_spec(_sees), env, {"text": "a"})
    assert seen[0] is not seen[1] and seen[0] is not env.landed


async def test_a_holder_that_fails_to_build_its_record_does_not_fail_the_audit() -> (
    None
):
    async def _broken_holder(env: ToolEnv, args: EchoIn) -> EchoOut:
        def broken() -> dict[str, Any]:
            raise KeyError("x")

        env.landed.keep(broken)
        raise asyncio.CancelledError()

    rows = _Rows()
    env = tool_env(fake_clients(), repo=rows)  # type: ignore[arg-type]
    with pytest.raises(asyncio.CancelledError):
        await execute(_spec(_broken_holder), env, {"text": "a"})
    [row] = rows.rows
    assert row["undo"] is None and row["error"] == "cancelled"


def test_long_arguments_are_shortened_for_the_audit() -> None:
    summary = summarize_args(
        {
            "q": "x" * 500,
            "ids": list(range(50)),
            "nested": {"deep": {"deeper": {"deepest": 1}}},
        }
    )
    assert len(summary["q"]) == 201 and summary["q"].endswith("…")
    assert summary["ids"][:20] == list(range(20)) and summary["ids"][20] == "… 30 more"
    assert summary["nested"] == {"deep": {"deeper": "…"}}


def test_wire_names_use_underscores() -> None:
    spec = _spec(_echo)
    assert spec.wire_name == "test_echo"
    schema = spec.json_schema()
    assert "title" not in schema
    assert schema["properties"]["text"]["description"] == "Text to echo."


TOKEN = "tok-4f9a8c7e1b2d3a5c6e7f"
CLIENT_SECRET = "web-client-secret-0123456789"


async def test_tokens_never_reach_the_audit_row_or_the_log(
    repo: Repository, db: Database, caplog: pytest.LogCaptureFixture
) -> None:
    async def _leaky(env: ToolEnv, args: EchoIn) -> EchoOut:
        raise ToolFailed(f"The service rejected {TOKEN} and {CLIENT_SECRET}")

    async def _crashing(env: ToolEnv, args: EchoIn) -> EchoOut:
        raise RuntimeError(f"upstream said: Bearer {TOKEN} / {CLIENT_SECRET}")

    env = tool_env(
        fake_clients(),
        repo=repo,
        login=StaticLogin(TOKEN),
        extra_secrets=[CLIENT_SECRET],
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(_spec(_leaky), env, {"text": "a"})
    assert TOKEN not in caught.value.message
    assert CLIENT_SECRET not in caught.value.message
    assert caught.value.message == "The service rejected … and …"
    with caplog.at_level("ERROR"), pytest.raises(ToolFailed):
        await execute(_spec(_crashing), env, {"text": "a"})
    rows = await _audit(db)
    assert len(rows) == 2
    for row in rows:
        assert TOKEN not in (row["error"] or "")
        assert CLIENT_SECRET not in (row["error"] or "")
    assert {row["error"] for row in rows} == {
        "The service rejected … and …",
        "internal error",
    }
    assert TOKEN not in caplog.text and CLIENT_SECRET not in caplog.text
    assert "upstream said" in caplog.text


async def test_invalid_input_messages_are_masked(
    repo: Repository, db: Database
) -> None:
    """A tool's InputInvalid can quote a service's answer (a 400 body); it is
    masked in ``execute``, like ToolFailed, so no tool has to remember it."""

    async def _quoting(env: ToolEnv, args: EchoIn) -> EchoOut:
        raise InputInvalid(f"The service rejected the filter: {TOKEN} {CLIENT_SECRET}")

    env = tool_env(
        fake_clients(),
        repo=repo,
        login=StaticLogin(TOKEN),
        extra_secrets=[CLIENT_SECRET],
    )
    with pytest.raises(InputInvalid) as caught:
        await execute(_spec(_quoting), env, {"text": "a"})
    assert caught.value.message == "The service rejected the filter: … …"
    [row] = await _audit(db)
    assert (row["status"], row["error"]) == (
        "invalid",
        "The service rejected the filter: … …",
    )


async def test_a_failing_audit_log_masks_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class BrokenRepo:
        async def insert_tool_call(self, **kwargs: Any) -> None:
            raise RuntimeError(f"connection string has {TOKEN}")

    env = tool_env(fake_clients(), repo=BrokenRepo(), login=StaticLogin(TOKEN))  # type: ignore[arg-type]
    with caplog.at_level("ERROR"):
        await execute(_spec(_echo), env, {"text": "a"})
    assert "Recording the call" in caplog.text
    assert TOKEN not in caplog.text


async def test_an_unclassified_exit_is_audited_as_an_error(
    repo: Repository, db: Database
) -> None:
    async def _exits(env: ToolEnv, args: EchoIn) -> EchoOut:
        raise KeyboardInterrupt

    env = tool_env(fake_clients(), repo=repo)
    with pytest.raises(KeyboardInterrupt):
        await execute(_spec(_exits), env, {"text": "a"})
    [row] = await _audit(db)
    assert row["status"] == "error"


# -- ruling 25: nulls inside dict-shaped data are values -------------------------


async def test_a_catalog_record_keeps_its_null_keys() -> None:
    """STAC keys that are null stay, as the catalog sent them."""
    from assistant.tools.catalog import GET_RECORD
    from assistant.tools.testing import Recorder

    item = {
        "type": "Feature",
        "id": "x",
        "bbox": None,
        "properties": {"end_datetime": None, "title": "X"},
        "assets": {"data": {"href": "/a", "roles": None}},
    }
    catalog = Recorder({("GET", "/stac/resolve/x"): {"kind": "item", "item": item}})
    record = await execute(
        GET_RECORD, tool_env(fake_clients(catalog=catalog)), {"item_id": "x"}
    )
    assert record == item


async def test_sample_properties_keep_their_nulls_and_typed_fields_drop_them() -> None:
    """A null attribute is "null here", not "not requested"; a typed model's
    unset field (no ``number_matched``) is still left out."""
    from assistant.context import parse_context
    from assistant.tools.project import SAMPLE_FEATURES
    from assistant.tools.testing import Recorder

    project = UUID(int=500)
    lines = "11111111-1111-1111-1111-111111111111"
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{project}/layer"): [
                {
                    "id": 11,
                    "layer_id": lines,
                    "name": "Radwege",
                    "type": "feature",
                    "feature_layer_geometry_type": "line",
                    "layer_project_group_id": None,
                    "order": 0,
                    "locked": False,
                }
            ]
        }
    )
    geoapi = Recorder(
        {
            ("GET", f"/collections/{lines}/queryables"): {
                "properties": {"art": {"type": "string"}, "notiz": {"type": "string"}}
            },
            ("GET", f"/collections/{lines}/items"): {
                "type": "FeatureCollection",
                "features": [{"id": 1, "properties": {"art": "Radweg", "notiz": None}}],
            },
        }
    )
    env = tool_env(
        fake_clients(core=core, geoapi=geoapi),
        page=parse_context({"surface": "project.map", "project_id": str(project)}),
    )
    sample = await execute(SAMPLE_FEATURES, env, {"layer_project_id": 11})
    assert sample["features"] == [
        {"feature_id": 1, "properties": {"art": "Radweg", "notiz": None}}
    ]
    assert "number_matched" not in sample
