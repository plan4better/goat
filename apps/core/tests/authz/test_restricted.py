"""Restricted folders/items (spec D9).

A restricted folder or item does not hand a space member the space default
role — the one place where a later rule *reduces* access (spec §3.2). The
space owner/admin keeps rank 3, and every additive path (direct grant,
ancestor-folder grant, bundle, project → layer read) still applies, so a
restricted item stays reachable for anyone explicitly given access to it.
"""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models._link_model import UserTeamLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.space import Space, SpaceDefaultRole, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import find_resource
from tests.authz.test_content_feed import _unverified_bearer

S = settings.SCHEMA


async def _role(
    db: AsyncSession, rtype: str, rid: UUID, uid: UUID | None
) -> str | None:
    return (
        await db.execute(
            text(f"SELECT {S}.effective_role(:t, :r, :u)"),
            {"t": rtype, "r": rid, "u": uid},
        )
    ).scalar()


async def _move_to_space(
    db: AsyncSession, table: str, rid: UUID, space_id: UUID
) -> None:
    await db.execute(
        text(f"UPDATE {S}.{table} SET space_id = :s WHERE id = :r"),
        {"s": space_id, "r": rid},
    )


async def _write_allowed(db: AsyncSession, lid: UUID, uid: UUID) -> bool:
    return bool(
        (
            await db.execute(
                text(f"SELECT {S}.layer_write_allowed(:l, :u)"), {"l": lid, "u": uid}
            )
        ).scalar()
    )


async def _authorized(db: AsyncSession, uid: UUID, pattern: str, path: str) -> bool:
    """`customer.authorization` — the URL gate `auth_z` runs. It raises rather
    than returning FALSE when it refuses, so a raise counts as refusal (the
    engine is AUTOCOMMIT, so a plain rollback clears the session bookkeeping)."""
    try:
        return bool(
            (
                await db.execute(
                    text(f"SELECT {S}.authorization(:u, :res, :path, :method)"),
                    {"u": uid, "res": pattern, "path": path, "method": "PATCH"},
                )
            ).scalar()
        )
    except DBAPIError:
        await db.rollback()
        return False


async def _restrict(db: AsyncSession, table: str, rid: UUID, value: bool) -> None:
    await db.execute(
        text(f"UPDATE {S}.{table} SET restricted = :v WHERE id = :r"),
        {"v": value, "r": rid},
    )


async def _team_space(
    db: AsyncSession,
    roles: dict[str, UUID],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    *,
    org: Organization,
    lead: User,
    member: User,
) -> Space:
    """A team space with the D8 editor default: `lead` is its admin
    (team-owner → space_rank 3), `member` a plain member."""
    team = await make_team(lead, member, org=org)
    await db.execute(
        text(
            f"UPDATE {S}.user_team SET role_id = :r WHERE team_id = :t AND user_id = :u"
        ),
        {"r": roles["team-owner"], "t": team.id, "u": lead.id},
    )
    space: Space = await make_space(
        SpaceKind.team, team=team, default_role=SpaceDefaultRole.editor
    )
    return space


@pytest.mark.asyncio
async def test_restricted_folder_removes_space_default_but_not_admin_or_grants(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    org = await make_org()
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    folder = await make_folder(lead, "Drafts")
    layer = await make_layer(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    await _move_to_space(db_session, "layer", layer.id, space.id)

    assert await _role(db_session, "layer", layer.id, member.id) == "editor"

    await _restrict(db_session, "folder", folder.id, True)

    assert await _role(db_session, "folder", folder.id, member.id) is None
    assert (
        await _role(db_session, "layer", layer.id, member.id) is None
    ), "inherited through the folder"
    assert (
        await _role(db_session, "layer", layer.id, lead.id) == "owner"
    ), "rank 3 unaffected"

    # a direct grant re-opens the item for the grantee only
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :b)"
        ),
        {"l": layer.id, "u": member.id, "r": roles["layer-viewer"], "b": lead.id},
    )
    assert await _role(db_session, "layer", layer.id, member.id) == "viewer"
    assert (
        await _role(db_session, "folder", folder.id, member.id) is None
    ), "the folder itself stays closed"


@pytest.mark.asyncio
async def test_restricted_folder_hides_its_whole_subtree(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    """A restricted ancestor closes the folders and items below it too —
    `restricted_applies` walks the whole `folder_chain`, not just the parent."""
    org = await make_org()
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    top = await make_folder(lead, "top")
    mid = await make_folder(lead, "mid")
    await db_session.execute(
        text(f"UPDATE {S}.folder SET parent_id = :p WHERE id = :c"),
        {"p": top.id, "c": mid.id},
    )
    deep = await make_layer(lead, mid)
    for table, rid in (("folder", top.id), ("folder", mid.id), ("layer", deep.id)):
        await _move_to_space(db_session, table, rid, space.id)

    assert await _role(db_session, "layer", deep.id, member.id) == "editor"

    await _restrict(db_session, "folder", top.id, True)

    assert await _role(db_session, "folder", mid.id, member.id) is None
    assert await _role(db_session, "layer", deep.id, member.id) is None
    assert await _role(db_session, "layer", deep.id, lead.id) == "owner"


@pytest.mark.asyncio
async def test_restricted_item_only_affects_itself(
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
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    folder = await make_folder(lead, "Plans")
    locked = await make_project(lead, folder)
    sibling = await make_project(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    await _move_to_space(db_session, "project", locked.id, space.id)
    await _move_to_space(db_session, "project", sibling.id, space.id)

    await _restrict(db_session, "project", locked.id, True)

    assert await _role(db_session, "project", locked.id, member.id) is None
    assert (
        await _role(db_session, "project", sibling.id, member.id) == "editor"
    ), "a sibling in the same folder is untouched"
    assert (
        await _role(db_session, "folder", folder.id, member.id) == "editor"
    ), "the containing folder is untouched"
    assert await _role(db_session, "project", locked.id, lead.id) == "owner"


@pytest.mark.asyncio
async def test_restricted_layer_still_readable_through_a_shared_project(
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
    """Restricting a layer takes away the space default on the layer, but the
    project → layer read path (rule 6) still reaches it: a member who can open
    a project that uses the layer still sees the layer, read-only."""
    org = await make_org()
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    folder = await make_folder(lead, "Maps")
    layer = await make_layer(lead, folder)
    project = await make_project(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    await _move_to_space(db_session, "layer", layer.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await db_session.execute(
        text(
            f'INSERT INTO {S}.layer_project (layer_id, project_id, name, "order", updated_at) '
            "VALUES (:l, :p, 'l', 0, now())"
        ),
        {"l": layer.id, "p": project.id},
    )

    await _restrict(db_session, "layer", layer.id, True)

    assert await _role(db_session, "project", project.id, member.id) == "editor"
    assert (
        await _role(db_session, "layer", layer.id, member.id) == "viewer"
    ), "D7/D17: seen through the project, never edited there"


@pytest.mark.asyncio
async def test_patch_restricted_is_owner_only_and_feed_reports_it(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, Any],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    f = await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Locked"})
    assert f.status_code == 201, f.text
    fid = f.json()["id"]
    child = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "Inside", "parent_id": fid}
    )
    assert child.status_code == 201, child.text
    child_id = child.json()["id"]

    r = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{fid}/restricted",
        json={"restricted": True},
    )
    assert r.status_code == 204, r.text

    space_id = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.folder WHERE id = :f"), {"f": fid}
        )
    ).scalar_one()

    page = (
        await client.get(
            f"{settings.API_V2_STR}/content",
            params={"view": "space", "space_id": str(space_id)},
        )
    ).json()
    row = next(i for i in page["items"] if i["id"] == fid)
    assert row["restricted"] is True and row["restricted_inherited"] is False

    inside = (
        await client.get(
            f"{settings.API_V2_STR}/content",
            params={"view": "space", "space_id": str(space_id), "folder_id": fid},
        )
    ).json()
    child_row = next(i for i in inside["items"] if i["id"] == child_id)
    assert child_row["restricted"] is False
    assert child_row["restricted_inherited"] is True, "closed through its parent"

    read = await client.get(f"{settings.API_V2_STR}/folder/{fid}")
    assert read.status_code == 200, read.text
    assert read.json()["restricted"] is True

    # a real second user (no grant, not a member of this personal space) is refused
    stranger = await make_user()
    refused = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{fid}/restricted",
        json={"restricted": False},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )
    assert refused.status_code == 403, refused.text

    off = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{fid}/restricted",
        json={"restricted": False},
    )
    assert off.status_code == 204, off.text
    assert (
        await db_session.execute(
            text(f"SELECT restricted FROM {S}.folder WHERE id = :f"), {"f": fid}
        )
    ).scalar_one() is False


@pytest.mark.asyncio
async def test_patch_restricted_404s_on_unknown_and_trashed(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    missing = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{UUID(int=99)}/restricted",
        json={"restricted": True},
    )
    assert missing.status_code == 404, missing.text

    f = await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Bin"})
    fid = f.json()["id"]
    await db_session.execute(
        text(f"UPDATE {S}.folder SET deleted_at = now() WHERE id = :f"), {"f": fid}
    )
    trashed = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{fid}/restricted",
        json={"restricted": True},
    )
    assert trashed.status_code == 404, trashed.text


@pytest.mark.asyncio
async def test_patch_restricted_refuses_a_space_root(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    """A space's `home` root is folded into the space listing and has no feed
    row of its own, so there would be no badge to toggle back off."""
    root = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{fixture_get_home_folder['id']}/restricted",
        json={"restricted": True},
    )
    assert root.status_code == 400, root.text


@pytest.mark.asyncio
async def test_restricted_bundle_closes_its_member_layers(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    """Rule 5 propagates a bundle's grants to its member layers, so Restricted
    propagates the same way: restricting the bundle closes its members."""
    org = await make_org()
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    folder = await make_folder(lead, "Networks")
    layer = await make_layer(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    await _move_to_space(db_session, "layer", layer.id, space.id)
    bundle_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now()) RETURNING id"
            ),
            {"u": lead.id, "f": folder.id, "s": space.id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) "
            "VALUES (:b, :l, 'edges')"
        ),
        {"b": bundle_id, "l": layer.id},
    )

    assert await _role(db_session, "layer", layer.id, member.id) == "editor"

    await _restrict(db_session, "bundle", bundle_id, True)

    assert await _role(db_session, "bundle", bundle_id, member.id) is None
    assert (
        await _role(db_session, "layer", layer.id, member.id) is None
    ), "the member layer is closed with the bundle"
    assert await _role(db_session, "layer", layer.id, lead.id) == "owner"

    # a grant on the bundle re-opens its members for the grantee (rule 5)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('bundle', :b, 'user', :u, :r, :o)"
        ),
        {"b": bundle_id, "u": member.id, "r": roles["bundle-viewer"], "o": lead.id},
    )
    assert await _role(db_session, "layer", layer.id, member.id) == "viewer"


@pytest.mark.asyncio
async def test_restricted_layer_is_not_writable_through_a_shared_project(
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
    """Restricted narrows write too: `layer_write_allowed`'s shared-workspace
    branch does not reach a restricted layer, so a member who may edit a
    project the layer sits in can still see it but no longer write it. The
    space admin and an explicit layer grant still do."""
    org = await make_org()
    lead, member = await make_user(org.id), await make_user(org.id)
    space = await _team_space(
        db_session, roles, make_team, make_space, org=org, lead=lead, member=member
    )
    folder = await make_folder(lead, "Shared")
    layer = await make_layer(lead, folder)
    project = await make_project(lead, folder)
    await _move_to_space(db_session, "folder", folder.id, space.id)
    await _move_to_space(db_session, "layer", layer.id, space.id)
    await _move_to_space(db_session, "project", project.id, space.id)
    await db_session.execute(
        text(
            f'INSERT INTO {S}.layer_project (layer_id, project_id, name, "order", updated_at) '
            "VALUES (:l, :p, 'l', 0, now())"
        ),
        {"l": layer.id, "p": project.id},
    )

    assert await _write_allowed(db_session, layer.id, member.id) is True

    await _restrict(db_session, "layer", layer.id, True)

    assert await _role(db_session, "layer", layer.id, member.id) == "viewer"
    assert (
        await _write_allowed(db_session, layer.id, member.id) is False
    ), "the shared-workspace rule does not reach a restricted layer"
    assert (
        await _write_allowed(db_session, layer.id, lead.id) is True
    ), "the space admin still writes"

    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :o)"
        ),
        {"l": layer.id, "u": member.id, "r": roles["layer-editor"], "o": lead.id},
    )
    assert (
        await _write_allowed(db_session, layer.id, member.id) is True
    ), "an explicit layer-editor grant still writes"


@pytest.mark.asyncio
async def test_authorization_gate_admits_the_patch_path(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
) -> None:
    """`seed_roles` registers the PATCH path as a `customer.resource` row, so
    `auth_z` finds it. The row carries no permissions: the URL gate admits any
    provisioned user and refuses an unknown one, while who may restrict *this*
    folder is decided by `CRUDContent.set_restricted`."""
    pattern = "content/{resource_type}/{resource_id}/restricted"
    await find_resource(db_session, pattern, "PATCH")

    org = await make_org()
    caller = await make_user(org.id)
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": caller.id, "r": roles["organization-owner"]},
    )
    path = f"content/folder/{uuid4()}/restricted"

    assert await _authorized(db_session, caller.id, pattern, path) is True
    assert (
        await _authorized(db_session, uuid4(), pattern, path) is False
    ), "an unprovisioned caller is refused"


@pytest.mark.asyncio
async def test_restricted_folder_is_not_listed_by_get_folder(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, Any],
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    """`GET /folder` feeds the breadcrumbs, the folder tree and the Move
    dialog, so it must not list a folder a member has no access to: the name
    alone says a closed folder exists, and offering it as a move destination
    would make the member's own item disappear into it."""
    team = await client.post(f"{settings.API_V2_STR}/teams", json={"name": "Mobility"})
    assert team.status_code == 200, team.text
    team_id = UUID(team.json()["id"])
    space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE team_id = :t"), {"t": team_id}
        )
    ).scalar_one()

    caller = await db_session.get(User, fixture_create_user)
    assert caller is not None
    member = await make_user(caller.organization_id)
    db_session.add(
        UserTeamLink(user_id=member.id, team_id=team_id, role_id=roles["team-member"])
    )
    await db_session.commit()

    closed = await client.post(
        f"{settings.API_V2_STR}/folder",
        json={"name": "Drafts (confidential)", "space_id": str(space_id)},
    )
    assert closed.status_code == 201, closed.text
    closed_id = closed.json()["id"]
    inside = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "Inside", "parent_id": closed_id}
    )
    assert inside.status_code == 201, inside.text
    opened = await client.post(
        f"{settings.API_V2_STR}/folder",
        json={"name": "Open", "space_id": str(space_id)},
    )
    assert opened.status_code == 201, opened.text

    patched = await client.patch(
        f"{settings.API_V2_STR}/content/folder/{closed_id}/restricted",
        json={"restricted": True},
    )
    assert patched.status_code == 204, patched.text

    async def _by_name(user_id: UUID | None) -> dict[str, dict[str, Any]]:
        headers = (
            {"Authorization": f"Bearer {_unverified_bearer(user_id)}"}
            if user_id
            else {}
        )
        r = await client.get(f"{settings.API_V2_STR}/folder", headers=headers)
        assert r.status_code == 200, r.text
        return {
            row["name"]: row for row in r.json() if row["space_id"] == str(space_id)
        }

    seen_by_member = await _by_name(member.id)
    assert {"home", "Open"} <= set(seen_by_member)
    assert "Drafts (confidential)" not in seen_by_member
    assert "Inside" not in seen_by_member, "nor anything below it"
    assert (
        seen_by_member["Open"]["role"] == "folder-editor"
    ), "an unrestricted folder still carries the space's editor default"

    seen_by_admin = await _by_name(None)
    assert {"Drafts (confidential)", "Inside"} <= set(seen_by_admin)
    assert seen_by_admin["Drafts (confidential)"]["role"] == "folder-owner"

    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, "
            "grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('folder', :f, 'user', :u, :r, :b)"
        ),
        {
            "f": closed_id,
            "u": member.id,
            "r": roles["folder-viewer"],
            "b": fixture_create_user,
        },
    )
    await db_session.commit()

    granted = await _by_name(member.id)
    assert {
        "Drafts (confidential)",
        "Inside",
    } <= set(granted), "a grant re-opens it for that member"
    # The role must be what the grant gives, not the space's editor default:
    # `getWritableFolders` keeps the `folder-editor` rows as create/upload
    # destinations, and `POST /project` into this one would 403.
    for name in ("Drafts (confidential)", "Inside"):
        assert granted[name]["role"] == "folder-viewer", granted[name]
        assert granted[name]["shared_from_name"] == "Mobility"
