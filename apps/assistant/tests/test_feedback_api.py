"""Feedback on answers: thumbs up or down with an optional comment, one per user
and answer, shown again when the conversation loads, and gone with it.

``api`` is the conftest fixture."""

import asyncio
from typing import Any
from uuid import UUID, uuid4

from httpx import AsyncClient

from assistant.db import Database

OTHER = UUID(int=2)
Api = Any  # conftest.ApiFactory


async def _answered(client: AsyncClient) -> tuple[str, str, str]:
    """A conversation with one finished answer: (conversation, question, answer)."""
    created = await client.post("/conversations", json={"origin_surface": "catalog"})
    conversation_id = created.json()["id"]
    started = await client.post(
        f"/conversations/{conversation_id}/runs",
        json={"message": {"id": "u", "text": "Radwege in Köln?"}},
    )
    assert started.status_code == 200, started.text
    for _ in range(100):
        body = (await client.get(f"/conversations/{conversation_id}")).json()
        if body["active_run_id"] is None and len(body["messages"]) == 2:
            question, answer = body["messages"]
            return conversation_id, question["id"], answer["id"]
        await asyncio.sleep(0.05)
    raise AssertionError("the run did not finish")


def _url(conversation_id: str, message_id: str) -> str:
    return f"/conversations/{conversation_id}/messages/{message_id}/feedback"


async def test_a_rating_is_saved_changed_and_removed(api: Api) -> None:
    async with api() as client:
        conversation_id, _, answer = await _answered(client)
        up = await client.put(_url(conversation_id, answer), json={"rating": "up"})
        assert up.json() == {"rating": "up", "comment": None}
        down = await client.put(
            _url(conversation_id, answer),
            json={"rating": "down", "comment": "  Missing the MVV stops.  "},
        )
        assert down.json() == {"rating": "down", "comment": "Missing the MVV stops."}
        loaded = (await client.get(f"/conversations/{conversation_id}")).json()
        assert loaded["feedback"] == {
            answer: {"rating": "down", "comment": "Missing the MVV stops."}
        }
        cleared = await client.put(_url(conversation_id, answer), json={"rating": None})
        assert cleared.json() == {"rating": None, "comment": None}
        loaded = (await client.get(f"/conversations/{conversation_id}")).json()
        assert loaded["feedback"] == {}


async def test_only_answers_of_the_users_own_conversations_can_be_rated(
    api: Api,
) -> None:
    async with api() as client:
        conversation_id, question, answer = await _answered(client)
        for url, code in (
            (_url(conversation_id, question), "answer_not_found"),
            (_url(conversation_id, str(uuid4())), "answer_not_found"),
        ):
            response = await client.put(url, json={"rating": "up"})
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == code
    async with api(user=OTHER) as other:
        response = await other.put(_url(conversation_id, answer), json={"rating": "up"})
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "conversation_not_found"


async def test_a_rating_takes_up_or_down_and_a_short_comment(api: Api) -> None:
    async with api() as client:
        conversation_id, _, answer = await _answered(client)
        for body in (
            {"rating": "meh"},
            {"rating": "down", "comment": "x" * 501},
            {"rating": "up", "extra": 1},
        ):
            response = await client.put(_url(conversation_id, answer), json=body)
            assert response.status_code == 422, body


async def test_feedback_goes_with_its_conversation(api: Api, db: Database) -> None:
    async with api() as client:
        conversation_id, _, answer = await _answered(client)
        await client.put(_url(conversation_id, answer), json={"rating": "up"})
        assert await db.pool.fetchval(f"SELECT count(*) FROM {db.t('feedback')}") == 1
        deleted = await client.delete(f"/conversations/{conversation_id}")
        assert deleted.status_code == 204
    assert await db.pool.fetchval(f"SELECT count(*) FROM {db.t('feedback')}") == 0
