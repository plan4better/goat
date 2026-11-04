"""`GET /project/layers/search`: layers by name across every project the
caller can read (the assistant's "which of my projects use X").

Each test acts as fresh users of a fresh organisation, so other tests' rows in
the shared test schema never show up, and searches for a token unique to the
test on top of that.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import find_resource

S = settings.SCHEMA
URL = f"{settings.API_V2_STR}/project/layers/search"
PATTERN = "project/layers/search"


def _bearer(user_id: UUID) -> dict[str, str]:
    """Authorization header making the test client act as `user_id`
    (`get_user_id` reads `sub` unverified under `AUTH=False`)."""

    def _segment(payload: dict[str, str]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    token = (
        f"{_segment({'alg': 'none', 'typ': 'JWT'})}."
        f"{_segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


def _token() -> str:
    """Hex only: no `%` or `_` of its own."""
    return uuid4().hex[:10]


async def _link(
    db: AsyncSession,
    project: Project,
    layer: Layer,
    name: str,
    *,
    shareable: bool = True,
) -> int:
    link = LayerProjectLink(
        project_id=project.id,
        layer_id=layer.id,
        name=name,
        properties={},
        shareable=shareable,
    )
    db.add(link)
    await db.flush()
    assert link.id is not None
    return int(link.id)


async def _grant(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: UUID,
    grantee_type: str,
    grantee_id: UUID,
    role_id: UUID,
    granted_by: UUID,
) -> None:
    await db.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, "
            "grantee_id, role_id, granted_by) VALUES (:t, :r, :gt, :g, :role, :by)"
        ),
        {
            "t": resource_type,
            "r": resource_id,
            "gt": grantee_type,
            "g": grantee_id,
            "role": role_id,
            "by": granted_by,
        },
    )


async def _search(
    client: AsyncClient, user: User, search: str, **params: int
) -> dict[str, Any]:
    response = await client.get(
        URL, params={"search": search, **params}, headers=_bearer(user.id)
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def _ids(page: dict[str, Any]) -> list[int]:
    return [hit["layer_project_id"] for hit in page["items"]]


@pytest.mark.asyncio
async def test_finds_layers_of_own_projects_by_name_or_dataset_name(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    project = await make_project(me, folder)
    by_name = await _link(
        db_session, project, await make_layer(me, folder), f"Radwege {token}"
    )
    renamed = await make_layer(me, folder)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET name = :n WHERE id = :l"),
        {"n": f"Fahrradständer {token}", "l": renamed.id},
    )
    by_dataset = await _link(db_session, project, renamed, "Abstellanlagen")
    await _link(db_session, project, await make_layer(me, folder), "Bezirke")
    await db_session.commit()

    # Case-insensitive, on the name in the project ...
    page = await _search(client, me, f"RADWEGE {token}")
    assert page["total"] == 1 and page["page"] == 1 and page["size"] == 20
    [hit] = page["items"]
    assert hit["project_updated_at"]
    assert {k: v for k, v in hit.items() if k != "project_updated_at"} == {
        "project_id": str(project.id),
        "project_name": project.name,
        "layer_project_id": by_name,
        "layer_name": f"Radwege {token}",
        "dataset_name": hit["dataset_name"],
        "layer_type": "feature",
        "geometry_type": "polygon",
        "locked": False,
    }
    # ... and on the dataset's own name.
    page = await _search(client, me, f"fahrradständer {token}")
    assert _ids(page) == [by_dataset]
    assert page["items"][0]["layer_name"] == "Abstellanlagen"
    assert page["items"][0]["dataset_name"] == f"Fahrradständer {token}"
    assert sorted(_ids(await _search(client, me, token))) == sorted(
        [by_name, by_dataset]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("grantee", ["user", "team", "organization", "folder"])
async def test_finds_layers_of_projects_shared_with_the_caller(
    grantee: str,
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    link = await _link(
        db_session, project, await make_layer(owner, folder), f"Radnetz {token}"
    )
    await db_session.commit()
    # In the owner's personal space: nobody else reads it without a grant.
    assert (await _search(client, me, token))["items"] == []

    if grantee == "folder":
        resource = {"resource_type": "folder", "resource_id": folder.id}
        target = {"grantee_type": "user", "grantee_id": me.id}
        role = roles["folder-viewer"]
    else:
        resource = {"resource_type": "project", "resource_id": project.id}
        role = roles["project-viewer"]
        if grantee == "team":
            team = await make_team(me, org=org)
            target = {"grantee_type": "team", "grantee_id": team.id}
        elif grantee == "organization":
            target = {"grantee_type": "organization", "grantee_id": org.id}
        else:
            target = {"grantee_type": "user", "grantee_id": me.id}
    await _grant(db_session, **resource, **target, role_id=role, granted_by=owner.id)
    await db_session.commit()

    page = await _search(client, me, token)
    assert _ids(page) == [link]
    assert page["items"][0]["project_id"] == str(project.id)


@pytest.mark.asyncio
async def test_finds_layers_below_a_folder_granted_higher_up(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """A grant on a folder reaches the projects of the folders below it."""
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    top = await make_folder(owner)
    middle = Folder(
        id=uuid4(), user_id=owner.id, space_id=top.space_id, parent_id=top.id, name="m"
    )
    db_session.add(middle)
    await db_session.flush()
    bottom = Folder(
        id=uuid4(),
        user_id=owner.id,
        space_id=top.space_id,
        parent_id=middle.id,
        name="b",
    )
    db_session.add(bottom)
    await db_session.flush()
    project = await make_project(owner, bottom)
    link = await _link(
        db_session, project, await make_layer(owner, top), f"Tief {token}"
    )
    await _grant(
        db_session,
        resource_type="folder",
        resource_id=top.id,
        grantee_type="user",
        grantee_id=me.id,
        role_id=roles["folder-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    assert _ids(await _search(client, me, token)) == [link]


@pytest.mark.asyncio
async def test_finds_layers_of_team_space_projects_without_a_grant(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    """Membership of the team's space is enough; leaving the team ends it."""
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    team = await make_team(me, owner, org=org)
    space = await make_space(SpaceKind.team, team=team)
    folder = Folder(id=uuid4(), user_id=owner.id, space_id=space.id, name="Team")
    db_session.add(folder)
    await db_session.flush()
    project = Project(
        id=uuid4(),
        user_id=owner.id,
        folder_id=folder.id,
        space_id=space.id,
        name=f"p-{token}",
    )
    db_session.add(project)
    await db_session.flush()
    link = await _link(
        db_session,
        project,
        await make_layer(owner, await make_folder(owner)),
        f"Team {token}",
    )
    await db_session.commit()

    assert _ids(await _search(client, me, token)) == [link]

    await db_session.execute(
        text(f"DELETE FROM {S}.user_team WHERE team_id = :t AND user_id = :u"),
        {"t": team.id, "u": me.id},
    )
    await db_session.commit()
    assert _ids(await _search(client, me, token)) == []


@pytest.mark.asyncio
async def test_a_revoked_grant_ends_the_search_too(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    link = await _link(
        db_session, project, await make_layer(owner, folder), f"Geteilt {token}"
    )
    await _grant(
        db_session,
        resource_type="project",
        resource_id=project.id,
        grantee_type="user",
        grantee_id=me.id,
        role_id=roles["project-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()
    assert _ids(await _search(client, me, token)) == [link]

    await db_session.execute(
        text(
            f"DELETE FROM {S}.resource_grant WHERE resource_type = 'project' "
            "AND resource_id = :p AND grantee_id = :u"
        ),
        {"p": project.id, "u": me.id},
    )
    await db_session.commit()
    assert _ids(await _search(client, me, token)) == []


@pytest.mark.asyncio
async def test_a_locked_layer_shows_only_its_name_in_the_project(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """D7: a non-shareable link to a dataset the caller cannot read is a locked
    row in the project's layer list, which shows its name in the project and
    nothing of the dataset. The search must neither return the dataset's name
    nor match on it, or probing substrings would spell it out."""
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    hidden = await make_layer(owner, folder)
    shared = await make_layer(owner, folder)
    for layer, name in ((hidden, "Geheim"), (shared, "Offen")):
        await db_session.execute(
            text(f"UPDATE {S}.layer SET name = :n WHERE id = :l"),
            {"n": f"{name} {token}", "l": layer.id},
        )
    locked = await _link(
        db_session, project, hidden, f"Platzhalter {token}", shareable=False
    )
    open_link = await _link(db_session, project, shared, f"Sichtbar {token}")
    await _grant(
        db_session,
        resource_type="project",
        resource_id=project.id,
        grantee_type="user",
        grantee_id=me.id,
        role_id=roles["project-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    # The project's layer list locks the same row for the same caller.
    listed = await client.get(
        f"{settings.API_V2_STR}/project/{project.id}/layer", headers=_bearer(me.id)
    )
    assert listed.status_code == 200, listed.text
    assert {row["id"]: row.get("locked", False) for row in listed.json()} == {
        locked: True,
        open_link: False,
    }

    assert (await _search(client, me, f"Geheim {token}"))["total"] == 0
    probed = (await _search(client, me, "Gehei"))["items"]
    assert locked not in {item["layer_project_id"] for item in probed}
    page = await _search(client, me, f"Platzhalter {token}")
    [hit] = page["items"]
    assert hit["layer_project_id"] == locked and hit["locked"] is True
    assert "dataset_name" not in hit
    # A shareable link still matches and shows its dataset's name.
    [hit] = (await _search(client, me, f"Offen {token}"))["items"]
    assert hit["layer_project_id"] == open_link
    assert hit["dataset_name"] == f"Offen {token}" and hit["locked"] is False
    # The owner of the dataset is not locked out of it.
    [hit] = (await _search(client, owner, f"Geheim {token}"))["items"]
    assert hit["layer_project_id"] == locked and hit["locked"] is False


@pytest.mark.asyncio
async def test_template_source_projects_are_left_out(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    source = await make_project(me, folder)
    await _link(db_session, source, await make_layer(me, folder), f"Vorlage {token}")
    live = await make_project(me, folder)
    kept = await _link(
        db_session, live, await make_layer(me, folder), f"Projekt {token}"
    )
    await db_session.execute(
        text(f"UPDATE {S}.project SET is_template_source = true WHERE id = :p"),
        {"p": source.id},
    )
    await db_session.commit()

    assert _ids(await _search(client, me, token)) == [kept]


@pytest.mark.asyncio
async def test_projects_the_caller_cannot_read_are_not_searched(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    someone = await make_user(org.id)
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    await _link(db_session, project, await make_layer(owner, folder), f"Intern {token}")
    # Shared, but with someone else.
    await _grant(
        db_session,
        resource_type="project",
        resource_id=project.id,
        grantee_type="user",
        grantee_id=someone.id,
        role_id=roles["project-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    assert (await _search(client, me, token))["total"] == 0
    assert _ids(await _search(client, owner, token)) != []
    assert _ids(await _search(client, someone, token)) != []

    # A project in the organisation's space is read by its members (a viewer
    # space) until it is marked Restricted: the space still makes it a
    # candidate, and `effective_role` then turns it down.
    org_space = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE organization_id = :o"), {"o": org.id}
        )
    ).scalar_one()
    org_folder = Folder(
        id=uuid4(), user_id=owner.id, space_id=org_space, name=f"f-{token}"
    )
    db_session.add(org_folder)
    await db_session.flush()
    shared = Project(
        id=uuid4(),
        user_id=owner.id,
        folder_id=org_folder.id,
        space_id=org_space,
        name=f"p-{token}",
    )
    db_session.add(shared)
    await db_session.flush()
    in_org = await _link(
        db_session, shared, await make_layer(owner, folder), f"Org {token}"
    )
    await db_session.commit()
    assert _ids(await _search(client, me, f"Org {token}")) == [in_org]

    await db_session.execute(
        text(f"UPDATE {S}.project SET restricted = true WHERE id = :p"),
        {"p": shared.id},
    )
    await db_session.commit()
    assert (await _search(client, me, f"Org {token}"))["items"] == []


@pytest.mark.asyncio
async def test_trashed_projects_and_datasets_are_left_out(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """The caller owns both. `effective_role` still hands the owner a trashed
    project (to restore it), so the search must leave it out itself."""
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    trashed = await make_project(me, folder)
    await _link(db_session, trashed, await make_layer(me, folder), f"Alt {token}")
    live = await make_project(me, folder)
    gone = await make_layer(me, folder)
    await _link(db_session, live, gone, f"Gelöscht {token}")
    kept = await _link(
        db_session, live, await make_layer(me, folder), f"Aktuell {token}"
    )
    await db_session.execute(
        text(f"UPDATE {S}.project SET deleted_at = now() WHERE id = :p"),
        {"p": trashed.id},
    )
    await db_session.execute(
        text(f"UPDATE {S}.layer SET deleted_at = now() WHERE id = :l"),
        {"l": gone.id},
    )
    await db_session.commit()
    role = (
        await db_session.execute(
            text(f"SELECT {S}.effective_role('project', :p, :u)"),
            {"p": trashed.id, "u": me.id},
        )
    ).scalar()
    assert role == "owner"

    assert _ids(await _search(client, me, token)) == [kept]


@pytest.mark.asyncio
async def test_percent_and_underscore_are_taken_literally(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    project = await make_project(me, folder)
    links = {}
    for name in ("50% Rad", "50x Rad", "rad_weg", "radxweg", "back\\slash"):
        links[name] = await _link(
            db_session, project, await make_layer(me, folder), f"{token} {name}"
        )
    await db_session.commit()

    assert _ids(await _search(client, me, f"{token} 50%")) == [links["50% Rad"]]
    assert _ids(await _search(client, me, "rad_weg")) == [links["rad_weg"]]
    assert _ids(await _search(client, me, "back\\slash")) == [links["back\\slash"]]
    assert _ids(await _search(client, me, f"{token}%Rad")) == []


@pytest.mark.asyncio
async def test_results_are_paged_and_the_page_size_is_capped(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    project = await make_project(me, folder)
    created = [
        await _link(
            db_session, project, await make_layer(me, folder), f"Layer {i} {token}"
        )
        for i in range(3)
    ]
    await db_session.commit()

    first = await _search(client, me, token, size=2)
    second = await _search(client, me, token, size=2, page=2)
    past = await _search(client, me, token, size=2, page=3)
    assert (first["total"], second["total"], past["total"]) == (3, 3, 3)
    assert len(first["items"]) == 2 and len(second["items"]) == 1
    assert past["items"] == []
    assert sorted(_ids(first) + _ids(second)) == sorted(created)

    for params in ({"size": 51}, {"size": 0}, {"page": 0}, {"page": 1001}):
        response = await client.get(
            URL, params={"search": token, **params}, headers=_bearer(me.id)
        )
        assert response.status_code == 422, params
    for search in ("", "x", " x ", "   ", "x" * 201):
        response = await client.get(
            URL, params={"search": search}, headers=_bearer(me.id)
        )
        assert response.status_code == 422, repr(search)


async def _authorized(db: AsyncSession, user_id: UUID) -> bool:
    """`customer.authorization`, the URL gate `auth_z` runs; it raises to refuse."""
    try:
        return bool(
            (
                await db.execute(
                    text(f"SELECT {S}.authorization(:u, :res, :path, 'GET')"),
                    {"u": user_id, "res": PATTERN, "path": PATTERN},
                )
            ).scalar()
        )
    except DBAPIError:
        await db.rollback()
        return False


@pytest.mark.asyncio
async def test_the_url_gate_admits_any_provisioned_user(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
) -> None:
    """`seed_roles` registers the path, so `auth_z` finds it under AUTH. Which
    projects' layers come back is decided per project inside the query."""
    await find_resource(db_session, PATTERN, "GET")
    viewer = await make_user((await make_org()).id)
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": viewer.id, "r": roles["organization-viewer"]},
    )
    await db_session.commit()

    assert await _authorized(db_session, viewer.id) is True
    assert await _authorized(db_session, uuid4()) is False
