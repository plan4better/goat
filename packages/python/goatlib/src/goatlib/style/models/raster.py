"""Raster styles and map services (the specification's sections 9 and 18.8)."""

from typing import Annotated, Any, Literal, Union

from pydantic import BeforeValidator, Discriminator, Field, Tag, model_validator
from pydantic_core import PydanticCustomError

from goatlib.style import limits
from goatlib.style.models.base import LAX, StyleModel
from goatlib.style.models.classify import ColorClassification
from goatlib.style.models.popup import RasterPopup
from goatlib.style.models.values import (
    Color,
    Computed,
    Domain,
    PaletteRef,
    Unit,
    ZoomLevel,
    value_type,
)


class NoData(StyleModel):
    values: list[float]


class BandFormula(StyleModel):
    name: Annotated[str, Field(min_length=1)]
    expression: Annotated[str, Field(min_length=1)]


def _check_band(v: Any) -> Any:
    if isinstance(v, dict) or (
        isinstance(v, int) and not isinstance(v, bool) and v >= 1
    ):
        return v
    raise PydanticCustomError(
        "invalid_value", "A band is a number from 1 or { name, expression }."
    )


Band = Annotated[Union[int, BandFormula], BeforeValidator(_check_band)]


def _check_bands(v: Any) -> Any:
    if (
        isinstance(v, list)
        and len(v) == 3
        and all(isinstance(b, int) and not isinstance(b, bool) and b >= 1 for b in v)
    ):
        return v
    raise PydanticCustomError(
        "invalid_value", "bands is three band numbers: red, green, blue."
    )


class ImageRender(StyleModel):
    type: Literal["image"]
    bands: (
        Annotated[tuple[int, int, int], BeforeValidator(_check_bands), LAX] | None
    ) = None
    no_data: NoData | None = None
    service_style: str | None = None


class Stop(StyleModel):
    value: float
    color: Color


class _Ramp(StyleModel):
    band: Band | None = None
    no_data: NoData | None = None
    palette: PaletteRef | None = None
    reverse: bool = False
    domain: Domain | None = None
    classify: ColorClassification | None = None
    outside: Literal["clamp", "hide"] | None = None
    #: The band's range as the default domain (section 12), written by the server.
    computed: Computed | None = None


class ContinuousRender(_Ramp):
    type: Literal["continuous"]
    stops: list[Stop] | None = None
    interpolate: Literal["linear", "nearest"] | None = None

    @model_validator(mode="after")
    def _palette_or_stops(self) -> "ContinuousRender":
        if self.palette is not None and self.stops is not None:
            raise PydanticCustomError(
                "invalid_value", "Use a palette or stops, not both."
            )
        stops = self.stops or []
        if any(b.value <= a.value for a, b in zip(stops, stops[1:])):
            raise PydanticCustomError(
                "stops_order", "Stops must be in ascending value order."
            )
        return self


class CategoryClass(StyleModel):
    value: float
    name: str | None = None
    color: Color | None = None
    visible: bool | None = None
    legend: Literal[False] | None = None


class CategoricalRender(StyleModel):
    type: Literal["categorical"]
    band: Band | None = None
    no_data: NoData | None = None
    classes: list[CategoryClass] | None = None
    other_color: Color | None = None


class TerrainRender(_Ramp):
    type: Literal["terrain"]
    method: (
        Literal["standard", "multidirectional", "combined", "igor", "basic"] | None
    ) = None
    direction: Annotated[float, Field(**limits.bounds("terrain.direction"))] | None = (
        None
    )
    altitude: Annotated[float, Field(**limits.bounds("terrain.altitude"))] | None = None
    exaggeration: (
        Annotated[float, Field(**limits.bounds("terrain.exaggeration"))] | None
    ) = None
    shadow_color: Color | None = None
    highlight_color: Color | None = None
    accent_color: Color | None = None


def _type_of(v: Any) -> str:
    return f"render:{v.get('type')}" if isinstance(v, dict) else "render:?"


RasterRender = Annotated[
    Union[
        Annotated[ImageRender, Tag("render:image")],
        Annotated[ContinuousRender, Tag("render:continuous")],
        Annotated[CategoricalRender, Tag("render:categorical")],
        Annotated[TerrainRender, Tag("render:terrain")],
    ],
    Discriminator(
        _type_of,
        custom_error_type="invalid_value",
        custom_error_message="render type is image, continuous, categorical or terrain.",
    ),
]


class RasterLegend(StyleModel):
    show: bool | None = None
    title: str | None = None
    caption: str | None = None
    unit: str | None = None
    min_label: str | None = None
    max_label: str | None = None


LayerOpacityValue = value_type(
    "LayerOpacity", Unit, **limits.forms("opacity", "raster.opacity", attribute=None)
)
Adjustment = Annotated[
    float,
    Field(**limits.bounds("raster.brightness", "raster.contrast", "raster.saturation")),
]
ADJUSTMENTS = ("brightness", "contrast", "saturation", "hue")


class RasterStyle(StyleModel):
    version: Literal[1]
    kind: Literal["raster"]
    opacity: LayerOpacityValue | None = None
    min_zoom: ZoomLevel | None = None
    max_zoom: ZoomLevel | None = None
    resampling: Literal["linear", "nearest"] | None = None
    render: RasterRender | None = None
    legend: Union[RasterLegend, Literal[False]] | None = None
    popup: Union[RasterPopup, Literal[False]] | None = None
    brightness: Adjustment | None = None
    contrast: Adjustment | None = None
    saturation: Adjustment | None = None
    hue: float | None = None
    ext: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _adjustments_on_images_only(self) -> "RasterStyle":
        render_type = getattr(self.render, "type", "image")
        if render_type != "image" and any(
            getattr(self, k) is not None for k in ADJUSTMENTS
        ):
            raise PydanticCustomError(
                "unknown_key",
                "brightness, contrast, saturation and hue apply to image renders only.",
            )
        return self
