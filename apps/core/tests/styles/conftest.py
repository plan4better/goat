"""A project with one polygon layer on it, for the style storage tests; a scratch
schema with the DuckLake catalog tables the data snapshot tracker reads."""

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest_asyncio
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import _personal_space


@dataclass
class StyleWorld:
    user_id: UUID
    project_id: UUID
    layer_id: UUID
    layer_project_id: int


async def build_style_world(db: AsyncSession, user: User) -> StyleWorld:
    """A folder, a polygon layer and a project of `user`, the layer on the project."""
    space_id = await _personal_space(db, user)
    folder = Folder(id=uuid4(), user_id=user.id, space_id=space_id, name="f")
    db.add(folder)
    await db.flush()
    layer = Layer(
        id=uuid4(),
        user_id=user.id,
        folder_id=folder.id,
        space_id=space_id,
        name="districts",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="polygon",
    )
    project = Project(
        id=uuid4(), user_id=user.id, folder_id=folder.id, space_id=space_id, name="p"
    )
    db.add_all([layer, project])
    await db.flush()
    link = LayerProjectLink(
        project_id=project.id, layer_id=layer.id, name="districts", properties={}
    )
    db.add(link)
    await db.flush()
    await db.commit()
    assert user.id is not None and link.id is not None
    return StyleWorld(
        user_id=user.id,
        project_id=project.id,
        layer_id=layer.id,
        layer_project_id=link.id,
    )


@pytest_asyncio.fixture
async def style_world(db_session: AsyncSession) -> StyleWorld:
    uid = uuid4()
    user = User(
        id=uid,
        email=f"style-{uid.hex[:8]}@goat.test",
        firstname="Style",
        lastname="Test",
        avatar="",
    )
    db_session.add(user)
    await db_session.flush()
    return await build_style_world(db_session, user)


@pytest_asyncio.fixture
async def api_style_world(
    db_session: AsyncSession, fixture_create_user: UUID
) -> StyleWorld:
    """The same world owned by the identity the API acts as without auth."""
    user = await db_session.get(User, UUID(str(settings.DEFAULT_USER_ID)))
    assert user is not None
    return await build_style_world(db_session, user)


LAKE = f"ducklake_test_{os.getpid()}"


@pytest_asyncio.fixture
async def lake(db_session: AsyncSession) -> AsyncIterator[str]:
    """DuckLake's change log tables in a scratch schema, and no tracker cursor yet."""
    await db_session.execute(text(f"DROP SCHEMA IF EXISTS {LAKE} CASCADE"))
    await db_session.execute(text(f"CREATE SCHEMA {LAKE}"))
    await db_session.execute(
        text(f"CREATE TABLE {LAKE}.ducklake_snapshot (snapshot_id bigint PRIMARY KEY)")
    )
    await db_session.execute(
        text(
            f"CREATE TABLE {LAKE}.ducklake_snapshot_changes "
            "(snapshot_id bigint PRIMARY KEY, changes_made text)"
        )
    )
    await db_session.execute(
        text(f"CREATE TABLE {LAKE}.ducklake_table (table_id bigint, table_name text)")
    )
    await db_session.execute(
        text(f"DELETE FROM {settings.SCHEMA}.data_snapshot_cursor")
    )
    await db_session.commit()
    yield LAKE
    await db_session.execute(text(f"DROP SCHEMA IF EXISTS {LAKE} CASCADE"))
    await db_session.commit()
