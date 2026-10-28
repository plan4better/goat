import io
import mimetypes
import uuid
from typing import List, Optional
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import RedirectResponse
from pydantic import UUID4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.core import authz
from core.core.config import settings
from core.db.models.asset import AssetType, UploadedAsset
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.asset import AssetRead, AssetUpdate
from core.services.s3 import ASSET_URL_EXPIRES, s3_service

router = APIRouter()

ALLOWED_MIME_TYPES = {
    AssetType.IMAGE: [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/tiff",
        "image/svg+xml",
        "image/x-icon",
    ],
    AssetType.ICON: [
        "image/svg+xml",
        "image/jpeg",
        "image/webp",
        "image/x-icon",
        "image/bmp",
        "image/png",
    ],
    AssetType.DOCUMENT: [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    ],
}

DOCUMENTS_MAX_FILE_SIZE_BYTES: int = settings.DOCUMENTS_MAX_FILE_SIZE


async def _check_folder_access(
    async_session: AsyncSession,
    folder_id: UUID,
    user_id: UUID,
) -> None:
    """Raise 404/403 if the folder doesn't exist or the requesting user has no
    access to it (any grant — viewer or above — is enough; asset placement
    itself is not role-gated beyond that)."""
    await authz.require(async_session, "folder", folder_id, user_id, "read")


@router.get("/file/{key:path}", include_in_schema=False)
async def asset_file(key: str) -> RedirectResponse:
    """An uploaded asset, with ASSETS_SERVED_BY_CORE: a redirect to a
    short-lived signed URL. Public, as an assets bucket would be: public
    projects and dashboards show these images to visitors without a login."""
    parts = key.split("/")
    if not settings.ASSETS_SERVED_BY_CORE or not key or "" in parts or ".." in parts:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    return RedirectResponse(
        s3_service.asset_download_url(key),
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={"Cache-Control": f"public, max-age={ASSET_URL_EXPIRES // 2}"},
    )


@router.get("/{asset_id}/file", include_in_schema=False)
async def asset_file_by_id(
    asset_id: UUID4, async_session: AsyncSession = Depends(get_db)
) -> RedirectResponse:
    """An uploaded icon or image by its id: a redirect to its file. Styles name
    uploaded icons `asset:<id>` (never URLs), so every viewer of a map, public
    ones included, reaches them here; documents stay behind their key."""
    s3_key = (
        await async_session.execute(
            select(UploadedAsset.s3_key).where(
                UploadedAsset.id == asset_id,
                UploadedAsset.asset_type.in_([AssetType.ICON, AssetType.IMAGE]),
            )
        )
    ).scalar_one_or_none()
    if s3_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    return RedirectResponse(
        f"{settings.ASSETS_URL}/{s3_key}",
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={"Cache-Control": f"public, max-age={ASSET_URL_EXPIRES // 2}"},
    )


@router.post(
    "/upload",
    response_model=AssetRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(auth_z)],
)
async def upload_asset(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    file: UploadFile = File(...),
    asset_type: AssetType = Form(...),
    display_name: str | None = Form(None),
    category: str | None = Form(None),
    folder_id: Optional[UUID] = Form(None),
) -> AssetRead:
    """
    Uploads a new asset to S3 and records its metadata in the database.
    - Only allows supported MIME types per asset_type.
    - For `icon` assets, `display_name` is required.
    - For `document` assets, `folder_id` is required.
    """
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No file selected."
        )

    if asset_type == AssetType.ICON and not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'display_name' is required for icon uploads.",
        )

    if asset_type == AssetType.DOCUMENT and not folder_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'folder_id' is required for document uploads.",
        )

    if folder_id:
        await _check_folder_access(async_session, folder_id, user_id)

    # Validate MIME type
    detected_mime_type, _ = mimetypes.guess_type(file.filename)
    actual_mime_type = detected_mime_type or file.content_type
    if actual_mime_type not in ALLOWED_MIME_TYPES.get(asset_type, []):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Invalid file type for asset_type '{asset_type.value}'. "
                f"Allowed types: {', '.join(ALLOWED_MIME_TYPES.get(asset_type, []))}. "
                f"Received: {actual_mime_type}"
            ),
        )

    # Read file + enforce size limit (document limit differs from image limit)
    file_content = await file.read()
    max_size = (
        DOCUMENTS_MAX_FILE_SIZE_BYTES
        if asset_type == AssetType.DOCUMENT
        else settings.ASSETS_MAX_FILE_SIZE
    )
    if len(file_content) > max_size:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File too large. Maximum allowed size is {max_size // (1024 * 1024)} MB.",
        )

    # Hash + deduplication (per user + asset_type). Documents are exempt:
    # users legitimately re-upload the same file (different folders, after delete, versioning).
    content_hash = s3_service.calculate_sha256(file_content)
    if asset_type != AssetType.DOCUMENT:
        existing = await async_session.execute(
            select(UploadedAsset)
            .where(UploadedAsset.content_hash == content_hash)
            .where(UploadedAsset.user_id == user_id)
            .where(UploadedAsset.asset_type == asset_type.value)
        )
        existing_asset = existing.fetchone()

        if existing_asset:
            existing_asset = existing_asset[0]
            existing_asset.file_name = file.filename
            existing_asset.display_name = display_name or existing_asset.display_name
            existing_asset.category = category or existing_asset.category
            existing_asset.folder_id = (
                folder_id if folder_id is not None else existing_asset.folder_id
            )
            async_session.add(existing_asset)
            await async_session.commit()
            await async_session.refresh(existing_asset)
            return AssetRead.model_validate(existing_asset)

    # Prepare S3 key
    file_extension = mimetypes.guess_extension(actual_mime_type) or ""
    s3_key = (
        f"goat/{settings.ENVIRONMENT}/users/{user_id}"
        f"/{asset_type.value}/{uuid.uuid4().hex}{file_extension}"
    )

    s3_service.upload_asset(io.BytesIO(file_content), s3_key, actual_mime_type)

    new_asset = UploadedAsset(
        user_id=user_id,
        folder_id=folder_id,
        s3_key=s3_key,
        file_name=file.filename,
        mime_type=actual_mime_type,
        file_size=len(file_content),
        asset_type=asset_type,
        content_hash=content_hash,
        display_name=display_name,
        category=category,
    )
    async_session.add(new_asset)
    await async_session.commit()
    await async_session.refresh(new_asset)

    return AssetRead.model_validate(new_asset)


@router.get(
    "",
    summary="List assets for the authenticated user",
    response_model=List[AssetRead],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(auth_z)],
)
async def read_assets(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    asset_type: AssetType | None = None,
    folder_id: UUID | None = Query(None),
) -> List[AssetRead]:
    """
    List assets. When `folder_id` is supplied the caller must own the folder or
    have a resource_grant on it. Returns all assets in that folder.
    Without `folder_id`, returns the caller's own assets.
    """
    if folder_id:
        await _check_folder_access(async_session, folder_id, user_id)
        query = select(UploadedAsset).where(UploadedAsset.folder_id == folder_id)
    else:
        query = select(UploadedAsset).where(UploadedAsset.user_id == user_id)

    if asset_type:
        query = query.where(UploadedAsset.asset_type == asset_type.value)

    result = await async_session.execute(
        query.order_by(UploadedAsset.created_at.desc())
    )
    assets = result.scalars().all()
    return [AssetRead.model_validate(a) for a in assets]


@router.put(
    "/{asset_id}",
    response_model=AssetRead,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(auth_z)],
    summary="Update asset metadata",
)
async def update_asset(
    asset_id: UUID4,
    asset_update: AssetUpdate,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> AssetRead:
    result = await async_session.execute(
        select(UploadedAsset)
        .where(UploadedAsset.id == asset_id)
        .where(UploadedAsset.user_id == user_id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )

    if asset_update.display_name is not None:
        asset.display_name = asset_update.display_name
    if asset_update.category is not None:
        asset.category = asset_update.category

    async_session.add(asset)
    await async_session.commit()
    await async_session.refresh(asset)
    return AssetRead.model_validate(asset)


@router.delete(
    "/{asset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(auth_z)],
    summary="Delete an asset",
)
async def delete_asset(
    asset_id: UUID4 = Path(..., description="ID of the asset to delete"),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> None:
    result = await async_session.execute(
        select(UploadedAsset)
        .where(UploadedAsset.id == asset_id)
        .where(UploadedAsset.user_id == user_id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )

    s3_service.delete_asset(asset.s3_key)
    await async_session.delete(asset)
    await async_session.commit()
    return None
