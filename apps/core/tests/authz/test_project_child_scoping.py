"""A project-child id is only ever resolved inside the project in its path (S3).

`layer_project` ids come from one global sequence and `auth_z` only checks the
caller's role on the `{project_id}` in the path, so a route that fetched the
child by its own id alone let anyone who owns any project read, restyle and
delete another tenant's project-layer link. Every such route now looks the
child up by both ids, so a foreign id is simply not found.
"""

from collections.abc import Awaitable, Callable

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_shareable_links import _bearer

S = settings.SCHEMA


async def _link(db: AsyncSession, project: Project, layer: Layer) -> int:
    link = LayerProjectLink(
        project_id=project.id,
        layer_id=layer.id,
        name=layer.name,
        properties={},
        shareable=True,
    )
    db.add(link)
    await db.flush()
    assert link.id is not None
    return link.id


@pytest.mark.asyncio
async def test_foreign_layer_project_id_is_not_found_under_my_own_project(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """GET, PUT and DELETE all 404 on a link that belongs to another project,
    and all three still work on the caller's own link."""
    org_a = await make_org()
    org_b = await make_org()
    attacker = await make_user(org_a.id)
    victim = await make_user(org_b.id)

    mine_folder = await make_folder(attacker, "Mine")
    mine_project = await make_project(attacker, mine_folder)
    mine_layer = await make_layer(attacker, mine_folder)
    mine_link = await _link(db_session, mine_project, mine_layer)

    theirs_folder = await make_folder(victim, "Theirs")
    theirs_project = await make_project(victim, theirs_folder)
    theirs_layer = await make_layer(victim, theirs_folder)
    theirs_link = await _link(db_session, theirs_project, theirs_layer)
    await db_session.commit()

    assert mine_link != theirs_link
    me = _bearer(attacker.id)
    base = f"{settings.API_V2_STR}/project/{mine_project.id}/layer"

    # The caller holds owner on `mine_project`, so `auth_z` lets him in — the
    # foreign link must still be invisible through it.
    read_foreign = await client.get(f"{base}/{theirs_link}", headers=me)
    assert read_foreign.status_code == 404, read_foreign.text

    write_foreign = await client.put(
        f"{base}/{theirs_link}", json={"name": "taken over"}, headers=me
    )
    assert write_foreign.status_code == 404, write_foreign.text

    delete_foreign = await client.delete(
        base, params={"layer_project_id": theirs_link}, headers=me
    )
    assert delete_foreign.status_code == 404, delete_foreign.text

    still_there = (
        await db_session.execute(
            text(f"SELECT name FROM {S}.layer_project WHERE id = :i"),
            {"i": theirs_link},
        )
    ).scalar_one_or_none()
    assert still_there == theirs_layer.name, "the refused calls changed nothing"

    # The same three calls against the caller's own link are unaffected.
    read_own = await client.get(f"{base}/{mine_link}", headers=me)
    assert read_own.status_code == 200, read_own.text
    assert int(read_own.json()["id"]) == mine_link

    write_own = await client.put(
        f"{base}/{mine_link}", json={"name": "renamed by the owner"}, headers=me
    )
    assert write_own.status_code == 200, write_own.text
    assert write_own.json()["name"] == "renamed by the owner"

    delete_own = await client.delete(
        base, params={"layer_project_id": mine_link}, headers=me
    )
    assert delete_own.status_code == 204, delete_own.text
    gone = (
        await db_session.execute(
            text(f"SELECT 1 FROM {S}.layer_project WHERE id = :i"), {"i": mine_link}
        )
    ).scalar_one_or_none()
    assert gone is None


@pytest.mark.asyncio
async def test_foreign_group_and_child_ids_are_not_found_either(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """The sibling project-child routes are scoped the same way: a layer
    group, report layout or workflow id from another project 404s."""
    org_a = await make_org()
    org_b = await make_org()
    attacker = await make_user(org_a.id)
    victim = await make_user(org_b.id)

    mine_project = await make_project(attacker, await make_folder(attacker, "Mine"))
    theirs_project = await make_project(victim, await make_folder(victim, "Theirs"))
    await db_session.commit()

    me = _bearer(attacker.id)
    theirs = f"{settings.API_V2_STR}/project/{theirs_project.id}"
    mine = f"{settings.API_V2_STR}/project/{mine_project.id}"

    group = await client.post(
        f"{theirs}/group", json={"name": "Theirs"}, headers=_bearer(victim.id)
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]

    layout = await client.post(
        f"{theirs}/report-layout",
        json={"name": "Theirs", "config": {}},
        headers=_bearer(victim.id),
    )
    assert layout.status_code == 201, layout.text
    layout_id = layout.json()["id"]

    workflow = await client.post(
        f"{theirs}/workflow",
        json={"name": "Theirs", "config": {"nodes": [], "edges": []}},
        headers=_bearer(victim.id),
    )
    assert workflow.status_code == 201, workflow.text
    workflow_id = workflow.json()["id"]

    for path, method, body in (
        (f"{mine}/group/{group_id}", "put", {"name": "taken over"}),
        (f"{mine}/group/{group_id}", "delete", None),
        (f"{mine}/report-layout/{layout_id}", "get", None),
        (f"{mine}/report-layout/{layout_id}", "put", {"name": "taken over"}),
        (f"{mine}/report-layout/{layout_id}", "delete", None),
        (f"{mine}/workflow/{workflow_id}", "get", None),
        (f"{mine}/workflow/{workflow_id}", "put", {"name": "taken over"}),
        (f"{mine}/workflow/{workflow_id}", "delete", None),
    ):
        response = await client.request(method.upper(), path, json=body, headers=me)
        assert response.status_code == 404, f"{method.upper()} {path}: {response.text}"

    # The victim's own reads still see untouched names.
    theirs_layout = await client.get(
        f"{theirs}/report-layout/{layout_id}", headers=_bearer(victim.id)
    )
    assert theirs_layout.status_code == 200, theirs_layout.text
    assert theirs_layout.json()["name"] == "Theirs"
    theirs_workflow = await client.get(
        f"{theirs}/workflow/{workflow_id}", headers=_bearer(victim.id)
    )
    assert theirs_workflow.status_code == 200, theirs_workflow.text
    assert theirs_workflow.json()["name"] == "Theirs"


@pytest.mark.asyncio
async def test_layer_tree_update_ignores_a_foreign_link(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`PUT /{project_id}/layer-tree` writes each row with a `project_id`
    predicate, so a foreign link id in the batch matches nothing."""
    org_a = await make_org()
    org_b = await make_org()
    attacker = await make_user(org_a.id)
    victim = await make_user(org_b.id)

    mine_project = await make_project(attacker, await make_folder(attacker, "Mine"))
    theirs_folder = await make_folder(victim, "Theirs")
    theirs_project = await make_project(victim, theirs_folder)
    theirs_layer = await make_layer(victim, theirs_folder)
    theirs_link = await _link(db_session, theirs_project, theirs_layer)
    await db_session.commit()

    tree = await client.put(
        f"{settings.API_V2_STR}/project/{mine_project.id}/layer-tree",
        json={
            "items": [
                {
                    "id": theirs_link,
                    "type": "layer",
                    "parent_id": None,
                    "order": 99,
                    "visible": False,
                }
            ]
        },
        headers=_bearer(attacker.id),
    )
    assert tree.status_code == 204, tree.text

    row = (
        await db_session.execute(
            text(f'SELECT "order", visible FROM {S}.layer_project WHERE id = :i'),
            {"i": theirs_link},
        )
    ).one()
    order: int = row[0]
    visible: bool = row[1]
    assert order == 0, "another project's link must not be reordered"
    assert visible, "another project's link must not be hidden"
