"""Every shape the workflow filter conversion writes passes the filter checker.

`convert_filter_to_cql` turns a workflow's filter rows into CQL2-JSON, which
reaches the evaluator through `cql_to_where_clause`; the checker reads the same
spellings, so none of them may be an error.
"""

from typing import Any

import pytest
from goatlib.filter.validate import validate
from goatlib.style.context import DataContext, FieldInfo
from goatlib.tools.workflow_runner import convert_filter_to_cql

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
}
FIELDS = {
    "name": "string",
    "pop": "integer",
    "area": "number",
    "open": "boolean",
    "built": "date",
    "seen": "datetime",
}

#: (expression, attribute, value): one per branch of the conversion.
ROWS: list[tuple[str, str, Any]] = [
    ("is_blank", "name", None),
    ("is_not_blank", "name", None),
    ("starts_with", "name", "Ham"),
    ("ends_with", "name", "burg"),
    ("contains_the_text", "name", "berg"),
    ("does_not_contains_the_text", "name", "berg"),
    ("is_between", "pop", "10-20"),
    ("is_between", "pop", [-5, 20]),
    ("is_between", "built", ["2024-05-01", "2024-05-31"]),
    ("is_between", "seen", ["2024-05-01", "2024-05-01T12:00:00Z"]),
    ("is_not_between", "area", [1.5, 2.5]),
    ("is_not_between", "built", ["2024-05-01", "2024-05-31"]),
    ("is_true", "open", ""),
    ("is_false", "open", ""),
    ("is_on", "built", "2024-05-01"),
    ("is_on", "seen", "2024-05-01"),
    ("is_not_on", "built", "2024-05-01"),
    ("is_not_on", "seen", "2024-05-01"),
    ("is_before", "built", "2024-05-01"),
    ("is_after", "seen", "2024-05-01T10:30:00Z"),
    ("in_the_last", "built", 7),
    ("in_the_last", "seen", "7"),
    ("not_in_the_last", "seen", 7),
    ("is_blank", "pop", None),
    ("is_not_blank", "seen", None),
    ("s_intersects", "geom", SQUARE),
    ("s_intersects", "geom", '{"type": "Point", "coordinates": [0.5, 0.5]}'),
    ("includes", "name", ["a", "b"]),
    ("includes", "pop", 3),
    ("excludes", "name", ["a", "b"]),
    ("is_empty_string", "name", None),
    ("is_not_empty_string", "name", None),
    ("is", "name", "Berlin"),
    ("is_not", "name", "Berlin"),
    ("is_at_least", "pop", 10),
    ("is_at_most", "area", 2.5),
    ("is_less_than", "pop", 3),
    ("is_greater_than", "area", 1),
]


def context() -> DataContext:
    return DataContext(
        kind="vector",
        geometry="polygon",
        fields={n: FieldInfo(name=n, type=t) for n, t in FIELDS.items()},
    )


def errors(cql: Any) -> list[tuple[str, str]]:
    found = validate(cql) + validate(cql, context())
    return [(i.code, i.message) for i in found if i.level == "error"]


#: A run knows the layer's field types where a row is written by them; the
#: workflow check does not.
TYPES = [FIELDS, None]


@pytest.mark.parametrize("field_types", TYPES, ids=["typed", "untyped"])
@pytest.mark.parametrize(
    "expression, attribute, value",
    ROWS,
    ids=[f"{r[0]}-{i}" for i, r in enumerate(ROWS)],
)
def test_one_row(
    expression: str, attribute: str, value: Any, field_types: dict | None
) -> None:
    cql = convert_filter_to_cql(
        {
            "op": "and",
            "expressions": [
                {"attribute": attribute, "expression": expression, "value": value}
            ],
        },
        field_types,
    )
    assert cql is not None
    assert errors(cql) == []
    # A negation keeps the rows without a value, so the checker has nothing to note.
    assert [i.code for i in validate(cql)] == []


#: The rows in filters within the conditions a filter takes (a row may count
#: as two: text that is not empty is not empty and not the empty text).
CHUNKS = [ROWS[i : i + 15] for i in range(0, len(ROWS), 15)]


@pytest.mark.parametrize("chunk", range(len(CHUNKS)))
@pytest.mark.parametrize("field_types", TYPES, ids=["typed", "untyped"])
@pytest.mark.parametrize("op", ["and", "or"])
def test_all_rows_together(op: str, field_types: dict | None, chunk: int) -> None:
    cql = convert_filter_to_cql(
        {
            "op": op,
            "expressions": [
                {"attribute": a, "expression": e, "value": v}
                for e, a, v in CHUNKS[chunk]
            ],
        },
        field_types,
    )
    assert cql is not None and cql["op"] == op
    assert errors(cql) == []
