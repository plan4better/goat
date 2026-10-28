"""The layer style document (the specification's sections 2 and 18.1)."""

from typing import Annotated, Any, Literal, Union

from pydantic import BeforeValidator, Discriminator, Field, Tag
from pydantic_core import PydanticCustomError

from goatlib.style.models.base import StyleModel
from goatlib.style.models.classify import Classification
from goatlib.style.models.parts import Symbol
from goatlib.style.models.popup import Popup
from goatlib.style.models.raster import LayerOpacityValue, RasterStyle
from goatlib.style.models.render import VectorRender
from goatlib.style.models.rules import Rule
from goatlib.style.models.values import ZoomLevel


class Legend(StyleModel):
    show: bool | None = None
    title: str | None = None
    caption: str | None = None


class OrderByField(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    top: Literal["smallest", "largest"]


class OrderByClasses(StyleModel):
    by: Literal["classes"]


Order = Annotated[
    Union[
        Annotated[OrderByField, Tag("order:field")],
        Annotated[OrderByClasses, Tag("order:classes")],
    ],
    Discriminator(
        lambda v: "order:classes"
        if isinstance(v, dict) and "by" in v
        else "order:field"
    ),
]


def _check_step(v: Any) -> Any:
    if v in ("year", "month", "day") or (
        isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0
    ):
        return v
    raise PydanticCustomError(
        "invalid_value", "step is a positive number, or year, month or day."
    )


class Time(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    step: (
        Annotated[
            Union[float, Literal["year", "month", "day"]], BeforeValidator(_check_step)
        ]
        | None
    ) = None


class VectorStyle(StyleModel):
    version: Literal[1]
    kind: Literal["vector"]
    geometry: Literal["point", "line", "polygon"] | None = None
    opacity: LayerOpacityValue | None = None
    min_zoom: ZoomLevel | None = None
    max_zoom: ZoomLevel | None = None
    symbol: Symbol | None = None
    classify: Annotated[list[Classification], Field(max_length=50)] | None = None
    rules: Annotated[list[Rule], Field(max_length=200)] | None = None
    order: Order | None = None
    legend: Union[Legend, Literal[False]] | None = None
    time: Time | None = None
    popup: Union[Popup, Literal[False]] | None = None
    render: VectorRender | None = None
    ext: dict[str, Any] | None = None


def _kind_of(v: Any) -> str:
    return f"kind:{v.get('kind')}" if isinstance(v, dict) else "kind:?"


LayerStyle = Annotated[
    Union[
        Annotated[VectorStyle, Tag("kind:vector")],
        Annotated[RasterStyle, Tag("kind:raster")],
    ],
    Discriminator(
        _kind_of,
        custom_error_type="invalid_value",
        custom_error_message='kind is "vector" or "raster".',
    ),
]
