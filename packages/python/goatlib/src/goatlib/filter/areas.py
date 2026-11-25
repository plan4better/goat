"""A layer filter's area from its pieces, as the web's filter panel writes it.

The area says where the features have to be (or must not be), beside the
filter's rows. It is made of pieces: the map view, drawn shapes, and features
picked from the administrative regions (source `"region"`) or from another
polygon layer (source = that layer's dataset id). In the saved filter the area
is one `s_intersects` of the geometry field with every piece's polygons
(under `not` for outside); the notes `ui.area` say which polygons belong to
which piece, with a sum of the coordinates that tells whether they still
describe the saved geometry.

The panel's code this mirrors one to one, under the same names in snake case:
`apps/web/lib/filter/area.ts` (pieces, `areaCql`, `areaNotes`, `areaSum`,
`readArea`, rounding), `lib/filter/simplify.ts` (`simplifyToFit`) and, in
`components/map/panels/filter/`, `area/pieces.ts` (`withPiece`,
`withFeature`), `area/AreaTools.tsx` (`add`) and `FilterPanel.tsx` (the limits
an outline has to fit). An outline joins the area rounded to six decimals;
when the area would then be over the points limit or longer than a map
request takes, the outline is simplified to the most positions that fit.

Numbers are written and measured as JavaScript writes them (`JSON.stringify`:
`10`, not `10.0`; `0.000001`, not `1e-06`), so the stored area and its sum are
the panel's to the last digit. The simplification uses V8's `Math.hypot` and
`Math.cos` as the web's tests run them (Node), so it keeps the positions the
panel keeps there; another engine may keep a slightly different set, which
changes nothing for the panel: it reads back whatever positions are stored.
The shared fixture `tests/unit/filter/fixtures/filter_areas.json` holds both
sides to that.
Standard library only: the assistant imports it.
"""

import json
import math
import re
import struct
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import quote

from goatlib.filter.limits import (
    _URL_SAFE,
    MAX_FEATURES,
    MAX_LENGTH,
    MAX_POINTS,
    MAX_SHAPES,
    _walk,
)
from goatlib.filter.rows import Rows, write_rows

Position = tuple[float, float]
#: One polygon: its rings, the outer one first.
Polygon = tuple[tuple[Position, ...], ...]
Polygons = tuple[Polygon, ...]

#: The source of the features picked from the administrative regions; any
#: other source is a layer's dataset id.
REGION_SOURCE = "region"
GEOMETRY_FIELD = "geom"
_DECIMALS = 1e6
_INF = math.inf


@dataclass(frozen=True)
class Feature:
    """A picked feature: its id in its source (a region's id, or a layer
    feature's id as text), the name the picker showed, and how many polygons
    it brought."""

    id: str
    n: int
    name: str | None = None


@dataclass(frozen=True)
class FeaturesPiece:
    """Features picked from one source, their polygons in the features' order,
    each feature's `n` of them."""

    source: str
    features: tuple[Feature, ...]
    polygons: Polygons


@dataclass(frozen=True)
class ViewPiece:
    """The map view as a box."""

    polygons: Polygons


@dataclass(frozen=True)
class ShapePiece:
    """A drawn shape. A circle around a point keeps its `center` and radius
    `km`; the CQL holds its ring alone."""

    polygons: Polygons
    shape: Literal["polygon", "circle"] | None = None
    label: str | None = None
    center: Position | None = None
    km: float | None = None


Piece = FeaturesPiece | ViewPiece | ShapePiece
Fits = Callable[[tuple[Piece, ...]], bool]


@dataclass(frozen=True)
class Area:
    """An area as the panel reads it from a saved filter."""

    pieces: tuple[Piece, ...]
    outside: bool = False
    enabled: bool = True
    property: str = GEOMETRY_FIELD


@dataclass(frozen=True)
class Simplified:
    """An outline made to fit, and how far it moved at most, in meters."""

    polygons: Polygons
    shift: float


@dataclass(frozen=True)
class Added:
    """The pieces with a new outline in them: the outline's positions as it
    came (`points`), as it was added (`kept`, fewer when it was simplified),
    and how far its edges moved, in meters (0 when it was not simplified)."""

    pieces: tuple[Piece, ...]
    points: int
    kept: int
    shift: float


# Numbers as JavaScript writes them.


def _is_number(v: Any) -> bool:
    """A finite number, as `Number.isFinite` takes a parsed JSON value."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def _js_number(value: float) -> str:
    """A number as `JSON.stringify` writes it: the shortest digits that read
    back as the same double, without a fraction for a whole number and with an
    exponent only below 1e-6 or from 1e21."""
    if isinstance(value, int) and abs(value) < 2**53:
        return str(value)
    try:
        value = float(value)
    except OverflowError:
        return "null"
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        e = n - 1
        text = (
            digits[0]
            + (f".{digits[1:]}" if k > 1 else "")
            + f"e{'+' if e >= 0 else '-'}{abs(e)}"
        )
    return sign + text


_SURROGATE = re.compile("[\ud800-\udfff]")


def _js_text(value: Any) -> str:
    """A key or value without children as `JSON.stringify` writes it, a
    lone surrogate escaped as it escapes one."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    text = json.dumps(str(value), ensure_ascii=False)
    if _SURROGATE.search(text) is None:
        return text
    # Two surrogates that make a pair are one character to JavaScript.
    joined = text.encode("utf-16", "surrogatepass").decode("utf-16", "surrogatepass")
    return _SURROGATE.sub(lambda found: f"\\u{ord(found.group()):04x}", joined)


def _url_scalar(value: Any) -> int:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        text = _js_number(value)
        return len(text) + 2 * text.count("+")
    return len(quote(_js_text(value), safe=_URL_SAFE))


def _url_length(cql: Any) -> int:
    """The characters of a filter in a map request's URL, as the web's
    `urlLength` counts them (`limits.url_length`, numbers written as
    JavaScript writes them)."""
    return 0 if cql is None else _walk(cql, _url_scalar, 3)


def _coordinates_text(value: Any) -> str:
    """Coordinates as `JSON.stringify` writes them, also a member that is no
    number."""
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_coordinates_text(v) for v in value) + "]"
    if isinstance(value, dict):
        members = (
            f"{_js_text(str(k))}:{_coordinates_text(v)}" for k, v in value.items()
        )
        return "{" + ",".join(members) + "}"
    return _js_text(value)


def area_sum(polygons: Sequence[Any]) -> str:
    """A short sum of the coordinates (FNV-1a over their JSON text, `areaSum`):
    tells whether notes still describe the saved geometry."""
    data = _coordinates_text(polygons).encode("utf-16-le")
    value = 0x811C9DC5
    # Over UTF-16 code units, as `charCodeAt` reads the text.
    for i in range(0, len(data), 2):
        value = ((value ^ (data[i] | data[i + 1] << 8)) * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


# Outlines.


def _is_position(v: Any) -> bool:
    return (
        isinstance(v, (list, tuple))
        and len(v) >= 2
        and _is_number(v[0])
        and _is_number(v[1])
    )


def _is_polygon(v: Any) -> bool:
    return (
        isinstance(v, (list, tuple))
        and len(v) > 0
        and all(
            isinstance(ring, (list, tuple))
            and len(ring) >= 4
            and all(_is_position(p) for p in ring)
            for ring in v
        )
    )


def _as_polygon(polygon: Any) -> Polygon:
    return tuple(tuple(tuple(p) for p in ring) for ring in polygon)


def _envelope(bbox: list[Any]) -> Polygon | None:
    """An envelope as the polygon the server makes of it."""
    box = [bbox[0], bbox[1], bbox[3], bbox[4]] if len(bbox) == 6 else bbox
    if len(box) != 4 or not all(_is_number(v) for v in box):
        return None
    w, s, e, n = box
    return (((w, s), (w, n), (e, n), (e, s), (w, s)),)


def _geometry_polygons(geometry: Any) -> Polygons | None:
    """`geometryPolygons`: the polygons of a polygon, a multipolygon or an
    envelope; None for any other geometry."""
    if not isinstance(geometry, dict):
        return None
    kind, coordinates = geometry.get("type"), geometry.get("coordinates")
    if kind == "Polygon":
        return (_as_polygon(coordinates),) if _is_polygon(coordinates) else None
    if kind == "MultiPolygon":
        if (
            isinstance(coordinates, list)
            and coordinates
            and all(_is_polygon(p) for p in coordinates)
        ):
            return tuple(_as_polygon(p) for p in coordinates)
        return None
    if len(geometry) == 1 and isinstance(geometry.get("bbox"), list):
        polygon = _envelope(geometry["bbox"])
        return (polygon,) if polygon else None
    return None


def polygons_of(geometry: Any) -> Polygons:
    """The polygons of a GeoJSON Polygon or MultiPolygon (or an envelope
    `{"bbox": [...]}`), as the panel takes an outline (`geometryPolygons`):
    every ring at least four positions of finite numbers."""
    polygons = _geometry_polygons(geometry)
    if polygons is None:
        raise ValueError(
            "An area is made of a Polygon or MultiPolygon whose rings have at "
            "least four positions of finite numbers."
        )
    return polygons


def _round(v: float) -> float:
    """`Math.round(v * 1e6) / 1e6`: the nearest, a tie toward +infinity; a
    whole number as an int, so it is written without a fraction."""
    x = v * _DECIMALS
    r = math.ceil(x)
    if r - 0.5 > x:
        r -= 1
    value = r / _DECIMALS
    return int(value) if value.is_integer() else value


def round_position(position: Sequence[float]) -> Position:
    """A position as a piece keeps it: longitude and latitude to six decimals."""
    return (_round(position[0]), _round(position[1]))


def round_polygons(polygons: Sequence[Any]) -> Polygons:
    """Coordinates as a piece keeps them: longitude and latitude to six decimals."""
    return tuple(
        tuple(tuple(round_position(p) for p in ring) for ring in polygon)
        for polygon in polygons
    )


def view_polygon(bounds: Sequence[float]) -> Polygon:
    """The map view (west, south, east, north) as a polygon, held to the world."""
    west, south, east, north = bounds
    w = _round(max(west, -180))
    s = _round(max(south, -90))
    e = _round(min(east, 180))
    n = _round(min(north, 90))
    return (((w, s), (e, s), (e, n), (w, n), (w, s)),)


def view_piece(bounds: Sequence[float]) -> ViewPiece:
    """The map view as a piece (`viewPieceOf`)."""
    return ViewPiece(polygons=(view_polygon(bounds),))


def area_polygons(pieces: Sequence[Piece]) -> Polygons:
    return tuple(polygon for piece in pieces for polygon in piece.polygons)


def point_count(polygons: Sequence[Any]) -> int:
    """The positions of every ring: what the points limit counts."""
    return sum(len(ring) for polygon in polygons for ring in polygon)


# Simplification (`simplify.ts`), with V8's arithmetic.

_METERS_PER_DEGREE_LAT = 110_574
_METERS_PER_DEGREE_LON = 111_320


def _hypot(x: float, y: float) -> float:
    """V8's `Math.hypot` of two numbers: both scaled to the larger, their
    squares summed, the root scaled back. (V8 sums with Kahan's compensation,
    which is exactly zero for two terms.)"""
    ax, ay = abs(x), abs(y)
    top = ax if ax > ay else ay
    if top == _INF:
        return _INF
    if top == 0:
        return 0.0
    nx, ny = ax / top, ay / top
    return math.sqrt(nx * nx + ny * ny) * top


def _high_word(x: float) -> int:
    return struct.unpack(">q", struct.pack(">d", x))[0] >> 32


def _from_high_word(high: int) -> float:
    return struct.unpack(">d", struct.pack(">II", high & 0xFFFFFFFF, 0))[0]


_C = (
    4.16666666666666019037e-02,
    -1.38888888888741095749e-03,
    2.48015872894767294178e-05,
    -2.75573143513906633035e-07,
    2.08757232129817482790e-09,
    -1.13596475577881948265e-11,
)
_S = (
    -1.66666666666666324348e-01,
    8.33333333332248946124e-03,
    -1.98412698298579493134e-04,
    2.75573137070700676789e-06,
    -2.50507602534068634195e-08,
    1.58969099521155010221e-10,
)
_PIO2_1 = 1.57079632673412561417e00
_PIO2_1T = 6.07710050650619224932e-11
_PIO2_2 = 6.07710050630396597660e-11
_PIO2_2T = 2.02226624879595063154e-21


def _kernel_cos(x: float, y: float) -> float:
    c1, c2, c3, c4, c5, c6 = _C
    ix = _high_word(x) & 0x7FFFFFFF
    if ix < 0x3E400000 and int(x) == 0:
        return 1.0
    z = x * x
    r = z * (c1 + z * (c2 + z * (c3 + z * (c4 + z * (c5 + z * c6)))))
    if ix < 0x3FD33333:
        return 1.0 - (0.5 * z - (z * r - x * y))
    qx = 0.28125 if ix > 0x3FE90000 else _from_high_word(ix - 0x00200000)
    iz = 0.5 * z - qx
    a = 1.0 - qx
    return a - (iz - (z * r - x * y))


def _kernel_sin(x: float, y: float) -> float:
    s1, s2, s3, s4, s5, s6 = _S
    ix = _high_word(x) & 0x7FFFFFFF
    if ix < 0x3E400000 and int(x) == 0:
        return x
    z = x * x
    v = z * x
    r = s2 + z * (s3 + z * (s4 + z * (s5 + z * s6)))
    return x - ((z * (0.5 * y - v * r) - y) - v * s1)


def _cos(x: float) -> float:
    """V8's `Math.cos` (fdlibm) for |x| < 3pi/4, which a latitude in radians
    is; beyond that the platform's cosine."""
    hx = _high_word(x)
    ix = hx & 0x7FFFFFFF
    if ix <= 0x3FE921FB:
        return _kernel_cos(x, 0.0)
    if ix >= 0x4002D97C:
        return math.cos(x)
    if hx > 0:
        z = x - _PIO2_1
        if ix != 0x3FF921FB:
            y0 = z - _PIO2_1T
            y1 = (z - y0) - _PIO2_1T
        else:
            z -= _PIO2_2
            y0 = z - _PIO2_2T
            y1 = (z - y0) - _PIO2_2T
        return -_kernel_sin(y0, y1)
    z = x + _PIO2_1
    if ix != 0x3FF921FB:
        y0 = z + _PIO2_1T
        y1 = (z - y0) + _PIO2_1T
    else:
        z += _PIO2_2
        y0 = z + _PIO2_2T
        y1 = (z - y0) + _PIO2_2T
    return _kernel_sin(y0, y1)


def _project(position: Sequence[float]) -> tuple[float, float]:
    lon, lat = position[0], position[1]
    return (
        lon * _cos((lat * math.pi) / 180) * _METERS_PER_DEGREE_LON,
        lat * _METERS_PER_DEGREE_LAT,
    )


def _distance(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    """The distance from p to the segment a-b."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = dx * dx + dy * dy
    t = (
        max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
        if length
        else 0
    )
    return _hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _importance(points: list[tuple[float, float]]) -> list[float]:
    """Each vertex's rank in the order Douglas-Peucker keeps them: the distance
    at which it is kept, never more than that of the vertex that split its
    segment. Three vertices of the ring always stay. `points` holds the ring
    without its closing position."""
    n = len(points)
    if n <= 3:
        return [_INF] * n
    rank = [0.0] * n
    first = points[0]
    far = 1
    for i in range(2, n):
        if _hypot(points[i][0] - first[0], points[i][1] - first[1]) > _hypot(
            points[far][0] - first[0], points[far][1] - first[1]
        ):
            far = i
    rank[0] = _INF
    rank[far] = _INF
    # Segments as (from, to, rank of the vertex that split them); `to` may be n, the ring's first vertex again.
    stack: list[tuple[int, int, float]] = [(0, far, _INF), (far, n, _INF)]
    while stack:
        start, end, parent = stack.pop()
        a, b = points[start % n], points[end % n]
        best = -1
        best_distance = -1.0
        # `_distance` and `_hypot` written out: this loop is where an outline of many positions spends its time.
        a0, a1 = a
        dx = b[0] - a0
        dy = b[1] - a1
        length = dx * dx + dy * dy
        for i in range(start + 1, end):
            px, py = points[i]
            px -= a0
            py -= a1
            t = max(0.0, min(1.0, (px * dx + py * dy) / length)) if length else 0
            ex = abs(px - t * dx)
            ey = abs(py - t * dy)
            top = ex if ex > ey else ey
            if top == 0:
                d = 0.0
            else:
                nx, ny = ex / top, ey / top
                d = math.sqrt(nx * nx + ny * ny) * top
            if d > best_distance:
                best_distance = d
                best = i
        if best < 0:
            continue
        rank[best] = min(best_distance, parent)
        stack.append((start, best, rank[best]))
        stack.append((best, end, rank[best]))
    # The third vertex: the one that would be kept first after the two ends.
    third = -1
    for i in range(1, n):
        if rank[i] != _INF and (third < 0 or rank[i] > rank[third]):
            third = i
    if third >= 0:
        rank[third] = _INF
    return rank


def simplify_to_fit(
    polygons: Polygons, fits: Callable[[Polygons], bool]
) -> Simplified | None:
    """The outline with as few positions dropped as `fits` allows, in the order
    Douglas-Peucker drops them, and how far it moved; None when even every ring
    at four positions does not fit. Every ring stays, and only positions of the
    outline are kept. Distances are meters on a local projection."""
    rings = []
    for polygon in polygons:
        for ring in polygon:
            open_ring = ring[:-1]
            projected = [_project(p) for p in open_ring]
            rings.append((open_ring, projected, _importance(projected)))
    # The vertices that may go, the most important first.
    optional = sorted(
        (
            (rank, k, i)
            for k, (_, _, ranks) in enumerate(rings)
            for i, rank in enumerate(ranks)
            if rank != _INF
        ),
        key=lambda v: (-v[0], v[1], v[2]),
    )

    def kept_with(count: int) -> list[list[int]]:
        kept = [[1 if rank == _INF else 0 for rank in ranks] for _, _, ranks in rings]
        for _, k, i in optional[:count]:
            kept[k][i] = 1
        return kept

    def candidate(kept: list[list[int]]) -> Polygons:
        out = []
        k = 0
        for polygon in polygons:
            rings_out = []
            for _ in polygon:
                ring = [p for p, keep in zip(rings[k][0], kept[k], strict=True) if keep]
                rings_out.append((*ring, ring[0]))
                k += 1
            out.append(tuple(rings_out))
        return tuple(out)

    if not fits(candidate(kept_with(0))):
        return None
    # The most vertices that fit.
    low, high = 0, len(optional)
    while low < high:
        mid = -(-(low + high) // 2)
        if fits(candidate(kept_with(mid))):
            low = mid
        else:
            high = mid - 1
    kept = kept_with(low)

    # How far the outline moved: each dropped vertex from the edge between the kept ones around it.
    shift = 0.0
    for k, (_, projected, _) in enumerate(rings):
        n = len(projected)
        keep = kept[k]
        first = keep.index(1)
        start = first
        for step in range(1, n + 1):
            i = (first + step) % n
            if not keep[i]:
                continue
            j = (start + 1) % n
            while j != i:
                shift = max(
                    shift, _distance(projected[j], projected[start], projected[i])
                )
                j = (j + 1) % n
            start = i
    return Simplified(polygons=candidate(kept), shift=shift)


# Pieces as the picker changes them (`pieces.ts`).


def with_piece(pieces: Sequence[Piece], piece: Piece) -> tuple[Piece, ...]:
    """The pieces with one more: a map view replaces the one there is, a shape
    goes right after the other shapes, features go last."""
    out = list(pieces)
    if isinstance(piece, ViewPiece):
        at = next((i for i, p in enumerate(out) if isinstance(p, ViewPiece)), -1)
        if at >= 0:
            out[at] = piece
        else:
            out.append(piece)
    elif isinstance(piece, ShapePiece):
        last = max(
            (i for i, p in enumerate(out) if isinstance(p, ShapePiece)), default=-1
        )
        out.insert(last + 1 if last >= 0 else len(out), piece)
    else:
        out.append(piece)
    return tuple(out)


def with_feature(
    pieces: Sequence[Piece], source: str, feature: Feature, polygons: Polygons
) -> tuple[Piece, ...]:
    """The pieces with one more picked feature in its source's piece; the same
    pieces when the feature is in already."""
    at = next(
        (
            i
            for i, p in enumerate(pieces)
            if isinstance(p, FeaturesPiece) and p.source == source
        ),
        -1,
    )
    if at < 0:
        return with_piece(
            pieces, FeaturesPiece(source=source, features=(feature,), polygons=polygons)
        )
    piece = pieces[at]
    assert isinstance(piece, FeaturesPiece)
    if any(f.id == feature.id for f in piece.features):
        return tuple(pieces)
    grown = FeaturesPiece(
        source=source,
        features=(*piece.features, feature),
        polygons=(*piece.polygons, *polygons),
    )
    return tuple(grown if i == at else p for i, p in enumerate(pieces))


def _filter_length(
    pieces: Sequence[Piece], rows: Rows | None, outside: bool, property: str
) -> int:
    """The length of the filter with the pieces as its area, switched on, beside
    `rows`, in a map request's URL."""
    cql, notes = area_of(pieces, outside=outside, property=property)
    base = rows or Rows(match="all", rows=())
    query = write_rows(replace(base, area=cql, area_notes=notes)) or {}
    return _url_length(query.get("cql"))


def filter_fits(
    rows: Rows | None = None, *, outside: bool = False, property: str = GEOMETRY_FIELD
) -> Fits:
    """Whether pieces fit into a layer filter, as the filter panel checks a new
    outline: every piece's points together within `MAX_POINTS`, and the filter
    with the area switched on, beside `rows` (none when not given), within the
    length a map request takes (`MAX_LENGTH`)."""

    def fits(pieces: tuple[Piece, ...]) -> bool:
        if point_count(area_polygons(pieces)) > MAX_POINTS:
            return False
        return _filter_length(pieces, rows, outside, property) <= MAX_LENGTH

    return fits


def add(
    polygons: Polygons,
    compose: Callable[[Polygons], tuple[Piece, ...]],
    fits: Fits,
) -> Added | None:
    """The pieces `compose` makes with an outline (`add` in AreaTools.tsx): the
    outline as it is when that fits, else simplified to the most positions
    that fit; None when even simplified it does not. The panel adds a
    simplified outline once the person agrees; here the caller decides."""
    points = point_count(polygons)
    pieces = compose(polygons)
    if fits(pieces):
        return Added(pieces=pieces, points=points, kept=points, shift=0.0)
    simplified = simplify_to_fit(polygons, lambda candidate: fits(compose(candidate)))
    if simplified is None:
        return None
    return Added(
        pieces=compose(simplified.polygons),
        points=points,
        kept=point_count(simplified.polygons),
        shift=simplified.shift,
    )


def add_feature(
    pieces: Sequence[Piece],
    source: str,
    id: str,
    geometry: Any,
    *,
    name: str | None = None,
    fits: Fits,
) -> Added | None:
    """The pieces with a picked feature, as the panel's lists add one: its
    outline (`polygons_of`, which raises ValueError for another geometry)
    rounded, then `add` with `with_feature`. A region's id and name are the
    catalog's; a layer feature's id is its feature id as text and its name the
    value of the layer's name column, the id when that is empty."""
    polygons = round_polygons(polygons_of(geometry))
    return add(
        polygons,
        lambda p: with_feature(pieces, source, Feature(id=id, name=name, n=len(p)), p),
        fits,
    )


def add_view(
    pieces: Sequence[Piece], bounds: Sequence[float], *, fits: Fits
) -> Added | None:
    """The pieces with the map view (west, south, east, north) in place of the
    one there is."""
    return add(
        view_piece(bounds).polygons,
        lambda p: with_piece(pieces, ViewPiece(polygons=p)),
        fits,
    )


# The area as the filter saves it.


def _lists(polygons: Polygons) -> list[Any]:
    return [[[list(p) for p in ring] for ring in polygon] for polygon in polygons]


def _feature_note(feature: Feature) -> dict[str, Any]:
    return {
        "id": feature.id,
        **({"name": feature.name} if feature.name is not None else {}),
        "n": feature.n,
    }


def _piece_note(piece: Piece) -> dict[str, Any]:
    n = len(piece.polygons)
    if isinstance(piece, FeaturesPiece):
        return {
            "kind": "features",
            "source": piece.source,
            "features": [_feature_note(f) for f in piece.features],
        }
    if isinstance(piece, ViewPiece):
        return {"kind": "view", "n": n}
    return {
        "kind": "shape",
        "n": n,
        **({"shape": piece.shape} if piece.shape else {}),
        **({"label": piece.label} if piece.label is not None else {}),
        **(
            {"center": list(piece.center), "km": piece.km}
            if piece.center and piece.km is not None
            else {}
        ),
    }


def area_of(
    pieces: Sequence[Piece], *, outside: bool = False, property: str = GEOMETRY_FIELD
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """The area's CQL node (`areaCql`) and its notes `ui.area` (`areaNotes`) for
    an active area; (None, None) without a polygon, as the panel then saves no
    area. Put them in `Rows.area` and `Rows.area_notes`. A freshly built area
    is always switched on: the panel writes a switched-off one (notes with
    `off`, the CQL only there) only when an existing area is switched off."""
    polygons = area_polygons(pieces)
    if not polygons:
        return None, None
    coordinates = _lists(polygons)
    geometry = (
        {"type": "Polygon", "coordinates": coordinates[0]}
        if len(coordinates) == 1
        else {"type": "MultiPolygon", "coordinates": coordinates}
    )
    inside = {"op": "s_intersects", "args": [{"property": property}, geometry]}
    cql = {"op": "not", "args": [inside]} if outside else inside
    notes = {
        "pieces": [_piece_note(p) for p in pieces if p.polygons],
        "sum": area_sum(coordinates),
    }
    return cql, notes


# Reading a saved area (`readArea`, `readAreaNotes`).


def _is_count(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, float):
        return v.is_integer() and v >= 1
    return isinstance(v, int) and v >= 1


def _read_feature(raw: Any) -> Feature | None:
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("id"), str)
        or not _is_count(raw.get("n"))
    ):
        return None
    name = raw.get("name")
    return Feature(
        id=raw["id"], n=int(raw["n"]), name=name if isinstance(name, str) else None
    )


def _is_lon_lat(v: Any) -> bool:
    return _is_position(v) and abs(v[0]) <= 180 and abs(v[1]) <= 90


def _read_piece_note(raw: Any) -> tuple[Piece, int] | None:
    """A piece of the notes without its polygons, and how many are its own."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    if kind == "view":
        return (
            (ViewPiece(polygons=()), int(raw["n"])) if _is_count(raw.get("n")) else None
        )
    if kind == "shape":
        if not _is_count(raw.get("n")):
            return None
        shape = raw.get("shape") if raw.get("shape") in ("polygon", "circle") else None
        label = raw.get("label") if isinstance(raw.get("label"), str) else None
        km = raw.get("km")
        circle = (
            shape == "circle"
            and _is_lon_lat(raw.get("center"))
            and _is_number(km)
            and km > 0
        )
        piece = ShapePiece(
            polygons=(),
            shape=shape,
            label=label,
            center=(raw["center"][0], raw["center"][1]) if circle else None,
            km=km if circle else None,
        )
        return piece, int(raw["n"])
    if kind == "features":
        source, raw_features = raw.get("source"), raw.get("features")
        if (
            not isinstance(source, str)
            or not isinstance(raw_features, list)
            or not raw_features
        ):
            return None
        features = [_read_feature(f) for f in raw_features]
        if any(f is None for f in features):
            return None
        return (
            FeaturesPiece(source=source, features=tuple(features), polygons=()),
            sum(f.n for f in features),
        )
    return None


def _read_notes(raw: Any) -> list[tuple[Piece, int]] | None:
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("sum"), str)
        or not isinstance(raw.get("pieces"), list)
    ):
        return None
    pieces = [_read_piece_note(p) for p in raw["pieces"]]
    return None if any(p is None for p in pieces) else pieces


def _intersects(node: Any) -> tuple[str, dict[str, Any], Polygons] | None:
    if not isinstance(node, dict) or node.get("op") != "s_intersects":
        return None
    args = node.get("args")
    if not isinstance(args, list) or len(args) != 2:
        return None
    field, geometry = args
    if not isinstance(field, dict) or not isinstance(field.get("property"), str):
        return None
    polygons = _geometry_polygons(geometry)
    return (field["property"], geometry, polygons) if polygons else None


def read_area(node: Any, notes: Any, *, enabled: bool = True) -> Area | None:
    """The area an area node says (`s_intersects` of a field and polygons, or
    `not` of exactly that), in the pieces its notes describe; one piece when
    the notes describe another geometry (the map view for an extent older
    panels saved, a shape otherwise). None for any other node. Never raises."""
    outside = isinstance(node, dict) and node.get("op") == "not"
    if outside:
        args = node.get("args")
        read = (
            _intersects(args[0]) if isinstance(args, list) and len(args) == 1 else None
        )
    else:
        read = _intersects(node)
    if read is None:
        return None
    field, geometry, polygons = read
    noted = _read_notes(notes)
    pieces: tuple[Piece, ...] | None = None
    if (
        noted is not None
        and notes["sum"] == area_sum(polygons)
        and sum(n for _, n in noted) == len(polygons)
    ):
        out = []
        at = 0
        for piece, n in noted:
            out.append(replace(piece, polygons=polygons[at : at + n]))
            at += n
        pieces = tuple(out)
    if pieces is None:
        properties = (
            geometry.get("properties")
            if isinstance(geometry.get("properties"), dict)
            else {}
        )
        label = properties.get("label")
        pieces = (
            (ViewPiece(polygons=polygons),)
            if properties.get("type") == "bbox"
            else (
                ShapePiece(
                    polygons=polygons,
                    label=label if isinstance(label, str) and label else None,
                ),
            )
        )
    return Area(pieces=pieces, outside=outside, enabled=enabled, property=field)


# Limits and summary.


def over_limits(
    pieces: Sequence[Piece],
    rows: Rows | None = None,
    *,
    outside: bool = False,
    property: str = GEOMETRY_FIELD,
) -> list[str]:
    """What a filter with these pieces as its area would be refused for, as
    plain sentences; empty when it is fine.

    - Drawn shapes: the shape pieces, at most `MAX_SHAPES` (the panel draws no
      more). The server counts the geometries in the CQL instead, and the
      whole area is one of them.
    - Features: the features of every features piece together, at most
      `MAX_FEATURES` (the panel picks no more; the server does not count them).
    - Points: the positions of every ring of every piece together, at most
      `MAX_POINTS`: the area is one geometry, and the server refuses a
      geometry with more (`area_too_detailed`), as the panel does.
    - Length: the filter as a map request carries it, the area switched on
      beside `rows` (none when not given), at most `MAX_LENGTH` characters,
      numbers written as the web writes them (`too_long` on the server, which
      writes them as Python does: for the area's rounded coordinates that text
      is never longer).
    """
    messages = []
    shapes = sum(isinstance(p, ShapePiece) for p in pieces)
    if shapes > MAX_SHAPES:
        messages.append(
            f"An area takes at most {MAX_SHAPES} drawn shapes; this one has {shapes}."
        )
    features = sum(len(p.features) for p in pieces if isinstance(p, FeaturesPiece))
    if features > MAX_FEATURES:
        messages.append(
            f"An area takes at most {MAX_FEATURES} features picked from regions or layers; this one has {features}."
        )
    points = point_count(area_polygons(pieces))
    if points > MAX_POINTS:
        messages.append(
            f"An area takes at most {MAX_POINTS} points; this one has {points}."
        )
    length = _filter_length(pieces, rows, outside, property)
    if length > MAX_LENGTH:
        messages.append(
            f"A filter sent with a map request takes at most {MAX_LENGTH} characters; this one has {length}."
        )
    return messages


#: The regions a summary names; the others are counted.
_NAMED_REGIONS = 10


def _describe(piece: Piece, layers: Mapping[str, str]) -> str:
    if isinstance(piece, ViewPiece):
        return "the map view"
    if isinstance(piece, FeaturesPiece):
        if piece.source != REGION_SOURCE:
            layer = layers.get(piece.source, "another layer")
            return f"features of {layer}: {len(piece.features)}"
        names = [f'"{f.name}" ({f.id})' if f.name else f.id for f in piece.features]
        more = len(names) - _NAMED_REGIONS
        listed = ", ".join(names[:_NAMED_REGIONS])
        return f"regions: {listed}" + (f" and {more} more" if more > 0 else "")
    if piece.shape == "circle" and piece.km is not None:
        text = f"a circle of {_js_number(piece.km)} km"
    elif piece.shape == "circle":
        text = "a drawn circle"
    else:
        text = "a drawn shape"
    return text + (f' "{piece.label}"' if piece.label else "")


def area_summary(
    notes: Any, node: Any = None, *, layers: Mapping[str, str] | None = None
) -> str:
    """A short description of a stored area for a language model, never its
    coordinates: its pieces joined with "; " (`regions: "Name" (id), ...`,
    `features of <layer>: <count>`, `the map view`, `a drawn shape`), after
    "switched off" and "outside" when they apply.

    `notes` is `ui.area` (`Rows.area_notes`); `node` the area's CQL node
    (`Rows.area`). The notes alone do not say whether the area keeps what lies
    outside, nor whether they still describe the saved geometry: with `node`
    both are read as the panel reads them. A switched-off area's node is in its
    notes (`off`). `layers` names a layer source (its dataset id) for the
    reader, for example "layer 31"; without it a layer is "another layer".
    Never raises."""
    off = isinstance(notes, dict) and isinstance(notes.get("off"), dict)
    if node is None and off:
        node = notes["off"]
    area = read_area(node, notes, enabled=not off) if node is not None else None
    if area is not None:
        pieces, outside = list(area.pieces), area.outside
    else:
        noted = _read_notes(notes)
        if not noted:
            return "an area"
        pieces, outside = [piece for piece, _ in noted], False
    said = [state for state, on in (("switched off", off), ("outside", outside)) if on]
    text = "; ".join(_describe(p, layers or {}) for p in pieces)
    return f"{', '.join(said)}: {text}" if said else text
