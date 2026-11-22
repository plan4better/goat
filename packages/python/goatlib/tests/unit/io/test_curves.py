"""Arcs replaced by straight pieces (`io/curves.py`): the points stay on the
arc's circle at the coordinates plans are drawn in."""

import math

import pytest
from goatlib.io.curves import _arc

#: A place in UTM 32N metres, as a plan's coordinates are.
X, Y = 566_000.0, 5_934_000.0


@pytest.mark.parametrize("radius", [0.05, 0.5, 5.0, 500.0])
def test_an_arcs_points_are_on_its_circle_at_map_coordinates(radius: float):
    """A rounded kerb has a radius of half a metre at coordinates of millions
    of metres: the points between its ends are on its circle to a tenth of a
    millimetre, not millimetres off."""
    start, mid, end = (
        (X + radius * math.cos(a), Y + radius * math.sin(a))
        for a in (0.0, math.pi / 4, math.pi / 2)
    )

    points = _arc(start, mid, end)

    assert points[0] == start and points[-1] == end
    assert len(points) > 3
    for x, y in points:
        assert math.hypot(x - X, y - Y) == pytest.approx(radius, abs=1e-4)


def test_a_full_circle_is_drawn_round():
    """A circle is an arc that ends where it starts, its middle point
    opposite: it stays a circle, not a line there and back."""
    start, opposite = (X + 2.0, Y), (X - 2.0, Y)

    points = _arc(start, opposite, start)

    assert points[0] == points[-1] == start
    assert len(points) >= 64
    for x, y in points:
        assert math.hypot(x - X, y - Y) == pytest.approx(2.0, abs=1e-4)
    # It goes around: points on both sides of the diameter.
    assert min(y for _, y in points) < Y - 1.9 and max(y for _, y in points) > Y + 1.9
