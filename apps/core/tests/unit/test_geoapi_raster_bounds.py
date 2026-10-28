"""core's client of geoapi's raster `bounds` route, which a COG layer's extent
comes from when core creates the layer."""

from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from aiohttp import web
from core.core.config import settings
from core.services.geoapi import RasterBoundsUnavailable, raster_bounds

LAYER = UUID("abc123de-f456-7890-1234-5678901234ab")


@pytest_asyncio.fixture
async def geoapi_answering(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[dict[str, Any]]:
    """A local geoapi that answers `answer["status"]` and `answer["body"]`, and
    records the request it got."""
    answer: dict[str, Any] = {"status": 200, "body": {"bounds": None}}

    async def handle(request: web.Request) -> web.Response:
        answer["path"] = request.path
        answer["authorization"] = request.headers.get("Authorization")
        return web.json_response(answer["body"], status=answer["status"])

    app = web.Application()
    app.router.add_get("/collections/{id}/raster/bounds", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    monkeypatch.setattr(settings, "GOAT_GEOAPI_URL", f"http://127.0.0.1:{port}/")
    yield answer
    await runner.cleanup()


@pytest.mark.asyncio
async def test_the_bounds_as_the_caller(geoapi_answering: dict[str, Any]) -> None:
    geoapi_answering["body"] = {"bounds": [13.53, 51.36, 15.17, 52.37]}
    assert await raster_bounds(LAYER, access_token="t") == (
        13.53,
        51.36,
        15.17,
        52.37,
    )
    assert geoapi_answering["path"] == f"/collections/{LAYER}/raster/bounds"
    assert geoapi_answering["authorization"] == "Bearer t"


@pytest.mark.asyncio
async def test_no_box_on_earth_is_none(geoapi_answering: dict[str, Any]) -> None:
    assert await raster_bounds(LAYER, access_token="t") is None


@pytest.mark.asyncio
async def test_without_a_token_none_is_sent(geoapi_answering: dict[str, Any]) -> None:
    """AUTH=False: core has no token to forward, geoapi needs none."""
    await raster_bounds(LAYER, access_token="")
    assert geoapi_answering["authorization"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, body",
    [
        (404, {"detail": "Not a raster file layer"}),
        (504, {"detail": "down"}),
        (200, {"bounds": "nonsense"}),
        (200, {"bounds": [1, 2, 3]}),
    ],
)
async def test_any_other_answer_is_unavailable(
    geoapi_answering: dict[str, Any], status: int, body: Any
) -> None:
    geoapi_answering.update(status=status, body=body)
    with pytest.raises(RasterBoundsUnavailable):
        await raster_bounds(LAYER, access_token="t")


@pytest.mark.asyncio
async def test_unconfigured_or_unreachable_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GOAT_GEOAPI_URL", None)
    with pytest.raises(RasterBoundsUnavailable):
        await raster_bounds(LAYER, access_token="t")
    monkeypatch.setattr(settings, "GOAT_GEOAPI_URL", "http://127.0.0.1:9")
    with pytest.raises(RasterBoundsUnavailable):
        await raster_bounds(LAYER, access_token="t")
