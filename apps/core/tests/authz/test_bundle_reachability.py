"""`_bundle_reachable_via_project`: whether a bundle's member layer sits in a
project the caller can reach through any `effective_role` path — direct
grant, team/organization grant, or being the owner/admin of the project's
space (see test 4, where that space is reached because the project lives in
a folder owned by that space)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.user import User
from core.endpoints.v2.bundle import _bundle_reachable_via_project
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def _make_bundle_with_member_layer(
    db_session: AsyncSession,
    owner: User,
    folder: Folder,
    layer: Layer,
) -> UUID:
    """A bundle owned by `owner`, with `layer` as its one member."""
    bundle_id = (
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
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) "
            "VALUES (:b, :l, 'edges')"
        ),
        {"b": bundle_id, "l": layer.id},
    )
    return UUID(str(bundle_id))


async def _link_layer_to_project(
    db_session: AsyncSession, layer: Layer, project: Project
) -> None:
    """The bundle's member layer sits inside `project` (`layer_project`) —
    this is the join `_bundle_reachable_via_project` walks to find the
    project(s) a bundle's members live in."""
    db_session.add(
        LayerProjectLink(layer_id=layer.id, project_id=project.id, name=layer.name)
    )
    await db_session.flush()


async def _grant_project(
    db_session: AsyncSession,
    *,
    project_id: UUID,
    grantee_id: UUID,
    role_id: UUID,
    granted_by: UUID,
) -> None:
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('project', :p, 'user', :g, :r, :o)"
        ),
        {
            "p": project_id,
            "g": grantee_id,
            "r": role_id,
            "o": granted_by,
        },
    )


@pytest.mark.asyncio
async def test_project_editor_grant_makes_bundle_reachable(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[[User, Folder], Awaitable[Layer]],
    make_project: Callable[[User, Folder], Awaitable[Project]],
) -> None:
    """A user with a direct `project-editor` resource_grant on the project
    that holds a bundle's member layer can reach the bundle."""
    project_owner = await make_user()
    editor = await make_user()
    project_folder = await make_folder(project_owner)
    project = await make_project(project_owner, project_folder)
    bundle_folder = await make_folder(project_owner)
    layer = await make_layer(project_owner, bundle_folder)
    bundle_id = await _make_bundle_with_member_layer(
        db_session, project_owner, bundle_folder, layer
    )
    await _link_layer_to_project(db_session, layer, project)
    await _grant_project(
        db_session,
        project_id=project.id,
        grantee_id=editor.id,
        role_id=roles["project-editor"],
        granted_by=project_owner.id,
    )
    await db_session.commit()

    assert await _bundle_reachable_via_project(db_session, bundle_id, editor.id) is True


@pytest.mark.asyncio
async def test_project_viewer_grant_makes_bundle_reachable(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[[User, Folder], Awaitable[Layer]],
    make_project: Callable[[User, Folder], Awaitable[Project]],
) -> None:
    """A `project-viewer` grant is also enough — `_bundle_reachable_via_project`
    grants READ-only bundle visibility (per its docstring: "they get
    read-only visibility of the bundle"), and `effective_role` returning any
    non-null role (viewer or above) satisfies its `IS NOT NULL` check. Any
    write beyond that stays behind `authorize_bundle`, which this function
    does not gate — confirmed by reading the function: it has no role-rank
    comparison, only a null check."""
    project_owner = await make_user()
    viewer = await make_user()
    project_folder = await make_folder(project_owner)
    project = await make_project(project_owner, project_folder)
    bundle_folder = await make_folder(project_owner)
    layer = await make_layer(project_owner, bundle_folder)
    bundle_id = await _make_bundle_with_member_layer(
        db_session, project_owner, bundle_folder, layer
    )
    await _link_layer_to_project(db_session, layer, project)
    await _grant_project(
        db_session,
        project_id=project.id,
        grantee_id=viewer.id,
        role_id=roles["project-viewer"],
        granted_by=project_owner.id,
    )
    await db_session.commit()

    assert await _bundle_reachable_via_project(db_session, bundle_id, viewer.id) is True


@pytest.mark.asyncio
async def test_stranger_without_any_grant_cannot_reach_bundle(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[[User, Folder], Awaitable[Layer]],
    make_project: Callable[[User, Folder], Awaitable[Project]],
) -> None:
    """A user with no ownership, grant, team, org, or folder path to the
    project cannot reach the bundle through it."""
    project_owner = await make_user()
    stranger = await make_user()
    project_folder = await make_folder(project_owner)
    project = await make_project(project_owner, project_folder)
    bundle_folder = await make_folder(project_owner)
    layer = await make_layer(project_owner, bundle_folder)
    bundle_id = await _make_bundle_with_member_layer(
        db_session, project_owner, bundle_folder, layer
    )
    await _link_layer_to_project(db_session, layer, project)
    await db_session.commit()

    assert (
        await _bundle_reachable_via_project(db_session, bundle_id, stranger.id) is False
    )


@pytest.mark.asyncio
async def test_folder_owner_can_reach_bundle_via_project_folder(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[[User, Folder], Awaitable[Layer]],
    make_project: Callable[[User, Folder], Awaitable[Project]],
) -> None:
    """A project living inside someone else's folder shares that folder's
    space (the real invariant a project-in-folder create path enforces); a
    fixture-built `project` does not follow the folder automatically, so
    this test moves it there itself. `folder_owner`, as the owner of the
    personal space that now holds the project, is that project's space
    owner — `effective_role('project', ...)` returns 'owner' for them, not
    merely a folder grant, so the bundle is reachable through it. Ownership
    of the folder alone (with the project left in a different space) grants
    nothing any more — the space is what answers this, not folder
    ownership."""
    folder_owner = await make_user()
    project_owner = await make_user()
    project_folder = await make_folder(folder_owner)
    project = await make_project(project_owner, project_folder)
    await db_session.execute(
        text(f"UPDATE {S}.project SET space_id = :s WHERE id = :p"),
        {"s": project_folder.space_id, "p": project.id},
    )
    bundle_folder = await make_folder(project_owner)
    layer = await make_layer(project_owner, bundle_folder)
    bundle_id = await _make_bundle_with_member_layer(
        db_session, project_owner, bundle_folder, layer
    )
    await _link_layer_to_project(db_session, layer, project)
    await db_session.commit()

    assert (
        await _bundle_reachable_via_project(db_session, bundle_id, folder_owner.id)
        is True
    )
