"""The filter limits and `measure`."""

import json
from typing import Any

from goatlib.filter import limits
from goatlib.filter.limits import Measure, measure

P = {"property": "a"}


def eq(value: Any, field: dict[str, str] = P) -> dict[str, Any]:
    return {"op": "=", "args": [field, value]}


def ring(points: int) -> list[list[float]]:
    """A closed ring of `points` positions."""
    return [[i * 0.001, (i % 2) * 0.001] for i in range(points - 1)] + [[0.0, 0.0]]


def test_the_limits_come_from_operators_json() -> None:
    assert (
        limits.MAX_CONDITIONS,
        limits.MAX_VALUES,
        limits.MAX_DEPTH,
        limits.MAX_SHAPES,
        limits.MAX_FEATURES,
        limits.MAX_POINTS,
        limits.MAX_LENGTH,
    ) == (20, 100, 32, 3, 200, 2000, 60000)


def test_url_length_is_the_filter_as_the_web_sends_it() -> None:
    """Compact JSON as encodeURIComponent writes it in a URL: the web counts
    118 for the same filter."""
    cql = eq("Straße & Co (1)!*~")
    assert limits.url_length(cql) == 118


def test_style_cql_shares_the_depth_limit() -> None:
    from goatlib.style import cql

    assert cql.MAX_DEPTH == limits.MAX_DEPTH


def test_a_single_comparison() -> None:
    cql = eq(1)
    assert measure(cql) == Measure(
        conditions=1,
        max_values=1,
        depth=1,
        shapes=0,
        max_points=0,
        bytes=len(json.dumps(cql, separators=(",", ":"))),
    )


def test_rows_of_a_top_level_and() -> None:
    cql = {
        "op": "and",
        "args": [
            eq(1),
            {"op": "in", "args": [{"property": "b"}, [1, 2, 3]]},
            {"op": "isNull", "args": [{"property": "c"}]},
        ],
    }
    m = measure(cql)
    assert (m.conditions, m.max_values, m.depth) == (3, 3, 2)


def test_a_value_list_written_as_alternatives_is_one_condition() -> None:
    includes = {"op": "or", "args": [eq(v) for v in range(25)]}
    m = measure({"op": "and", "args": [includes]})
    assert (m.conditions, m.max_values) == (1, 25)


def test_a_negation_with_its_empty_alternative_is_one_condition() -> None:
    excludes = {
        "op": "or",
        "args": [
            {"op": "and", "args": [{"op": "!=", "args": [P, v]} for v in "xyz"]},
            {"op": "isNull", "args": P},
        ],
    }
    not_in = {
        "op": "or",
        "args": [
            {"op": "not", "args": [{"op": "in", "args": [P, [1, 2]]}]},
            {"op": "isNull", "args": [P]},
        ],
    }
    assert measure({"op": "and", "args": [excludes]}).conditions == 1
    assert measure({"op": "and", "args": [excludes]}).max_values == 3
    assert measure({"op": "and", "args": [not_in]}).conditions == 1
    assert measure({"op": "and", "args": [not_in]}).max_values == 2


def test_a_range_on_one_field_is_one_condition() -> None:
    between = {
        "op": "and",
        "args": [{"op": ">=", "args": [P, 1]}, {"op": "<=", "args": [P, 5]}],
    }
    m = measure({"op": "and", "args": [between, eq(1, {"property": "b"})]})
    assert (m.conditions, m.max_values) == (2, 2)
    two_fields = {"op": "and", "args": [eq(1), eq(1, {"property": "b"})]}
    assert measure({"op": "or", "args": [two_fields]}).conditions == 2


def test_shapes_and_points() -> None:
    small = {"type": "Polygon", "coordinates": [ring(5)]}
    big = {"type": "MultiPolygon", "coordinates": [[ring(10)], [ring(30), ring(6)]]}
    cql = {
        "op": "and",
        "args": [
            {"op": "s_intersects", "args": [{"property": "geom"}, small]},
            {"op": "s_intersects", "args": [{"property": "geom"}, big]},
            {
                "op": "s_intersects",
                "args": [{"property": "geom"}, {"bbox": [0, 0, 1, 1]}],
            },
            eq(1),
        ],
    }
    m = measure(cql)
    assert (m.shapes, m.max_points, m.conditions) == (3, 46, 1)


def test_bytes_is_the_compact_json_size() -> None:
    cql = {"op": "=", "args": [{"property": "Straße"}, 'Köln "x"']}
    expected = len(
        json.dumps(cql, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    assert measure(cql).bytes == expected


def test_a_very_deep_tree_does_not_recurse() -> None:
    cql: Any = eq(1)
    for _ in range(5_000):
        cql = {"op": "not", "args": [cql]}
    m = measure(cql)
    assert m.depth == 5_001
    assert m.conditions == 1
    assert m.bytes > 5_000 * len('{"op":"not","args":[]}')


def test_anything_else_measures_as_nothing() -> None:
    assert measure(None) == Measure(0, 0, 1, 0, 0, 4)
    assert measure("x").conditions == 0
