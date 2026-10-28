"""Rules and their conditions (the specification's sections 6, 6.1 and 18.6)."""

from typing import Annotated, Any, Literal, Union

from pydantic import (
    BeforeValidator,
    Discriminator,
    Field,
    Tag,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from goatlib.style import cql, limits
from goatlib.style.models.base import LAX, StyleModel
from goatlib.style.models.parts import (
    ArrowsPart,
    CasingPart,
    FillPart,
    LabelPart,
    LinePart,
    MarkerPart,
    OutlinePart,
)


def _check_scalar(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)):
        return v
    raise PydanticCustomError(
        "invalid_value", "A comparison value is a text, a number or true or false."
    )


Scalar = Annotated[Union[str, float, bool], BeforeValidator(_check_scalar)]


def _check_list(v: Any) -> Any:
    if (
        isinstance(v, list)
        and v
        and all(isinstance(x, (str, int, float, bool)) for x in v)
    ):
        return v
    raise PydanticCustomError("invalid_value", '"in" takes a list of values.')


ScalarList = Annotated[list[Union[str, float, bool]], BeforeValidator(_check_list)]


class Property(StyleModel):
    property: Annotated[str, Field(min_length=1)]


class Logical(StyleModel):
    op: Literal["and", "or"]
    args: Annotated[list["Condition"], Field(min_length=1)]


class Not(StyleModel):
    op: Literal["not"]
    args: Annotated[list["Condition"], Field(min_length=1, max_length=1)]


class Compare(StyleModel):
    op: Literal["=", "<>", "<", ">", "<=", ">="]
    args: Annotated[tuple[Property, Scalar], LAX]


class In(StyleModel):
    op: Literal["in"]
    args: Annotated[tuple[Property, ScalarList], LAX]


class Like(StyleModel):
    op: Literal["like"]
    args: Annotated[tuple[Property, str], LAX]

    @model_validator(mode="after")
    def _supported_pattern(self) -> "Like":
        if not cql.like_pattern_supported(self.args[1]):
            raise PydanticCustomError(
                "like_pattern_unsupported",
                '"like" takes contains (%x%), starts with (x%) or ends with (%x); "_" is not supported.',
            )
        return self


class IsNull(StyleModel):
    op: Literal["isNull"]
    args: Annotated[tuple[Property], LAX]


def _op_of(v: Any) -> str:
    op = v.get("op") if isinstance(v, dict) else None
    if op in ("and", "or"):
        return "op:logical"
    if op in cql.COMPARE:
        return "op:compare"
    return f"op:{op}"


Condition = Annotated[
    Union[
        Annotated[Logical, Tag("op:logical")],
        Annotated[Not, Tag("op:not")],
        Annotated[Compare, Tag("op:compare")],
        Annotated[In, Tag("op:in")],
        Annotated[Like, Tag("op:like")],
        Annotated[IsNull, Tag("op:isNull")],
    ],
    Discriminator(
        _op_of,
        custom_error_type="invalid_value",
        custom_error_message="A condition's op is one of " + ", ".join(cql.OPS) + ".",
    ),
]

Logical.model_rebuild()
Not.model_rebuild()


def _check_whole_zoom(v: Any) -> Any:
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v != int(v):
        raise PydanticCustomError(
            "zoom_not_whole", "Class and rule zooms are whole numbers."
        )
    return v


WholeZoom = Annotated[
    float, BeforeValidator(_check_whole_zoom), Field(**limits.bounds("zoom"))
]


class Overrides(StyleModel):
    """What a class record or a rule changes: parts, visibility and zooms."""

    visible: bool | None = None
    min_zoom: WholeZoom | None = None
    max_zoom: WholeZoom | None = None
    fill: FillPart | None = None
    outline: OutlinePart | None = None
    line: LinePart | None = None
    casing: CasingPart | None = None
    arrows: ArrowsPart | None = None
    marker: MarkerPart | None = None
    label: LabelPart | None = None


class Rule(Overrides):
    id: str | None = None
    name: str | None = None
    legend: Literal[False] | None = None
    when: Condition

    @field_validator("when", mode="before")
    @classmethod
    def _bounded_depth(cls, v: Any) -> Any:
        if cql.depth(v) > cql.MAX_DEPTH:
            raise PydanticCustomError(
                "invalid_value",
                f"A condition may nest at most {cql.MAX_DEPTH} levels deep.",
            )
        return v
