"""`content_space_default`: a BEFORE INSERT trigger that backfills
space_id from the folder on layer/project/bundle rows whose caller (a
Windmill tool, a raw migration, ...) inserted without one. It is the
belt to goatlib's braces (`ToolDatabaseService.create_layer`/
`create_bundle` now derive space_id themselves) — this test drives the
trigger directly with raw SQL, bypassing goatlib entirely."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.space import Space, SpaceKind
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


@pytest.mark.asyncio
async def test_layer_insert_without_space_id_gets_folders_space(
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    assert folder.space_id is not None

    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer "
                "(id, user_id, folder_id, name, type, feature_layer_type, "
                " feature_layer_geometry_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, 'l', 'feature', 'standard', "
                " 'polygon', now()) RETURNING id"
            ),
            {"u": owner.id, "f": folder.id},
        )
    ).scalar_one()

    space_id = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.layer WHERE id = :id"), {"id": layer_id}
        )
    ).scalar_one()
    assert space_id == folder.space_id


@pytest.mark.asyncio
async def test_project_insert_without_space_id_gets_folders_space(
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)

    project_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.project (id, user_id, folder_id, name, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, 'p', now()) RETURNING id"
            ),
            {"u": owner.id, "f": folder.id},
        )
    ).scalar_one()

    space_id = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.project WHERE id = :id"),
            {"id": project_id},
        )
    ).scalar_one()
    assert space_id == folder.space_id


@pytest.mark.asyncio
async def test_bundle_insert_without_space_id_gets_folders_space(
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)

    bundle_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle "
                "(id, user_id, folder_id, name, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, 'b', 'street_network', now()) "
                "RETURNING id"
            ),
            {"u": owner.id, "f": folder.id},
        )
    ).scalar_one()

    space_id = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.bundle WHERE id = :id"),
            {"id": bundle_id},
        )
    ).scalar_one()
    assert space_id == folder.space_id


@pytest.mark.asyncio
async def test_explicit_space_id_is_not_overwritten(
    db_session: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_org: Callable[..., Awaitable[object]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """The trigger only fills in space_id when the caller left it NULL."""
    owner = await make_user()
    folder = await make_folder(owner)
    org = await make_org()
    other_space = await make_space(SpaceKind.organization, org=org)

    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer "
                "(id, user_id, folder_id, space_id, name, type, feature_layer_type, "
                " feature_layer_geometry_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, :s, 'l', 'feature', 'standard', "
                " 'polygon', now()) RETURNING id"
            ),
            {"u": owner.id, "f": folder.id, "s": other_space.id},
        )
    ).scalar_one()

    space_id = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.layer WHERE id = :id"), {"id": layer_id}
        )
    ).scalar_one()
    assert space_id == other_space.id
    assert space_id != folder.space_id
