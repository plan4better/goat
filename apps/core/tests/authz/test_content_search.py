"""`GET /content/search`: projects, datasets and the workflows and print
layouts of projects, across everything the caller can open (the assistant's
"find my project / dataset / workflow").

Each test acts as fresh users of a fresh organisation, so other tests' rows in
the shared test schema never show up, and searches for a token unique to the
test on top of that.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import find_resource
from tests.authz.test_project_layer_search import _bearer, _grant, _token

S = settings.SCHEMA
URL = f"{settings.API_V2_STR}/content/search"


async def _search(
    client: AsyncClient, user: User, search: str, **params: Any
) -> dict[str, Any]:
    response = await client.get(
        URL, params={"search": search, **params}, headers=_bearer(user.id)
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def _found(page: dict[str, Any]) -> list[tuple[str, str]]:
    return sorted((hit["type"], hit["id"]) for hit in page["items"])


async def _rename(db: AsyncSession, table: str, row_id: UUID, name: str) -> None:
    await db.execute(
        text(f"UPDATE {S}.{table} SET name = :n WHERE id = :i"),
        {"n": name, "i": row_id},
    )


async def _workflow(db: AsyncSession, project: Project, name: str) -> UUID:
    workflow_id = uuid4()
    await db.execute(
        text(
            f"INSERT INTO {S}.workflow (id, project_id, name, config, is_default, "
            "updated_at) VALUES (:i, :p, :n, '{}'::jsonb, FALSE, now())"
        ),
        {"i": workflow_id, "p": project.id, "n": name},
    )
    return workflow_id


async def _layout(db: AsyncSession, project: Project, name: str) -> UUID:
    layout_id = uuid4()
    await db.execute(
        text(
            f"INSERT INTO {S}.report_layout (id, project_id, name, config, is_default, "
            "is_predefined, updated_at) "
            "VALUES (:i, :p, :n, '{}'::jsonb, FALSE, FALSE, now())"
        ),
        {"i": layout_id, "p": project.id, "n": name},
    )
    return layout_id


async def _subfolder(db: AsyncSession, parent: Folder, name: str) -> Folder:
    folder = Folder(
        id=uuid4(),
        user_id=parent.user_id,
        space_id=parent.space_id,
        parent_id=parent.id,
        name=name,
    )
    db.add(folder)
    await db.flush()
    return folder


@pytest.mark.asyncio
async def test_finds_own_projects_with_owner_space_and_folder(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me, f"Planung {token}")
    project = await make_project(me, folder)
    await _rename(db_session, "project", project.id, f"Radverkehr {token}")
    await db_session.commit()

    page = await _search(client, me, f"RADVERKEHR {token}")
    assert page["total"] == 1 and page["page"] == 1 and page["size"] == 20
    [hit] = page["items"]
    assert hit["updated_at"]
    assert {k: v for k, v in hit.items() if k != "updated_at"} == {
        "type": "project",
        "id": str(project.id),
        "name": f"Radverkehr {token}",
        "my_role": "owner",
        "created_by": {"id": str(me.id), "name": "Authz Test"},
        "space_kind": "personal",
        "space_name": "Authz Test",
        "folder_path": [f"Planung {token}"],
        "matched_on": ["name"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("grantee", ["user", "team", "organization", "folder"])
async def test_finds_projects_shared_with_the_caller_in_any_way(
    grantee: str,
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """The gap of the shared-with-me feed: grants to a team or the
    organisation, and projects inside a shared folder."""
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    await _rename(db_session, "project", project.id, f"Schulung {token}")
    await db_session.commit()
    # In the owner's personal space: nobody else finds it without a grant.
    assert (await _search(client, me, token))["items"] == []

    if grantee == "folder":
        resource = {"resource_type": "folder", "resource_id": folder.id}
        role = roles["folder-viewer"]
    else:
        resource = {"resource_type": "project", "resource_id": project.id}
        role = roles["project-viewer"]
    if grantee == "team":
        team = await make_team(me, org=org)
        target = {"grantee_type": "team", "grantee_id": team.id}
    elif grantee in ("organization", "folder"):
        target = {"grantee_type": "organization", "grantee_id": org.id}
    else:
        target = {"grantee_type": "user", "grantee_id": me.id}
    await _grant(db_session, **resource, **target, role_id=role, granted_by=owner.id)
    await db_session.commit()

    [hit] = (await _search(client, me, token))["items"]
    assert (hit["type"], hit["id"], hit["my_role"]) == (
        "project",
        str(project.id),
        "viewer",
    )


@pytest.mark.asyncio
async def test_finds_what_lives_in_a_team_space(
    client: AsyncClient,
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_project: Callable[..., Awaitable[Project]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    colleague = await make_user(org.id)
    team = await make_team(me, colleague, org=org)
    space = await make_space(SpaceKind.team, team=team)
    team_folder = Folder(
        id=uuid4(), user_id=colleague.id, space_id=space.id, name="Projekte"
    )
    db_session.add(team_folder)
    await db_session.flush()
    project = await make_project(colleague, await make_folder(colleague))
    await db_session.execute(
        text(
            f"UPDATE {S}.project SET space_id = :s, folder_id = :f, name = :n WHERE id = :p"
        ),
        {
            "s": space.id,
            "f": team_folder.id,
            "n": f"Teamprojekt {token}",
            "p": project.id,
        },
    )
    await db_session.commit()

    [hit] = (await _search(client, me, token))["items"]
    assert hit["id"] == str(project.id)
    assert (hit["space_kind"], hit["space_name"]) == ("team", team.name)
    assert hit["folder_path"] == ["Projekte"]


@pytest.mark.asyncio
async def test_a_folder_name_finds_what_sits_below_it(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """A training folder shared with the organisation: searching its name
    finds the projects and workflows in it and in its subfolders, while the
    owner's private folder above it is neither matched nor named."""
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    private = await make_folder(owner, f"Privat {token}")
    training = await _subfolder(db_session, private, f"Schulung {token}")
    day_one = await _subfolder(db_session, training, "Tag 1")
    project = await make_project(owner, day_one)
    workflow = await _workflow(db_session, project, "Huff-Modell")
    await _grant(
        db_session,
        resource_type="folder",
        resource_id=training.id,
        grantee_type="organization",
        grantee_id=org.id,
        role_id=roles["folder-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    page = await _search(client, me, f"schulung {token}")
    assert _found(page) == sorted(
        [("project", str(project.id)), ("workflow", str(workflow))]
    )
    for hit in page["items"]:
        assert hit["matched_on"] == ["folder"]
        assert hit["folder_path"] == [f"Schulung {token}", "Tag 1"]
    assert (await _search(client, me, f"privat {token}"))["items"] == []
    # The owner opens the private folder too, so it matches for them.
    owners_page = await _search(client, owner, f"privat {token}")
    assert ("project", str(project.id)) in _found(owners_page)


@pytest.mark.asyncio
async def test_the_owners_name_finds_their_shared_items(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    await db_session.execute(
        text(f'UPDATE {S}."user" SET firstname = :f, lastname = :l WHERE id = :u'),
        {"f": f"Anna{token}", "l": "Schmidt", "u": owner.id},
    )
    shared = await make_project(owner, await make_folder(owner))
    await make_project(owner, await make_folder(owner))  # not shared
    await _grant(
        db_session,
        resource_type="project",
        resource_id=shared.id,
        grantee_type="organization",
        grantee_id=org.id,
        role_id=roles["project-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    [hit] = (await _search(client, me, f"anna{token} schmidt"))["items"]
    assert hit["id"] == str(shared.id)
    assert hit["matched_on"] == ["owner"]
    assert hit["created_by"]["name"] == f"Anna{token} Schmidt"


@pytest.mark.asyncio
async def test_finds_workflows_and_layouts_by_their_name_or_their_projects(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    project = await make_project(me, await make_folder(me))
    await _rename(db_session, "project", project.id, f"Nahversorgung {token}")
    workflow = await _workflow(db_session, project, f"Huff {token}")
    layout = await _layout(db_session, project, "A3 Karte")
    await db_session.commit()

    [hit] = (await _search(client, me, f"huff {token}"))["items"]
    assert (hit["type"], hit["id"], hit["matched_on"]) == (
        "workflow",
        str(workflow),
        ["name"],
    )
    assert (hit["project_id"], hit["project_name"]) == (
        str(project.id),
        f"Nahversorgung {token}",
    )
    page = await _search(client, me, f"nahversorgung {token}")
    assert _found(page) == sorted(
        [
            ("project", str(project.id)),
            ("workflow", str(workflow)),
            ("layout", str(layout)),
        ]
    )
    # The project's own name match comes first.
    assert page["items"][0]["type"] == "project"
    assert {h["type"]: h["matched_on"] for h in page["items"]}["layout"] == ["project"]
    only = await _search(client, me, f"nahversorgung {token}", types="workflow,layout")
    assert {hit["type"] for hit in only["items"]} == {"workflow", "layout"}


@pytest.mark.asyncio
async def test_finds_datasets_and_a_bundles_members_only_as_the_bundle(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    token = _token()
    org = await make_org()
    me = await make_user(org.id)
    owner = await make_user(org.id)
    folder = await make_folder(me)
    own = await make_layer(me, folder)
    member = await make_layer(me, folder)
    await _rename(db_session, "layer", own.id, f"Radwege {token}")
    await _rename(db_session, "layer", member.id, f"Haltestellen {token}")
    bundle_id = uuid4()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle (id, name, user_id, space_id, folder_id, "
            "bundle_type, updated_at) VALUES (:i, :n, :u, :s, :f, 'gtfs', now())"
        ),
        {
            "i": bundle_id,
            "n": f"Fahrplan {token}",
            "u": me.id,
            "s": folder.space_id,
            "f": folder.id,
        },
    )
    await db_session.execute(
        text(f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id) VALUES (:b, :l)"),
        {"b": bundle_id, "l": member.id},
    )
    strangers = await make_layer(owner, await make_folder(owner))
    granted = await make_layer(owner, await make_folder(owner))
    await _rename(db_session, "layer", strangers.id, f"Privat {token}")
    await _rename(db_session, "layer", granted.id, f"Geteilt {token}")
    await _grant(
        db_session,
        resource_type="layer",
        resource_id=granted.id,
        grantee_type="user",
        grantee_id=me.id,
        role_id=roles["layer-viewer"],
        granted_by=owner.id,
    )
    await db_session.commit()

    page = await _search(client, me, token)
    assert _found(page) == sorted(
        [
            ("layer", str(own.id)),
            ("layer", str(granted.id)),
            ("bundle", str(bundle_id)),
        ]
    )
    by_type = {hit["type"]: hit for hit in page["items"]}
    assert by_type["bundle"]["bundle_type"] == "gtfs"
    assert (by_type["layer"]["layer_type"], by_type["layer"]["geometry_type"]) == (
        "feature",
        "polygon",
    )
    assert (await _search(client, me, f"haltestellen {token}"))["items"] == []


@pytest.mark.asyncio
async def test_leaves_out_trashed_projects_and_template_sources(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    trashed = await make_project(me, folder)
    source = await make_project(me, folder)
    for project in (trashed, source):
        await _rename(db_session, "project", project.id, f"Alt {token}")
        await _workflow(db_session, project, f"Alt {token}")
    await db_session.execute(
        text(f"UPDATE {S}.project SET deleted_at = now() WHERE id = :p"),
        {"p": trashed.id},
    )
    await db_session.execute(
        text(f"UPDATE {S}.project SET is_template_source = TRUE WHERE id = :p"),
        {"p": source.id},
    )
    await db_session.commit()

    assert (await _search(client, me, token))["items"] == []


@pytest.mark.asyncio
async def test_pages_carry_the_total(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    token = _token()
    me = await make_user((await make_org()).id)
    folder = await make_folder(me)
    for _ in range(3):
        project = await make_project(me, folder)
        await _rename(db_session, "project", project.id, f"Seite {token}")
    await db_session.commit()

    first = await _search(client, me, token, size=2)
    assert (first["total"], len(first["items"])) == (3, 2)
    second = await _search(client, me, token, size=2, page=2)
    assert (second["total"], len(second["items"])) == (3, 1)
    past = await _search(client, me, token, size=2, page=5)
    assert (past["total"], past["items"]) == (3, [])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [{"search": " a "}, {"search": "ab", "types": "project,dashboard"}],
)
async def test_rejects_a_short_search_or_an_unknown_type(
    params: dict[str, str],
    client: AsyncClient,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
) -> None:
    me = await make_user((await make_org()).id)
    response = await client.get(URL, params=params, headers=_bearer(me.id))
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_the_url_gate_knows_the_route(db_session: AsyncSession) -> None:
    """`seed_roles` registers the path, so `auth_z` finds it under AUTH."""
    await find_resource(db_session, "content/search", "GET")
