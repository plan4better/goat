"""Popups (the specification's section 7.4)."""

from typing import Annotated, Any, Literal, Union

from pydantic import Discriminator, Field, Tag

from goatlib.style.models.base import StyleModel
from goatlib.style.models.values import Color, NumberFormat


class FieldAttribute(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    label: str | None = None
    type: Literal["string", "number", "boolean"] | None = None
    format: NumberFormat | None = None


class FieldListBlock(StyleModel):
    id: str | None = None
    type: Literal["field_list"]
    layout: Literal["table", "list"] | None = None
    attributes: list[FieldAttribute] | None = None
    collapse_after: Annotated[int, Field(ge=1, le=50)] | None = None


class TextBlock(StyleModel):
    id: str | None = None
    type: Literal["text"]
    html: str | None = None


class ImageBlock(StyleModel):
    id: str | None = None
    type: Literal["image"]
    source: Literal["field", "static"] | None = None
    field: str | None = None
    url: str | None = None
    sizing: Literal["fit", "fixed", "aspect"] | None = None
    height: Annotated[int, Field(ge=40, le=400)] | None = None
    aspect: Literal["16/9", "4/3", "3/2", "1/1", "2/3"] | None = None


class ButtonBlock(StyleModel):
    id: str | None = None
    type: Literal["button"]
    label: str | None = None
    url_template: str | None = None
    style: Literal["link", "outlined", "filled"] | None = None
    color: Color | None = None


class BadgeBlock(StyleModel):
    id: str | None = None
    type: Literal["badge"]
    field: str | None = None
    mode: Literal["single", "per_value"] | None = None
    color: Color | None = None
    palette: dict[str, Color] | None = None
    labels: dict[str, str] | None = None
    full_width: bool | None = None


class DividerBlock(StyleModel):
    id: str | None = None
    type: Literal["divider"]
    thickness: Annotated[int, Field(ge=1, le=8)] | None = None
    color: Color | None = None


def _block_of(v: Any) -> str:
    return f"block:{v.get('type')}" if isinstance(v, dict) else "block:?"


Block = Annotated[
    Union[
        Annotated[FieldListBlock, Tag("block:field_list")],
        Annotated[TextBlock, Tag("block:text")],
        Annotated[ImageBlock, Tag("block:image")],
        Annotated[ButtonBlock, Tag("block:button")],
        Annotated[BadgeBlock, Tag("block:badge")],
        Annotated[DividerBlock, Tag("block:divider")],
    ],
    Discriminator(
        _block_of,
        custom_error_type="invalid_value",
        custom_error_message="A block's type is field_list, text, image, button, badge or divider.",
    ),
]


class Popup(StyleModel):
    enabled: bool | None = None
    trigger: Literal["click", "hover", "click_and_hover"] | None = None
    mode: Literal["simple", "html"] | None = None
    blocks: list[Block] | None = None
    html: str | None = None
    layout: (
        Literal["popup", "pinned", "modal", "left_sidebar", "right_sidebar"] | None
    ) = None
    anchor: Literal["top_left", "top_right", "bottom_left", "bottom_right"] | None = (
        None
    )
    width: Annotated[int, Field(ge=1, le=4000)] | None = None
    max_height: Annotated[int, Field(ge=1, le=4000)] | None = None
    header: Literal["standard", "compact", "none"] | None = None
    highlight_active_feature: bool | None = None


class RasterPopup(StyleModel):
    """A raster's popup: the cell values from the raster service, or a map service's feature info."""

    enabled: bool | None = None
    trigger: Literal["click", "hover"] | None = None
    bands: Literal["styled", "all"] | None = None
