"""Value forms (the specification's sections 4.1 to 4.4 and 18.3).

A property is fixed, by zoom (`{"zoom": [[z, v], ...]}`) or by attribute
(`{"field": ..., "palette" | "range": ...}`); a field alone uses the field's value
as it is. `value_type` builds the annotation a property uses from the forms the
section 4.5 table allows it.
"""

import re
from typing import Annotated, Any, Literal, Union

from pydantic import BeforeValidator, Discriminator, Field, Tag, model_validator
from pydantic_core import PydanticCustomError

from goatlib.style import limits
from goatlib.style.models.base import LAX, StyleModel

HEX = r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
_HEX = re.compile(HEX)

Color = Annotated[str, Field(pattern=HEX)]
#: Opacities, bounded as MapLibre bounds the opacities they compile to (goatlib.style.limits).
Unit = Annotated[
    float,
    Field(
        **limits.bounds(
            "fill.opacity",
            "outline.opacity",
            "line.opacity",
            "casing.opacity",
            "marker.opacity",
            "heatmap.opacity",
            "h3.opacity",
            "opacity",
            "raster.opacity",
        )
    ),
]
#: Screen pixels: widths, sizes and spacings.
Px = Annotated[
    float,
    Field(
        **limits.bounds(
            "outline.width",
            "line.width",
            "line.blur",
            "casing.width",
            "arrows.size",
            "marker.size",
            "label.size",
            "label.max_width",
            "label.halo.width",
            "label.lines.size",
            "fill.pattern_spacing",
            "fill.pattern_width",
            "cluster.radius",
            "h3.outline.width",
        )
    ),
]
#: A zoom level within MapLibre's layer zoom range.
ZoomLevel = Annotated[float, Field(**limits.bounds("zoom"))]


def _check_palette(v: Any) -> Any:
    if isinstance(v, str) and v:
        return v
    if isinstance(v, list):
        if not 2 <= len(v) <= 12:
            raise PydanticCustomError(
                "invalid_value", "An inline palette has 2 to 12 colors."
            )
        if not all(isinstance(c, str) and _HEX.fullmatch(c) for c in v):
            raise PydanticCustomError(
                "invalid_value", "Inline palette colors are hex strings like #2166ac."
            )
        return v
    raise PydanticCustomError(
        "invalid_value",
        "A palette is a catalogue id like d3:viridis or a list of colors.",
    )


PaletteRef = Annotated[Union[str, list[str]], BeforeValidator(_check_palette)]


def _check_pair(code: str, what: str) -> Any:
    def check(v: Any) -> Any:
        if (
            isinstance(v, (list, tuple))
            and len(v) == 2
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)
        ):
            if code == "domain_invalid" and not v[0] < v[1]:
                raise PydanticCustomError(code, f"The {what} must go from low to high.")
            if code == "range_invalid" and v[0] > v[1]:
                raise PydanticCustomError(code, f"The {what} must go from low to high.")
            return v
        raise PydanticCustomError(
            "invalid_value", f"The {what} is a list of two numbers."
        )

    return check


Domain = Annotated[
    tuple[float, float], BeforeValidator(_check_pair("domain_invalid", "domain")), LAX
]
Range = Annotated[
    tuple[float, float], BeforeValidator(_check_pair("range_invalid", "range")), LAX
]


def _no_zoom_inside(data: Any) -> Any:
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, dict) and "zoom" in value:
                raise PydanticCustomError(
                    "zoom_nesting",
                    "Zoom stops go outside an attribute mapping, never inside it (zoom outside, attribute inside).",
                )
    return data


class Generated(StyleModel):
    """What the server wrote into a classification's classes: the target and the
    value per class id. A class value still equal to it follows the palette or
    range; one changed by hand stays (section 12)."""

    target: str
    values: dict[str, str | float]


class Computed(StyleModel):
    """What the server computed and from which data (section 12)."""

    at: str
    data: str
    scope: Literal["dataset"] = "dataset"
    domain: Annotated[tuple[float, float], LAX] | None = None
    generated: Generated | None = None


Scale = Literal["linear", "sqrt", "log"]


def _log_domain_above_zero(form: Any) -> Any:
    if form.scale == "log" and form.domain is not None and form.domain[0] <= 0:
        raise PydanticCustomError(
            "domain_invalid", "A log scale needs a domain that starts above 0."
        )
    return form


class ByAttributeColor(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    palette: PaletteRef
    reverse: bool = False
    scale: Scale = "linear"
    domain: Domain | None = None
    no_data: Color | None = None
    title: str | None = None
    computed: Computed | None = None

    _nesting = model_validator(mode="before")(_no_zoom_inside)
    _log_domain = model_validator(mode="after")(_log_domain_above_zero)


class ByAttributeNumber(StyleModel):
    field: Annotated[str, Field(min_length=1)]
    range: Range
    scale: Scale = "linear"
    domain: Domain | None = None
    no_data: float | None = None
    title: str | None = None
    computed: Computed | None = None

    _nesting = model_validator(mode="before")(_no_zoom_inside)
    _log_domain = model_validator(mode="after")(_log_domain_above_zero)


class RawField(StyleModel):
    """A field's value used as it is: degrees for a rotation, hex colors from a text field."""

    field: Annotated[str, Field(min_length=1)]
    no_data: Any = None


def _check_stops(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    stops = data.get("zoom")
    if not isinstance(stops, list) or len(stops) < 2:
        raise PydanticCustomError(
            "zoom_stops", "By zoom needs at least two [zoom, value] stops."
        )
    zooms = []
    for stop in stops:
        if not isinstance(stop, (list, tuple)) or len(stop) != 2:
            raise PydanticCustomError(
                "zoom_stops", "Each zoom stop is a [zoom, value] pair."
            )
        if isinstance(stop[1], dict) and "zoom" in stop[1]:
            raise PydanticCustomError(
                "zoom_nesting", "Zoom stops cannot hold zoom stops."
            )
        zooms.append(stop[0])
    if all(
        isinstance(z, (int, float)) and not isinstance(z, bool) for z in zooms
    ) and any(b <= a for a, b in zip(zooms, zooms[1:])):
        raise PydanticCustomError(
            "zoom_stops", "Zoom stops must be in ascending zoom order."
        )
    return data


class ZoomStops(StyleModel):
    """By zoom: at least two ascending `[zoom, value]` stops (section 4.2)."""

    zoom: list[Annotated[tuple[ZoomLevel, Any], LAX]]
    interpolate: Literal["linear", "exponential", "step"] = "linear"
    base: Annotated[float, Field(gt=0)] = 1.6

    _stops = model_validator(mode="before")(_check_stops)


def _need_step(self: Any) -> Any:
    if self.interpolate != "step":
        raise PydanticCustomError(
            "zoom_needs_step",
            'This property only switches at zoom stops: set "interpolate": "step".',
        )
    return self


def _form_of(v: Any) -> str:
    if isinstance(v, dict):
        if "zoom" in v:
            return "form:zoom"
        if "field" in v:
            return "form:attribute" if ("palette" in v or "range" in v) else "form:raw"
    return "form:fixed"


_ZOOM_MODELS: dict[tuple[str, bool], type[ZoomStops]] = {}


def _zoom_model(name: str, stop_value: Any, step_only: bool) -> type[ZoomStops]:
    key = (name, step_only)
    if key not in _ZOOM_MODELS:
        namespace: dict[str, Any] = {
            "__annotations__": {
                "zoom": list[Annotated[tuple[ZoomLevel, stop_value], LAX]]
            }
        }
        if step_only:
            namespace["_step"] = model_validator(mode="after")(_need_step)
        _ZOOM_MODELS[key] = type(
            f"Zoom{'Step' if step_only else ''}{name}", (ZoomStops,), namespace
        )
    return _ZOOM_MODELS[key]


def value_type(
    name: str,
    fixed: Any,
    *,
    zoom: Literal["blend", "step"] | None,
    attribute: Literal["color", "number"] | None,
) -> Any:
    """The annotation of a property: its fixed type plus the forms it allows.

    `name` names the generated zoom models in the JSON Schema (`ZoomColor`). A form
    the property does not allow is `value_form_not_allowed`.
    """
    attr_model = {"color": ByAttributeColor, "number": ByAttributeNumber, None: None}[
        attribute
    ]
    choices: list[Any] = [Annotated[fixed, Tag("form:fixed")]]
    if zoom:
        stop_value = fixed
        if attr_model is not None:
            stop_value = Annotated[
                Union[
                    Annotated[fixed, Tag("form:fixed")],
                    Annotated[attr_model, Tag("form:attribute")],
                    Annotated[RawField, Tag("form:raw")],
                ],
                Discriminator(
                    _form_of,
                    custom_error_type="value_form_not_allowed",
                    custom_error_message=f"A {name} zoom stop holds a fixed value or an attribute mapping.",
                ),
            ]
        choices.append(
            Annotated[_zoom_model(name, stop_value, zoom == "step"), Tag("form:zoom")]
        )
    if attr_model is not None:
        choices.append(Annotated[attr_model, Tag("form:attribute")])
        choices.append(Annotated[RawField, Tag("form:raw")])
    return Annotated[
        Union[tuple(choices)],
        Discriminator(
            _form_of,
            custom_error_type="value_form_not_allowed",
            custom_error_message=f"{name} does not take this value form here (section 4.5).",
        ),
    ]


def _check_decimals(v: Any) -> Any:
    if v == "auto" or (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 10):
        return v
    raise PydanticCustomError(
        "invalid_value", 'decimals is "auto" or a whole number from 0 to 10.'
    )


class NumberFormat(StyleModel):
    decimals: Annotated[
        Union[Literal["auto"], int], BeforeValidator(_check_decimals)
    ] = "auto"
    thousands_separator: bool = True
    abbreviate: bool = False
    always_show_sign: bool = False
    prefix: str | None = None
    suffix: str | None = None
