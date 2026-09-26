from uuid import UUID

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
)
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from pydantic import UUID4
from sqlalchemy import select, text

from core.core import authz
from core.core.config import settings
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_project import DEFAULT_INITIAL_VIEW_STATE
from core.crud.crud_project import project as crud_project
from core.crud.crud_project_copy import copy_project as copy_project_fn
from core.crud.crud_space import space as crud_space
from core.crud.crud_user_project import user_project as crud_user_project
from core.db.models._link_model import (
    UserProjectLink,
    UserTeamLink,
)
from core.db.models.folder import Folder
from core.db.models.project import Project
from core.db.models.user import User
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.common import OrderEnum
from core.schemas.error import FolderNotFoundError
from core.schemas.project import (
    InitialViewState,
    IProjectBaseUpdate,
    IProjectCopy,
    IProjectCreate,
    IProjectRead,
)
from core.schemas.project import (
    request_examples as project_request_examples,
)
from core.services.initial_view_state import resolve_initial_view_state

router = APIRouter()


### Project endpoints
@router.post(
    "",
    summary="Create a new project",
    response_model=IProjectRead,
    response_model_exclude_none=True,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_project(
    request: Request,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    *,
    project_in: IProjectCreate = Body(
        ...,
        examples=[project_request_examples["create"]],
        description="Project to create",
    ),
) -> IProjectRead:
    """This will create an empty project. The project does not contain layers.

    A caller that sends no `initial_view_state` gets one chosen for them — see
    `core.services.initial_view_state` for which signals are tried.
    """

    # A target folder must exist, be live, and be writable by the caller —
    # the new project then takes THAT folder's own space (personal, or a
    # team/org space the caller may write to), rather than always landing
    # in the caller's personal space regardless of where folder_id actually
    # points.
    if project_in.folder_id is not None:
        folder = await async_session.get(Folder, project_in.folder_id)
        if folder is None or folder.deleted_at is not None or folder.space_id is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        if not await authz.can(
            async_session, "folder", project_in.folder_id, user_id, "write"
        ):
            # Read access but not write: confirm the folder is there but
            # refuse it (403). No access at all: behave as if it weren't
            # there (404) rather than confirming a totally foreign folder's
            # existence to a caller with no relationship to it.
            if await authz.can(
                async_session, "folder", project_in.folder_id, user_id, "read"
            ):
                raise HTTPException(
                    status_code=403, detail="Not allowed to write this folder"
                )
            raise HTTPException(status_code=404, detail="Folder not found")
        space_id = folder.space_id
    else:
        space_id = (await crud_space.ensure_personal(async_session, user_id)).id

    initial_view_state = await resolve_initial_view_state(
        async_session,
        user_id=user_id,
        requested=project_in.initial_view_state,
        headers=request.headers,
        peer=request.client.host if request.client else None,
    )

    # Create project
    project = await crud_project.create(
        async_session=async_session,
        project_in=Project(
            **project_in.model_dump(exclude_none=True),
            user_id=user_id,
            space_id=space_id,
        ),
        initial_view_state=initial_view_state,
    )

    await async_session.commit()

    return project


@router.get(
    "/{project_id}",
    summary="Retrieve a project by its ID",
    response_model=IProjectRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_project(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> IProjectRead:
    """Retrieve a project by its ID."""

    # Get project (404s if trashed)
    project = await crud_project.get_live_or_404(async_session, project_id)

    # Stamp the caller's own link so Home can order "recent" by what *I*
    # last opened rather than what anyone last edited (H4). A no-op when
    # the caller has no link (e.g. no `user_project` row for this project).
    await async_session.execute(
        text(
            f"UPDATE {settings.SCHEMA}.user_project SET last_opened_at = now() "
            "WHERE project_id = :project_id AND user_id = :user_id"
        ),
        {"project_id": project_id, "user_id": user_id},
    )
    await async_session.commit()

    # Populate owned_by from the project owner
    owner = await async_session.get(User, project.user_id)
    owned_by = (
        {
            "id": str(owner.id),
            "firstname": owner.firstname,
            "lastname": owner.lastname,
            "avatar": owner.avatar,
        }
        if owner
        else None
    )

    my_role = await crud_project.get_my_role(
        async_session, project_id=project_id, user_id=user_id
    )

    return IProjectRead(
        **project.model_dump(),
        owned_by=owned_by,
        my_role=my_role,
        **await crud_project.space_label(async_session, project.space_id),
        personally_owned_layer_count=await crud_project.personally_owned_layer_count(
            async_session, project.id
        ),
        restricted_inherited=await crud_project.restricted_inherited(
            async_session, project
        ),
    )


@router.get(
    "",
    summary="Retrieve a list of projects",
    response_model=Page[IProjectRead],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_projects(
    async_session: AsyncSession = Depends(get_db),
    page_params: PaginationParams = Depends(),
    folder_id: UUID4 | None = Query(None, description="Folder ID"),
    user_id: UUID4 = Depends(get_user_id),
    team_id: UUID | None = Query(
        None,
        description="The ID of the team to get the layers from",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    organization_id: UUID | None = Query(
        None,
        description="The ID of the organization to get the layers from",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    search: str = Query(None, description="Searches the name of the project"),
    order_by: str = Query(
        None,
        description="Specify the column name that should be used to order. You can check the Project model to see which column names exist.",
        examples=["created_at"],
    ),
    order: OrderEnum = Query(
        "descendent",
        description="Specify the order to apply. There are the option ascendent or descendent.",
        examples=["descendent"],
    ),
) -> Page[IProjectRead]:
    """Retrieve a list of projects."""

    # Resolve the user's team memberships and organization for folder-grant checks
    team_ids_result = await async_session.execute(
        select(UserTeamLink.team_id).where(UserTeamLink.user_id == user_id)
    )
    team_ids = [row[0] for row in team_ids_result.all()]
    user_obj = await async_session.get(User, user_id)
    user_organization_id = user_obj.organization_id if user_obj else None

    projects = await crud_project.get_projects(
        async_session=async_session,
        user_id=user_id,
        folder_id=folder_id,
        page_params=page_params,
        search=search,
        order_by=order_by,
        order=order,
        team_id=team_id,
        organization_id=organization_id,
        team_ids=team_ids,
        user_organization_id=user_organization_id,
    )

    return projects


@router.put(
    "/{project_id}",
    response_model=IProjectRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_project(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    project_in: IProjectBaseUpdate = Body(
        ...,
        examples=[project_request_examples["update"]],
        description="Project to update",
    ),
) -> IProjectRead:
    """Update base attributes of a project by its ID."""

    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    if project_in.folder_id is not None:
        current = await crud_project.get(async_session, id=project_id)
        if current is None:
            raise HTTPException(status_code=404, detail="Project not found")
        try:
            await crud_folder.assert_same_space(
                async_session, folder_id=project_in.folder_id, space_id=current.space_id
            )
        except FolderNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Folder not found") from exc
        await authz.require(
            async_session, "folder", project_in.folder_id, user_id, "write"
        )

    # Update project
    project = await crud_project.update_base(
        async_session=async_session,
        id=project_id,
        project=project_in,
    )
    return project


@router.delete(
    "/{project_id}",
    response_model=None,
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> None:
    """Delete a project by its ID (soft delete: sets `deleted_at`)."""

    # Get project (404s if already trashed)
    await crud_project.get_live_or_404(async_session, project_id)

    # Delete project
    await crud_project.delete(db=async_session, id=project_id)
    return


@router.get(
    "/{project_id}/initial-view-state",
    response_model=InitialViewState,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_project_initial_view_state(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> InitialViewState:
    """Retrieve initial view state of a project by its ID."""

    user_projects = await crud_user_project.get_by_multi_keys(
        async_session, keys={"user_id": user_id, "project_id": project_id}
    )
    if user_projects:
        user_project = user_projects[0]
        assert type(user_project) is UserProjectLink
        return InitialViewState(**user_project.initial_view_state)

    # Shared-folder user: no personal row yet — fall back to the owner's view state.
    project = await crud_project.get_live_or_404(async_session, project_id)
    owner_projects = await crud_user_project.get_by_multi_keys(
        async_session, keys={"user_id": project.user_id, "project_id": project_id}
    )
    if owner_projects:
        return InitialViewState(**owner_projects[0].initial_view_state)

    # Neither the requester nor the owner has a row yet (e.g. the owner's row
    # was lost to `ON DELETE CASCADE` when a prior owner was offboarded) —
    # fall back to the same default a fresh project would get, lazily,
    # rather than 404ing on a project the caller can otherwise read.
    return InitialViewState(**DEFAULT_INITIAL_VIEW_STATE)


@router.put(
    "/{project_id}/initial-view-state",
    response_model=InitialViewState,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_project_initial_view_state(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    initial_view_state: InitialViewState = Body(
        ...,
        examples=[project_request_examples["initial_view_state"]],
        description="Initial view state to update",
    ),
) -> InitialViewState:
    """Update initial view state of a project by its ID."""

    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    # Update project
    user_project = await crud_user_project.update_initial_view_state(
        async_session,
        user_id=user_id,
        project_id=project_id,
        initial_view_state=initial_view_state,
    )
    return InitialViewState(**user_project.initial_view_state)


@router.post(
    "/{project_id}/copy",
    response_model=IProjectRead,
    response_model_exclude_none=True,
    status_code=201,
    summary="Copy project",
    dependencies=[Depends(auth_z)],
)
async def copy_project(
    project_id: UUID4 = Path(..., description="Source project ID"),
    body: IProjectCopy = Body(default=None),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> IProjectRead:
    """Create a shallow copy of a project."""
    # 404 if the source project is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    try:
        new_project = await copy_project_fn(
            async_session,
            project_id=project_id,
            user_id=user_id,
            target_folder_id=body.folder_id if body else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FolderNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return IProjectRead(
        **new_project.model_dump(),
        **await crud_project.space_label(async_session, new_project.space_id),
        personally_owned_layer_count=await crud_project.personally_owned_layer_count(
            async_session, new_project.id
        ),
    )
