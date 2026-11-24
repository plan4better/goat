"""A layer filter's area as the model sets it: the row operations
``set_area`` and ``clear_area``, and the area built from their sources the
way the web's filter panel builds it (``goatlib.filter.areas``).

An area is made of regions (catalog region ids), features of another
polygon layer of the project and the map view the user sees. Each outline
joins the area as the panel's lists and its "Add map view" add it: rounded,
and simplified to the most positions that fit beside the rows the call
leaves. Several outlines of one call share that room (``build_area``); the
panel reads back whatever positions are stored. The outlines are read before the plan (``assistant.maps.area_sources``);
building the area only computes.
"""

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal

from goatlib.filter.areas import (
    GEOMETRY_FIELD,
    REGION_SOURCE,
    Piece,
    _filter_length,
    add_feature,
    add_view,
    area_of,
    area_polygons,
    filter_fits,
    over_limits,
    point_count,
    read_area,
)
from goatlib.filter.limits import MAX_FEATURES, MAX_LENGTH, MAX_POINTS
from goatlib.filter.rows import Rows
from pydantic import BaseModel, ConfigDict, Field, model_validator

from assistant.context import NUTS_ID_PATTERN
from assistant.tools.filters import FILTER_EXAMPLES, FeatureFilter
from assistant.tools.runtime import InputInvalid

#: Regions one set_area takes.
MAX_REGIONS = 50
#: The positions of one outline above which it is thinned (every k-th
#: position of each ring kept) before it is simplified: the simplification
#: in pure Python grows faster than the positions, and an outline of more
#: positions than this is simplified far below it anyway.
THIN_ABOVE = 20_000

RegionId = Annotated[str, Field(pattern=NUTS_ID_PATTERN)]

#: What a replacement of a switched-off area says.
REPLACED_OFF = (
    "The area the filter had was switched off in the Filter tab; the new area "
    "replaces it and is switched on."
)


class FeaturesOf(BaseModel):
    model_config = ConfigDict(extra="forbid")

    layer_project_id: int = Field(
        ge=1,
        description=(
            "Another polygon layer of the open project (layer_project_id from "
            "project_get_layers) whose features make the area."
        ),
    )
    filter: FeatureFilter | None = Field(
        default=None,
        description=(
            "Which of its features; left out, all it shows. At most "
            f"{MAX_FEATURES} may match. {FILTER_EXAMPLES}"
        ),
    )


class SetArea(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["set_area"] = Field(
        description=(
            "Limit the layer to an area, as the Filter tab's Area does: only "
            "features inside it (or outside it) pass. The rows stay."
        )
    )
    regions: list[RegionId] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_REGIONS,
        description=("Region ids from catalog_find_region (nuts_id). Example: DE212."),
    )
    features_of: FeaturesOf | None = Field(
        default=None,
        description="Features of another polygon layer of this project.",
    )
    view: bool | None = Field(
        default=None,
        description="true: the map view the user sees now.",
    )
    outside: bool | None = Field(
        default=None,
        description=(
            "true keeps the features outside the area. Default false; with "
            "add, the side the area has."
        ),
    )
    add: bool = Field(
        default=False,
        description=(
            "true adds these to the area the filter has (a drawn shape stays; "
            "an area switched off stays switched off); false makes the area "
            "exactly these, switched on."
        ),
    )

    @model_validator(mode="after")
    def _has_a_source(self) -> "SetArea":
        if not (self.regions or self.features_of is not None or self.view):
            raise ValueError(
                "set_area takes at least one of regions, features_of and view: true."
            )
        return self


class ClearArea(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["clear_area"] = Field(
        description="Remove the filter's area, switched on or off; the rows stay."
    )


@dataclass(frozen=True)
class Outline:
    """A feature an area is made of: its id in its source, the name the
    panel shows, and its geometry as the service sent it."""

    id: str
    name: str | None
    geometry: Any


@dataclass(frozen=True)
class AreaSources:
    """The outlines of one set_area, read before the plan: its regions in
    the order given, the other layer's dataset id and features, and the map
    view (west, south, east, north)."""

    regions: tuple[Outline, ...] = ()
    layer: str | None = None
    features: tuple[Outline, ...] = ()
    bounds: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class BuiltArea:
    """The area's CQL node and notes as the panel writes them, and what the
    model should say about how it was built."""

    node: dict[str, Any]
    notes: dict[str, Any]
    said: list[str]


def layer_labels(rows: Mapping[int, Mapping[str, Any]]) -> dict[str, str]:
    """How an area's summary names a layer source (a dataset id): by the
    name and number of the first layer of the project that holds it."""
    labels: dict[str, str] = {}
    for link in sorted(rows):
        row = rows[link]
        if row.get("layer_id"):
            name = str(row.get("name") or f"layer {link}")
            labels.setdefault(str(row["layer_id"]), f'layer "{name}" ({link})')
    return labels


def _ring_positions(geometry: Any) -> list[list[Any]] | None:
    """The rings of a Polygon or MultiPolygon; None for anything else."""
    if not isinstance(geometry, dict):
        return None
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Polygon" and isinstance(coordinates, list):
        polygons = [coordinates]
    elif geometry.get("type") == "MultiPolygon" and isinstance(coordinates, list):
        polygons = coordinates
    else:
        return None
    rings = [
        ring for polygon in polygons if isinstance(polygon, list) for ring in polygon
    ]
    return rings if all(isinstance(ring, list) for ring in rings) else None


def _thin_ring(ring: Sequence[Any], step: int) -> list[Any]:
    """Every ``step``-th position, the first and the closing one kept; a
    ring keeps at least four positions."""
    n = len(ring)
    own = max(1, min(step, (n - 1) // 3))
    return [*ring[0 : n - 1 : own], ring[-1]] if n > 4 else list(ring)


def thinned(geometry: Any) -> Any:
    """The geometry with every k-th position of each ring when it has more
    than ``THIN_ABOVE`` positions; anything else as it came."""
    rings = _ring_positions(geometry)
    if rings is None:
        return geometry
    total = sum(len(ring) for ring in rings)
    if total <= THIN_ABOVE:
        return geometry
    step = math.ceil(total / THIN_ABOVE)
    coordinates = geometry["coordinates"]
    if geometry["type"] == "Polygon":
        thin = [_thin_ring(ring, step) for ring in coordinates]
    else:
        thin = [[_thin_ring(ring, step) for ring in polygon] for polygon in coordinates]
    return {**geometry, "coordinates": thin}


def _positions(geometry: Any) -> int:
    rings = _ring_positions(geometry)
    return sum(len(ring) for ring in rings) if rings else 0


#: The most outlines a note names; the others are counted.
_NAMED_OUTLINES = 5


def _listed(what: Sequence[str]) -> str:
    named = list(what[:_NAMED_OUTLINES])
    if len(what) > _NAMED_OUTLINES:
        named.append(f"{len(what) - _NAMED_OUTLINES} more")
    if len(named) == 1:
        return named[0]
    return f"{', '.join(named[:-1])} and {named[-1]}"


def _simplified(what: Sequence[str], shift: float) -> str:
    if len(what) == 1:
        return (
            f"The outline of {what[0]} was simplified to fit the filter's size "
            f"limit; it moved by up to {max(1, round(shift))} m."
        )
    return (
        f"The outlines of {_listed(what)} were simplified to fit the filter's "
        f"size limit; they moved by up to {max(1, round(shift))} m."
    )


def _strongly(what: Sequence[str]) -> str:
    """The note for thinned outlines: how far they moved is not measured."""
    if len(what) == 1:
        return (
            f"The outline of {what[0]} is very detailed and was simplified "
            "strongly to fit the filter's size limit."
        )
    return (
        f"The outlines of {_listed(what)} are very detailed and were simplified "
        "strongly to fit the filter's size limit."
    )


@dataclass(frozen=True)
class _Joining:
    """One outline to add: the words that name it, its geometry as it will
    be added (thinned when very detailed), whether it was thinned, and how
    it joins the pieces."""

    what: str
    geometry: Any
    thin: bool
    source: str | None = None
    outline: Outline | None = None


def _joining(what: str, outline: Outline, source: str) -> _Joining:
    geometry = thinned(outline.geometry)
    return _Joining(
        what=what,
        geometry=geometry,
        thin=geometry is not outline.geometry,
        source=source,
        outline=outline,
    )


def build_area(op: SetArea, rows: Rows, sources: AreaSources) -> BuiltArea:
    """The area one ``set_area`` sets on a filter whose rows are ``rows`` (as
    the call leaves them, with the area there was). Raises ``InputInvalid``
    for outlines that do not fit even simplified, for an area over a limit
    and for an area without a polygon.

    The outlines share the room the rows and the area there is leave: they
    are added smallest first, each fitted (simplified when needed) into at
    most an equal share of the points and of the length still free, so one
    that needs less leaves the rest to those after it."""
    # As the Filter tab: an area the user switched off stays switched off
    # when pieces are added to it.
    was_off = (
        rows.area is not None
        and isinstance(rows.area_notes, dict)
        and "off" in rows.area_notes
    )
    current = (
        read_area(rows.area, rows.area_notes)
        if op.add and rows.area is not None
        else None
    )
    pieces: tuple[Piece, ...] = current.pieces if current is not None else ()
    if op.outside is not None:
        outside = op.outside
    else:
        outside = current.outside if current is not None else False
    field = current.property if current is not None else GEOMETRY_FIELD
    beside = replace(rows, area=None, area_notes=None)
    fits = filter_fits(beside, outside=outside, property=field)

    def length(candidate: Sequence[Piece]) -> int:
        # goatlib has no py.typed marker, so mypy reads its result as Any.
        counted: int = _filter_length(candidate, beside, outside, field)
        return counted

    joining = [
        _joining(f'the region "{region.name or region.id}"', region, REGION_SOURCE)
        for region in sources.regions
    ]
    if sources.layer is not None:
        joining += [
            _joining(
                f'the feature "{feature.name or feature.id}"', feature, sources.layer
            )
            for feature in sources.features
        ]
    if sources.bounds is not None:
        joining.append(_Joining(what="the map view", geometry=None, thin=False))
    # The map view is a box of five positions.
    joining.sort(key=lambda item: _positions(item.geometry) if item.geometry else 5)

    simplified: list[str] = []
    strongly: list[str] = []
    shift = 0.0
    without = 0
    for index, item in enumerate(joining):
        left = len(joining) - index
        used_points = point_count(area_polygons(pieces))
        used_length = length(pieces)
        point_share = (MAX_POINTS - used_points) // left
        length_share = (MAX_LENGTH - used_length) // left

        def fair(
            candidate: tuple[Piece, ...],
            used_points: int = used_points,
            used_length: int = used_length,
            point_share: int = point_share,
            length_share: int = length_share,
        ) -> bool:
            return (
                point_count(area_polygons(candidate)) - used_points <= point_share
                and length(candidate) - used_length <= length_share
                and fits(candidate)
            )

        if item.outline is None:
            assert sources.bounds is not None
            added = add_view(pieces, sources.bounds, fits=fair)
        else:
            assert item.source is not None
            try:
                added = add_feature(
                    pieces,
                    item.source,
                    item.outline.id,
                    item.geometry,
                    name=item.outline.name,
                    fits=fair,
                )
            except ValueError:
                if item.source == REGION_SOURCE:
                    raise InputInvalid(
                        f"The catalog has no polygon outline for {item.what}."
                    ) from None
                # The panel leaves a feature without a polygon out of the area.
                without += 1
                continue
        if added is None:
            if len(joining) == 1:
                raise InputInvalid(
                    f"The outline of {item.what} does not fit the filter's size "
                    "limit, also not simplified, beside the rows and the rest of "
                    "the area. Use fewer or shorter rows."
                )
            raise InputInvalid(
                f"The {len(joining)} outlines asked for do not fit the filter's "
                "size limit together, also not each simplified to an equal share "
                "of it. Ask for fewer of them, or for larger units (a region one "
                "level up)."
            )
        if added.kept < added.points:
            if item.thin:
                strongly.append(item.what)
            else:
                simplified.append(item.what)
                shift = max(shift, added.shift)
        pieces = added.pieces

    problems = over_limits(pieces, beside, outside=outside, property=field)
    if problems:
        raise InputInvalid(" ".join(problems))
    node, notes = area_of(pieces, outside=outside, property=field)
    if node is None or notes is None:
        raise InputInvalid(
            "None of the features has a polygon outline, so no area was set."
        )
    said = []
    if was_off and op.add:
        notes = {**notes, "off": node}
    elif was_off:
        said.append(REPLACED_OFF)
    if simplified:
        said.append(_simplified(simplified, shift))
    if strongly:
        said.append(_strongly(strongly))
    if without:
        said.append(
            "1 feature without a polygon outline was left out."
            if without == 1
            else f"{without} features without a polygon outline were left out."
        )
    return BuiltArea(node=node, notes=notes, said=said)
