"""The map document: map state only (the specification's section 10)."""

from typing import Annotated, Any, Literal, Union

from pydantic import Discriminator, Field, Tag

from goatlib.style import limits
from goatlib.style.models.base import LAX, StyleModel


class Basemap(StyleModel):
    id: Annotated[str, Field(min_length=1)]


class View(StyleModel):
    center: Annotated[tuple[float, float], LAX] | None = None
    zoom: Annotated[float, Field(**limits.bounds("view.zoom"))] | None = None
    pitch: Annotated[float, Field(**limits.bounds("view.pitch"))] | None = None
    bearing: float | None = None
    bounds: Annotated[tuple[float, float, float, float], LAX] | None = None


class LayerTime(StyleModel):
    value: Any = None


class LayerLegendState(StyleModel):
    expanded: bool | None = None


class MapLayer(StyleModel):
    type: Literal["layer"]
    id: int
    visible: bool | None = None
    style: str | None = None
    position: str | None = None
    filter: dict[str, Any] | None = None
    time: LayerTime | None = None
    legend: LayerLegendState | None = None


class MapGroup(StyleModel):
    type: Literal["group"]
    id: int | None = None
    name: str | None = None
    visible: bool | None = None
    expanded: bool | None = None
    children: list["MapEntry"] | None = None


def _entry_of(v: Any) -> str:
    return f"entry:{v.get('type')}" if isinstance(v, dict) else "entry:?"


MapEntry = Annotated[
    Union[
        Annotated[MapLayer, Tag("entry:layer")], Annotated[MapGroup, Tag("entry:group")]
    ],
    Discriminator(
        _entry_of,
        custom_error_type="invalid_value",
        custom_error_message='An entry\'s type is "layer" or "group".',
    ),
]

MapGroup.model_rebuild()


class MapDocument(StyleModel):
    version: Literal[1]
    basemap: Basemap | None = None
    view: View | None = None
    locale: str | None = None
    layers: list[MapEntry] | None = None
