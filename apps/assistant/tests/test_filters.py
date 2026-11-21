"""The filters the assistant writes pass goatlib's filter checker.

The assistant builds CQL2-JSON from structured conditions (`to_cql2`); the web
panel and the services read the same filter, so every condition it can write
must be free of errors under `goatlib.filter.validate.validate`.
"""

from typing import Any, get_args

import pytest
from goatlib.filter.limits import TABLE
from goatlib.filter.validate import validate
from goatlib.style.context import DataContext, FieldInfo

from assistant.tools.filters import (
    OPERATORS,
    FeatureFilter,
    Op,
    to_cql2,
)
from assistant.tools.runtime import InputInvalid

#: The assistant's field kinds as goatlib's field types.
TYPES = {
    "string": "string",
    "number": "number",
    "integer": "integer",
    "boolean": "boolean",
    "date-time": "datetime",
}
#: A value of each kind; a list for "in", none for the null checks.
SAMPLE = {
    "string": "Berlin",
    "number": 2.5,
    "integer": 3,
    "boolean": True,
    "date-time": "2024-05-01T00:00:00Z",
}
LIKE = {"like": "Haupt%stra_e", "contains": "berg"}


def context() -> DataContext:
    return DataContext(
        kind="vector",
        geometry="point",
        fields={
            kind: FieldInfo(name=kind, type=t)  # type: ignore[arg-type]
            for kind, t in TYPES.items()
        },
    )


def condition(kind: str, op: str) -> dict[str, Any]:
    if op in ("is_null", "is_not_null"):
        return {"field": kind, "op": op}
    value: Any = LIKE.get(op, SAMPLE[kind])
    if op == "in":
        value = [value]
    return {"field": kind, "op": op, "value": value}


def write(*conditions: dict[str, Any], match: str = "all") -> dict[str, Any]:
    return to_cql2(
        FeatureFilter.model_validate({"match": match, "conditions": list(conditions)}),
        # Each field is named after its kind.
        {kind: kind for kind in TYPES},
    )


WRITABLE = [
    (kind, op) for kind in TYPES for op in get_args(Op) if op in OPERATORS[kind]
]


@pytest.mark.parametrize("kind, op", WRITABLE, ids=[f"{k}-{o}" for k, o in WRITABLE])
def test_every_condition_it_writes_is_free_of_errors(kind: str, op: str) -> None:
    cql = write(condition(kind, op))
    assert [i.code for i in validate(cql, context())] == []


def test_all_conditions_together_are_free_of_errors() -> None:
    for match in ("all", "any"):
        for start in range(0, len(WRITABLE), 10):
            chunk = WRITABLE[start : start + 10]
            cql = write(*(condition(k, o) for k, o in chunk), match=match)
            assert [i.code for i in validate(cql, context())] == []


def test_the_operators_of_text_and_numbers_come_from_goatlib() -> None:
    """Where an operator names a row of the web's filter panel, a field kind
    takes it when goatlib's operator table gives that row to the kind."""
    rows = TABLE["operators"]
    assert OPERATORS["string"] == {
        "=",
        "!=",
        "in",
        "contains",
        "like",
        "is_null",
        "is_not_null",
    }
    for kind in ("number", "integer"):
        assert "is_less_than" in rows[kind]
        assert OPERATORS[kind] == {
            "=",
            "!=",
            "<",
            "<=",
            ">",
            ">=",
            "in",
            "is_null",
            "is_not_null",
        }


@pytest.mark.parametrize("kind", list(TYPES))
def test_an_operator_a_kind_does_not_take_is_refused(kind: str) -> None:
    for op in set(get_args(Op)) - OPERATORS[kind]:
        with pytest.raises(InputInvalid):
            write(condition(kind, op))


def test_text_is_not_ordered() -> None:
    with pytest.raises(InputInvalid, match="string"):
        write({"field": "string", "op": "<", "value": "M"})


def test_not_equal_keeps_the_features_without_a_value() -> None:
    assert write({"field": "string", "op": "!=", "value": "Weg"}) == {
        "op": "or",
        "args": [
            {"op": "<>", "args": [{"property": "string"}, "Weg"]},
            {"op": "isNull", "args": [{"property": "string"}]},
        ],
    }
    cql = write(condition("integer", "!="))
    assert cql["op"] == "or"
    assert [i.code for i in validate(cql, context())] == []


def test_not_equal_to_the_empty_text_reads_not_empty() -> None:
    """`x <> ''` asks for a value, so it takes no empty alternative."""
    assert write({"field": "string", "op": "!=", "value": ""}) == {
        "op": "<>",
        "args": [{"property": "string"}, ""],
    }
