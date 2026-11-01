"""Saves of a workflow, a report layout and a dashboard never silently
overwrite each other.

Every save sends the revision it read (`base_revision`, for the dashboard
`builder_base_revision`). A save that changes the document raises the revision
by one in the same statement that checks it; one made on an older revision
answers 409 `changed_elsewhere` and writes nothing. A save that changes only
volatile parts (viewport, selection, run state, editor-only toggles) is
written in place without a new revision and without the check, and an
unchanged save writes nothing.
"""

import asyncio
import copy
import logging
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core import revision as revision_module
from core.core.config import settings
from core.crud.crud_workflow import workflow as crud_workflow
from core.db.session import session_manager
from core.schemas.workflow import WorkflowUpdate
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_template_api import _create_project, _create_workflow

API = settings.API_V2_STR
S = settings.SCHEMA


def _workflow_config() -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "dataset-1",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {"type": "dataset", "label": "Input Layer"},
            },
            {
                "id": "tool-1",
                "type": "tool",
                "position": {"x": 300, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "label": "Buffer",
                    "config": {"distance": 100},
                    "status": "idle",
                },
            },
        ],
        "edges": [
            {
                "id": "edge-1",
                "source": "dataset-1",
                "target": "tool-1",
                "targetHandle": "input_layer_id",
            }
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


def _with_distance(distance: int) -> dict[str, Any]:
    config = _workflow_config()
    config["nodes"][1]["data"]["config"]["distance"] = distance
    return config


def _with_viewport(config: dict[str, Any], zoom: float) -> dict[str, Any]:
    moved = copy.deepcopy(config)
    moved["viewport"] = {"x": -120, "y": 40, "zoom": zoom}
    return moved


async def _workflow(client: AsyncClient, project_id: str, workflow_id: str) -> Any:
    response = await client.get(f"{API}/project/{project_id}/workflow/{workflow_id}")
    assert response.status_code == 200, response.text
    return response.json()


async def _put_workflow(
    client: AsyncClient, project_id: str, workflow_id: str, body: dict[str, Any]
) -> Response:
    return await client.put(
        f"{API}/project/{project_id}/workflow/{workflow_id}", json=body
    )


def _assert_changed_elsewhere(response: Response, revision: int) -> None:
    assert response.status_code == 409, response.text
    body = response.json()
    assert set(body) == {"detail", "revision", "updated_at", "updated_by"}
    assert body["detail"] == "changed_elsewhere"
    assert body["revision"] == revision
    assert body["updated_at"]
    assert body["updated_by"]["id"] == settings.DEFAULT_USER_ID
    assert set(body["updated_by"]) == {"id", "firstname", "lastname", "avatar"}


# Workflows


@pytest.mark.asyncio
async def test_a_new_workflow_starts_at_revision_1_and_reads_carry_it(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    created = await client.post(
        f"{API}/project/{project_id}/workflow",
        json={"name": "wf", "config": _workflow_config()},
    )
    assert created.status_code == 201, created.text
    assert created.json()["revision"] == 1

    workflow_id = created.json()["id"]
    assert (await _workflow(client, project_id, workflow_id))["revision"] == 1
    listed = await client.get(f"{API}/project/{project_id}/workflow")
    assert [w["revision"] for w in listed.json()] == [1]


@pytest.mark.asyncio
async def test_two_saves_on_the_same_revision_one_lands_one_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())

    first = await _put_workflow(
        client,
        project_id,
        workflow_id,
        {"config": _with_distance(200), "base_revision": 1},
    )
    second = await _put_workflow(
        client,
        project_id,
        workflow_id,
        {"config": _with_distance(300), "base_revision": 1},
    )

    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 2
    _assert_changed_elsewhere(second, revision=2)
    stored = await _workflow(client, project_id, workflow_id)
    assert stored["config"] == _with_distance(200)
    assert stored["revision"] == 2

    # The editor's "Keep mine" saves on top of the revision the 409 named.
    kept = await _put_workflow(
        client,
        project_id,
        workflow_id,
        {"config": _with_distance(300), "base_revision": 2},
    )
    assert kept.status_code == 200, kept.text
    assert kept.json()["revision"] == 3


@pytest.mark.asyncio
async def test_a_viewport_only_save_on_an_old_revision_lands_without_a_new_one(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())
    renamed = await _put_workflow(
        client, project_id, workflow_id, {"name": "renamed", "base_revision": 1}
    )
    assert renamed.json()["revision"] == 2
    before = await _workflow(client, project_id, workflow_id)

    # A tab still on revision 1 pans the canvas and a run finishes there.
    panned = _with_viewport(_workflow_config(), zoom=2.5)
    panned["nodes"][1]["data"].update(status="completed", jobId="job-1")
    panned["nodes"][0]["selected"] = True
    response = await _put_workflow(
        client, project_id, workflow_id, {"config": panned, "base_revision": 1}
    )

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 2
    after = await _workflow(client, project_id, workflow_id)
    assert after["config"] == panned
    assert after["name"] == "renamed"
    assert after["revision"] == 2
    assert after["updated_at"] == before["updated_at"]


@pytest.mark.asyncio
async def test_an_unchanged_save_writes_nothing(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())
    before = await _workflow(client, project_id, workflow_id)

    response = await _put_workflow(
        client,
        project_id,
        workflow_id,
        {"name": "wf", "config": _workflow_config(), "base_revision": 7},
    )

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    after = await _workflow(client, project_id, workflow_id)
    assert after == before


@pytest.mark.asyncio
async def test_a_rename_alone_is_a_new_revision(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())

    renamed = await _put_workflow(
        client, project_id, workflow_id, {"name": "renamed", "base_revision": 1}
    )
    stale = await _put_workflow(
        client, project_id, workflow_id, {"name": "again", "base_revision": 1}
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["revision"] == 2
    _assert_changed_elsewhere(stale, revision=2)
    assert (await _workflow(client, project_id, workflow_id))["name"] == "renamed"


@pytest.mark.asyncio
async def test_a_save_without_a_base_revision_still_lands_and_is_logged(
    client: AsyncClient,
    fixture_get_home_folder: dict[str, object],
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())
    await _put_workflow(
        client, project_id, workflow_id, {"name": "renamed", "base_revision": 1}
    )

    with caplog.at_level(logging.WARNING, logger="core.core.revision"):
        response = await _put_workflow(
            client, project_id, workflow_id, {"config": _with_distance(500)}
        )

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 3
    assert (await _workflow(client, project_id, workflow_id))["config"] == (
        _with_distance(500)
    )
    assert any(
        "base_revision" in record.getMessage() and workflow_id in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_a_volatile_save_never_overwrites_a_change_that_landed_after_its_read(
    client: AsyncClient,
    fixture_get_home_folder: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The in-place write is checked against the revision it was compared
    with: a real change that lands between the read and the write sends the
    save through the conflict check again."""
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())

    real_read = revision_module._read
    stale: dict[str, Any] = {}

    async def read_then_let_another_save_land(*args: Any, **kwargs: Any) -> Any:
        row = await real_read(*args, **kwargs)
        if not stale:
            stale.update(row)
            # Another tab saves a real change right after this read.
            monkeypatch.setattr(revision_module, "_read", real_read)
            other = await _put_workflow(
                client,
                project_id,
                workflow_id,
                {"config": _with_distance(900), "base_revision": 1},
            )
            assert other.status_code == 200, other.text
        return row

    monkeypatch.setattr(revision_module, "_read", read_then_let_another_save_land)
    response = await _put_workflow(
        client,
        project_id,
        workflow_id,
        {"config": _with_viewport(_workflow_config(), zoom=3), "base_revision": 1},
    )

    assert stale["revision"] == 1
    _assert_changed_elsewhere(response, revision=2)
    assert (await _workflow(client, project_id, workflow_id))["config"] == (
        _with_distance(900)
    )


def _assistant_draft_config() -> dict[str, Any]:
    """In the form the assistant writes a workflow
    (apps/assistant/src/assistant/workflows/draft.py `to_config`): the steps,
    then the notes, each note with `zIndex`."""
    config = _workflow_config()
    config["nodes"].append(
        {
            "id": "note-1",
            "type": "textAnnotation",
            "position": {"x": 0, "y": 200},
            "zIndex": -1000,
            "data": {
                "type": "textAnnotation",
                "text": "<p>Buffers the input</p>",
                "backgroundColor": "#F2CE58",
                "width": 400,
                "height": 200,
            },
        }
    )
    return config


def _as_the_editor_saves(config: dict[str, Any]) -> dict[str, Any]:
    """`config` as the editor saves it back (apps/web: `configToReactFlow`
    puts notes first, `useWorkflowAutosave` sends id, type, position, data)."""
    nodes = [
        {key: node[key] for key in ("id", "type", "position", "data")}
        for node in config["nodes"]
    ]
    nodes.sort(key=lambda node: node["type"] != "textAnnotation")
    return {**copy.deepcopy(config), "nodes": nodes}


@pytest.mark.asyncio
async def test_the_editors_first_save_of_an_assistant_workflow_is_no_change(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    """Opening an assistant's workflow and panning raises no revision, so a
    later real save on the revision read before still lands."""
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _assistant_draft_config())

    panned = _with_viewport(_as_the_editor_saves(_assistant_draft_config()), zoom=2)
    first_autosave = await _put_workflow(
        client, project_id, workflow_id, {"config": panned, "base_revision": 1}
    )

    assert first_autosave.status_code == 200, first_autosave.text
    assert first_autosave.json()["revision"] == 1
    assert (await _workflow(client, project_id, workflow_id))["config"] == panned

    edited = _as_the_editor_saves(_assistant_draft_config())
    [tool] = [node for node in edited["nodes"] if node["id"] == "tool-1"]
    tool["data"]["config"]["distance"] = 200
    real_save = await _put_workflow(
        client, project_id, workflow_id, {"config": edited, "base_revision": 1}
    )
    assert real_save.status_code == 200, real_save.text
    assert real_save.json()["revision"] == 2


@pytest.mark.asyncio
async def test_concurrent_saves_on_the_same_revision_one_lands_one_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())

    async def save(distance: int, base: int) -> Any:
        async with session_manager.session() as session:
            return await crud_workflow.update_for_project(
                session,
                project_id=UUID(project_id),
                workflow_id=UUID(workflow_id),
                obj_in=WorkflowUpdate(
                    config=_with_distance(distance), base_revision=base
                ),
                user_id=UUID(settings.DEFAULT_USER_ID),
            )

    for base in range(1, 11):
        results = await asyncio.gather(
            save(1000 + base, base), save(2000 + base, base), return_exceptions=True
        )
        landed = [r for r in results if not isinstance(r, BaseException)]
        refused = [
            r for r in results if isinstance(r, revision_module.ChangedElsewhereError)
        ]
        assert len(landed) == 1 and len(refused) == 1, results
        assert landed[0].revision == base + 1
        assert refused[0].revision == base + 1
        stored = await _workflow(client, project_id, workflow_id)
        assert stored["config"] == landed[0].config


@pytest.mark.asyncio
async def test_a_new_default_leaves_the_others_last_change_as_it_was(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    """Moving the default flag to another workflow or layout is no change of
    the one that loses it: its revision and the time of its last change stay."""
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    for kind, body in (
        ("workflow", {"config": _workflow_config()}),
        ("report-layout", {"config": _layout_config()}),
    ):
        url = f"{API}/project/{project_id}/{kind}"
        old = await client.post(url, json={**body, "name": "old", "is_default": True})
        new = await client.post(url, json={**body, "name": "new"})
        assert old.status_code == 201 and new.status_code == 201, kind

        moved = await client.put(
            f"{url}/{new.json()['id']}", json={"is_default": True, "base_revision": 1}
        )

        assert moved.status_code == 200, moved.text
        after = (await client.get(f"{url}/{old.json()['id']}")).json()
        assert after["is_default"] is False, kind
        assert after["revision"] == 1, kind
        assert after["updated_at"] == old.json()["updated_at"], kind


@pytest.mark.asyncio
async def test_the_saver_is_recorded(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, object],
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _workflow_config())
    await _put_workflow(
        client, project_id, workflow_id, {"config": _with_distance(250)}
    )

    updated_by = (
        await db_session.execute(
            text(f"SELECT updated_by FROM {S}.workflow WHERE id = :id"),
            {"id": workflow_id},
        )
    ).scalar_one()
    assert str(updated_by) == settings.DEFAULT_USER_ID


@pytest.mark.asyncio
async def test_a_row_written_without_a_revision_reads_revision_1(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """Rows written by other services (project import, copies) name no
    revision and start at 1."""
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id, layout_id = uuid4(), uuid4()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.workflow (id, project_id, name, is_default, config,"
            " updated_at) VALUES (:id, :p, 'raw', false, '{}'::jsonb, now())"
        ),
        {"id": workflow_id, "p": UUID(project_id)},
    )
    await db_session.execute(
        text(
            f"INSERT INTO {S}.report_layout (id, project_id, name, is_default,"
            " is_predefined, config, updated_at)"
            " VALUES (:id, :p, 'raw', false, false, '{}'::jsonb, now())"
        ),
        {"id": layout_id, "p": UUID(project_id)},
    )
    await db_session.commit()

    revisions = (
        await db_session.execute(
            text(
                f"SELECT (SELECT revision FROM {S}.workflow WHERE id = :w),"
                f" (SELECT revision FROM {S}.report_layout WHERE id = :l),"
                f" (SELECT builder_revision FROM {S}.project WHERE id = :p)"
            ),
            {"w": workflow_id, "l": layout_id, "p": UUID(project_id)},
        )
    ).one()
    assert tuple(revisions) == (1, 1, 1)


# Report layouts


def _layout_config() -> dict[str, Any]:
    return {
        "page": {"size": "A4", "orientation": "portrait", "snapToGuides": False},
        "layout": {"type": "grid", "columns": 12, "rows": 12, "gap": 5},
        "elements": [],
    }


async def _create_layout(client: AsyncClient, project_id: str) -> Any:
    response = await client.post(
        f"{API}/project/{project_id}/report-layout",
        json={"name": "layout", "config": _layout_config()},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _layout(client: AsyncClient, project_id: str, layout_id: str) -> Any:
    response = await client.get(f"{API}/project/{project_id}/report-layout/{layout_id}")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_layout_saves_on_the_same_revision_one_lands_one_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    created = await _create_layout(client, project_id)
    assert created["revision"] == 1
    url = f"{API}/project/{project_id}/report-layout/{created['id']}"

    landscape = _layout_config()
    landscape["page"]["orientation"] = "landscape"
    a3 = _layout_config()
    a3["page"]["size"] = "A3"
    first = await client.put(url, json={"config": landscape, "base_revision": 1})
    second = await client.put(url, json={"config": a3, "base_revision": 1})

    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 2
    _assert_changed_elsewhere(second, revision=2)
    assert (await _layout(client, project_id, created["id"]))["config"] == landscape


@pytest.mark.asyncio
async def test_layout_view_toggles_on_an_old_revision_land_without_a_new_one(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    created = await _create_layout(client, project_id)
    url = f"{API}/project/{project_id}/report-layout/{created['id']}"
    renamed = await client.put(url, json={"name": "renamed", "base_revision": 1})
    assert renamed.json()["revision"] == 2

    toggled = _layout_config()
    toggled["page"].update(snapToGuides=True, showRulers=True)
    response = await client.put(url, json={"config": toggled, "base_revision": 1})

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 2
    stored = await _layout(client, project_id, created["id"])
    assert stored["config"] == toggled
    assert stored["name"] == "renamed"


@pytest.mark.asyncio
async def test_an_unchanged_layout_save_keeps_its_revision(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    created = await _create_layout(client, project_id)

    response = await client.put(
        f"{API}/project/{project_id}/report-layout/{created['id']}",
        json={"config": _layout_config(), "base_revision": 1},
    )

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1


# The dashboard (a project's builder_config)


def _dashboard(toolbar: bool) -> dict[str, Any]:
    return {"settings": {"toolbar": toolbar}, "interface": [], "interactions": []}


async def _project(client: AsyncClient, project_id: str) -> Any:
    response = await client.get(f"{API}/project/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_dashboard_saves_on_the_same_revision_one_lands_one_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    assert (await _project(client, project_id))["builder_revision"] == 1
    url = f"{API}/project/{project_id}"

    first = await client.put(
        url, json={"builder_config": _dashboard(False), "builder_base_revision": 1}
    )
    second = await client.put(
        url,
        json={
            "builder_config": {**_dashboard(True), "interactions": [{"id": "x"}]},
            "builder_base_revision": 1,
        },
    )

    assert first.status_code == 200, first.text
    assert first.json()["builder_revision"] == 2
    _assert_changed_elsewhere(second, revision=2)
    stored = await _project(client, project_id)
    assert stored["builder_config"] == _dashboard(False)
    assert stored["builder_revision"] == 2


@pytest.mark.asyncio
async def test_project_saves_without_a_dashboard_change_keep_its_revision(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    url = f"{API}/project/{project_id}"
    await client.put(
        url, json={"builder_config": _dashboard(False), "builder_base_revision": 1}
    )

    # A rename from another tab, and the same dashboard saved on an old base.
    renamed = await client.put(url, json={"name": "renamed"})
    unchanged = await client.put(
        url, json={"builder_config": _dashboard(False), "builder_base_revision": 1}
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["builder_revision"] == 2
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["builder_revision"] == 2
    assert (await _project(client, project_id))["name"] == "renamed"


@pytest.mark.asyncio
async def test_a_dashboard_save_without_a_base_revision_still_lands(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))

    response = await client.put(
        f"{API}/project/{project_id}",
        json={"builder_config": _dashboard(False), "name": "with dashboard"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["builder_revision"] == 2
    stored = await _project(client, project_id)
    assert stored["builder_config"] == _dashboard(False)
    assert stored["name"] == "with dashboard"
