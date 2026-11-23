"""Through HTTP, a write that carries `properties` answers 422 with the sentence
as `detail` (the text a client shows) and changes nothing."""

from uuid import UUID

import pytest
import pytest_asyncio
from core.core.config import settings
from core.db.models.user import User
from core.schemas.properties_refused import PROPERTIES_REFUSED
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld, build_style_world

API = settings.API_V2_STR
S = settings.SCHEMA


@pytest_asyncio.fixture
async def world(db_session: AsyncSession, fixture_create_user: UUID) -> StyleWorld:
    """A project with one layer, owned by the identity the API acts as without auth."""
    user = await db_session.get(User, UUID(str(settings.DEFAULT_USER_ID)))
    assert user is not None
    return await build_style_world(db_session, user)


async def link_row(db: AsyncSession, lp: int):
    return (
        await db.execute(
            text(
                f'SELECT name, visible, "order", updated_at, properties '
                f"FROM {S}.layer_project WHERE id = :lp"
            ),
            {"lp": lp},
        )
    ).one()


@pytest.mark.asyncio
async def test_a_project_layer_update_with_properties_answers_422_and_stores_nothing(
    client: AsyncClient, db_session: AsyncSession, world: StyleWorld
) -> None:
    before = await link_row(db_session, world.layer_project_id)
    response = await client.put(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}",
        json={"name": "Renamed", "properties": {"color": [1, 2, 3]}},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == PROPERTIES_REFUSED
    db_session.expire_all()
    assert await link_row(db_session, world.layer_project_id) == before


@pytest.mark.asyncio
async def test_a_project_layer_update_with_another_unknown_key_is_still_accepted(
    client: AsyncClient, db_session: AsyncSession, world: StyleWorld
) -> None:
    response = await client.put(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}",
        json={"name": "Renamed", "colour": "red"},
    )
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert (await link_row(db_session, world.layer_project_id)).name == "Renamed"


@pytest.mark.asyncio
async def test_a_tree_put_with_properties_answers_422_and_stores_nothing(
    client: AsyncClient, db_session: AsyncSession, world: StyleWorld
) -> None:
    before = await link_row(db_session, world.layer_project_id)
    response = await client.put(
        f"{API}/project/{world.project_id}/layer-tree",
        json={
            "items": [
                {
                    "id": world.layer_project_id,
                    "type": "layer",
                    "order": 5,
                    "properties": {"visibility": False},
                }
            ]
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == PROPERTIES_REFUSED
    db_session.expire_all()
    assert await link_row(db_session, world.layer_project_id) == before


@pytest.mark.asyncio
async def test_a_dataset_update_with_properties_answers_422_and_stores_nothing(
    client: AsyncClient, db_session: AsyncSession, world: StyleWorld
) -> None:
    response = await client.put(
        f"{API}/layer/{world.layer_id}",
        json={"name": "Renamed", "properties": {"color": [1, 2, 3]}},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == PROPERTIES_REFUSED
    db_session.expire_all()
    name = (
        await db_session.execute(
            text(f"SELECT name FROM {S}.layer WHERE id = :l"), {"l": world.layer_id}
        )
    ).scalar_one()
    assert name == "districts"


@pytest.mark.asyncio
async def test_a_group_create_with_properties_answers_422_and_creates_nothing(
    client: AsyncClient, db_session: AsyncSession, world: StyleWorld
) -> None:
    response = await client.post(
        f"{API}/project/{world.project_id}/group",
        json={"name": "G", "properties": {"visibility": False}},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == PROPERTIES_REFUSED
    count = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_project_group WHERE project_id = :p"),
            {"p": world.project_id},
        )
    ).scalar_one()
    assert count == 0
