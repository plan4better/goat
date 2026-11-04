"""Live fan-out of run events across replicas (spec §6.1 step 3).

Events are durable in Postgres; the bus only carries them to subscribers that
are connected right now, so a lost message is recovered from the database by
the next replay. Hence Redis pub/sub, not streams.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol
from uuid import UUID

import anyio
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

CONTROL_CHANNEL = "assistant:control"
SUBSCRIBE_TIMEOUT_SECONDS = 5.0


def events_channel(run_id: UUID) -> str:
    return f"assistant:run:{run_id}"


class EventBus(Protocol):
    async def publish(self, channel: str, message: dict[str, Any]) -> None: ...

    async def ping(self) -> None:
        """Raise when the bus cannot reach its backend (readiness)."""
        ...

    def subscribe(
        self, channel: str
    ) -> AbstractAsyncContextManager[AsyncIterator[dict[str, Any]]]:
        """Subscribe to `channel` for the duration of the context.

        The yielded iterator is an async generator: cancelling a pending
        `__anext__()` (for example through `asyncio.wait_for`) finalizes it and
        ends the subscription's stream. Callers that need a keep-alive timeout
        must keep ONE pending `__anext__()` future across timeouts instead of
        issuing a fresh `wait_for(anext(...))` per attempt.
        """
        ...

    async def close(self) -> None: ...


class InMemoryEventBus:
    """Single-process bus for tests and single-replica local runs."""

    def __init__(self) -> None:
        self._queues: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}

    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        for queue in list(self._queues.get(channel, ())):
            queue.put_nowait(message)

    async def ping(self) -> None:
        return None

    @asynccontextmanager
    async def subscribe(
        self, channel: str
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._queues.setdefault(channel, set()).add(queue)

        async def messages() -> AsyncIterator[dict[str, Any]]:
            while True:
                yield await queue.get()

        try:
            yield messages()
        finally:
            subscribers = self._queues.get(channel)
            if subscribers is not None:
                subscribers.discard(queue)
                if not subscribers:
                    del self._queues[channel]

    async def close(self) -> None:
        self._queues.clear()


class RedisEventBus:
    def __init__(self, url: str) -> None:
        self._client = aioredis.from_url(url)  # type: ignore[no-untyped-call]

    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        await self._client.publish(channel, json.dumps(message, default=str))

    async def ping(self) -> None:
        await self._client.ping()

    @asynccontextmanager
    async def subscribe(
        self, channel: str
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        pubsub = self._client.pubsub()

        async def messages() -> AsyncIterator[dict[str, Any]]:
            async for raw in pubsub.listen():
                if raw.get("type") != "message":
                    continue
                try:
                    yield json.loads(raw["data"])
                except ValueError:
                    logger.warning("Skipping non-JSON message on channel %s", channel)

        try:
            await pubsub.subscribe(channel)
            # `subscribe()` returns when the command is sent, not when Redis has
            # registered the subscription; a publish in that window is lost. Wait
            # for the server's confirmation before handing out the iterator.
            async with asyncio.timeout(SUBSCRIBE_TIMEOUT_SECONDS):
                while True:
                    raw = await pubsub.get_message(timeout=1.0)
                    if raw is not None and raw.get("type") == "subscribe":
                        break
            yield messages()
        finally:
            # Under anyio cancellation (level-triggered) every await in this
            # block would raise again, so the connection would never be
            # released; the shield lets `aclose()` finish. It disconnects the
            # connection, which also drops the server-side subscription.
            with anyio.CancelScope(shield=True):
                await pubsub.aclose()

    async def close(self) -> None:
        await self._client.aclose()


def make_bus(url: str) -> EventBus:
    if url.startswith("memory://"):
        return InMemoryEventBus()
    return RedisEventBus(url)
