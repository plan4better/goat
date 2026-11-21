"""`normalize_area`: a filter's area as one valid polygon or multipolygon."""

import json
import math
from typing import Any

import pytest
import shapely
from goatlib.filter import area as area_module
from goatlib.filter.area import AreaCrossesItselfError, crosses_itself, normalize_area


def square(x: float, y: float, size: float) -> list[list[float]]:
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def polygon(*rings: list[list[float]]) -> dict[str, Any]:
    return {"type": "Polygon", "coordinates": list(rings)}


def multipolygon(*polygons: list[list[list[float]]]) -> dict[str, Any]:
    return {"type": "MultiPolygon", "coordinates": list(polygons)}


def read(geometry: dict[str, Any]) -> shapely.Geometry:
    return shapely.from_geojson(json.dumps(geometry))


def weave(lines: int) -> list[list[float]]:
    """A ring swept in rows and then in columns: every row crosses every column."""
    size = lines + 1
    ring: list[list[float]] = []
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[start, i], [end, i]]
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[i, start], [i, end]]
    return ring + [ring[0]]


def circle(points: int, radius: float = 1.0) -> list[list[float]]:
    ring = [
        [
            11.5 + radius * math.cos(2 * math.pi * i / (points - 1)),
            48.1 + radius * math.sin(2 * math.pi * i / (points - 1)),
        ]
        for i in range(points - 1)
    ]
    return ring + [ring[0]]


def bars(count: int, upright: bool) -> list[list[list[list[float]]]]:
    """Thin rectangles side by side, lying or upright, as a MultiPolygon's polygons."""
    out = []
    for i in range(count):
        ring = [[0, i + 0.4], [count, i + 0.4], [count, i + 0.6], [0, i + 0.6]]
        if upright:
            ring = [[y, x] for x, y in ring]
        out.append([ring + [ring[0]]])
    return out


@pytest.fixture(autouse=True)
def _nothing_remembered() -> None:
    area_module.forget()


def test_overlapping_polygons_become_their_union() -> None:
    area = multipolygon([square(0, 0, 4)], [square(2, 2, 4)])

    result = normalize_area(area)

    assert result["type"] == "Polygon"
    assert shapely.is_valid(read(result))
    assert read(result).area == 4 * 4 * 2 - 2 * 2


def test_a_polygon_filling_another_ones_hole_closes_it() -> None:
    area = multipolygon([square(0, 0, 10), square(4, 4, 2)], [square(3, 3, 4)])

    result = normalize_area(area)

    assert shapely.equals(read(result), shapely.box(0, 0, 10, 10))


def test_polygons_sharing_an_edge_become_one() -> None:
    area = multipolygon([square(0, 0, 2)], [square(2, 0, 2)])

    result = normalize_area(area)

    assert shapely.equals(read(result), shapely.box(0, 0, 4, 2))


def test_a_ring_touching_itself_becomes_a_polygon_with_a_hole() -> None:
    # (2, 4) twice: the ring closes a triangle off inside the square
    ring = [[0, 0], [4, 0], [4, 4], [2, 4], [3, 2], [1, 2], [2, 4], [0, 4], [0, 0]]
    area = polygon(ring)
    assert not shapely.is_valid(read(area))

    result = normalize_area(area)

    assert shapely.is_valid(read(result))
    assert read(result).area == 16 - 2


def test_separate_polygons_stay_apart() -> None:
    area = multipolygon([square(0, 0, 1)], [square(5, 5, 1)])

    assert normalize_area(area) is area


def test_a_valid_polygon_comes_back_as_it_is() -> None:
    area = polygon(square(0.123456789012345, 47.1, 1), square(0.5, 47.5, 0.1))

    assert normalize_area(area) is area


def test_a_polygon_without_area_leaves_an_empty_area() -> None:
    area = polygon([[0, 0], [1, 1], [2, 2], [0, 0]])

    result = normalize_area(area)

    assert result == {"type": "MultiPolygon", "coordinates": []}
    assert read(result).is_empty


def test_a_member_without_area_is_dropped() -> None:
    area = multipolygon([[[0, 0], [1, 1], [2, 2], [0, 0]]], [square(5, 5, 1)])

    result = normalize_area(area)

    assert shapely.equals(read(result), shapely.box(5, 5, 6, 6))


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [1, 2]},
        {"type": "LineString", "coordinates": [[0, 0], [1, 1], [0, 1], [1, 0]]},
        {"type": "Polygon", "coordinates": "not coordinates"},
        {"type": "Polygon"},
    ],
    ids=["point", "line", "unreadable", "no coordinates"],
)
def test_anything_else_comes_back_as_it_is(geometry: dict[str, Any]) -> None:
    assert normalize_area(geometry) is geometry


# what is costly to repair is refused -------------------------------------------------------------


def test_an_outline_that_crosses_itself_a_few_times_is_repaired() -> None:
    area = polygon(weave(3))
    assert not shapely.is_valid(read(area))

    result = normalize_area(area)

    assert shapely.is_valid(read(result))
    assert read(result).area > 0
    assert not crosses_itself(area)


def test_a_detailed_outline_with_one_defect_is_repaired() -> None:
    ring = circle(5000)
    ring[700], ring[701] = ring[701], ring[700]
    area = polygon(ring)
    assert not shapely.is_valid(read(area))

    result = normalize_area(area)

    assert shapely.is_valid(read(result))
    assert read(result).area == pytest.approx(math.pi, rel=1e-3)


def test_an_outline_that_crosses_itself_too_often_is_refused() -> None:
    area = polygon(weave(20))

    assert crosses_itself(area)
    with pytest.raises(AreaCrossesItselfError) as refused:
        normalize_area(area)
    assert str(refused.value) == area_module.CROSSES_ITSELF
    assert isinstance(refused.value, ValueError)


def test_a_tangle_in_a_detailed_outline_is_refused() -> None:
    ring = circle(4000)
    tangle = [[11.5 + x / 100, 48.1 + y / 100] for x, y in weave(20)[:-1]]
    area = polygon(ring[:2000] + tangle + ring[2000:])

    with pytest.raises(AreaCrossesItselfError):
        normalize_area(area)


def test_many_polygons_side_by_side_and_overlapping_are_unioned() -> None:
    area = multipolygon(*bars(20, upright=False), *bars(20, upright=True))

    result = normalize_area(area)

    assert shapely.is_valid(read(result))
    assert read(result).area == pytest.approx(2 * 20 * 20 * 0.2 - 400 * 0.04)


def test_polygons_that_cross_one_another_too_often_are_refused() -> None:
    area = multipolygon(*bars(80, upright=False), *bars(80, upright=True))

    with pytest.raises(AreaCrossesItselfError):
        normalize_area(area)


def test_holes_inside_one_another_are_repaired_until_they_are_too_many() -> None:
    def nested(rings: int) -> dict[str, Any]:
        return polygon(*(square(i, i, 2 * (rings - i)) for i in range(rings)))

    assert shapely.is_valid(read(normalize_area(nested(5))))
    with pytest.raises(AreaCrossesItselfError):
        normalize_area(nested(150))


def test_too_many_polygons_meeting_in_one_point_are_refused() -> None:
    """Valid, but checking it costs by the pairs of edges at the point."""

    def fan(members: int) -> dict[str, Any]:
        def corner(i: float) -> list[float]:
            angle = 2 * math.pi * i / members
            return [math.cos(angle), math.sin(angle)]

        return multipolygon(
            *([[[0, 0], corner(i), corner(i + 0.5), [0, 0]]] for i in range(members))
        )

    few = fan(40)
    assert normalize_area(few) is few
    with pytest.raises(AreaCrossesItselfError):
        normalize_area(fan(1250))


def test_points_given_twice_do_not_count_as_touching() -> None:
    ring = [point for point in circle(400) for _ in range(2)]
    area = polygon(ring)

    assert normalize_area(area) is area


# each area is worked out once ----------------------------------------------------------------


def test_an_area_is_repaired_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    union_all = shapely.union_all
    monkeypatch.setattr(
        shapely, "union_all", lambda *a, **kw: calls.append(1) or union_all(*a, **kw)
    )
    area = multipolygon([square(0, 0, 4)], [square(2, 2, 4)])

    first = normalize_area(area)
    second = normalize_area(json.loads(json.dumps(area)))

    assert len(calls) == 1
    assert first == second


def test_a_repaired_area_is_the_callers_own() -> None:
    area = multipolygon([square(0, 0, 4)], [square(2, 2, 4)])

    first = normalize_area(area)
    expected = json.loads(json.dumps(first))
    first["coordinates"].clear()
    first["type"] = "Point"

    assert normalize_area(area) == expected


def test_a_valid_area_is_checked_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    is_valid = shapely.is_valid
    monkeypatch.setattr(
        shapely, "is_valid", lambda *a, **kw: calls.append(1) or is_valid(*a, **kw)
    )
    area = polygon(square(0, 0, 1))

    assert normalize_area(area) is area
    assert normalize_area(area) is area
    same = json.loads(json.dumps(area))
    assert normalize_area(same) is same
    assert len(calls) == 1


def test_a_refusal_is_remembered(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    from_geojson = shapely.from_geojson
    monkeypatch.setattr(
        shapely,
        "from_geojson",
        lambda *a, **kw: calls.append(1) or from_geojson(*a, **kw),
    )
    area = polygon(weave(20))

    for _ in range(3):
        assert crosses_itself(area)
        with pytest.raises(AreaCrossesItselfError):
            normalize_area(area)
    assert len(calls) == 1


def test_only_so_many_areas_are_remembered() -> None:
    for i in range(area_module.REMEMBERED + 50):
        normalize_area(polygon(square(i, 0, 1)))

    assert area_module.remembered() == area_module.REMEMBERED
