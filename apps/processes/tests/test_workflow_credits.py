"""A workflow runs tools, so an organization out of credits cannot start one
either: the same 402 as a single tool, before anything reaches Windmill."""

from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import HTTPException

from processes.routers.workflows import WorkflowExecuteRequest, execute_workflow

USER = UUID("00000000-0000-0000-0000-000000000001")
WORKFLOW = "00000000-0000-0000-0000-000000000004"


@pytest.mark.asyncio
async def test_a_workflow_is_refused_without_credits() -> None:
    request = WorkflowExecuteRequest(
        project_id="00000000-0000-0000-0000-000000000002",
        folder_id="00000000-0000-0000-0000-000000000003",
        nodes=[],
        edges=[],
    )
    refused = HTTPException(status_code=402, detail="out of credits")
    run = AsyncMock(return_value="job-1")
    with (
        patch(
            "processes.routers.workflows.ensure_workflow_allowed",
            AsyncMock(return_value=None),
        ),
        patch(
            "processes.services.credit_gate.assert_credits_available",
            AsyncMock(side_effect=refused),
        ),
        patch("processes.routers.workflows.windmill_client.run_script_async", run),
        pytest.raises(HTTPException) as caught,
    ):
        await execute_workflow(WORKFLOW, request, user_id=USER, access_token="tok")

    assert caught.value.status_code == 402
    run.assert_not_awaited()
