"""Feature filters the model writes without knowing CQL2 (spec §7.4).

The analytics service ignores a filter it cannot parse and counts everything,
so a misspelled field or a value of the wrong type would give a confident
wrong number. The model therefore sends structured conditions; the server
checks every field and every value against the layer's fields and builds the
CQL2-JSON itself.

Field kinds come from geoapi's queryables: ``string``, ``number``, ``integer``,
``boolean`` and ``date-time`` (a string with that format) can be filtered;
anything else (arrays, objects, unknown types) cannot.
"""

import difflib
import json
from collections.abc import Mapping
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, WithJsonSchema, model_validator

from assistant.tools.runtime import InputInvalid

Op = Literal[
    "=", "!=", "<", "<=", ">", ">=", "in", "like", "contains", "is_null", "is_not_null"
]
Scalar = str | int | float | bool

FILTERABLE_KINDS = frozenset({"string", "number", "integer", "boolean", "date-time"})
_CQL_OPS = {"=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">="}
_ORDERING = {"<", "<=", ">", ">="}
_CONDITION_KEYS = frozenset({"field", "op", "value"})
_FILTER_KEYS = frozenset({"match", "conditions"})

#: One valid condition. Models tend to write ``{"field": "speed", ">=": 0.2}``,
#: so the descriptions show the shape and the shape errors repeat it.
CONDITION_EXAMPLE = '{"field": "speed", "op": ">=", "value": 0.2}'
#: For the descriptions of every ``filter`` argument.
FILTER_EXAMPLES = (
    "Each condition is an object with field, op and value, e.g. "
    f'{{"conditions": [{CONDITION_EXAMPLE}]}}; a range is two conditions: '
    '{"conditions": [{"field": "year", "op": ">=", "value": 2010}, '
    '{"field": "year", "op": "<", "value": 2020}]}.'
)
CONDITION_SHAPE = (
    'A condition is {"field": <name>, "op": <operator>, "value": <value>}, '
    f"e.g. {CONDITION_EXAMPLE}."
)
FILTER_SHAPE = (
    'A filter is {"match": "all" or "any", "conditions": [...]}, '
    f'e.g. {{"conditions": [{CONDITION_EXAMPLE}]}}.'
)


def _decoded(data: Any) -> Any:
    """An object the model sent as JSON text, sometimes encoded twice, as the
    object; anything else unchanged, for the shape check to reject."""
    for _ in range(2):
        if not isinstance(data, str):
            break
        try:
            data = json.loads(data)
        except ValueError:
            break
    return data


def field_kind(schema: Mapping[str, Any]) -> str:
    """The kind of a queryables property: its JSON type, or ``date-time``."""
    kind = str(schema.get("type", "unknown"))
    if kind == "string" and schema.get("format") in ("date-time", "date"):
        return "date-time"
    return kind


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        """Another shape is still rejected, but the message shows the right
        one instead of naming each stray key."""
        if isinstance(data, cls):
            return data
        data = _decoded(data)
        if (
            not isinstance(data, Mapping)
            or not set(data) <= _CONDITION_KEYS
            or not {"field", "op"} <= set(data)
        ):
            raise ValueError(CONDITION_SHAPE)
        return data

    field: str = Field(description="Field name, as project_get_fields lists it.")
    op: Op = Field(
        description=(
            "'like': case-insensitive, % as wildcard; 'contains': the text "
            "anywhere, case-insensitive; is_null and is_not_null take no value."
        )
    )
    # Typed for validation; the model sees one line instead of six alternatives,
    # and a wrong type comes back as a message saying what fits.
    value: Annotated[
        Scalar | list[Scalar] | None,
        WithJsonSchema(
            {
                "description": "Of the field's type; a list for 'in'; dates as ISO 8601.",
                "default": None,
            }
        ),
    ] = None


class FeatureFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        """A bare condition or list in place of the filter object is rejected
        with the expected shape. Some models send the object as JSON text."""
        if isinstance(data, cls):
            return data
        data = _decoded(data)
        if (
            not isinstance(data, Mapping)
            or not set(data) <= _FILTER_KEYS
            or "conditions" not in data
        ):
            raise ValueError(FILTER_SHAPE)
        return data

    match: Literal["all", "any"] = Field(
        default="all", description="'all' = AND, 'any' = OR."
    )
    conditions: list[Condition] = Field(
        min_length=1, max_length=10, description="1 to 10."
    )


def unknown_field(name: str, fields: Mapping[str, str]) -> str:
    close = difflib.get_close_matches(name, list(fields), n=1, cutoff=0.6)
    hint = (
        f" Did you mean {close[0]!r}?"
        if close
        else f" Fields: {', '.join(sorted(fields)[:30])}."
    )
    return f"Field {name!r} doesn't exist on this layer.{hint}"


def _is_number(value: Scalar) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _typed(field: str, kind: str, value: Scalar) -> Any:
    """``value`` as CQL2-JSON for a field of ``kind``; raises a fixable error."""
    if kind == "string":
        if not isinstance(value, str):
            raise InputInvalid(
                f"Field {field!r} is text; compare it with a text value."
            )
        return value
    if kind == "number":
        if not _is_number(value):
            raise InputInvalid(f"Field {field!r} is numeric; compare it with a number.")
        return value
    if kind == "integer":
        if not _is_number(value) or (
            isinstance(value, float) and not value.is_integer()
        ):
            raise InputInvalid(
                f"Field {field!r} holds whole numbers; compare it with an integer."
            )
        return int(value)
    if kind == "boolean":
        if not isinstance(value, bool):
            raise InputInvalid(
                f"Field {field!r} is true or false; compare it with true or false."
            )
        return value
    # date-time
    if not isinstance(value, str):
        raise InputInvalid(
            f"Field {field!r} is a date-time; pass ISO 8601, e.g. '2024-05-01T00:00:00Z'."
        )
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InputInvalid(
            f"{value!r} is not an ISO 8601 date-time (field {field!r}); e.g. '2024-05-01T00:00:00Z'."
        ) from exc
    # The normalized form is sent, not the text: the compact and week-date forms
    # Python reads are not all read the same way by the CQL2 parser downstream
    # (it takes "2024-W18-3" for a different day).
    return {"timestamp": parsed.isoformat()}


def _condition(condition: Condition, fields: Mapping[str, str]) -> dict[str, Any]:
    if condition.field not in fields:
        raise InputInvalid(unknown_field(condition.field, fields))
    kind = fields[condition.field]
    if kind not in FILTERABLE_KINDS:
        raise InputInvalid(
            f"Field {condition.field!r} ({kind}) cannot be used in a filter."
        )
    prop = {"property": condition.field}
    if condition.op in ("is_null", "is_not_null"):
        if condition.value is not None:
            raise InputInvalid(
                f"{condition.op} takes no value (field {condition.field!r})."
            )
        expression: dict[str, Any] = {"op": "isNull", "args": [prop]}
        return (
            expression
            if condition.op == "is_null"
            else {"op": "not", "args": [expression]}
        )
    if condition.value is None:
        raise InputInvalid(
            f"Operator {condition.op!r} on {condition.field!r} needs a value."
        )
    if condition.op == "in":
        values = (
            condition.value if isinstance(condition.value, list) else [condition.value]
        )
        if not values:
            raise InputInvalid(f"'in' on {condition.field!r} needs at least one value.")
        return {
            "op": "in",
            "args": [prop, [_typed(condition.field, kind, v) for v in values]],
        }
    if isinstance(condition.value, list):
        raise InputInvalid(
            f"Operator {condition.op!r} takes one value, not a list; use 'in' for a list."
        )
    if condition.op == "contains":
        if kind != "string" or not isinstance(condition.value, str):
            raise InputInvalid(
                "'contains' works on text fields and takes a text, e.g. 'Schule'."
            )
        # The services' LIKE takes no escape character (goatlib's CQL2
        # evaluator sends the pattern to DuckDB's ILIKE as it is), so a % or _
        # in the text stays a wildcard and matches at least the text itself.
        return {"op": "like", "args": [prop, f"%{condition.value}%"]}
    if condition.op == "like":
        if kind != "string" or not isinstance(condition.value, str):
            raise InputInvalid(
                "'like' works on text fields and takes a text pattern, e.g. 'Haupt%'."
            )
        return {"op": "like", "args": [prop, condition.value]}
    if condition.op in _ORDERING and kind == "boolean":
        raise InputInvalid(f"Field {condition.field!r} is true or false; use = or !=.")
    return {
        "op": _CQL_OPS[condition.op],
        "args": [prop, _typed(condition.field, kind, condition.value)],
    }


def to_cql2(feature_filter: FeatureFilter, fields: Mapping[str, str]) -> dict[str, Any]:
    """CQL2-JSON for the filter. ``fields`` maps the layer's field names to their
    kinds (``field_kind``). Raises ``InputInvalid`` with a fixable message."""
    args = [_condition(condition, fields) for condition in feature_filter.conditions]
    if len(args) == 1:
        return args[0]
    return {"op": "and" if feature_filter.match == "all" else "or", "args": args}


def _value_text(value: Scalar | list[Scalar] | None) -> str:
    if isinstance(value, list):
        return "(" + ", ".join(_value_text(item) for item in value) + ")"
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return json.dumps(value)


def describe_filter(feature_filter: FeatureFilter | None) -> str:
    """The filter as the model and the step view read it."""
    if feature_filter is None:
        return "none (all features)"
    parts = []
    for condition in feature_filter.conditions:
        if condition.op == "is_null":
            parts.append(f"{condition.field} is null")
        elif condition.op == "is_not_null":
            parts.append(f"{condition.field} is not null")
        else:
            parts.append(
                f"{condition.field} {condition.op} {_value_text(condition.value)}"
            )
    return (" and " if feature_filter.match == "all" else " or ").join(parts)
