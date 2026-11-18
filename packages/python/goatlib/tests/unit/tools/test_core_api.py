"""A job calls core's API for uploaded files: icons and images come from
core's public file route, and an import uploads them as the user with the
access token it was given. Nothing here refreshes a token."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from goatlib.tools.core_api import CoreAddressInput, CoreSession, CoreTokenInput

CORE = "http://core:8000"


def session(handler, access_token: str | None = "tok") -> CoreSession:  # noqa: ANN001
    return CoreSession(
        CORE, access_token, client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_api_is_under_cores_v2_prefix() -> None:
    assert CoreSession(CORE + "/", None).api == CORE + "/api/v2"


def test_download_follows_the_public_redirect_without_a_token(tmp_path: Path) -> None:
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("authorization")))
        if request.url.host == "core":
            return httpx.Response(
                307, headers={"location": "http://files.example/k/a.svg?sig=1"}
            )
        return httpx.Response(200, content=b"<svg/>")

    dest = tmp_path / "a.svg"
    session(handler, access_token=None).download_upload("a1", dest)

    assert dest.read_bytes() == b"<svg/>"
    assert seen == [
        (f"{CORE}/api/v2/asset/a1/file", None),
        ("http://files.example/k/a.svg?sig=1", None),
    ]


def test_download_raises_on_a_missing_upload(tmp_path: Path) -> None:
    with pytest.raises(httpx.HTTPStatusError):
        session(lambda r: httpx.Response(404)).download_upload("a1", tmp_path / "a")


def test_upload_posts_the_file_as_the_user(tmp_path: Path) -> None:
    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["url"] = str(request.url)
        sent["auth"] = request.headers.get("authorization")
        sent["body"] = request.read()
        return httpx.Response(201, json={"id": "new-1"})

    path = tmp_path / "old-1.svg"
    path.write_bytes(b"<svg/>")
    new_id = session(handler).upload(
        path,
        file_name="pin.svg",
        mime_type="image/svg+xml",
        asset_type="icon",
        display_name=None,
        category="Shops",
    )

    assert new_id == "new-1"
    assert sent["url"] == f"{CORE}/api/v2/asset/upload"
    assert sent["auth"] == "Bearer tok"
    body = sent["body"]
    assert isinstance(body, bytes)
    # Core takes the MIME type from the file name; an icon needs a display name.
    assert b'filename="pin.svg"' in body
    assert b'name="asset_type"\r\n\r\nicon' in body
    assert b'name="display_name"\r\n\r\npin' in body
    assert b'name="category"\r\n\r\nShops' in body
    assert b"folder_id" not in body


def test_an_expired_token_is_an_error_not_a_refresh(tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(401)

    path = tmp_path / "f.png"
    path.write_bytes(b"png")
    with pytest.raises(httpx.HTTPStatusError):
        session(handler).upload(path, "f.png", "image/png", "image", None, None)
    assert calls == [f"{CORE}/api/v2/asset/upload"]


def test_the_users_uploads_and_deleting_one(tmp_path: Path) -> None:
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": "a"}, {"id": "b"}])
        return httpx.Response(204)

    s = session(handler)
    assert s.upload_ids() == {"a", "b"}
    s.delete_upload("b")
    assert seen == [
        ("GET", f"{CORE}/api/v2/asset"),
        ("DELETE", f"{CORE}/api/v2/asset/b"),
    ]


def test_inputs_are_hidden_from_the_tool_form() -> None:
    for model, name in (
        (CoreAddressInput, "core_url"),
        (CoreTokenInput, "access_token"),
    ):
        prop = model.model_json_schema()["properties"][name]
        assert json.dumps(prop).count('"hidden": true') == 1
    assert "refresh_token" not in CoreTokenInput.model_fields
