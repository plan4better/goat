from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams

from core.core.config import settings
from core.crud.crud_datasets import datasets as crud_datasets
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.bundle import DatasetContentTile
from core.schemas.common import OrderEnum
from core.schemas.datasets import DatasetImportRequest, PresignedUploadResponse
from core.schemas.error import HTTPErrorHandler
from core.schemas.layer import ILayerGet
from core.services.s3 import s3_service
from core.utils import sanitize_filename

router = APIRouter()


@router.post(
    "",
    summary="List datasets — layers and bundles combined",
    description=(
        "Return the caller's datasets as one paginated, sorted result: layers "
        "and bundles unified into a single content-tile shape "
        "(discriminated by `content_type`). Member layers of a bundle are "
        "hidden — the bundle is surfaced instead."
    ),
    response_model=Page[DatasetContentTile],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_datasets(
    async_session: AsyncSession = Depends(get_db),
    page_params: PaginationParams = Depends(),
    user_id: UUID = Depends(get_user_id),
    obj_in: ILayerGet = Body(None, description="Dataset filters"),
    team_id: UUID | None = Query(
        None, description="List datasets shared with this team"
    ),
    organization_id: UUID | None = Query(
        None, description="List datasets shared with this organization"
    ),
    order_by: str = Query(
        None, description="Column to sort by (e.g. name, created_at, updated_at)"
    ),
    order: OrderEnum = Query("descendent", description="ascendent or descendent"),
) -> Page:
    """List layers and bundles merged into one paginated tile result."""
    with HTTPErrorHandler():
        if team_id is not None and organization_id is not None:
            raise ValueError("Only one of team_id and organization_id can be set.")
        return await crud_datasets.list_content(
            async_session=async_session,
            user_id=user_id,
            params=obj_in,
            order_by=order_by,
            order=order,
            page_params=page_params,
            team_id=team_id,
            organization_id=organization_id,
        )


@router.post(
    "/request-upload",
    summary="Request S3 upload URL",
    description="Generate a presigned S3 PUT for a dataset import.",
    response_model=PresignedUploadResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def request_upload(
    body: DatasetImportRequest,
    user_id: UUID = Depends(get_user_id),
) -> PresignedUploadResponse:
    if body.file_size > settings.MAX_UPLOAD_DATASET_FILE_SIZE:
        raise HTTPException(
            400,
            detail=f"Dataset file too large. Limit is {settings.MAX_UPLOAD_DATASET_FILE_SIZE//1024//1024} MB.",
        )

    filename = sanitize_filename(body.filename)
    s3_key = s3_service.build_s3_key(
        settings.S3_BUCKET_PATH, "users", str(user_id), "imports", "uploads", filename
    )

    presigned = s3_service.generate_presigned_put(
        bucket_name=settings.S3_BUCKET_NAME,
        s3_key=s3_key,
        content_type=body.content_type,
        expires_in=600,  # 10 min expiry
    )

    return presigned
