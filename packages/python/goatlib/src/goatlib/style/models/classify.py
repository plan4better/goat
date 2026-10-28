"""Classifications and class records (the specification's sections 5 and 18.4, 18.5)."""

from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, BeforeValidator, Field, model_validator
from pydantic_core import PydanticCustomError

from goatlib.style.cql import as_text
from goatlib.style.models.base import StyleModel
from goatlib.style.models.parts import PARTS
from goatlib.style.models.rules import Overrides, Scalar, WholeZoom
from goatlib.style.models.values import (
    ByAttributeColor,
    ByAttributeNumber,
    Color,
    Computed,
    NumberFormat,
    PaletteRef,
    Range,
)

NUMERIC_METHODS = (
    "quantile",
    "equal_interval",
    "natural_breaks",
    "std_dev",
    "heads_and_tails",
)
Method = Literal[
    "categories",
    "quantile",
    "equal_interval",
    "natural_breaks",
    "std_dev",
    "heads_and_tails",
    "manual",
]
NumericMethod = Literal[
    "quantile",
    "equal_interval",
    "natural_breaks",
    "std_dev",
    "heads_and_tails",
    "manual",
]


def _target_paths() -> frozenset[str]:
    """Every property a classification can name as its target: `part.key`, and the
    halo and font keys of labels. Per-layer keys are listed too; the document
    checks report them (`override_not_per_feature`)."""
    paths = {
        f"{part}.{key}"
        for part, model in PARTS.items()
        for key in model.model_fields
        if key not in ("min_zoom", "max_zoom", "halo", "font")
    }
    return frozenset(
        paths | {"label.halo.color", "label.halo.width", "label.font.weight"}
    )


TARGET_PATHS = _target_paths()

#: The most classes or top values a classification may ask the server for, as
#: processes caps the breaks of its class-breaks process: `count` sizes the work.
MAX_COUNT = 100


def _target_kind(path: str) -> Literal["color", "number", "choice"]:
    model: Any = PARTS[path.split(".")[0]]
    *nested, key = path.split(".")[1:]
    for name in nested:
        model = next(
            a
            for a in get_args(model.model_fields[name].annotation)
            if isinstance(a, type) and issubclass(a, BaseModel)
        )
    stack, forms = [model.model_fields[key].annotation], set()
    while stack:
        a = stack.pop()
        if a in (ByAttributeColor, ByAttributeNumber):
            forms.add(a)
        stack.extend(get_args(a))
    if ByAttributeColor in forms:
        return "color"
    return "number" if ByAttributeNumber in forms else "choice"


#: What generated classes fill a target with: colors from `palette` where the
#: property maps attributes to colors, numbers from `range` where it maps them to
#: numbers, nothing for choices (5.4).
TARGET_KINDS = {path: _target_kind(path) for path in TARGET_PATHS}


def _check_target(v: Any) -> Any:
    if isinstance(v, str) and v not in TARGET_PATHS:
        raise PydanticCustomError(
            "invalid_value", f'"{v}" is not a property a classification can set.'
        )
    return v


TargetPath = Annotated[
    str,
    BeforeValidator(_check_target),
    Field(json_schema_extra={"enum": sorted(TARGET_PATHS)}),
]


class ClassRecord(Overrides):
    id: str | None = None
    values: list[Scalar] | None = None
    from_: float | None = Field(default=None, alias="from")
    to: float | None = None
    name: str | None = None
    legend: Literal[False] | None = None


def _check_numeric(classes: list[Any], method: str) -> None:
    """Numeric classes are sorted, without gaps or overlaps.

    A computed method may list its classes by position only (names, colors,
    visibility): the server fills `from` and `to`, so there is nothing to check yet.
    """
    if method != "manual" and all(c.from_ is None and c.to is None for c in classes):
        return
    previous_to: float | None = None
    for i, c in enumerate(classes):
        if c.from_ is not None and c.to is not None and c.from_ >= c.to:
            raise PydanticCustomError(
                "classes_invalid", "A class's from must be below its to."
            )
        if i > 0 and (c.from_ is None or previous_to is None or c.from_ != previous_to):
            raise PydanticCustomError(
                "classes_invalid",
                "Numeric classes are sorted, without gaps or overlaps: each from is the previous to.",
            )
        previous_to = c.to


class Classification(StyleModel):
    id: str | None = None
    title: str | None = None
    field: Annotated[str, Field(min_length=1)]
    method: Method
    count: Annotated[int, Field(ge=1, le=MAX_COUNT)] | None = None
    target: TargetPath | None = None
    palette: PaletteRef | None = None
    reverse: bool = False
    range: Range | None = None
    unit: str | None = None
    format: NumberFormat | None = None
    legend: Literal[False] | None = None
    classes: list[ClassRecord] | None = None
    other: ClassRecord | None = None
    no_data: ClassRecord | None = None
    computed: Computed | None = None

    @model_validator(mode="after")
    def _classes_fit_the_method(self) -> "Classification":
        classes = self.classes or []
        if self.method == "categories":
            if any(
                c.values is None or c.from_ is not None or c.to is not None
                for c in classes
            ):
                raise PydanticCustomError(
                    "invalid_value",
                    "Category classes list their values, not from and to.",
                )
            seen: set[str] = set()
            for c in classes:
                for v in c.values or []:
                    if as_text(v) in seen:
                        raise PydanticCustomError(
                            "category_duplicate", f'"{v}" is in two classes.'
                        )
                    seen.add(as_text(v))
        else:
            if any(c.values is not None for c in classes):
                raise PydanticCustomError(
                    "invalid_value", "Numeric classes take from and to, not values."
                )
            _check_numeric(classes, self.method)
        return self


class ColorClass(StyleModel):
    """A class of a raster or H3 classification: a color instead of part overrides."""

    id: str | None = None
    from_: float | None = Field(default=None, alias="from")
    to: float | None = None
    color: Color | None = None
    name: str | None = None
    visible: bool | None = None
    legend: Literal[False] | None = None
    min_zoom: WholeZoom | None = None
    max_zoom: WholeZoom | None = None


class ColorClassification(StyleModel):
    id: str | None = None
    method: NumericMethod
    count: Annotated[int, Field(ge=1, le=MAX_COUNT)] | None = None
    palette: PaletteRef | None = None
    reverse: bool = False
    classes: list[ColorClass] | None = None
    computed: Computed | None = None

    @model_validator(mode="after")
    def _sorted(self) -> "ColorClassification":
        _check_numeric(self.classes or [], self.method)
        return self
