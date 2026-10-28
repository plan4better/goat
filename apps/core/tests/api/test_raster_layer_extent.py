"""A raster layer created from a COG address stores the file's bounds as its
extent: core asks geoapi's `bounds` route, which reads the file's header (core
has no raster reader). Bounds that cannot be had leave the extent empty and
never fail the creation. A map service's extent comes with the request."""

from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from core.core.config import settings
from core.services import geoapi
from httpx import AsyncClient
from jose import jwt
from shapely import wkt
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

API = settings.API_V2_STR
BOUNDS = (13.53, 51.36, 15.17, 52.37)


def _cog(folder: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "folder_id": str(folder["id"]),
        "name": "Sentinel",
        "type": "raster",
        "url": "https://cdn.example/tci.tif",
        "data_type": "cog",
        **extra,
    }


async def _extent(db: AsyncSession, layer_id: str) -> Any:
    row = (
        await db.execute(
            text(
                f"SELECT ST_XMin(extent) w, ST_YMin(extent) s, ST_XMax(extent) e, "
                f"ST_YMax(extent) n FROM {settings.SCHEMA}.layer WHERE id = :id"
            ),
            {"id": UUID(layer_id)},
        )
    ).first()
    return None if row is None or row.w is None else tuple(row)


@pytest.mark.asyncio
async def test_a_cog_layer_stores_the_files_bounds(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    # The caller's token (AUTH is off here, so it is read unverified).
    token = jwt.encode({"sub": str(settings.DEFAULT_USER_ID)}, "k", algorithm="HS256")
    bounds = AsyncMock(return_value=BOUNDS)
    with patch.object(geoapi, "raster_bounds", bounds):
        response = await client.post(
            f"{API}/layer/raster",
            json=_cog(fixture_get_home_folder),
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 201, response.text
    layer_id = response.json()["id"]
    # geoapi reads the stored row, as the creator.
    bounds.assert_awaited_once()
    assert bounds.await_args.args[0] == UUID(layer_id)
    assert bounds.await_args.kwargs["access_token"] == token
    assert await _extent(db_session, layer_id) == pytest.approx(BOUNDS)
    # The answer carries it too.
    assert wkt.loads(response.json()["extent"]).bounds == pytest.approx(BOUNDS)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        geoapi.RasterBoundsUnavailable("geoapi is down"),
        RuntimeError("anything else"),
    ],
)
async def test_a_cog_layer_without_bounds_is_still_created(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    failure: Exception,
) -> None:
    with patch.object(geoapi, "raster_bounds", AsyncMock(side_effect=failure)):
        response = await client.post(
            f"{API}/layer/raster", json=_cog(fixture_get_home_folder)
        )
    assert response.status_code == 201, response.text
    assert await _extent(db_session, response.json()["id"]) is None


@pytest.mark.asyncio
async def test_a_cog_whose_bounds_are_no_box_keeps_no_extent(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    with patch.object(geoapi, "raster_bounds", AsyncMock(return_value=None)):
        response = await client.post(
            f"{API}/layer/raster", json=_cog(fixture_get_home_folder)
        )
    assert response.status_code == 201, response.text
    assert await _extent(db_session, response.json()["id"]) is None


@pytest.mark.asyncio
async def test_a_map_service_keeps_the_extent_it_was_sent(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    """WMS and WMTS: the web sends the capabilities' bounding box."""
    bounds = AsyncMock(return_value=BOUNDS)
    with patch.object(geoapi, "raster_bounds", bounds):
        response = await client.post(
            f"{API}/layer/raster",
            json={
                **_cog(fixture_get_home_folder),
                "url": "https://example.com/wms",
                "data_type": "wms",
                "extent": "MULTIPOLYGON(((5 47, 5 55, 15 55, 15 47, 5 47)))",
            },
        )
    assert response.status_code == 201, response.text
    bounds.assert_not_awaited()
    assert await _extent(db_session, response.json()["id"]) == (5, 47, 15, 55)


@pytest.mark.asyncio
async def test_a_cog_sent_with_an_extent_keeps_it(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    bounds = AsyncMock(return_value=BOUNDS)
    with patch.object(geoapi, "raster_bounds", bounds):
        response = await client.post(
            f"{API}/layer/raster",
            json=_cog(
                fixture_get_home_folder,
                extent="MULTIPOLYGON(((5 47, 5 55, 15 55, 15 47, 5 47)))",
            ),
        )
    assert response.status_code == 201, response.text
    bounds.assert_not_awaited()
    assert await _extent(db_session, response.json()["id"]) == (5, 47, 15, 55)
