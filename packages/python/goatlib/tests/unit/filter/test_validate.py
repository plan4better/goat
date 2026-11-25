"""`validate` over the shared cases, and what the cases cannot show."""

import json
from typing import Any

import pytest
from goatlib.filter.issues import CODES
from goatlib.filter.limits import TABLE
from goatlib.filter.validate import validate
from goatlib.style.context import DataContext

from .conftest import context, load_cases

CASES = load_cases()
ROW_OPS = {op for ops in TABLE["operators"].values() for op in ops}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case(case: dict[str, Any]) -> None:
    issues = validate(case["cql"], context(case["fields"]))
    assert [i.code for i in issues] == case["issues"], [
        (i.path, i.code, i.message) for i in issues
    ]
    assert all(i.message for i in issues)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case_shape(case: dict[str, Any]) -> None:
    assert set(case) <= {"name", "note", "fields", "cql", "issues", "rows", "stable"}
    assert set(case["fields"].values()) <= set(TABLE["operators"])
    assert set(case["issues"]) <= set(CODES)
    rows = case.get("rows")
    if rows is None or rows == "custom":
        return
    assert set(rows) <= {"match", "rows", "area"}
    assert rows["match"] in ("all", "any")
    assert rows.get("area") in (None, "inside", "outside")
    for row in rows["rows"]:
        if row == "custom":
            continue
        assert set(row) <= {"field", "op", "value", "value2"}
        assert row["op"] in ROW_OPS


def test_every_code_has_a_case() -> None:
    seen = {code for case in CASES for code in case["issues"]}
    assert seen == set(CODES)


def test_issue_paths_point_at_the_condition() -> None:
    cql = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "name"}, "x"]},
            {
                "op": "or",
                "args": [
                    {"op": "=", "args": [{"property": "gone"}, 1]},
                    {"op": "!=", "args": [{"property": "name"}, "y"]},
                ],
            },
        ],
    }
    issues = validate(cql, context({"name": "string"}))
    assert [(i.path, i.code) for i in issues] == [
        ("/args/1/args/0", "unknown_field"),
        ("/args/1/args/1", "negation_drops_empty"),
    ]


def test_paths_are_ordered_as_numbers() -> None:
    cql = {
        "op": "and",
        "args": [{"op": "=", "args": [{"property": f"f{i}"}, 1]} for i in range(12)],
    }
    issues = validate(cql, context({}))
    assert [i.path for i in issues] == [f"/args/{i}" for i in range(12)]


def test_without_a_context_only_shape_and_limits_are_checked() -> None:
    by_name = {c["name"]: c for c in CASES}
    for name, expected in [
        ("unknown_field", []),
        ("number_compared_with_text", []),
        ("like_on_a_number", []),
        ("not_a_condition", ["malformed"]),
        ("array_operator", ["operator_unsupported"]),
        ("like_with_a_wildcard_inside", []),
        ("function_not_allowed", ["operator_unsupported"]),
        ("function_reads_an_unknown_field", []),
        ("values_over_the_limit", ["too_many_values"]),
        ("legacy_is_not_bare", ["negation_drops_empty"]),
    ]:
        assert [i.code for i in validate(by_name[name]["cql"])] == expected, name
    unknown_fields = DataContext(kind="vector", fields=None)
    assert validate(by_name["unknown_field"]["cql"], unknown_fields) == []


LEVELS = {
    "unknown_field": ("error", "damaged"),
    "number_compared_with_text": ("error", "damaged"),
    "like_on_a_number": ("error", "error"),
    "conditions_over_the_limit": ("error", "warning"),
    "values_over_the_limit": ("error", "warning"),
    "depth_over_the_limit": ("error", "warning"),
    "shapes_over_the_limit": ("error", "warning"),
    "area_points_over_the_limit": ("error", "warning"),
    "area_crosses_itself": ("error", "warning"),
    "array_operator": ("error", "error"),
    "legacy_is_not_bare": ("info", "info"),
}


@pytest.mark.parametrize("name", sorted(LEVELS))
def test_levels_of_a_new_and_a_stored_filter(name: str) -> None:
    case = next(c for c in CASES if c["name"] == name)
    new = validate(case["cql"], context(case["fields"]))
    stored = validate(case["cql"], context(case["fields"]), stored=True)
    assert [i.code for i in stored] == [i.code for i in new]
    assert {i.level for i in new} == {LEVELS[name][0]}
    assert {i.level for i in stored} == {LEVELS[name][1]}


def test_a_very_deep_tree_does_not_recurse() -> None:
    cql: Any = {"op": "=", "args": [{"property": "a"}, 1]}
    for _ in range(5_000):
        cql = {"op": "not", "args": [cql]}
    assert [i.code for i in validate(cql, context({"a": "integer"}))] == ["too_deep"]
    arithmetic: Any = {"property": "a"}
    for _ in range(5_000):
        arithmetic = {"op": "+", "args": [arithmetic, 1]}
    deep_operand = {"op": ">", "args": [arithmetic, 1]}
    # 5,000 levels are also more than a map request takes
    assert [i.code for i in validate(deep_operand, context({"a": "integer"}))] == [
        "too_deep",
        "too_long",
    ]


def test_the_input_is_not_mutated() -> None:
    for case in CASES:
        before = json.dumps(case["cql"])
        validate(case["cql"], context(case["fields"]))
        assert json.dumps(case["cql"]) == before


def test_fields_match_regardless_of_case_and_geometry_is_no_field() -> None:
    cql = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "NAME"}, "x"]},
            {"op": "=", "args": [{"property": "id"}, 3]},
            {
                "op": "s_intersects",
                "args": [
                    {"property": "geometry"},
                    {"type": "Point", "coordinates": [1, 2]},
                ],
            },
        ],
    }
    assert validate(cql, context({"name": "string"})) == []


def test_a_field_compared_with_a_field() -> None:
    cql = {"op": "<", "args": [{"property": "a"}, {"property": "b"}]}
    assert validate(cql, context({"a": "integer", "b": "number"})) == []
    assert [i.code for i in validate(cql, context({"a": "integer"}))] == [
        "unknown_field"
    ]


def fn(name: str, *args: Any) -> dict[str, Any]:
    return {"function": {"name": name, "arguments": list(args)}}


def test_any_like_pattern_is_a_filter() -> None:
    """The services read every pattern (ILIKE); only style rules, which the map
    client evaluates, are held to contains, starts with and ends with."""
    for pattern in ("Haupt%stra_e", "a_c", "%a%b%", "_", "100%"):
        cql = {"op": "like", "args": [{"property": "name"}, pattern]}
        assert validate(cql, context({"name": "string"})) == [], pattern


def test_every_function_the_services_allow() -> None:
    from goatlib.filter.cql import FUNCTIONS
    from goatlib.storage.cql_evaluator import _ALLOWED_CQL_FUNCTIONS

    assert set(FUNCTIONS) == set(_ALLOWED_CQL_FUNCTIONS)
    for name in FUNCTIONS:
        for spelling in (name, name.upper()):
            cql = {"op": "=", "args": [fn(spelling, {"property": "pop"}), 1]}
            assert validate(cql, context({"pop": "integer"})) == [], spelling


def test_functions_in_every_place_a_value_goes() -> None:
    name = {"property": "name"}
    ctx = context({"name": "string", "pop": "integer"})
    for cql in (
        {"op": "like", "args": [fn("lower", name), "%ber%"]},
        {"op": "in", "args": [fn("lower", name), ["a", fn("upper", "b")]]},
        {"op": "isNull", "args": [fn("trim", name)]},
        {"op": "between", "args": [fn("abs", {"property": "pop"}), 1, 4]},
        {"op": "between", "args": [{"property": "pop"}, fn("abs", -4), 6]},
        {"op": "=", "args": [fn("upper", fn("trim", name)), "HAM"]},
        {"op": "=", "args": [fn("coalesce", name, "x"), "x"]},
        {"op": "=", "args": [fn("substr", name, 1, 3), "Ber"]},
    ):
        assert validate(cql, ctx) == [], cql


def test_functions_the_services_cannot_run() -> None:
    name = {"property": "name"}
    for cql, code in (
        # A function is no condition on its own.
        (fn("lower", name), "malformed"),
        ({"op": "=", "args": [fn("lower"), "x"]}, "malformed"),
        ({"op": "=", "args": [fn("coalesce", None), "x"]}, "malformed"),
        ({"op": "=", "args": [fn("coalesce", [1, 2]), 1]}, "malformed"),
        (
            {
                "op": "=",
                "args": [{"function": {"name": "lower", "arguments": name}}, "x"],
            },
            "malformed",
        ),
        ({"op": "=", "args": [{"function": {"arguments": [name]}}, "x"]}, "malformed"),
        (
            {
                "op": "=",
                "args": [
                    {"function": {"name": "lower", "arguments": [name]}, "op": "x"},
                    "x",
                ],
            },
            "malformed",
        ),
        # pygeofilter's shorthand for lower(); not standard, not taken.
        ({"op": "=", "args": [{"lower": name}, "berlin"]}, "malformed"),
        ({"op": "=", "args": [fn("read_parquet", "x"), "x"]}, "operator_unsupported"),
        (
            {"op": "=", "args": [{"op": "lower", "args": [name]}, "x"]},
            "operator_unsupported",
        ),
    ):
        assert [i.code for i in validate(cql, context({"name": "string"}))] == [
            code
        ], cql


def test_function_arguments_nest_no_deeper_than_a_filter() -> None:
    arg: Any = {"property": "name"}
    for _ in range(5_000):
        arg = fn("lower", arg)
    cql = {"op": "=", "args": [arg, "x"]}
    assert [i.code for i in validate(cql, context({"name": "string"}))] == [
        "too_deep",
        "too_long",
    ]


def crossing_area(lines: int) -> dict[str, Any]:
    """A ring swept in rows and then in columns: every row crosses every column."""
    size = lines + 1
    ring: list[list[float]] = []
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[start, i], [end, i]]
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[i, start], [i, end]]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


def within(geometry: dict[str, Any]) -> dict[str, Any]:
    return {"op": "s_intersects", "args": [{"property": "geom"}, geometry]}


def test_an_area_that_crosses_itself_too_often_is_an_issue_at_the_area() -> None:
    cql = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "name"}, "x"]},
            {"op": "not", "args": [within(crossing_area(20))]},
        ],
    }

    issues = validate(cql)

    assert [(i.path, i.code, i.level) for i in issues] == [
        ("/args/1/args/0/args/1", "area_crosses_itself", "error")
    ]
    assert "crosses" in issues[0].message
    assert "—" not in issues[0].message and "–" not in issues[0].message


def test_an_area_that_crosses_itself_a_few_times_is_no_issue() -> None:
    assert validate({"op": "and", "args": [within(crossing_area(3))]}) == []


def test_an_area_over_the_point_limit_is_not_read_further(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.filter import area
    from goatlib.filter.limits import MAX_POINTS, MAX_SHAPES

    read = []
    monkeypatch.setattr(area, "crosses_itself", lambda g: read.append(g) or True)
    detailed = crossing_area(MAX_POINTS // 4 + 1)
    cql = {"op": "and", "args": [within(detailed)]}
    assert [i.code for i in validate(cql)] == ["area_too_detailed"]
    many = {"op": "or", "args": [within(crossing_area(20))] * (MAX_SHAPES + 1)}
    assert [i.code for i in validate(many)] == ["too_many_shapes"]
    assert read == []
