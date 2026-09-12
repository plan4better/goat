"""The single rule: space owner/admin > space default for members > direct
grant (user/team/org) > ancestor-folder grant > bundle grant > project→layer
read > catalog read; max role wins."""

from collections.abc import Awaitable, Callable
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.team import Team
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def role(db: AsyncSession, rtype: str, rid: UUID, uid: UUID | None) -> str | None:
    return (
        await db.execute(
            text(f"SELECT {S}.effective_role(:t, :r, :u)"),
            {"t": rtype, "r": rid, "u": uid},
        )
    ).scalar()


async def can(
    db: AsyncSession, rtype: str, rid: UUID, uid: UUID | None, action: str
) -> bool:
    return bool(
        (
            await db.execute(
                text(f"SELECT {S}.can(:t, :r, :u, :a)"),
                {"t": rtype, "r": rid, "u": uid, "a": action},
            )
        ).scalar()
    )


async def grant(
    db: AsyncSession,
    roles: dict[str, UUID],
    *,
    rtype: str,
    rid: UUID,
    gtype: str,
    gid: UUID,
    role_name: str,
    by: UUID,
) -> None:
    await db.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES (:t,:r,:gt,:g,:role,:by)"
        ),
        {
            "t": rtype,
            "r": rid,
            "gt": gtype,
            "g": gid,
            "role": roles[role_name],
            "by": by,
        },
    )


@pytest.mark.asyncio
async def test_owner_editor_viewer_none(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    org = await make_org()
    owner, editor, viewer, stranger = [await make_user(org.id) for _ in range(4)]
    layer = await make_layer(owner, await make_folder(owner))
    await grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        gtype="user",
        gid=editor.id,
        role_name="layer-editor",
        by=owner.id,
    )
    team = await make_team(viewer)
    await grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        gtype="team",
        gid=team.id,
        role_name="layer-viewer",
        by=owner.id,
    )

    assert await role(db_session, "layer", layer.id, owner.id) == "owner"
    assert await role(db_session, "layer", layer.id, editor.id) == "editor"
    assert await role(db_session, "layer", layer.id, viewer.id) == "viewer"
    assert await role(db_session, "layer", layer.id, stranger.id) is None
    assert await can(db_session, "layer", layer.id, viewer.id, "read")
    assert not await can(db_session, "layer", layer.id, viewer.id, "write")
    assert await can(db_session, "layer", layer.id, editor.id, "write")
    assert not await can(db_session, "layer", layer.id, editor.id, "delete")
    assert await can(db_session, "layer", layer.id, owner.id, "delete")


@pytest.mark.asyncio
async def test_max_role_wins_across_paths(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    org = await make_org()
    owner, user = await make_user(org.id), await make_user(org.id)
    team = await make_team(user)
    folder = await make_folder(owner)
    layer = await make_layer(owner, folder)
    await grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        gtype="team",
        gid=team.id,
        role_name="layer-viewer",
        by=owner.id,
    )
    await grant(
        db_session,
        roles,
        rtype="folder",
        rid=folder.id,
        gtype="organization",
        gid=org.id,
        role_name="folder-editor",
        by=owner.id,
    )
    assert await role(db_session, "layer", layer.id, user.id) == "editor"


@pytest.mark.asyncio
async def test_project_grant_gives_read_only_on_its_layers(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    org = await make_org()
    owner, member = await make_user(org.id), await make_user(org.id)
    folder = await make_folder(owner)
    layer = await make_layer(owner, folder)
    project = await make_project(owner, folder)
    await db_session.execute(
        text(
            f'INSERT INTO {S}.layer_project (layer_id, project_id, name, "order", updated_at) '
            "VALUES (:l, :p, 'l', 0, now())"
        ),
        {"l": layer.id, "p": project.id},
    )
    await grant(
        db_session,
        roles,
        rtype="project",
        rid=project.id,
        gtype="user",
        gid=member.id,
        role_name="project-editor",
        by=owner.id,
    )
    assert await role(db_session, "project", project.id, member.id) == "editor"
    assert (
        await role(db_session, "layer", layer.id, member.id) == "viewer"
    ), "D7/D17: a project grant lets you SEE its datasets, not edit them"


@pytest.mark.asyncio
async def test_catalog_layer_is_readable_by_anyone_never_writable(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    someone = await make_user()
    lid = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, feature_layer_geometry_type, user_id, catalog_external_uid, updated_at) "
                "VALUES (gen_random_uuid(), 'cat', 'feature', 'standard', 'point', NULL, 'stac:abc', now()) RETURNING id"
            )
        )
    ).scalar_one()
    assert await role(db_session, "layer", lid, someone.id) == "viewer"
    assert await role(db_session, "layer", lid, None) == "viewer"
    assert not await can(db_session, "layer", lid, someone.id, "write")


@pytest.mark.asyncio
async def test_bundle_grant_reaches_member_layers(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    org = await make_org()
    owner, member = await make_user(org.id), await make_user(org.id)
    team = await make_team(member)
    folder = await make_folder(owner)
    layer = await make_layer(owner, folder)
    bid = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now()) RETURNING id"
            ),
            {"u": owner.id, "f": folder.id, "s": folder.space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) VALUES (:b, :l, 'edges')"
        ),
        {"b": bid, "l": layer.id},
    )
    await grant(
        db_session,
        roles,
        rtype="bundle",
        rid=bid,
        gtype="team",
        gid=team.id,
        role_name="bundle-editor",
        by=owner.id,
    )
    assert await role(db_session, "layer", layer.id, member.id) == "editor"


@pytest.mark.asyncio
async def test_catalog_layer_grant_cannot_raise_above_viewer(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    someone = await make_user()
    lid = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, feature_layer_geometry_type, user_id, catalog_external_uid, updated_at) "
                "VALUES (gen_random_uuid(), 'cat', 'feature', 'standard', 'point', NULL, 'stac:def', now()) RETURNING id"
            )
        )
    ).scalar_one()
    await grant(
        db_session,
        roles,
        rtype="layer",
        rid=lid,
        gtype="user",
        gid=someone.id,
        role_name="layer-editor",
        by=someone.id,
    )
    assert await role(db_session, "layer", lid, someone.id) == "viewer"
    assert not await can(db_session, "layer", lid, someone.id, "write")


@pytest.mark.asyncio
async def test_owner_role_grant_row_yields_editor_not_owner(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    """I3: a grant row can never mint ownership, even one that names the
    `layer-owner` role directly — only the layer's own owner_id column can.
    direct_grant_rank caps every grant at rank 2 (editor)."""
    org = await make_org()
    owner, grantee = await make_user(org.id), await make_user(org.id)
    layer = await make_layer(owner, await make_folder(owner))
    await grant(
        db_session,
        roles,
        rtype="layer",
        rid=layer.id,
        gtype="user",
        gid=grantee.id,
        role_name="layer-owner",
        by=owner.id,
    )
    assert await role(db_session, "layer", layer.id, grantee.id) == "editor"
    assert await can(db_session, "layer", layer.id, grantee.id, "write")
    assert not await can(db_session, "layer", layer.id, grantee.id, "delete")


@pytest.mark.asyncio
async def test_bundle_owner_is_the_space_owner_of_member_layers(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    """A bundle's member layers live in the bundle's own space — a layer
    created elsewhere and moved into the bundle keeps that invariant, so
    `bundle_owner`, as the owner of the personal space the bundle and its
    member layer both now sit in, is that layer's space owner too: 'owner',
    not merely bundle-editor access. Bundle membership itself grants nothing
    on its own any more (see `test_bundle_grant_reaches_member_layers` for
    the grant path, which still caps at editor)."""
    org = await make_org()
    bundle_owner, layer_owner = await make_user(org.id), await make_user(org.id)
    layer_folder = await make_folder(layer_owner)
    layer = await make_layer(layer_owner, layer_folder)
    bundle_folder = await make_folder(bundle_owner)
    bid = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now()) RETURNING id"
            ),
            {"u": bundle_owner.id, "f": bundle_folder.id, "s": bundle_folder.space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) VALUES (:b, :l, 'edges')"
        ),
        {"b": bid, "l": layer.id},
    )
    await db_session.execute(
        text(f"UPDATE {S}.layer SET space_id = :s WHERE id = :l"),
        {"s": bundle_folder.space_id, "l": layer.id},
    )
    assert await role(db_session, "layer", layer.id, bundle_owner.id) == "owner"
    assert await can(db_session, "layer", layer.id, bundle_owner.id, "write")
    assert await can(db_session, "layer", layer.id, bundle_owner.id, "delete")


@pytest.mark.asyncio
async def test_unknown_resource_type_raises_and_unknown_action_is_false(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    owner = await make_user()
    layer = await make_layer(owner, await make_folder(owner))
    with pytest.raises(DBAPIError):
        await role(db_session, "spaceship", layer.id, owner.id)
    await db_session.rollback()

    assert not await can(db_session, "layer", layer.id, owner.id, "fly")
