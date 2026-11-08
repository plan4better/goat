from typing import Dict

from goatlib.io.formats import ALL_EXTS, refuse_unsupported_format
from pydantic import BaseModel, Field, field_validator

from core.utils import sanitize_filename


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

    @field_validator("filename")
    @classmethod
    def _format_the_import_reads(cls, filename: str) -> str:
        """Only a file of a format the import reads is presigned; the importer
        refuses any other. Checked on the name the upload is stored under."""
        try:
            refuse_unsupported_format(sanitize_filename(filename))
        except ValueError as e:
            raise ValueError(
                f"{e}. Accepted formats: {', '.join(sorted(ALL_EXTS))}"
            ) from e
        return filename


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
