"""A conversation lives in one project (spec §10): binding on first use, read
only elsewhere, and hidden answers after the user lost access.

``api`` and ``make_project`` are the conftest fixtures (Task 2 Step 1)."""

from typing import Any
from uuid import UUID

import pytest
from httpx import AsyncClient

from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.repo import ConversationBoundElsewhere, Repository
from assistant.routers import conversations

USER = UUID(int=1)
OTHER = UUID(int=2)
Api = Any  # conftest.ApiFactory
Projects = Any  # conftest.ProjectFactory


def _map(project_id: UUID) -> dict[str, Any]:
    return {"surface": "project.map", "project_id": str(project_id)}


async def _run(
    client: AsyncClient, conversation_id: str, context: dict[str, Any] | None
) -> Any:
    return await client.post(
        f"/conversations/{conversation_id}/runs",
        json={"message": {"text": "Welche Layer gibt es?"}, "context": context},
    )


async def _message_count(repo: Repository, conversation_id: str) -> int:
    return len(await repo.list_messages(UUID(conversation_id), exclude_message_id=None))


async def test_a_run_from_a_project_binds_an_unbound_conversation(
    api: Api, make_project: Projects
) -> None:
    project = await make_project("P")
    async with api() as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        assert (
            await _run(client, conversation["id"], _map(project))
        ).status_code == 200
        # Bound once the run was accepted; the stream above has ended by now.
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
        # Every project mode counts as the same project.
        workflows = {"surface": "project.workflows", "project_id": str(project)}
        assert (await _run(client, conversation["id"], workflows)).status_code == 200
    assert detail["conversation"]["project_id"] == str(project)
    assert (detail["access"], detail["project_name"]) == ("ok", "P")


async def test_a_bound_conversation_is_refused_from_another_page(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    """Review Focus 2."""
    home, elsewhere = await make_project("P"), await make_project("P")
    async with api() as client:
        conversation = (
            await client.post(
                "/conversations",
                json={"origin_surface": "project.map", "project_id": str(home)},
            )
        ).json()
        for context in (
            _map(elsewhere),
            None,
            {"surface": "catalog"},
            {"surface": "none"},
        ):
            refused = await _run(client, conversation["id"], context)
            assert refused.status_code == 409, context
            assert refused.json()["detail"] == {
                "code": "conversation_bound",
                "message": "This conversation belongs to another project.",
                "project_id": str(home),
            }
    assert await _message_count(repo, conversation["id"]) == 0


def _source(project_id: UUID) -> list[dict[str, str]]:
    return [{"kind": "project", "id": str(project_id), "name": "Quelle"}]


async def test_sources_naming_the_bound_project_do_not_make_a_none_page_its_own(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    """Sources never change the target (ruling 20): a home page that mentions
    the bound project is still a page outside it."""
    home = await make_project("P")
    async with api() as client:
        conversation = (
            await client.post(
                "/conversations",
                json={"origin_surface": "project.map", "project_id": str(home)},
            )
        ).json()
        refused = await _run(
            client,
            conversation["id"],
            {"surface": "none", "sources": _source(home)},
        )
    assert refused.status_code == 409
    assert refused.json()["detail"] == {
        "code": "conversation_bound",
        "message": "This conversation belongs to another project.",
        "project_id": str(home),
    }
    assert await _message_count(repo, conversation["id"]) == 0


async def test_sources_naming_another_project_leave_the_binding_as_it_was(
    api: Api, make_project: Projects
) -> None:
    home, source = await make_project("A"), await make_project("B")
    async with api() as client:
        conversation = (
            await client.post(
                "/conversations",
                json={"origin_surface": "project.map", "project_id": str(home)},
            )
        ).json()
        context = {**_map(home), "sources": _source(source)}
        assert (await _run(client, conversation["id"], context)).status_code == 200
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
        unbound = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        home_page = {"surface": "none", "sources": _source(source)}
        assert (await _run(client, unbound["id"], home_page)).status_code == 200
        unbound_detail = (await client.get(f"/conversations/{unbound['id']}")).json()
    assert detail["conversation"]["project_id"] == str(home)
    assert unbound_detail["conversation"]["project_id"] is None


async def test_a_refused_run_never_binds(
    api: Api, make_project: Projects, settings: AssistantSettings
) -> None:
    """The binding follows an accepted run only; plan 3's refusals keep their answers."""
    project = await make_project("P")
    off = settings.model_copy(update={"disabled_surfaces": ["project.map"]})
    async with api(app_settings=off) as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        refused = await _run(client, conversation["id"], _map(project))
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    assert (refused.status_code, refused.json()["detail"]["code"]) == (
        403,
        "surface_disabled",
    )
    assert detail["conversation"]["project_id"] is None


async def test_a_run_in_a_project_the_user_cannot_read_is_refused(
    api: Api, make_project: Projects, repo: Repository
) -> None:
    foreign = await make_project("P", readers=(OTHER,))
    async with api() as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        refused = await _run(client, conversation["id"], _map(foreign))
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    assert (refused.status_code, refused.json()["detail"]["code"]) == (
        403,
        "project_not_readable",
    )
    assert detail["conversation"]["project_id"] is None
    assert await _message_count(repo, conversation["id"]) == 0


async def test_lost_access_hides_answers_and_refuses_runs(
    api: Api, make_project: Projects, db: Database, repo: Repository
) -> None:
    """Review Focus 3."""
    project = await make_project("P")
    async with api() as client:
        conversation = (
            await client.post(
                "/conversations",
                json={"origin_surface": "project.map", "project_id": str(project)},
            )
        ).json()
        assert (
            await _run(client, conversation["id"], _map(project))
        ).status_code == 200
        before = (await client.get(f"/conversations/{conversation['id']}")).json()
        assert [m["role"] for m in before["messages"]] == ["user", "assistant"]

        await db.pool.execute(
            f"DELETE FROM {db.customer('project_reader')} WHERE project_id = $1",
            project,
        )

        after = (await client.get(f"/conversations/{conversation['id']}")).json()
        refused = await _run(client, conversation["id"], _map(project))
        stored_after_refusal = await _message_count(repo, conversation["id"])
        stream = await client.get(f"/conversations/{conversation['id']}/stream")
        listed = (await client.get("/conversations")).json()
        deleted = await client.delete(f"/conversations/{conversation['id']}")
    assert (after["access"], after["project_name"]) == ("lost", None)
    assert after["messages"] == [
        {
            "id": after["messages"][0]["id"],
            "role": "user",
            "parts": [{"type": "text", "text": "Welche Layer gibt es?"}],
            "metadata": {"created_at": after["messages"][0]["metadata"]["created_at"]},
        }
    ]
    assert (refused.status_code, refused.json()["detail"]["code"]) == (
        403,
        "project_access_lost",
    )
    assert stored_after_refusal == 2  # the first question and its answer only
    assert (stream.status_code, stream.json()["detail"]["code"]) == (
        403,
        "project_access_lost",
    )
    assert (listed[0]["id"], listed[0]["project_access"]) == (conversation["id"], False)
    assert deleted.status_code == 204


async def test_a_deleted_project_counts_as_lost(
    api: Api, make_project: Projects, db: Database
) -> None:
    project = await make_project("P")
    async with api() as client:
        conversation = (
            await client.post(
                "/conversations",
                json={"origin_surface": "project.map", "project_id": str(project)},
            )
        ).json()
        await db.pool.execute(
            f"UPDATE {db.customer('project')} SET deleted_at = now() WHERE id = $1",
            project,
        )
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
        await db.pool.execute(
            f"DELETE FROM {db.customer('project')} WHERE id = $1", project
        )
        gone = (await client.get(f"/conversations/{conversation['id']}")).json()
    assert detail["access"] == "lost"
    assert gone["access"] == "lost"


# -- the binding race (ruling 20): begin_run binds or verifies in its transaction --


async def _run_count(repo: Repository, conversation_id: UUID) -> int:
    count: int = await repo.db.pool.fetchval(
        f"SELECT count(*) FROM {repo.db.t('run')} WHERE conversation_id = $1",
        conversation_id,
    )
    return count


@pytest.mark.parametrize("with_project", [True, False])
async def test_a_binding_made_after_the_check_refuses_the_run(
    with_project: bool,
    api: Api,
    make_project: Projects,
    repo: Repository,
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Another request binds the conversation to B between the route's check
    and the run's transaction: a run in A, or one without a project, is
    refused and nothing is stored."""
    here, elsewhere = await make_project("A"), await make_project("B")
    real_check = conversations._check_target

    async def check_then_bind_elsewhere(*args: Any) -> UUID | None:
        target = await real_check(*args)
        await db.pool.execute(
            f"UPDATE {db.t('conversation')} SET project_id = $2 WHERE id = $1",
            args[1]["id"],
            elsewhere,
        )
        return target

    monkeypatch.setattr(conversations, "_check_target", check_then_bind_elsewhere)
    async with api() as client:
        conversation = (
            await client.post("/conversations", json={"origin_surface": "catalog"})
        ).json()
        context = _map(here) if with_project else {"surface": "catalog"}
        refused = await _run(client, conversation["id"], context)
        detail = (await client.get(f"/conversations/{conversation['id']}")).json()
    assert refused.status_code == 409
    assert refused.json()["detail"] == {
        "code": "conversation_bound",
        "message": "This conversation belongs to another project.",
        "project_id": str(elsewhere),
    }
    assert detail["conversation"]["project_id"] == str(elsewhere)
    assert await _message_count(repo, conversation["id"]) == 0
    assert await _run_count(repo, UUID(conversation["id"])) == 0


async def test_begin_run_binds_an_unbound_conversation_to_its_target(
    repo: Repository, make_project: Projects
) -> None:
    project = await make_project("P")
    conversation_id = UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )
    await repo.begin_run(conversation_id, USER, [], "test", "test", 3, target=project)
    stored = await repo.get_conversation(conversation_id, USER)
    assert stored is not None and stored["project_id"] == project


async def test_begin_run_refuses_a_stale_target(
    repo: Repository, make_project: Projects
) -> None:
    home, elsewhere = await make_project("A"), await make_project("B")
    conversation_id = UUID(
        str((await repo.create_conversation(USER, "project.map", home, None))["id"])
    )
    with pytest.raises(ConversationBoundElsewhere) as refused:
        await repo.begin_run(
            conversation_id, USER, [], "test", "test", 3, target=elsewhere
        )
    assert refused.value.project_id == home
    assert await _message_count(repo, str(conversation_id)) == 0
    assert await _run_count(repo, conversation_id) == 0


async def test_begin_run_without_a_target_refuses_a_conversation_bound_meanwhile(
    repo: Repository, make_project: Projects
) -> None:
    """The route saw an unbound conversation and a page without a project; a
    PATCH bound it before the run's transaction."""
    elsewhere = await make_project("B")
    conversation_id = UUID(
        str((await repo.create_conversation(USER, "catalog", None, None))["id"])
    )
    assert await repo.bind_project(conversation_id, USER, elsewhere) == elsewhere
    with pytest.raises(ConversationBoundElsewhere) as refused:
        await repo.begin_run(conversation_id, USER, [], "test", "test", 3, target=None)
    assert refused.value.project_id == elsewhere
    assert await _message_count(repo, str(conversation_id)) == 0
    assert await _run_count(repo, conversation_id) == 0
