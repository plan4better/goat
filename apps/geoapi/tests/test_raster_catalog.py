"""A raster promoted from the catalog is read from the file GOAT stores for it:
the catalog bucket is private, so the item's own href is no address geoapi can
open. The file is found by the layer's id (`stored_raster_file`), never by its
`url`."""

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from geoapi.config import settings
from geoapi.services import raster_service as rs

LAYER = "abc123def456789012345678901234ab"


def _row(catalog: bool, url: str | None) -> dict[str, Any]:
    return {"url": url, "updated": 1, "catalog": catalog}


async def _layer(row: dict[str, Any]) -> rs.RasterLayer | None:
    rs.raster_service.clear()
    with patch.object(
        rs.layer_service, "_execute_with_retry", AsyncMock(return_value=row)
    ):
        return await rs.raster_service.layer(LAYER)


async def test_a_catalog_raster_is_read_from_its_copy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """It has no address (`url` is NULL): the file is found by the id."""
    monkeypatch.setattr(settings, "CATALOG_LAYERS_DIR", str(tmp_path))
    layer = await _layer(_row(True, None))
    assert layer is not None
    assert layer.external_url is None
    assert layer.stored_file == tmp_path / f"t_{LAYER}.tif"


async def test_a_users_raster_is_read_from_its_address(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Whatever its url looks like: a path in a user's url stays an address,
    which the URL guard refuses."""
    monkeypatch.setattr(settings, "CATALOG_LAYERS_DIR", str(tmp_path))
    typed = str(tmp_path / f"t_{LAYER}.tif")
    layer = await _layer(_row(False, typed))
    assert layer is not None
    assert layer.external_url == typed and layer.stored_file is None


async def test_the_lookup_asks_whether_the_layer_is_from_the_catalog() -> None:
    rs.raster_service.clear()
    mock = AsyncMock(return_value=None)
    with patch.object(rs.layer_service, "_execute_with_retry", mock):
        await rs.raster_service.layer(LAYER)
    sql = " ".join(mock.await_args.args[0].split())
    assert "catalog_external_uid" in sql
    assert "(url IS NOT NULL OR catalog_external_uid IS NOT NULL)" in sql


def test_the_stored_file_is_opened_as_a_file(tmp_path: Path) -> None:
    opened: list[tuple[Any, ...]] = []

    class Source:
        def __init__(self, url: str | None, *args: Any, **kwargs: Any) -> None:
            opened.append((url, kwargs))

    copy = tmp_path / "t_x.tif"
    with patch.object(rs, "RasterSource", Source):
        rs.raster_service._source(rs.RasterLayer(LAYER, None, "v", copy))
        rs.raster_service._source(rs.RasterLayer(LAYER, "https://x.example/a.tif", "v"))
    assert opened[0] == (None, {"stored_file": copy})
    assert opened[1] == ("https://x.example/a.tif", {"stored_file": None})
