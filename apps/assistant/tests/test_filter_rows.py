"""A layer's stored filter as numbered rows for the model, and the model's row
operations applied to it (`assistant.maps.filter_rows`).

The stored form is the web filter panel's (`goatlib.filter.rows`); the land use
layer of the map evals holds an active drawn area, an ordinary row, a
switched-off row and a custom row.
"""

import copy
import json
import subprocess
import sys
from typing import Any

import pytest
from goatlib.filter.limits import MAX_CONDITIONS, TABLE
from pydantic import TypeAdapter, ValidationError

from assistant.maps.filter_rows import (
    MAX_ROWS,
    AddRows,
    ClearRows,
    FilterBrief,
    FilterRowView,
    RemoveRow,
    ReplaceRow,
    RowOp,
    SetMatch,
    _row_text,
    apply_row_ops,
    brief,
)
from assistant.tools.filters import Condition
from assistant.tools.runtime import InputInvalid
from evals.map_fixture import LAND_USE_QUERY

FIELDS = {"use": "string", "area_m2": "number"}
AREA = LAND_USE_QUERY["cql"]["args"][0]
BIG = LAND_USE_QUERY["cql"]["args"][1]
CUSTOM = LAND_USE_QUERY["cql"]["args"][2]
OFF = LAND_USE_QUERY["ui"]["off"][0]["cql"]
NOTES = LAND_USE_QUERY["ui"]["area"]
USE = {"property": "use"}

ROW_OPS: TypeAdapter[list[RowOp]] = TypeAdapter(list[RowOp])


def ops(*items: dict[str, Any]) -> list[RowOp]:
    return ROW_OPS.validate_python(list(items))


def condition(field: str, op: str, value: Any = None) -> dict[str, Any]:
    return {"field": field, "op": op, "value": value}


def land_use() -> dict[str, Any]:
    """A copy whose parts are the fixture's own objects, for identity checks."""
    return {
        "cql": {"op": "and", "args": [AREA, BIG, CUSTOM]},
        "ui": {"v": 1, "off": [{"at": 1, "cql": OFF}], "area": NOTES},
    }


# ---- the brief ------------------------------------------------------------------


def test_the_brief_says_custom_for_a_row_it_cannot_read_and_off_for_a_switched_off_one() -> (
    None
):
    assert brief(LAND_USE_QUERY, FIELDS) == FilterBrief(
        match="all",
        rows=[
            FilterRowView(row=1, text="area_m2 is greater than 5000"),
            FilterRowView(row=2, text='use is "industrial"', on=False),
            FilterRowView(row=3, text="custom"),
        ],
        area='a drawn shape "Study area"',
    )


@pytest.mark.parametrize("query", [None, {}, {"cql": {}}, {"metadata": {"a": 1}}])
def test_no_filter_has_no_brief(query: Any) -> None:
    assert brief(query, FIELDS) is None


def test_an_area_alone_has_a_brief_without_rows() -> None:
    query = {"cql": {"op": "and", "args": [AREA]}, "ui": {"v": 1, "area": NOTES}}
    assert brief(query, FIELDS) == FilterBrief(
        match="all", rows=[], area='a drawn shape "Study area"'
    )


def test_a_switched_off_area_is_an_area() -> None:
    query = {"ui": {"v": 1, "area": {**NOTES, "off": AREA}}}
    assert brief(query, FIELDS) == FilterBrief(
        match="all", rows=[], area='switched off: a drawn shape "Study area"'
    )


def test_the_brief_never_shows_cql_or_coordinates() -> None:
    text = json.dumps(brief(LAND_USE_QUERY, FIELDS).model_dump())  # type: ignore[union-attr]
    for leaked in ("12.28", "51.27", "s_intersects", "property", "args"):
        assert leaked not in text


#: Each panel operator with a row it reads and the words the brief gives it.
TEXTS: list[tuple[dict[str, Any], str]] = [
    ({"field": "use", "op": "is", "value": "park"}, 'use is "park"'),
    ({"field": "use", "op": "is_not", "value": "park"}, 'use is not "park"'),
    (
        {"field": "use", "op": "includes", "value": ["park", "forest"]},
        'use is one of "park", "forest"',
    ),
    (
        {"field": "use", "op": "excludes", "value": ["park"]},
        'use is not one of "park"',
    ),
    (
        {"field": "use", "op": "contains_the_text", "value": "par"},
        'use contains "par"',
    ),
    (
        {"field": "use", "op": "does_not_contains_the_text", "value": "par"},
        'use does not contain "par"',
    ),
    ({"field": "use", "op": "starts_with", "value": "pa"}, 'use starts with "pa"'),
    ({"field": "use", "op": "ends_with", "value": "rk"}, 'use ends with "rk"'),
    ({"field": "use", "op": "is_blank"}, "use is empty"),
    ({"field": "use", "op": "is_not_blank"}, "use is not empty"),
    ({"field": "n", "op": "is_less_than", "value": 3}, "n is less than 3"),
    ({"field": "n", "op": "is_greater_than", "value": 3}, "n is greater than 3"),
    ({"field": "n", "op": "is_at_most", "value": 2.5}, "n is at most 2.5"),
    ({"field": "n", "op": "is_at_least", "value": 3}, "n is at least 3"),
    (
        {"field": "n", "op": "is_between", "value": 1, "value2": 9},
        "n is between 1 and 9",
    ),
    (
        {"field": "n", "op": "is_not_between", "value": 1, "value2": 9},
        "n is not between 1 and 9",
    ),
    ({"field": "open", "op": "is_true"}, "open is true"),
    ({"field": "open", "op": "is_false"}, "open is false"),
    (
        {"field": "built", "op": "is_on", "value": "2024-05-01", "type": "date"},
        "built is on 2024-05-01",
    ),
    (
        {"field": "built", "op": "is_not_on", "value": "2024-05-01"},
        "built is not on 2024-05-01",
    ),
    (
        {"field": "built", "op": "is_before", "value": "2024-05-01"},
        "built is before 2024-05-01",
    ),
    (
        {"field": "built", "op": "is_after", "value": "2024-05-01T10:00:00Z"},
        "built is after 2024-05-01T10:00:00Z",
    ),
    (
        {
            "field": "built",
            "op": "is_between",
            "value": "2024-01-01",
            "value2": "2024-12-31",
            "type": "date",
        },
        "built is between 2024-01-01 and 2024-12-31",
    ),
    (
        {"field": "built", "op": "in_the_last", "value": 7},
        "built is in the last 7 days",
    ),
    (
        {"field": "built", "op": "in_the_last", "value": 1},
        "built is in the last 1 day",
    ),
    (
        {"field": "built", "op": "not_in_the_last", "value": 30},
        "built is not in the last 30 days",
    ),
]


@pytest.mark.parametrize(("panel", "text"), TEXTS)
def test_each_panel_operator_reads_in_words(panel: dict[str, Any], text: str) -> None:
    assert _row_text(panel, None, {"built": "date-time"}) == text


def test_every_panel_operator_has_words() -> None:
    worded = {panel["op"] for panel, _ in TEXTS}
    every = {op for ops in TABLE["operators"].values() for op in ops}
    assert every <= worded


def test_an_operator_without_words_reads_as_its_name() -> None:
    assert _row_text({"field": "a", "op": "is_near", "value": 3}, None, {}) == (
        "a is near 3"
    )


def test_a_long_list_names_five_values_and_counts_the_rest() -> None:
    values = ["a", "b", "c", "d", "e", "f", "g", "h"]
    text = _row_text({"field": "use", "op": "includes", "value": values}, None, {})
    assert text == 'use is one of "a", "b", "c", "d", "e" and 3 more'


def test_a_text_is_at_most_120_characters() -> None:
    text = _row_text({"field": "use", "op": "is", "value": "x" * 300}, None, {})
    assert len(text) == 120
    assert text.startswith('use is "xxx') and text.endswith("…")


def test_a_relative_date_note_reads_as_in_the_last_days() -> None:
    stamp = {"timestamp": "2024-05-01T00:00:00Z"}
    query = {
        "cql": {
            "op": "and",
            "args": [{"op": ">=", "args": [{"property": "t"}, stamp]}],
        },
        "ui": {"v": 1, "relative": [{"at": 0, "days": 14}]},
    }
    view = brief(query, {"t": "date-time"})
    assert view is not None
    assert view.rows[0].text == "t is in the last 14 days"


@pytest.mark.parametrize(
    ("value", "text"),
    [
        ({"date": "2024-05-01"}, "built is on 2024-05-01"),
        ({"timestamp": "2024-05-01T10:30:00Z"}, "built is 2024-05-01T10:30:00Z"),
    ],
)
def test_a_date_time_field_reads_with_the_type_its_value_shows(
    value: dict[str, str], text: str
) -> None:
    query = {
        "cql": {
            "op": "and",
            "args": [{"op": "=", "args": [{"property": "built"}, value]}],
        }
    }
    view = brief(query, {"built": "date-time"})
    assert view is not None
    assert view.rows[0].text == text


# ---- the row operations ------------------------------------------------------------


def test_an_added_row_keeps_area_off_rows_and_custom_rows() -> None:
    query = land_use()
    out = apply_row_ops(
        query,
        ops({"do": "add", "conditions": [condition("use", "=", "forest")]}),
        FIELDS,
    )
    assert out == {
        "cql": {
            "op": "and",
            "args": [AREA, BIG, CUSTOM, {"op": "=", "args": [USE, "forest"]}],
        },
        "ui": {"v": 1, "off": [{"at": 1, "cql": OFF}], "area": NOTES},
    }
    assert out["cql"]["args"][0] is AREA
    assert out["cql"]["args"][2] is CUSTOM
    assert out["ui"]["off"][0]["cql"] is OFF
    assert out["ui"]["area"] is NOTES
    assert query == land_use()


def test_removing_a_row_before_a_switched_off_row_moves_its_note() -> None:
    out = apply_row_ops(land_use(), ops({"do": "remove", "row": 1}), FIELDS)
    assert out == {
        "cql": {"op": "and", "args": [AREA, CUSTOM]},
        "ui": {"v": 1, "off": [{"at": 0, "cql": OFF}], "area": NOTES},
    }


def test_replace_writes_the_panels_form_for_a_negation() -> None:
    out = apply_row_ops(
        land_use(),
        ops({"do": "replace", "row": 1, "condition": condition("use", "!=", "forest")}),
        FIELDS,
    )
    assert out is not None
    assert out["cql"]["args"][1] == {
        "op": "or",
        "args": [
            {"op": "<>", "args": [USE, "forest"]},
            {"op": "isNull", "args": [USE]},
        ],
    }
    view = brief(out, FIELDS)
    assert view is not None
    assert view.rows[0] == FilterRowView(row=1, text='use is not "forest"')


def test_clear_removes_the_rows_and_keeps_the_area() -> None:
    out = apply_row_ops(land_use(), ops({"do": "clear"}), FIELDS)
    assert out == {
        "cql": {"op": "and", "args": [AREA]},
        "ui": {"v": 1, "area": NOTES},
    }


def test_set_match_any_with_an_area_writes_one_or_group() -> None:
    out = apply_row_ops(land_use(), ops({"do": "set_match", "match": "any"}), FIELDS)
    assert out == {
        "cql": {"op": "and", "args": [AREA, {"op": "or", "args": [BIG, CUSTOM]}]},
        "ui": {"v": 1, "off": [{"at": 1, "cql": OFF}], "area": NOTES, "any": True},
    }
    view = brief(out, FIELDS)
    assert view is not None and view.match == "any" and len(view.rows) == 3


@pytest.mark.parametrize("row", [4, 9])
def test_a_row_number_that_does_not_exist_is_input_invalid(row: int) -> None:
    with pytest.raises(InputInvalid) as caught:
        apply_row_ops(
            land_use(),
            ops({"do": "set_match", "match": "any"}, {"do": "remove", "row": row}),
            FIELDS,
        )
    assert caught.value.message == (
        f"Row operation 2: the filter has no row {row}; its rows are 1 to 3."
    )


def test_a_row_of_a_filter_without_rows_is_input_invalid() -> None:
    with pytest.raises(InputInvalid, match="Row operation 1: the filter has no rows."):
        apply_row_ops(None, ops({"do": "remove", "row": 1}), FIELDS)


def test_a_row_number_below_one_is_refused_by_the_model() -> None:
    with pytest.raises(ValidationError):
        ops({"do": "remove", "row": 0})


def test_the_twenty_first_row_is_refused() -> None:
    assert MAX_ROWS == MAX_CONDITIONS == 20
    ten = [condition("area_m2", ">", n) for n in range(10)]
    seventeen = ops(
        {"do": "add", "conditions": ten}, {"do": "add", "conditions": ten[:7]}
    )
    out = apply_row_ops(land_use(), seventeen, FIELDS)
    assert out is not None and len(out["cql"]["args"]) == 1 + 2 + 17
    with pytest.raises(InputInvalid) as caught:
        apply_row_ops(
            land_use(),
            ops({"do": "add", "conditions": ten}, {"do": "add", "conditions": ten[:8]}),
            FIELDS,
        )
    assert caught.value.message == (
        "A filter holds at most 20 rows, switched-off ones included; these "
        "operations would leave 21. Remove rows or combine conditions."
    )


def test_removing_rows_from_a_filter_over_the_limit_is_allowed() -> None:
    many = [{"op": ">", "args": [{"property": "area_m2"}, n]} for n in range(22)]
    out = apply_row_ops(
        {"cql": {"op": "and", "args": many}}, ops({"do": "remove", "row": 1}), FIELDS
    )
    assert out == {"cql": {"op": "and", "args": many[1:]}}


def test_row_numbers_are_those_before_the_call() -> None:
    out = apply_row_ops(
        land_use(),
        ops(
            {"do": "remove", "row": 1},
            {"do": "replace", "row": 3, "condition": condition("use", "=", "park")},
        ),
        FIELDS,
    )
    assert out == {
        "cql": {"op": "and", "args": [AREA, {"op": "=", "args": [USE, "park"]}]},
        "ui": {"v": 1, "off": [{"at": 0, "cql": OFF}], "area": NOTES},
    }


@pytest.mark.parametrize(
    "second",
    [
        {"do": "remove", "row": 1},
        {"do": "replace", "row": 1, "condition": condition("use", "=", "park")},
    ],
)
def test_two_operations_on_one_row_are_input_invalid(second: dict[str, Any]) -> None:
    with pytest.raises(InputInvalid) as caught:
        apply_row_ops(land_use(), ops({"do": "remove", "row": 1}, second), FIELDS)
    assert caught.value.message == (
        "Row operation 2: row 1 is already changed by row operation 1; "
        "change each row once per call."
    )


@pytest.mark.parametrize(
    "other",
    [
        {"do": "remove", "row": 2},
        {"do": "replace", "row": 2, "condition": condition("use", "=", "park")},
    ],
)
def test_clear_with_remove_or_replace_is_input_invalid(other: dict[str, Any]) -> None:
    with pytest.raises(InputInvalid) as caught:
        apply_row_ops(land_use(), ops(other, {"do": "clear"}), FIELDS)
    assert caught.value.message == (
        "Row operation 1: clear (row operation 2) removes every row; "
        "do not remove or replace rows in the same call."
    )


def test_clear_then_add_replaces_every_row() -> None:
    out = apply_row_ops(
        land_use(),
        ops(
            {"do": "clear"},
            {"do": "add", "conditions": [condition("use", "=", "park")]},
        ),
        FIELDS,
    )
    assert out == {
        "cql": {"op": "and", "args": [AREA, {"op": "=", "args": [USE, "park"]}]},
        "ui": {"v": 1, "area": NOTES},
    }


def test_clear_after_add_removes_the_added_rows_too() -> None:
    out = apply_row_ops(
        land_use(),
        ops(
            {"do": "add", "conditions": [condition("use", "=", "park")]},
            {"do": "clear"},
        ),
        FIELDS,
    )
    assert out == {"cql": {"op": "and", "args": [AREA]}, "ui": {"v": 1, "area": NOTES}}


def test_the_last_set_match_wins() -> None:
    out = apply_row_ops(
        land_use(),
        ops({"do": "set_match", "match": "any"}, {"do": "set_match", "match": "all"}),
        FIELDS,
    )
    assert out == land_use()


def test_added_rows_go_to_the_end_in_the_order_given() -> None:
    out = apply_row_ops(
        {"cql": {"op": "and", "args": [BIG]}},
        ops(
            {
                "do": "add",
                "conditions": [condition("use", "=", "a"), condition("use", "=", "b")],
            },
            {"do": "add", "conditions": [condition("use", "=", "c")]},
        ),
        FIELDS,
    )
    assert out is not None
    assert [arg["args"][1] for arg in out["cql"]["args"][1:]] == ["a", "b", "c"]


def test_a_replaced_switched_off_row_stays_switched_off() -> None:
    out = apply_row_ops(
        land_use(),
        ops({"do": "replace", "row": 2, "condition": condition("use", "=", "water")}),
        FIELDS,
    )
    assert out is not None
    assert out["ui"]["off"] == [{"at": 1, "cql": {"op": "=", "args": [USE, "water"]}}]
    assert out["cql"] == LAND_USE_QUERY["cql"]


def test_a_replaced_row_loses_its_relative_date_note() -> None:
    stamp = {"timestamp": "2024-05-01T00:00:00Z"}
    query = {
        "cql": {
            "op": "and",
            "args": [BIG, {"op": ">=", "args": [{"property": "t"}, stamp]}],
        },
        "ui": {"v": 1, "relative": [{"at": 1, "days": 14}]},
    }
    fields = {**FIELDS, "t": "date-time"}
    kept = apply_row_ops(query, ops({"do": "remove", "row": 1}), fields)
    assert kept is not None and kept["ui"] == {
        "v": 1,
        "relative": [{"at": 0, "days": 14}],
    }
    out = apply_row_ops(
        query,
        ops(
            {"do": "replace", "row": 2, "condition": condition("t", ">=", "2025-01-01")}
        ),
        fields,
    )
    assert out is not None and "ui" not in out


def test_a_field_the_layer_lacks_names_the_operation() -> None:
    with pytest.raises(InputInvalid) as caught:
        apply_row_ops(
            land_use(),
            ops(
                {"do": "set_match", "match": "any"},
                {"do": "add", "conditions": [condition("usee", "=", "park")]},
            ),
            FIELDS,
        )
    assert caught.value.message == (
        "Row operation 2: Field 'usee' doesn't exist on this layer. Did you mean 'use'?"
    )


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        (condition("area_m2", "=", "big"), "Field 'area_m2' is numeric"),
        (condition("use", "<", "a"), "Operator '<' does not apply to 'use'"),
        (condition("use", "is_null", "a"), "is_null takes no value"),
    ],
)
def test_values_to_cql2_refuses_are_refused(bad: dict[str, Any], message: str) -> None:
    with pytest.raises(InputInvalid, match=f"^Row operation 1: {message}"):
        apply_row_ops(
            land_use(),
            ops({"do": "replace", "row": 1, "condition": bad}),
            FIELDS,
        )


def test_removing_the_last_row_leaves_nothing() -> None:
    assert (
        apply_row_ops(
            {"cql": {"op": "and", "args": [BIG]}},
            ops({"do": "remove", "row": 1}),
            FIELDS,
        )
        is None
    )


def test_removing_the_last_active_row_beside_a_switched_off_one_keeps_the_note() -> (
    None
):
    query = {
        "cql": {"op": "and", "args": [BIG]},
        "ui": {"v": 1, "off": [{"at": 1, "cql": OFF}]},
    }
    out = apply_row_ops(query, ops({"do": "remove", "row": 1}), FIELDS)
    assert out == {"ui": {"v": 1, "off": [{"at": 0, "cql": OFF}]}}


def test_metadata_is_sent_back_as_stored() -> None:
    """The panel's save sends a stored `metadata` back unchanged (`apply` in
    `hooks/map/useLayerFilter.ts`); nothing derives it from the rows."""
    metadata = {"intersection": {"label": "Old area", "geom_type": "draw"}}
    query = {"metadata": metadata, **land_use()}
    out = apply_row_ops(query, ops({"do": "remove", "row": 1}), FIELDS)
    assert out is not None and out["metadata"] is metadata
    cleared = apply_row_ops(
        {"metadata": metadata, "cql": {"op": "and", "args": [BIG]}},
        ops({"do": "remove", "row": 1}),
        FIELDS,
    )
    assert cleared == {"metadata": metadata}


#: A field of each kind and a value for every operator a condition takes.
KINDS = {
    "name": "string",
    "pop": "integer",
    "share": "number",
    "open": "boolean",
    "built": "date-time",
}
READABLE: list[tuple[dict[str, Any], str]] = [
    (condition("name", "=", "Berlin"), 'name is "Berlin"'),
    (condition("name", "!=", "Berlin"), 'name is not "Berlin"'),
    (condition("name", "in", ["Berlin", "Bonn"]), 'name is one of "Berlin", "Bonn"'),
    (condition("name", "contains", "erl"), 'name contains "erl"'),
    (condition("name", "like", "Ber%"), 'name starts with "Ber"'),
    (condition("name", "is_null"), "name is empty"),
    (condition("name", "is_not_null"), "name is not empty"),
    (condition("pop", "<", 3), "pop is less than 3"),
    (condition("pop", "<=", 3), "pop is at most 3"),
    (condition("pop", ">", 3), "pop is greater than 3"),
    (condition("pop", ">=", 3), "pop is at least 3"),
    (condition("share", "!=", 0.5), "share is not 0.5"),
    (condition("pop", "is_null"), "pop is empty"),
    (condition("pop", "is_not_null"), "pop is not empty"),
    (condition("open", "=", True), "open is true"),
    (condition("open", "=", False), "open is false"),
    (
        condition("built", "<", "2024-05-01T00:00:00Z"),
        "built is before 2024-05-01T00:00:00+00:00",
    ),
]


@pytest.mark.parametrize(("given", "text"), READABLE)
def test_a_written_row_reads_back_in_words(given: dict[str, Any], text: str) -> None:
    out = apply_row_ops(None, ops({"do": "add", "conditions": [given]}), KINDS)
    view = brief(out, KINDS)
    assert view is not None
    assert view.rows == [FilterRowView(row=1, text=text)]


def test_the_row_operations_are_one_union_on_do() -> None:
    parsed = ops(
        {"do": "add", "conditions": [condition("use", "=", "a")]},
        {"do": "replace", "row": 1, "condition": condition("use", "=", "a")},
        {"do": "remove", "row": 1},
        {"do": "set_match", "match": "any"},
        {"do": "clear"},
    )
    assert [type(op) for op in parsed] == [
        AddRows,
        ReplaceRow,
        RemoveRow,
        SetMatch,
        ClearRows,
    ]
    assert isinstance(parsed[0].conditions[0], Condition)  # type: ignore[union-attr]
    with pytest.raises(ValidationError):
        ops({"do": "add", "conditions": []})
    with pytest.raises(ValidationError):
        ops({"do": "add", "conditions": [condition("use", "=", "a")] * 11})
    with pytest.raises(ValidationError):
        ops({"do": "switch_off", "row": 1})


def _described(schema: dict[str, Any], defs: dict[str, Any], seen: set[str]) -> None:
    for name, prop in schema.get("properties", {}).items():
        assert prop.get(
            "description"
        ), f"{schema.get('title')}.{name} has no description"
    for sub in schema.get("oneOf", []) + schema.get("anyOf", []):
        ref = sub.get("$ref", "").rsplit("/", 1)[-1]
        if ref and ref not in seen:
            seen.add(ref)
            _described(defs[ref], defs, seen)


def test_every_field_of_the_models_has_a_description() -> None:
    for model in (FilterBrief, FilterRowView):
        _described(model.model_json_schema(), {}, set())
    schema = ROW_OPS.json_schema()
    defs = schema.get("$defs", {})
    _described(schema["items"], defs, set())
    for name in ("AddRows", "ReplaceRow", "RemoveRow", "SetMatch", "ClearRows"):
        _described(defs[name], defs, set())


def test_the_fixture_is_not_changed() -> None:
    before = copy.deepcopy(LAND_USE_QUERY)
    apply_row_ops(LAND_USE_QUERY, ops({"do": "clear"}), FIELDS)
    brief(LAND_USE_QUERY, FIELDS)
    assert LAND_USE_QUERY == before


def test_filter_rows_imports_no_data_library() -> None:
    script = """
import importlib.abc
import sys

class Refuse(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in ("numpy", "shapely", "duckdb"):
            raise ImportError(f"refused: {name}")
        return None

sys.meta_path.insert(0, Refuse())
import assistant.maps.filter_rows
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
