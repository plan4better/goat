"""The view ``map_update`` hands to the page: a camera or a box to fit, the 2D
or 3D mode and the projection. Nothing of it is saved by the assistant; the
page moves its own map and stores the user's view as it does when the user
moves it.

A view fitted to a layer is the extent of the features its saved filter
keeps, which processes computes. Only a layer from the project's own layer
list that the user can read reaches processes, as for the project tools.
"""

import json
from collections.abc import Sequence
from typing import Any, Literal

from pydantic import BaseModel
from pydantic_ai.exceptions import ToolFailed

from assistant.maps.operations import SetView
from assistant.maps.state import MapRead
from assistant.tools.project import _COPYING, STILL_COPYING, _analytics, _copy_status
from assistant.tools.runtime import InputInvalid, ToolEnv

#: A server extent narrower than this (a single point, or features on one
#: meridian or parallel) is widened to it before it becomes a map view, because
#: a zero-sized box cannot be fitted. In degrees, roughly 200 m.
_MIN_EXTENT_DEGREES = 0.004

NO_LAYER = (
    "There is no layer {layer_project_id} in this project. Call "
    "project_get_layers to list the layers."
)
LOCKED = "{name!r} is in the project, but the user has no access to its data."
NOTHING_TO_FIT = "No features match the layer's filter, so there is nothing to show."


class ViewTarget(BaseModel):
    """What the page is asked to show; a key left out stays as the page has it."""

    #: Any of center ([longitude, latitude]), zoom, pitch and bearing.
    camera: dict[str, Any] | None = None
    #: [west, south, east, north] to fit inside the view.
    bbox: tuple[float, float, float, float] | None = None
    mode: Literal["2d", "3d"] | None = None
    projection: Literal["mercator", "globe"] | None = None


def _check_bbox(bbox: list[float]) -> tuple[float, float, float, float]:
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise InputInvalid(
            "bbox must be [west, south, east, north] with west < east and south < north in WGS84."
        )
    return west, south, east, north


def _widen(
    low: float, high: float, floor: float, ceiling: float
) -> tuple[float, float]:
    """``low..high`` at least ``_MIN_EXTENT_DEGREES`` wide, kept inside the bounds."""
    if high - low >= _MIN_EXTENT_DEGREES:
        return low, high
    middle = (low + high) / 2
    low, high = middle - _MIN_EXTENT_DEGREES / 2, middle + _MIN_EXTENT_DEGREES / 2
    if low < floor:
        return floor, floor + _MIN_EXTENT_DEGREES
    if high > ceiling:
        return ceiling - _MIN_EXTENT_DEGREES, ceiling
    return low, high


def _extent_bbox(raw: list[float]) -> tuple[float, float, float, float]:
    """A layer's extent as a map view. One feature that is a point, or features
    on one meridian or parallel, give a box with no width or height: it is
    widened."""
    try:
        west, south, east, north = (float(value) for value in raw)
        if not (west <= east and south <= north):
            raise ValueError
        west, east = _widen(west, east, -180.0, 180.0)
        south, north = _widen(south, north, -90.0, 90.0)
        return _check_bbox([west, south, east, north])
    except (ValueError, TypeError, InputInvalid) as exc:
        raise ToolFailed("The layer's extent cannot be shown as a map view.") from exc


def fitted_layer(state: MapRead, layer_project_id: int) -> dict[str, Any]:
    """The row of a layer a view can be fitted to. Refused: a layer the
    project does not have, one the user cannot read, one still being copied,
    and one without features that have a place (a table, a raster)."""
    row = state.rows.get(layer_project_id)
    if row is None:
        raise InputInvalid(NO_LAYER.format(layer_project_id=layer_project_id))
    name = str(row.get("name") or f"layer {layer_project_id}")
    if row.get("locked"):
        raise ToolFailed(LOCKED.format(name=name))
    if _copy_status(row) in _COPYING:
        raise ToolFailed(STILL_COPYING)
    if row.get("type") == "raster":
        raise ToolFailed(
            f"{name!r} is a raster layer; a view is fitted to a layer with features."
        )
    if row.get("type") != "feature" or row.get("feature_layer_geometry_type") is None:
        # A table: the services have no extent to compute for it.
        raise ToolFailed(
            f"{name!r} has no geometry to show on the map. Fit the view to a "
            "layer with geometry, or give center and zoom."
        )
    return row


def _camera(op: SetView) -> dict[str, Any] | None:
    camera: dict[str, Any] = {}
    if op.center is not None:
        camera["center"] = [float(value) for value in op.center]
    for key in ("zoom", "pitch", "bearing"):
        value = getattr(op, key)
        if value is not None:
            camera[key] = float(value)
    return camera or None


#: ``view_target``'s query when none is given: the layer's saved one.
_SAVED: Any = object()


async def view_target(
    env: ToolEnv, op: SetView, state: MapRead | None, query: Any = _SAVED
) -> ViewTarget:
    """The view an operation asks for. A view fitted to a layer needs the
    project's map (``state``), and asks processes for the extent of the
    features the layer's filter keeps: ``query`` when given (the filter as
    the earlier operations of the call leave it), else the saved one; the
    mode and the projection may come with it. Any other view reads nothing."""
    if op.fit_layer_project_id is None:
        return ViewTarget(camera=_camera(op), mode=op.mode, projection=op.projection)
    if state is None:
        raise ValueError("a view fitted to a layer needs the project's map")
    row = fitted_layer(state, op.fit_layer_project_id)
    if query is _SAVED:
        query = row.get("query")
    cql = query.get("cql") if isinstance(query, dict) else None
    extent = await _analytics(
        env,
        "extent",
        {
            "collection": str(row["layer_id"]),
            "filter": json.dumps(cql) if isinstance(cql, dict) and cql else None,
        },
    )
    bbox = extent.get("bbox") if isinstance(extent, dict) else None
    if not bbox:
        raise ToolFailed(NOTHING_TO_FIT)
    west, south, east, north = _extent_bbox(list(bbox))
    # Seven decimals of a degree are about a centimetre.
    return ViewTarget(
        bbox=(round(west, 7), round(south, 7), round(east, 7), round(north, 7)),
        mode=op.mode,
        projection=op.projection,
    )


def merged_view(targets: Sequence[ViewTarget]) -> ViewTarget | None:
    """The views of one call as one, in their order: a later value of a field
    counts, a box takes the place of a camera before it and a camera that of
    a box before it. None without a view."""
    if not targets:
        return None
    merged = ViewTarget()
    for target in targets:
        if target.bbox is not None:
            merged.bbox, merged.camera = target.bbox, None
        elif target.camera is not None:
            merged.camera = {**(merged.camera or {}), **target.camera}
            merged.bbox = None
        merged.mode = target.mode or merged.mode
        merged.projection = target.projection or merged.projection
    return merged
