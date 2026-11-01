"""A failed workflow run reports each step's own error in its job status.

The runner returns its result with `status: "failed"` and the steps' errors
instead of raising, so Windmill records the run as a success. processes
reports it as failed, lists `node_errors` (step id -> message, never the
stack, at most 500 characters), keeps the result with the steps' raw errors
out of its answers, and reads a failed child job's message while the run is
still going.
"""

import copy
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

import processes.routers.processes as processes_router
from processes.deps.auth import get_user_id
from processes.main import app
from processes.models.processes import StatusCode
from processes.routers.processes import _windmill_job_to_status_info
from processes.services.windmill_client import WindmillClient

BASE = "http://processes.test"
USER = "8f19467a-6287-4563-8905-588c3a736f39"
RUN_ID = "01a0538a-d853-19e5-e97f-cfdd4d119e10"
STACK = 'File "/venv/lib/python3.11/site-packages/goatlib/tools/clip.py", line 88'

FAILED_RUN: dict[str, Any] = {
    "id": RUN_ID,
    "script_path": "f/goat/tools/workflow_runner",
    "created_at": "2026-10-15T10:00:00Z",
    "running": False,
    "success": True,
    "args": {"user_id": USER, "workflow_id": "w-1"},
    "result": {
        "status": "failed",
        "node_results": {
            "n-buffer": {"temp_layer_id": "w-1:n-buffer:abc"},
            "n-clip": {
                "error": {
                    "name": "ValueError",
                    "message": "Column 'name' not found",
                    "stack": STACK,
                }
            },
        },
        "errors": [{"node_id": "n-clip", "message": "Column 'name' not found"}],
        "node_jobs": {"n-buffer": "job-buffer", "n-clip": "job-clip"},
    },
}
BUFFER_JOB: dict[str, Any] = {
    "id": "job-buffer-alone",
    "script_path": "f/goat/tools/buffer",
    "created_at": "2026-10-15T09:00:00Z",
    "running": False,
    "success": True,
    "args": {"user_id": USER},
    "result": {"layer_id": "90e3bcb2-d7ec-4abf-955d-50633ab4a101"},
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_user_id] = lambda: UUID(USER)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_user_id, None)


# --- Mapping a Windmill job to its status -----------------------------------


def test_a_run_that_returned_step_errors_is_failed() -> None:
    info = _windmill_job_to_status_info(copy.deepcopy(FAILED_RUN), BASE)

    assert info.status == StatusCode.failed
    assert info.node_errors == {"n-clip": "Column 'name' not found"}
    # The step's own message; the step is named by node_errors.
    assert info.message == "Column 'name' not found"


def test_a_failed_step_of_a_running_run_is_reported_at_once() -> None:
    running = {
        **copy.deepcopy(FAILED_RUN),
        "running": True,
        "success": None,
        "result": None,
        "node_status": {
            "n-buffer": {"status": "completed"},
            "n-clip": {"status": "failed", "error": "Column 'name' not found"},
        },
    }

    info = _windmill_job_to_status_info(running, BASE)

    assert info.status == StatusCode.running
    assert info.node_errors == {"n-clip": "Column 'name' not found"}


def test_a_long_step_error_is_cut_and_carries_no_stack() -> None:
    job = copy.deepcopy(FAILED_RUN)
    job["result"]["errors"] = [
        {
            "node_id": "n-clip",
            "error": {"name": "ValueError", "message": "y" * 2000, "stack": STACK},
        }
    ]

    info = _windmill_job_to_status_info(job, BASE)

    assert info.node_errors is not None
    assert len(info.node_errors["n-clip"]) == 500
    assert "site-packages" not in info.model_dump_json()


def test_a_successful_run_has_no_step_errors() -> None:
    job = copy.deepcopy(FAILED_RUN)
    job["result"] = {"status": "success", "node_results": {}, "errors": []}

    info = _windmill_job_to_status_info(job, BASE)

    assert info.status == StatusCode.successful
    assert info.node_errors is None


# --- The job routes ----------------------------------------------------------


def test_the_job_list_reports_a_failed_run_with_its_step_errors(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    listed = AsyncMock(
        return_value=[copy.deepcopy(FAILED_RUN), copy.deepcopy(BUFFER_JOB)]
    )
    monkeypatch.setattr(processes_router.windmill_client, "list_jobs_filtered", listed)

    response = client.get("/jobs")

    assert response.status_code == 200, response.text
    run, buffer = response.json()["jobs"]
    assert run["status"] == "failed"
    assert run["node_errors"] == {"n-clip": "Column 'name' not found"}
    # A failed run's result holds its steps' raw errors, stacks included.
    assert run["result"] is None
    assert "site-packages" not in response.text
    assert buffer["status"] == "successful"
    assert buffer["result"] == BUFFER_JOB["result"]
    assert buffer["node_errors"] is None


@pytest.mark.parametrize(
    ("wanted", "asked_success", "listed_ids"),
    [
        ("failed", None, [RUN_ID]),
        ("successful", True, ["job-buffer-alone"]),
    ],
)
def test_a_status_filter_follows_the_reported_status(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    wanted: str,
    asked_success: bool | None,
    listed_ids: list[str],
) -> None:
    """Windmill counts a failed run as a success, so `failed` is not passed
    on to it; every job is filtered by the status processes reports."""
    listed = AsyncMock(
        return_value=[copy.deepcopy(FAILED_RUN), copy.deepcopy(BUFFER_JOB)]
    )
    monkeypatch.setattr(processes_router.windmill_client, "list_jobs_filtered", listed)

    response = client.get("/jobs", params={"status": wanted})

    assert response.status_code == 200, response.text
    assert [job["jobID"] for job in response.json()["jobs"]] == listed_ids
    assert listed.await_args.kwargs["success"] is asked_success


def test_a_single_job_reports_the_step_errors_too(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        processes_router.windmill_client,
        "get_job_with_result",
        AsyncMock(return_value=copy.deepcopy(FAILED_RUN)),
    )

    response = client.get(f"/jobs/{RUN_ID}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "failed"
    assert body["node_errors"] == {"n-clip": "Column 'name' not found"}
    assert body["result"] is None


@pytest.mark.parametrize(
    ("job", "said"),
    [
        (FAILED_RUN, "Column 'name' not found"),
        (
            {
                **BUFFER_JOB,
                "success": False,
                "result": {
                    "error": {
                        "name": "ValueError",
                        "message": "distances must be set",
                        "stack": STACK,
                    }
                },
            },
            "ValueError: distances must be set",
        ),
    ],
)
def test_the_results_of_a_failed_job_name_the_error_not_the_stack(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    job: dict[str, Any],
    said: str,
) -> None:
    monkeypatch.setattr(
        processes_router.windmill_client,
        "get_job_status",
        AsyncMock(return_value=copy.deepcopy(job)),
    )

    response = client.get(f"/jobs/{job['id']}/results")

    assert response.status_code == 500, response.text
    assert response.json()["detail"]["detail"] == said
    assert "site-packages" not in response.text


# --- Reading a running run's child jobs --------------------------------------


@pytest.mark.asyncio
async def test_a_running_run_reads_its_failed_child_jobs_message() -> None:
    jobs = {
        RUN_ID: {
            "id": RUN_ID,
            "script_path": "f/goat/tools/workflow_runner",
            "running": True,
            "success": None,
            "args": {"user_id": USER},
        },
        "job-buffer": {
            "id": "job-buffer",
            "running": False,
            "success": True,
            "args": {"node_id": "n-buffer"},
            "result": {"temp_layer_id": "w-1:n-buffer:abc"},
        },
        "job-clip": {
            "id": "job-clip",
            "running": False,
            "success": False,
            "args": {"node_id": "n-clip"},
            "result": {
                "error": {"name": "ValueError", "message": "z" * 2000, "stack": STACK}
            },
        },
    }
    windmill = WindmillClient()
    with patch.object(windmill, "_get_client") as get_client:
        wm = MagicMock()
        wm.get_job.side_effect = lambda job_id: copy.deepcopy(jobs[job_id])
        children = MagicMock()
        children.json.return_value = [{"id": "job-buffer"}, {"id": "job-clip"}]
        wm.client.get.return_value = children
        get_client.return_value = wm

        job = await windmill.get_job_with_result(RUN_ID)

    assert job["node_status"]["n-buffer"] == {
        "status": "completed",
        "temp_layer_id": "w-1:n-buffer:abc",
    }
    assert job["node_status"]["n-clip"] == {
        "status": "failed",
        "error": "z" * 499 + "…",
    }
    assert "site-packages" not in str(job["node_status"])
