"""The conversation API the dock uses (spec §10): history with search and
origin labels, titles, binding, and refusals the web app can translate.

``api`` and ``make_project`` are the conftest fixtures."""

import asyncio
from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient

from assistant.config import AssistantSettings
from assistant.repo import Repository

USER = UUID(int=1)
OTHER = UUID(int=2)
Api = Any  # conftest.ApiFactory
Projects = Any  # conftest.ProjectFactory


async def _create(client: AsyncClient, **body: Any) -> dict[str, Any]:
    response = await client.post(
        "/conversations", json={"origin_surface": "catalog", **body}
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _ask(
    client: AsyncClient,
    conversation_id: str,
    text: str,
    context: dict[str, Any] | None = None,
) -> None:
    response = await client.post(
        f"/conversations/{conversation_id}/runs",
        json={"message": {"id": "u", "text": text}, "context": context},
    )
    assert response.status_code == 200, response.text


async def test_the_list_filters_by_project_and_searches_titles_and_first_messages(
    api: Api, make_project: Projects
) -> None:
    project = await make_project("P")
    async with api() as client:
        in_project = await _create(
            client,
            origin_surface="project.map",
            project_id=str(project),
            title="Radwege Dresden",
        )
        green = await _create(client, title="Grünflächen in Leipzig")
        playgrounds = await _create(client)
        await _ask(client, playgrounds["id"], "Wo gibt es Spielplätze_50%?")

        async def ids(**params: str) -> list[str]:
            response = await client.get("/conversations", params=params)
            assert response.status_code == 200, response.text
            return [row["id"] for row in response.json()]

        assert await ids(project_id=str(project)) == [in_project["id"]]
        # ASCII on purpose: ILIKE folds non-ASCII letters only under a UTF-8 ctype.
        assert await ids(q="LEIPZIG") == [green["id"]]
        assert await ids(q="spielpl") == [playgrounds["id"]]
        # Wildcards in the search are literal characters.
        assert await ids(q="_50%") == [playgrounds["id"]]
        assert await ids(q="%") == [playgrounds["id"]]
        assert await ids(q="x%y") == []
        listed = (await client.get("/conversations")).json()
    assert {row["id"] for row in listed} == {
        in_project["id"],
        green["id"],
        playgrounds["id"],
    }
    row = next(r for r in listed if r["id"] == playgrounds["id"])
    assert row["first_message"] == "Wo gibt es Spielplätze_50%?"
    assert row["running"] is False


async def test_summaries_name_only_projects_the_user_can_open(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    readable = await make_project("Lesbar")
    foreign = await make_project("Fremd", readers=(OTHER,))
    trashed = await make_project("Gelöscht", deleted=True)
    for project in (readable, foreign, trashed):
        # Created directly: the API refuses projects the user cannot read.
        await repo.create_conversation(USER, "project.map", project, None)
    async with api() as client:
        rows = {
            row["project_id"]: row
            for row in (await client.get("/conversations")).json()
        }
    assert (
        rows[str(readable)]["project_name"],
        rows[str(readable)]["project_access"],
    ) == ("Lesbar", True)
    assert (
        rows[str(foreign)]["project_name"],
        rows[str(foreign)]["project_access"],
    ) == (None, False)
    assert (
        rows[str(trashed)]["project_name"],
        rows[str(trashed)]["project_access"],
    ) == (None, False)


async def test_patch_renames_and_clears_the_title(api: Api) -> None:
    async with api() as client:
        conversation = await _create(client)
        renamed = await client.patch(
            f"/conversations/{conversation['id']}", json={"title": "  Radwege  "}
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["title"] == "Radwege"
        cleared = await client.patch(
            f"/conversations/{conversation['id']}", json={"title": ""}
        )
        assert cleared.json()["title"] is None
        too_long = await client.patch(
            f"/conversations/{conversation['id']}", json={"title": "x" * 201}
        )
        assert too_long.status_code == 422
        assert (
            too_long.json()["detail"]["code"] == "invalid_request"
        )  # plan 2's handler (D21)


async def test_patch_binds_an_unbound_conversation_once(
    api: Api, make_project: Projects
) -> None:
    first = await make_project("Eins")
    second = await make_project("Zwei")
    async with api() as client:
        conversation = await _create(client)
        bound = await client.patch(
            f"/conversations/{conversation['id']}", json={"project_id": str(first)}
        )
        assert bound.status_code == 200, bound.text
        assert (bound.json()["project_id"], bound.json()["project_name"]) == (
            str(first),
            "Eins",
        )
        again = await client.patch(
            f"/conversations/{conversation['id']}", json={"project_id": str(first)}
        )
        assert again.status_code == 200
        moved = await client.patch(
            f"/conversations/{conversation['id']}", json={"project_id": str(second)}
        )
    assert moved.status_code == 409
    assert moved.json()["detail"]["code"] == "conversation_bound"
    assert moved.json()["detail"]["project_id"] == str(first)


async def test_binding_needs_read_access_to_the_project(
    api: Api, make_project: Projects
) -> None:
    foreign = await make_project("P", readers=(OTHER,))
    async with api() as client:
        conversation = await _create(client)
        refused = await client.patch(
            f"/conversations/{conversation['id']}", json={"project_id": str(foreign)}
        )
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "project_not_readable"
        created = await client.post(
            "/conversations",
            json={"origin_surface": "project.map", "project_id": str(foreign)},
        )
        assert created.status_code == 403
        assert created.json()["detail"]["code"] == "project_not_readable"
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    assert detail["conversation"]["project_id"] is None


async def test_another_users_conversation_is_not_found_with_a_code(api: Api) -> None:
    async with api(user=OTHER) as other:
        conversation = await _create(other)
    async with api() as client:
        for response in (
            await client.get(f"/conversations/{conversation['id']}"),
            await client.patch(
                f"/conversations/{conversation['id']}", json={"title": "x"}
            ),
            await client.get(f"/conversations/{uuid4()}"),
        ):
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == "conversation_not_found"
        own = await _create(client)
        missing_run = await client.get(
            f"/conversations/{own['id']}/stream", params={"run_id": str(uuid4())}
        )
    assert missing_run.status_code == 404
    assert missing_run.json()["detail"]["code"] == "run_not_found"


async def test_busy_and_limit_refusals_carry_codes(
    api: Api, repo: Repository, settings: AssistantSettings
) -> None:
    async with api() as client:
        conversations = [
            await _create(client) for _ in range(settings.user_max_concurrent_runs + 1)
        ]
        # Active runs recorded without a task: they stay queued during the test.
        for conversation in conversations[:-1]:
            await repo.begin_run(
                UUID(conversation["id"]),
                USER,
                [{"type": "user_text", "text": "x"}],
                "test",
                "test",
                99,
            )
        busy = await client.post(
            f"/conversations/{conversations[0]['id']}/runs",
            json={"message": {"text": "again"}},
        )
        limit = await client.post(
            f"/conversations/{conversations[-1]['id']}/runs",
            json={"message": {"text": "one more"}},
        )
    assert (busy.status_code, busy.json()["detail"]["code"]) == (
        409,
        "conversation_busy",
    )
    assert (limit.status_code, limit.json()["detail"]["code"]) == (
        429,
        "user_run_limit",
    )


async def test_a_run_message_needs_no_id(api: Api) -> None:
    async with api() as client:
        conversation = await _create(client)
        response = await client.post(
            f"/conversations/{conversation['id']}/runs",
            json={"message": {"text": "hi"}},
        )
    assert response.status_code == 200, response.text


async def test_the_browser_may_send_patch(
    api: Api, settings: AssistantSettings
) -> None:
    origin = settings.cors_origins[0]
    async with api() as client:
        response = await client.options(
            f"/conversations/{uuid4()}",
            headers={"Origin": origin, "Access-Control-Request-Method": "PATCH"},
        )
    assert response.status_code == 200
    assert "PATCH" in response.headers["access-control-allow-methods"]


async def test_a_long_first_message_is_cut_to_200_characters(
    api: Api, repo: Repository
) -> None:
    async with api() as client:
        conversation = await _create(client)
        await _ask(client, conversation["id"], "a" * 150 + "b" * 150)
        row = (await client.get("/conversations")).json()[0]
        # The search still sees the part that the summary cuts off.
        found = (await client.get("/conversations", params={"q": "b" * 100})).json()
    assert row["first_message"] == "a" * 150 + "b" * 49 + "\u2026"
    assert len(row["first_message"]) == 200
    assert [r["id"] for r in found] == [conversation["id"]]


async def test_a_backslash_in_the_search_is_literal(api: Api) -> None:
    async with api() as client:
        windows = await _create(client, title="C:\\Daten")
        await _create(client, title="C:/Daten")
        found = (await client.get("/conversations", params={"q": "\\"})).json()
        none = (await client.get("/conversations", params={"q": "\\x"})).json()
    assert [r["id"] for r in found] == [windows["id"]]
    assert none == []


async def test_a_blank_search_lists_everything(api: Api) -> None:
    async with api() as client:
        created = {(await _create(client))["id"] for _ in range(2)}
        listed = (await client.get("/conversations", params={"q": "   "})).json()
    assert {r["id"] for r in listed} == created


async def test_a_conversation_deleted_during_binding_is_not_found(
    api: Api, make_project: Projects, repo: Repository, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await make_project("P")
    original = Repository.bind_project

    async def delete_then_bind(
        self: Repository, conversation_id: UUID, user_id: UUID, project_id: UUID
    ) -> UUID | None:
        await self.delete_conversation(conversation_id, user_id)
        return await original(self, conversation_id, user_id, project_id)

    monkeypatch.setattr(Repository, "bind_project", delete_then_bind)
    async with api() as client:
        conversation = await _create(client)
        response = await client.patch(
            f"/conversations/{conversation['id']}", json={"project_id": str(project)}
        )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "conversation_not_found"


async def test_concurrent_binds_to_different_projects_have_one_winner(
    api: Api, make_project: Projects
) -> None:
    first = await make_project("Eins")
    second = await make_project("Zwei")
    async with api() as client:
        conversation = await _create(client)
        url = f"/conversations/{conversation['id']}"
        responses = await asyncio.gather(
            client.patch(url, json={"project_id": str(first)}),
            client.patch(url, json={"project_id": str(second)}),
        )
        final = (await client.get(url)).json()["conversation"]["project_id"]
    ok = [r for r in responses if r.status_code == 200]
    lost = [r for r in responses if r.status_code == 409]
    assert len(ok) == 1 and len(lost) == 1
    assert ok[0].json()["project_id"] == final
    assert lost[0].json()["detail"]["code"] == "conversation_bound"
    assert lost[0].json()["detail"]["project_id"] == final


async def test_a_home_message_with_sources_reloads_with_its_context(
    api: Api, make_project: Projects
) -> None:
    source = await make_project("Quelle")
    sources = [{"kind": "project", "id": str(source), "name": "Quelle"}]
    async with api() as client:
        conversation = await _create(client)
        await _ask(
            client,
            conversation["id"],
            "Vergleiche",
            {"surface": "none", "sources": sources},
        )
        await _ask(client, conversation["id"], "Und sonst?", {"surface": "none"})
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    users = [m for m in detail["messages"] if m["role"] == "user"]
    assert users[0]["parts"][1] == {
        "type": "data-context",
        "data": {"surface": "none", "sources": sources},
    }
    # A home message without sources keeps storing no context part.
    assert [p["type"] for p in users[1]["parts"]] == ["text"]


async def test_a_reloaded_conversation_carries_each_message_s_time(api: Api) -> None:
    async with api() as client:
        conversation = await _create(client)
        await _ask(client, conversation["id"], "Wo gibt es Spielplätze?")
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    times = [m.get("metadata", {}).get("created_at") for m in detail["messages"]]
    assert times and all(times), detail["messages"]
    assert all(t.endswith("+00:00") for t in times)
