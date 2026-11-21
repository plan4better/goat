"""A filter's area as one valid Polygon or MultiPolygon.

The web writes an area as its pieces side by side in one MultiPolygon (drawn
shapes, the map view, picked features), and other clients may do the same, so
its polygons may overlap, share an edge, or fill one another's holes. That is
not a valid MultiPolygon, and a point in it is not answered as in any of its
pieces: DuckDB's `ST_Intersects` with a constant area and a prepared shapely
geometry both answer as if they counted the boundaries crossed on the way to
the point, even or odd, so a point in two pieces reads as outside.
`normalize_area` returns the union of the pieces, which reads the same in
every engine. Shapely only; the services import this module where they
evaluate an area, not with the package.

Repairing an outline costs by how often it crosses, touches or lies within
itself, not by its size, and so does checking one whose edges crowd one
another. `_meetings` counts that first, at a cost that is bounded, and an area
past a cap is refused (`AreaCrossesItselfError`, the validator's
`area_crosses_itself`) before any costly step. Each area is worked out once:
the outcome is kept by the digest of its JSON text.
"""

import functools
import hashlib
import json
from typing import Any

import numpy as np
import shapely

_AREA_TYPES = ("Polygon", "MultiPolygon")

#: One message for the refusal, wherever it surfaces.
CROSSES_ITSELF = (
    "The area's outline crosses or overlaps itself too often. "
    "Redraw it or pick a simpler one."
)

# Any area: what the validity check and the counting below cost by.
_MAX_EDGE_PAIRS = 50_000  # edges whose boxes meet, and so many again per edge
_MAX_EDGE_PAIRS_EACH = 10
_MAX_RING_PAIRS = 50_000  # rings whose boxes meet
_MAX_NESTED_RINGS = 5_000  # rings of one polygon, one's box inside the other's
# An area that is not valid: what its repair costs by.
_MAX_SELF_MEETINGS = 100  # edges of one polygon that cross or touch
_MAX_CROSSINGS = 5_000  # edges that cross, of one polygon or of two

#: Boxes asked of the index at once: what one answer may hold at most.
_ANSWER = 2_000_000
#: Areas whose outcome is kept.
REMEMBERED = 64

_REFUSED = "refused"


class AreaCrossesItselfError(ValueError):
    """The area's repair would cost too much: nothing was repaired."""


def normalize_area(geometry: dict[str, Any]) -> dict[str, Any]:
    """The GeoJSON area as one valid Polygon or MultiPolygon.

    A valid area comes back as it is (the same object), so the common case
    pays for the counting and a validity check, once per area. Otherwise each
    polygon is made valid and all are unioned; what has no area (a ring that
    collapses to a line) is dropped, and an area left with nothing is an empty
    MultiPolygon, which intersects nothing. The repaired area is the caller's
    own: a new object on every call. Anything that is not a Polygon or
    MultiPolygon, or does not read as one, comes back as it is, for the caller
    to answer or refuse as before.

    Raises `AreaCrossesItselfError` for an area past a cap (see the module).
    """
    outcome = _outcome(geometry)
    if outcome is None:
        return geometry
    if outcome is _REFUSED:
        raise AreaCrossesItselfError(CROSSES_ITSELF)
    repaired: dict[str, Any] = json.loads(outcome)
    return repaired


def crosses_itself(geometry: Any) -> bool:
    """Whether `normalize_area` refuses the geometry."""
    return _outcome(geometry) is _REFUSED


def forget() -> None:
    """Drops every outcome kept."""
    _slot.cache_clear()


def remembered() -> int:
    """The areas whose outcome is kept."""
    return _slot.cache_info().currsize


@functools.lru_cache(maxsize=REMEMBERED)
def _slot(digest: bytes) -> list[str | None]:
    """The place of one area's outcome; empty until it is worked out."""
    return []


def _outcome(geometry: Any) -> str | None:
    """None for an area to take as it is, `_REFUSED`, or the repaired area as
    GeoJSON text (text, so that no caller can change what is kept)."""
    if not isinstance(geometry, dict) or geometry.get("type") not in _AREA_TYPES:
        return None
    try:
        text = json.dumps(geometry)
    except (TypeError, ValueError, RecursionError):
        return None
    slot = _slot(hashlib.sha256(text.encode()).digest())
    if not slot:
        slot.append(_settle(text))
    return slot[0]


def _settle(text: str) -> str | None:
    try:
        area = shapely.from_geojson(text)
    except (shapely.errors.GEOSException, TypeError, ValueError):
        return None
    meetings = _meetings(area)
    if meetings is None:
        return _REFUSED
    if shapely.is_valid(area):
        return None
    touching, crossing = meetings
    if touching > _MAX_SELF_MEETINGS or crossing > _MAX_CROSSINGS:
        return _REFUSED
    pieces = []
    for piece in shapely.get_parts(area):
        if not shapely.is_valid(piece):
            # a polygon, a multipolygon or a collection with lines and points
            piece = shapely.make_valid(piece)
        pieces.extend(_polygons(piece))
    polygons = _polygons(shapely.union_all(pieces)) if pieces else []
    if not polygons:
        return json.dumps({"type": "MultiPolygon", "coordinates": []})
    union = polygons[0] if len(polygons) == 1 else shapely.MultiPolygon(polygons)
    repaired: str = shapely.to_geojson(union)
    return repaired


def _box_pairs(geometries: Any, budget: int) -> tuple[Any, Any] | None:
    """The pairs (a < b) of geometries whose boxes meet, or None past the
    budget. The index is asked in slices, so the count stops at the budget
    however many boxes meet."""
    tree = shapely.STRtree(geometries)
    step = max(1, min(256, _ANSWER // max(len(geometries), 1)))
    found, total = [], 0
    for start in range(0, len(geometries), step):
        a, b = tree.query(geometries[start : start + step])
        a = a + start
        keep = a < b
        total += int(keep.sum())
        if total > budget:
            return None
        found.append((a[keep], b[keep]))
    return (
        np.concatenate([a for a, _ in found]),
        np.concatenate([b for _, b in found]),
    )


def _meetings(area: shapely.Geometry) -> tuple[int, int] | None:
    """How the area's outline meets itself: (edges of one polygon that cross or
    touch, edges that cross), or None for an area past a cap that holds for
    valid areas too. Edges next to each other in a ring are not counted."""
    rings, polygon = shapely.get_rings(shapely.get_parts(area), return_index=True)
    xy, ring = shapely.get_coordinates(rings, return_index=True)
    # an edge: two points of one ring that follow each other and differ
    edge = (ring[:-1] == ring[1:]) & (xy[:-1] != xy[1:]).any(axis=1)
    p, q, ring = xy[:-1][edge], xy[1:][edge], ring[:-1][edge]
    if not len(p):
        return 0, 0

    nesting = _box_pairs(rings, _MAX_RING_PAIRS)
    if nesting is None:
        return None
    a, b = nesting
    one, other = shapely.bounds(rings[a]), shapely.bounds(rings[b])
    inside = ((one[:, :2] >= other[:, :2]) & (one[:, 2:] <= other[:, 2:])).all(axis=1)
    around = ((other[:, :2] >= one[:, :2]) & (other[:, 2:] <= one[:, 2:])).all(axis=1)
    nested = (inside | around) & (polygon[a] == polygon[b])
    if int(nested.sum()) > _MAX_NESTED_RINGS:
        return None

    # Neighbours always meet, and a detailed outline has that many of them.
    pairs = _box_pairs(
        shapely.linestrings(np.stack([p, q], axis=1)),
        _MAX_EDGE_PAIRS + _MAX_EDGE_PAIRS_EACH * len(p),
    )
    if pairs is None:
        return None
    a, b = pairs
    starts = np.r_[True, ring[1:] != ring[:-1]]
    first = np.flatnonzero(starts)
    last = np.r_[first[1:] - 1, len(p) - 1]
    nth = np.cumsum(starts) - 1
    neighbours = (ring[a] == ring[b]) & (
        (b - a == 1) | ((a == first[nth[a]]) & (b == last[nth[a]]))
    )
    a, b = a[~neighbours], b[~neighbours]

    def side(start: Any, end: Any, point: Any) -> Any:
        """Which side of the line through start and end the point lies on."""
        with np.errstate(all="ignore"):
            return np.sign(
                (end[:, 0] - start[:, 0]) * (point[:, 1] - start[:, 1])
                - (end[:, 1] - start[:, 1]) * (point[:, 0] - start[:, 0])
            )

    b_start, b_end = side(p[a], q[a], p[b]), side(p[a], q[a], q[b])
    a_start, a_end = side(p[b], q[b], p[a]), side(p[b], q[b], q[a])
    meet = (b_start * b_end <= 0) & (a_start * a_end <= 0)
    cross = (b_start * b_end < 0) & (a_start * a_end < 0)
    same_polygon = polygon[ring[a]] == polygon[ring[b]]
    return int((meet & same_polygon).sum()), int(cross.sum())


def _polygons(geometry: shapely.Geometry) -> list[shapely.Polygon]:
    return [
        part
        for part in shapely.get_parts(geometry)
        if part.geom_type == "Polygon" and not part.is_empty
    ]
