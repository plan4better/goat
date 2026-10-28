"""Requests and answers of the style routes (spec 13.1, 13.2)."""

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class StyleSaveRequest(BaseModel):
    base_rev: int = Field(
        ..., ge=1, description="The revision the document is based on"
    )
    document: dict[str, Any] = Field(..., description="The whole GOAT Style document")


class StyleRead(BaseModel):
    id: UUID
    name: str
    position: int
    revision: int
    document: dict[str, Any]
    issues: list[dict[str, Any]] = Field(default_factory=list)
    stale: bool = False


class StyleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    copy_from: UUID | None = None


class StyleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    position: int | None = Field(default=None, ge=0)


class StyleCheckRequest(BaseModel):
    document: dict[str, Any] | None = None


class StyleCheckResult(BaseModel):
    document: dict[str, Any]
    issues: list[dict[str, Any]] = Field(default_factory=list)


class DefaultStyleWrite(BaseModel):
    document: dict[str, Any]


class StyleName(BaseModel):
    id: UUID
    name: str


class LayerStyles(BaseModel):
    """A project layer's styles in the map request: the active one whole, the others by name."""

    active: StyleRead
    others: list[StyleName] = Field(default_factory=list)


class UnpublishedChange(BaseModel):
    """A published layer whose styles differ from the published snapshot: `recomputed`
    when only computed values moved (new data), `edited` otherwise (spec 13.2)."""

    layer_project_id: int
    reason: Literal["recomputed", "edited"]


class MapResponse(BaseModel):
    """The map request (spec 13.2): the map document, the styles keyed by project layer
    id, and the layers whose styles differ from the published map."""

    map: dict[str, Any]
    styles: dict[str, LayerStyles] = Field(default_factory=dict)
    unpublished: list[UnpublishedChange] = Field(default_factory=list)


class LayerMapState(BaseModel):
    """A project layer's map state (spec 10): only the fields sent are written."""

    model_config = ConfigDict(extra="forbid")

    visible: bool | None = None
    active_style_id: UUID | None = None
    position: Literal["top", "below_labels", "below_roads"] | None = None
    time_value: Any = None
    legend_expanded: bool | None = None


class GroupMapState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    visible: bool
