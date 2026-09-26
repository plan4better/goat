from datetime import datetime
from enum import Enum
from typing import Any, List, Literal, Optional
from uuid import UUID

from pydantic import (
    UUID4,
    BaseModel,
    ConfigDict,
    ValidationInfo,
    field_validator,
)
from sqlmodel import ARRAY, Column, Field, ForeignKey, SQLModel, Text
from sqlmodel import UUID as UUID_PG

from core.core.config import settings
from core.db.models._base_class import ContentBaseAttributes, DateTimeBase
from core.schemas.common import CQLQuery
from core.schemas.custom_basemap import CustomBasemap
from core.schemas.layer import (
    ExternalServiceOtherProperties,
    FeatureStandardRead,
    FeatureStreetNetworkRead,
    FeatureToolRead,
    RasterRead,
    TableRead,
)
from core.utils import optional


################################################################################
# Project DTOs
################################################################################
class ProjectContentType(str, Enum):
    layer = "layer"


class IProjectCopy(BaseModel):
    """Request body for project copy."""

    folder_id: UUID4 | None = Field(
        None, description="Target folder. If None, same folder as original."
    )


class InitialViewState(BaseModel):
    latitude: float = Field(..., description="Latitude", ge=-90, le=90)
    longitude: float = Field(..., description="Longitude", ge=-180, le=180)
    zoom: int = Field(..., description="Zoom level", ge=0, le=20)
    min_zoom: int = Field(..., description="Minimum zoom level", ge=0, le=20)
    max_zoom: int = Field(..., description="Maximum zoom level", ge=0, le=20)
    bearing: int = Field(..., description="Bearing", ge=0, le=360)
    pitch: int = Field(..., description="Pitch", ge=0, le=60)

    @field_validator("zoom", mode="before")
    @classmethod
    def convert_zoom(cls: type["InitialViewState"], value: int | float) -> int:
        if isinstance(value, float):
            return int(value)
        return value

    @field_validator("max_zoom", mode="after")
    @classmethod
    def check_max_zoom(
        cls: type["InitialViewState"], value: int, info: ValidationInfo
    ) -> int:
        min_zoom = info.data.get("min_zoom")
        if min_zoom is not None and value < min_zoom:
            raise ValueError("max_zoom should be greater than or equal to min_zoom")
        return value

    @field_validator("min_zoom", mode="after")
    @classmethod
    def check_min_zoom(
        cls: type["InitialViewState"], value: int, info: ValidationInfo
    ) -> int:
        max_zoom = info.data.get("max_zoom")
        if max_zoom is not None and value > max_zoom:
            raise ValueError("min_zoom should be less than or equal to max_zoom")
        return value


initial_view_state_example = {
    "latitude": 48.1502132,
    "longitude": 11.5696284,
    "zoom": 12,
    "min_zoom": 0,
    "max_zoom": 20,
    "bearing": 0,
    "pitch": 0,
}


class IProjectCreate(ContentBaseAttributes):
    initial_view_state: InitialViewState | None = Field(
        None,
        description=(
            "Initial view state of the project. Omit it to have the server "
            "choose one, in order: the caller's approximate location, the "
            "deployment's configured default, the project they most recently "
            "opened, and failing all of those a wide default view."
        ),
    )
    tags: List[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(Text), nullable=True),
        description="Layer tags",
    )


class IProjectRead(ContentBaseAttributes, DateTimeBase):
    id: UUID = Field(..., description="Project ID")
    space_id: UUID | None = Field(None, description="Space that owns this project")
    space_kind: Literal["personal", "team", "organization"] | None = Field(
        None, description="Kind of the owning space"
    )
    space_name: str | None = Field(
        None,
        description=(
            "Name of the owning team or organisation. None for a personal "
            "space — its owner's name is not exposed here."
        ),
    )
    personally_owned_layer_count: int | None = Field(
        None,
        description=(
            "Count of this project's linked live layers that live in a "
            "personal space (D13 health check). None for a project that is "
            "itself in a personal space."
        ),
    )
    layer_order: list[int] | None = Field(None, description="Layer order in project")
    thumbnail_url: str | None = Field(description="Project thumbnail URL")
    basemap: str | None = Field(None, description="Project basemap")
    custom_basemaps: list[CustomBasemap] = Field(
        default_factory=list, description="Per-project custom basemap library"
    )
    shared_with: dict[str, Any] | None = Field(None, description="Shared with")
    owned_by: dict[str, Any] | None = Field(None, description="Owned by")
    my_role: str | None = Field(None, description="Current user's role on this project")
    restricted: bool = Field(
        False, description="Restricted (D9): members do not get the space default"
    )
    restricted_inherited: bool = Field(
        False,
        description="Closed by a restricted ancestor folder rather than its own flag",
    )
    builder_config: dict[str, Any] | None = Field(None, description="Builder config")
    max_extent: list[float] | None = Field(
        None, description="Max extent of the project"
    )
    tags: List[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(Text), nullable=True),
        description="Layer tags",
    )

    @field_validator("thumbnail_url", mode="before")
    @classmethod
    def convert_thumbnail_to_presigned_url(
        cls: type["IProjectRead"], value: str | None
    ) -> str | None:
        """Convert S3 key to presigned URL if needed."""
        if not value:
            return settings.DEFAULT_PROJECT_THUMBNAIL

        # If already a full URL, return as-is
        if value.startswith(("http://", "https://")):
            return value

        # It's an S3 key, generate presigned URL
        from core.services.s3 import s3_service

        return s3_service.get_thumbnail_url(
            value, default_url=settings.DEFAULT_PROJECT_THUMBNAIL
        )


class IProjectBaseUpdate(SQLModel):
    folder_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.folder.id", ondelete="CASCADE"),
            nullable=False,
        ),
        description="Layer folder ID",
    )
    name: str | None = Field(
        default=None,
        sa_type=Text,
        description="Layer name",
        max_length=255,
        nullable=False,
    )
    description: str | None = Field(
        default=None,
        sa_type=Text,
        description="Layer description",
        max_length=2000,
    )
    layer_order: list[int] | None = Field(None, description="Layer order in project")
    basemap: str | None = Field(None, description="Project basemap")
    custom_basemaps: list[CustomBasemap] | None = Field(
        default=None, description="Per-project custom basemap library"
    )
    max_extent: list[float] | None = Field(
        None, description="Max extent of the project"
    )
    builder_config: dict[str, Any] | None = Field(None, description="Builder config")
    tags: List[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(Text), nullable=True),
        description="Layer tags",
    )


class LayerProjectIds(BaseModel):
    id: int = Field(..., description="Layer Project ID")
    layer_id: UUID = Field(..., description="Layer ID")
    #: `updated_at` on a project layer is the LATER of the dataset's and the
    #: link's, because the map keys its tile source on it and either side
    #: changing has to refetch. That makes it useless for "how current is this
    #: data": restyling the layer moves it. This is the dataset's own.
    dataset_updated_at: datetime | None = Field(
        None, description="When the underlying dataset last changed"
    )
    locked: bool = Field(
        False,
        description=(
            "The caller has no access to this dataset of his own: it is in the "
            "project through a non-shareable link (D7), so it is listed but its "
            "style, filter and preferences are withheld and it is not mapped."
        ),
    )


class IFeatureBaseProject(CQLQuery):
    group: str | None = Field(None, description="Layer group name")
    charts: dict[str, Any] | None = Field(None, description="Layer chart properties")
    other_properties: dict[str, Any] | None = Field(
        None,
        description="Per-project-layer preferences (e.g. data table configuration)",
    )


class IFeatureBaseProjectRead(IFeatureBaseProject):
    properties: dict[str, Any] = Field(
        ...,
        description="Layer properties",
    )
    total_count: int | None = Field(
        None, description="Total count of features in the layer"
    )
    filtered_count: int | None = Field(
        None, description="Filtered count of features in the layer"
    )
    order: int = Field(0, description="Visual sorting order")
    layer_project_group_id: int | None = Field(None, description="Parent group ID")


class IFeatureStandardProjectRead(
    LayerProjectIds, FeatureStandardRead, IFeatureBaseProjectRead
):
    # Override the dataset-read typing (strict WMS model): project-layer
    # other_properties is a free-form preference blob (e.g. table_config).
    other_properties: dict[str, Any] | None = Field(
        None, description="Per-project-layer preferences"
    )


class IFeatureToolProjectRead(
    LayerProjectIds, FeatureToolRead, IFeatureBaseProjectRead
):
    other_properties: dict[str, Any] | None = Field(
        None, description="Per-project-layer preferences"
    )


class IFeatureStreetNetworkProjectRead(
    LayerProjectIds, FeatureStreetNetworkRead, IFeatureBaseProjectRead
):
    other_properties: dict[str, Any] | None = Field(
        None, description="Per-project-layer preferences"
    )


class IFeatureStandardProjectUpdate(IFeatureBaseProject):
    name: str | None = Field(None, description="Layer name")
    properties: dict[str, Any] | None = Field(
        default=None,
        description="Layer properties",
    )


class IFeatureStreetNetworkProjectUpdate(IFeatureBaseProject):
    name: str | None = Field(None, description="Layer name")
    properties: dict[str, Any] | None = Field(
        default=None,
        description="Layer properties",
    )


class IFeatureToolProjectUpdate(IFeatureBaseProject):
    name: str | None = Field(None, description="Layer name")
    properties: dict[str, Any] | None = Field(
        default=None,
        description="Layer properties",
    )


class ITableProjectRead(LayerProjectIds, TableRead, CQLQuery):
    # Unbounded on read: one row over a limit fails the whole response, not just
    # this field. The limit belongs on create/update.
    group: str | None = Field(None, description="Layer group name")
    other_properties: dict[str, Any] | None = Field(
        None,
        description="Per-project-layer preferences (e.g. data table configuration)",
    )
    total_count: int | None = Field(
        None, description="Total count of features in the layer"
    )
    filtered_count: int | None = Field(
        None, description="Filtered count of features in the layer"
    )
    order: int = Field(0, description="Visual sorting order")
    layer_project_group_id: int | None = Field(None, description="Parent group ID")


@optional
class ITableProjectUpdate(CQLQuery):
    name: str | None = Field(None, description="Layer name", max_length=255)
    group: str | None = Field(None, description="Layer group name", max_length=255)
    other_properties: dict[str, Any] | None = Field(
        None,
        description="Per-project-layer preferences (e.g. data table configuration)",
    )


class IRasterProjectRead(LayerProjectIds, RasterRead):
    # Unbounded on read: one row over a limit fails the whole response, not just
    # this field. The limit belongs on create/update.
    group: str | None = Field(None, description="Layer group name")
    properties: Optional[dict[str, Any]] = Field(
        None,
        description="Layer properties",
    )
    order: int = Field(0, description="Visual sorting order")
    layer_project_group_id: int | None = Field(None, description="Parent group ID")


@optional
class IRasterProjectUpdate(BaseModel):
    name: str | None = Field(None, description="Layer name", max_length=255)
    group: str | None = Field(None, description="Layer group name", max_length=255)
    properties: dict[str, Any] | None = Field(
        None,
        description="Layer properties",
    )
    other_properties: ExternalServiceOtherProperties | None = Field(
        None,
        description="Other properties of the layer",
    )


layer_type_mapping_read = {
    "feature_standard": IFeatureStandardProjectRead,
    "feature_tool": IFeatureToolProjectRead,
    "feature_street_network": IFeatureStreetNetworkProjectRead,
    "raster": IRasterProjectRead,
    "table": ITableProjectRead,
}

layer_type_mapping_update = {
    "feature_standard": IFeatureStandardProjectUpdate,
    "feature_tool": IFeatureToolProjectUpdate,
    "feature_street_network": IFeatureStreetNetworkProjectUpdate,
    "raster": IRasterProjectUpdate,
    "table": ITableProjectUpdate,
}


class ProjectPublicProjectConfig(BaseModel):
    id: UUID = Field(..., description="Project ID")
    name: str = Field(..., description="Project name")
    description: str | None = Field(..., description="Project description")
    tags: List[str] | None = Field(default=None, description="Project tags")
    thumbnail_url: str | None = Field(None, description="Project thumbnail URL")
    initial_view_state: InitialViewState = Field(
        ..., description="Initial view state of the project"
    )
    basemap: str | None = Field(None, description="Project basemap")
    custom_basemaps: list[CustomBasemap] = Field(
        default_factory=list, description="Per-project custom basemap library"
    )
    layer_order: list[int] | None = Field(None, description="Layer order in project")
    max_extent: list[float] | None = Field(
        None, description="Max extent of the project"
    )
    folder_id: UUID = Field(..., description="Folder ID")
    builder_config: dict[str, Any] | None = Field(None, description="Builder config")

    @field_validator("thumbnail_url", mode="before")
    @classmethod
    def convert_thumbnail_to_presigned_url(
        cls: type["ProjectPublicProjectConfig"], value: str | None
    ) -> str | None:
        """Convert S3 key to presigned URL if needed."""
        if not value:
            return settings.DEFAULT_PROJECT_THUMBNAIL

        # If already a full URL, return as-is
        if value.startswith(("http://", "https://")):
            return value

        # It's an S3 key, generate presigned URL
        from core.services.s3 import s3_service

        return s3_service.get_thumbnail_url(
            value, default_url=settings.DEFAULT_PROJECT_THUMBNAIL
        )


class ProjectPublicConfig(BaseModel):
    layers: list[
        IFeatureStreetNetworkProjectRead
        | IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ] = Field(..., description="Layers of the project")
    layer_groups: list["ILayerProjectGroupRead"] = Field(
        ..., description="Layer groups of the project"
    )
    project: ProjectPublicProjectConfig = Field(
        ..., description="Project configuration"
    )


class PublicAnalytics(BaseModel):
    """Analytics block included in the public-project response.

    Only present when the project has an analytics instance assigned
    (``analytics_id`` set). The frontend dispatches on ``provider`` to
    choose which tracker to inject.
    """

    provider: str
    config: dict[str, Any]


class ProjectPublicRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    created_at: datetime = Field(..., description="Created at")
    updated_at: datetime = Field(..., description="Updated at")
    project_id: UUID
    config: ProjectPublicConfig
    custom_domain_id: UUID | None = Field(
        default=None,
        description="ID of the custom domain assigned to this published project, if any.",
    )
    analytics_id: UUID | None = Field(
        default=None,
        description="Analytics instance this dashboard reports to. Null means tracking is off.",
    )
    tracking_require_consent: bool = Field(
        default=True,
        description="If true, the analytics tracker defers events until the visitor's consent banner grants permission.",
    )
    analytics: PublicAnalytics | None = Field(
        default=None,
        description="Resolved analytics integration to inject. Null when no instance is assigned.",
    )


# --- Schemas for Tree Structure Updates (Drag & Drop) ---


# WRITE Model (PUT) - for the bulk update
class LayerTreeItem(BaseModel):
    id: int
    type: Literal["group", "layer"]
    order: int
    properties: dict[str, Any] | None = None
    parent_id: Optional[int] = None


class LayerTreeUpdate(BaseModel):
    items: List[LayerTreeItem]


# --- Schemas for Group CRUD (Renamed) ---
class ILayerProjectGroupCreate(BaseModel):
    # The column is unbounded `text`, so nothing else stops a group name of any
    # size — 5,000 characters was accepted and stored.
    name: str = Field(..., max_length=255)
    properties: dict[str, Any] | None = None
    parent_id: Optional[int] = None


class ILayerProjectGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    properties: dict[str, Any] | None = None
    parent_id: Optional[int] = None


class ILayerProjectGroupRead(ILayerProjectGroupCreate):
    # Unbounded on read, though it inherits a bounded field: a group named
    # before the limit existed must still be readable.
    name: str
    id: int
    project_id: UUID4
    order: int
    # Read-only: a bundle-backed group is created through the dedicated
    # add-bundle endpoint (which authorizes the bundle), never through the
    # generic group create.
    bundle_id: Optional[UUID4] = Field(
        None,
        description="Set when the group holds a bundle's layers (locked membership)",
    )


# TODO: Refactor
request_examples = {
    "get": {
        "ids": [
            "39e16c27-2b03-498e-8ccc-68e798c64b8d",
            "e7dcaae4-1750-49b7-89a5-9510bf2761ad",
        ],
    },
    "create": {
        "folder_id": "39e16c27-2b03-498e-8ccc-68e798c64b8d",
        "name": "Project 1",
        "description": "Project 1 description",
        "tags": ["tag1", "tag2"],
        "initial_view_state": initial_view_state_example,
    },
    "update": {
        "folder_id": "39e16c27-2b03-498e-8ccc-68e798c64b8d",
        "name": "Project 2",
        "description": "Project 2 description",
        "tags": ["tag1", "tag2"],
    },
    "initial_view_state": initial_view_state_example,
    "update_layer": {
        "feature_standard": {
            "summary": "Feature Layer Standard",
            "value": {
                "name": "Feature Layer Standard",
                "group": "Group 1",
                "query": {"op": "=", "args": [{"property": "category"}, "bus_stop"]},
                "properties": {
                    "type": "circle",
                    "paint": {
                        "circle-radius": 5,
                        "circle-color": "#ff0000",
                    },
                    "layout": {"visibility": "visible"},
                    "minzoom": 0,
                    "maxzoom": 22,
                },
            },
        },
        "feature_tool": {
            "summary": "Feature Layer Tool",
            "value": {
                "name": "Feature Layer Tool",
                "group": "Group 1",
                "properties": {
                    "type": "circle",
                    "paint": {
                        "circle-radius": 5,
                        "circle-color": "#ff0000",
                    },
                    "layout": {"visibility": "visible"},
                    "minzoom": 0,
                    "maxzoom": 22,
                },
            },
        },
        "table": {
            "summary": "Table Layer",
            "value": {
                "name": "Table Layer",
                "group": "Group 1",
            },
        },
        "external_vector": {
            "summary": "VectorVectorTile Layer",
            "value": {
                "name": "VectorVectorTile Layer",
                "group": "Group 1",
            },
        },
        "external_imagery": {
            "summary": "Imagery Layer",
            "value": {
                "name": "Imagery Layer",
                "group": "Group 1",
            },
        },
    },
}
