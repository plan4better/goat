"""An uploaded icon a style names (`asset:<id>`, spec 3) is reachable by its id, so
every viewer of a map draws it, not only the user who uploaded it."""

from uuid import uuid4

import pytest
from core.core.config import settings
from core.db.models.asset import AssetType, UploadedAsset
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR


def upload(world: StyleWorld, kind: AssetType, key: str) -> UploadedAsset:
    return UploadedAsset(
        id=uuid4(),
        user_id=world.user_id,
        s3_key=key,
        file_name=key.rsplit("/", 1)[-1],
        mime_type="image/svg+xml",
        file_size=1,
        asset_type=kind,
        content_hash=uuid4().hex,
    )


async def test_an_uploaded_icon_redirects_to_its_file_by_id(
    client: AsyncClient,
    db_session: AsyncSession,
    style_world: StyleWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ASSETS_URL", "https://assets.example.org/goat")
    icon = upload(style_world, AssetType.ICON, "icons/u/pin.svg")
    document = upload(style_world, AssetType.DOCUMENT, "documents/u/plan.pdf")
    db_session.add_all([icon, document])
    await db_session.commit()

    response = await client.get(f"{API}/asset/{icon.id}/file")
    assert response.status_code == 307
    assert response.headers["location"] == "https://assets.example.org/goat/icons/u/pin.svg"
    assert response.headers["cache-control"].startswith("public, max-age=")
    # Documents stay behind their key; an unknown id is not found.
    assert (await client.get(f"{API}/asset/{document.id}/file")).status_code == 404
    assert (await client.get(f"{API}/asset/{uuid4()}/file")).status_code == 404
