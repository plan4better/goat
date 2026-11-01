import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest

from assistant.db import Database
from assistant.events import RunStarted, TextDelta, UsageReported
from assistant.repo import (
    ConversationBusy,
    ConversationNotFound,
    Repository,
    UserRunLimit,
)

USER = UUID(int=1)
OTHER = UUID(int=2)


async def _conversation(repo: Repository, user: UUID = USER) -> UUID:
    row = await repo.create_conversation(user, "catalog", None, None)
    return UUID(str(row["id"]))


async def test_conversations_are_private_to_their_user(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    assert await repo.get_conversation(conversation_id, USER) is not None
    assert await repo.get_conversation(conversation_id, OTHER) is None
    assert await repo.delete_conversation(conversation_id, OTHER) is False
    assert [
        c["id"] for c in await repo.list_conversation_summaries(USER, None, None, 50)
    ] == [conversation_id]


async def test_begin_run_creates_messages_and_a_queued_run(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [{"type": "user_text", "text": "hi"}], "test", "test", 3
    )
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "queued"
    assert run["assistant_message_id"] == message_id
    messages = await repo.list_messages(conversation_id, exclude_message_id=None)
    assert [m["role"] for m in messages] == ["user", "assistant"]


async def test_second_run_in_conversation_is_refused(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    with pytest.raises(ConversationBusy):
        await repo.begin_run(conversation_id, USER, [], "test", "test", 3)


async def test_user_run_limit(repo: Repository) -> None:
    for _ in range(3):
        await repo.begin_run(await _conversation(repo), USER, [], "test", "test", 3)
    with pytest.raises(UserRunLimit):
        await repo.begin_run(await _conversation(repo), USER, [], "test", "test", 3)
    # Another user is not affected.
    await repo.begin_run(await _conversation(repo, OTHER), OTHER, [], "test", "test", 3)


async def test_events_round_trip_in_order(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [], "test", "test", 3
    )
    await repo.append_event(run_id, 1, RunStarted(message_id=str(message_id)))
    await repo.append_event(run_id, 2, TextDelta(part_id="p", delta="x"))
    assert [seq for seq, _ in await repo.list_events(run_id)] == [1, 2]
    assert [event for _, event in await repo.list_events(run_id, after_seq=1)] == [
        TextDelta(part_id="p", delta="x")
    ]
    assert await repo.next_seq(run_id) == 3


async def test_finish_run_folds_and_frees_the_conversation(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [], "test", "test", 3
    )
    await repo.mark_running(
        run_id, "owner-a", datetime.now(timezone.utc) + timedelta(seconds=30)
    )
    parts = [{"type": "text", "id": "p", "text": "done"}]
    await repo.finish_run(run_id, "succeeded", None, parts, [{"kind": "response"}])
    assert await repo.active_run(conversation_id) is None
    messages = await repo.list_messages(conversation_id, exclude_message_id=None)
    assert messages[-1]["parts"] == parts
    assert await repo.history(conversation_id) == [{"kind": "response"}]


async def test_an_answer_is_dated_when_its_run_ended(
    repo: Repository, db: Database
) -> None:
    conversation_id = await _conversation(repo)
    run_id, message_id = await repo.begin_run(
        conversation_id, USER, [{"type": "user_text", "text": "hi"}], "t", "t", 3
    )
    asked = datetime(2026, 10, 19, 10, 0, tzinfo=timezone.utc)
    answered = asked + timedelta(minutes=3)
    await repo.finish_run(run_id, "succeeded", None, [], [])
    async with db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {db.t('message')} SET created_at = $2 WHERE conversation_id = $1",
            conversation_id,
            asked,
        )
        await conn.execute(
            f"UPDATE {db.t('run')} SET finished_at = $2 WHERE id = $1",
            run_id,
            answered,
        )
    question, answer = await repo.list_messages(conversation_id, None)
    assert question["created_at"] == asked
    assert answer["id"] == message_id and answer["created_at"] == answered


async def test_expired_runs_and_lease_renewal(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    await repo.mark_running(run_id, "owner-a", past)
    assert [r["id"] for r in await repo.expired_runs(datetime.now(timezone.utc))] == [
        run_id
    ]
    assert await repo.renew_lease(run_id, "owner-b", past) is False  # not the owner
    assert await repo.renew_lease(
        run_id, "owner-a", datetime.now(timezone.utc) + timedelta(seconds=30)
    )
    assert await repo.expired_runs(datetime.now(timezone.utc)) == []


async def test_usage_survives_conversation_deletion(
    repo: Repository, db: Database
) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    await repo.insert_usage(
        run_id,
        USER,
        None,
        "test",
        "test",
        "main",
        UsageReported(model="test", input_tokens=5, output_tokens=2),
    )
    assert await repo.delete_conversation(conversation_id, USER) is True
    async with db.pool.acquire() as conn:
        assert await conn.fetchval(f"SELECT count(*) FROM {db.t('usage')}") == 1


async def test_organization_of_unknown_user_is_none(repo: Repository) -> None:
    assert await repo.organization_of(uuid4()) is None


async def test_organization_of_reads_the_users_organization(
    repo: Repository, db: Database
) -> None:
    user = uuid4()
    organization = uuid4()
    async with db.pool.acquire() as conn:
        await conn.execute(
            f"INSERT INTO {db.customer('user')} (id, organization_id) VALUES ($1, $2)",
            user,
            organization,
        )
    assert await repo.organization_of(user) == organization


async def test_begin_run_refuses_another_users_conversation(
    repo: Repository,
) -> None:
    conversation_id = await _conversation(repo)
    with pytest.raises(ConversationNotFound):
        await repo.begin_run(conversation_id, OTHER, [], "test", "test", 3)
    assert await repo.active_run(conversation_id) is None


async def test_stale_queued_runs_are_swept(repo: Repository, db: Database) -> None:
    stale_conversation = await _conversation(repo)
    stale_id, _ = await repo.begin_run(stale_conversation, USER, [], "test", "test", 3)
    fresh_id, _ = await repo.begin_run(
        await _conversation(repo), USER, [], "test", "test", 3
    )
    async with db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {db.t('run')} SET created_at = now() - interval '5 minutes' "
            "WHERE id = $1",
            stale_id,
        )
    expired = await repo.expired_runs(datetime.now(timezone.utc))
    assert [r["id"] for r in expired] == [stale_id]
    assert fresh_id not in [r["id"] for r in expired]


async def test_finish_run_is_compare_and_set(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    first = [{"type": "text", "id": "p", "text": "first"}]
    assert await repo.finish_run(run_id, "interrupted", "lost", first, []) is True
    second = [{"type": "text", "id": "p", "text": "second"}]
    assert await repo.finish_run(run_id, "succeeded", None, second, []) is False
    messages = await repo.list_messages(conversation_id, exclude_message_id=None)
    assert messages[-1]["parts"] == first
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "interrupted"


async def test_mark_running_only_claims_a_queued_run(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    run_id, _ = await repo.begin_run(conversation_id, USER, [], "test", "test", 3)
    lease = datetime.now(timezone.utc) + timedelta(seconds=30)
    assert await repo.mark_running(run_id, "owner-a", lease) is True
    assert await repo.mark_running(run_id, "owner-b", lease) is False
    await repo.finish_run(run_id, "succeeded", None, [], [])
    assert await repo.mark_running(run_id, "owner-a", lease) is False
    run = await repo.get_run(run_id)
    assert run is not None and run["status"] == "succeeded"


async def test_concurrent_begin_runs_respect_the_user_limit(
    repo: Repository,
) -> None:
    conversations = [await _conversation(repo) for _ in range(8)]
    results = await asyncio.gather(
        *(repo.begin_run(c, USER, [], "test", "test", 3) for c in conversations),
        return_exceptions=True,
    )
    assert sum(isinstance(r, tuple) for r in results) == 3
    assert sum(isinstance(r, UserRunLimit) for r in results) == 5


async def test_concurrent_begin_runs_on_one_conversation(repo: Repository) -> None:
    conversation_id = await _conversation(repo)
    results = await asyncio.gather(
        *(
            repo.begin_run(conversation_id, USER, [], "test", "test", 10)
            for _ in range(5)
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(r, tuple) for r in results) == 1
    assert sum(isinstance(r, ConversationBusy) for r in results) == 4
