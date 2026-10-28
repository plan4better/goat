from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Any, Dict, List, Union
from uuid import UUID

from geoalchemy2 import Geometry, WKBElement
from geoalchemy2.shape import to_shape
from pydantic import (
    HttpUrl,
    computed_field,
    field_serializer,
    field_validator,
)
from sqlalchemy import BigInteger, Index, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import (
    ARRAY,
    Boolean,
    Column,
    DateTime,
    Field,
    ForeignKey,
    Integer,
    Relationship,
    SQLModel,
    Text,
)

from core.core.config import settings
from core.db.models._base_class import (
    ContentBaseAttributes,
    DateTimeBase,
    serialize_str_enum,
)

if TYPE_CHECKING:
    from core.db.models.folder import Folder

    from ._link_model import (
        BundleLayerLink,
        LayerProjectLink,
    )


class FeatureType(str, Enum):
    """Feature layer types."""

    standard = "standard"
    tool = "tool"
    street_network = "street_network"


class RasterDataType(str, Enum):
    """Imagery layer data types."""

    wms = "wms"
    xyz = "xyz"
    wmts = "wmts"
    cog = "cog"


class LayerType(str, Enum):
    """Layer types that are supported."""

    feature = "feature"
    raster = "raster"
    table = "table"


class FeatureDataType(str, Enum):
    """Data types for feature layers."""

    mvt = "mvt"
    wfs = "wfs"
    # NULL / None is used for feature layers not fetched from an external service


class FeatureGeometryType(str, Enum):
    """Feature layer geometry types."""

    point = "point"
    line = "line"
    polygon = "polygon"


class GeospatialAttributes(SQLModel):
    """Some general geospatial attributes."""

    extent: str | None = Field(
        default=None,
        sa_column=Column(
            Geometry("MultiPolygon", srid=4326, spatial_index=True),
            nullable=True,
        ),
        description="Geographical extent of the layer",
    )

    @field_validator("extent", mode="before")
    @classmethod
    def wkb_to_wkt(
        cls: type["GeospatialAttributes"],
        v: WKBElement | str | None,
    ) -> str | None:
        if isinstance(v, WKBElement):
            return str(to_shape(v).wkt)
        return v


class LayerBase(ContentBaseAttributes):
    """Base model for layers."""

    public_read: bool | None = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="False"),
        description=(
            "Public dataset: readable by every signed-in user in any "
            "organization. Set by the owner; changes nothing about who may "
            "write. Catalog datasets are identified by catalog_external_uid."
        ),
    )
    thumbnail_url: str | None = Field(
        default=settings.DEFAULT_LAYER_THUMBNAIL,
        sa_column=Column(Text, nullable=True),
        description="Layer thumbnail URL",
    )
    tags: List[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(Text), nullable=True),
        description="Layer tags",
    )


class Layer(LayerBase, GeospatialAttributes, DateTimeBase, table=True):
    """Layer model."""

    __tablename__ = "layer"
    __table_args__ = (
        # The arbiter of promote-on-use: `catalog_promote` inserts with
        # ON CONFLICT (catalog_external_uid, catalog_version) WHERE
        # catalog_external_uid IS NOT NULL, so a concurrent promote of the same
        # (item, version) conflicts here and the loser reuses the winner's row.
        # The predicate must stay identical to that statement's, or the
        # conflict target resolves to no index and every promote fails.
        Index(
            "uq_layer_catalog_identity",
            "catalog_external_uid",
            "catalog_version",
            unique=True,
            postgresql_where=text("catalog_external_uid IS NOT NULL"),
        ),
        {"schema": settings.SCHEMA},
    )

    id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=text("uuid_generate_v4()"),
        ),
        description="Layer ID",
    )
    user_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        description=(
            "Layer owner. NULL for a catalog layer: it belongs to the provider "
            "that published it, not to anyone here, which is what keeps it out "
            "of every content listing and every storage quota. Also NULL for a "
            "space-owned layer whose creator's account was removed: "
            'informational "created by", survives the user like every other '
            "content table's user_id."
        ),
    )
    catalog_external_uid: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description=(
            "Identity of the catalog item this layer was promoted from. A "
            "promoted layer is a shared, read-only snapshot: together with "
            "catalog_version it is unique (partial index), which is what makes "
            "promote-on-use idempotent across users and orgs."
        ),
    )
    catalog_version: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description=(
            "The catalog item's version at promotion time. Projects keep the "
            "version they added; a newer upstream version promotes into a new "
            "layer rather than touching this one."
        ),
    )
    data_snapshot: int | None = Field(
        default=None,
        sa_column=Column(BigInteger, nullable=True),
        description=(
            "The last DuckLake snapshot that changed the layer's data: the data "
            "fingerprint its styles' computed values are compared with (spec 12)."
        ),
    )
    folder_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.folder.id", ondelete="CASCADE"),
            nullable=True,
        ),
        description="Folder the layer lives in. NULL for an unowned catalog layer.",
    )
    space_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.space.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        description="Space this layer belongs to. NULL for an unowned catalog layer.",
    )
    deleted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
        description="Soft-delete timestamp; NULL while the layer is live.",
    )
    restricted: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default=text("false")),
        description="Restricted (D9): members of the layer's space do not get the space default role on it; grants still apply.",
    )
    type: LayerType = Field(
        sa_column=Column(Text, nullable=False), description="Layer type"
    )
    extent: str | None = Field(
        default=None,
        sa_column=Column(
            Geometry(geometry_type="MultiPolygon", srid=4326, spatial_index=False),
            nullable=True,
        ),
        description="Geographical Extent of the layer",
    )
    properties: Dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="Properties of the layer",
    )
    other_properties: Dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="Other properties of the layer",
    )
    url: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Layer URL for vector and imagery layers",
    )
    data_type: Union["RasterDataType", "FeatureDataType"] | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Data type to store the source of the layer",
    )
    tool_type: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="If it is an tool layer, the tool type",
    )
    job_id: UUID | None = Field(
        default=None,
        sa_column=Column(UUID_PG(as_uuid=True), nullable=True),
        description="Job ID if the layer is a tool layer",
    )
    feature_layer_type: FeatureType | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Feature layer type",
    )
    feature_layer_geometry_type: FeatureGeometryType | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Geometry type for feature layers",
    )
    size: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
        description="Size of the layer in bytes",
    )
    field_config: Dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(
            JSONB,
            nullable=False,
            server_default=text("'{}'::jsonb"),
        ),
        description=(
            "Per-column metadata keyed by column name. "
            "Each entry has shape "
            '{"kind": str, "is_computed": bool, "is_locked": bool, '
            '"depends_on": [str], "display_config": {...}}, plus per-kind '
            'settings next to "kind" (a formula\'s "formula", a serial\'s '
            '"start"; see goatlib.utils.generated_fields). '
            "Columns with no entry use default config inferred from the "
            "DuckDB type."
        ),
    )

    # Relationships
    layer_projects: List["LayerProjectLink"] = Relationship(
        back_populates="layer", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    folder: "Folder" = Relationship(back_populates="layers")
    bundle_link: "BundleLayerLink" = Relationship(
        back_populates="layer",
        sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"},
    )

    @field_validator("extent", mode="after")
    @classmethod
    def wkt_to_geojson(cls, value: str | WKBElement | None) -> str | None:
        if value is not None and isinstance(value, WKBElement):
            return str(to_shape(value).wkt)
        return value

    @field_serializer("extent")
    def _serialize_extent(self, value: str | WKBElement | None) -> str | None:
        """Serialize extent whether it arrives as WKT (validated) or a raw
        WKBElement (e.g. direct model_dump of an ORM instance), avoiding the
        WKBElement-vs-str serializer warning while keeping output identical."""
        if isinstance(value, WKBElement):
            return str(to_shape(value).wkt)
        return value

    @field_serializer("type", "feature_layer_type", "feature_layer_geometry_type")
    def _serialize_enum(self, value: Enum | str | None) -> str | None:
        return serialize_str_enum(value)

    @field_validator("url", mode="before")
    @classmethod
    def convert_httpurl_to_str(cls, value: str | HttpUrl | None) -> str | None:
        """Convert HttpUrl to string for url.

        Note: thumbnail_url is handled separately by ThumbnailUrlMixin
        in the schema layer, as it may be stored as an S3 key.
        """
        if value is None:
            return value
        elif isinstance(value, HttpUrl):
            return str(value)
        assert HttpUrl(value)
        return value

    @computed_field
    def layer_id(self) -> UUID | None:
        return self.id


Layer.model_rebuild()
