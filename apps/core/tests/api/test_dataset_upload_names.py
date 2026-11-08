"""An upload is presigned only for a file name of a format the import reads."""

import pytest
from core.core.config import settings


async def _request_upload(client, filename: str):
    return await client.post(
        f"{settings.API_V2_STR}/datasets/request-upload",
        json={
            "filename": filename,
            "content_type": "application/octet-stream",
            "file_size": 1,
        },
    )


@pytest.mark.asyncio
async def test_request_upload_refuses_unknown_extension(client):
    resp = await _request_upload(client, "data.xml")

    assert resp.status_code == 422
    assert "Unsupported file format: .xml" in resp.text
    for accepted in (".gpkg", ".geojson", ".zip", ".csv", ".xlsx", ".parquet"):
        assert accepted in resp.text


@pytest.mark.asyncio
async def test_request_upload_takes_a_known_extension_in_any_case(client):
    resp = await _request_upload(client, "DATA.GPKG")

    assert resp.status_code == 200, resp.text
    assert resp.json()["key"].endswith("/DATA.GPKG")


@pytest.mark.asyncio
async def test_request_upload_checks_the_name_it_stores(client):
    """The key takes the sanitized base name, which is what is checked."""
    resp = await _request_upload(client, "../folder/DATA.GPKG")

    assert resp.status_code == 200, resp.text
    assert resp.json()["key"].endswith("/DATA.GPKG")


@pytest.mark.asyncio
async def test_request_upload_names_a_missing_extension(client):
    resp = await _request_upload(client, "data")

    assert resp.status_code == 422
    assert "Unsupported file format: no file extension" in resp.text
