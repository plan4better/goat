"""The tool-call audit table (spec §5, §7.5), built from core's definitions."""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.repo import Repository
from assistant.runs.manager import RunManager

USER = UUID(int=1)


async def _run(repo: Repository) -> tuple[UUID, UUID]:
    conversation = await repo.create_conversation(USER, "catalog", None, None)
    run_id, _ = await repo.begin_run(
        conversation["id"],
        USER,
        [{"type": "user_text", "text": "hi"}],
        "test",
        "test",
        3,
    )
    return conversation["id"], run_id


async def _rows(db: Database) -> list[dict[str, object]]:
    async with db.pool.acquire() as conn:
        records = await conn.fetch(
            f"SELECT * FROM {db.t('tool_call')} ORDER BY created_at"
        )
    return [dict(r) for r in records]


async def test_tool_calls_are_recorded_and_deleted_with_the_conversation(
    repo: Repository, db: Database
) -> None:
    conversation_id, run_id = await _run(repo)
    await repo.insert_tool_call(
        run_id=run_id,
        user_id=USER,
        tool="catalog_search",
        tool_call_id="call-0",
        args_summary={"q": "radweg"},
        result_bytes=120,
        duration_ms=15,
        status="ok",
        error=None,
    )
    rows = await _rows(db)
    assert len(rows) == 1
    assert rows[0]["tool"] == "catalog_search"
    assert rows[0]["args_summary"] == {"q": "radweg"}
    assert (rows[0]["result_bytes"], rows[0]["status"], rows[0]["error"]) == (
        120,
        "ok",
        None,
    )

    await repo.delete_conversation(conversation_id, USER)
    assert await _rows(db) == []


async def test_calls_over_mcp_have_no_run(repo: Repository, db: Database) -> None:
    user = uuid4()
    await repo.insert_tool_call(
        run_id=None,
        user_id=user,
        tool="catalog_get_record",
        tool_call_id=None,
        args_summary={"item_id": "x"},
        result_bytes=0,
        duration_ms=3,
        status="error",
        error="Catalog record 'x' not found",
    )
    rows = await _rows(db)
    assert rows[0]["run_id"] is None and rows[0]["user_id"] == user


async def test_last_user_context_reads_the_latest_user_message(
    repo: Repository,
) -> None:
    conversation = await repo.create_conversation(USER, "catalog", None, None)
    assert await repo.last_user_context(conversation["id"]) is None
    run_id, _ = await repo.begin_run(
        conversation["id"],
        USER,
        [
            {"type": "user_text", "text": "one"},
            {"type": "context", "context": {"surface": "catalog", "q": "rad"}},
        ],
        "test",
        "test",
        3,
    )
    await repo.finish_run(run_id, "succeeded", None, [], [])
    assert await repo.last_user_context(conversation["id"]) == {
        "surface": "catalog",
        "q": "rad",
    }

    run_id, _ = await repo.begin_run(
        conversation["id"],
        USER,
        [{"type": "user_text", "text": "two"}],
        "test",
        "test",
        3,
    )
    # The latest user message has no context part (sent from a page without an adapter).
    assert await repo.last_user_context(conversation["id"]) is None


# -- MCP audit retention (ruling 24) -------------------------------------------


async def _call(repo: Repository, run_id: UUID | None, tool: str) -> None:
    await repo.insert_tool_call(
        run_id=run_id,
        user_id=USER,
        tool=tool,
        tool_call_id=None,
        args_summary={"q": tool},
        result_bytes=1,
        duration_ms=1,
        status="ok",
        error=None,
    )


async def _age(db: Database, tool: str, days: int) -> None:
    async with db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {db.t('tool_call')} SET created_at = now() - make_interval(days => $2) "
            "WHERE tool = $1",
            tool,
            days,
        )


async def _three_calls(repo: Repository, db: Database) -> None:
    """An old MCP call, a recent MCP call and an old in-app call."""
    _, run_id = await _run(repo)
    await _call(repo, None, "old_mcp")
    await _call(repo, None, "recent_mcp")
    await _call(repo, run_id, "old_in_app")
    await _age(db, "old_mcp", 31)
    await _age(db, "recent_mcp", 29)
    await _age(db, "old_in_app", 400)


async def test_old_mcp_calls_are_deleted_and_in_app_calls_kept(
    repo: Repository, db: Database
) -> None:
    await _three_calls(repo, db)
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    assert await repo.delete_mcp_tool_calls_before(cutoff) == 1
    assert sorted(row["tool"] for row in await _rows(db)) == [
        "old_in_app",
        "recent_mcp",
    ]
    assert await repo.delete_mcp_tool_calls_before(cutoff) == 0


async def test_one_delete_is_bounded(repo: Repository, db: Database) -> None:
    for _ in range(3):
        await _call(repo, None, "old_mcp")
    await _age(db, "old_mcp", 60)
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    assert await repo.delete_mcp_tool_calls_before(cutoff, limit=2) == 2
    assert len(await _rows(db)) == 1


async def test_the_sweeper_applies_the_mcp_retention(
    repo: Repository, db: Database, settings: AssistantSettings
) -> None:
    await _three_calls(repo, db)
    manager = RunManager(repo, InMemoryEventBus(), settings, owner="a")
    # The return value still counts the runs it ended, nothing else.
    assert await manager.sweep_once() == 0
    assert sorted(row["tool"] for row in await _rows(db)) == [
        "old_in_app",
        "recent_mcp",
    ]
    # A shorter retention reaches the recent call too.
    shorter = settings.model_copy(update={"mcp_audit_retention_days": 7})
    await RunManager(repo, InMemoryEventBus(), shorter, owner="a").sweep_once()
    assert [row["tool"] for row in await _rows(db)] == ["old_in_app"]
