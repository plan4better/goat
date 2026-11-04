import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel

from assistant import app as app_module
from assistant.agent import INSTRUCTIONS, RunDeps, build_agent
from assistant.app import AppServices, create_app
from assistant.auth import Principal, get_principal
from assistant.bus import EventBus, InMemoryEventBus, events_channel
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.encoding.ai_sdk import AiSdkEncoder
from assistant.repo import Repository
from assistant.routers import conversations
from assistant.runs.manager import RunManager
from tests.test_manager import _gated_agent

USER = UUID(int=1)
OTHER = UUID(int=2)
RUN = {"message": {"id": "u1", "text": "go"}}
WAIT = 5.0


class Gate:
    """Lets a test hold a run after its first token and see that it got there."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.reached = asyncio.Event()

    def set(self) -> None:
        self.release.set()

    async def at_first_token(self) -> None:
        await asyncio.wait_for(self.reached.wait(), WAIT)


def _gated(gate: Gate) -> Callable[[str], Agent[RunDeps, str]]:
    """An agent that streams one word, then waits for the test to release it."""

    def factory(model: str) -> Agent[RunDeps, str]:
        async def stream(
            messages: list[ModelMessage], info: AgentInfo
        ) -> AsyncIterator[str | DeltaToolCalls]:
            yield "first "
            gate.reached.set()
            await gate.release.wait()
            yield "second"

        return Agent(
            FunctionModel(stream_function=stream),
            deps_type=RunDeps,
            instructions=INSTRUCTIONS,
        )

    return factory


class FlakyBus:
    """An in-memory bus that can drop or repeat event messages on their way out."""

    def __init__(self, *, drop: Callable[[dict[str, Any]], bool] | None = None) -> None:
        self.inner = InMemoryEventBus()
        self.drop = drop or (lambda message: False)
        self.dropped = 0
        self.repeat = False

    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        if "event" in message and self.drop(message):
            self.dropped += 1
            return
        await self.inner.publish(channel, message)
        if self.repeat and "event" in message:
            await self.inner.publish(channel, message)

    def subscribe(
        self, channel: str
    ) -> AbstractAsyncContextManager[AsyncIterator[dict[str, Any]]]:
        return self.inner.subscribe(channel)

    async def close(self) -> None:
        await self.inner.close()


@asynccontextmanager
async def _services(
    db: Database,
    settings: AssistantSettings,
    factory: Callable[[str], Agent[RunDeps, str]] = build_agent,
    bus: EventBus | None = None,
) -> AsyncIterator[AppServices]:
    bus = bus or InMemoryEventBus()
    repo = Repository(db)
    runs = RunManager(repo, bus, settings, owner="test", agent_factory=factory)
    await runs.start()
    try:
        yield AppServices(db=db, repo=repo, bus=bus, runs=runs)
    finally:
        await runs.stop()


@pytest_asyncio.fixture
async def gate() -> Gate:
    # Created inside the test's own event loop.
    return Gate()


def _client(
    settings: AssistantSettings, services: AppServices, user: UUID = USER
) -> AsyncClient:
    app = create_app(settings, services=services)
    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id=user, token=None
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _chunks(body: str) -> list[dict[str, object]]:
    frames = [
        f for f in body.split("\n\n") if f.startswith("data: ") and f != "data: [DONE]"
    ]
    return [json.loads(f.removeprefix("data: ")) for f in frames]


async def _new_conversation(client: AsyncClient) -> str:
    response = await client.post("/conversations", json={"origin_surface": "catalog"})
    assert response.status_code == 201
    return str(response.json()["id"])


async def _until(condition: Callable[[], bool | Awaitable[bool]]) -> None:
    """Poll until the condition holds; the failure is a timeout, never a hang."""

    async def poll() -> None:
        while True:
            result = condition()
            if (await result) if isinstance(result, Awaitable) else result:
                return
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), WAIT)


def _subscribers(bus: InMemoryEventBus, run_id: UUID) -> int:
    return len(bus._queues.get(events_channel(run_id), ()))


async def _active_run_id(services: AppServices, conversation_id: str) -> UUID:
    run = await services.repo.active_run(UUID(conversation_id))
    assert run is not None
    return UUID(str(run["id"]))


async def test_post_run_streams_the_whole_run(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        response = await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
    assert response.status_code == 200
    assert response.headers["x-vercel-ai-ui-message-stream"] == "v1"
    chunks = _chunks(response.text)
    assert chunks[0]["type"] == "start"
    assert chunks[-1] == {"type": "finish"}
    assert response.text.endswith("data: [DONE]\n\n")


async def test_stream_after_finish_is_204_and_message_is_folded(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        assert (
            await client.get(f"/conversations/{conversation_id}/stream")
        ).status_code == 204
        body = (await client.get(f"/conversations/{conversation_id}")).json()
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
    assert any(p["type"] == "text" for p in body["messages"][1]["parts"])


async def test_resume_replays_the_same_message(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live_task = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        run_id = await _active_run_id(services, conversation_id)
        resumed_task = asyncio.create_task(
            client.get(f"/conversations/{conversation_id}/stream")
        )
        assert isinstance(services.bus, InMemoryEventBus)
        await _until(lambda: _subscribers(services.bus, run_id) == 2)  # type: ignore[arg-type]
        gate.set()
        live, resumed = await live_task, await resumed_task
    # Same message id, same part ids, same order.
    assert _chunks(resumed.text) == _chunks(live.text)


async def test_post_while_running_is_409(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        first = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        second = await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        gate.set()
        await first
    assert second.status_code == 409


async def test_cancel_endpoint_stops_the_run(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        first = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        assert (
            await client.post(f"/conversations/{conversation_id}/cancel")
        ).status_code == 202
        live = await first
        assert (
            await client.post(f"/conversations/{conversation_id}/cancel")
        ).status_code == 204
    assert _chunks(live.text)[-1] == {"type": "abort"}


async def test_other_users_conversation_is_404(
    db: Database, settings: AssistantSettings
) -> None:
    async with _services(db, settings) as services:
        async with _client(settings, services) as owner:
            conversation_id = await _new_conversation(owner)
        async with _client(settings, services, user=OTHER) as stranger:
            for method, path in [
                ("GET", f"/conversations/{conversation_id}"),
                ("GET", f"/conversations/{conversation_id}/stream"),
                ("POST", f"/conversations/{conversation_id}/cancel"),
                ("DELETE", f"/conversations/{conversation_id}"),
            ]:
                assert (await stranger.request(method, path)).status_code == 404, path
            response = await stranger.post(
                f"/conversations/{conversation_id}/runs", json=RUN
            )
            assert response.status_code == 404


async def test_user_run_limit_is_429(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    limited = settings.model_copy(update={"user_max_concurrent_runs": 1})
    async with (
        _services(db, limited, _gated(gate)) as services,
        _client(limited, services) as client,
    ):
        first_id = await _new_conversation(client)
        second_id = await _new_conversation(client)
        first = asyncio.create_task(
            client.post(f"/conversations/{first_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        blocked = await client.post(f"/conversations/{second_id}/runs", json=RUN)
        gate.set()
        await first
    assert blocked.status_code == 429


async def test_quiet_run_keeps_the_stream_alive(
    db: Database,
    settings: AssistantSettings,
    gate: Gate,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run silent for longer than the keep-alive interval sends comment frames
    and still delivers the events that follow."""
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.1)
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        # Several keep-alive intervals of real silence.
        await asyncio.sleep(0.6)
        gate.set()
        response = await live
    assert ": keep-alive\n\n" in response.text
    chunks = _chunks(response.text)
    assert chunks[-1] == {"type": "finish"}
    deltas = "".join(str(c["delta"]) for c in chunks if c["type"] == "text-delta")
    assert deltas == "first second"


async def test_delete_during_a_run_ends_it_first(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        assert (
            await client.delete(f"/conversations/{conversation_id}")
        ).status_code == 204
        await live
        assert (
            await client.get(f"/conversations/{conversation_id}")
        ).status_code == 404


async def test_post_run_while_shutting_down_is_503(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await services.runs.stop()
        response = await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
    assert response.status_code == 503


async def test_conversation_json_is_valid_and_listed(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        detail = await client.get(f"/conversations/{conversation_id}")
        listed = await client.get("/conversations")
    body = json.loads(detail.text)
    assert body["conversation"]["id"] == conversation_id
    assert UUID(body["conversation"]["user_id"]) == USER
    assert isinstance(body["conversation"]["created_at"], str)
    assert [c["id"] for c in json.loads(listed.text)] == [conversation_id]


# -- resuming by run id ------------------------------------------------------


async def test_active_run_id_is_set_while_running_and_null_after(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        running = (await client.get(f"/conversations/{conversation_id}")).json()
        run_id = await _active_run_id(services, conversation_id)
        gate.set()
        await live
        finished = (await client.get(f"/conversations/{conversation_id}")).json()
    assert running["active_run_id"] == str(run_id)
    assert finished["active_run_id"] is None


async def test_stream_by_run_id_replays_a_finished_run(
    db: Database, settings: AssistantSettings
) -> None:
    """The run ended between the client's GET and its resume: the answer still arrives."""
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        run_id = await _only_run(db, conversation_id)
        by_id = await client.get(
            f"/conversations/{conversation_id}/stream",
            params={"run_id": str(run_id)},
        )
        without = await client.get(f"/conversations/{conversation_id}/stream")
    assert without.status_code == 204
    assert by_id.status_code == 200
    assert _chunks(by_id.text) == _chunks(live.text)
    assert _chunks(by_id.text)[-1] == {"type": "finish"}
    assert by_id.text.endswith("data: [DONE]\n\n")


async def test_stream_run_id_of_another_conversation_is_404(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        first_id = await _new_conversation(client)
        second_id = await _new_conversation(client)
        await client.post(f"/conversations/{first_id}/runs", json=RUN)
        run_id = await _only_run(db, first_id)
        foreign = await client.get(
            f"/conversations/{second_id}/stream", params={"run_id": str(run_id)}
        )
        unknown = await client.get(
            f"/conversations/{second_id}/stream", params={"run_id": str(UUID(int=9))}
        )
    assert foreign.status_code == 404
    assert unknown.status_code == 404


async def test_stream_with_nonzero_after_sends_only_the_tail(
    db: Database, settings: AssistantSettings
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        run_id = await _only_run(db, conversation_id)
        events = await services.repo.list_events(run_id)
        after = events[2][0]
        resumed = await client.get(
            f"/conversations/{conversation_id}/stream",
            params={"run_id": str(run_id), "after": after},
        )
    encoder = AiSdkEncoder()
    expected = [
        chunk for seq, event in events if seq > after for chunk in encoder.encode(event)
    ]
    assert _chunks(resumed.text) == expected
    assert resumed.text.endswith("data: [DONE]\n\n")


async def test_stream_past_the_end_of_a_finished_run_still_terminates(
    db: Database, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.05)
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        run_id = await _only_run(db, conversation_id)
        resumed = await asyncio.wait_for(
            client.get(
                f"/conversations/{conversation_id}/stream",
                params={"run_id": str(run_id), "after": 10_000},
            ),
            WAIT,
        )
    assert _chunks(resumed.text) == [{"type": "finish"}]
    assert resumed.text.endswith("data: [DONE]\n\n")


async def test_a_run_ended_without_a_stored_end_replays_its_code(
    db: Database, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The end event is gone (its owner died after folding the message): the
    stream rebuilds the end from the run row and takes the code from the folded
    message, so the dock sees the same status part as on a live stream."""
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.05)
    short = settings.model_copy(update={"run_max_seconds": 0})
    gate = asyncio.Event()
    async with (
        _services(db, short, lambda _: _gated_agent(gate)) as services,
        _client(short, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        run_id = await _only_run(db, conversation_id)
        await db.pool.execute(
            f"DELETE FROM {db.t('run_event')} WHERE run_id = $1 AND type = 'run_ended'",
            run_id,
        )
        resumed = await asyncio.wait_for(
            client.get(
                f"/conversations/{conversation_id}/stream",
                params={"run_id": str(run_id), "after": 10_000},
            ),
            WAIT,
        )
    assert _chunks(resumed.text) == [
        {
            "type": "data-run-status",
            "data": {
                "status": "failed",
                "error": "The run took longer than allowed.",
                "code": "run_timeout",
            },
        },
        {"type": "error", "errorText": "The run took longer than allowed."},
    ]


# -- lost and repeated live messages -------------------------------------------


def _is_run_ended(message: dict[str, Any]) -> bool:
    return bool(message["event"]["type"] == "run_ended")


async def test_stream_ends_when_the_final_event_never_arrives_live(
    db: Database,
    settings: AssistantSettings,
    gate: Gate,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.1)
    bus = FlakyBus(drop=_is_run_ended)
    async with (
        _services(db, settings, _gated(gate), bus) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        gate.set()
        response = await asyncio.wait_for(live, WAIT)
        replay = await client.get(
            f"/conversations/{conversation_id}/stream",
            params={"run_id": str(await _only_run(db, conversation_id))},
        )
    assert bus.dropped == 1
    assert _chunks(response.text)[-1] == {"type": "finish"}
    assert response.text.endswith("data: [DONE]\n\n")
    assert _chunks(response.text) == _chunks(replay.text)


async def _only_run(db: Database, conversation_id: str) -> UUID:
    row = await db.pool.fetchrow(
        f"SELECT id FROM {db.t('run')} WHERE conversation_id = $1",
        UUID(conversation_id),
    )
    assert row is not None
    return UUID(str(row["id"]))


async def test_stream_aborts_when_the_run_is_deleted_underneath_it(
    db: Database,
    settings: AssistantSettings,
    gate: Gate,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Another replica deleted the conversation: the cascade took the run and its events."""
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.1)
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        run_id = await _only_run(db, conversation_id)
        resumed = asyncio.create_task(
            client.get(f"/conversations/{conversation_id}/stream")
        )
        assert isinstance(services.bus, InMemoryEventBus)
        await _until(lambda: _subscribers(services.bus, run_id) == 2)  # type: ignore[arg-type]
        await db.pool.execute(
            f"DELETE FROM {db.t('conversation')} WHERE id = $1", UUID(conversation_id)
        )
        response = await asyncio.wait_for(resumed, WAIT)
        gate.set()
        await live
    assert _chunks(response.text)[-1] == {"type": "abort"}
    assert response.text.endswith("data: [DONE]\n\n")


async def test_repeated_live_messages_are_sent_once(
    db: Database, settings: AssistantSettings
) -> None:
    bus = FlakyBus()
    bus.repeat = True
    async with (
        _services(db, settings, bus=bus) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = await client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        replay = await client.get(
            f"/conversations/{conversation_id}/stream",
            params={"run_id": str(await _only_run(db, conversation_id))},
        )
    assert _chunks(live.text) == _chunks(replay.text)


async def test_missed_live_message_is_filled_from_the_database(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    def is_second_word(message: dict[str, Any]) -> bool:
        return bool(message["event"].get("delta") == "second")

    bus = FlakyBus(drop=is_second_word)
    async with (
        _services(db, settings, _gated(gate), bus) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live_task = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        run_id = await _active_run_id(services, conversation_id)
        await _until(lambda: _subscribers(bus.inner, run_id) == 1)
        gate.set()
        live = await asyncio.wait_for(live_task, WAIT)
        replay = await client.get(
            f"/conversations/{conversation_id}/stream", params={"run_id": str(run_id)}
        )
    assert bus.dropped == 1
    chunks = _chunks(live.text)
    deltas = "".join(str(c["delta"]) for c in chunks if c["type"] == "text-delta")
    assert deltas == "first second"
    assert chunks == _chunks(replay.text)


# -- cleanup -------------------------------------------------------------------


async def test_cancelled_consumer_releases_its_subscription(
    db: Database, settings: AssistantSettings, gate: Gate
) -> None:
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        assert isinstance(services.bus, InMemoryEventBus)
        bus = services.bus
        conversation_id = await _new_conversation(client)
        consumer = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        run_id = await _active_run_id(services, conversation_id)
        await _until(lambda: _subscribers(bus, run_id) == 1)
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer
        await _until(lambda: events_channel(run_id) not in bus._queues)
        # The run is detached from its consumer and still completes.
        gate.set()
        await _until(lambda: _run_is_over(db, run_id))
    detail = await services.repo.get_run(run_id)
    assert detail is not None
    assert detail["status"] == "succeeded"


async def _run_is_over(db: Database, run_id: UUID) -> bool:
    status = await db.pool.fetchval(
        f"SELECT status FROM {db.t('run')} WHERE id = $1", run_id
    )
    return status not in ("queued", "running")


async def test_response_closes_its_body_when_sending_fails() -> None:
    """A write that fails leaves the generator suspended at its yield; the response
    still closes it."""
    closed = asyncio.Event()

    async def body() -> AsyncIterator[str]:
        try:
            yield "data: {}\n\n"
            yield "data: {}\n\n"
        finally:
            closed.set()

    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()
        return {}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body":
            raise OSError("client went away")

    response = conversations._sse_response(body())
    with pytest.raises(BaseException):  # noqa: B017, PT011
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert closed.is_set()


# -- service lifecycle -----------------------------------------------------------


async def test_failed_start_closes_the_bus_and_the_database(
    settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    closed: list[str] = []
    real_db_close = Database.close
    real_bus_close = InMemoryEventBus.close

    async def start(self: RunManager) -> None:
        raise RuntimeError("listener failed")

    async def db_close(self: Database) -> None:
        closed.append("db")
        await real_db_close(self)

    async def bus_close(self: InMemoryEventBus) -> None:
        closed.append("bus")
        await real_bus_close(self)

    monkeypatch.setattr(RunManager, "start", start)
    monkeypatch.setattr(Database, "close", db_close)
    monkeypatch.setattr(InMemoryEventBus, "close", bus_close)
    with pytest.raises(RuntimeError, match="listener failed"):
        await app_module._build_services(settings)
    assert closed == ["bus", "db"]


async def test_failing_stop_still_closes_the_bus_and_the_database(
    db: Database, settings: AssistantSettings
) -> None:
    closed: list[str] = []

    class Runs:
        async def stop(self) -> None:
            raise RuntimeError("stop failed")

    class Bus:
        async def close(self) -> None:
            closed.append("bus")

    class Db:
        async def close(self) -> None:
            closed.append("db")

    services = AppServices(db=Db(), repo=Repository(db), bus=Bus(), runs=Runs())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="stop failed"):
        await app_module._close_services(services)
    assert closed == ["bus", "db"]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/conversations/{id}/runs",
            {
                "message": {
                    "id": "u1",
                    "text": "x" * (conversations.MAX_MESSAGE_CHARS + 1),
                }
            },
        ),
        (
            "/conversations/{id}/runs",
            {
                "message": {"id": "u1", "text": "go"},
                "context": {"blob": "x" * conversations.MAX_CONTEXT_BYTES},
            },
        ),
    ],
)
async def test_oversized_run_body_is_422(
    db: Database, settings: AssistantSettings, path: str, body: dict[str, Any]
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        response = await client.post(path.format(id=conversation_id), json=body)
    assert response.status_code == 422


async def test_run_body_at_the_limits_is_accepted(
    db: Database, settings: AssistantSettings
) -> None:
    # A valid catalog context just under the size cap: 79 facet values of 200
    # characters, then one value that takes up the rest (its quotes and the
    # separator before it are 4 bytes).
    facets = {f"f{i}": ["v" * 200] * 20 for i in range(4)}
    facets["f3"] = facets["f3"][:19]
    context: dict[str, Any] = {"surface": "catalog", "facets": facets}
    room = conversations.MAX_CONTEXT_BYTES - len(json.dumps(context).encode()) - 4
    assert 0 < room <= 200
    facets["f3"].append("w" * room)
    size = len(json.dumps(context).encode())
    assert (
        conversations.MAX_CONTEXT_BYTES - 64 <= size <= conversations.MAX_CONTEXT_BYTES
    )
    body = {
        "message": {"id": "u1", "text": "x" * conversations.MAX_MESSAGE_CHARS},
        "context": context,
    }
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        response = await client.post(
            f"/conversations/{conversation_id}/runs", json=body
        )
    assert response.status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"origin_surface": "s" * (conversations.MAX_ORIGIN_SURFACE_CHARS + 1)},
        {
            "origin_surface": "catalog",
            "title": "t" * (conversations.MAX_TITLE_CHARS + 1),
        },
    ],
)
async def test_oversized_conversation_fields_are_422(
    db: Database, settings: AssistantSettings, body: dict[str, Any]
) -> None:
    async with (
        _services(db, settings) as services,
        _client(settings, services) as client,
    ):
        response = await client.post("/conversations", json=body)
    assert response.status_code == 422


async def test_synthesized_end_carries_the_run_error(
    db: Database,
    settings: AssistantSettings,
    gate: Gate,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The run finished (failed) but its RunEnded was never stored: the stream
    still reports why."""
    monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.05)
    async with (
        _services(db, settings, _gated(gate)) as services,
        _client(settings, services) as client,
    ):
        conversation_id = await _new_conversation(client)
        live = asyncio.create_task(
            client.post(f"/conversations/{conversation_id}/runs", json=RUN)
        )
        await gate.at_first_token()
        run_id = await _only_run(db, conversation_id)
        await db.pool.execute(
            f"UPDATE {db.t('run')} SET status = 'failed', error = 'model unreachable' "
            "WHERE id = $1",
            run_id,
        )
        response = await asyncio.wait_for(
            client.get(
                f"/conversations/{conversation_id}/stream",
                params={"run_id": str(run_id)},
            ),
            WAIT,
        )
        gate.set()
        await live
    assert _chunks(response.text)[-1] == {
        "type": "error",
        "errorText": "model unreachable",
    }
