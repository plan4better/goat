"""Shareable project-layer links (spec D7) and the space fields on a project read.

D7's second guardrail: you can only extend access to what you may already
share. A layer added to a project by someone who lacks `share` on that layer
creates a link marked `shareable = FALSE`, and rule 6 of `effective_role`
(project -> layer read) skips such links — so the add does not hand the
project's other members read access to a dataset the adder could not have
shared himself. The layer still shows up in the project's layer list for them,
but `locked`, with its style/filter payload withheld.
"""

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_project import DEFAULT_INITIAL_VIEW_STATE
from core.crud.crud_project import project as crud_project
from core.crud.crud_project_copy import copy_project
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.space import Space, SpaceDefaultRole, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


def _bearer(user_id: UUID) -> dict[str, str]:
    """Authorization header making the test client act as `user_id`.

    `get_user_id` reads `sub` with `jwt.get_unverified_claims`, so an unsigned
    JWT-shaped token is enough under `AUTH=False`.
    """

    def _segment(payload: dict[str, str]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    token = (
        f"{_segment({'alg': 'none', 'typ': 'JWT'})}."
        f"{_segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


async def _role(
    db: AsyncSession, rtype: str, rid: UUID, uid: UUID | None
) -> str | None:
    return (
        await db.execute(
            text(f"SELECT {S}.effective_role(:t, :r, :u)"),
            {"t": rtype, "r": rid, "u": uid},
        )
    ).scalar()


async def _can(db: AsyncSession, rtype: str, rid: UUID, uid: UUID, action: str) -> bool:
    return bool(
        (
            await db.execute(
                text(f"SELECT {S}.can(:t, :r, :u, :a)"),
                {"t": rtype, "r": rid, "u": uid, "a": action},
            )
        ).scalar()
    )


async def _write_allowed(db: AsyncSession, layer_id: UUID, user_id: UUID) -> bool:
    return bool(
        (
            await db.execute(
                text(f"SELECT {S}.layer_write_allowed(:l, :u)"),
                {"l": layer_id, "u": user_id},
            )
        ).scalar()
    )


async def _move_to_space(
    db: AsyncSession, table: str, rid: UUID, space_id: UUID
) -> None:
    await db.execute(
        text(f"UPDATE {S}.{table} SET space_id = :s WHERE id = :r"),
        {"s": space_id, "r": rid},
    )


async def _shareable(db: AsyncSession, project_id: UUID, layer_id: UUID) -> bool:
    return bool(
        (
            await db.execute(
                text(
                    f"SELECT shareable FROM {S}.layer_project "
                    "WHERE project_id = :p AND layer_id = :l"
                ),
                {"p": project_id, "l": layer_id},
            )
        ).scalar_one()
    )


async def _team_space(
    db: AsyncSession,
    roles: dict[str, UUID],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    *,
    org: Organization,
    lead: User,
    members: list[User],
) -> tuple[Space, Team]:
    """A team space with the D8 editor default: `lead` is its admin
    (team-owner -> space_rank 3), everyone in `members` a plain member."""
    team = await make_team(lead, *members, org=org)
    await db.execute(
        text(
            f"UPDATE {S}.user_team SET role_id = :r WHERE team_id = :t AND user_id = :u"
        ),
        {"r": roles["team-owner"], "t": team.id, "u": lead.id},
    )
    space: Space = await make_space(
        SpaceKind.team, team=team, default_role=SpaceDefaultRole.editor
    )
    return space, team


async def _styled_layer(
    db: AsyncSession,
    make_layer: Callable[..., Awaitable[Layer]],
    owner: User,
    folder: Folder,
) -> Layer:
    """A layer whose `properties` is a real (empty) style object.

    The project-layer read models require `properties` to be a dict; the
    fixture leaves it NULL, which the link would copy.
    """
    layer = await make_layer(owner, folder)
    await db.execute(
        text(f"UPDATE {S}.layer SET properties = '{{}}'::jsonb WHERE id = :l"),
        {"l": layer.id},
    )
    return layer


async def _grant(
    db: AsyncSession,
    roles: dict[str, UUID],
    *,
    rtype: str,
    rid: UUID,
    grantee: UUID,
    role_name: str,
    by: UUID,
) -> None:
    await db.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES (:t, :r, 'user', :g, :role, :by)"
        ),
        {"t": rtype, "r": rid, "g": grantee, "role": roles[role_name], "by": by},
    )


#: Real values written onto the link and the layer before the locked read, so
#: that a blank assertion can only pass because the row was actually stripped.
LINK_STYLE = {"paint": {"fill-color": "#f00"}}
LINK_OTHER = {"table_config": 1}
LINK_QUERY = {"cql": {"op": "=", "args": [{"property": "category"}, "secret"]}}
LINK_CHARTS = {"x": 1}
LAYER_DESCRIPTION = "Confidential source, do not disclose"
LAYER_THUMBNAIL = "layer-thumbnails/secret-preview.png"
LAYER_SIZE = 123456
LAYER_TAGS = ["classified"]


async def _fill_with_secrets(
    db: AsyncSession, project_id: UUID, layer_id: UUID
) -> None:
    """Give the link a style/filter/chart payload and the layer some metadata.

    Without this the blanking assertions would pass on an already-empty row.
    """
    await db.execute(
        text(
            f"UPDATE {S}.layer_project SET properties = CAST(:props AS jsonb), "
            "other_properties = CAST(:other AS jsonb), "
            "query = CAST(:query AS jsonb), charts = CAST(:charts AS jsonb) "
            "WHERE project_id = :p AND layer_id = :l"
        ),
        {
            "props": json.dumps(LINK_STYLE),
            "other": json.dumps(LINK_OTHER),
            "query": json.dumps(LINK_QUERY),
            "charts": json.dumps(LINK_CHARTS),
            "p": project_id,
            "l": layer_id,
        },
    )
    await db.execute(
        text(
            f"UPDATE {S}.layer SET description = :d, thumbnail_url = :t, "
            "size = :s, tags = CAST(:tags AS text[]), "
            "extent = ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326) "
            "WHERE id = :l"
        ),
        {
            "d": LAYER_DESCRIPTION,
            "t": LAYER_THUMBNAIL,
            "s": LAYER_SIZE,
            "tags": LAYER_TAGS,
            "l": layer_id,
        },
    )


async def _project_layers(
    client: AsyncClient, project_id: UUID, caller: UUID
) -> list[dict[str, Any]]:
    r = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/layer",
        headers=_bearer(caller),
    )
    assert r.status_code == 200, r.text
    return [dict(row) for row in r.json()]


async def _one_project_layer(
    client: AsyncClient, project_id: UUID, layer_project_id: int, caller: UUID
) -> dict[str, Any]:
    r = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/layer/{layer_project_id}",
        headers=_bearer(caller),
    )
    assert r.status_code == 200, r.text
    return dict(r.json())


def _row_for(rows: list[dict[str, Any]], layer_id: UUID) -> dict[str, Any]:
    matches = [row for row in rows if row["layer_id"] == str(layer_id)]
    assert len(matches) == 1, f"{layer_id} not listed exactly once in {rows}"
    return matches[0]


@pytest.mark.asyncio
async def test_non_shareable_link_does_not_leak_read(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)  # owns the layer, in her own personal space
    b = await make_user(org.id)  # may only VIEW it, and adds it to the project
    c = await make_user(org.id)  # another member of the team space
    space, _ = await _team_space(
        db_session,
        roles,
        make_team,
        make_space,
        org=org,
        lead=lead,
        members=[a, b, c],
    )

    layer = await _styled_layer(db_session, make_layer, a, await make_folder(a, "Mine"))

    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)

    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        grantee=b.id,
        role_name="layer-viewer",
        by=a.id,
    )
    await db_session.commit()

    assert await _can(db_session, "layer", layer.id, b.id, "read") is True
    assert await _can(db_session, "layer", layer.id, b.id, "share") is False
    assert await _role(db_session, "project", project.id, b.id) == "editor"

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(layer.id)]},
        headers=_bearer(b.id),
    )
    assert added.status_code == 200, added.text

    assert await _shareable(db_session, project.id, layer.id) is False
    assert (
        await _role(db_session, "layer", layer.id, c.id) is None
    ), "rule 6 must skip a non-shareable link"

    await _fill_with_secrets(db_session, project.id, layer.id)
    await db_session.commit()

    # The owner sees all of it — this is what the locked row below must not.
    own = _row_for(await _project_layers(client, project.id, a.id), layer.id)
    assert own["locked"] is False, "the layer's own owner still sees it"
    assert "properties" not in own, "styles come from the map request"
    assert own["other_properties"] == LINK_OTHER
    assert own["query"] == LINK_QUERY
    assert own["charts"] == LINK_CHARTS
    assert own["description"] == LAYER_DESCRIPTION
    assert own["size"] == LAYER_SIZE
    assert own["tags"] == LAYER_TAGS
    assert own["extent"]
    assert LAYER_THUMBNAIL in own["thumbnail_url"]

    locked = _row_for(await _project_layers(client, project.id, c.id), layer.id)
    assert locked["locked"] is True
    assert locked["name"] == own["name"], "the tree still shows that it is there"
    assert "properties" not in locked
    assert locked["layer_id"] == str(layer.id)
    # Its style is withheld where styles are served: the map request names none.
    locked_map = await client.get(
        f"{settings.API_V2_STR}/project/{project.id}/map", headers=_bearer(c.id)
    )
    assert locked_map.status_code == 200, locked_map.text
    assert str(locked["id"]) not in locked_map.json()["styles"]
    # Whitelist: nothing outside LOCKED_ROW_KEYS may carry a real value.
    for field in (
        "query",
        "charts",
        "other_properties",
        "description",
        "size",
        "tags",
        "extent",
        "url",
        "data_type",
        "user_id",
        "folder_id",
        "attribute_mapping",
        "updated_at",
        "created_at",
        "dataset_updated_at",
    ):
        assert locked.get(field) is None, field
    assert LAYER_THUMBNAIL not in (
        locked.get("thumbnail_url") or ""
    ), "the presigned thumbnail of the real layer must not travel"

    # The project's space admin is not the layer's: the layer lives in A's
    # personal space, so admin rank on the team space buys nothing here.
    admin = _row_for(await _project_layers(client, project.id, lead.id), layer.id)
    assert admin["locked"] is True
    assert admin.get("description") is None

    assert (
        await _write_allowed(db_session, layer.id, c.id) is False
    ), "a non-shareable link is not a write path either"


@pytest.mark.asyncio
async def test_shareable_link_grants_read(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """The adder owns the layer, so the link stays shareable and rule 6 fires."""
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)
    c = await make_user(org.id)
    space, _ = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[a, c]
    )

    layer = await _styled_layer(db_session, make_layer, a, await make_folder(a, "Mine"))

    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await db_session.commit()

    assert await _can(db_session, "layer", layer.id, a.id, "share") is True

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(layer.id)]},
        headers=_bearer(a.id),
    )
    assert added.status_code == 200, added.text

    assert await _shareable(db_session, project.id, layer.id) is True
    assert await _role(db_session, "layer", layer.id, c.id) == "viewer"

    row = _row_for(await _project_layers(client, project.id, c.id), layer.id)
    assert row["locked"] is False
    assert (
        await _write_allowed(db_session, layer.id, c.id) is True
    ), "the shared-workspace write rule still runs through a shareable link"


@pytest.mark.asyncio
async def test_catalog_layer_link_is_always_shareable(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """A catalog layer is readable by everyone anyway, so nobody needs `share`
    on it for the link to travel with the project."""
    org = await make_org()
    lead = await make_user(org.id)
    b = await make_user(org.id)
    c = await make_user(org.id)
    space, _ = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[b, c]
    )

    catalog_layer = await _styled_layer(
        db_session, make_layer, lead, await make_folder(lead, "Catalog source")
    )
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET catalog_external_uid = 'stac:' || CAST(:l AS text), "
            "catalog_version = '1' WHERE id = :l"
        ),
        {"l": catalog_layer.id},
    )

    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await db_session.commit()

    assert (
        await _can(db_session, "layer", catalog_layer.id, b.id, "share") is False
    ), "a catalog layer is viewer-only for everyone but its owner"

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(catalog_layer.id)]},
        headers=_bearer(b.id),
    )
    assert added.status_code == 200, added.text

    assert await _shareable(db_session, project.id, catalog_layer.id) is True
    row = _row_for(await _project_layers(client, project.id, c.id), catalog_layer.id)
    assert row["locked"] is False


@pytest.mark.asyncio
async def test_project_read_exposes_space_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    org = await make_org()
    lead = await make_user(org.id)
    space, team = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[]
    )

    team_folder = await make_folder(lead, "Team")
    team_project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", team_project.id, space.id)

    personal_project = await make_project(lead, await make_folder(lead, "Mine"))
    personal_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"), {"u": lead.id}
        )
    ).scalar_one()

    org_space = await make_space(SpaceKind.organization, org=org)
    org_folder = await make_folder(lead, "Org")
    org_project = await make_project(lead, org_folder)
    await _move_to_space(db_session, "folder", org_folder.id, org_space.id)
    await _move_to_space(db_session, "project", org_project.id, org_space.id)
    await db_session.commit()

    r = await client.get(
        f"{settings.API_V2_STR}/project/{team_project.id}", headers=_bearer(lead.id)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["space_id"] == str(space.id)
    assert body["space_kind"] == "team"
    assert body["space_name"] == team.name

    r = await client.get(
        f"{settings.API_V2_STR}/project/{personal_project.id}", headers=_bearer(lead.id)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["space_id"] == str(personal_space_id)
    assert body["space_kind"] == "personal"
    assert body.get("space_name") is None, "a personal space exposes no owner name"

    r = await client.get(
        f"{settings.API_V2_STR}/project/{org_project.id}", headers=_bearer(lead.id)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["space_kind"] == "organization"
    assert body["space_name"] == org.name


@pytest.mark.asyncio
async def test_project_listing_exposes_space_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`GET /project` carries the same three fields (Home needs them), plus the
    personally owned layer count — on every row of a multi-project page, since
    the listing fills both with one page-level query rather than per row."""
    org = await make_org()
    lead = await make_user(org.id)
    space, team = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[]
    )
    folder = await make_folder(lead, "Team")
    project = await make_project(lead, folder)
    second = await make_project(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    for rid in (project.id, second.id):
        await _move_to_space(db_session, "project", rid, space.id)
    # a layer still living in the lead's PERSONAL space, linked into the first
    # project only — what the D13 health line counts
    personal_layer = await _styled_layer(
        db_session, make_layer, lead, await make_folder(lead, "Mine")
    )
    await db_session.commit()
    await crud_layer_project.create(
        db_session,
        project_id=project.id,
        layer_ids=[personal_layer.id],
        user_id=lead.id,
    )
    await db_session.commit()

    r = await client.get(
        f"{settings.API_V2_STR}/project",
        params={"folder_id": str(folder.id)},
        headers=_bearer(lead.id),
    )
    assert r.status_code == 200, r.text
    by_id = {row["id"]: row for row in r.json()["items"]}
    assert {str(project.id), str(second.id)} <= set(by_id), r.text
    for row in (by_id[str(project.id)], by_id[str(second.id)]):
        assert row["space_id"] == str(space.id)
        assert row["space_kind"] == "team"
        assert row["space_name"] == team.name
    assert by_id[str(project.id)]["personally_owned_layer_count"] == 1
    assert by_id[str(second.id)]["personally_owned_layer_count"] == 0


@pytest.mark.asyncio
async def test_single_layer_read_is_locked_the_same_way(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`GET /project/{id}/layer/{layer_project_id}` is no way round the
    withheld payload — and it returns at all, which the always-false
    `assert type(x) is (A | B | C | D)` it used to carry prevented."""
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)
    b = await make_user(org.id)
    c = await make_user(org.id)
    space, _ = await _team_space(
        db_session,
        roles,
        make_team,
        make_space,
        org=org,
        lead=lead,
        members=[a, b, c],
    )

    layer = await _styled_layer(db_session, make_layer, a, await make_folder(a, "Mine"))
    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        grantee=b.id,
        role_name="layer-viewer",
        by=a.id,
    )
    await db_session.commit()

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(layer.id)]},
        headers=_bearer(b.id),
    )
    assert added.status_code == 200, added.text
    link_id = int(added.json()[0]["id"])
    await _fill_with_secrets(db_session, project.id, layer.id)
    await db_session.commit()

    own = await _one_project_layer(client, project.id, link_id, a.id)
    assert own["locked"] is False
    assert "properties" not in own
    assert own["description"] == LAYER_DESCRIPTION

    locked = await _one_project_layer(client, project.id, link_id, c.id)
    assert locked["locked"] is True
    assert locked["id"] == link_id
    assert "properties" not in locked
    for field in ("query", "charts", "other_properties", "description", "size", "tags"):
        assert locked.get(field) is None, field


@pytest.mark.asyncio
async def test_publish_omits_non_shareable_layers(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """Publishing is the widest audience there is, so a non-shareable link
    never reaches the public config — nor its `layer_order` entry."""
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)
    b = await make_user(org.id)
    space, _ = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[a, b]
    )

    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    shared_layer = await _styled_layer(db_session, make_layer, lead, team_folder)
    for table, rid in (
        ("folder", team_folder.id),
        ("project", project.id),
        ("layer", shared_layer.id),
    ):
        await _move_to_space(db_session, table, rid, space.id)

    private_layer = await _styled_layer(
        db_session, make_layer, a, await make_folder(a, "Mine")
    )
    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=private_layer.id,
        grantee=b.id,
        role_name="layer-viewer",
        by=a.id,
    )
    # publish_project reads the owner's view state off user_project.
    await db_session.execute(
        text(
            f"INSERT INTO {S}.user_project (user_id, project_id, initial_view_state, updated_at) "
            "VALUES (:u, :p, CAST(:v AS jsonb), now())"
        ),
        {"u": lead.id, "p": project.id, "v": json.dumps(DEFAULT_INITIAL_VIEW_STATE)},
    )
    await db_session.commit()

    for adder, layer in ((lead, shared_layer), (b, private_layer)):
        r = await client.post(
            f"{settings.API_V2_STR}/project/{project.id}/layer",
            params={"layer_ids": [str(layer.id)]},
            headers=_bearer(adder.id),
        )
        assert r.status_code == 200, r.text

    assert await _shareable(db_session, project.id, shared_layer.id) is True
    assert await _shareable(db_session, project.id, private_layer.id) is False

    published = await crud_project.publish_project(
        async_session=db_session, project_id=project.id
    )
    config = published.config
    listed = {row["layer_id"] for row in config["layers"]}
    assert listed == {str(shared_layer.id)}, config["layers"]

    shared_link_id = (
        await db_session.execute(
            text(
                f"SELECT id FROM {S}.layer_project "
                "WHERE project_id = :p AND layer_id = :l"
            ),
            {"p": project.id, "l": shared_layer.id},
        )
    ).scalar_one()
    assert config["project"]["layer_order"] == [shared_link_id]


@pytest.mark.asyncio
async def test_put_on_a_locked_link_does_not_leak(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`PUT /project/{id}/layer/{lp}` is reachable with project write alone, so
    a member the link is locked for could otherwise get the full layer row back
    from it. It refuses with 403 and leaves the link untouched; the layer's own
    owner still gets the whole row."""
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)
    b = await make_user(org.id)
    c = await make_user(org.id)
    space, _ = await _team_space(
        db_session,
        roles,
        make_team,
        make_space,
        org=org,
        lead=lead,
        members=[a, b, c],
    )

    layer = await _styled_layer(db_session, make_layer, a, await make_folder(a, "Mine"))
    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        grantee=b.id,
        role_name="layer-viewer",
        by=a.id,
    )
    await db_session.commit()

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(layer.id)]},
        headers=_bearer(b.id),
    )
    assert added.status_code == 200, added.text
    link_id = int(added.json()[0]["id"])
    await _fill_with_secrets(db_session, project.id, layer.id)
    await db_session.commit()

    refused = await client.put(
        f"{settings.API_V2_STR}/project/{project.id}/layer/{link_id}",
        json={"name": "renamed by an outsider"},
        headers=_bearer(c.id),
    )
    assert refused.status_code == 403, refused.text
    body = refused.json()
    assert "description" not in body and "thumbnail_url" not in body, body

    assert (
        await db_session.execute(
            text(f"SELECT name FROM {S}.layer_project WHERE id = :i"), {"i": link_id}
        )
    ).scalar_one() == layer.name, "the refused write changed nothing"

    allowed = await client.put(
        f"{settings.API_V2_STR}/project/{project.id}/layer/{link_id}",
        json={"name": "renamed by the owner"},
        headers=_bearer(a.id),
    )
    assert allowed.status_code == 200, allowed.text
    row = dict(allowed.json())
    assert row["locked"] is False
    assert row["name"] == "renamed by the owner"
    assert row["description"] == LAYER_DESCRIPTION
    assert "properties" not in row


@pytest.mark.asyncio
async def test_copy_never_widens_a_link_beyond_the_copier(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`shareable` records that the adder held `share` on the layer, and on a
    copy the adder is the copier — so it is recomputed for him and ANDed with
    the source link's. Copy-then-share is therefore not a way round D7."""
    org = await make_org()
    lead = await make_user(org.id)
    a = await make_user(org.id)
    b = await make_user(org.id)
    space, _ = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, members=[a, b]
    )

    a_folder = await make_folder(a, "Mine")
    owned = await _styled_layer(db_session, make_layer, a, a_folder)
    added_by_b = await _styled_layer(db_session, make_layer, a, a_folder)
    catalog_layer = await _styled_layer(db_session, make_layer, a, a_folder)
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET catalog_external_uid = 'stac:' || CAST(:l AS text), "
            "catalog_version = '1' WHERE id = :l"
        ),
        {"l": catalog_layer.id},
    )

    team_folder = await make_folder(lead, "Team")
    project = await make_project(lead, team_folder)
    await _move_to_space(db_session, "folder", team_folder.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    for layer in (owned, added_by_b):
        await _grant(
            db_session,
            roles,
            rtype="layer",
            rid=layer.id,
            grantee=b.id,
            role_name="layer-viewer",
            by=a.id,
        )
    await db_session.commit()

    await crud_layer_project.create(
        db_session,
        project_id=project.id,
        layer_ids=[owned.id, catalog_layer.id],
        user_id=a.id,
    )
    await crud_layer_project.create(
        db_session,
        project_id=project.id,
        layer_ids=[added_by_b.id],
        user_id=b.id,
    )
    await db_session.commit()

    assert await _shareable(db_session, project.id, owned.id) is True
    assert await _shareable(db_session, project.id, catalog_layer.id) is True
    assert await _shareable(db_session, project.id, added_by_b.id) is False

    by_owner = await copy_project(db_session, project_id=project.id, user_id=a.id)
    assert (
        await _shareable(db_session, by_owner.id, owned.id) is True
    ), "the copier owns it"
    assert await _shareable(db_session, by_owner.id, catalog_layer.id) is True
    assert (
        await _shareable(db_session, by_owner.id, added_by_b.id) is False
    ), "never wider than the source link"

    by_viewer = await copy_project(db_session, project_id=project.id, user_id=b.id)
    assert (
        await _shareable(db_session, by_viewer.id, owned.id) is False
    ), "b may only view it, so his copy cannot hand it on"
    assert await _shareable(db_session, by_viewer.id, catalog_layer.id) is True
    assert await _shareable(db_session, by_viewer.id, added_by_b.id) is False


@pytest.mark.asyncio
async def test_adding_a_street_network_layer_is_serializable(
    client: AsyncClient,
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """`POST /project/{id}/layer` returns rows from the same read path as the
    GETs, so its response union has to carry `IFeatureStreetNetworkProjectRead`
    too: each read model pins `feature_layer_type` as a `Literal`, so a
    street-network row matching none of them is a response-validation 500."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Mine")
    layer = await _styled_layer(db_session, make_layer, owner, folder)
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET feature_layer_type = 'street_network' WHERE id = :l"
        ),
        {"l": layer.id},
    )
    project = await make_project(owner, folder)
    await db_session.commit()

    added = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/layer",
        params={"layer_ids": [str(layer.id)]},
        headers=_bearer(owner.id),
    )
    assert added.status_code == 200, added.text
    row = _row_for(added.json(), layer.id)
    assert row["feature_layer_type"] == "street_network"

    listed = _row_for(await _project_layers(client, project.id, owner.id), layer.id)
    assert listed["feature_layer_type"] == "street_network"
