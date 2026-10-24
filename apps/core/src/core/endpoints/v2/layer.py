# Standard Libraries
from datetime import datetime, timezone
from typing import Any, Dict
from uuid import UUID

# Third-party Libraries
from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Path,
    Query,
    status,
)
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from pydantic import UUID4, BaseModel
from sqlalchemy import select, text
from sqlmodel import SQLModel

# Local application imports
from core.core import authz
from core.core.config import settings
from core.core.content import (
    read_content_by_id,
)
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_layer import layer as crud_layer
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import BundleLayerLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.user import User
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.common import OrderEnum
from core.schemas.error import FolderNotFoundError, HTTPErrorHandler
from core.schemas.layer import (
    ILayerGet,
    ILayerRead,
    IRasterCreate,
    IRasterLayerRead,
)
from core.schemas.layer import (
    request_examples as layer_request_examples,
)

router = APIRouter()


@router.post(
    "/raster",
    summary="Create a new raster layer",
    response_model=IRasterLayerRead,
    status_code=201,
    description="Generate a new layer based on a URL for a raster service hosted externally.",
    dependencies=[Depends(auth_z)],
)
async def create_layer_raster(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    layer_in: IRasterCreate = Body(
        ...,
        examples=[layer_request_examples["create"]],
        description="Layer to create",
    ),
) -> BaseModel:
    """Create a new raster layer from a service hosted externally."""

    # The layer takes its folder's own space, as a new project does: pinning
    # it to the caller's personal space refused every team folder with a 404.
    # Outside HTTPErrorHandler below: it would turn these HTTPExceptions into
    # a 500.
    if layer_in.folder_id is not None:
        folder = await async_session.get(Folder, layer_in.folder_id)
        if folder is None or folder.deleted_at is not None or folder.space_id is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        if not await authz.can(
            async_session, "folder", layer_in.folder_id, user_id, "write"
        ):
            # Readable but not writable: 403. Not even readable: as if absent.
            if await authz.can(
                async_session, "folder", layer_in.folder_id, user_id, "read"
            ):
                raise HTTPException(
                    status_code=403, detail="Not allowed to write this folder"
                )
            raise HTTPException(status_code=404, detail="Folder not found")
        space_id = folder.space_id
    else:
        space_id = (await crud_space.ensure_personal(async_session, user_id)).id

    with HTTPErrorHandler():
        layer = IRasterLayerRead(
            **(
                await crud_layer.create(
                    db=async_session,
                    obj_in=Layer(
                        **layer_in.model_dump(), user_id=user_id, space_id=space_id
                    ).model_dump(),
                )
            ).model_dump()
        )
    return layer


class LayerWriteAccess(BaseModel):
    """Whether the caller may edit a layer's rows."""

    can_write: bool


@router.get(
    "/{layer_id}/write-access",
    summary="Whether the caller may edit a layer",
    response_model=LayerWriteAccess,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_layer_write_access(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    layer_id: UUID4 = Path(..., description="The ID of the layer"),
) -> LayerWriteAccess:
    """Whether the caller may edit the layer (``layer_write_allowed``). The
    workflow's "Save as dataset" warns with it before a run."""
    result = await async_session.execute(
        text(f"SELECT {settings.SCHEMA}.layer_write_allowed(:layer, :user)"),
        {"layer": layer_id, "user": user_id},
    )
    return LayerWriteAccess(can_write=bool(result.scalar()))


@router.get(
    "/{layer_id}",
    summary="Retrieve a layer by its ID",
    response_model=ILayerRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_layer(
    async_session: AsyncSession = Depends(get_db),
    layer_id: UUID4 = Path(
        ...,
        description="The ID of the layer to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> ILayerRead:
    """Retrieve a layer by its ID."""
    layer = await read_content_by_id(
        async_session=async_session, id=layer_id, model=Layer, crud_content=crud_layer
    )

    # The owner, as the listing endpoint reports it. A catalog layer has no
    # user_id, so it keeps `owned_by` None.
    owner = (
        await async_session.get(User, layer.user_id)
        if getattr(layer, "user_id", None)
        else None
    )
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

    return ILayerRead.model_validate({**layer.model_dump(), "owned_by": owned_by})


@router.post(
    "",
    response_model=Page[ILayerRead],
    response_model_exclude_none=True,
    status_code=200,
    summary="Retrieve a list of layers using different filters including a spatial filter. If not filter is specified, all layers will be returned.",
    dependencies=[Depends(auth_z)],
)
async def read_layers(
    async_session: AsyncSession = Depends(get_db),
    page_params: PaginationParams = Depends(),
    user_id: UUID4 = Depends(get_user_id),
    obj_in: ILayerGet = Body(
        None,
        description="Layer to get",
    ),
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
    order_by: str = Query(
        None,
        description="Specify the column name that should be used to order. You can check the Layer model to see which column names exist.",
        examples=["created_at"],
    ),
    order: OrderEnum = Query(
        "descendent",
        description="Specify the order to apply. There are the option ascendent or descendent.",
        examples=["descendent"],
    ),
) -> Page:
    """This endpoints returns a list of layers based one the specified filters."""

    with HTTPErrorHandler():
        # Make sure that team_id and organization_id are not both set
        if team_id is not None and organization_id is not None:
            raise ValueError("Only one of team_id and organization_id can be set.")

        # Get layers from CRUD
        layers = await crud_layer.get_layers_with_filter(
            async_session=async_session,
            user_id=user_id,
            params=obj_in,
            order_by=order_by,
            order=order,
            page_params=page_params,
            team_id=team_id,
            organization_id=organization_id,
        )

    return layers


@router.put(
    "/{layer_id}",
    response_model=ILayerRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_layer(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    layer_id: UUID4 = Path(
        ...,
        description="The ID of the layer to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layer_in: Dict[Any, Any] = Body(
        ..., examples=[layer_request_examples["update"]], description="Layer to update"
    ),
) -> ILayerRead:
    # `public_read` opens the dataset to every signed-in user in every
    # organization: an owner's decision. Editors may write the data and even
    # share it inside their own circle, but not open it to everyone.
    if "public_read" in layer_in:
        role = await authz.effective_role(async_session, "layer", layer_id, user_id)
        if role != "owner":
            raise HTTPException(
                status_code=403, detail="Only the owner may change public_read"
            )
    target_folder_id = layer_in.get("folder_id")
    if target_folder_id is not None:
        # Outside HTTPErrorHandler below: authz.require raises HTTPException
        # directly, which HTTPErrorHandler does not know how to map and
        # would otherwise turn into a 500.
        layer = await crud_layer.get(async_session, id=layer_id)
        if layer is None:
            raise HTTPException(status_code=404, detail="Layer not found")
        try:
            await crud_folder.assert_same_space(
                async_session,
                folder_id=UUID(str(target_folder_id)),
                space_id=layer.space_id,
            )
        except FolderNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        await authz.require(
            async_session, "folder", UUID(str(target_folder_id)), user_id, "write"
        )

    with HTTPErrorHandler():
        result: SQLModel = await crud_layer.update(
            async_session=async_session,
            id=layer_id,
            layer_in=layer_in,
        )

    return result


@router.delete(
    "/{layer_id}",
    summary="Delete a layer",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_layer(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    layer_id: UUID4 = Path(
        ...,
        description="The ID of the layer to delete",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> None:
    """Soft delete a layer: sets `deleted_at` — the row, its grants
    and its DuckLake data stay untouched until the trash retention window
    expires and the purge task removes them. A layer that belongs to a
    bundle must be deleted through the bundle instead (refused here with
    409) so the bundle stays together.
    """
    await authz.require(async_session, "layer", layer_id, user_id, "delete")

    is_bundle_member = (
        await async_session.execute(
            select(BundleLayerLink.id)
            .where(BundleLayerLink.layer_id == layer_id)
            .limit(1)
        )
    ).first() is not None
    if is_bundle_member:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This layer belongs to a bundle — delete the bundle instead",
        )

    layer = await crud_layer.get(async_session, id=layer_id)
    if layer is None or layer.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found"
        )

    layer.deleted_at = datetime.now(timezone.utc)
    async_session.add(layer)
    await async_session.commit()
    return None
