"""The limits of a layer filter (`data/operators.json`) and `measure`.

The web reads the same table, so the panel and the services stop at the same
place. A stored filter over a limit still loads; only a new save is refused
(see `goatlib.filter.validate`). The request ceilings below are this module's
own: what a single request may carry, checked on every request.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass
from importlib import resources
from typing import Any
from urllib.parse import quote

from goatlib.filter import cql

TABLE: dict[str, Any] = json.loads(
    resources.files("goatlib.filter")
    .joinpath("data", "operators.json")
    .read_text(encoding="utf-8")
)
_LIMITS: dict[str, int] = TABLE["limits"]

MAX_CONDITIONS: int = _LIMITS["conditions"]
MAX_VALUES: int = _LIMITS["values"]
MAX_DEPTH: int = _LIMITS["depth"]
MAX_SHAPES: int = _LIMITS["shapes"]
#: The features one area may be made of (areas come in step 2; nothing measures it yet).
MAX_FEATURES: int = _LIMITS["features"]
MAX_POINTS: int = _LIMITS["points"]
#: The characters of the filter in a map request's URL (`url_length`): a
#: filter travels in the request, and proxies refuse a URL past their limit.
MAX_LENGTH: int = _LIMITS["length"]
# What encodeURIComponent leaves as it is.
_URL_SAFE = "-_.!~*'()"

#: The request ceilings: what one request may carry at most. They protect the
#: services, lie well above the save limits so no saved filter is refused, and
#: are not product rules, so the web does not read them. The depth ceiling is the
#: save limit: the parser recurses once per level.
REQUEST_MAX_CONDITIONS = 200
REQUEST_MAX_VALUES = 1000
REQUEST_MAX_SHAPES = 20
REQUEST_MAX_POINTS = 20000
REQUEST_MAX_DEPTH = MAX_DEPTH


@dataclass(frozen=True)
class Measure:
    """What a filter holds, against the limits.

    `conditions` counts the conditions a person sees as rows: comparisons on one
    field joined by one `and` or `or` (a value list written as alternatives, a
    range) count once, and the empty alternative of a negation (`x <> v or x is
    null`) is not counted. Areas are not conditions. `max_values` is the most
    values one condition holds, `depth` the logical nesting (`cql.depth`),
    `shapes` the geometries, `max_points` the most positions one geometry has,
    and `bytes` the size of the filter as compact UTF-8 JSON.
    """

    conditions: int
    max_values: int
    depth: int
    shapes: int
    max_points: int
    bytes: int


def _scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _compared_field(node: Any) -> str | None:
    """The field of a comparison with a single value, else None."""
    if not isinstance(node, dict) or node.get("op") not in (
        cql.COMPARE + cql.LEGACY_COMPARE
    ):
        return None
    args = node.get("args")
    if not isinstance(args, list) or len(args) != 2:
        return None
    first = args[0]
    if not isinstance(first, dict) or set(first) != {"property"}:
        return None
    value = args[1]
    if not (_scalar(value) or (isinstance(value, dict) and len(value) == 1)):
        return None
    return first["property"] if isinstance(first["property"], str) else None


def _null_field(node: Any) -> str | None:
    if not isinstance(node, dict) or node.get("op") != "isNull":
        return None
    args = node.get("args")
    prop = args[0] if isinstance(args, list) and len(args) == 1 else args
    if isinstance(prop, dict) and isinstance(prop.get("property"), str):
        return prop["property"]
    return None


def _without_empty_alternative(
    args: list[tuple[int, Any]],
) -> list[tuple[int, Any]]:
    """An `or`'s (index, arg) pairs without `isNull(x)` where another arg reads `x`."""
    read: set[str] = set()
    for _, a in args:
        if _null_field(a) is None:
            read |= cql.fields_of(a)
    return [(i, a) for i, a in args if _null_field(a) not in read]


def _values(node: dict[str, Any]) -> int:
    args = node.get("args")
    if node.get("op") == "in" and isinstance(args, list) and len(args) == 2:
        return len(args[1]) if isinstance(args[1], list) else 1
    if node.get("op") == "isNull":
        return 0
    return 1


def _positions(coordinates: Any) -> int:
    """Positions in a GeoJSON `coordinates` array."""
    count = 0
    stack = [coordinates]
    while stack:
        item = stack.pop()
        if not isinstance(item, list):
            continue
        if item and isinstance(item[0], (int, float)):
            count += 1
        else:
            stack.extend(item)
    return count


def _size(value: Any) -> int:
    """Bytes of `value` as compact UTF-8 JSON, counted without recursion."""
    return _walk(value, _size_scalar, 1)


def _walk(value: Any, scalar: Callable[[Any], int], punctuation: int) -> int:
    """`value` as compact JSON, counted without recursion: `scalar` counts a
    key or value, each brace, bracket, comma and colon counts `punctuation`."""
    total = 0
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            # braces, commas, colons
            total += punctuation * (2 + max(len(item) - 1, 0) + len(item))
            for k, v in item.items():
                total += scalar(str(k))
                stack.append(v)
        elif isinstance(item, (list, tuple)):
            total += punctuation * (2 + max(len(item) - 1, 0))
            stack.extend(item)
        else:
            total += scalar(item)
    return total


def _size_scalar(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _url_scalar(value: Any) -> int:
    return len(quote(json.dumps(value, ensure_ascii=False), safe=_URL_SAFE))


def _segment(key: Any) -> str:
    return "/" + str(key).replace("~", "~0").replace("/", "~1")


def parts(cql_filter: Any) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    """The filter's conditions as (JSON pointer, values) and its geometries as
    (JSON pointer, positions), counted as `Measure` describes."""
    conditions: list[tuple[str, int]] = []
    shapes: list[tuple[str, int]] = []
    stack: list[tuple[Any, str]] = [(cql_filter, "")]
    while stack:
        node, path = stack.pop()
        if isinstance(node, list):
            stack.extend((v, path + _segment(i)) for i, v in enumerate(node))
            continue
        if not isinstance(node, dict):
            continue
        if cql.is_geometry(node):
            bbox = len(node) == 1 and "bbox" in node
            shapes.append((path, 5 if bbox else _positions(node["coordinates"])))
            continue
        op, args = node.get("op"), node.get("args")
        if op in ("and", "or") and isinstance(args, list):
            indexed = list(enumerate(args))
            group = _without_empty_alternative(indexed) if op == "or" else indexed
            fields = {_compared_field(a) for _, a in group}
            if len(group) > 1 and len(fields) == 1 and None not in fields:
                conditions.append((path, len(group)))
            else:
                stack.extend((a, f"{path}/args/{i}") for i, a in group)
            continue
        if op == "not" or op in cql.SPATIAL or "op" not in node:
            stack.extend(
                (v, path + _segment(k))
                for k, v in node.items()
                if isinstance(v, (dict, list))
            )
            continue
        conditions.append((path, _values(node)))
    return conditions, shapes


def measure(cql_filter: Any) -> Measure:
    """The filter's `Measure`; anything that is not a filter measures as nothing."""
    conditions, shapes = parts(cql_filter)
    return Measure(
        conditions=len(conditions),
        max_values=max((n for _, n in conditions), default=0),
        depth=cql.depth(cql_filter),
        shapes=len(shapes),
        max_points=max((n for _, n in shapes), default=0),
        bytes=_size(cql_filter),
    )


def url_length(cql_filter: Any) -> int:
    """The characters of the filter as a URL parameter: compact JSON as the web
    writes it, percent-encoded as `encodeURIComponent` encodes it (each brace,
    bracket, comma and colon as three). Counted without recursion."""
    return _walk(cql_filter, _url_scalar, 3)
