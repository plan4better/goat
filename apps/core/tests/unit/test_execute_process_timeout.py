"""core's job submission to the processes service gives up on a service that
accepts the connection and never answers, instead of holding the caller (a
catalog add, a bundle import, a template copy) for aiohttp's default five
minutes."""

import asyncio
import socket
import time
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from core.core.config import settings
from core.services import processes
from core.services.processes import (
    dispatch_never_started,
    execute_process,
    submit_each,
)


@pytest_asyncio.fixture
async def silent_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[list[asyncio.StreamWriter]]:
    """A processes service that takes the request and never answers: to the
    caller, the same as a listening socket with no live worker behind it.
    Yields the connections it accepted."""
    held: list[asyncio.StreamWriter] = []
    stop = asyncio.Event()

    async def never_answer(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        held.append(writer)
        await reader.read(65536)
        await stop.wait()

    server = await asyncio.start_server(never_answer, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(settings, "GOAT_PROCESSES_URL", f"http://127.0.0.1:{port}")
    yield held
    stop.set()
    for writer in held:
        writer.close()
    server.close()
    await server.wait_closed()


@pytest.mark.asyncio
async def test_a_processes_service_that_never_answers_times_out(
    silent_processes: list[asyncio.StreamWriter], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(processes, "EXECUTE_PROCESS_TIMEOUT_S", 0.2, raising=False)

    started = time.monotonic()
    with pytest.raises(TimeoutError) as raised:
        # The outer bound only keeps a regression from hanging the suite; the
        # elapsed time says whose timeout fired.
        await asyncio.wait_for(
            execute_process(
                process_id="catalog_materialize",
                inputs={"layer_id": "x"},
                access_token="t",
            ),
            timeout=5,
        )
    assert time.monotonic() - started < 2
    # The submission may have been accepted: callers must not treat it as a
    # job that never started.
    assert dispatch_never_started(raised.value) is False


THREE_LAYERS = [{"layer_id": "a"}, {"layer_id": "b"}, {"layer_id": "c"}]


@pytest.mark.asyncio
async def test_a_batch_waits_for_one_timeout_not_one_per_job(
    silent_processes: list[asyncio.StreamWriter], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A catalog dataset expands to many layers, each with a materialize job.
    Once processes has not answered one of them, asking again for every other
    layer only multiplies the wait: the rest stay pending, which re-adding the
    dataset heals."""
    monkeypatch.setattr(processes, "EXECUTE_PROCESS_TIMEOUT_S", 0.2)

    started = time.monotonic()
    submitted = await asyncio.wait_for(
        submit_each(
            process_id="catalog_materialize",
            inputs=THREE_LAYERS,
            access_token="t",
        ),
        timeout=5,
    )
    elapsed = time.monotonic() - started

    assert submitted == 0
    assert len(silent_processes) == 1
    assert elapsed < 0.2 * 2


@pytest.mark.asyncio
async def test_a_batch_stops_after_processes_refuses_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setattr(settings, "GOAT_PROCESSES_URL", f"http://127.0.0.1:{port}")
    attempts = 0
    real = processes.execute_process

    async def counted(**kwargs: object) -> str:
        nonlocal attempts
        attempts += 1
        return await real(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(processes, "execute_process", counted)

    submitted = await submit_each(
        process_id="catalog_materialize", inputs=THREE_LAYERS, access_token="t"
    )

    assert submitted == 0
    assert attempts == 1


@pytest.mark.asyncio
async def test_a_job_processes_refuses_does_not_stop_the_others(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 502 is an answer: processes is alive, so the next job may well start."""
    requests = 0

    async def refuse(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        nonlocal requests
        requests += 1
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n"
            b"Connection: close\r\n\r\n"
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(refuse, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(settings, "GOAT_PROCESSES_URL", f"http://127.0.0.1:{port}")
    try:
        submitted = await submit_each(
            process_id="catalog_materialize", inputs=THREE_LAYERS, access_token="t"
        )
    finally:
        server.close()
        await server.wait_closed()

    assert submitted == 0
    assert requests == 3
