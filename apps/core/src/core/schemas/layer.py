# Standard library imports
from typing import Any, Dict, List, Literal, Union
from uuid import UUID

# Third party imports
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    RootModel,
    field_validator,
)
from shapely import wkt

# Local application imports
from core.core.config import settings
from core.db.models._base_class import DateTimeBase, content_base_example
from core.db.models.layer import (
    FeatureDataType,
    FeatureGeometryType,
    FeatureType,
    GeospatialAttributes,
    LayerBase,
    LayerType,
    RasterDataType,
)
from core.utils import optional


class ThumbnailUrlMixin(BaseModel):
    """Mixin to convert thumbnail S3 keys to presigned URLs."""

    @field_validator("thumbnail_url", mode="before", check_fields=False)
    @classmethod
    def convert_thumbnail_to_presigned_url(
        cls: type["ThumbnailUrlMixin"], value: str | None
    ) -> str | None:
        """Convert S3 key to presigned URL if needed."""
        if not value:
            return settings.DEFAULT_LAYER_THUMBNAIL

        # A full URL or a root-relative path (the artwork the web app
        # ships) is returned as-is
        if value.startswith(("http://", "https://", "/")):
            return value

        # It's an S3 key, generate presigned URL
        from core.services.s3 import s3_service

        return s3_service.get_thumbnail_url(
            value, default_url=settings.DEFAULT_LAYER_THUMBNAIL
        )


class LayerReadBaseAttributes(BaseModel):
    # Reading is not the place to discover that stored data is too long: the
    # value is already in the database and the user can do nothing about it.
    # One over-long description used to fail the whole `GET /project/{id}/layer`
    # response, so a single catalog layer stopped an entire project loading.
    # The bounds that matter are on input — see `ContentBaseAttributes`, and
    # `tests/unit/test_read_models_accept_stored_data.py`, which fails if a
    # length constraint reaches a read model again.
    name: str | None = Field(None, description="Layer name")
    description: str | None = Field(None, description="Layer description")
    user_id: UUID | None = Field(None, description="Owner, or None for a catalog layer")
    shared_with: Dict[str, Any] | None = Field(
        None, description="List of user IDs the layer is shared with"
    )
    owned_by: Dict[str, Any] | None = Field(None, description="User ID of the owner")


################################################################################
# External service DTOs
################################################################################


class ExternalServiceOtherProperties(BaseModel):
    """The WMS/WFS fields of `other_properties`, plus whatever else is in there.

    `extra="allow"` because this model is the declared type of `other_properties`
    on every layer read schema, and the column is a free-form document: a
    promoted catalog layer keeps its `catalog_item` snapshot and its
    `catalog_materialize` status in it. Without this, Pydantic silently drops
    every key not named below, so `GET /layer/{id}` returned `{}` for a catalog
    layer and its detail page had nothing to show.
    """

    model_config = ConfigDict(extra="allow")

    url: str | None = Field(
        default=None,
        description="Layer URL",
    )
    layers: List[str] | None = Field(
        default=None,
        description="List of layers to be displayed",
    )
    width: int | None = Field(
        default=None,
        description="Width of the WMS image",
    )
    height: int | None = Field(
        default=None,
        description="Height of the WMS image",
    )
    srs: str | None = Field(
        default=None,
        description="SRS of the WMS image",
        max_length=50,
    )
    legend_urls: List[str] | None = Field(
        default=None,
        description="Layer legend URLs",
    )

    @field_validator("url", mode="before")
    @classmethod
    def convert_url_httpurl_to_str(
        cls: type["ExternalServiceOtherProperties"], value: str | HttpUrl | None
    ) -> str | None:
        if value is None:
            return value
        elif isinstance(value, HttpUrl):
            return str(value)
        assert HttpUrl(value)
        return value

    @field_validator("legend_urls", mode="before")
    @classmethod
    def convert_legend_urls_httpurl_to_str(
        cls: type["ExternalServiceOtherProperties"],
        value: list[str] | list[HttpUrl] | None,
    ) -> list[str] | None:
        if value is None:
            return value

        result = []
        for v in value:
            if isinstance(v, HttpUrl):
                result.append(str(v))
            else:
                assert HttpUrl(v)
                result.append(v)
        return result


class ExternalServiceAttributesBase(BaseModel):
    """Base model for attributes pertaining to an external service."""

    url: str | None = Field(
        default=None,
        description="Layer URL",
    )
    data_type: FeatureDataType | RasterDataType | None = Field(
        default=None,
        description="Content data type",
    )
    other_properties: ExternalServiceOtherProperties | None = Field(
        default=None,
        description="Additional layer properties.",
    )

    @field_validator("url", mode="before")
    @classmethod
    def convert_httpurl_to_str(
        cls: type["ExternalServiceAttributesBase"], value: str | HttpUrl | None
    ) -> str | None:
        if value is None:
            return value
        elif isinstance(value, HttpUrl):
            return str(value)
        assert HttpUrl(value)
        return value


################################################################################
# File Upload DTOs
################################################################################


################################################################################
# Feature Layer DTOs
################################################################################


class FeatureReadBaseAttributes(
    ThumbnailUrlMixin, LayerReadBaseAttributes, LayerBase, GeospatialAttributes
):
    """Base model for feature layer reads.

    Note: ThumbnailUrlMixin must come first in the inheritance chain to ensure
    its field validator runs before LayerBase's HttpUrl validation.
    """

    feature_layer_geometry_type: "FeatureGeometryType" = Field(
        ..., description="Feature layer geometry type"
    )
    size: int | None = Field(None, description="Size of the layer in bytes")


class FeatureUpdateBase(LayerBase, GeospatialAttributes):
    """Base model for feature layer updates. A layer's style is its default style
    row (`PUT /layer/{id}/style`), never part of these."""


feature_layer_update_base_example = {
    "size": 1000,
}


# Feature Layer Standard
class FeatureStandardRead(
    FeatureReadBaseAttributes, DateTimeBase, ExternalServiceAttributesBase
):
    type: Literal["feature"]
    feature_layer_type: Literal["standard"]


class IFeatureStandardLayerRead(FeatureStandardRead):
    id: UUID = Field(..., description="Content ID of the layer")


@optional
class IFeatureStandardUpdate(FeatureUpdateBase):
    pass


# Feature Layer Tool
class FeatureToolAttributesBase(BaseModel):
    """Base model for additional attributes feature layer tool."""

    tool_type: str | None = Field(None, description="Tool type")


class FeatureToolRead(
    FeatureReadBaseAttributes, FeatureToolAttributesBase, DateTimeBase
):
    """Model to read a feature layer tool."""

    type: Literal["feature"]
    feature_layer_type: Literal["tool"]
    charts: Dict[str, Any] | None = Field(None, description="Chart configuration")


class IFeatureToolLayerRead(FeatureToolRead):
    id: UUID = Field(..., description="Content ID of the layer")


@optional
class IFeatureToolUpdate(FeatureUpdateBase):
    """Model to update a feature layer tool."""

    pass


class FeatureStreetNetworkRead(FeatureReadBaseAttributes, DateTimeBase):
    """Model to read a street network feature layer."""

    type: Literal["feature"]
    feature_layer_type: Literal["street_network"]


class IFeatureStreetNetworkLayerRead(FeatureStreetNetworkRead):
    id: UUID = Field(..., description="Content ID of the layer")


class IFeatureStreetNetworkUpdate(IFeatureStandardUpdate):
    """Model to update a street network feature layer."""

    pass


################################################################################
# Raster DTOs
################################################################################


class RasterAttributesBase(ExternalServiceAttributesBase):
    """Base model for attributes pertaining to an external service providing a raster."""

    type: LayerType = Field(..., description="Layer type")

    pass


imagery_layer_attributes_example = {
    "url": "https://geodata.nationaalgeoregister.nl/luchtfoto/rgb/wms?request=GetCapabilities&service=WMS",
    "data_type": "wms",
    "other_properties": {
        "layers": ["Actueel_ortho25"],
        "width": 256,
        "height": 256,
        "srs": "EPSG:3857",
        "legend_urls": [
            "https://geodata.nationaalgeoregister.nl/luchtfoto/rgb/wms?request=GetLegendGraphic&service=WMS&layer=Actueel_ortho25&format=image/png&width=20&height=20",
            "https://geodata.nationaalgeoregister.nl/luchtfoto/rgb/wms?request=GetLegendGraphic&service=WMS&layer=Actueel_ortho25&format=image/png&width=20&height=20",
        ],
    },
}


class IRasterCreate(LayerBase, GeospatialAttributes, RasterAttributesBase):
    """Model to create a raster layer."""

    pass


class RasterRead(
    ThumbnailUrlMixin,
    LayerReadBaseAttributes,
    LayerBase,
    GeospatialAttributes,
    RasterAttributesBase,
    DateTimeBase,
    ExternalServiceAttributesBase,
):
    """Model to read a raster layer.

    Note: ThumbnailUrlMixin must come first in the inheritance chain to ensure
    its field validator runs before LayerBase's HttpUrl validation.
    """

    type: Literal[LayerType.raster]


class IRasterLayerRead(RasterRead):
    id: UUID = Field(..., description="Content ID of the layer")


@optional
class IRasterUpdate(LayerBase, GeospatialAttributes):
    """Model to update a raster layer."""

    url: str | None = Field(None, description="Layer URL")
    other_properties: ExternalServiceOtherProperties | None = Field(
        None, description="Additional layer properties."
    )

    @field_validator("url", mode="before")
    @classmethod
    def convert_httpurl_to_str(
        cls: type["IRasterUpdate"], value: str | HttpUrl | None
    ) -> str | None:
        if value is None:
            return value
        elif isinstance(value, HttpUrl):
            return str(value)
        assert HttpUrl(value)
        return value


imagery_layer_update_base_example = {
    "url": "https://geodata.nationaalgeoregister.nl/luchtfoto/rgb/wms?request=GetCapabilities&service=WMS",
}

################################################################################
# Table Layer DTOs
################################################################################


class TableRead(
    ThumbnailUrlMixin,
    LayerReadBaseAttributes,
    LayerBase,
    DateTimeBase,
    ExternalServiceAttributesBase,
):
    """Model to read a table layer.

    Note: ThumbnailUrlMixin must come first in the inheritance chain to ensure
    its field validator runs before LayerBase's HttpUrl validation.
    """

    type: Literal["table"]


class ITableLayerRead(TableRead):
    id: UUID = Field(..., description="Content ID of the layer")


@optional
class ITableUpdate(LayerBase):
    """Model to update a table layer."""

    pass


layer_creator_class = {
    "feature": {
        "standard": IFeatureStandardLayerRead,
        "tool": IFeatureToolLayerRead,
        "street_network": IFeatureStreetNetworkLayerRead,
    },
    "table": ITableLayerRead,
    "raster": IRasterLayerRead,
}


layer_update_class = {
    "feature": {
        "standard": IFeatureStandardUpdate,
        "tool": IFeatureToolUpdate,
        "street_network": IFeatureStreetNetworkUpdate,
    },
    "raster": IRasterUpdate,
    "table": ITableUpdate,
}


# Write function to get the correct class
def get_layer_schema(
    class_mapping: Dict[str, Any],
    layer_type: LayerType,
    feature_layer_type: FeatureType | None = None,
) -> FeatureUpdateBase | IRasterUpdate | ITableUpdate:
    # Check if layer type is valid
    if layer_type in class_mapping:
        # Check if layer is feature
        if feature_layer_type:
            schema_class = class_mapping[layer_type][feature_layer_type]
            if not issubclass(schema_class, FeatureUpdateBase):
                raise ValueError(
                    f"Feature layer type ({feature_layer_type}) is invalid for layer type ({layer_type})"
                )
            return schema_class
        else:
            schema_class = class_mapping[layer_type]
            if not issubclass(schema_class, IRasterUpdate | ITableUpdate):
                raise ValueError(
                    f"Layer type ({layer_type}) is invalid for the provided class mapping"
                )
            return schema_class
    else:
        raise ValueError(f"Layer type ({layer_type}) is invalid")


# Flat union of all concrete layer-read variants, with NO discriminator.
#
# A discriminated union can't be used here: the three feature variants all share
# type="feature" (a single discriminator value can't map to three schemas), and
# wrapping them in a nested discriminated union either (a) hides the outer "type"
# discriminator behind a RootModel — forcing slow, warning-emitting left-to-right
# serialization — or (b) emits a nested-object discriminator mapping that is
# invalid OpenAPI. A plain union lets Pydantic's smart-mode match by the Literal
# `type`/`feature_layer_type` fields: correct routing, no serializer warnings,
# and valid OpenAPI (a plain oneOf with no discriminator mapping).
class ILayerRead(
    RootModel[
        Union[
            IFeatureStandardLayerRead,
            IFeatureToolLayerRead,
            IFeatureStreetNetworkLayerRead,
            ITableLayerRead,
            IRasterLayerRead,
        ]
    ]
):
    pass


class IUniqueValue(BaseModel):
    """Model for unique values."""

    value: str = Field(..., description="Unique value")
    count: int = Field(..., description="Number of occurrences")

    @field_validator("value", mode="before")
    @classmethod
    def convert_value_to_str(cls: type["IUniqueValue"], value: str | int) -> str:
        if isinstance(value, str):
            return value
        return str(value)


class LayerGetBase(BaseModel):
    folder_id: UUID | None = Field(
        None,
        description="Folder ID to filter by. If not specified, all layers will be returned.",
    )
    type: List[LayerType] | None = Field(
        None,
        description="Layer type to filter by. Can be multiple. If not specified, all layer types will be returned.",
    )
    feature_layer_type: List[FeatureType] | None = Field(
        None,
        description="Feature layer type to filter by. Can be multiple. If not specified, all feature layer types will be returned.",
    )
    search: str | None = Field(
        None,
        description="Searches the 'name' and 'description' column of the layer. It will convert the text into lower case and see if the passed text is part of the name.",
    )
    spatial_search: str | None = Field(None, description="Spatial search for the layer")

    # Validate the spatial search
    @field_validator("spatial_search")
    @classmethod
    def validate_spatial_search(cls, value: str | None) -> str | None:
        if value:
            try:
                wkt.loads(value)
            except Exception as e:
                raise ValueError(f"Invalid Geometry: {e}")
        return value


class ILayerGet(LayerGetBase):
    public_read: bool | None = Field(
        None,
        description="This field is left optional. If true, only layers readable by every user are returned.",
    )


request_examples = {
    # The only two consumers: the raster POST and the layer PUT
    # (endpoints/v2/layer.py). Feature and table layers are created by the
    # import tools, not through this API, so they have no example here.
    "create": {
        "raster": {
            "summary": "Raster Layer",
            "value": {
                **content_base_example,
                **imagery_layer_attributes_example,
                "type": "raster",
                "extent": "MULTIPOLYGON(((0 0, 0 1, 1 1, 1 0, 0 0)), ((2 2, 2 3, 3 3, 3 2, 2 2)))",
            },
        },
    },
    "update": {
        "table": {
            "summary": "Table Layer",
            "value": {
                **content_base_example,
            },
        },
    },
}
