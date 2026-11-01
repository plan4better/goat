"""
Report Layout Endpoints
"""

from typing import List
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from pydantic import UUID4

from core.core.revision import CHANGED_ELSEWHERE_RESPONSE
from core.crud.crud_project import project as crud_project
from core.crud.crud_report_layout import report_layout as crud_report_layout
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.report_layout import (
    ReportLayoutCreate,
    ReportLayoutRead,
    ReportLayoutUpdate,
)
from core.schemas.report_layout import (
    request_examples as report_layout_request_examples,
)

router = APIRouter()


@router.get(
    "/{project_id}/report-layout",
    summary="Get all report layouts for a project",
    response_model=List[ReportLayoutRead],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_report_layouts(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> List[ReportLayoutRead]:
    """Get all report layouts for a project."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    layouts = await crud_report_layout.get_by_project(
        async_session, project_id=project_id
    )
    return [ReportLayoutRead.model_validate(layout) for layout in layouts]


@router.get(
    "/{project_id}/report-layout/{layout_id}",
    summary="Get a specific report layout",
    response_model=ReportLayoutRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_report_layout(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_id: UUID4 = Path(
        ...,
        description="The ID of the report layout",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> ReportLayoutRead:
    """Get a specific report layout by ID."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    layout = await crud_report_layout.get_by_project_and_id(
        async_session, project_id=project_id, layout_id=layout_id
    )
    if not layout:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report layout not found",
        )
    return ReportLayoutRead.model_validate(layout)


@router.post(
    "/{project_id}/report-layout",
    summary="Create a new report layout",
    response_model=ReportLayoutRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_report_layout(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_in: ReportLayoutCreate = Body(
        ..., examples=[report_layout_request_examples["create"]]
    ),
) -> ReportLayoutRead:
    """Create a new report layout for a project."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    layout = await crud_report_layout.create_for_project(
        async_session, project_id=project_id, obj_in=layout_in, user_id=user_id
    )
    return ReportLayoutRead.model_validate(layout)


@router.put(
    "/{project_id}/report-layout/{layout_id}",
    summary="Update a report layout",
    response_model=ReportLayoutRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
    responses=CHANGED_ELSEWHERE_RESPONSE,
)
async def update_report_layout(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_id: UUID4 = Path(
        ...,
        description="The ID of the report layout",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_in: ReportLayoutUpdate = Body(
        ..., examples=[report_layout_request_examples["update"]]
    ),
) -> ReportLayoutRead:
    """Update an existing report layout.

    A save that changes the layout raises its `revision` and is refused with
    409 `changed_elsewhere` when `base_revision` is not the stored revision.
    One that changes only the editor's view toggles is saved without either
    (`core.core.revision`).
    """
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    layout = await crud_report_layout.update_for_project(
        async_session,
        project_id=project_id,
        layout_id=layout_id,
        obj_in=layout_in,
        user_id=user_id,
    )
    if not layout:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report layout not found",
        )
    return ReportLayoutRead.model_validate(layout)


@router.delete(
    "/{project_id}/report-layout/{layout_id}",
    summary="Delete a report layout",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_report_layout(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_id: UUID4 = Path(
        ...,
        description="The ID of the report layout",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> None:
    """Delete a report layout."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    deleted = await crud_report_layout.delete_for_project(
        async_session, project_id=project_id, layout_id=layout_id
    )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report layout not found or cannot be deleted",
        )


@router.post(
    "/{project_id}/report-layout/{layout_id}/duplicate",
    summary="Duplicate a report layout",
    response_model=ReportLayoutRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def duplicate_report_layout(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layout_id: UUID4 = Path(
        ...,
        description="The ID of the report layout to duplicate",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    new_name: str | None = Query(
        None,
        description="Name for the duplicated layout (optional)",
    ),
) -> ReportLayoutRead:
    """Duplicate an existing report layout."""
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    layout = await crud_report_layout.duplicate(
        async_session, project_id=project_id, layout_id=layout_id, new_name=new_name
    )
    if not layout:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report layout not found",
        )
    return ReportLayoutRead.model_validate(layout)
