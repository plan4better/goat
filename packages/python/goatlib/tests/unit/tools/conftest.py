"""Fixtures for the tool runner unit tests."""

import asyncio
from collections.abc import Iterator

import pytest


@pytest.fixture
def runner_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[asyncio.AbstractEventLoop]:
    """An event loop for a runner's own `run()`, which drives its database
    calls with `asyncio.get_event_loop()`. Once code in the same process has
    called `asyncio.run()`, the thread has no loop and that call raises, so
    the test gets a loop of its own, closed afterwards."""
    loop = asyncio.new_event_loop()
    monkeypatch.setattr(asyncio, "get_event_loop", lambda: loop)
    yield loop
    loop.close()
