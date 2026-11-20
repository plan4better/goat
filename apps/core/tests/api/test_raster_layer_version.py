"""A COG layer's version moves with its address. geoapi names a raster layer's
value tiles by the row's `url` and `updated_at` (with the file's ETag for a
remote file), and caches keep those tiles for good: a write that changed the
file a layer reads without moving either would serve the old file's tiles
under the new file's addresses."""

from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from core.core.config import settings
from core.services import geoapi
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

API = settings.API_V2_STR
BOUNDS = (13.53, 51.36, 15.17, 52.37)


async def _version(db: AsyncSession, layer_id: str) -> Any:
    """What geoapi's version of the layer is made of: its address and update time."""
    return (
        await db.execute(
            text(f"SELECT url, updated_at FROM {settings.SCHEMA}.layer WHERE id = :id"),
            {"id": UUID(layer_id)},
        )
    ).one()


async def _cog(client: AsyncClient, folder: dict[str, Any]) -> str:
    with patch.object(geoapi, "raster_bounds", AsyncMock(return_value=BOUNDS)):
        response = await client.post(
            f"{API}/layer/raster",
            json={
                "folder_id": str(folder["id"]),
                "name": "Elevation",
                "type": "raster",
                "url": "https://cdn.example/dem-2024.tif",
                "data_type": "cog",
            },
        )
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.mark.asyncio
async def test_a_new_address_moves_the_layers_version(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    layer_id = await _cog(client, fixture_get_home_folder)
    before = await _version(db_session, layer_id)
    with patch.object(geoapi, "raster_bounds", AsyncMock(return_value=BOUNDS)):
        response = await client.put(
            f"{API}/layer/{layer_id}", json={"url": "https://cdn.example/dem-2025.tif"}
        )
    assert response.status_code == 200, response.text
    db_session.expire_all()
    after = await _version(db_session, layer_id)
    assert after.url == "https://cdn.example/dem-2025.tif"
    assert after.updated_at > before.updated_at
