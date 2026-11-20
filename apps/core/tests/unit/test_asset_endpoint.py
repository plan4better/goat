import mimetypes
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from core.core.config import settings
from core.db.models.asset import AssetType
from core.endpoints.deps import get_db
from core.endpoints.v2.asset import ALLOWED_MIME_TYPES, DOCUMENTS_MAX_FILE_SIZE_BYTES
from core.main import app
from core.services.s3 import s3_service
from httpx import ASGITransport, AsyncClient, Response


def test_document_mime_types_defined() -> None:
    assert AssetType.DOCUMENT in ALLOWED_MIME_TYPES
    allowed = ALLOWED_MIME_TYPES[AssetType.DOCUMENT]
    assert "application/pdf" in allowed
    assert (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        in allowed
    )


def test_documents_max_file_size() -> None:
    assert DOCUMENTS_MAX_FILE_SIZE_BYTES == 52428800


@pytest.mark.parametrize(
    "name", ["a.svg", "a.png", "a.jpg", "a.jpeg", "a.webp", "a.bmp", "a.ico"]
)
def test_icon_types_by_file_name(name: str) -> None:
    # The upload reads the type from the file name first, as mimetypes names it.
    assert mimetypes.guess_type(name)[0] in ALLOWED_MIME_TYPES[AssetType.ICON]


class _Result:
    def __init__(self, value: str | None) -> None:
        self.value = value

    def scalar_one_or_none(self) -> str | None:
        return self.value


class _Session:
    async def execute(self, _statement: object) -> _Result:
        return _Result("users/u1/icons/pin.svg")


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "ASSETS_SERVED_BY_CORE", True)
    monkeypatch.setattr(
        s3_service, "asset_download_url", lambda key: f"https://s3.example/{key}"
    )

    async def session() -> AsyncIterator[_Session]:
        yield _Session()

    app.dependency_overrides[get_db] = session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://core"
        ) as http:
            yield http
    finally:
        app.dependency_overrides.pop(get_db, None)


ASSET_REDIRECTS = [
    f"{settings.API_V2_STR}/asset/{uuid4()}/file",
    f"{settings.API_V2_STR}/asset/file/users/u1/icons/pin.svg",
]


def _vary(response: Response) -> set[str]:
    return {
        token.strip().lower()
        for value in response.headers.get_list("vary")
        for token in value.split(",")
    }


@pytest.mark.parametrize("path", ASSET_REDIRECTS)
async def test_asset_redirect_without_origin_allows_any_origin(
    client: AsyncClient, path: str
) -> None:
    # A browser caches this public redirect from a plain <img> request and
    # reuses it for a later anonymous CORS request (a map icon drawn onto a
    # canvas), so the cached copy must already allow that.
    response = await client.get(path)

    assert response.status_code == 307
    assert response.headers["access-control-allow-origin"] == "*"
    assert "origin" in _vary(response)
    assert response.headers["cache-control"].startswith("public")


@pytest.mark.parametrize("path", ASSET_REDIRECTS)
async def test_asset_redirect_with_origin_allows_that_origin(
    client: AsyncClient, path: str
) -> None:
    response = await client.get(path, headers={"Origin": "https://app.example"})

    assert response.status_code == 307
    # CORSMiddleware reflects the origin (credentials are allowed).
    assert response.headers["access-control-allow-origin"] == "https://app.example"
    assert "origin" in _vary(response)
