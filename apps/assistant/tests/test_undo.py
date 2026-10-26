"""The dock's Undo of an answer's workflow edits
(``POST /conversations/{id}/runs/{run_id}/undo``): it writes back what the
answer's edits replaced, through core's save on the revision the answer
left, under the user's own sign-in.

``api`` and ``make_project`` are conftest fixtures; core is a stateful fake
that checks ``base_revision`` as core does."""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx

from assistant.repo import Repository
from assistant.tools.testing import Recorder, fake_clients

USER = UUID(int=1)
OTHER = UUID(int=2)
Api = Any  # conftest.ApiFactory
ProjectFactory = Any  # conftest.ProjectFactory

ADA = {
    "id": str(UUID(int=7)),
    "firstname": "Ada",
    "lastname": "Lovelace",
    "avatar": None,
}


def config(label: str) -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "tool-walk",
                "type": "tool",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "catchment_area_v2",
                    "label": label,
                },
            }
        ],
        "edges": [],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


@dataclass
class Stored:
    config: dict[str, Any]
    revision: int
    updated_by: dict[str, Any] | None = None


@dataclass
class Core:
    """Core's workflow save as far as the Undo needs it: a save on another
    revision than the stored one answers 409 changed_elsewhere."""

    project_id: UUID
    workflows: dict[str, Stored] = field(default_factory=dict)
    #: The status every save answers with instead, when set (a viewer's 403).
    refuse: int | None = None
    #: Whether a save's answer names the revision.
    answer_revision: bool = True
    #: A save whose answer never comes: "after" it was written, or "before".
    time_out: str | None = None
    #: Whether a read of the workflow fails.
    read_fails: bool = False
    recorder: Recorder = field(default_factory=Recorder)

    def path(self, workflow_id: str) -> str:
        return f"/api/v2/project/{self.project_id}/workflow/{workflow_id}"

    def add(self, workflow_id: str, stored: Stored) -> None:
        self.workflows[workflow_id] = stored
        self.recorder.routes[("PUT", self.path(workflow_id))] = self._put(workflow_id)
        self.recorder.routes[("GET", self.path(workflow_id))] = self._get(workflow_id)

    def _get(self, workflow_id: str) -> Any:
        def get(request: httpx.Request) -> httpx.Response:
            if self.read_fails:
                return httpx.Response(500, json={"detail": "down"})
            stored = self.workflows[workflow_id]
            return httpx.Response(
                200,
                json={
                    "id": workflow_id,
                    "config": stored.config,
                    "revision": stored.revision,
                },
            )

        return get

    def _put(self, workflow_id: str) -> Any:
        def put(request: httpx.Request) -> httpx.Response:
            if self.refuse is not None:
                return httpx.Response(self.refuse, json={"detail": "Not allowed"})
            if self.time_out == "before":
                raise httpx.ReadTimeout("no answer", request=request)
            body = json.loads(request.content)
            stored = self.workflows[workflow_id]
            if body.get("base_revision") != stored.revision:
                return httpx.Response(
                    409,
                    json={
                        "detail": "changed_elsewhere",
                        "revision": stored.revision,
                        "updated_at": "2026-10-25T09:12:03+00:00",
                        "updated_by": stored.updated_by,
                    },
                )
            stored.config = body["config"]
            stored.revision += 1
            stored.updated_by = None
            if self.time_out == "after":
                raise httpx.ReadTimeout("no answer", request=request)
            answer = {"id": workflow_id, "config": stored.config}
            if self.answer_revision:
                answer["revision"] = stored.revision
            return httpx.Response(200, json=answer)

        return put

    def puts(self) -> list[tuple[str, Any]]:
        return [
            (request.url.path.rsplit("/", 1)[-1], json.loads(request.content))
            for request in self.recorder.requests
            if request.method == "PUT"
        ]


def edit(
    project_id: UUID, workflow_id: str, before: int, after: int, label: str
) -> dict[str, Any]:
    """An undo record as ``workflow_update`` writes it."""
    return {
        "kind": "workflow",
        "workflow_id": workflow_id,
        "project_id": str(project_id),
        "revision_before": before,
        "revision_after": after,
        "before": {"config": config(label)},
    }


async def answer(
    repo: Repository,
    project_id: UUID,
    records: list[dict[str, Any]],
    *,
    conversation_id: UUID | None = None,
    status: str = "succeeded",
) -> tuple[UUID, UUID, UUID]:
    """A finished answer whose ``workflow_update`` calls left ``records``:
    (conversation, run, answer)."""
    if conversation_id is None:
        conversation = await repo.create_conversation(
            USER, "project.workflows", project_id, None
        )
        conversation_id = conversation["id"]
    run_id, message_id = await repo.begin_run(
        conversation_id,
        USER,
        [{"type": "user_text", "text": "Change the walking time"}],
        "test",
        "test",
        4,
        target=project_id,
    )
    for index, record in enumerate(records):
        await repo.insert_tool_call(
            run_id=run_id,
            user_id=USER,
            tool="workflow_update",
            tool_call_id=f"call-{index}",
            args_summary={},
            result_bytes=100,
            duration_ms=5,
            status="ok",
            error=None,
            undo=record,
        )
    if status != "running":
        await repo.finish_run(
            run_id, status, None, [{"type": "text", "text": "Changed."}], []
        )
    return conversation_id, run_id, message_id


def url(conversation_id: UUID, run_id: UUID) -> str:
    return f"/conversations/{conversation_id}/runs/{run_id}/undo"


async def stored_answer(
    client: httpx.AsyncClient, conversation_id: UUID
) -> dict[str, Any]:
    body = (await client.get(f"/conversations/{conversation_id}")).json()
    found: dict[str, Any] = body["messages"][-1]
    return found


async def test_undo_writes_back_the_workflow_as_it_was_before_the_answer(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, message_id = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [
                {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
            ]
        }
        assert core.puts() == [
            ("wf-1", {"config": config("10 min"), "base_revision": 5})
        ]
        assert core.workflows["wf-1"].config == config("10 min")
        # The answer is undone, as the dock shows it when the conversation loads.
        stored = await stored_answer(client, conversation_id)
        assert stored["id"] == str(message_id)
        assert stored["metadata"]["run_id"] == str(run_id)
        assert stored["metadata"]["undone"] is True


async def test_two_edits_of_one_workflow_go_back_in_one_save(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("20 min"), revision=6))
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 5, 6, "15 min"),
            edit(project_id, "wf-1", 4, 5, "10 min"),
        ],
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
    assert response.status_code == 200, response.text
    # The oldest content on the newest revision: a save per edit would refuse
    # its own second save.
    assert core.puts() == [("wf-1", {"config": config("10 min"), "base_revision": 6})]
    assert core.workflows["wf-1"].revision == 7


async def test_a_save_after_the_answer_asks_and_force_saves_on_top(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    # A person moved a step after the answer's edit.
    core.add("wf-1", Stored(config("15 min, moved"), revision=6, updated_by=ADA))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        asked = await client.post(url(conversation_id, run_id), json={})
        assert asked.status_code == 409, asked.text
        assert asked.json()["detail"] == {
            "code": "changed_since",
            "message": "The workflow was changed after this answer edited it.",
            "workflows": [
                {
                    "workflow_id": "wf-1",
                    "project_id": str(project_id),
                    "revision": 6,
                    "updated_at": "2026-10-25T09:12:03+00:00",
                    "updated_by": ADA,
                    "between": False,
                }
            ],
            "undone": [],
        }
        # Nothing was written, and the answer is not undone.
        assert core.workflows["wf-1"].config == config("15 min, moved")
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )

        forced = await client.post(url(conversation_id, run_id), json={"force": True})
        assert forced.status_code == 200, forced.text
        assert forced.json()["workflows"] == [
            {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 7}
        ]
    assert core.puts()[-1] == ("wf-1", {"config": config("10 min"), "base_revision": 6})
    assert core.workflows["wf-1"].config == config("10 min")


async def test_edits_with_a_save_between_them_ask_before_anything_is_saved(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("20 min"), revision=7))
    # Someone saved revision 6 between the answer's two edits.
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 4, 5, "10 min"),
            edit(project_id, "wf-1", 6, 7, "15 min"),
        ],
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        asked = await client.post(url(conversation_id, run_id), json={})
        assert asked.status_code == 409, asked.text
        detail = asked.json()["detail"]
        assert detail["code"] == "changed_since"
        # Asked in words of its own: the save came between the answer's edits.
        assert [(w["workflow_id"], w["between"]) for w in detail["workflows"]] == [
            ("wf-1", True)
        ]
        assert core.puts() == []

        forced = await client.post(url(conversation_id, run_id), json={"force": True})
        assert forced.status_code == 200, forced.text
    assert core.puts() == [("wf-1", {"config": config("10 min"), "base_revision": 7})]


async def test_a_second_undo_is_refused(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        first = await client.post(url(conversation_id, run_id), json={})
        assert first.status_code == 200
        for body in ({}, {"force": True}):
            again = await client.post(url(conversation_id, run_id), json=body)
            assert again.status_code == 409, again.text
            assert again.json()["detail"]["code"] == "already_undone"
    assert len(core.puts()) == 1


async def test_two_clicks_at_once_save_once(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        responses = await asyncio.gather(
            client.post(url(conversation_id, run_id), json={}),
            client.post(url(conversation_id, run_id), json={}),
        )
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert len(core.puts()) == 1


async def test_someone_who_cannot_change_the_workflow_is_refused(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id, refuse=403)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        refused = await client.post(url(conversation_id, run_id), json={"force": True})
        assert refused.status_code == 403, refused.text
        assert refused.json()["detail"]["code"] == "undo_not_allowed"
        # Not undone: rights given back later still let it go through.
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )
        core.refuse = None
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 200, again.text


async def test_only_the_conversations_owner_may_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project(readers=(USER, OTHER))
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(user=OTHER, tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "conversation_not_found"
    assert core.puts() == []


async def test_an_answer_without_edits_or_of_another_conversation_has_nothing_to_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    conversation_id, run_id, _ = await answer(repo, project_id, [])
    other_conversation, other_run, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        nothing = await client.post(url(conversation_id, run_id), json={})
        assert nothing.status_code == 404
        assert nothing.json()["detail"]["code"] == "nothing_to_undo"
        elsewhere = await client.post(url(conversation_id, other_run), json={})
        assert elsewhere.status_code == 404
        assert elsewhere.json()["detail"]["code"] == "run_not_found"
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )
    assert other_conversation != conversation_id
    assert core.puts() == []


async def test_a_running_answer_is_not_undone(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")], status="running"
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "run_active"
    assert core.puts() == []


async def test_a_lost_project_is_not_undone_in(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project(readers=())
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "project_access_lost"
    assert core.puts() == []


async def test_each_workflow_goes_back_on_its_own(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    core.add("wf-2", Stored(config("bus, moved"), revision=3, updated_by=ADA))
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 4, 5, "10 min"),
            edit(project_id, "wf-2", 1, 2, "bus"),
        ],
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        asked = await client.post(url(conversation_id, run_id), json={})
        assert asked.status_code == 409, asked.text
        detail = asked.json()["detail"]
        assert [w["workflow_id"] for w in detail["workflows"]] == ["wf-2"]
        assert detail["undone"] == [
            {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
        ]
        forced = await client.post(url(conversation_id, run_id), json={"force": True})
        assert forced.status_code == 200, forced.text
        assert [w["workflow_id"] for w in forced.json()["workflows"]] == ["wf-2"]
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
    # wf-1 went back once. wf-2 was asked about, and with force it is tried
    # on the answer's revision once more, then saved on the person's.
    assert [put[0] for put in core.puts()] == ["wf-1", "wf-2", "wf-2", "wf-2"]
    assert core.puts()[-1] == ("wf-2", {"config": config("bus"), "base_revision": 3})


async def test_a_deleted_workflow_leaves_nothing_to_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.recorder.routes[("PUT", core.path("wf-1"))] = httpx.Response(
        404, json={"detail": "Workflow not found"}
    )
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {"workflows": []}
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True


async def test_an_answers_run_is_named_on_the_stored_answer(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    conversation_id, run_id, _ = await answer(repo, project_id, [])
    async with api() as client:
        body = (await client.get(f"/conversations/{conversation_id}")).json()
    question, reply = body["messages"]
    assert "run_id" not in question.get("metadata", {})
    assert reply["metadata"]["run_id"] == str(run_id)
    assert "undone" not in reply["metadata"]


async def test_a_save_whose_answer_names_no_revision_reads_it_back(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id, answer_revision=False)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json()["workflows"][0]["revision"] == 6
        # Not known even then: said so, never guessed.
        core.add("wf-2", Stored(config("bus"), revision=3))
        _, second, _ = await answer(
            repo,
            project_id,
            [edit(project_id, "wf-2", 2, 3, "tram")],
            conversation_id=conversation_id,
        )
        core.read_fails = True
        unknown = await client.post(url(conversation_id, second), json={})
        assert unknown.status_code == 200, unknown.text
        assert unknown.json()["workflows"][0]["revision"] is None
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True


async def test_a_restore_whose_answer_timed_out_counts_when_it_landed(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id, time_out="after")
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json()["workflows"][0]["revision"] == 6
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True


async def test_a_restore_that_timed_out_before_it_landed_is_not_done(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id, time_out="before")
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 503, response.text
        assert response.json()["detail"]["code"] == "undo_unavailable"
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )
        core.time_out = None
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 200, again.text


async def test_an_undo_under_way_elsewhere_is_not_told_as_done(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    now = datetime.now(UTC)
    claimed = {
        **edit(project_id, "wf-1", 4, 5, "10 min"),
        "undoing_at": now.isoformat(),
    }
    conversation_id, run_id, _ = await answer(repo, project_id, [claimed])
    async with api(tools=fake_clients(core=core.recorder)) as client:
        busy = await client.post(url(conversation_id, run_id), json={})
        assert busy.status_code == 409, busy.text
        assert busy.json()["detail"]["code"] == "undo_in_progress"
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )
    assert core.puts() == []
    # A claim left by a request that never finished frees itself after a while.
    stale = {
        **edit(project_id, "wf-1", 4, 5, "10 min"),
        "undoing_at": (now - timedelta(minutes=10)).isoformat(),
    }
    conversation_id, run_id, _ = await answer(repo, project_id, [stale])
    async with api(tools=fake_clients(core=core.recorder)) as client:
        freed = await client.post(url(conversation_id, run_id), json={})
        assert freed.status_code == 200, freed.text


async def test_an_answer_reads_undone_once_every_edit_the_undo_takes_is_undone(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    broken = {**edit(project_id, "wf-2", 1, 2, "x"), "before": None}
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min"), broken]
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
