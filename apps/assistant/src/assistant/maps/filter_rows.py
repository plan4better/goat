"""A project layer's saved filter as numbered rows, and row operations on it.

The filter is stored in the form the web's filter panel writes
(`goatlib.filter.rows`): rows that match all or any, switched-off rows, a
drawn area and the notes that go with them. The model reads it as a
`FilterBrief`, each row in words or "custom" for a row the panel shows as an
expression, and the area in words, and changes it row by row (`RowOp`); the
area is set and cleared by the operations of ``assistant.maps.filter_area``.
Whatever an operation does not touch (the area, switched-off and custom rows,
the notes, `metadata`) is written back as stored.

Row numbers start at 1 and count every row in order, switched-off ones
included; an area is no row. Within one call they name the rows as they were
before it.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Annotated, Any, Literal

from goatlib.filter.areas import area_summary
from goatlib.filter.limits import MAX_CONDITIONS
from goatlib.filter.rows import Row, read_rows, write_rows
from pydantic import BaseModel, ConfigDict, Field

from assistant.maps.filter_area import AreaSources, ClearArea, SetArea, build_area
from assistant.tools.filters import Condition, condition_cql
from assistant.tools.runtime import InputInvalid

#: The rows a filter holds, switched-off ones included; the panel saves no more.
MAX_ROWS = MAX_CONDITIONS

#: The panel's field types of the assistant's field kinds. A date-time field is
#: left out: the panel tells a day from a moment and the kind does not, so its
#: rows are read with the type their value shows.
_PANEL_TYPES = {
    "string": "string",
    "number": "number",
    "integer": "integer",
    "boolean": "boolean",
}

#: The panel's operators in words, by their names in goatlib's operator table
#: (`goatlib/filter/data/operators.json`).
_WORDS = {
    "is": "is",
    "is_not": "is not",
    "includes": "is one of",
    "excludes": "is not one of",
    "contains_the_text": "contains",
    "does_not_contains_the_text": "does not contain",
    "starts_with": "starts with",
    "ends_with": "ends with",
    "is_blank": "is empty",
    "is_not_blank": "is not empty",
    "is_less_than": "is less than",
    "is_greater_than": "is greater than",
    "is_at_most": "is at most",
    "is_at_least": "is at least",
    "is_between": "is between",
    "is_not_between": "is not between",
    "is_true": "is true",
    "is_false": "is false",
    "is_on": "is on",
    "is_not_on": "is not on",
    "is_before": "is before",
    "is_after": "is after",
    "in_the_last": "is in the last",
    "not_in_the_last": "is not in the last",
}
_RANGES = frozenset({"is_between", "is_not_between"})
_DAYS = frozenset({"in_the_last", "not_in_the_last"})
#: Operators whose values are days or moments, written without quotes.
_TEMPORAL = frozenset({"is_on", "is_not_on", "is_before", "is_after"}) | _DAYS
_LISTED = 5
_LONGEST = 120
CUSTOM = "custom"


class FilterRowView(BaseModel):
    row: int = Field(description="The row's number, from 1, as row operations name it.")
    text: str = Field(
        description=(
            "The condition in words, or 'custom' for an expression the filter "
            "panel shows as it is."
        )
    )
    on: bool = Field(
        default=True,
        description="False for a switched-off row: it is kept but filters nothing.",
    )


class FilterBrief(BaseModel):
    match: Literal["all", "any"] = Field(
        description="'all': a feature passes every switched-on row; 'any': at least one."
    )
    rows: list[FilterRowView] = Field(
        description="Every row in order, switched-off ones included."
    )
    area: str | None = Field(
        default=None,
        description=(
            "The area in words (regions, features of a layer, the map view, a "
            "drawn shape; outside or switched off when so); None without one. "
            "set_area and clear_area change it, row operations keep it."
        ),
    )


class AddRows(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["add"] = Field(description="Add rows after the last one.")
    conditions: list[Condition] = Field(
        min_length=1,
        max_length=10,
        description="1 to 10 conditions, each a new row, in this order.",
    )


class ReplaceRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["replace"] = Field(
        description="Put a new condition in place of a row; a switched-off row stays off."
    )
    row: int = Field(ge=1, description="The row's number in the filter as read.")
    condition: Condition = Field(description="The row's new condition.")


class RemoveRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["remove"] = Field(description="Remove a row.")
    row: int = Field(ge=1, description="The row's number in the filter as read.")


class SetMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["set_match"] = Field(
        description="Choose whether a feature passes every row or at least one."
    )
    match: Literal["all", "any"] = Field(description="'all' = AND, 'any' = OR.")


class ClearRows(BaseModel):
    model_config = ConfigDict(extra="forbid")

    do: Literal["clear"] = Field(
        description=(
            "Remove every row, switched-off ones included; the area stays. "
            "Rows added after it in the same call are kept."
        )
    )


RowOp = Annotated[
    AddRows | ReplaceRow | RemoveRow | SetMatch | ClearRows | SetArea | ClearArea,
    Field(discriminator="do"),
]


def _panel_fields(fields: Mapping[str, str]) -> dict[str, str]:
    return {
        name: _PANEL_TYPES[kind]
        for name, kind in fields.items()
        if kind in _PANEL_TYPES
    }


def _value_text(value: Any, temporal: bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return (
            str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
        )
    if isinstance(value, str):
        return value if temporal else json.dumps(value, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False, default=str)


def _row_text(
    panel: Mapping[str, Any], relative_days: int | None, fields: Mapping[str, str]
) -> str:
    """A panel row in words: the field, the operator and the value, at most
    `_LONGEST` characters. A relative date note reads as the panel shows it,
    "in the last N days"."""
    field, op = str(panel.get("field")), str(panel.get("op"))
    value = panel.get("value")
    temporal = (
        op in _TEMPORAL
        or panel.get("type") in ("date", "datetime")
        or fields.get(field) == "date-time"
    )
    if relative_days is not None and temporal and op == "is_at_least":
        op, value = "in_the_last", relative_days
    words = _WORDS.get(op, op.replace("_", " "))
    if op in _DAYS:
        days = _value_text(value, True)
        text = f"{field} {words} {days} {'day' if value == 1 else 'days'}"
    elif op in _RANGES:
        low = _value_text(value, temporal)
        text = f"{field} {words} {low} and {_value_text(panel.get('value2'), temporal)}"
    elif isinstance(value, list):
        shown = ", ".join(_value_text(v, temporal) for v in value[:_LISTED])
        more = f" and {len(value) - _LISTED} more" if len(value) > _LISTED else ""
        text = f"{field} {words} {shown}{more}"
    elif "value" in panel:
        text = f"{field} {words} {_value_text(value, temporal)}"
    else:
        text = f"{field} {words}"
    return text if len(text) <= _LONGEST else text[: _LONGEST - 1] + "…"


def brief(
    query: Any,
    fields: Mapping[str, str],
    *,
    layers: Mapping[str, str] | None = None,
) -> FilterBrief | None:
    """The stored filter as the model reads it; None without a row or an area.
    ``fields`` maps the layer's field names to their kinds (``field_kind``);
    ``layers`` names the layers an area's features come from
    (``filter_area.layer_labels``), "another layer" without it."""
    rows = read_rows(query, _panel_fields(fields))
    if not rows.rows and rows.area is None:
        return None
    return FilterBrief(
        match=rows.match,
        rows=[
            FilterRowView(
                row=number,
                text=CUSTOM
                if row.panel is None
                else _row_text(row.panel, row.relative_days, fields),
                on=row.enabled,
            )
            for number, row in enumerate(rows.rows, start=1)
        ],
        area=area_summary(rows.area_notes, rows.area, layers=layers)
        if rows.area is not None
        else None,
    )


def _refused(number: int, message: str) -> InputInvalid:
    return InputInvalid(f"Row operation {number}: {message}")


def _no_row(row: int, count: int) -> str:
    if count == 0:
        return "the filter has no rows."
    if count == 1:
        return f"the filter has no row {row}; its only row is 1."
    return f"the filter has no row {row}; its rows are 1 to {count}."


def _cql(number: int, condition: Condition, fields: Mapping[str, str]) -> Any:
    try:
        return condition_cql(condition, fields)
    except InputInvalid as exc:
        raise _refused(number, exc.message) from exc


@dataclass(frozen=True)
class FilterChange:
    """The query to store after a filter operation's row operations, in the
    panel's form (None when nothing is left), and what the model should say
    about how an area was built."""

    query: dict[str, Any] | None
    said: list[str] = field(default_factory=list)


def apply_row_ops(
    query: Any, ops: Sequence[RowOp], fields: Mapping[str, str]
) -> dict[str, Any] | None:
    """The query to store after row operations that set no area
    (``apply_filter_ops``)."""
    return apply_filter_ops(query, ops, fields).query


def apply_filter_ops(
    query: Any,
    ops: Sequence[RowOp],
    fields: Mapping[str, str],
    *,
    sources: AreaSources | None = None,
) -> FilterChange:
    """The query to store after the row operations. ``fields`` maps the
    layer's field names to their kinds (``field_kind``); ``sources`` holds
    the outlines of a ``set_area`` (``assistant.maps.area_sources``).

    Every row number names the row as it was before the call; new rows go
    after the last one in the order given. An area operation works on the
    rows the call leaves, so its outline fits beside them. Raises
    ``InputInvalid`` for a row that does not exist, a row two operations
    change, ``clear`` beside ``remove`` or ``replace``, a condition the
    layer's fields do not take, more than ``MAX_ROWS`` rows left where the
    call grew the filter (a filter stored over the limit can still be
    shrunk), more than one area operation, and an area that cannot be built
    (``filter_area.build_area``).
    """
    stored = read_rows(query, _panel_fields(fields))
    count = len(stored.rows)
    clear = next(
        (n for n, op in enumerate(ops, start=1) if isinstance(op, ClearRows)), None
    )
    areas = [
        (n, op)
        for n, op in enumerate(ops, start=1)
        if isinstance(op, SetArea | ClearArea)
    ]
    if len(areas) > 1:
        raise _refused(
            areas[1][0],
            "a filter operation takes at most one set_area or clear_area.",
        )
    changed: dict[int, int] = {}
    for number, op in enumerate(ops, start=1):
        if not isinstance(op, ReplaceRow | RemoveRow):
            continue
        if not 1 <= op.row <= count:
            raise _refused(number, _no_row(op.row, count))
        if clear is not None:
            raise _refused(
                number,
                f"clear (row operation {clear}) removes every row; do not remove "
                "or replace rows in the same call.",
            )
        if op.row in changed:
            raise _refused(
                number,
                f"row {op.row} is already changed by row operation "
                f"{changed[op.row]}; change each row once per call.",
            )
        changed[op.row] = number

    # Adds only append and clear comes with no remove or replace, so a stored
    # row keeps its index in this list.
    rows: list[Row | None] = list(stored.rows)
    match = stored.match
    for number, op in enumerate(ops, start=1):
        if isinstance(op, AddRows):
            rows.extend(Row(cql=_cql(number, c, fields)) for c in op.conditions)
        elif isinstance(op, ReplaceRow):
            before = stored.rows[op.row - 1]
            rows[op.row - 1] = Row(
                cql=_cql(number, op.condition, fields), enabled=before.enabled
            )
        elif isinstance(op, RemoveRow):
            rows[op.row - 1] = None
        elif isinstance(op, SetMatch):
            match = op.match
        elif isinstance(op, ClearRows):
            rows = [None] * len(rows)
    kept = tuple(row for row in rows if row is not None)
    if len(kept) > MAX_ROWS and len(kept) > count:
        raise InputInvalid(
            f"A filter holds at most {MAX_ROWS} rows, switched-off ones included; "
            f"these operations would leave {len(kept)}. Remove rows or combine "
            "conditions."
        )
    left = replace(stored, match=match, rows=kept)
    said: list[str] = []
    for number, op in areas:
        if isinstance(op, ClearArea):
            left = replace(left, area=None, area_notes=None)
            continue
        if sources is None:
            raise ValueError("set_area needs the outlines read before the plan")
        try:
            built = build_area(op, left, sources)
        except InputInvalid as exc:
            raise _refused(number, exc.message) from exc
        left = replace(left, area=built.node, area_notes=built.notes)
        said = built.said
    return FilterChange(query=write_rows(left), said=said)
