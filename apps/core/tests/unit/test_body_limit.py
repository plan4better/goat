"""Request body caps of the style, map-state and project update routes: a larger
body is answered 413 before it is read whole or parsed."""

import json
import re
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from core.core.config import settings
from core.endpoints.v2 import style
from core.main import (
    PROJECT_BODY_MAX_BYTES,
    PROJECT_BODY_PATHS,
    STYLE_BODY_MAX_BYTES,
    STYLE_BODY_PATHS,
    app,
)
from core.support.body_limit import BodyLimit
from fastapi.routing import APIRoute
from goatlib.style.map_rows import MAX_DOCUMENT_BYTES
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.unit
V2 = settings.API_V2_STR
MB = 1024 * 1024
TOO_LARGE = {"detail": {"code": "body_too_large"}}
STYLE_SAVE = f"{V2}/project/{uuid4()}/layer/7/style/{uuid4()}"
PROJECT = f"{V2}/project/{uuid4()}"


def _concrete(path: str) -> str:
    """A route path with every parameter filled in."""
    return re.sub(r"\{[^}]+\}", "x1", path)


def _body_routes() -> list[tuple[str, str]]:
    """(method, concrete path) of every core route that takes a request body."""
    return [
        (method, _concrete(route.path))
        for route in app.routes
        if isinstance(route, APIRoute) and route.body_field is not None
        for method in route.methods
    ]


def test_body_cap_covers_every_style_route_that_takes_a_body() -> None:
    style_routes = [
        route
        for route in style.router.routes
        if isinstance(route, APIRoute) and route.body_field is not None
    ]
    assert len(style_routes) >= 6
    for route in style_routes:
        assert re.fullmatch(STYLE_BODY_PATHS, _concrete(V2 + route.path)), route.path


def test_body_caps_cover_only_the_style_routes_and_the_project_update() -> None:
    style_paths = {
        _concrete(V2 + route.path)
        for route in style.router.routes
        if isinstance(route, APIRoute)
    }
    for method, path in _body_routes():
        if re.fullmatch(STYLE_BODY_PATHS, path):
            assert path in style_paths, (method, path)
        if re.fullmatch(PROJECT_BODY_PATHS, path):
            assert path == _concrete(f"{V2}/project/{{project_id}}"), (method, path)
    assert re.fullmatch(PROJECT_BODY_PATHS, PROJECT)
    assert not re.fullmatch(PROJECT_BODY_PATHS, f"{PROJECT}/initial-view-state")
    assert not re.fullmatch(STYLE_BODY_PATHS, f"{PROJECT}/layer")


def test_body_cap_of_the_style_routes_leaves_room_for_a_document_at_its_limit() -> None:
    # A document at the limit in ASCII escapes (six bytes for each two-byte
    # character) with default separators still reaches the handler's own check.
    assert STYLE_BODY_MAX_BYTES >= 3 * MAX_DOCUMENT_BYTES + 1024


async def test_style_body_over_the_cap_is_413_before_it_is_read() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        r = await ac.put(
            STYLE_SAVE,
            content=b"{}",
            headers={
                "content-type": "application/json",
                "content-length": str(STYLE_BODY_MAX_BYTES + 1),
            },
        )
    assert (r.status_code, r.json()) == (413, TOO_LARGE)


async def test_chunked_style_body_over_the_cap_is_413_while_streaming() -> None:
    sent = 0
    chunks = STYLE_BODY_MAX_BYTES // MB + 4

    async def body() -> AsyncIterator[bytes]:
        nonlocal sent
        yield b'{"base_rev": 1, "document": {"name": "'
        for _ in range(chunks):  # no Content-Length: chunked
            sent += 1
            yield b"x" * MB
        yield b'"}}'

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        r = await ac.put(
            STYLE_SAVE, content=body(), headers={"content-type": "application/json"}
        )
    assert (r.status_code, r.json()) == (413, TOO_LARGE)
    assert sent < chunks  # stopped while streaming, not after the whole body


async def test_chunked_map_state_body_over_the_cap_is_413() -> None:
    async def body() -> AsyncIterator[bytes]:
        yield b'{"time_value": "'
        for _ in range(STYLE_BODY_MAX_BYTES // MB + 2):
            yield b"x" * MB
        yield b'"}'

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        r = await ac.patch(
            f"{V2}/project/{uuid4()}/group/3/map-state",
            content=body(),
            headers={"content-type": "application/json"},
        )
    assert (r.status_code, r.json()) == (413, TOO_LARGE)


async def test_project_update_body_over_its_cap_is_413() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        r = await ac.put(
            PROJECT,
            content=b"{}",
            headers={
                "content-type": "application/json",
                "content-length": str(PROJECT_BODY_MAX_BYTES + 1),
            },
        )
    assert (r.status_code, r.json()) == (413, TOO_LARGE)


# ------------------------------------------------------------ the middleware
class _Inner:
    def __init__(self) -> None:
        self.ran = False

    async def __call__(self, scope: dict, receive: object, send: object) -> None:
        self.ran = True
        total = 0
        while True:
            message = await receive()  # type: ignore[operator]
            total += len(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})  # type: ignore[operator]
        await send({"type": "http.response.body", "body": str(total).encode()})  # type: ignore[operator]


async def _call(
    app_: object, *, path: str, chunks: list[bytes], declared: int | None = None
) -> tuple[int, bytes]:
    sent: list[dict] = []
    queue = list(chunks)

    async def receive() -> dict:
        if queue:
            return {
                "type": "http.request",
                "body": queue.pop(0),
                "more_body": bool(queue),
            }
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    headers = [] if declared is None else [(b"content-length", str(declared).encode())]
    await app_(
        {"type": "http", "method": "PUT", "path": path, "headers": headers},
        receive,
        send,
    )  # type: ignore[operator]
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    return status, b"".join(
        m.get("body", b"") for m in sent if m["type"] == "http.response.body"
    )


def _limited(inner: _Inner) -> BodyLimit:
    return BodyLimit(
        inner,  # type: ignore[arg-type]
        max_bytes=100,
        paths=STYLE_BODY_PATHS,
        detail={"code": "body_too_large"},
    )


async def test_body_limit_passes_a_body_at_the_cap_and_other_paths() -> None:
    inner = _Inner()
    assert await _call(
        _limited(inner), path=STYLE_SAVE, chunks=[b"x" * 60, b"x" * 40]
    ) == (200, b"100")
    other = _Inner()
    status, body = await _call(
        _limited(other), path=f"{V2}/layer", chunks=[b"x" * 5000], declared=5000
    )
    assert (status, body, other.ran) == (200, b"5000", True)


async def test_body_limit_answers_a_declared_size_without_running_the_app() -> None:
    inner = _Inner()
    status, body = await _call(
        _limited(inner), path=STYLE_SAVE, chunks=[b"x"], declared=101
    )
    assert (status, json.loads(body)) == (413, TOO_LARGE)
    assert inner.ran is False
