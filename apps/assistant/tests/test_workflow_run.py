"""workflow_run and workflow_last_run (spec 2026-10-23 §3, §4, §5)."""

import asyncio
import copy
import dataclasses
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import AskHistory, AskUserInput, CardAnswer
from assistant.clock import AnswerClock
from assistant.context import parse_context
from assistant.tools import workflow_runs
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.runtime import ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env
from assistant.tools.workflow_runs import (
    ASK_FIRST,
    CREATED_HERE_BUT,
    JOBS_UNAVAILABLE,
    LAST_RUN,
    NO_RUN,
    NO_TIME,
    NOT_CREATED_HERE,
    NOT_IN_PROJECT,
    OVERWRITES,
    REPLACES_USERS_RUN,
    RUN,
    UNNAMED_LATEST,
    UNNAMED_RUNNING,
)
from assistant.tools.workflow_tools import clear_description_cache
from assistant.workflows.runs import ConversationRuns

PROJECT = "00000000-0000-0000-0000-0000000005e4"
PAGE = parse_context({"surface": "project.workflows", "project_id": PROJECT})
WF = "0b6f0000-0000-0000-0000-00000000f10f"
FOLDER = "0f000000-0000-0000-0000-000000000001"
RESULT_LAYER = "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8"
CONFIG: dict[str, Any] = {
    "nodes": [
        {
            "id": "dataset-a",
            "type": "dataset",
            "data": {"type": "dataset", "label": "Praxen"},
        },
        {
            "id": "tool-walk",
            "type": "tool",
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "15 Minuten zu Fuß",
            },
        },
        {
            "id": "export-save",
            "type": "export",
            "data": {
                "type": "export",
                "label": "Save as dataset",
                "datasetName": "Einwohner je Band",
            },
        },
    ],
    "edges": [{"id": "e1", "source": "tool-walk", "target": "export-save"}],
    "variables": [
        {"id": "v1", "name": "minutes", "type": "number", "defaultValue": 15}
    ],
}


def _job(status: str, job_id: str = "j1", **extra: Any) -> dict[str, Any]:
    return {
        "jobID": job_id,
        "processID": "workflow_runner",
        "status": status,
        "inputs": {"workflow_id": WF},
        "created": "2026-10-23T08:41:30Z",
        "started": "2026-10-23T08:41:31Z",
        **extra,
    }


DONE = _job(
    "successful",
    result={
        "status": "success",
        "node_results": {
            "tool-walk": {"status": "success", "feature_count": 3},
            "export-save": {
                "layer_id": RESULT_LAYER,
                "layer_name": "Einwohner je Band",
                "layer_project_id": 80487,
                "feature_count": 3,
            },
        },
    },
)
RUNNING = _job("running", node_status={"tool-walk": {"status": "running"}})
QUERYABLES = {
    "properties": {
        "name": {"type": "string"},
        "einwohner": {"type": "integer"},
        "geometry": {"$ref": "#/geometry"},
    }
}


DESCRIPTIONS: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "process_descriptions.json").read_text(
        encoding="utf-8"
    )
)["descriptions"]


@pytest.fixture(autouse=True)
def _fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.0)
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 0.0)


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_description_cache()
    yield
    clear_description_cache()


def _services(
    *,
    jobs: Any = None,
    statuses: list[Any] | None = None,
    execute_answer: Any = None,
    queryables: Any = QUERYABLES,
) -> tuple[Recorder, Recorder, Recorder]:
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
    answers = list(statuses or [DONE])

    def status(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=answers.pop(0) if len(answers) > 1 else answers[0]
        )

    processes = Recorder(
        {
            ("GET", "/jobs"): jobs if jobs is not None else {"jobs": []},
            ("POST", f"/workflows/{WF}/execute"): execute_answer
            if execute_answer is not None
            else {"job_id": "j1", "workflow_id": WF, "status": "submitted"},
            ("GET", "/jobs/j1"): status,
            ("DELETE", "/jobs/j1"): {"status": "dismissed"},
        }
    )
    geoapi = Recorder({("GET", f"/collections/{RESULT_LAYER}/queryables"): queryables})
    return core, processes, geoapi


def _env(
    services: tuple[Recorder, Recorder, Recorder],
    *,
    runs: ConversationRuns | None = None,
    asks: AskHistory | None = None,
    emitted: list[tuple[str, str | None, dict[str, Any]]] | None = None,
    clock: AnswerClock | None = None,
) -> ToolEnv:
    core, processes, geoapi = services

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        if emitted is not None:
            emitted.append((name, part_id, data))
        return part_id or "p"

    env = tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi),
        page=PAGE,
        emit_data=emit,
        locale="de",
    )
    return dataclasses.replace(
        env, runs=runs or ConversationRuns(), asks=asks or AskHistory(), clock=clock
    )


def _picked_run(card_id: str = "ask-c1") -> AskHistory:
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Jetzt ausführen?",
                    "header": "Ausführen",
                    "options": [
                        {
                            "label": "Run",
                            "description": "Startet ihn.",
                            "value": f"run:{WF}",
                        },
                        {
                            "label": "Not now",
                            "description": "Lässt ihn.",
                            "value": "no",
                        },
                    ],
                }
            ]
        }
    )
    answer = CardAnswer.model_validate(
        {"card_id": card_id, "answers": [{"question": 0, "options": [0]}]}
    )
    return AskHistory(cards={card_id: card}, answers={card_id: answer})


def _methods(recorder: Recorder) -> list[str]:
    return [f"{r.method} {r.url.path}" for r in recorder.requests]


async def test_a_workflow_built_here_runs_at_once_and_reports_what_it_saved() -> None:
    services = _services()
    emitted: list[tuple[str, str | None, dict[str, Any]]] = []
    runs = ConversationRuns(created={WF})
    out = await execute(
        RUN, _env(services, runs=runs, emitted=emitted), {"workflow_id": WF}
    )
    core, processes, geoapi = services
    assert out["status"] == "succeeded"
    assert [(s["name"], s["layer_project_id"], s["rows"]) for s in out["saved"]] == [
        ("Einwohner je Band", 80487, 3)
    ]
    assert [f["name"] for f in out["saved"][0]["fields"]] == ["name", "einwohner"]
    [execute_request] = [r for r in processes.requests if r.method == "POST"]
    assert execute_request.headers["accept-language"] == "de"
    assert processes.bodies()[processes.requests.index(execute_request)] == {
        "project_id": PROJECT,
        "folder_id": FOLDER,
        "nodes": CONFIG["nodes"],
        "edges": CONFIG["edges"],
        "variables": CONFIG["variables"],
    }
    assert runs.started == {"j1"}
    assert emitted[0][:2] == ("workflow-run", "workflow-run:j1")
    assert emitted[0][2]["started"] is True and emitted[0][2]["status"] == "running"
    assert emitted[-1][2]["status"] == "succeeded"


async def test_a_workflow_from_elsewhere_asks_first_and_starts_nothing() -> None:
    services = _services()
    with pytest.raises(ToolFailed) as refused:
        await execute(RUN, _env(services), {"workflow_id": WF})
    assert refused.value.message == ASK_FIRST.format(
        reason=NOT_CREATED_HERE, value=f"run:{WF}"
    )
    assert "POST /workflows" not in " ".join(_methods(services[1]))


async def test_a_pick_of_run_allows_one_run() -> None:
    """Review Focus 5: the next answer may not reuse the same pick."""
    asks = _picked_run()
    runs = ConversationRuns()
    out = await execute(
        RUN, _env(_services(), runs=runs, asks=asks), {"workflow_id": WF}
    )
    assert out["status"] == "succeeded"
    assert runs.used_cards == {"ask-c1"}
    later = _services(jobs={"jobs": [DONE]})
    with pytest.raises(ToolFailed):
        await execute(RUN, _env(later, runs=runs, asks=asks), {"workflow_id": WF})


async def test_every_part_of_a_run_carries_the_pick_it_used() -> None:
    """A workflow built here runs without a card, but a Run pick the user also
    gave is used up by it, and every part of the run says so: a later part
    replaces an earlier one wholesale (fold_parts)."""
    emitted: list[tuple[str, str | None, dict[str, Any]]] = []
    runs = ConversationRuns(created={WF})
    env = _env(_services(), runs=runs, asks=_picked_run(), emitted=emitted)
    out = await execute(RUN, env, {"workflow_id": WF})
    assert out["status"] == "succeeded"
    assert runs.used_cards == {"ask-c1"}
    assert len(emitted) >= 2
    assert {
        (part_id, part["card_id"], part["started"]) for _, part_id, part in emitted
    } == {("workflow-run:j1", "ask-c1", True)}


async def test_a_run_of_the_users_needs_a_card() -> None:
    services = _services(jobs={"jobs": [_job("successful", job_id="theirs")]})
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env(services, runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    assert refused.value.message == ASK_FIRST.format(
        reason=CREATED_HERE_BUT.format(effects=REPLACES_USERS_RUN),
        value=f"run:{WF}",
    )
    assert _posts(services) == 0


def _overwriting(services: tuple[Recorder, Recorder, Recorder]) -> None:
    """The stored workflow's export overwrites the layer it saved before."""
    nodes = [
        node
        if node["id"] != "export-save"
        else {**node, "data": {**node["data"], "overwritePrevious": True}}
        for node in CONFIG["nodes"]
    ]
    services[0].routes[("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}")] = {
        "id": WF,
        "project_id": PROJECT,
        "config": {**CONFIG, "nodes": nodes},
    }


async def test_an_overwriting_export_needs_a_card_that_says_so() -> None:
    services = _services()
    _overwriting(services)
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env(services, runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    assert refused.value.message == ASK_FIRST.format(
        reason=CREATED_HERE_BUT.format(effects=OVERWRITES), value=f"run:{WF}"
    )
    assert _posts(services) == 0


async def test_a_card_names_both_effects_when_both_hold() -> None:
    services = _services(jobs={"jobs": [_job("successful", job_id="theirs")]})
    _overwriting(services)
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env(services, runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    effects = f"{REPLACES_USERS_RUN}, and {OVERWRITES}"
    assert refused.value.message == ASK_FIRST.format(
        reason=CREATED_HERE_BUT.format(effects=effects), value=f"run:{WF}"
    )


async def test_a_running_job_is_waited_for_not_started_again() -> None:
    services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING, DONE])
    emitted: list[tuple[str, str | None, dict[str, Any]]] = []
    out = await execute(
        RUN, _env(services, emitted=emitted, clock=None), {"workflow_id": WF}
    )
    # Without a clock the tool reads the status once and hands back what it saw.
    assert out["status"] == "running"
    assert not any(r.method == "POST" for r in services[1].requests)
    assert all(part["started"] is False for _, _, part in emitted)


async def test_a_wait_on_a_run_already_going_uses_up_the_pick() -> None:
    """The pick asked for a run, and waiting on the one going answers it: it
    allows no later run."""
    services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING])
    emitted: list[tuple[str, str | None, dict[str, Any]]] = []
    runs = ConversationRuns()
    asks = _picked_run()
    out = await execute(
        RUN, _env(services, runs=runs, asks=asks, emitted=emitted), {"workflow_id": WF}
    )
    assert out["status"] == "running"
    assert runs.used_cards == {"ask-c1"}
    assert emitted and all(
        (part["card_id"], part["started"]) == ("ask-c1", False)
        for _, _, part in emitted
    )
    later = _services(jobs={"jobs": [DONE]})
    with pytest.raises(ToolFailed):
        await execute(RUN, _env(later, runs=runs, asks=asks), {"workflow_id": WF})
    assert _posts(services) == 0 and _posts(later) == 0


async def test_an_active_run_that_names_no_workflow_starts_nothing() -> None:
    """processes leaves a job's inputs out when it could not read its details:
    the run could be this workflow's, so none is started (fail closed)."""
    unnamed = {k: v for k, v in RUNNING.items() if k != "inputs"} | {"jobID": "x"}
    services = _services(jobs={"jobs": [unnamed]})
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env(services, runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    assert refused.value.message == UNNAMED_RUNNING
    assert _posts(services) == 0
    with pytest.raises(ToolFailed) as unread:
        await execute(LAST_RUN, _env(services), {"workflow_id": WF})
    assert unread.value.message == UNNAMED_LATEST


async def test_a_finished_run_that_names_no_workflow_is_ignored() -> None:
    finished = {k: v for k, v in DONE.items() if k != "inputs"} | {"jobID": "x"}
    services = _services(jobs={"jobs": [finished]})
    out = await execute(
        RUN, _env(services, runs=ConversationRuns(created={WF})), {"workflow_id": WF}
    )
    assert out["status"] == "succeeded" and _posts(services) == 1


@pytest.mark.parametrize(
    ("wait_max", "started"),
    [
        pytest.param(0.5, False, id="too little time left"),
        pytest.param(120, True, id="time left once the clock is extended"),
    ],
)
async def test_a_run_starts_only_with_time_left_to_wait_for_it(
    monkeypatch: pytest.MonkeyPatch, wait_max: float, started: bool
) -> None:
    """A run started in the answer's last seconds would be cancelled by the
    answer's deadline at once; the wait's extension counts."""
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 59.0)
    services = _services()
    runs = ConversationRuns()
    clock = AnswerClock(wait_max_seconds=wait_max)
    async with asyncio.timeout(0.5) as deadline:
        clock.timeout = deadline
        env = _env(services, runs=runs, asks=_picked_run(), clock=clock)
        if started:
            out = await execute(RUN, env, {"workflow_id": WF})
            assert out["status"] == "succeeded"
        else:
            with pytest.raises(ToolFailed) as refused:
                await execute(RUN, env, {"workflow_id": WF})
            assert refused.value.message == NO_TIME
    assert _posts(services) == (1 if started else 0)
    # A run not started leaves the pick for the next answer.
    assert runs.used_cards == ({"ask-c1"} if started else set())


async def test_the_wait_follows_the_run_until_it_ends() -> None:
    services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING, RUNNING, DONE])
    clock = AnswerClock(wait_max_seconds=60)
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        out = await execute(RUN, _env(services, clock=clock), {"workflow_id": WF})
    assert out["status"] == "succeeded"
    assert _methods(services[1]).count("GET /jobs/j1") == 3


async def test_the_wait_ends_in_time_for_the_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 59.9)
    services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING])
    clock = AnswerClock(wait_max_seconds=60)
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        out = await execute(RUN, _env(services, clock=clock), {"workflow_id": WF})
    assert out["status"] == "running"
    assert "workflow_last_run" in out["note"]


async def test_a_refused_run_returns_its_issues() -> None:
    refusal = httpx.Response(
        422,
        json={
            "detail": {
                "message": "The workflow has issues.",
                "issues": [{"message": "Walk: bad band edges."}],
            }
        },
    )
    services = _services(execute_answer=refusal)
    out = await execute(
        RUN, _env(services, runs=ConversationRuns(created={WF})), {"workflow_id": WF}
    )
    assert out["status"] == "refused" and out["issues"] == ["Walk: bad band edges."]


async def test_a_refused_run_uses_up_the_pick_that_allowed_it() -> None:
    """One pick, one run: a run processes refused used the pick too, and its
    part records that for the next answers."""
    refusal = httpx.Response(
        422,
        json={
            "detail": {
                "message": "The workflow has issues.",
                "issues": [{"message": "Walk: bad band edges."}],
            }
        },
    )
    services = _services(execute_answer=refusal)
    emitted: list[tuple[str, str | None, dict[str, Any]]] = []
    runs = ConversationRuns()
    asks = _picked_run()
    out = await execute(
        RUN, _env(services, runs=runs, asks=asks, emitted=emitted), {"workflow_id": WF}
    )
    assert out["status"] == "refused"
    assert runs.used_cards == {"ask-c1"}
    assert emitted == [
        (
            "workflow-run",
            f"workflow-run:refused:{WF}",
            {
                "workflow_id": WF,
                "project_id": PROJECT,
                "job_id": None,
                "status": "refused",
                "started": False,
                "card_id": "ask-c1",
                "done": 0,
                "total": 2,
                "step": None,
                "started_at": None,
                "saved": 0,
            },
        )
    ]
    assert ConversationRuns.from_stored(
        [
            {
                "role": "assistant",
                "parts": [
                    {"type": "data", "name": name, "id": part_id, "data": data}
                    for name, part_id, data in emitted
                ],
            }
        ]
    ) == ConversationRuns(used_cards={"ask-c1"})
    with pytest.raises(ToolFailed):
        await execute(RUN, _env(services, runs=runs, asks=asks), {"workflow_id": WF})
    assert _posts(services) == 1


async def test_a_run_is_not_started_when_the_job_list_cannot_be_read() -> None:
    """Review Focus 1: fail closed."""
    services = _services(jobs=httpx.Response(503, json={"detail": "down"}))
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env(services, runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    assert refused.value.message == JOBS_UNAVAILABLE
    assert not any(r.method == "POST" for r in services[1].requests)


async def test_a_workflow_outside_the_open_project_is_refused() -> None:
    core, processes, geoapi = _services()
    core.routes[("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}")] = httpx.Response(
        404, json={"detail": "nope"}
    )
    with pytest.raises(ToolFailed) as refused:
        await execute(
            RUN,
            _env((core, processes, geoapi), runs=ConversationRuns(created={WF})),
            {"workflow_id": WF},
        )
    assert refused.value.message == NOT_IN_PROJECT


async def test_a_removed_saved_layer_is_listed_without_fields() -> None:
    """Review Focus 3."""
    services = _services(queryables=httpx.Response(404, json={"detail": "gone"}))
    out = await execute(
        RUN, _env(services, runs=ConversationRuns(created={WF})), {"workflow_id": WF}
    )
    assert out["status"] == "succeeded"
    assert "fields" not in out["saved"][0]


async def _cancelled(env: ToolEnv, started: asyncio.Event) -> None:
    task = asyncio.create_task(execute(RUN, env, {"workflow_id": WF}))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.05)


async def test_stop_cancels_the_run_the_tool_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.01)
    services = _services(statuses=[RUNNING])
    started = asyncio.Event()
    clock = AnswerClock(wait_max_seconds=60)

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        started.set()
        return part_id or "p"

    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = dataclasses.replace(
            _env(services, runs=ConversationRuns(created={WF}), clock=clock),
            emit_data=emit,
        )
        await _cancelled(env, started)
    assert "DELETE /jobs/j1" in _methods(services[1])


async def test_stop_leaves_a_run_the_tool_only_waited_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.01)
    services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING])
    started = asyncio.Event()
    clock = AnswerClock(wait_max_seconds=60)

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        started.set()
        return part_id or "p"

    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = dataclasses.replace(_env(services, clock=clock), emit_data=emit)
        await _cancelled(env, started)
    assert "DELETE /jobs/j1" not in _methods(services[1])


async def test_stop_after_the_run_finished_cancels_nothing() -> None:
    """Review Focus 2: Stop while the summary reads the saved layers."""
    reading = asyncio.Event()

    async def slow(request: httpx.Request) -> httpx.Response:
        reading.set()
        await asyncio.sleep(10)
        return httpx.Response(200, json=QUERYABLES)

    services = _services(queryables=slow)
    env = _env(services, runs=ConversationRuns(created={WF}))
    await _cancelled(env, reading)
    assert "DELETE /jobs/j1" not in _methods(services[1])


async def test_stop_while_the_started_part_is_sent_cancels_the_run() -> None:
    """In the app the part waits for a lock, an insert and a publish: a Stop
    there comes after the POST and before the wait."""
    services = _services(statuses=[RUNNING])
    sending = asyncio.Event()
    parts: list[dict[str, Any]] = []

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        parts.append(data)
        sending.set()
        await asyncio.sleep(10)
        return part_id or "p"

    env = dataclasses.replace(
        _env(services, runs=ConversationRuns(created={WF})), emit_data=emit
    )
    await _cancelled(env, sending)
    [part] = parts
    assert (part["status"], part["started"], part["done"]) == ("running", True, 0)
    assert "GET /jobs/j1" not in _methods(services[1])
    assert "DELETE /jobs/j1" in _methods(services[1])


async def test_stop_before_the_run_started_cancels_nothing() -> None:
    reading = asyncio.Event()

    async def slow(request: httpx.Request) -> httpx.Response:
        reading.set()
        await asyncio.sleep(10)
        return httpx.Response(200, json={"jobs": []})

    services = _services(jobs=slow)
    await _cancelled(_env(services, runs=ConversationRuns(created={WF})), reading)
    assert not any(r.method in ("POST", "DELETE") for r in services[1].requests)


@pytest.mark.parametrize("cancelled_while", ["sending the started part", "waiting"])
async def test_a_shutdown_leaves_the_run_going(
    monkeypatch: pytest.MonkeyPatch, cancelled_while: str
) -> None:
    """Spec §5 Restart: a replica that shuts down ends the answer, not the run;
    workflow_last_run reads it in the next answer."""
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.01)
    services = _services(statuses=[RUNNING])
    reached = asyncio.Event()
    clock = AnswerClock(wait_max_seconds=60)

    async def emit(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        reached.set()
        if cancelled_while == "sending the started part":
            await asyncio.sleep(10)
        return part_id or "p"

    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = dataclasses.replace(
            _env(services, runs=ConversationRuns(created={WF}), clock=clock),
            emit_data=emit,
            stopping=lambda: True,
        )
        await _cancelled(env, reached)
    assert "POST" in [r.method for r in services[1].requests]
    assert "DELETE /jobs/j1" not in _methods(services[1])


def _status_failing(
    services: tuple[Recorder, Recorder, Recorder],
    *,
    times: int | None,
    reading: asyncio.Event | None = None,
) -> None:
    """``GET /jobs/j1`` answers 503 ``times`` times (always with None), then DONE."""
    calls = 0

    def status(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if reading is not None:
            reading.set()
        if times is None or calls <= times:
            return httpx.Response(503, json={"detail": "down"})
        return httpx.Response(200, json=DONE)

    services[1].routes[("GET", "/jobs/j1")] = status


def _posts(services: tuple[Recorder, Recorder, Recorder]) -> int:
    return [r.method for r in services[1].requests].count("POST")


async def test_fields_that_cannot_be_read_leave_the_run_succeeded() -> None:
    """A failure after the POST must not fail the call: the retry that failure
    allows would start the finished workflow again."""
    services = _services(queryables=httpx.Response(503, json={"detail": "down"}))
    env = _env(services, runs=ConversationRuns(created={WF}))
    out = await execute(RUN, env, {"workflow_id": WF})
    assert out["status"] == "succeeded"
    assert "fields" not in out["saved"][0]
    assert _posts(services) == 1


async def test_a_status_read_that_fails_once_does_not_end_the_wait() -> None:
    services = _services()
    _status_failing(services, times=1)
    clock = AnswerClock(wait_max_seconds=60)
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = _env(services, runs=ConversationRuns(created={WF}), clock=clock)
        out = await execute(RUN, env, {"workflow_id": WF})
    assert out["status"] == "succeeded"
    assert _methods(services[1]).count("GET /jobs/j1") == 2
    assert _posts(services) == 1


@pytest.mark.parametrize("with_clock", [True, False])
async def test_a_status_that_cannot_be_read_ends_the_wait_as_running(
    monkeypatch: pytest.MonkeyPatch, with_clock: bool
) -> None:
    monkeypatch.setattr(workflow_runs, "ANSWER_RESERVE_SECONDS", 59.9)
    services = _services()
    _status_failing(services, times=None)
    clock = AnswerClock(wait_max_seconds=60) if with_clock else None
    async with asyncio.timeout(60) as deadline:
        if clock is not None:
            clock.timeout = deadline
        env = _env(services, runs=ConversationRuns(created={WF}), clock=clock)
        out = await execute(RUN, env, {"workflow_id": WF})
    assert (out["status"], out["job_id"]) == ("running", "j1")
    assert [(s["name"], s["status"]) for s in out["steps"]] == [
        ("15 Minuten zu Fuß", "pending"),
        ("Save as dataset", "pending"),
    ]
    assert "workflow_last_run" in out["note"]
    reads = _methods(services[1]).count("GET /jobs/j1")
    assert reads > 1 if with_clock else reads == 1
    assert _posts(services) == 1


async def test_a_status_read_that_cannot_succeed_ends_the_wait_at_once() -> None:
    """Only a failing service is read again: a 404 (or a sign-in the service
    refuses) would answer the same until the wait's time runs out."""
    services = _services()
    services[1].routes[("GET", "/jobs/j1")] = httpx.Response(
        404, json={"detail": "no such job"}
    )
    clock = AnswerClock(wait_max_seconds=60)
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = _env(services, runs=ConversationRuns(created={WF}), clock=clock)
        out = await execute(RUN, env, {"workflow_id": WF})
    assert (out["status"], out["job_id"]) == ("running", "j1")
    assert {s["status"] for s in out["steps"]} == {"pending"}
    assert _methods(services[1]).count("GET /jobs/j1") == 1
    assert _posts(services) == 1
    assert "DELETE /jobs/j1" not in _methods(services[1])


async def test_stop_while_the_status_cannot_be_read_cancels_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.01)
    services = _services()
    reading = asyncio.Event()
    _status_failing(services, times=None, reading=reading)
    clock = AnswerClock(wait_max_seconds=60)
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        env = _env(services, runs=ConversationRuns(created={WF}), clock=clock)
        await _cancelled(env, reading)
    assert "DELETE /jobs/j1" in _methods(services[1])


async def test_last_run_reads_the_latest_run_without_starting_one() -> None:
    services = _services(jobs={"jobs": [DONE]})
    out = await execute(LAST_RUN, _env(services), {"workflow_id": WF})
    assert out["status"] == "succeeded" and out["job_id"] == "j1"
    assert not any(r.method in ("POST", "DELETE") for r in services[1].requests)


async def test_a_summary_states_each_tool_steps_settings() -> None:
    """The method as it ran, so the answer can state it exactly: the tool
    step's settings, its variables resolved; none for the export step."""
    core, processes, geoapi = _services(jobs={"jobs": [DONE]})
    config = copy.deepcopy(CONFIG)
    config["nodes"][1]["data"]["config"] = {
        "routing_mode": "walking",
        "max_cost": "{{@minutes}}",
        "speed": 5,
    }
    core.routes[("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}")] = {
        "id": WF,
        "project_id": PROJECT,
        "config": config,
    }
    out = await execute(LAST_RUN, _env((core, processes, geoapi)), {"workflow_id": WF})
    walk, save = out["steps"]
    assert walk["tool"] == "catchment_area_v2"
    assert walk["settings"] == {"routing_mode": "walking", "max_cost": 15, "speed": 5}
    assert "settings" not in save
    assert "state the method exactly" in RUN.description


async def test_last_run_without_a_run_says_so() -> None:
    with pytest.raises(ToolFailed) as refused:
        await execute(LAST_RUN, _env(_services()), {"workflow_id": WF})
    assert refused.value.message == NO_RUN


@pytest.mark.parametrize(
    ("status", "expires_in", "message"),
    [
        (401, -60, SIGN_IN_EXPIRED),
        # Core answers 401 also when its authorization denies the request.
        (401, 300, NOT_IN_PROJECT),
        (403, 300, NOT_IN_PROJECT),
    ],
)
async def test_last_run_names_an_expired_sign_in(
    status: int, expires_in: float, message: str
) -> None:
    """A 401 for an expired sign-in is no missing workflow: the model must not
    say it does not exist."""
    core, processes, geoapi = _services(jobs={"jobs": [DONE]})
    core.routes[("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}")] = httpx.Response(
        status, json={"detail": "x"}
    )
    env = dataclasses.replace(
        _env((core, processes, geoapi)), login=signed_in(expires_in)
    )
    with pytest.raises(ToolFailed) as refused:
        await execute(LAST_RUN, env, {"workflow_id": WF})
    assert refused.value.message == message


def _three_tools() -> dict[str, Any]:
    """A walk and a transit catchment, both left at most defaults, and an
    aggregation whose settings have no static default."""
    config = copy.deepcopy(CONFIG)
    walk = config["nodes"][1]
    walk["data"]["config"] = {"routing_mode": "walking", "max_cost": "{{@minutes}}"}
    transit = copy.deepcopy(walk)
    transit["id"] = "tool-pt"
    transit["data"]["config"] = {"routing_mode": "pt", "max_cost": 30, "steps": 3}
    count = {
        "id": "tool-sum",
        "type": "tool",
        "data": {
            "type": "tool",
            "processId": "aggregate_points",
            "label": "Einwohner",
            "config": {"area_type": "polygon"},
        },
    }
    config["nodes"][2:2] = [transit, count]
    return config


def _described(
    services: tuple[Recorder, Recorder, Recorder],
    config: dict[str, Any],
    answers: dict[str, Any] | None = None,
) -> None:
    core, processes, _ = services
    core.routes[("GET", f"/api/v2/project/{PROJECT}/workflow/{WF}")] = {
        "id": WF,
        "project_id": PROJECT,
        "config": config,
    }
    for tool_id in ("catchment_area_v2", "aggregate_points"):
        answer = (answers or {}).get(tool_id, DESCRIPTIONS[tool_id])
        processes.routes[("GET", f"/processes/{tool_id}")] = answer


def _description_reads(processes: Recorder) -> list[str]:
    return [path for path in processes.paths() if path.startswith("/processes/")]


async def test_a_summary_lists_what_each_step_left_at_its_default() -> None:
    services = _services(jobs={"jobs": [DONE]})
    _described(services, _three_tools())
    out = await execute(LAST_RUN, _env(services), {"workflow_id": WF})
    walk, transit, count, save = out["steps"]
    assert walk["settings"] == {"routing_mode": "walking", "max_cost": 15}
    assert walk["defaults"]["shape_style"] == "combined"
    assert walk["defaults"]["steps"] == 5
    assert not any(name.startswith("pt_") for name in walk["defaults"])
    assert transit["defaults"]["pt_start_time"] == "07:00"
    assert transit["defaults"]["pt_end_time"] == "09:00"
    assert "steps" not in transit["defaults"]
    assert "defaults" not in count and "defaults" not in save
    assert sorted(_description_reads(services[1])) == [
        "/processes/aggregate_points",
        "/processes/catchment_area_v2",
    ]
    assert "left at the tool's default" in RUN.description
    assert "workflow_describe_tool" in RUN.description


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500, json={"detail": "x"}),
        httpx.Response(404, json={"detail": "x"}),
        {"not": "a description"},
    ],
)
async def test_a_description_that_cannot_be_read_leaves_its_defaults_out(
    answer: Any,
) -> None:
    services = _services(jobs={"jobs": [DONE]})
    _described(services, _three_tools(), {"catchment_area_v2": answer})
    out = await execute(LAST_RUN, _env(services), {"workflow_id": WF})
    walk, transit, _, _ = out["steps"]
    assert out["status"] == "succeeded"
    assert walk["settings"] == {"routing_mode": "walking", "max_cost": 15}
    assert "defaults" not in walk and "defaults" not in transit


class _Overlap(httpx.AsyncBaseTransport):
    """Answers as ``recorder`` does, holding each description read for a
    moment, and counts how many are read at once."""

    def __init__(self, recorder: Recorder) -> None:
        self.recorder = recorder
        self.reading = 0
        self.most = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        if request.url.path.startswith("/processes/"):
            self.reading += 1
            self.most = max(self.most, self.reading)
            await asyncio.sleep(0.01)
            self.reading -= 1
        return self.recorder(request)


async def test_a_run_reads_each_tools_description_once_and_at_once() -> None:
    """Two steps of one tool and one of another: two reads, side by side,
    before the first status, and none on the later polls."""
    core, processes, geoapi = _services(statuses=[RUNNING, RUNNING, DONE])
    _described((core, processes, geoapi), _three_tools())
    overlap = _Overlap(processes)
    clock = AnswerClock(wait_max_seconds=60)
    env = dataclasses.replace(
        tool_env(
            fake_clients(core=core, processes=overlap, geoapi=geoapi),
            page=PAGE,
            locale="de",
        ),
        runs=ConversationRuns(created={WF}),
        asks=AskHistory(),
        clock=clock,
    )
    async with asyncio.timeout(60) as deadline:
        clock.timeout = deadline
        out = await execute(RUN, env, {"workflow_id": WF})
    assert out["status"] == "succeeded"
    assert processes.paths().count("/jobs/j1") == 3
    assert out["steps"][1]["defaults"]["pt_day"] == "weekday"
    assert len(_description_reads(processes)) == 2 and overlap.most == 2
    first_status = processes.paths().index("/jobs/j1")
    assert all(
        processes.paths().index(path) < first_status
        for path in _description_reads(processes)
    )
