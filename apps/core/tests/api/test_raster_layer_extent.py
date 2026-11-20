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


#: Another file's bounds.
OTHER = (11.5, 48.1, 11.6, 48.2)


async def _created(client: AsyncClient, folder: dict[str, Any], **extra: Any) -> str:
    with patch.object(geoapi, "raster_bounds", AsyncMock(return_value=BOUNDS)):
        response = await client.post(f"{API}/layer/raster", json=_cog(folder, **extra))
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.mark.asyncio
async def test_a_new_address_stores_the_new_files_bounds(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    layer_id = await _created(client, fixture_get_home_folder)
    token = jwt.encode({"sub": str(settings.DEFAULT_USER_ID)}, "k", algorithm="HS256")
    bounds = AsyncMock(return_value=OTHER)
    with patch.object(geoapi, "raster_bounds", bounds):
        response = await client.put(
            f"{API}/layer/{layer_id}",
            json={"url": "https://cdn.example/other.tif"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200, response.text
    # geoapi reads the stored row, with the new address, as the editor.
    bounds.assert_awaited_once()
    assert bounds.await_args.args[0] == UUID(layer_id)
    assert bounds.await_args.kwargs["access_token"] == token
    assert await _extent(db_session, layer_id) == pytest.approx(OTHER)
    assert wkt.loads(response.json()["extent"]).bounds == pytest.approx(OTHER)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        AsyncMock(side_effect=geoapi.RasterBoundsUnavailable("geoapi is down")),
        AsyncMock(side_effect=RuntimeError("anything else")),
        AsyncMock(return_value=None),
    ],
)
async def test_a_new_address_without_bounds_drops_the_old_files_extent(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    answer: AsyncMock,
) -> None:
    """The old file's extent would be wrong; without one the web asks geoapi."""
    layer_id = await _created(client, fixture_get_home_folder)
    with patch.object(geoapi, "raster_bounds", answer):
        response = await client.put(
            f"{API}/layer/{layer_id}", json={"url": "https://cdn.example/other.tif"}
        )
    assert response.status_code == 200, response.text
    assert await _extent(db_session, layer_id) is None


@pytest.mark.asyncio
async def test_an_edit_that_keeps_the_address_asks_for_no_bounds(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
) -> None:
    cog = await _created(client, fixture_get_home_folder)
    wms = await _created(
        client,
        fixture_get_home_folder,
        url="https://example.com/wms",
        data_type="wms",
        extent="MULTIPOLYGON(((5 47, 5 55, 15 55, 15 47, 5 47)))",
    )
    bounds = AsyncMock(return_value=OTHER)
    with patch.object(geoapi, "raster_bounds", bounds):
        for layer_id, body in (
            (cog, {"name": "Renamed"}),
            (cog, {"url": "https://cdn.example/tci.tif", "name": "Again"}),
            # A map service's extent comes with the request, a COG's sent one
            # is kept.
            (wms, {"url": "https://example.com/other-wms"}),
            (
                cog,
                {
                    "url": "https://cdn.example/sent.tif",
                    "extent": "MULTIPOLYGON(((5 47, 5 55, 15 55, 15 47, 5 47)))",
                },
            ),
        ):
            response = await client.put(f"{API}/layer/{layer_id}", json=body)
            assert response.status_code == 200, (body, response.text)
    bounds.assert_not_awaited()
    assert await _extent(db_session, wms) == (5, 47, 15, 55)
    assert await _extent(db_session, cog) == (5, 47, 15, 55)
