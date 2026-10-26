"""
Workflow Endpoints
"""

from typing import List
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from goatlib.workflows.checks import shape_issues
from pydantic import UUID4

from core.core.revision import CHANGED_ELSEWHERE_RESPONSE
from core.crud.crud_project import project as crud_project
from core.crud.crud_workflow import workflow as crud_workflow
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.workflow import (
    WorkflowCreate,
    WorkflowRead,
    WorkflowUpdate,
)
from core.schemas.workflow import (
    request_examples as workflow_request_examples,
)

router = APIRouter()


def _refuse_damaged(config: object) -> None:
    """422 with the issues when `config` cannot be read as a workflow.

    Only the shape is checked: an incomplete workflow (a step without its
    input, a missing setting) is saved as it is, since workflows are built
    step by step.
    """
    issues = shape_issues(config)
    if issues:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": "The workflow is damaged.",
                "issues": [issue.to_dict() for issue in issues],
            },
        )


@router.get(
    "/{project_id}/workflow",
    summary="Get all workflows for a project",
    response_model=List[WorkflowRead],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_workflows(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> List[WorkflowRead]:
    """Get all workflows for a project."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    workflows = await crud_workflow.get_by_project(async_session, project_id=project_id)
    return [WorkflowRead.model_validate(w) for w in workflows]


@router.get(
    "/{project_id}/workflow/{workflow_id}",
    summary="Get a specific workflow",
    response_model=WorkflowRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_workflow(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_id: UUID4 = Path(
        ...,
        description="The ID of the workflow",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> WorkflowRead:
    """Get a specific workflow by ID."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    wf = await crud_workflow.get_by_project_and_id(
        async_session, project_id=project_id, workflow_id=workflow_id
    )
    if not wf:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )
    return WorkflowRead.model_validate(wf)


@router.post(
    "/{project_id}/workflow",
    summary="Create a new workflow",
    response_model=WorkflowRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_workflow(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_in: WorkflowCreate = Body(
        ..., examples=[workflow_request_examples["create"]]
    ),
) -> WorkflowRead:
    """Create a new workflow for a project."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)
    _refuse_damaged(workflow_in.config)

    wf = await crud_workflow.create_for_project(
        async_session, project_id=project_id, obj_in=workflow_in, user_id=user_id
    )
    return WorkflowRead.model_validate(wf)


@router.put(
    "/{project_id}/workflow/{workflow_id}",
    summary="Update a workflow",
    response_model=WorkflowRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
    responses=CHANGED_ELSEWHERE_RESPONSE,
)
async def update_workflow(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_id: UUID4 = Path(
        ...,
        description="The ID of the workflow",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_in: WorkflowUpdate = Body(
        ..., examples=[workflow_request_examples["update"]]
    ),
) -> WorkflowRead:
    """Update an existing workflow.

    A save that changes the workflow raises its `revision` and is refused with
    409 `changed_elsewhere` when `base_revision` is not the stored revision.
    One that changes only the viewport, selection or run state is saved
    without either (`core.core.revision`).
    """
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)
    # A request without `config` (a rename) keeps the stored one; an explicit
    # `"config": null` would replace it, so it is checked like any config.
    if "config" in workflow_in.model_fields_set:
        _refuse_damaged(workflow_in.config)

    wf = await crud_workflow.update_for_project(
        async_session,
        project_id=project_id,
        workflow_id=workflow_id,
        obj_in=workflow_in,
        user_id=user_id,
    )
    if not wf:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )
    return WorkflowRead.model_validate(wf)


@router.delete(
    "/{project_id}/workflow/{workflow_id}",
    summary="Delete a workflow",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_workflow(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_id: UUID4 = Path(
        ...,
        description="The ID of the workflow",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> None:
    """Delete a workflow."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    deleted = await crud_workflow.delete_for_project(
        async_session, project_id=project_id, workflow_id=workflow_id
    )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )


@router.post(
    "/{project_id}/workflow/{workflow_id}/duplicate",
    summary="Duplicate a workflow",
    response_model=WorkflowRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def duplicate_workflow(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    workflow_id: UUID4 = Path(
        ...,
        description="The ID of the workflow to duplicate",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    new_name: str | None = Query(
        None,
        description="Name for the duplicated workflow",
        max_length=255,
    ),
) -> WorkflowRead:
    """Duplicate a workflow."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    wf = await crud_workflow.duplicate(
        async_session, project_id=project_id, workflow_id=workflow_id, new_name=new_name
    )
    if not wf:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workflow not found",
        )
    return WorkflowRead.model_validate(wf)
