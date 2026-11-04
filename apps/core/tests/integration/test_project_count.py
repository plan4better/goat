"""The trigger log_project_count keeps `organization.used_projects` equal to
the organization's projects: a project template's hidden copy never counts,
and a project whose creator was removed is found through its space when it
is deleted."""

import uuid
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.team import Team
from core.db.models.user import User
from core.db.sql.init_triggers import init_triggers
from sqlalchemy import delete, text, update
from tests.utils import make_organization

_S = settings.SCHEMA


async def _used(db_session, org: Organization) -> int:
    return (
        await db_session.execute(
            text(f"SELECT used_projects FROM {_S}.organization WHERE id = :i"),
            {"i": org.id},
        )
    ).scalar_one()


async def _member(db_session, org: Organization) -> User:
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex}@t.local",
        firstname="T",
        lastname="U",
        organization_id=org.id,
    )
    db_session.add(user)
    await db_session.commit()
    return user


async def _add(db_session, user: User, folder_id: UUID, **fields) -> Project:
    """A project in the folder; its space is the folder's (content_space_default)."""
    project = Project(
        id=uuid.uuid4(), user_id=user.id, folder_id=folder_id, name="P", **fields
    )
    db_session.add(project)
    await db_session.commit()
    return project


async def _remove(db_session, project: Project) -> None:
    await db_session.execute(delete(Project).where(Project.id == project.id))
    await db_session.commit()


@pytest.mark.asyncio
async def test_a_template_copy_never_counts(db_session):
    await init_triggers()
    org = make_organization()
    db_session.add(org)
    await db_session.commit()
    user = await _member(db_session, org)
    home = await crud_space.ensure_root_folder(
        db_session, (await crud_space.ensure_organization(db_session, org.id)).id
    )
    await db_session.commit()

    plan = await _add(db_session, user, home)
    assert await _used(db_session, org) == 1
    copy = await _add(db_session, user, home, is_template_source=True)
    assert await _used(db_session, org) == 1
    await _remove(db_session, copy)
    assert await _used(db_session, org) == 1
    await _remove(db_session, plan)
    assert await _used(db_session, org) == 0


@pytest.mark.asyncio
async def test_a_project_of_a_removed_creator_counts_off_through_its_space(
    db_session,
):
    """The organization's own space, a team's space and a member's personal
    space each name the organization once the creator is gone."""
    await init_triggers()
    org = make_organization()
    db_session.add(org)
    await db_session.commit()
    leaver, stayer = await _member(db_session, org), await _member(db_session, org)
    team = Team(id=uuid.uuid4(), name="Team", avatar="", organization_id=org.id)
    db_session.add(team)
    await db_session.commit()
    folders = [
        await crud_space.ensure_root_folder(db_session, space.id)
        for space in (
            await crud_space.ensure_organization(db_session, org.id),
            await crud_space.ensure_team(db_session, team.id),
            await crud_space.ensure_personal(db_session, stayer.id),
        )
    ]
    await db_session.commit()
    projects = [await _add(db_session, leaver, folder) for folder in folders]
    assert await _used(db_session, org) == 3

    # As remove_user leaves the space-owned content behind.
    await db_session.execute(
        update(Project).where(Project.user_id == leaver.id).values(user_id=None)
    )
    await db_session.execute(delete(User).where(User.id == leaver.id))
    await db_session.commit()

    for left, project in zip((2, 1, 0), projects, strict=True):
        await _remove(db_session, project)
        assert await _used(db_session, org) == left
