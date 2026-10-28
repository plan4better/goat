"""core's client of processes' style-check: which answers are worth retrying."""

from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from aiohttp import web
from core.core.config import settings
from core.services import processes
from core.services.processes import (
    StyleCheckRefused,
    StyleCheckUnavailable,
    style_check,
)

DOC = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#111111"}}}


@pytest_asyncio.fixture
async def processes_answering(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[list[int]]:
    """A local processes that answers the status at the head of the list."""
    statuses: list[int] = []

    async def handle(_: web.Request) -> web.Response:
        return web.json_response({"detail": "x"}, status=statuses[0])

    app = web.Application()
    app.router.add_post("/processes/style-check/execution", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    monkeypatch.setattr(settings, "GOAT_PROCESSES_URL", f"http://127.0.0.1:{port}")
    yield statuses
    await runner.cleanup()


async def check() -> None:
    await style_check(
        layer_id=uuid4(),
        document=DOC,
        geometry="polygon",
        fingerprint="ducklake:1",
        access_token="t",
    )


@pytest.mark.asyncio
async def test_a_refusal_is_not_retryable_and_says_its_status(
    processes_answering: list[int],
) -> None:
    for status in (400, 401, 404, 422):
        processes_answering[:] = [status]
        with pytest.raises(StyleCheckRefused) as refused:
            await check()
        assert refused.value.status == status


@pytest.mark.asyncio
async def test_a_server_error_or_overload_is_retryable(
    processes_answering: list[int],
) -> None:
    for status in (429, 500, 503):
        processes_answering[:] = [status]
        with pytest.raises(StyleCheckUnavailable) as down:
            await check()
        assert not isinstance(down.value, StyleCheckRefused)


def test_the_refusal_is_a_kind_of_unavailable() -> None:
    """Readers answer the stored style for both; only saves tell them apart."""
    assert issubclass(processes.StyleCheckRefused, processes.StyleCheckUnavailable)
