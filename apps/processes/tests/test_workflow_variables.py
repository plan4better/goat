"""`/workflows/{id}/execute` hands workflow variables to the runner as sent.

A variable may carry an optional ``label`` and ``description`` for the
editor. The route does not validate a variable's shape; it must accept those
keys and pass them through untouched, so the runner sees what the editor
saved (the runner resolves by ``name`` and ignores the rest).
"""

from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest

from processes.routers.workflows import WorkflowExecuteRequest, execute_workflow

USER = UUID("00000000-0000-0000-0000-000000000001")
PROJECT = "00000000-0000-0000-0000-000000000002"
FOLDER = "00000000-0000-0000-0000-000000000003"
WORKFLOW = "00000000-0000-0000-0000-000000000004"

LABELLED: dict[str, Any] = {
    "name": "max_abstand_gruppierung",
    "label": "Maximaler Abstand",
    "description": "Größter Abstand zwischen zwei Punkten einer Gruppe, in Metern.",
    "type": "number",
    "defaultValue": 250,
}
LEGACY: dict[str, Any] = {"name": "suffix", "type": "string", "defaultValue": "_neu"}


def test_the_request_model_keeps_label_and_description() -> None:
    request = WorkflowExecuteRequest(
        project_id=PROJECT,
        folder_id=FOLDER,
        nodes=[],
        edges=[],
        variables=[LABELLED, LEGACY],
    )
    assert request.variables == [LABELLED, LEGACY]
    assert "label" not in request.variables[1]


@pytest.mark.asyncio
async def test_execute_forwards_the_variables_unchanged() -> None:
    request = WorkflowExecuteRequest(
        project_id=PROJECT,
        folder_id=FOLDER,
        nodes=[],
        edges=[],
        variables=[LABELLED, LEGACY],
    )
    run = AsyncMock(return_value="job-1")
    with (
        patch(
            "processes.routers.workflows.check_workflow",
            AsyncMock(return_value=[]),
        ),
        patch("processes.routers.workflows.windmill_client.run_script_async", run),
    ):
        response = await execute_workflow(
            WORKFLOW, request, user_id=USER, language="en"
        )

    assert response.job_id == "job-1"
    args = run.await_args.kwargs["args"]
    assert args["variables"] == [LABELLED, LEGACY]
