"""The trigger log_storage_usage keeps `organization.used_storage` (MB) equal
to its layers' sizes: a layer whose creator was removed is found through its
space when its size changes or it is deleted."""

import uuid

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.team import Team
from core.db.models.user import User
from core.db.sql.init_triggers import init_triggers
from sqlalchemy import delete, text, update
from tests.utils import make_organization

_S = settings.SCHEMA
MB = 1_048_576


async def _used(db_session, org: Organization) -> float:
    return (
        await db_session.execute(
            text(f"SELECT used_storage FROM {_S}.organization WHERE id = :i"),
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


@pytest.mark.asyncio
async def test_a_layer_of_a_removed_creator_counts_off_through_its_space(
    db_session,
):
    """The organization's own space, a team's space and a member's personal
    space each name the organization once the creator is gone: a new size
    and the deletion move the organization's storage."""
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
    # Its space is the folder's (content_space_default).
    layers = [
        Layer(
            id=uuid.uuid4(),
            user_id=leaver.id,
            folder_id=folder,
            name="L",
            type="table",
            size=MB,
        )
        for folder in folders
    ]
    db_session.add_all(layers)
    await db_session.commit()
    assert await _used(db_session, org) == pytest.approx(3)

    # As remove_user leaves the space-owned content behind.
    await db_session.execute(
        update(Layer).where(Layer.user_id == leaver.id).values(user_id=None)
    )
    await db_session.execute(delete(User).where(User.id == leaver.id))
    await db_session.commit()
    assert await _used(db_session, org) == pytest.approx(3)

    await db_session.execute(
        update(Layer).where(Layer.id == layers[0].id).values(size=4 * MB)
    )
    await db_session.commit()
    assert await _used(db_session, org) == pytest.approx(6)

    for left, layer in zip((2, 1, 0), layers, strict=True):
        await db_session.execute(delete(Layer).where(Layer.id == layer.id))
        await db_session.commit()
        assert await _used(db_session, org) == pytest.approx(left)
