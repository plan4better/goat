"""How points are drawn: features, heatmap, clusters, H3 (the specification's sections 8 and 18.7)."""

from typing import Annotated, Any, Literal, Union

from pydantic import BeforeValidator, Discriminator, Field, Tag, model_validator
from pydantic_core import PydanticCustomError

from goatlib.style import limits
from goatlib.style.models.base import StyleModel
from goatlib.style.models.classify import ColorClassification
from goatlib.style.models.parts import LabelPart, MarkerPart, OutlinePart
from goatlib.style.models.values import (
    Color,
    Domain,
    PaletteRef,
    Px,
    Unit,
    ZoomLevel,
    value_type,
)

RadiusValue = value_type(
    "HeatmapRadius",
    Annotated[float, Field(**limits.bounds("heatmap.radius"))],
    **limits.forms("heatmap.radius", attribute=None),
)
IntensityValue = value_type(
    "Intensity",
    Annotated[float, Field(**limits.bounds("heatmap.intensity"))],
    **limits.forms("heatmap.intensity", attribute=None),
)
OpacityValue = value_type(
    "HeatmapOpacity", Unit, **limits.forms("heatmap.opacity", attribute=None)
)


class HeatmapWeight(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    domain: Domain | None = None


Weight = Annotated[
    Union[
        Annotated[float, Field(**limits.bounds("heatmap.weight")), Tag("weight:fixed")],
        Annotated[HeatmapWeight, Tag("weight:field")],
    ],
    Discriminator(lambda v: "weight:field" if isinstance(v, dict) else "weight:fixed"),
]


class FeaturesRender(StyleModel):
    type: Literal["features"]


class HeatmapRender(StyleModel):
    type: Literal["heatmap"]
    radius: RadiusValue | None = None
    intensity: IntensityValue | None = None
    opacity: OpacityValue | None = None
    weight: Weight | None = None
    palette: PaletteRef | None = None
    reverse: bool = False
    points_from_zoom: ZoomLevel | None = None


class ClusterSymbol(StyleModel):
    """Cluster points, styled over the derived field `count`."""

    marker: MarkerPart | None = None
    outline: OutlinePart | None = None
    label: LabelPart | None = None


class ClusterRender(StyleModel):
    type: Literal["cluster"]
    radius: Px | None = None
    cluster_until_zoom: ZoomLevel | None = None
    min_points: Annotated[int, Field(**limits.bounds("cluster.min_points"))] | None = (
        None
    )
    symbol: ClusterSymbol | None = None


class H3Value(StyleModel):
    op: Literal["count", "sum", "mean"]
    field: str | None = None

    @model_validator(mode="after")
    def _field_for_sum_and_mean(self) -> "H3Value":
        if self.op != "count" and not self.field:
            raise PydanticCustomError("missing_required", "sum and mean need a field.")
        return self


class H3Outline(StyleModel):
    color: Color | None = None
    width: Px | None = None


def _check_resolution(v: Any) -> Any:
    if v == "auto" or (isinstance(v, int) and not isinstance(v, bool) and 5 <= v <= 10):
        return v
    raise PydanticCustomError(
        "invalid_value", 'resolution is "auto" or a whole number from 5 to 10.'
    )


class H3Cells(StyleModel):
    """The cell values of one resolution: their range, and the inner breaks of a
    computed classification."""

    min: float | None = None
    max: float | None = None
    breaks: list[float] | None = None


class H3Computed(StyleModel):
    """What the server computed for an H3 render (section 12), by resolution."""

    at: str
    data: str
    scope: Literal["dataset"] = "dataset"
    resolutions: dict[str, H3Cells] = {}


class H3Render(StyleModel):
    type: Literal["h3"]
    resolution: (
        Annotated[Union[Literal["auto"], int], BeforeValidator(_check_resolution)]
        | None
    ) = None
    value: H3Value | None = None
    palette: PaletteRef | None = None
    reverse: bool = False
    classify: ColorClassification | None = None
    opacity: Unit | None = None
    outline: H3Outline | None = None
    points_from_zoom: ZoomLevel | None = None
    computed: H3Computed | None = None


def _type_of(v: Any) -> str:
    return f"render:{v.get('type')}" if isinstance(v, dict) else "render:?"


VectorRender = Annotated[
    Union[
        Annotated[FeaturesRender, Tag("render:features")],
        Annotated[HeatmapRender, Tag("render:heatmap")],
        Annotated[ClusterRender, Tag("render:cluster")],
        Annotated[H3Render, Tag("render:h3")],
    ],
    Discriminator(
        _type_of,
        custom_error_type="invalid_value",
        custom_error_message="render type is features, heatmap, cluster or h3.",
    ),
]
