"""core's add paths write style rows (spec 10): every new project layer starts
with an active "Default", and new rasters get their dataset default."""

from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.layer import Layer
from core.scripts.seed_e2e import seed_e2e
from core.services.style import add_first_styles, insert_dataset_default
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA
GREEN = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}


async def active_of(db: AsyncSession, lp: int) -> Any:
    return (
        await db.execute(
            text(
                f"SELECT s.name, s.document, lp.visible FROM {S}.layer_project lp "
                f"JOIN {S}.layer_style s ON s.id = lp.active_style_id WHERE lp.id = :lp"
            ),
            {"lp": lp},
        )
    ).first()


async def default_of(db: AsyncSession, layer_id: UUID) -> Any:
    return (
        await db.execute(
            text(f"SELECT name, document FROM {S}.layer_style WHERE layer_id = :l"),
            {"l": layer_id},
        )
    ).first()


@pytest.mark.asyncio
async def test_adding_a_dataset_gives_the_new_link_an_active_default(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    await insert_dataset_default(db_session, world.layer_id, GREEN)
    response = await client.post(
        f"{API}/project/{world.project_id}/layer",
        params={"layer_ids": [str(world.layer_id)]},
    )
    assert response.status_code == 200, response.text
    [added] = response.json()
    active = await active_of(db_session, added["id"])
    assert active is not None and active.name == "Default"


@pytest.mark.asyncio
async def test_a_duplicate_add_copies_the_link_already_there(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    await insert_dataset_default(db_session, world.layer_id, GREEN)
    await add_first_styles(db_session, [world.layer_project_id])
    styles = f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/style"
    style_id = (await client.get(f"{API}/project/{world.project_id}/map")).json()[
        "styles"
    ][str(world.layer_project_id)]["active"]["id"]
    red = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#aa0000"}}}
    saved = await client.put(
        f"{styles}/{style_id}", json={"base_rev": 1, "document": red}
    )
    assert saved.status_code == 200, saved.text
    second = (
        await client.post(
            f"{API}/project/{world.project_id}/layer",
            params={"layer_ids": [str(world.layer_id)]},
        )
    ).json()[0]
    active = await active_of(db_session, second["id"])
    assert active.document["symbol"]["fill"]["color"] == "#aa0000"
    assert active.visible is True


@pytest.mark.asyncio
async def test_a_raster_created_through_the_api_gets_a_map_service_default(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    response = await client.post(
        f"{API}/layer/raster",
        json={
            "folder_id": str(fixture_get_home_folder["id"]),
            "name": "Aerial",
            "type": "raster",
            "url": "https://example.com/wms",
            "data_type": "wms",
        },
    )
    assert response.status_code == 201, response.text
    default = await default_of(db_session, UUID(response.json()["id"]))
    assert default is not None
    assert default.document == {
        "version": 1,
        "kind": "raster",
        "opacity": 0.8,
        "render": {"type": "image"},
    }


@pytest.mark.asyncio
async def test_seed_e2e_writes_a_dataset_default(
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    await seed_e2e(db_session, UUID(str(settings.DEFAULT_USER_ID)))
    points = (
        await db_session.execute(
            select(Layer.id).where(
                Layer.name == "E2E Points",
                Layer.user_id == UUID(str(settings.DEFAULT_USER_ID)),
            )
        )
    ).scalar_one()
    default = await default_of(db_session, points)
    assert default is not None and default.document["symbol"]["marker"]
