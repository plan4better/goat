"""A raster promoted from the catalog is read from the file GOAT stores for it:
the catalog bucket is private, so the item's own href is no address geoapi can
open. The file is found by the layer's id (`stored_raster_file`), never by its
`url`."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from goatlib.raster.values import ENCODING_VERSION

from geoapi.config import settings
from geoapi.services import raster_service as rs

LAYER = "abc123def456789012345678901234ab"
UPDATED = datetime(2026, 11, 19, 12, 0, 0, 250000, tzinfo=timezone.utc)


def _row(
    catalog: bool, url: str | None, updated_at: datetime = UPDATED
) -> dict[str, Any]:
    return {"url": url, "updated_at": updated_at, "catalog": catalog}


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


async def test_two_writes_within_a_second_are_two_versions() -> None:
    """A layer's version names its update time to the microsecond: a file
    given to it twice within one second still gets new tile addresses."""
    url = "https://cdn.example/dem.tif"
    first = await _layer(_row(False, url))
    second = await _layer(_row(False, url, UPDATED + timedelta(microseconds=1)))
    catalog = await _layer(_row(True, None))
    replaced = await _layer(_row(True, None, UPDATED + timedelta(milliseconds=300)))
    assert first is not None and second is not None
    assert catalog is not None and replaced is not None
    assert first.version != second.version
    assert catalog.version != replaced.version
    # A values version (with a remote file's validator and the encoding's)
    # still fits the tile route's `v`, 64 characters.
    assert len(f"{second.version}-{'0' * 8}-{ENCODING_VERSION}") <= 64


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
    assert opened[0] == (None, {"stored_file": copy, "remember_failures": True})
    assert opened[1] == (
        "https://x.example/a.tif",
        {"stored_file": None, "remember_failures": True},
    )
