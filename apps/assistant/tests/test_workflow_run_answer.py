"""A whole answer that waits for a workflow run (spec 2026-10-23 §5): the
wait outlasts run_max_seconds only because the run extends the answer's clock,
and the user's Stop cancels the run the answer started while a shutdown of
the replica leaves it going."""

import asyncio
import time
from typing import Any
from uuid import UUID

import httpx
import pytest

from assistant.agent import build_agent
from assistant.asks import AskHistory, CardAnswer, QuestionAnswer
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.events import ToolReturned
from assistant.login import StaticLogin
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools import workflow_runs
from assistant.tools.testing import Recorder, ScriptedModel, TurnModel, fake_clients

USER = UUID(int=1)
PROJECT = "00000000-0000-0000-0000-0000000005e4"
WF = "0b6f0000-0000-0000-0000-00000000f10f"
CONFIG = {
    "nodes": [
        {
            "id": "tool-walk",
            "type": "tool",
            "data": {"type": "tool", "processId": "buffer", "label": "Buffer"},
        }
    ],
    "edges": [],
}


def _job(status: str) -> dict[str, Any]:
    return {
        "jobID": "j1",
        "processID": "workflow_runner",
        "status": status,
        "inputs": {"workflow_id": WF},
        "created": "2026-10-23T08:00:00Z",
    }


async def _waited(repo: Repository, settings: AssistantSettings, wait_max: int) -> str:
    began: list[float] = []

    def status(request: httpx.Request) -> httpx.Response:
        began.append(began[0] if began else time.monotonic())
        done = time.monotonic() - began[0] > 4.5
        return httpx.Response(200, json=_job("successful" if done else "running"))

    core = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}"): {
                "id": WF,
                "project_id": PROJECT,
                "config": CONFIG,
            }
        }
    )
    processes = Recorder(
        {("GET", "/jobs"): {"jobs": [_job("running")]}, ("GET", "/jobs/j1"): status}
    )
    script = ScriptedModel([("workflow_run", {"workflow_id": WF})], answer="Fertig.")
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings.model_copy(
            update={"run_max_seconds": 3, "run_wait_max_seconds": wait_max}
        ),
        owner="a",
        agent_factory=lambda _: build_agent(script.model),
        tool_services=fake_clients(core=core, processes=processes),
    )
    conversation = UUID(
        str(
            (
                await repo.create_conversation(
                    USER, "project.workflows", UUID(PROJECT), None
                )
            )["id"]
        )
    )
    run_id, _ = await manager.start_run(
        conversation,
        USER,
        "Lauf abwarten",
        parse_context({"surface": "project.workflows", "project_id": PROJECT}),
        locale="de",
        login=StaticLogin("token"),
        target=UUID(PROJECT),
    )
    await manager.wait(run_id)
    [returned] = [
        e for _, e in await repo.list_events(run_id) if isinstance(e, ToolReturned)
    ]
    return str(returned.output["status"])


async def test_the_wait_outlasts_run_max_seconds_when_the_clock_extends(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.1)
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 1.0)
    assert await _waited(repo, settings, wait_max=15) == "succeeded"


async def test_without_a_longer_wait_limit_the_wait_ends_early(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.1)
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 1.0)
    assert await _waited(repo, settings, wait_max=3) == "running"


FOLDER = "0f000000-0000-0000-0000-000000000001"
PAGE = parse_context({"surface": "project.workflows", "project_id": PROJECT})
RUN_CARD: dict[str, Any] = {
    "questions": [
        {
            "question": "Jetzt ausführen?",
            "header": "Ausführen",
            "options": [
                {"label": "Run", "description": "Startet ihn.", "value": f"run:{WF}"},
                {"label": "Not now", "description": "Lässt ihn.", "value": "no"},
            ],
        }
    ]
}


async def _waiting_on_its_run(
    repo: Repository, settings: AssistantSettings
) -> tuple[RunManager, UUID, Recorder]:
    """An answer that started a run (the user picked Run in the card before)
    and waits for it; the job never ends. Returned once the status was read
    twice: the run's part is sent after the first read, so no insert of an
    event is in flight when the test stops the answer."""
    polled = asyncio.Event()
    reads: list[float] = []

    def status(request: httpx.Request) -> httpx.Response:
        reads.append(time.monotonic())
        if len(reads) >= 2:
            polled.set()
        return httpx.Response(200, json=_job("running"))

    core = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}"): {
                "id": WF,
                "project_id": PROJECT,
                "config": CONFIG,
            },
            ("GET", f"/api/v2/project/{PROJECT}"): {"id": PROJECT, "folder_id": FOLDER},
        }
    )
    processes = Recorder(
        {
            ("GET", "/jobs"): {"jobs": []},
            ("POST", f"/workflows/{WF}/execute"): {
                "job_id": "j1",
                "status": "submitted",
            },
            ("GET", "/jobs/j1"): status,
            ("DELETE", "/jobs/j1"): {"status": "dismissed"},
        }
    )
    model = TurnModel(
        [
            ([("ask_user", RUN_CARD)], "Soll ich ihn ausführen?"),
            ([("workflow_run", {"workflow_id": WF})], "Fertig."),
        ]
    )
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(model.model),
        tool_services=fake_clients(core=core, processes=processes),
    )
    created = await repo.create_conversation(
        USER, "project.workflows", UUID(PROJECT), None
    )
    conversation = UUID(str(created["id"]))
    login = StaticLogin("token")
    run_id, _ = await manager.start_run(
        conversation, USER, "Lauf starten", PAGE, login=login, target=UUID(PROJECT)
    )
    await manager.wait(run_id)
    [card_id] = AskHistory.from_stored(
        await repo.list_messages(conversation, None)
    ).cards
    answer = CardAnswer(
        card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
    )
    run_id, _ = await manager.start_run(
        conversation,
        USER,
        "Ausführen: Run",
        PAGE,
        login=login,
        target=UUID(PROJECT),
        answer=answer,
    )
    async with asyncio.timeout(10):
        await polled.wait()
    return manager, run_id, processes


def _deleted(processes: Recorder) -> list[str]:
    return [r.url.path for r in processes.requests if r.method == "DELETE"]


async def test_stop_cancels_the_run_the_answer_started(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.05)
    manager, run_id, processes = await _waiting_on_its_run(repo, settings)
    await manager.cancel(run_id)
    await manager.wait(run_id)
    assert _deleted(processes) == ["/jobs/j1"]
    await manager.stop()


async def test_a_shutdown_leaves_the_run_the_answer_started(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.05)
    manager, run_id, processes = await _waiting_on_its_run(repo, settings)
    await manager.stop()
    assert [r.method for r in processes.requests].count("POST") == 1
    assert _deleted(processes) == []


async def test_a_lost_lease_leaves_the_run_the_answer_started(
    repo: Repository, settings: AssistantSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run swept elsewhere ends here at the next heartbeat; only the user's
    Stop cancels the job, so this one goes on."""
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.05)
    fast = settings.model_copy(update={"lease_heartbeat_seconds": 1})
    manager, run_id, processes = await _waiting_on_its_run(repo, fast)
    async with repo.db.pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {repo.db.t('run')} SET lease_expires_at = now() - "
            "interval '1 minute' WHERE id = $1",
            run_id,
        )
    assert await manager.sweep_once() == 1
    async with asyncio.timeout(10):
        await manager.wait(run_id)
    assert [r.method for r in processes.requests].count("POST") == 1
    assert _deleted(processes) == []
    await manager.stop()
