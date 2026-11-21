"""`normalize`: legacy and standard CQL2 spellings to the form the evaluator takes."""

import json
from typing import Any

import pytest
from goatlib.filter.normalize import normalize
from goatlib.storage.cql_evaluator import cql2_to_duckdb_sql
from pygeofilter.parsers.cql2_json import parse

P = {"property": "a"}
D = {"property": "d"}
G = {"property": "geom"}
SQUARE = {
    "type": "Polygon",
    "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
}

#: (name, input, normalized). Each row of the plan's table, then forms that stay.
CASES: list[tuple[str, Any, Any]] = [
    (
        "bang_equal_to_not_equal",
        {"op": "!=", "args": [P, 1]},
        {"op": "<>", "args": [P, 1]},
    ),
    (
        "is_null_object_arg_to_list",
        {"op": "isNull", "args": P},
        {"op": "isNull", "args": [P]},
    ),
    (
        "between_three_args_to_pair",
        {"op": "between", "args": [P, 1, 5]},
        {"op": "between", "args": [P, [1, 5]]},
    ),
    (
        "date_to_timestamp",
        {"op": ">", "args": [D, {"date": "2024-01-01"}]},
        {"op": ">", "args": [D, {"timestamp": "2024-01-01T00:00:00Z"}]},
    ),
    (
        "bbox_to_polygon",
        {"op": "s_intersects", "args": [G, {"bbox": [0, 0, 1, 1]}]},
        {"op": "s_intersects", "args": [G, SQUARE]},
    ),
    (
        "bbox_with_heights_to_polygon",
        {"op": "s_intersects", "args": [G, {"bbox": [0, 0, -5, 1, 1, 5]}]},
        {"op": "s_intersects", "args": [G, SQUARE]},
    ),
    (
        "casei_unwrapped",
        {
            "op": "=",
            "args": [
                {"op": "casei", "args": [P]},
                {"op": "casei", "args": ["Berlin"]},
            ],
        },
        {"op": "=", "args": [P, "Berlin"]},
    ),
    (
        "nested_in_logical",
        {
            "op": "and",
            "args": [
                {"op": "or", "args": [{"op": "!=", "args": [P, ""]}]},
                {"op": "not", "args": [{"op": "isNull", "args": P}]},
            ],
        },
        {
            "op": "and",
            "args": [
                {"op": "or", "args": [{"op": "<>", "args": [P, ""]}]},
                {"op": "not", "args": [{"op": "isNull", "args": [P]}]},
            ],
        },
    ),
    (
        "inside_a_filter_wrapper",
        {"filter": {"op": "!=", "args": [P, 1]}, "filter-lang": "cql2-json"},
        {"filter": {"op": "<>", "args": [P, 1]}, "filter-lang": "cql2-json"},
    ),
]

#: Forms the evaluator takes already: they come back equal.
UNCHANGED: list[tuple[str, Any]] = [
    ("not_equal", {"op": "<>", "args": [P, 1]}),
    ("is_null_list", {"op": "isNull", "args": [P]}),
    ("between_pair", {"op": "between", "args": [P, [1, 5]]}),
    ("timestamp", {"op": "<", "args": [D, {"timestamp": "2024-01-01T10:00:00Z"}]}),
    ("in_list", {"op": "in", "args": [P, [1, 2, 3]]}),
    ("like", {"op": "like", "args": [P, "%x%"]}),
    ("not_object_arg", {"op": "not", "args": {"op": "=", "args": [P, 1]}}),
    ("s_intersects_geometry", {"op": "s_intersects", "args": [G, SQUARE]}),
    (
        "geometry_with_bbox_member",
        {"op": "s_intersects", "args": [G, {**SQUARE, "bbox": [0, 0, 1, 1]}]},
    ),
    ("property_named_date", {"op": "=", "args": [{"property": "date"}, "x"]}),
    ("unknown_op", {"op": "a_contains", "args": [P, [1]]}),
    ("unknown_object", {"foo": {"bar": [1, 2]}}),
    ("text", "not a filter"),
    ("none", None),
]


@pytest.mark.parametrize("name,raw,expected", CASES, ids=[c[0] for c in CASES])
def test_normalize_rewrites(name: str, raw: Any, expected: Any) -> None:
    assert normalize(raw) == expected


@pytest.mark.parametrize("name,raw", UNCHANGED, ids=[c[0] for c in UNCHANGED])
def test_normalize_keeps(name: str, raw: Any) -> None:
    assert normalize(raw) == raw


@pytest.mark.parametrize(
    "raw", [c[1] for c in CASES] + [c[1] for c in UNCHANGED], ids=lambda _: ""
)
def test_normalize_is_idempotent(raw: Any) -> None:
    once = normalize(raw)
    assert normalize(once) == once


def test_date_with_a_time_is_kept_as_it_is() -> None:
    raw = {"op": ">", "args": [D, {"date": "2024-01-01T12:00:00Z"}]}
    assert normalize(raw)["args"][1] == {"timestamp": "2024-01-01T12:00:00Z"}


def test_the_input_is_not_mutated() -> None:
    raw = {
        "op": "and",
        "args": [c[1] for c in CASES] + [{"op": "or", "args": [c[1] for c in CASES]}],
    }
    before = json.dumps(raw)
    out = normalize(raw)
    assert json.dumps(raw) == before
    assert out is not raw


def test_a_very_deep_tree_does_not_recurse() -> None:
    # Built and checked without json, which recurses itself.
    raw: Any = {"op": "!=", "args": [P, 1]}
    for _ in range(5_000):
        raw = {"op": "not", "args": [raw]}
    out = normalize(raw)
    levels = 0
    while out.get("op") == "not":
        out = out["args"][0]
        levels += 1
    assert levels == 5_000
    assert out == {"op": "<>", "args": [P, 1]}


@pytest.mark.parametrize("name,raw,expected", CASES, ids=[c[0] for c in CASES])
def test_the_evaluator_takes_the_normalized_form(
    name: str, raw: Any, expected: Any
) -> None:
    sql, _ = cql2_to_duckdb_sql(
        parse(json.dumps(normalize(raw))), ["a", "d", "geom"], "geom"
    )
    assert sql


@pytest.mark.parametrize(
    "raw",
    [
        {"op": "between", "args": [P, 1, 5]},
        {"op": ">", "args": [D, {"date": "2024-01-01"}]},
        {"op": "s_intersects", "args": [G, {"bbox": [0, 0, 1, 1]}]},
    ],
    ids=["between", "date", "bbox"],
)
def test_forms_that_fail_today_fail_without_normalize(raw: Any) -> None:
    with pytest.raises(Exception):
        cql2_to_duckdb_sql(parse(json.dumps(raw)), ["a", "d", "geom"], "geom")


@pytest.mark.parametrize(
    "raw",
    [
        {"op": "between", "args": [P, 1, 5]},
        {"op": ">", "args": [D, {"date": "2024-01-01"}]},
        {"op": "s_intersects", "args": [G, {"bbox": [0, 0, 1, 1]}]},
    ],
    ids=["between", "date", "bbox"],
)
def test_the_parse_sites_normalize(raw: Any) -> None:
    from goatlib.storage import build_cql_filter, cql_to_where_clause

    assert cql_to_where_clause(raw, ["a", "d", "geom"], "geom", inline=True)
    built = build_cql_filter(
        {"filter": json.dumps(raw), "lang": "cql2-json"}, ["a", "d"], "geom"
    )
    assert built.clauses
