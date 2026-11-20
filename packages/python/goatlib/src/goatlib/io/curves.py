"""Curved geometries to straight ones.

GML (plans, the cadastre) draws rounded corners and street bends as arcs, which GDAL reads as
curve types (CircularString, CompoundCurve, CurvePolygon, MultiCurve,
MultiSurface). DuckDB, shapely and the map tiles know only straight segments,
and GDAL offers no way to straighten them while reading, so each arc is
replaced by a polyline through points on its circle.
"""

import math
import struct

import shapely
from shapely.geometry.base import BaseGeometry

#: The largest angle one straight piece of an arc may span.
MAX_STEP = math.pi / 32


def _arc(p0: tuple, p1: tuple, p2: tuple) -> list[tuple]:
    """Points along the circle through p0, p1, p2, from p0 to p2 via p1."""
    (ax, ay), (bx, by), (cx, cy) = p0[:2], p1[:2], p2[:2]
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:  # the three points are on a line
        return [p0, p2] if p0 != p2 else [p0, p1, p2]
    ux = (
        (ax**2 + ay**2) * (by - cy)
        + (bx**2 + by**2) * (cy - ay)
        + (cx**2 + cy**2) * (ay - by)
    ) / d
    uy = (
        (ax**2 + ay**2) * (cx - bx)
        + (bx**2 + by**2) * (ax - cx)
        + (cx**2 + cy**2) * (bx - ax)
    ) / d
    radius = math.hypot(ax - ux, ay - uy)
    a0, a1, a2 = (math.atan2(y - uy, x - ux) for x, y in ((ax, ay), (bx, by), (cx, cy)))
    if p0 == p2:  # a full circle: p1 is the opposite point
        sweep = 2 * math.pi
    else:
        ccw = (a1 - a0) % (2 * math.pi) < (a2 - a0) % (2 * math.pi)
        sweep = (a2 - a0) % (2 * math.pi)
        if not ccw:
            sweep -= 2 * math.pi
    steps = max(2, math.ceil(abs(sweep) / MAX_STEP))
    points = [
        (
            ux + radius * math.cos(a0 + sweep * i / steps),
            uy + radius * math.sin(a0 + sweep * i / steps),
        )
        for i in range(steps + 1)
    ]
    points[0], points[-1] = p0[:2], p2[:2]
    return points


def _circular(points: list[tuple]) -> list[tuple]:
    out = [points[0][:2]]
    for i in range(0, len(points) - 2, 2):
        out += _arc(points[i], points[i + 1], points[i + 2])[1:]
    return out


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data, self.pos = data, 0

    def take(self, fmt: str) -> tuple:
        values = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += struct.calcsize(fmt)
        return values

    def geometry(self) -> BaseGeometry | list:
        (order,) = self.take("B")
        e = "<" if order == 1 else ">"
        (code,) = self.take(e + "I")
        flags, kind = code // 1000, code % 1000
        if code & 0x80000000 or code & 0x40000000:  # EWKB Z / M flags
            kind = code & 0xFFFF
            flags = (1 if code & 0x80000000 else 0) + (2 if code & 0x40000000 else 0)
        dims = {0: 2, 1: 3, 2: 3, 3: 4}[flags]

        def points() -> list[tuple]:
            (n,) = self.take(e + "I")
            return [self.take(e + "d" * dims)[:2] for _ in range(n)]

        def parts() -> list:
            (n,) = self.take(e + "I")
            return [self.geometry() for _ in range(n)]

        if kind == 1:
            return shapely.Point(self.take(e + "d" * dims)[:2])
        if kind == 2:
            return shapely.LineString(points())
        if kind == 8:
            return shapely.LineString(_circular(points()))
        if kind == 3:
            (n,) = self.take(e + "I")
            rings = [points() for _ in range(n)]
            return shapely.Polygon(rings[0], rings[1:]) if rings else shapely.Polygon()
        if kind == 9:  # CompoundCurve: its parts joined end to end
            coords: list[tuple] = []
            for part in parts():
                c = list(part.coords)
                coords += c if not coords else c[1:]
            return shapely.LineString(coords)
        if kind == 10:  # CurvePolygon: rings of any curve type
            rings = [list(r.coords) for r in parts()]
            return shapely.Polygon(rings[0], rings[1:]) if rings else shapely.Polygon()
        if kind in (4, 5, 6, 7, 11, 12):
            members = parts()
            if kind == 4:
                return shapely.MultiPoint(members)
            if kind in (5, 11):
                return shapely.MultiLineString(members)
            if kind in (6, 12):
                return shapely.MultiPolygon(members)
            return shapely.GeometryCollection(members)
        raise ValueError(f"Unsupported WKB geometry type {code}")


def linear_wkb(wkb: bytes | None) -> bytes | None:
    """The geometry as 2D WKB with every arc replaced by straight segments."""
    if wkb is None:
        return None
    return shapely.to_wkb(_Reader(bytes(wkb)).geometry())
