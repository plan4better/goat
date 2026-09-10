from typing import Dict

from pydantic import BaseModel, Field


class DatasetImportRequest(BaseModel):
    """Schema for requesting a presigned upload URL for a new dataset import."""

    filename: str = Field(..., examples=["data.gpkg"])
    content_type: str = Field(
        "application/octet-stream",
        description="MIME type of the file being uploaded",
        examples=["application/geopackage+sqlite3"],
    )
    file_size: int = Field(
        ...,
        gt=0,
        description="Size of the file in bytes",
        examples=[1048576],
    )


class PresignedUploadResponse(BaseModel):
    """Presigned PUT the browser uses to upload a file straight to S3."""

    url: str = Field(
        ...,
        examples=[
            "https://mybucket.s3.amazonaws.com/goat/123/imports/data.gpkg?X-Amz-Signature=..."
        ],
    )
    key: str = Field(..., examples=["goat/123/imports/data.gpkg"])
    headers: Dict[str, str] = Field(
        default_factory=dict,
        description="Request headers the upload must carry",
        examples=[{"Content-Type": "application/geopackage+sqlite3"}],
    )
