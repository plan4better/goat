import json
from enum import Enum
from typing import Any, Dict

from goatlib.filter.normalize import normalize
from goatlib.filter.validate import validate
from pydantic import BaseModel, Field, field_validator
from pygeofilter.parsers.cql2_json import parse as cql2_json_parser

#: The largest `query.ui` a save takes, as compact UTF-8 JSON. A switched-off
#: area is kept in the notes with its geometry, up to the points an area may
#: have.
QUERY_UI_MAX_BYTES = 256 * 1024


class OrderEnum(str, Enum):
    ascendent = "ascendent"
    descendent = "descendent"


class IntersectionQueryMetadata(BaseModel):
    label: str | None = Field(None, description="Name of the bounday")
    geom_type: str = Field(..., description="Value of the metadata")
    buffer_size: float | None = Field(None, description="Buffer size for the boundary")


class MetaDataQuery(BaseModel):
    intersection: IntersectionQueryMetadata | None = Field(
        None, description="Intersection query"
    )


def _cql_errors(cql: Any) -> list[str]:
    return [i.message for i in validate(cql) if i.level == "error"]


class CQLQueryObject(BaseModel):
    metadata: MetaDataQuery | None = Field(None, description="Metadata query")
    cql: Dict[str, Any] | None = Field(None, description="CQL query")
    ui: Dict[str, Any] | None = Field(
        None,
        description=(
            "What only the filter panel needs (switched-off rows); never "
            "changes which features pass."
        ),
    )

    # Read models use this class too, so this refuses only what the parser
    # cannot read, as it always did: a stored filter keeps loading. The checker
    # and the limits apply when a save changes the filter (`query_save_errors`).
    @field_validator("cql")
    @classmethod
    def validate_query(
        cls: type["CQLQueryObject"], value: Dict[str, Any] | None
    ) -> Dict[str, Any] | None:
        if value is None:
            return value
        try:
            cql2_json_parser(normalize(value))
        except Exception as e:
            raise ValueError(f"Invalid CQL query: {e}")
        return value


class CQLQuery(BaseModel):
    """Model for CQL query."""

    query: CQLQueryObject | None = Field(None, description="CQL query")


def _stored_cql(stored: Any) -> Any:
    """The filter of a stored `query`: today's `{"cql": ...}` or the CQL2 itself."""
    if not isinstance(stored, dict):
        return None
    return stored.get("cql") if "cql" in stored else (stored or None)


def same_json(a: Any, b: Any) -> bool:
    """Whether two parsed JSON values are the same: key order does not count
    and numbers compare by value (`1` and `1.0` are one number, as in JSON),
    but `true` is no number. Iterative, so no nesting depth can exhaust the
    stack."""
    stack = [(a, b)]
    while stack:
        x, y = stack.pop()
        if isinstance(x, bool) or isinstance(y, bool):
            if not (isinstance(x, bool) and isinstance(y, bool) and x == y):
                return False
        elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
            if x != y:
                return False
        elif isinstance(x, dict) and isinstance(y, dict):
            if x.keys() != y.keys():
                return False
            stack.extend((x[k], y[k]) for k in x)
        elif isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                return False
            stack.extend(zip(x, y))
        elif type(x) is not type(y) or x != y:
            return False
    return True


def query_save_errors(
    stored: Any, incoming: CQLQueryObject | Dict[str, Any] | None
) -> list[str]:
    """Why a save may not write `incoming` over the `stored` query; empty when it may.

    A filter the save changes (compared as parsed JSON) is checked as a new
    filter, limits included. A filter it leaves as it was is not checked again:
    a filter saved before a limit existed keeps loading, filtering and saving
    with the layer's other properties. The `ui` notes are capped in size.
    `incoming` is the update model's `query`, which is a plain dict where the
    update model is made optional field by field (table layers).
    """
    if isinstance(incoming, CQLQueryObject):
        cql, ui = incoming.cql, incoming.ui
    elif isinstance(incoming, dict):
        cql, ui = incoming.get("cql"), incoming.get("ui")
    else:
        return []
    errors = []
    if cql is not None and not same_json(cql, _stored_cql(stored)):
        cql_errors = _cql_errors(cql)
        if cql_errors:
            errors.append(f"Invalid CQL query: {'; '.join(cql_errors)}")
    if ui is not None:
        size = len(json.dumps(ui, separators=(",", ":"), ensure_ascii=False).encode())
        if size > QUERY_UI_MAX_BYTES:
            errors.append(
                f"The filter's ui notes take at most {QUERY_UI_MAX_BYTES} bytes; "
                f"these take {size}."
            )
    return errors


# test = CQLQueryObject(
#     cql={
#         "op": "=",
#         "args": [{"property": "category"}, "second_category"],
#     }
# )
# print(test)

# x={'query': {'cql': {'op': '=', 'args': [{'property': 'category'}, 'second_category']}}}
# CQLQuery(**x)
