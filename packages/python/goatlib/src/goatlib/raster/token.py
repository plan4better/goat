"""The coloring a raster tile URL carries (`?style=<token>`).

The browser derives the coloring from a style (palettes resolved to colors,
classes with their bounds) and sends it as base64url of its JSON; the service
only colors cells. A token is its own cache key and needs no lookup, so live
edits, published snapshots and printed maps all draw from the same route. The
JSON keys are the web's (`lib/style/raster/color.ts`, `RasterColorSpec`).
"""

import base64
import binascii
import json
import re
from typing import Annotated, Any, Literal, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    StrictInt,
    ValidationError,
    field_validator,
)

from goatlib.raster.formula import Formula, FormulaError, parse_formula

#: Longer tokens are refused; the web reports styles whose token would pass 6 KB.
MAX_TOKEN_LENGTH = 16_384
MAX_CLASSES = 1024
MAX_STOPS = 256
MAX_NO_DATA = 64

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


class TokenError(ValueError):
    """The token is not a coloring."""


Color = Annotated[str, Field(pattern=_HEX.pattern)]
BandNumber = Annotated[StrictInt, Field(ge=1, le=1024)]


class _Coloring(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    v: Literal[1]
    no_data: Annotated[list[float], Field(alias="noData", max_length=MAX_NO_DATA)]


class _OneBand(_Coloring):
    band: BandNumber | str

    @field_validator("band")
    @classmethod
    def _formula(cls, v: Any) -> Any:
        if isinstance(v, str):
            try:
                parse_formula(v)
            except FormulaError as error:
                raise ValueError(str(error)) from None
        return v

    @property
    def formula(self) -> Formula:
        """The band or formula as a formula (`b<n>` for a band number)."""
        return parse_formula(
            self.band if isinstance(self.band, str) else f"b{self.band}"
        )


class Ramp(_OneBand):
    kind: Literal["ramp"]
    colors: Annotated[list[Color], Field(min_length=2, max_length=256)]
    domain: tuple[float, float] | None = None
    outside: Literal["clamp", "hide"] = "clamp"


class Stop(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: float
    color: Color


class Stops(_OneBand):
    kind: Literal["stops"]
    stops: Annotated[list[Stop], Field(min_length=1, max_length=MAX_STOPS)]
    interpolate: Literal["linear", "nearest"] = "linear"
    outside: Literal["clamp", "hide"] = "clamp"


class RangeClass(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    from_: float | None = Field(default=None, alias="from")
    to: float | None = None
    color: Color | None


class Classes(_OneBand):
    kind: Literal["classes"]
    classes: Annotated[list[RangeClass], Field(min_length=1, max_length=MAX_CLASSES)]


class ValueClass(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: float
    color: Color | None


class Categories(_OneBand):
    kind: Literal["categories"]
    classes: Annotated[list[ValueClass], Field(max_length=MAX_CLASSES)]
    other: Color | None = None


class Rgb(_Coloring):
    kind: Literal["rgb"]
    #: None: the file as it is (its color table, bands 1 to 3, or one band in grey).
    bands: tuple[BandNumber, BandNumber, BandNumber] | None = None


Coloring = Annotated[
    Union[Ramp, Stops, Classes, Categories, Rgb], Discriminator("kind")
]


class _Token(BaseModel):
    coloring: Coloring


def _canonical(coloring: dict[str, Any]) -> str:
    return json.dumps(coloring, sort_keys=True, separators=(",", ":"))


def encode_token(coloring: dict[str, Any]) -> str:
    """base64url (no padding) of the coloring's canonical JSON."""
    return base64.urlsafe_b64encode(_canonical(coloring).encode()).decode().rstrip("=")


def decode_token(token: str) -> Ramp | Stops | Classes | Categories | Rgb:
    """The coloring a token carries. Raises TokenError."""
    if not token or len(token) > MAX_TOKEN_LENGTH:
        raise TokenError("The style token is missing or too long.")
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        data = json.loads(raw)
    except (binascii.Error, ValueError, RecursionError):
        raise TokenError("The style token is not base64url JSON.") from None
    if not isinstance(data, dict):
        raise TokenError("The style token is not a coloring.")
    try:
        return _Token.model_validate({"coloring": data}).coloring
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(p) for p in first["loc"][2:])
        raise TokenError(
            f"The style token is invalid at {where}: {first['msg']}"
        ) from None
