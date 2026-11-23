from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    Field,
    field_validator,
)

from core.db.models.layer import check_layer_url


def _validate_uuid_str(value: str) -> str:
    """Ensures the value parses as a UUID; returns the original string."""
    UUID(value)
    return value


UUIDStr = Annotated[str, AfterValidator(_validate_uuid_str)]


def _validate_iso_datetime(value: str) -> str:
    """Ensures the value parses as an ISO 8601 datetime; returns the original string."""
    # datetime.fromisoformat handles the ISO formats Pydantic v2 emits
    # (Z suffix and explicit offsets); raise on garbage.
    try:
        # Replace trailing Z with +00:00 because fromisoformat in py3.11
        # accepts both, but be explicit so it's portable.
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        datetime.fromisoformat(normalized)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Invalid ISO 8601 datetime: {value!r}") from exc
    return value


ISODateTimeStr = Annotated[str, AfterValidator(_validate_iso_datetime)]


def _validate_http_url(value: str) -> str:
    """Ensures the value is a valid http(s) URL; returns the original string."""
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL must start with http:// or https://")
    if not parsed.netloc:
        raise ValueError("URL must have a host")
    return value


HttpUrlStr = Annotated[str, AfterValidator(_validate_http_url)]


class BasemapLayerSetting(BaseModel):
    visible: bool = True
    relation: Literal["above", "below"] = "below"
    target: str = "all"


class _BaseCustomBasemap(BaseModel):
    id: UUIDStr
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    thumbnail_url: str | None = Field(default=None, max_length=2048)
    attribution: str | None = Field(default=None, max_length=500)
    created_at: ISODateTimeStr
    updated_at: ISODateTimeStr


class VectorCustomBasemap(_BaseCustomBasemap):
    type: Literal["vector"] = "vector"
    url: HttpUrlStr
    layer_config: dict[str, BasemapLayerSetting] | None = None


class RasterCustomBasemap(_BaseCustomBasemap):
    type: Literal["raster"] = "raster"
    url: str = Field(max_length=2048)

    @field_validator("url")
    @classmethod
    def must_have_xyz_placeholders(cls, value: str) -> str:
        if not (value.startswith("http://") or value.startswith("https://")):
            raise ValueError("Raster URL must start with http:// or https://")
        check_layer_url(value)
        # `{-y}` counts the rows from the south (TMS).
        has_y = "{y}" in value or "{-y}" in value
        if "{z}" not in value or "{x}" not in value or not has_y:
            raise ValueError("Raster URL must contain {z}, {x}, and {y} placeholders")
        return value


class SolidCustomBasemap(_BaseCustomBasemap):
    type: Literal["solid"] = "solid"
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


CustomBasemap = Annotated[
    VectorCustomBasemap | RasterCustomBasemap | SolidCustomBasemap,
    Field(discriminator="type"),
]
