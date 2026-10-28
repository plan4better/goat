"""Pydantic validation errors as GOAT Style issues.

`parse` validates a raw document (or part of one) with a model and turns every
error into an `Issue` with the specification's code and a JSON pointer. The raw
document is only read: it is walked to name list items by their ids and to drop
the labels Pydantic adds for union branches.
"""

from typing import Any

from pydantic import TypeAdapter, ValidationError

from goatlib.style.issues import CODES, Issue, make_issue
from goatlib.style.pointer import item_key, to_pointer

CURRENT_VERSION = 1

_TYPE_TO_CODE = {"extra_forbidden": "unknown_key", "missing": "missing_required"}
_ADAPTERS: dict[Any, TypeAdapter[Any]] = {}


def _adapter(model: Any) -> TypeAdapter[Any]:
    try:
        if model not in _ADAPTERS:
            _ADAPTERS[model] = TypeAdapter(model)
        return _ADAPTERS[model]
    except TypeError:  # an unhashable annotation
        return TypeAdapter(model)


#: Deeper documents are refused before anything walks them (the deepest real
#: structure, a classification's part override by zoom, is about 10 levels).
MAX_DEPTH = 64


def too_deep(raw: Any) -> list[str] | None:
    """The path to the first node deeper than `MAX_DEPTH`, or None."""
    stack: list[tuple[Any, list[str]]] = [(raw, [])]
    while stack:
        node, path = stack.pop()
        if len(path) > MAX_DEPTH:
            return path
        if isinstance(node, dict):
            stack.extend((v, path + [str(k)]) for k, v in node.items())
        elif isinstance(node, list):
            stack.extend((v, path + [str(i)]) for i, v in enumerate(node))
    return None


def parse(model: Any, raw: Any, *, base_path: str = "") -> tuple[Any, list[Issue]]:
    """Validate `raw` with a model class or annotation; issues instead of exceptions.

    The models are strict about JSON types (`models/base.py`), because the caller
    stores `raw` itself, not what a lax parse would make of it.
    """
    deep = too_deep(raw)
    if deep is not None:
        return None, [
            make_issue(
                "invalid_value",
                base_path + to_pointer(deep[:8]),
                f"A document nests at most {MAX_DEPTH} levels deep.",
            )
        ]
    try:
        return _adapter(model).validate_python(raw), []
    except ValidationError as exc:
        issues: list[Issue] = []
        seen: set[tuple[str, str]] = set()
        for error in exc.errors(include_url=False):
            code = _TYPE_TO_CODE.get(error["type"]) or (
                error["type"] if error["type"] in CODES else "invalid_value"
            )
            segments = _segments(raw, error["loc"], error["type"])
            path = base_path + to_pointer(segments)
            if (code, path) in seen:
                continue
            seen.add((code, path))
            issues.append(make_issue(code, path, _message(code, segments, error)))
        return None, issues


def _segments(raw: Any, loc: tuple[Any, ...], error_type: str) -> list[str]:
    segments: list[str] = []
    node = raw
    for i, part in enumerate(loc):
        last = i == len(loc) - 1
        if isinstance(node, list) and isinstance(part, int):
            item = node[part] if 0 <= part < len(node) else None
            segments.append(item_key(item, part))
            node = item
        elif isinstance(node, dict) and isinstance(part, str) and part in node:
            segments.append(part)
            node = node[part]
        elif last and error_type == "missing" and isinstance(part, str):
            segments.append(part)
        # anything else is a label Pydantic adds for a union branch: not part of the document
    return segments


#: Pydantic's bound errors: the bound's name in the error's `ctx`, and the message.
_BOUNDS = {
    "greater_than_equal": ("ge", "{v} is less than {b}, the least this takes."),
    "less_than_equal": ("le", "{v} is more than {b}, the most this takes."),
    "greater_than": ("gt", "{v} is not more than {b}; this takes values above it."),
    "less_than": ("lt", "{v} is not less than {b}; this takes values below it."),
}


def _message(code: str, segments: list[str], error: dict[str, Any]) -> str:
    key = segments[-1] if segments else ""
    if code == "unknown_key":
        return f'"{key}" is not a key here.'
    if code == "missing_required":
        return f'"{key}" is required here.'
    if error["type"] in _BOUNDS:
        bound, message = _BOUNDS[error["type"]]
        return message.format(v=_number(error["input"]), b=_number(error["ctx"][bound]))
    return str(error["msg"])


def _number(v: Any) -> str:
    """A number as JSON writes it: 359.0 is 359."""
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)


def check_version(raw: Any) -> list[Issue]:
    """Issues about `version`; the rest of a document is read only when there are none."""
    if not isinstance(raw, dict):
        return [
            make_issue("invalid_value", "", "A GOAT Style document is a JSON object.")
        ]
    if "version" not in raw:
        return [
            make_issue("missing_required", "/version", '"version" is required here.')
        ]
    version = raw["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return [
            make_issue(
                "unknown_version", "/version", "version is a whole number from 1."
            )
        ]
    if version > CURRENT_VERSION:
        return [
            make_issue(
                "newer_version",
                "/version",
                f"This server reads GOAT Style up to version {CURRENT_VERSION}.",
            )
        ]
    return []


def parse_for_write(raw: Any) -> tuple[Any, list[Issue]]:
    """A layer style as it is written: strict, current version only. `raw` is not changed."""
    from goatlib.style.models.layer import LayerStyle

    issues = check_version(raw)
    if issues:
        return None, issues
    return parse(LayerStyle, raw)


def parse_map_document(raw: Any) -> tuple[Any, list[Issue]]:
    from goatlib.style.models.map_document import MapDocument

    issues = check_version(raw)
    if issues:
        return None, issues
    return parse(MapDocument, raw)
