from goatlib.style import cql
from goatlib.style.models.rules import Rule

from .conftest import codes

NAME_IS_NULL = {"op": "isNull", "args": [{"property": "name"}]}


def test_rule_zooms_are_whole_numbers() -> None:
    assert codes(Rule, {"when": NAME_IS_NULL, "visible": False, "min_zoom": 12.5}) == [
        "zoom_not_whole"
    ]


def test_like_takes_contains_starts_and_ends_only() -> None:
    ok = {"op": "like", "args": [{"property": "name"}, "%Gymnasium%"]}
    assert codes(Rule, {"when": ok, "visible": False}) == []
    for pattern in ("G_mnasium%", "Primary%school%"):
        bad = {"op": "like", "args": [{"property": "name"}, pattern]}
        assert codes(Rule, {"when": bad, "visible": False}) == [
            "like_pattern_unsupported"
        ]


def test_operators_and_shapes() -> None:
    nested = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "status"}, "planned"]},
            {"op": "<", "args": [{"property": "pupils"}, 300]},
            {
                "op": "not",
                "args": [
                    {"op": "in", "args": [{"property": "type"}, ["primary", "special"]]}
                ],
            },
        ],
    }
    assert codes(Rule, {"when": nested, "marker": {"color": "#d95f02"}}) == []
    assert codes(Rule, {"when": {"op": "~=", "args": [{"property": "a"}, 1]}}) == [
        "invalid_value"
    ]
    assert codes(Rule, {"when": {"op": "in", "args": [{"property": "a"}, "x"]}}) == [
        "invalid_value"
    ]


def test_cql_fields_and_odd_names() -> None:
    cond = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "Einwohner 2020"}, 5]},
            {"op": "in", "args": [{"property": "Straße"}, ["a"]]},
        ],
    }
    assert cql.fields_of(cond) == {"Einwohner 2020", "Straße"}
    assert cql.depth(cond) == 2


def test_deep_nesting_is_refused_without_recursion_error() -> None:
    cond = NAME_IS_NULL
    for _ in range(300):
        cond = {"op": "not", "args": [cond]}
    assert codes(Rule, {"when": cond, "visible": False}) == ["invalid_value"]
    assert cql.depth(cond) == 301
