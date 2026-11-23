"""Saved layer filters in the filter panel's form for negations and empty tests.

The panel (`apps/web/lib/filter/rows.ts`) writes every negation (is not,
excludes, does not contain the text, is not between, is not on, not in the
last N days) with the empty value as an alternative, so it keeps the features
that have no value, and on a text field "is empty" and "is not empty" also take
the empty text. Filters saved before hold other shapes for the same rows (`!=`,
`isNull` alone, `not` around `like` or `in`, ...), which the services evaluate
without the empty value. The panel reads both as the same row and writes the
row in its form on the next save, so an old row changes what it filters the
first time any row of its filter is saved.

`convert_query` rewrites exactly those rows into what the panel writes for
them, so a saved filter means the same before and after its next save. A row is
what the panel's reader takes as one: an argument of the top level (`and` or
`or`; a top level of another kind is one row), an argument of the one `or` group
beside an area, and the condition of each switched-off row in the notes
(`ui.off`). A converted top level that was one row goes under `and`, and the
"match any" note goes where it would make the one converted row beside an area
read as two, as the panel saves both. Every other part of the query stays as it
was saved, also rows the panel would only spell differently. A row already in
the panel's form, a shape
no row says and an "is empty" or "is not empty" on a field whose type is not
known stay as they are, so a second run changes nothing.

The reading and the writing follow `cqlToRow` and `rowToCql` in `rows.ts`,
`readFilter` in `read.ts` and `isAreaNode` in `area.ts`; the shared fixture
`tests/unit/filter/fixtures/filter_conversions.json` holds both sides to the
same answers. Standard library only: core's data migration imports it.
"""

import copy
import json
import math
import re
from datetime import date, timedelta
from importlib import resources
from typing import Any, NamedTuple

#: The field types a filter knows (goatlib `FieldType`), by name.
Fields = dict[str, str]

#: The operators the panel writes with the empty value as an alternative.
NEGATIONS = frozenset(
    {
        "is_not",
        "excludes",
        "does_not_contains_the_text",
        "is_not_between",
        "is_not_on",
        "not_in_the_last",
    }
)
#: What `not` of a row reads as.
_OPPOSITE = {
    "includes": "excludes",
    "contains_the_text": "does_not_contains_the_text",
    "is_blank": "is_not_blank",
    "is": "is_not",
    "is_between": "is_not_between",
    "is_on": "is_not_on",
}
_PLAIN = ("is", "is_not", "is_blank", "is_not_blank")
_DAYS_AGO = "daysAgo"
_MISSING: Any = object()

_DAY = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T", re.ASCII)
_MIDNIGHT = re.compile(r"(\d{4}-\d{2}-\d{2})T00:00:00Z", re.ASCII)
_DECIMAL = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", re.ASCII)
_RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)", re.ASCII)
_BASES = {"x": 16, "o": 8, "b": 2}
#: What JavaScript's `trim` takes away.
_JS_SPACE = "\t\n\v\f\r           " "       　﻿"


def _load_operators() -> dict[str, list[str]]:
    text = resources.files("goatlib.filter").joinpath("data/operators.json").read_text()
    return json.loads(text)["operators"]


_OPERATORS = _load_operators()


class Converted(NamedTuple):
    """The query (or CQL) after the conversion, and each row it rewrote: the
    row's JSON pointer in the input and the operator the panel reads it as."""

    value: Any
    changes: list[tuple[str, str]]


# values ---------------------------------------------------------------------------------------


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _scalar(v: Any) -> bool:
    return v is None or isinstance(v, (str, int, float))


def _is_day(v: Any) -> bool:
    return isinstance(v, str) and _DAY.fullmatch(v) is not None


def _is_stamp(v: Any) -> bool:
    return isinstance(v, str) and _STAMP.match(v) is not None


def _calendar_day(day: str) -> date | None:
    """The day as JavaScript's `Date.parse` takes it: a day of the month up to 31
    runs on into the next month."""
    year, month, dom = int(day[0:4]), int(day[5:7]), int(day[8:10])
    if not 1 <= month <= 12 or not 1 <= dom <= 31 or year < 1:
        return None
    try:
        return date(year, month, 1) + timedelta(days=dom - 1)
    except OverflowError:
        return None


def _day_of(value: Any) -> str | None:
    if not (_is_day(value) or _is_stamp(value)):
        return None
    day = value[:10]
    return day if _calendar_day(day) else None


def _next_day(day: str) -> str | None:
    start = _calendar_day(day)
    if start is None:
        return None
    try:
        return (start + timedelta(days=1)).isoformat()
    except OverflowError:
        return None


def _js_number(text: str) -> Any:
    """JavaScript's `Number` of a trimmed text that is not empty, or None when it
    is no finite number; a whole number comes back as an int, as JSON writes it."""
    if _DECIMAL.fullmatch(text):
        n = float(text)
    elif _RADIX.fullmatch(text):
        try:
            n = float(int(text[2:], _BASES[text[1].lower()]))
        except OverflowError:
            return None
    else:
        return None
    if not math.isfinite(n):
        return None
    if n.is_integer() and abs(n) < 1e21:
        return int(n)
    return n


def _days_ago_of(value: Any) -> int | None:
    if not isinstance(value, dict) or value.get("op") != _DAYS_AGO or len(value) != 2:
        return None
    args = value.get("args")
    days = args[0] if isinstance(args, list) and len(args) == 1 else None
    if not _is_number(days) or not float(days).is_integer() or days < 1:
        return None
    return int(days)


def _guess_type(raw: Any) -> str | None:
    if _days_ago_of(raw) is not None:
        return "date"
    if isinstance(raw, dict):
        if isinstance(raw.get("date"), str):
            return "date"
        return "datetime" if isinstance(raw.get("timestamp"), str) else None
    if isinstance(raw, bool):
        return "boolean"
    if _is_number(raw):
        return "number"
    return "string" if isinstance(raw, str) else None


def _type_in(fields: Fields, field: str) -> str | None:
    return fields.get(field)


def _filter_value(raw: Any, type_: str | None) -> Any:
    """A saved value as the panel's row holds it, or _MISSING."""
    if isinstance(raw, dict):
        if len(raw) != 1 or type_ not in (None, "date", "datetime"):
            return _MISSING
        if isinstance(raw.get("date"), str):
            return raw["date"] if _is_day(raw["date"]) else _MISSING
        if isinstance(raw.get("timestamp"), str):
            stamp = raw["timestamp"]
            midnight = _MIDNIGHT.fullmatch(stamp) if type_ == "datetime" else None
            if midnight:
                return midnight.group(1)
            return stamp if _is_stamp(stamp) else _MISSING
        return _MISSING
    if raw is None or raw == "" or not _scalar(raw):
        return _MISSING
    if isinstance(raw, str) and not raw.strip(_JS_SPACE) and type_ != "string":
        return _MISSING
    return raw


def _date_literal(value: str, type_: str | None) -> Any:
    if _is_day(value):
        return (
            {"timestamp": f"{value}T00:00:00Z"}
            if type_ == "datetime"
            else {"date": value}
        )
    if _is_stamp(value):
        return {"timestamp": value}
    return value


def _typed_literal(value: Any, type_: str | None) -> Any:
    """The filter's literal of the field's type, or None while there is none."""
    if not _scalar(value) or value is None or value == "":
        return None
    if type_ in ("number", "integer"):
        if not isinstance(value, str):
            return value
        text = value.strip(_JS_SPACE)
        if not text:
            return None
        n = _js_number(text)
        return value if n is None else n
    if type_ == "boolean":
        return True if value == "true" else False if value == "false" else value
    if type_ in ("date", "datetime"):
        return _date_literal(value, type_) if isinstance(value, str) else value
    return value


def _text_literal(value: Any) -> str | None:
    """The text of a "contains" row; its reader gives text only."""
    return value if isinstance(value, str) and value else None


# reading --------------------------------------------------------------------------------------


def _field_of(node: dict[str, Any]) -> str | None:
    args = node.get("args")
    first = args[0] if isinstance(args, list) and args else None
    if isinstance(first, dict) and isinstance(first.get("property"), str):
        return first["property"]
    return None


def _null_field(node: Any) -> str | None:
    """The field of `isNull`, with its args as a list or as the bare property."""
    if not isinstance(node, dict) or node.get("op") != "isNull":
        return None
    args = node.get("args")
    arg = (args[0] if len(args) == 1 else None) if isinstance(args, list) else args
    if isinstance(arg, dict) and isinstance(arg.get("property"), str):
        return arg["property"]
    return None


def _temporal(type_: str | None) -> bool:
    return type_ in ("date", "datetime")


def _like_row(field: str, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str):
        return None
    starts = raw.startswith("%")
    ends = raw.endswith("%") and len(raw) > 1
    text = raw[1 if starts else 0 : -1 if ends else None]
    if re.search("[%_]", text) or not text:
        return None
    if starts and ends:
        return {"field": field, "op": "contains_the_text", "value": text}
    if ends:
        return {"field": field, "op": "starts_with", "value": text}
    if starts:
        return {"field": field, "op": "ends_with", "value": text}
    return None


def _comparison_row(
    op: Any, field: str, raw: Any, args: list[Any], fields: Fields
) -> dict[str, Any] | None:
    known = _type_in(fields, field)
    if len(args) != 2:
        return None
    if op == "like":
        return _like_row(field, raw)
    guessed = known or _guess_type(
        (raw[0] if raw else None) if isinstance(raw, list) else raw
    )

    def typed(row: dict[str, Any]) -> dict[str, Any]:
        return {**row, "type": guessed} if not known and guessed else row

    if op == "in":
        if not isinstance(raw, list) or not raw:
            return None
        values = [_filter_value(v, guessed) for v in raw]
        if any(v is _MISSING for v in values):
            return None
        return typed({"field": field, "op": "includes", "value": values})
    if op in ("=", "<>", "!=") and raw == "" and isinstance(raw, str):
        if guessed != "string":
            return None
        return typed(
            {"field": field, "op": "is_blank" if op == "=" else "is_not_blank"}
        )
    if op == "=" and isinstance(raw, bool):
        return {"field": field, "op": "is_true" if raw else "is_false"}
    days = _days_ago_of(raw)
    if days is not None:
        return (
            typed({"field": field, "op": "in_the_last", "value": days})
            if op == ">="
            else None
        )
    value = _filter_value(raw, guessed)
    if value is _MISSING:
        return None
    is_date = _temporal(guessed)
    on_day = guessed == "date" and _is_day(value)
    ops = {
        "=": "is_on" if on_day else "is",
        "<>": "is_not_on" if on_day else "is_not",
        "!=": "is_not_on" if on_day else "is_not",
        "<": "is_before" if is_date else "is_less_than",
        ">": "is_after" if is_date else "is_greater_than",
        "<=": "is_at_most",
        ">=": "is_at_least",
    }
    if not isinstance(op, str) or op not in ops:
        return None
    return typed({"field": field, "op": ops[op], "value": value})


def _bounds(args: list[Any]) -> tuple[str, list[Any], list[Any]] | None:
    """Two comparisons of one field with two args each: the field, their
    operators and their values."""
    if len(args) != 2 or not all(isinstance(a, dict) for a in args):
        return None
    a, b = args
    field = _field_of(a)
    if not field or field != _field_of(b):
        return None
    if not isinstance(a.get("args"), list) or not isinstance(b.get("args"), list):
        return None
    if len(a["args"]) != 2 or len(b["args"]) != 2:
        return None
    return field, [a.get("op"), b.get("op")], [a["args"][1], b["args"][1]]


def _at(ops: list[Any], op: str) -> int:
    return ops.index(op) if op in ops else -1


def _range_row(
    field: str, op: str, lo: Any, hi: Any, fields: Fields
) -> dict[str, Any] | None:
    known = _type_in(fields, field)
    type_ = known or _guess_type(lo)
    value, value2 = _filter_value(lo, type_), _filter_value(hi, type_)
    if value is _MISSING or value2 is _MISSING:
        return None
    row = {"field": field, "op": op, "value": value, "value2": value2}
    return {**row, "type": type_} if not known and type_ else row


def _day_row(
    field: str, lo: Any, hi: Any, op: str, fields: Fields
) -> dict[str, Any] | None:
    row = _range_row(field, "is_between", lo, hi, fields)
    if not row or (row.get("type") or _type_in(fields, field)) != "datetime":
        return None
    day = row["value"] if _is_day(row["value"]) else None
    if not day or row["value2"] != _next_day(day):
        return None
    out = {"field": field, "op": op, "value": day}
    return {**out, "type": row["type"]} if row.get("type") else out


def _filter_and(args: list[Any], fields: Fields) -> dict[str, Any] | None:
    b = _bounds(args)
    if b:
        field, ops, raws = b
        if _at(ops, ">=") >= 0 and _at(ops, "<=") >= 0:
            return _range_row(
                field, "is_between", raws[_at(ops, ">=")], raws[_at(ops, "<=")], fields
            )
        if _at(ops, ">=") >= 0 and _at(ops, "<") >= 0:
            return _day_row(
                field, raws[_at(ops, ">=")], raws[_at(ops, "<")], "is_on", fields
            )
    if len(args) == 2:
        a, c = args
        for negated, other in ((a, c), (c, a)):
            blank = (
                negated["args"]
                if isinstance(negated, dict)
                and negated.get("op") == "not"
                and isinstance(negated.get("args"), list)
                else None
            )
            field = _null_field(blank[0]) if blank and len(blank) == 1 else None
            row = _parse(other, fields, 3) if field else None
            if row and row["field"] == field and row["op"] == "is_not_blank":
                return {"field": field, "op": "is_not_blank"}
    values: list[Any] = []
    listed: str | None = None
    for arg in args:
        if not isinstance(arg, dict) or arg.get("op") not in ("!=", "<>"):
            return None
        row = _parse(arg, fields, 3)
        if (
            not row
            or row["op"] != "is_not"
            or (listed is not None and row["field"] != listed)
        ):
            return None
        listed = row["field"]
        values.append(row["value"])
    return (
        None if listed is None else {"field": listed, "op": "excludes", "value": values}
    )


def _filter_or(args: list[Any], fields: Fields, depth: int) -> dict[str, Any] | None:
    empties = [_null_field(a) for a in args]
    field = next((f for f in empties if f is not None), None)
    if field is not None:
        if any(f is not None and f != field for f in empties):
            return None
        rest = [a for a, f in zip(args, empties, strict=True) if f is None]
        if not rest:
            return {"field": field, "op": "is_blank"}
        before = (
            rest[0]
            if len(rest) == 1 and isinstance(rest[0], dict) and rest[0].get("op") == "<"
            else None
        )
        days = (
            _days_ago_of(before["args"][1])
            if before
            and _field_of(before) == field
            and isinstance(before.get("args"), list)
            and len(before["args"]) == 2
            else None
        )
        if days is not None:
            row = {"field": field, "op": "not_in_the_last", "value": days}
            return row if _type_in(fields, field) else {**row, "type": "date"}
        inner = (
            _parse(rest[0], fields, depth + 1)
            if len(rest) == 1
            else _filter_or(rest, fields, depth + 1)
        )
        if not inner or inner["field"] != field:
            return None
        if inner["op"] in NEGATIONS or inner["op"] == "is_blank":
            return inner
        return None
    b = _bounds(args)
    if b:
        bfield, ops, raws = b
        if _at(ops, "<") >= 0 and _at(ops, ">") >= 0:
            return _range_row(
                bfield,
                "is_not_between",
                raws[_at(ops, "<")],
                raws[_at(ops, ">")],
                fields,
            )
        if _at(ops, "<") >= 0 and _at(ops, ">=") >= 0:
            return _day_row(
                bfield, raws[_at(ops, "<")], raws[_at(ops, ">=")], "is_not_on", fields
            )
    values: list[Any] = []
    listed: str | None = None
    type_: str | None = None
    for arg in args:
        if not isinstance(arg, dict) or arg.get("op") != "=":
            return None
        row = _parse(arg, fields, 3)
        if (
            not row
            or row["op"] != "is"
            or (listed is not None and row["field"] != listed)
        ):
            return None
        listed = row["field"]
        type_ = row.get("type")
        values.append(row["value"])
    if listed is None:
        return None
    row = {"field": listed, "op": "includes", "value": values}
    return {**row, "type": type_} if type_ else row


def _parse(node: Any, fields: Fields, depth: int) -> dict[str, Any] | None:
    if depth > 3 or not isinstance(node, dict):
        return None
    op = node.get("op")
    if op == "isNull":
        field = _null_field(node)
        return {"field": field, "op": "is_blank"} if field else None
    args = node.get("args")
    if not isinstance(args, list):
        return None
    if op == "not":
        if len(args) != 1:
            return None
        inner = _parse(args[0], fields, depth + 1)
        opposite = _OPPOSITE.get(inner["op"]) if inner else None
        if not inner or not opposite:
            return None
        if opposite == "is_not_blank":
            return {"field": inner["field"], "op": opposite}
        return {**inner, "op": opposite}
    if op == "and":
        return _filter_and(args, fields)
    if op == "or":
        return _filter_or(args, fields, depth)
    if op == "between":
        field = _field_of(node)
        if not field:
            return None
        if len(args) == 3:
            return _range_row(field, "is_between", args[1], args[2], fields)
        pair = args[1] if len(args) == 2 else None
        if isinstance(pair, list) and len(pair) == 2:
            return _range_row(field, "is_between", pair[0], pair[1], fields)
        return None
    field = _field_of(node)
    if not field:
        return None
    return _comparison_row(op, field, args[1] if len(args) > 1 else None, args, fields)


def _row_of(node: Any, fields: Fields) -> dict[str, Any] | None:
    """The row the panel reads a condition as (`cqlToRow`), or None."""
    row = _parse(node, fields, 0)
    if not row:
        return None
    type_ = _type_in(fields, row["field"])
    offered = _OPERATORS.get(type_, _PLAIN) if type_ else None
    return None if offered is not None and row["op"] not in offered else row


# writing --------------------------------------------------------------------------------------


def _write(row: dict[str, Any], type_: str | None) -> dict[str, Any] | None:
    """The panel's CQL of a negation or an empty test (`rowToCql`), or None
    while the row is unfinished."""
    field = row["field"]
    if not isinstance(field, str) or not field:
        return None
    p = {"property": field}
    is_null = {"op": "isNull", "args": [p]}

    def with_empty(node: dict[str, Any] | None) -> dict[str, Any] | None:
        if node is None:
            return None
        args = node["args"] if node["op"] == "or" else [node]
        return {"op": "or", "args": [*args, is_null]}

    def compare(op: str, value: Any) -> dict[str, Any] | None:
        v = _typed_literal(value, type_)
        return None if v is None else {"op": op, "args": [p, v]}

    op, value = row["op"], row.get("value", _MISSING)
    text = type_ == "string"
    if op == "is_not":
        return with_empty(compare("<>", value))
    if op == "excludes":
        values = (
            value
            if isinstance(value, list)
            else [v.strip(_JS_SPACE) for v in value.split(",") if v.strip(_JS_SPACE)]
            if isinstance(value, str)
            else []
        )
        literals = [_typed_literal(v, type_) for v in values]
        if not literals or any(v is None for v in literals):
            return None
        return with_empty({"op": "not", "args": [{"op": "in", "args": [p, literals]}]})
    if op == "is_blank":
        return (
            {"op": "or", "args": [is_null, {"op": "=", "args": [p, ""]}]}
            if text
            else is_null
        )
    if op == "is_not_blank":
        negated = {"op": "not", "args": [is_null]}
        return (
            {"op": "and", "args": [negated, {"op": "<>", "args": [p, ""]}]}
            if text
            else negated
        )
    if op == "is_not_between":
        lo, hi = _typed_literal(value, type_), _typed_literal(row.get("value2"), type_)
        if lo is None or hi is None:
            return None
        return with_empty(
            {
                "op": "or",
                "args": [{"op": "<", "args": [p, lo]}, {"op": ">", "args": [p, hi]}],
            }
        )
    if op == "does_not_contains_the_text":
        pattern = _text_literal(value)
        if pattern is None or re.search("[%_]", pattern):
            return None
        return with_empty(
            {"op": "not", "args": [{"op": "like", "args": [p, f"%{pattern}%"]}]}
        )
    if op == "is_not_on":
        day = _day_of(value)
        if not day:
            return None
        if type_ != "datetime":
            return with_empty({"op": "<>", "args": [p, _typed_literal(day, "date")]})
        end = _next_day(day)
        if end is None:
            return None
        return with_empty(
            {
                "op": "or",
                "args": [
                    {"op": "<", "args": [p, {"timestamp": f"{day}T00:00:00Z"}]},
                    {"op": ">=", "args": [p, {"timestamp": f"{end}T00:00:00Z"}]},
                ],
            }
        )
    return None


# what changes ---------------------------------------------------------------------------------


def _mentions_empty_text(node: Any) -> bool:
    """Whether a comparison inside `node` compares with the empty text."""
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            args = n.get("args")
            if (
                n.get("op") in ("=", "<>", "!=")
                and isinstance(args, list)
                and len(args) == 2
                and args[1] == ""
            ):
                return True
            stack.extend(v for v in n.values() if isinstance(v, (dict, list)))
        elif isinstance(n, list):
            stack.extend(n)
    return False


def _mentions_null(node: Any) -> bool:
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            if n.get("op") == "isNull":
                return True
            stack.extend(v for v in n.values() if isinstance(v, (dict, list)))
        elif isinstance(n, list):
            stack.extend(n)
    return False


def _changes_meaning(node: Any, row: dict[str, Any], type_: str | None) -> bool:
    """Whether the panel's form of the row filters otherwise than `node`."""
    op, field = row["op"], row["field"]
    if op in NEGATIONS:
        # Already in the panel's form: the empty value is one of the alternatives.
        args = node.get("args") if node.get("op") == "or" else None
        return not (
            isinstance(args, list) and any(_null_field(a) == field for a in args)
        )
    if type_ != "string":
        return False
    if op == "is_blank":
        return not (_mentions_null(node) and _mentions_empty_text(node))
    if op == "is_not_blank":
        # `!=` against the empty text means the same; it is written in the panel's
        # form all the same, so no stored filter keeps the legacy operator.
        return node.get("op") == "!=" or not _mentions_empty_text(node)
    return False


def _convert_row(node: Any, fields: Fields | None) -> tuple[Any, str] | None:
    """The panel's form of one row, with the operator it reads as; None when the
    row stays as it is."""
    known = fields if fields is not None else {}
    row = _row_of(node, known)
    if row is None:
        return None
    if fields is None and row["op"] not in NEGATIONS:
        return None
    type_ = known.get(row["field"]) or row.get("type")
    if not _changes_meaning(node, row, known.get(row["field"])):
        return None
    written = _write(row, type_)
    if written is None or written == node:
        return None
    return written, row["op"]


# areas ----------------------------------------------------------------------------------------


def _is_position(v: Any) -> bool:
    return (
        isinstance(v, list)
        and len(v) >= 2
        and all(_is_number(x) and math.isfinite(x) for x in v[:2])
    )


def _is_polygon(v: Any) -> bool:
    return (
        isinstance(v, list)
        and len(v) > 0
        and all(
            isinstance(ring, list)
            and len(ring) >= 4
            and all(_is_position(p) for p in ring)
            for ring in v
        )
    )


def _has_polygons(geometry: Any) -> bool:
    if not isinstance(geometry, dict):
        return False
    kind, coordinates = geometry.get("type"), geometry.get("coordinates")
    if kind == "Polygon":
        return _is_polygon(coordinates)
    if kind == "MultiPolygon":
        return (
            isinstance(coordinates, list)
            and len(coordinates) > 0
            and all(_is_polygon(c) for c in coordinates)
        )
    bbox = geometry.get("bbox")
    if len(geometry) == 1 and isinstance(bbox, list):
        box = [bbox[0], bbox[1], bbox[3], bbox[4]] if len(bbox) == 6 else bbox
        return len(box) == 4 and all(_is_number(x) and math.isfinite(x) for x in box)
    return False


def _intersects(node: Any) -> bool:
    if not isinstance(node, dict) or node.get("op") != "s_intersects":
        return False
    args = node.get("args")
    if not isinstance(args, list) or len(args) != 2:
        return False
    field = args[0]
    return (
        isinstance(field, dict)
        and isinstance(field.get("property"), str)
        and _has_polygons(args[1])
    )


def _is_area(node: Any) -> bool:
    """A condition the panel takes as the filter's area (`isAreaNode`)."""
    if isinstance(node, dict) and node.get("op") == "not":
        args = node.get("args")
        return isinstance(args, list) and len(args) == 1 and _intersects(args[0])
    return _intersects(node)


# the filter -----------------------------------------------------------------------------------


def _row_paths(cql: Any, fields: Fields, match_any: bool) -> list[tuple[Any, ...]]:
    """Where the rows of the active CQL are, as `readFilter` splits it."""
    if (
        isinstance(cql, dict)
        and cql.get("op") in ("and", "or")
        and isinstance(cql.get("args"), list)
    ):
        args: list[Any] = cql["args"]
        paths: list[tuple[Any, ...]] = [("args", i) for i in range(len(args))]
        top_all = cql["op"] == "and"
    elif cql is None or (isinstance(cql, dict) and not cql):
        return []
    else:
        args, paths, top_all = [cql], [()], True
    at = (
        next((i for i, a in enumerate(args) if _is_area(a)), -1)
        if top_all or len(args) == 1
        else -1
    )
    if at < 0:
        return paths
    del paths[at]
    rest = [a for i, a in enumerate(args) if i != at]
    group = rest[0] if len(rest) == 1 else None
    if (
        isinstance(group, dict)
        and group.get("op") == "or"
        and isinstance(group.get("args"), list)
        and (match_any or not _row_of(group, fields))
    ):
        return [(*paths[0], "args", j) for j in range(len(group["args"]))]
    return paths


def _lone_beside_area(cql: Any) -> tuple[Any, ...] | None:
    """The path of the one argument beside an area at the top level that is no
    `or` group, or None."""
    if not isinstance(cql, dict) or cql.get("op") not in ("and", "or"):
        return None
    args = cql.get("args")
    if not isinstance(args, list) or not (cql["op"] == "and" or len(args) == 1):
        return None
    at = next((i for i, a in enumerate(args) if _is_area(a)), -1)
    if at < 0 or len(args) != 2:
        return None
    other = 1 - at
    group = args[other]
    if (
        isinstance(group, dict)
        and group.get("op") == "or"
        and isinstance(group.get("args"), list)
    ):
        return None
    return ("args", other)


def _get(node: Any, path: tuple[Any, ...]) -> Any:
    for key in path:
        node = node[key]
    return node


def _pointer(path: tuple[Any, ...]) -> str:
    return "".join(f"/{str(k).replace('~', '~0').replace('/', '~1')}" for k in path)


def _convert_at(
    root: Any,
    paths: list[tuple[Any, ...]],
    fields: Fields | None,
    prefix: tuple[Any, ...],
) -> tuple[Any, list[tuple[str, str]]]:
    changes: list[tuple[str, str]] = []
    out = root
    for path in paths:
        converted = _convert_row(_get(root, path), fields)
        if converted is None:
            continue
        if out is root:
            out = copy.deepcopy(root)
        if path:
            _get(out, path[:-1])[path[-1]] = converted[0]
        else:
            # A top level that is one row: the panel saves its rows under `and`,
            # so its own `or` is not read as two rows.
            out = {"op": "and", "args": [converted[0]]}
        changes.append((_pointer(prefix + path), converted[1]))
    return out, changes


def convert_cql(cql: Any, fields: Fields | None, match_any: bool = False) -> Converted:
    """The active CQL of a filter with its rows converted. `fields` are the
    layer's field types by name, None when they are not known (then only the
    negations are converted); `match_any` is the notes' "match any" (`ui.any`)."""
    paths = _row_paths(cql, fields or {}, match_any)
    value, changes = _convert_at(cql, paths, fields, ())
    return Converted(value, changes)


def _off_paths(ui: Any) -> list[tuple[Any, ...]]:
    """The switched-off rows of the notes that the panel reads (`readNotes`)."""
    if (
        not isinstance(ui, dict)
        or ui.get("v") != 1
        or not isinstance(ui.get("off"), list)
    ):
        return []
    return [
        ("off", i, "cql")
        for i, entry in enumerate(ui["off"])
        if isinstance(entry, dict)
        and isinstance(entry.get("at"), int)
        and not isinstance(entry.get("at"), bool)
        and entry["at"] >= 0
        and entry.get("cql") is not None
    ]


def convert_query(query: Any, fields: Fields | None) -> Converted:
    """A stored layer filter (`{cql, ui?, metadata?}`, or the CQL itself as
    saved long ago) with its rows converted; see the module docstring. The input
    is not changed; without a change the same object comes back."""
    if not isinstance(query, dict):
        return Converted(query, [])
    if "cql" not in query:
        return convert_cql(query, fields) if "op" in query else Converted(query, [])
    ui = query.get("ui")
    match_any = isinstance(ui, dict) and ui.get("v") == 1 and ui.get("any") is True
    cql, changes = convert_cql(query["cql"], fields, match_any)
    off, off_changes = _convert_at(ui, _off_paths(ui), fields, ("ui",))
    if not changes and not off_changes:
        return Converted(query, [])
    out = {**query, "cql": cql}
    if off_changes:
        out["ui"] = off
    changes = [(f"/cql{p}", op) for p, op in changes] + off_changes
    lone = _lone_beside_area(query["cql"]) if match_any else None
    if (
        lone is not None
        and isinstance(_get(cql, lone), dict)
        and _get(cql, lone).get("op") == "or"
    ):
        # The one row beside an area reads as one row with "match any" noted only
        # while it is no `or`; the panel reads it as matching all and drops the
        # note on saving, and so does the conversion.
        out["ui"] = {k: v for k, v in out.get("ui", ui).items() if k != "any"}
        changes.append(("/ui/any", "any"))
    return Converted(out, changes)
