"""The request ceilings: what one request may carry, well above the save limits."""

from typing import Any

import pytest
from goatlib.filter import limits
from goatlib.filter.validate import (
    over_request_limits,
    over_request_limits_text,
    validate,
)
from pygeofilter.parsers.cql2_text import parse as parse_text

from .conftest import load_cases

P = {"property": "a"}
G = {"property": "geom"}


def eq(i: int) -> dict[str, Any]:
    return {"op": "=", "args": [{"property": f"f{i}"}, i]}


def conditions(n: int) -> dict[str, Any]:
    return {"op": "and", "args": [eq(i) for i in range(n)]}


def values(n: int) -> dict[str, Any]:
    return {"op": "in", "args": [P, list(range(n))]}


def nested(levels: int) -> dict[str, Any]:
    node: dict[str, Any] = {"op": "=", "args": [P, 1]}
    for _ in range(levels - 1):
        node = {"op": "and", "args": [node]}
    return node


def square(i: int) -> dict[str, Any]:
    ring = [[i, 0], [i, 1], [i + 1, 1], [i + 1, 0], [i, 0]]
    return {
        "op": "s_intersects",
        "args": [G, {"type": "Polygon", "coordinates": [ring]}],
    }


def shapes(n: int) -> dict[str, Any]:
    return {"op": "or", "args": [square(i) for i in range(n)]}


def area(points: int) -> dict[str, Any]:
    """A saw blade: teeth along the top, closed underneath."""
    teeth = [[i * 0.001, (i % 2) * 0.001] for i in range(points - 3)]
    ring = teeth + [[teeth[-1][0], -1.0], [0.0, -1.0], [0.0, 0.0]]
    return {
        "op": "s_intersects",
        "args": [G, {"type": "Polygon", "coordinates": [ring]}],
    }


def test_the_ceilings_lie_above_the_save_limits() -> None:
    assert limits.REQUEST_MAX_CONDITIONS > limits.MAX_CONDITIONS
    assert limits.REQUEST_MAX_VALUES > limits.MAX_VALUES
    assert limits.REQUEST_MAX_SHAPES > limits.MAX_SHAPES
    assert limits.REQUEST_MAX_POINTS > limits.MAX_POINTS
    assert limits.REQUEST_MAX_DEPTH == limits.MAX_DEPTH


CEILINGS = [
    ("too_many_conditions", conditions, limits.REQUEST_MAX_CONDITIONS),
    ("too_many_values", values, limits.REQUEST_MAX_VALUES),
    ("too_deep", nested, limits.REQUEST_MAX_DEPTH),
    ("too_many_shapes", shapes, limits.REQUEST_MAX_SHAPES),
    ("area_too_detailed", area, limits.REQUEST_MAX_POINTS),
]


@pytest.mark.parametrize("code, build, ceiling", CEILINGS, ids=[c[0] for c in CEILINGS])
def test_exactly_at_a_ceiling_and_one_over(code: str, build: Any, ceiling: int) -> None:
    assert over_request_limits(build(ceiling)) == []
    issues = over_request_limits(build(ceiling + 1))
    assert [i.code for i in issues] == [code]
    assert str(ceiling) in issues[0].message
    assert issues[0].level == "error"


def test_a_filter_over_a_save_limit_passes_a_request() -> None:
    cql = {
        "op": "and",
        "args": [{"op": "=", "args": [P, 1]}, area(limits.MAX_POINTS + 400)],
    }
    assert [i.code for i in validate(cql)] == ["area_too_detailed"]
    assert over_request_limits(cql) == []


def test_every_shared_case_passes_a_request() -> None:
    # The depth ceiling is the save limit: the parser recurses once per level.
    # An area is costly by how it crosses itself, not by who sends it.
    refused = {
        "depth_over_the_limit": ["too_deep"],
        "area_crosses_itself": ["area_crosses_itself"],
    }
    for case in load_cases():
        expected = refused.get(case["name"], [])
        assert [i.code for i in over_request_limits(case["cql"])] == expected, case[
            "name"
        ]


def test_too_deep_is_answered_before_anything_else_is_read() -> None:
    cql: Any = {"op": "=", "args": [P, 1]}
    for _ in range(5_000):
        cql = {"op": "not", "args": [cql]}
    assert [i.code for i in over_request_limits(cql)] == ["too_deep"]


def test_what_is_not_a_filter_measures_as_nothing() -> None:
    for value in (None, "text", 3, [], {}):
        assert over_request_limits(value) == []


def test_a_filter_wrapper_is_measured_as_the_parser_reads_it() -> None:
    """The parser reads `{"filter": x}` as `x`, at any level, so the ceilings
    do too."""
    deep = nested(limits.REQUEST_MAX_DEPTH + 1)
    assert [i.code for i in over_request_limits({"filter": deep})] == ["too_deep"]
    wrapped = {"op": "and", "args": [{"filter": deep}]}
    assert [i.code for i in over_request_limits(wrapped)] == ["too_deep"]
    many = {"filter-lang": "cql2-json", "filter": values(limits.REQUEST_MAX_VALUES + 1)}
    assert [i.code for i in over_request_limits(many)] == ["too_many_values"]
    assert over_request_limits({"filter": nested(limits.REQUEST_MAX_DEPTH)}) == []


def weave(lines: int) -> dict[str, Any]:
    """An area swept in rows and then in columns: every row crosses every column."""
    size = lines + 1
    ring: list[list[float]] = []
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[start, i], [end, i]]
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[i, start], [i, end]]
    return {
        "op": "s_intersects",
        "args": [G, {"type": "Polygon", "coordinates": [ring + [ring[0]]]}],
    }


def test_an_area_that_crosses_itself_too_often_is_refused_on_a_request() -> None:
    cql = {"op": "and", "args": [{"op": "=", "args": [P, 1]}, weave(20)]}

    issues = over_request_limits(cql)

    assert [(i.path, i.code, i.level) for i in issues] == [
        ("/args/1/args/1", "area_crosses_itself", "error")
    ]
    assert over_request_limits({"filter": cql}) == issues
    assert over_request_limits({"op": "and", "args": [weave(3)]}) == []


def wkt(geometry: dict[str, Any]) -> str:
    ring = ", ".join(f"{x} {y}" for x, y in geometry["coordinates"][0])
    return f"S_INTERSECTS(geom, POLYGON(({ring})))"


def test_text_is_measured_as_the_json_it_stands_for() -> None:
    """The parser reads `a AND b AND c` as pairs in pairs: no deeper than its
    one `and` in JSON."""
    chain = " AND ".join(f"field{i} = {i}" for i in range(limits.REQUEST_MAX_DEPTH * 3))
    assert over_request_limits_text(parse_text(chain)) == []
    either = " OR ".join(f"field{i} = {i}" for i in range(limits.REQUEST_MAX_DEPTH * 3))
    assert over_request_limits_text(parse_text(f"field = 1 AND ({either})")) == []

    listed = ", ".join(str(i) for i in range(limits.REQUEST_MAX_VALUES + 1))
    many = parse_text(f"field IN ({listed})")
    assert [i.code for i in over_request_limits_text(many)] == ["too_many_values"]

    long = " AND ".join(
        f"field{i} = {i}" for i in range(limits.REQUEST_MAX_CONDITIONS + 1)
    )
    assert [i.code for i in over_request_limits_text(parse_text(long))] == [
        "too_many_conditions"
    ]


def test_an_area_in_text_is_held_against_the_ceilings() -> None:
    fine = parse_text(wkt(area(limits.MAX_POINTS)["args"][1]))
    assert over_request_limits_text(fine) == []

    detailed = parse_text(wkt(area(limits.REQUEST_MAX_POINTS + 1)["args"][1]))
    assert [i.code for i in over_request_limits_text(detailed)] == ["area_too_detailed"]

    tangled = parse_text(wkt(weave(20)["args"][1]))
    assert [i.code for i in over_request_limits_text(tangled)] == [
        "area_crosses_itself"
    ]


def test_text_the_json_form_cannot_express_measures_as_nothing() -> None:
    assert over_request_limits_text(object()) == []
