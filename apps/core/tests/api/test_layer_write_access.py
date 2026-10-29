"""GET /layer/{id}/write-access tells the caller whether they may edit a layer.

The workflow's "Save as dataset" set to an existing dataset warns before the
run when the user may not edit the target (the step then fails). The answer
uses the same rule the run uses (``customer.layer_write_allowed``), so the
warning and the run never disagree.
"""

from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models import Layer, Role, User
from core.db.models._link_model import ResourceGrant
from core.db.models.folder import Folder
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def _role(db: AsyncSession, name: str) -> UUID:
    row = (
        await db.execute(text(f"SELECT id FROM {S}.role WHERE name = :n"), {"n": name})
    ).first()
    if row:
        return UUID(str(row[0]))
    role = Role(name=name, resource_type="layer")
    db.add(role)
    await db.flush()
    return role.id


async def _layer_of(db: AsyncSession, owner: UUID) -> UUID:
    space_id = (await crud_space.ensure_personal(db, owner)).id
    folder = Folder(
        id=uuid4(), user_id=owner, space_id=space_id, name=f"f-{uuid4().hex[:6]}"
    )
    db.add(folder)
    await db.flush()
    layer = Layer(
        id=uuid4(),
        user_id=owner,
        folder_id=folder.id,
        space_id=space_id,
        name="Monitoring",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="point",
    )
    db.add(layer)
    await db.flush()
    return layer.id


async def _someone_elses_layer(db: AsyncSession) -> UUID:
    other = User(
        id=uuid4(),
        email=f"other-{uuid4().hex[:6]}@goat.test",
        firstname="O",
        lastname="W",
        avatar="",
    )
    db.add(other)
    await db.flush()
    return await _layer_of(db, other.id)


async def _grant(db: AsyncSession, layer_id: UUID, user_id: UUID, role: str) -> None:
    db.add(
        ResourceGrant(
            resource_type="layer",
            resource_id=layer_id,
            grantee_type="user",
            grantee_id=user_id,
            role_id=await _role(db, role),
            granted_by=None,
        )
    )
    await db.commit()


async def _can_write(client: AsyncClient, layer_id: UUID) -> bool:
    response = await client.get(f"{settings.API_V2_STR}/layer/{layer_id}/write-access")
    assert response.status_code == 200, response.text
    return bool(response.json()["can_write"])


@pytest.mark.asyncio
async def test_own_layer_is_writable(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    layer_id = await _layer_of(db_session, fixture_create_user)
    await db_session.commit()
    assert await _can_write(client, layer_id) is True


@pytest.mark.asyncio
async def test_viewer_may_not_write(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    layer_id = await _someone_elses_layer(db_session)
    await _grant(db_session, layer_id, fixture_create_user, "layer-viewer")
    assert await _can_write(client, layer_id) is False


@pytest.mark.asyncio
async def test_editor_may_write(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    layer_id = await _someone_elses_layer(db_session)
    await _grant(db_session, layer_id, fixture_create_user, "layer-editor")
    assert await _can_write(client, layer_id) is True


@pytest.mark.asyncio
async def test_unknown_layer_is_not_writable(
    client: AsyncClient, fixture_create_user: UUID
) -> None:
    assert await _can_write(client, uuid4()) is False
