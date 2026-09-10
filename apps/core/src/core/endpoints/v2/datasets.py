from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from core.core.config import settings
from core.deps.auth import auth_z
from core.endpoints.deps import get_user_id
from core.schemas.datasets import DatasetImportRequest, PresignedUploadResponse
from core.services.s3 import s3_service
from core.utils import sanitize_filename

router = APIRouter()


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
