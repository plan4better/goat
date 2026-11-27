"""The legend numbers of a style: for each classification, how many of the
features the layer's saved filter keeps fall in each class, in no class and
have no value. They tell whether the classes split the data well.

Counted by processes with the requests the web's legend makes
(``useLegendPresence``), under the layer's saved filter:

- ``feature-count`` with the filter: the features.
- categories: ``unique-values`` of the field, each value's count added to the
  class that lists it, matched as the map matches it (``class_index``);
  ``feature-count`` with the filter and ``isNull(field)``: the features
  without a value.
- numeric classes: ``histogram`` with ``custom_breaks`` = every limit of the
  classes (the web's ``presenceRequests``). The service adds the data's
  minimum and maximum as the outer edges, drops a break outside them and
  counts each bin from its lower edge up to its upper one, the last one
  included. No bin crosses a class limit, so each bin's count goes to the
  class its middle lies in, read as the web's legend ``classifier`` reads a
  value (a class holds its ``from``, not its ``to``); a bin in no class is
  ``other``. A class the data under the filter does not reach counts 0;
  ``without_value`` is the histogram's ``missing_count``.
"""

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from decimal import Decimal
from typing import Any, TypeGuard

from goatlib.style.pointer import item_key, to_pointer
from pydantic import BaseModel

from assistant.tools.project import _analytics, _Layer, saved_filter
from assistant.tools.runtime import ToolEnv

LEGEND_UNAVAILABLE = "The legend numbers are not available right now."
ADDS_UP_NOT = "The legend numbers do not add up to the feature count."
#: Classifications counted per read when none is named.
MAX_COUNTED = 3
#: Classes a classification's numbers list, in the legend's order.
MAX_LISTED = 12
#: The most values the unique values request answers at once (the web's
#: ``VALUES_LIMIT``).
VALUES_LIMIT = 1000
#: Values a category class's label names before "and N more".
LABEL_VALUES = 3
#: A number as a database or goatlib writes one (the web's ``DECIMAL``): no
#: ``+``, no leading zero before the whole part, so a code such as "01067"
#: stays text.
_DECIMAL = re.compile(r"-?(0|[1-9]\d*)(\.\d+)?(e[+-]?\d+)?", re.IGNORECASE)


class LegendClass(BaseModel):
    id: str | None = None
    label: str
    count: int
    #: Of ``features``, 0 to 1, rounded to 3 places.
    share: float


class LegendNumbers(BaseModel):
    #: The classification's pointer, e.g. ``/classify/density``.
    classification: str
    field: str
    method: str
    #: Features the layer's saved filter keeps.
    features: int
    without_value: int
    #: Features with a value in no class: always for categories, for numeric
    #: classes only when there are any.
    other: int | None = None
    #: At most ``MAX_LISTED``, in the legend's order.
    classes: list[LegendClass]
    #: Classes left out.
    more: int | None = None


# ---- values as the map writes and matches them --------------------------------------


def _is_number(value: Any) -> TypeGuard[float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _values(record: Any) -> list[Any]:
    """A category class's values."""
    values = record.get("values") if isinstance(record, dict) else None
    return values if isinstance(values, list) else []


def number_text(value: float) -> str:
    """The text JavaScript writes for a number (``String(n)``), which the map
    compares category values by: ``3.0`` is "3", ``1e-05`` is "0.00001",
    ``1e-07`` is "1e-7"."""
    if value != value:
        return "NaN"
    if value in (float("inf"), float("-inf")):
        return "Infinity" if value > 0 else "-Infinity"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    sign = "-" if value < 0 else ""
    parts = Decimal(repr(abs(float(value)))).normalize().as_tuple()
    digits = "".join(map(str, parts.digits))
    k = len(digits)
    n = int(parts.exponent) + k
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    exponent = n - 1
    mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
    return f"{sign}{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"


def map_number_text(text: str) -> str | None:
    """The map's text of the number ``text`` writes ("3.0" is "3", "0.50" is
    "0.5"); None for a text that writes no number (the web's
    ``mapNumberText``)."""
    if not _DECIMAL.fullmatch(text):
        return None
    number = float(text)
    return number_text(number) if abs(number) != float("inf") else None


def value_text(value: Any) -> str:
    """A value's text as JavaScript's ``String`` writes it."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if _is_number(value):
        return number_text(value)
    return str(value)


def class_index(classes: Sequence[Any]) -> Callable[[Any], int | None]:
    """The index of the category class a value falls in, None for no class.

    Each class matches its values' texts (a text two classes list stays with
    the first), then the number spelling of each value no class lists as it
    is (the web's ``classTexts``). A value is read by its own text first and
    by its number's spelling second, so the service's "3.0" of a number field
    lands in the class of 3, and a text field's "3.0" in the class of "3.0"
    when one lists it.
    """
    by_text: dict[str, int] = {}
    values = [_values(c) for c in classes]
    for index, listed in enumerate(values):
        for value in listed:
            by_text.setdefault(value_text(value), index)
    for index, listed in enumerate(values):
        for value in listed:
            spelled = map_number_text(value) if isinstance(value, str) else None
            if spelled is not None:
                by_text.setdefault(spelled, index)

    def index_of(value: Any) -> int | None:
        found = by_text.get(value_text(value))
        if found is None and isinstance(value, str):
            spelled = map_number_text(value)
            if spelled is not None:
                found = by_text.get(spelled)
        return found

    return index_of


# ---- what is counted ---------------------------------------------------------------


@dataclass(frozen=True)
class _Counted:
    pointer: str
    field: str
    method: str
    classes: list[dict[str, Any]]
    #: Numeric classes: every limit of the classes, ascending.
    breaks: list[float] | None
    #: Classes fitted to the data: class id to the one value the class holds
    #: (`computed.single`).
    single: dict[str, float] = dataclass_field(default_factory=dict)


def _inner_limits(classes: list[dict[str, Any]]) -> list[float] | None:
    """The limit between each class and the next (its ``to``, else the next
    one's ``from``); None when one is missing or they do not ascend."""
    limits: list[float] = []
    for current, following in zip(classes, classes[1:], strict=False):
        limit = current.get("to")
        if not _is_number(limit):
            limit = following.get("from")
        if not _is_number(limit) or (limits and limit <= limits[-1]):
            return None
        limits.append(float(limit))
    return limits


def _limits(classes: list[dict[str, Any]]) -> list[float] | None:
    """Every ``from`` and ``to`` of numeric classes, ascending, once each;
    None for classes whose limits between neighbours are not all stored
    (computed classes the server has not filled yet)."""
    if _inner_limits(classes) is None:
        return None
    bounds = {
        float(value)
        for record in classes
        for value in (record.get("from"), record.get("to"))
        if _is_number(value) and abs(value) != float("inf")
    }
    return sorted(bounds)


def _numeric_index(classes: list[dict[str, Any]], value: float) -> int | None:
    """The class a number falls in, as the web's legend ``classifier`` reads
    it: the first class with ``from <= value < to``, a missing limit open."""
    for index, record in enumerate(classes):
        low, high = record.get("from"), record.get("to")
        if (not _is_number(low) or value >= low) and (
            not _is_number(high) or value < high
        ):
            return index
    return None


def _counted(document: dict[str, Any]) -> list[_Counted]:
    """The classifications of a vector style that have stored classes, in
    document order. A raster's classes, and an H3 grid's (which count cells,
    not features), are not counted."""
    if document.get("kind") == "raster":
        return []
    found: list[_Counted] = []
    classify = document.get("classify")
    for index, c in enumerate(classify if isinstance(classify, list) else []):
        if not isinstance(c, dict):
            continue
        field, method, classes = c.get("field"), c.get("method"), c.get("classes")
        if not (isinstance(field, str) and field and isinstance(method, str)):
            continue
        if not isinstance(classes, list) or not classes:
            continue
        if not all(isinstance(k, dict) for k in classes):
            continue
        breaks = None if method == "categories" else _limits(classes)
        if method != "categories" and breaks is None:
            continue
        computed = c.get("computed")
        # Single values are read for classes fitted to the data only.
        single = (
            computed.get("single")
            if isinstance(computed, dict) and c.get("fit") is True
            else None
        )
        found.append(
            _Counted(
                to_pointer(["classify", item_key(c, index)]),
                field,
                method,
                classes,
                breaks,
                {
                    k: v
                    for k, v in (single if isinstance(single, dict) else {}).items()
                    if _is_number(v)
                },
            )
        )
    return found


# ---- the counts ----------------------------------------------------------------------


def _null_filter(cql: dict[str, Any] | None, field: str) -> dict[str, Any]:
    """The filter and ``isNull(field)``, as the web's legend writes it."""
    empty = {"op": "isNull", "args": [{"property": field}]}
    return {"op": "and", "args": [cql, empty]} if cql is not None else empty


def _count(reply: Any, key: str) -> int:
    value = reply.get(key) if isinstance(reply, dict) else None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"no {key} in the answer")
    return value


def _label(c: _Counted, record: dict[str, Any]) -> str:
    name = record.get("name")
    if isinstance(name, str) and name:
        return name
    if c.method == "categories":
        listed = _values(record)
        texts = [value_text(v) for v in listed[:LABEL_VALUES]]
        rest = len(listed) - len(texts)
        return ", ".join(texts) + (f" and {rest} more" if rest > 0 else "")
    rid = record.get("id")
    one = c.single.get(rid) if isinstance(rid, str) else None
    if one is not None:
        return number_text(one)
    low, high = record.get("from"), record.get("to")
    if _is_number(low) and _is_number(high):
        return f"{number_text(low)} to {number_text(high)}"
    if _is_number(high):
        return f"below {number_text(high)}"
    if _is_number(low):
        return f"{number_text(low)} and above"
    return "all values"


def _numbers(
    c: _Counted, features: int, without_value: int, counts: list[int], other: int | None
) -> LegendNumbers:
    listed = [
        LegendClass(
            id=record.get("id") if isinstance(record.get("id"), str) else None,
            label=_label(c, record),
            count=count,
            share=round(count / features, 3) if features else 0.0,
        )
        for record, count in zip(c.classes, counts, strict=True)
    ]
    more = len(listed) - MAX_LISTED
    return LegendNumbers(
        classification=c.pointer,
        field=c.field,
        method=c.method,
        features=features,
        without_value=without_value,
        other=other,
        classes=listed[:MAX_LISTED],
        more=more if more > 0 else None,
    )


def _categories(
    c: _Counted, features: int, reply: dict[str, Any], notes: list[str]
) -> LegendNumbers:
    page, missing = reply["values"], reply["missing"]
    rows = page.get("values") if isinstance(page, dict) else None
    if not isinstance(rows, list):
        raise ValueError("no values in the answer")
    without_value = _count(missing, "count")
    index_of = class_index(c.classes)
    counts, other = [0] * len(c.classes), 0
    for row in rows:
        value, count = row.get("value"), _count(row, "count")
        if value is None:
            continue
        found = index_of(value)
        if found is None:
            other += count
        else:
            counts[found] += count
    total = page.get("total")
    cut = (
        total > len(rows)
        if isinstance(total, int) and not isinstance(total, bool)
        else len(rows) >= VALUES_LIMIT
    )
    if cut:
        notes.append(
            f"{c.pointer}: only the {VALUES_LIMIT} most frequent values of "
            f"{c.field!r} were counted, so its class counts may be low; other is "
            "the rest of the features with a value."
        )
        other = max(0, features - without_value - sum(counts))
    _check_sum(features, without_value, counts, other, notes)
    return _numbers(c, features, without_value, counts, other)


def _check_sum(
    features: int, without_value: int, counts: list[int], other: int, notes: list[str]
) -> None:
    """Notes numbers that do not add up to the feature count (the service's
    answers disagree); the numbers are kept."""
    if sum(counts) + other + without_value != features and ADDS_UP_NOT not in notes:
        notes.append(ADDS_UP_NOT)


def _classes(
    c: _Counted, features: int, reply: dict[str, Any], notes: list[str]
) -> LegendNumbers:
    bins = reply.get("bins")
    if not isinstance(bins, list):
        raise ValueError("no bins in the answer")
    without_value = _count(reply, "missing_count")
    counts, other = [0] * len(c.classes), 0
    for item in bins:
        low, high = item["range"]
        found = _numeric_index(c.classes, (float(low) + float(high)) / 2)
        if found is None:
            other += _count(item, "count")
        else:
            counts[found] += _count(item, "count")
    _check_sum(features, without_value, counts, other, notes)
    return _numbers(c, features, without_value, counts, other or None)


async def _quietly(call: Awaitable[Any]) -> Any:
    """The call's answer; None when it failed."""
    try:
        return await call
    except Exception:
        return None


async def legend_numbers(
    env: ToolEnv,
    layer: _Layer,
    query_cql: Any,
    document: dict[str, Any],
    pointers: Sequence[str] | None = None,
) -> tuple[list[LegendNumbers], str | None]:
    """The legend numbers of the stored ``document`` (the whole one, with its
    classes) under the layer's saved filter ``query_cql``, and a note on what
    is missing. ``pointers`` names the classifications to count; None counts
    the first ``MAX_COUNTED``. Never raises: a classification whose requests
    fail gets no numbers and the note says so."""
    candidates = _counted(document)
    notes: list[str] = []
    if pointers is None:
        chosen = candidates[:MAX_COUNTED]
        if len(candidates) > MAX_COUNTED:
            notes.append(
                f"Legend numbers are given for the first {MAX_COUNTED} "
                "classifications; read another one with part, e.g. part="
                f"{candidates[MAX_COUNTED].pointer!r}."
            )
    else:
        chosen = [c for c in candidates if c.pointer in pointers]
    if not chosen:
        return [], " ".join(notes) or None
    cql = saved_filter(query_cql)
    text = json.dumps(cql) if cql is not None else None
    collection = layer.layer_id

    async def asked(c: _Counted) -> dict[str, Any]:
        if c.breaks is None:
            values, missing = await asyncio.gather(
                _analytics(
                    env,
                    "unique-values",
                    {
                        "collection": collection,
                        "attribute": c.field,
                        "filter": text,
                        "limit": VALUES_LIMIT,
                        "order": "descendent",
                    },
                ),
                _analytics(
                    env,
                    "feature-count",
                    {
                        "collection": collection,
                        "filter": json.dumps(_null_filter(cql, c.field)),
                    },
                ),
            )
            return {"values": values, "missing": missing}
        reply: dict[str, Any] = await _analytics(
            env,
            "histogram",
            {
                "collection": collection,
                "column": c.field,
                "method": "custom_breaks",
                "custom_breaks": c.breaks,
                "filter": text,
            },
        )
        return reply

    counted, *replies = await asyncio.gather(
        _quietly(
            _analytics(env, "feature-count", {"collection": collection, "filter": text})
        ),
        *(_quietly(asked(c)) for c in chosen),
    )
    found: list[LegendNumbers] = []
    unavailable = False
    for c, reply in zip(chosen, replies, strict=True):
        try:
            features = _count(counted, "count")
            if not isinstance(reply, dict):
                raise ValueError("no answer")
            numbers = (
                _categories(c, features, reply, notes)
                if c.breaks is None
                else _classes(c, features, reply, notes)
            )
        except (ValueError, TypeError, KeyError, AttributeError):
            unavailable = True
            continue
        found.append(numbers)
    if unavailable:
        notes.insert(0, LEGEND_UNAVAILABLE)
    return found, " ".join(notes) or None
