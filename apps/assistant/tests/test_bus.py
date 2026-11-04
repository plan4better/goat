import asyncio
import logging
import os

import anyio
import pytest

from assistant.bus import EventBus, InMemoryEventBus, RedisEventBus


async def _roundtrip(bus: EventBus) -> None:
    async with bus.subscribe("chan") as messages:
        await bus.publish("chan", {"n": 1})
        await bus.publish("other", {"n": 99})
        await bus.publish("chan", {"n": 2})
        received = [await asyncio.wait_for(anext(messages), 2) for _ in range(2)]
    assert received == [{"n": 1}, {"n": 2}]


async def test_in_memory_bus() -> None:
    bus = InMemoryEventBus()
    await _roundtrip(bus)
    await bus.close()


async def test_in_memory_bus_fans_out_to_every_subscriber() -> None:
    bus = InMemoryEventBus()
    async with bus.subscribe("c") as a, bus.subscribe("c") as b:
        await bus.publish("c", {"x": 1})
        assert await asyncio.wait_for(anext(a), 1) == {"x": 1}
        assert await asyncio.wait_for(anext(b), 1) == {"x": 1}


@pytest.mark.integration
async def test_redis_bus() -> None:
    bus = RedisEventBus(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    await _roundtrip(bus)
    await bus.close()


async def test_in_memory_bus_keeps_no_state_for_idle_channels() -> None:
    bus = InMemoryEventBus()
    await bus.publish("nobody-listens", {"n": 1})
    assert bus._queues == {}
    async with bus.subscribe("c") as a, bus.subscribe("c"):
        await bus.publish("c", {"n": 2})
        assert await asyncio.wait_for(anext(a), 1) == {"n": 2}
        assert "c" in bus._queues
    assert bus._queues == {}


def _redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379/0")


@pytest.mark.integration
async def test_redis_bus_releases_connection_when_cancelled_by_anyio() -> None:
    bus = RedisEventBus(_redis_url())
    subscribed = anyio.Event()

    async def subscriber() -> None:
        async with bus.subscribe("chan-cancel") as messages:
            subscribed.set()
            await anext(messages)

    try:
        async with anyio.create_task_group() as tg:
            tg.start_soon(subscriber)
            await subscribed.wait()
            tg.cancel_scope.cancel()
        assert len(bus._client.connection_pool._in_use_connections) == 0
    finally:
        await bus.close()


@pytest.mark.integration
async def test_redis_bus_subscribe_times_out_without_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("assistant.bus.SUBSCRIBE_TIMEOUT_SECONDS", 0.2)
    bus = RedisEventBus(_redis_url())

    async def never_confirms(
        self: object, timeout: float | None = None, **kwargs: object
    ) -> None:
        await asyncio.sleep(timeout or 0)

    monkeypatch.setattr("redis.asyncio.client.PubSub.get_message", never_confirms)
    try:
        with pytest.raises(TimeoutError):
            async with bus.subscribe("chan-timeout"):
                pass
        assert len(bus._client.connection_pool._in_use_connections) == 0
    finally:
        await bus.close()


@pytest.mark.integration
async def test_redis_bus_skips_non_json_messages(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bus = RedisEventBus(_redis_url())
    try:
        with caplog.at_level(logging.WARNING, logger="assistant.bus"):
            async with bus.subscribe("chan-junk") as messages:
                await bus._client.publish("chan-junk", "not json{")
                await bus.publish("chan-junk", {"n": 1})
                received = await asyncio.wait_for(anext(messages), 2)
        assert received == {"n": 1}
        assert "chan-junk" in caplog.text
    finally:
        await bus.close()
