"""Parts (the specification's sections 3 and 18.2).

Which value forms each property takes follows the section 4.5 table: colors,
widths, sizes and opacities blend by zoom and map attributes; choices and icons
switch at zoom stops only; per-layer keys are fixed.
"""

from typing import Annotated, Any, Literal, Union

from pydantic import BeforeValidator, Discriminator, Field, Tag
from pydantic_core import PydanticCustomError

from goatlib.style import limits
from goatlib.style.models.base import LAX, StyleModel
from goatlib.style.models.values import (
    HEX,
    Color,
    NumberFormat,
    Px,
    Unit,
    ZoomLevel,
    value_type,
)

PATTERNS = (
    "none",
    "hatch_45",
    "hatch_135",
    "vertical",
    "horizontal",
    "cross",
    "grid",
    "dots",
)


def _check_pattern(v: Any) -> Any:
    if isinstance(v, str) and v not in PATTERNS:
        raise PydanticCustomError(
            "unknown_pattern",
            "Patterns are none, hatch_45, hatch_135, vertical, horizontal, cross, grid and dots.",
        )
    return v


Pattern = Annotated[
    Literal[
        "none",
        "hatch_45",
        "hatch_135",
        "vertical",
        "horizontal",
        "cross",
        "grid",
        "dots",
    ],
    BeforeValidator(_check_pattern),
]
Dash = Literal["solid", "dashed", "dotted", "dash_dot"]
#: `<library>:<name>` (`goat:park`, `emoji:1f525`) or `asset:<id>` for an uploaded icon;
#: which libraries exist is checked against the catalogue (`unknown_icon`).
IconRef = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*:[A-Za-z0-9._-]+$")]
ColorOrFill = Annotated[str, Field(pattern=HEX[:-1] + "|^fill$")]
XY = Annotated[tuple[float, float], LAX]

ColorValue = value_type(
    "Color",
    Color,
    **limits.forms(
        "fill.color",
        "fill.pattern_color",
        "line.color",
        "casing.color",
        "arrows.color",
        "marker.color",
        "marker.icon_color",
        "label.color",
        "label.halo.color",
        attribute="color",
    ),
)
OutlineColorValue = value_type(
    "OutlineColor", ColorOrFill, **limits.forms("outline.color", attribute="color")
)
UnitValue = value_type(
    "Unit",
    Unit,
    **limits.forms(
        "fill.opacity",
        "outline.opacity",
        "line.opacity",
        "casing.opacity",
        "marker.opacity",
        attribute="number",
    ),
)
PxValue = value_type(
    "Px",
    Px,
    **limits.forms(
        "outline.width",
        "line.width",
        "line.blur",
        "casing.width",
        "arrows.size",
        "marker.size",
        "label.size",
        "label.max_width",
        "label.halo.width",
        attribute="number",
    ),
)
#: A line's sideways shift in px: negative draws it on the other side.
LineOffsetValue = value_type(
    "LineOffset",
    Annotated[float, Field(**limits.bounds("line.offset"))],
    **limits.forms("line.offset", attribute="number"),
)
DegreesValue = value_type(
    "Degrees", float, **limits.forms("marker.rotation", attribute="number")
)
OffsetValue = value_type(
    "Offset", XY, **limits.forms("marker.offset", "label.offset", attribute=None)
)
SpacingValue = value_type(
    "Spacing",
    Annotated[float, Field(**limits.bounds("arrows.spacing"))],
    **limits.forms("arrows.spacing", attribute=None),
)
DashValue = value_type(
    "Dash", Dash, **limits.forms("line.dash", "outline.dash", attribute=None)
)
CapValue = value_type(
    "Cap",
    Literal["butt", "round", "square"],
    **limits.forms("line.cap", attribute=None),
)
JoinValue = value_type(
    "Join",
    Literal["miter", "round", "bevel"],
    **limits.forms("line.join", attribute=None),
)
PatternValue = value_type(
    "Pattern", Pattern, **limits.forms("fill.pattern", attribute=None)
)
#: A pattern's spacing and line width (dot size): each value is an image of its own, so they switch at zoom stops
#: and per class but take no continuous mapping by attribute.
PatternPxValue = value_type(
    "PatternPx",
    Px,
    **limits.forms("fill.pattern_spacing", "fill.pattern_width", attribute=None),
)
IconValue = value_type("Icon", IconRef, **limits.forms("marker.icon", attribute=None))
AnchorValue = value_type(
    "Anchor",
    Literal[
        "center",
        "top",
        "bottom",
        "left",
        "right",
        "top_left",
        "top_right",
        "bottom_left",
        "bottom_right",
    ],
    **limits.forms("marker.anchor", attribute=None),
)
WeightValue = value_type(
    "Weight",
    Literal["regular", "bold"],
    **limits.forms("label.font.weight", attribute=None),
)


class _Part(StyleModel):
    min_zoom: ZoomLevel | None = None
    max_zoom: ZoomLevel | None = None


class Fill(_Part):
    color: ColorValue | None = None
    opacity: UnitValue | None = None
    pattern: PatternValue | None = None
    pattern_color: ColorValue | None = None
    pattern_spacing: PatternPxValue | None = None
    pattern_width: PatternPxValue | None = None


class Outline(_Part):
    color: OutlineColorValue | None = None
    width: PxValue | None = None
    opacity: UnitValue | None = None
    dash: DashValue | None = None


class Line(_Part):
    color: ColorValue | None = None
    width: PxValue | None = None
    opacity: UnitValue | None = None
    dash: DashValue | None = None
    cap: CapValue | None = None
    join: JoinValue | None = None
    offset: LineOffsetValue | None = None
    blur: PxValue | None = None


class Casing(_Part):
    color: ColorValue | None = None
    width: PxValue | None = None
    opacity: UnitValue | None = None


class Arrows(_Part):
    placement: Literal["repeat", "center", "start", "end", "both_ends"] | None = None
    direction: Literal["forward", "backward", "both"] | None = None
    spacing: SpacingValue | None = None
    size: PxValue | None = None
    color: ColorValue | None = None


#: A marker's shape (3.3): a shape the icon sits in, a pin that points at its place
#: with its tip, or the icon alone.
MarkerShape = Literal[
    "circle",
    "square",
    "diamond",
    "hexagon",
    "shield",
    "pin",
    "round_pin",
    "needle",
    "square_pin",
    "tag_pin",
    "flag",
    "icon",
]


class Marker(_Part):
    shape: MarkerShape | None = None
    color: ColorValue | None = None
    #: `false` draws the marker hollow: its outline and its icon only (3.3).
    fill: bool | None = None
    size: PxValue | None = None
    opacity: UnitValue | None = None
    icon: IconValue | None = None
    icon_color: ColorValue | None = None
    rotation: DegreesValue | None = None
    anchor: AnchorValue | None = None
    offset: OffsetValue | None = None
    allow_overlap: bool | None = None


class Halo(StyleModel):
    color: ColorValue | None = None
    width: PxValue | None = None


class Font(StyleModel):
    weight: WeightValue | None = None


class LabelLine(StyleModel):
    """The style of one line of a multi-line label (fixed values only)."""

    size: Px | None = None
    color: Color | None = None
    font: Font | None = None


class Priority(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    top: Literal["largest", "smallest"]


class Label(_Part):
    text: str | None = None
    format: NumberFormat | None = None
    formats: dict[str, NumberFormat] | None = None
    size: PxValue | None = None
    color: ColorValue | None = None
    halo: Halo | None = None
    font: Font | None = None
    placement: Literal["auto", "above", "center", "line", "inside"] | None = None
    offset: OffsetValue | None = None
    max_width: PxValue | None = None
    lines: list[LabelLine] | None = None
    priority: Priority | None = None
    allow_overlap: bool | None = None


def _on_off(v: Any) -> str:
    return "part:off" if v is False else "part:on"


def switchable(model: type[StyleModel]) -> Any:
    """A part that `false` switches off."""
    return Annotated[
        Union[
            Annotated[model, Tag("part:on")], Annotated[Literal[False], Tag("part:off")]
        ],
        Discriminator(_on_off),
    ]


PARTS: dict[str, type[StyleModel]] = {
    "fill": Fill,
    "outline": Outline,
    "line": Line,
    "casing": Casing,
    "arrows": Arrows,
    "marker": Marker,
    "label": Label,
}

#: Keys that hold one value for the whole layer and may be set in one place only (6.1):
#: those MapLibre takes no data-driven value for, and GOAT's own (goatlib.style.limits).
PER_LAYER_KEYS = limits.per_layer(
    {key for key in limits.SETTINGS if key.split(".")[0] in PARTS}
)


FillPart = switchable(Fill)
OutlinePart = switchable(Outline)
LinePart = switchable(Line)
CasingPart = switchable(Casing)
ArrowsPart = switchable(Arrows)
MarkerPart = switchable(Marker)
LabelPart = switchable(Label)


class Symbol(StyleModel):
    fill: FillPart | None = None
    outline: OutlinePart | None = None
    line: LinePart | None = None
    casing: CasingPart | None = None
    arrows: ArrowsPart | None = None
    marker: MarkerPart | None = None
    label: LabelPart | None = None
