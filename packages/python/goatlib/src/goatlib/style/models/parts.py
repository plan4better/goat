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
#: An outline color: a color, `"fill"` (the color the main part draws) or `"auto"`
#: (a darker shade of it, `goatlib.style.colors.shade`).
OutlineColor = Annotated[str, Field(pattern=f"^({HEX[1:-1]}|fill|auto)$")]
#: A casing color: a color or `"auto"` (a darker shade of the line's color).
CasingColor = Annotated[str, Field(pattern=f"^({HEX[1:-1]}|auto)$")]
#: An H3 outline color: a color or `"auto"` (a darker shade of each hexagon's color).
H3OutlineColor = Annotated[str, Field(pattern=f"^({HEX[1:-1]}|auto)$")]
XY = Annotated[tuple[float, float], LAX]

ColorValue = value_type(
    "Color",
    Color,
    **limits.forms(
        "fill.color",
        "fill.pattern_color",
        "line.color",
        "arrows.color",
        "marker.color",
        "marker.icon_color",
        "label.color",
        "label.halo.color",
        attribute="color",
    ),
)
OutlineColorValue = value_type(
    "OutlineColor", OutlineColor, **limits.forms("outline.color", attribute="color")
)
CasingColorValue = value_type(
    "CasingColor", CasingColor, **limits.forms("casing.color", attribute="color")
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
ArrowIconValue = value_type(
    "ArrowIcon", IconRef, **limits.forms("arrows.icon", attribute=None)
)
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
    Literal["light", "regular", "medium", "bold"],
    **limits.forms("label.font.weight", attribute=None),
)
#: A label's letters upright or slanted.
FontStyleValue = value_type(
    "FontStyle",
    Literal["normal", "italic"],
    **limits.forms("label.font.style", attribute=None),
)
#: A label's letters as written, in capitals or in small letters.
TransformValue = value_type(
    "Transform",
    Literal["none", "uppercase", "lowercase"],
    **limits.forms("label.transform", attribute=None),
)
#: Extra space between a label's letters in ems of its size: negative draws them closer.
LetterSpacingValue = value_type(
    "LetterSpacing",
    Annotated[float, Field(**limits.bounds("label.letter_spacing"))],
    **limits.forms("label.letter_spacing", attribute=None),
)
#: The distance between the lines of a label in ems of its size, for the whole layer.
LineHeightValue = value_type(
    "LineHeight",
    Annotated[float, Field(**limits.bounds("label.line_height"))],
    **limits.forms("label.line_height", attribute=None),
)
#: How far apart a label along a line repeats, in px, for the whole layer.
LabelSpacingValue = value_type(
    "LabelSpacing",
    Annotated[float, Field(**limits.bounds("label.spacing"))],
    **limits.forms("label.spacing", attribute=None),
)
#: The free space in px kept around each label, for the whole layer.
LabelPaddingValue = value_type(
    "LabelPadding",
    Annotated[float, Field(**limits.bounds("label.padding"))],
    **limits.forms("label.padding", attribute=None),
)
#: Where a polygon's outline runs: centred on the edge, or all of its width inside or outside the polygon.
OutlinePositionValue = value_type(
    "OutlinePosition",
    Literal["center", "inside", "outside"],
    **limits.forms("outline.position", attribute=None),
)

#: Heights in metres above the ground, fixed, by zoom or by attribute (raw fields
#: count storeys when the part's `unit` says so).
HeightValue = value_type(
    "Height",
    Annotated[float, Field(**limits.bounds("extrude.height", "extrude.base"))],
    **limits.forms("extrude.height", "extrude.base", attribute="number"),
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
    position: OutlinePositionValue | None = None


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
    color: CasingColorValue | None = None
    width: PxValue | None = None
    opacity: UnitValue | None = None


class Arrows(_Part):
    placement: Literal["repeat", "center", "start", "end", "both_ends"] | None = None
    direction: Literal["forward", "backward", "both"] | None = None
    spacing: SpacingValue | None = None
    size: PxValue | None = None
    color: ColorValue | None = None
    #: The icon drawn as the arrow, its top pointing the way the arrow points; one for
    #: the whole layer. GOAT's arrow (`goat:arrow`) when absent.
    icon: ArrowIconValue | None = None
    #: Whether the icon turns with the line (its top along the line, the way the arrow
    #: points) or stays upright on the screen; one for the whole layer. Turns when absent.
    turn_with_line: bool | None = None


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
    style: FontStyleValue | None = None


class LabelLine(StyleModel):
    """The style of one line of a multi-line label (fixed values only)."""

    size: Px | None = None
    color: Color | None = None
    font: Font | None = None


class Priority(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    top: Literal["largest", "smallest"]


#: The sides of a marker a label can sit on, named by where the label sits.
_SIDES = (
    "above",
    "below",
    "left",
    "right",
    "above_left",
    "above_right",
    "below_left",
    "below_right",
)

#: Where a label sits, per geometry (3.4). Beside a point it is named by the side of the marker it sits on;
#: `auto` lets MapLibre pick a side, `center` puts it on the point. A line's label sits along the line (`line`) or
#: at its center point, and an area's at its label point; both take the point's positions there, with `center`
#: (lines) and `inside` (polygons) for the middle.
LABEL_PLACEMENTS: dict[str, tuple[str, ...]] = {
    "point": ("auto", "center", *_SIDES),
    "line": ("line", "auto", "center", *_SIDES),
    "polygon": ("auto", "inside", *_SIDES),
}

LabelPlacement = Literal[
    "auto",
    "center",
    "above",
    "below",
    "left",
    "right",
    "above_left",
    "above_right",
    "below_left",
    "below_right",
    "line",
    "inside",
]


class Label(_Part):
    text: str | None = None
    format: NumberFormat | None = None
    formats: dict[str, NumberFormat] | None = None
    size: PxValue | None = None
    color: ColorValue | None = None
    halo: Halo | None = None
    font: Font | None = None
    placement: LabelPlacement | None = None
    offset: OffsetValue | None = None
    max_width: PxValue | None = None
    transform: TransformValue | None = None
    letter_spacing: LetterSpacingValue | None = None
    line_height: LineHeightValue | None = None
    spacing: LabelSpacingValue | None = None
    padding: LabelPaddingValue | None = None
    lines: list[LabelLine] | None = None
    priority: Priority | None = None
    allow_overlap: bool | None = None


class Extrude(_Part):
    """The height part of polygons: each feature drawn as a volume from `base` to `height`."""

    height: HeightValue | None = None
    base: HeightValue | None = None
    #: How raw field values count: metres, or storeys of 3 m. Fixed values, zoom
    #: stops and attribute ranges are always metres.
    unit: Literal["m", "storeys"] | None = None


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
    "extrude": Extrude,
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
ExtrudePart = switchable(Extrude)


class Symbol(StyleModel):
    fill: FillPart | None = None
    outline: OutlinePart | None = None
    line: LinePart | None = None
    casing: CasingPart | None = None
    arrows: ArrowsPart | None = None
    marker: MarkerPart | None = None
    label: LabelPart | None = None
    extrude: ExtrudePart | None = None
