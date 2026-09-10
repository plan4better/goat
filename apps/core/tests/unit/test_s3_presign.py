from urllib.parse import parse_qs, urlparse

import pytest
from core.core.config import settings
from core.services.s3 import S3Service

PUBLIC = "https://s3.example.org"
INTERNAL = "http://minio:9000"


@pytest.fixture
def s3_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "S3_PROVIDER", "minio")
    monkeypatch.setattr(settings, "S3_ENDPOINT_URL", INTERNAL)
    monkeypatch.setattr(settings, "S3_PUBLIC_ENDPOINT_URL", PUBLIC)
    monkeypatch.setattr(settings, "S3_ACCESS_KEY_ID", "test-key")
    monkeypatch.setattr(settings, "S3_SECRET_ACCESS_KEY", "test-secret")
    monkeypatch.setattr(settings, "S3_REGION", "us-east-1")
    monkeypatch.setattr(settings, "S3_FORCE_PATH_STYLE", True)


@pytest.mark.unit
def test_presigned_put_is_signed_for_the_public_host(s3_settings: None) -> None:
    presigned = S3Service().generate_presigned_put(
        bucket_name="goat",
        s3_key="users/u1/imports/uploads/data.gpkg",
        content_type="application/geopackage+sqlite3",
    )
    url = urlparse(presigned["url"])
    query = parse_qs(url.query)

    assert presigned["key"] == "users/u1/imports/uploads/data.gpkg"
    assert presigned["headers"] == {"Content-Type": "application/geopackage+sqlite3"}
    # A SigV4 signature covers the Host header, so the URL must be signed for
    # the host the browser will talk to, not rewritten afterwards.
    assert f"{url.scheme}://{url.netloc}" == PUBLIC
    assert url.path == "/goat/users/u1/imports/uploads/data.gpkg"
    assert query["X-Amz-SignedHeaders"] == ["content-type;host"]
    assert "X-Amz-Signature" in query


@pytest.mark.unit
def test_presigned_put_uses_internal_host_without_public_endpoint(
    s3_settings: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "S3_PUBLIC_ENDPOINT_URL", None)
    presigned = S3Service().generate_presigned_put(
        bucket_name="goat", s3_key="k", content_type="text/csv"
    )
    assert presigned["url"].startswith(INTERNAL)
