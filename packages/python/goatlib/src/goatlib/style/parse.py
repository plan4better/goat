"""Pydantic validation errors as GOAT Style issues.

`parse` validates a raw document (or part of one) with a model and turns every
error into an `Issue` with the specification's code and a JSON pointer. The raw
document is only read: it is walked to name list items by their ids and to drop
the labels Pydantic adds for union branches.

Where a value can take one of several forms, Pydantic reports every form that
failed. A form the value plainly is not (it failed at the value itself) is left
out when another form failed inside the value; when every form failed at the
value itself, one line names them all.
"""

from functools import cache
from types import UnionType
from typing import Annotated, Any, Union, get_args, get_origin

from pydantic import BaseModel, Tag, TypeAdapter, ValidationError

from goatlib.style import version as versions
from goatlib.style.issues import CODES, Issue, make_issue
from goatlib.style.pointer import item_key, to_pointer
from goatlib.style.version import format_version, known_version, parse_version

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
        found = [
            _Found(error, *_walk(raw, error["loc"], error["type"]))
            for error in exc.errors(include_url=False)
        ]
        for one in _closest_forms(found):
            error, segments = one.error, one.segments
            code = _TYPE_TO_CODE.get(error["type"]) or (
                error["type"] if error["type"] in CODES else "invalid_value"
            )
            path = base_path + to_pointer(segments)
            if (code, path) in seen:
                continue
            seen.add((code, path))
            message = one.forms or _message(code, segments, error, model)
            issues.append(make_issue(code, path, message))
        return None, issues


class _Found:
    """A Pydantic error with its place in the document (`segments`) and the
    union branches its `loc` went through (`labels`: the number of segments
    before the label, and the label)."""

    def __init__(
        self, error: Any, segments: list[str], labels: list[tuple[int, Any]]
    ) -> None:
        self.error = error
        self.segments = segments
        self.labels = labels
        #: The line naming every form a value failed, set on the one kept.
        self.forms: str | None = None

    def at_branch(self) -> bool:
        """Whether the error is the branch's own: it failed at the value
        itself, not inside it."""
        return bool(self.labels) and self.labels[-1][0] == len(self.segments)

    def unions(self) -> list[tuple[Any, Any]]:
        """The unions the error went through, each as a key (the branches
        taken before it, its depth and the document path to it) and the
        branch taken."""
        return [
            ((tuple(self.labels[:n]), depth, tuple(self.segments[:depth])), label)
            for n, (depth, label) in enumerate(self.labels)
        ]


def _closest_forms(found: list[_Found]) -> list[_Found]:
    """`found` without the errors of forms the value plainly is not: an error
    at a branch is left out when another branch of the union failed inside the
    value. Where every branch failed at the value and each says what the value
    should be, the first error's line names all of them in place of the rest."""
    through: dict[Any, list[tuple[_Found, Any]]] = {}
    for one in found:
        for key, label in one.unions():
            through.setdefault(key, []).append((one, label))
    kept: list[_Found] = []
    for one in found:
        if not one.at_branch():
            kept.append(one)
            continue
        key, label = one.unions()[-1]
        siblings = [other for other, taken in through[key] if taken != label]
        if any(len(other.segments) > len(one.segments) for other in siblings):
            continue
        if any(other.forms for other in siblings):
            continue
        forms = [_form(e.error) for e in [one, *siblings]]
        if siblings and all(forms):
            one.forms = "Input should be " + _or(
                list(dict.fromkeys(f for f in forms if f))
            )
        kept.append(one)
    return kept


def _form(error: dict[str, Any]) -> str | None:
    """What a branch's error says the value should be, in JSON's words."""
    if error["type"] in ("model_type", "model_attributes_type", "dict_type"):
        return "an object"
    if error["type"] == "literal_error":
        expected = str(error.get("ctx", {}).get("expected", ""))
        return {"False": "false", "True": "true", "None": "null"}.get(
            expected, expected
        )
    message = str(error["msg"])
    prefix = "Input should be "
    return message[len(prefix) :] if message.startswith(prefix) else None


def _or(words: list[str]) -> str:
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} or {words[-1]}"


def _walk(
    raw: Any, loc: tuple[Any, ...], error_type: str
) -> tuple[list[str], list[tuple[int, Any]]]:
    segments: list[str] = []
    labels: list[tuple[int, Any]] = []
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
        else:
            # a label Pydantic adds for a union branch: not part of the document
            labels.append((len(segments), part))
    return segments, labels


#: An unknown key's message names at most this many keys of its place.
MAX_KEYS_NAMED = 20


def _keys_at(model: Any, loc: tuple[Any, ...]) -> list[str] | None:
    """The keys the object holding the last part of `loc` takes, as JSON
    writes them; None when `loc` does not lead to a model."""
    node = model
    for part in loc[:-1]:
        node = _step(node, part)
        if node is None:
            return None
    node = _unwrap(node)
    if not (isinstance(node, type) and issubclass(node, BaseModel)):
        return None
    try:
        return _schema_keys(node)
    except Exception:  # a model without a JSON Schema keeps the short message
        return None


@cache
def _schema_keys(model: type[BaseModel]) -> list[str]:
    """The keys of a model's JSON Schema: names as JSON writes them, without
    the fields a model refuses itself."""
    schema = model.model_json_schema(by_alias=True)
    if "$ref" in schema:  # a model that holds itself is one of its `$defs`
        schema = schema["$defs"][schema["$ref"].rsplit("/", 1)[-1]]
    return list(schema.get("properties", {}))


def _unwrap(node: Any) -> Any:
    """`node` without `Annotated` and without the None of an optional."""
    while True:
        if get_origin(node) is Annotated:
            node = get_args(node)[0]
        elif get_origin(node) in (Union, UnionType) and type(None) in get_args(node):
            members = [a for a in get_args(node) if a is not type(None)]
            node = members[0] if len(members) == 1 else Union[tuple(members)]
        else:
            return node


def _label(member: Any) -> Any:
    """The label Pydantic gives a union's member in an error's `loc`."""
    if get_origin(member) is Annotated:
        for meta in get_args(member)[1:]:
            if isinstance(meta, Tag):
                return meta.tag
    member = _unwrap(member)
    return member.__name__ if isinstance(member, type) else None


def _step(node: Any, part: Any) -> Any:
    """The annotation one part of an error's `loc` leads to from `node`."""
    node = _unwrap(node)
    origin = get_origin(node)
    if origin in (Union, UnionType):
        return next((m for m in get_args(node) if _label(m) == part), None)
    if isinstance(node, type) and issubclass(node, BaseModel):
        for name, field in node.model_fields.items():
            if part in (name, field.alias):
                return field.annotation
        return None
    args = get_args(node)
    if origin is list and isinstance(part, int) and args:
        return args[0]
    if origin is tuple and isinstance(part, int) and args:
        return args[0] if args[-1] is Ellipsis else args[min(part, len(args) - 1)]
    if origin is dict and len(args) == 2:
        return args[1]
    return None


#: Pydantic's bound errors: the bound's name in the error's `ctx`, and the message.
_BOUNDS = {
    "greater_than_equal": ("ge", "{v} is less than {b}, the least this takes."),
    "less_than_equal": ("le", "{v} is more than {b}, the most this takes."),
    "greater_than": ("gt", "{v} is not more than {b}; this takes values above it."),
    "less_than": ("lt", "{v} is not less than {b}; this takes values below it."),
}


def _message(code: str, segments: list[str], error: dict[str, Any], model: Any) -> str:
    key = segments[-1] if segments else ""
    if code == "unknown_key":
        # A model that refuses a key itself (`PydanticCustomError`) says why.
        if error["type"] == "unknown_key":
            return str(error["msg"])
        keys = _keys_at(model, error["loc"])
        if not keys:
            return f'"{key}" is not a key here.'
        named = ", ".join(keys[:MAX_KEYS_NAMED])
        if len(keys) > MAX_KEYS_NAMED:
            named += f" and {len(keys) - MAX_KEYS_NAMED} more"
        return f'"{key}" is not a key here. Keys here: {named}.'
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
    """Issues about `version`. The rest of a document is read only when none is an
    error: a newer patch (`newer_patch`) only warns."""
    if not isinstance(raw, dict):
        return [
            make_issue("invalid_value", "", "A GOAT Style document is a JSON object.")
        ]
    if "version" not in raw:
        return [
            make_issue("missing_required", "/version", '"version" is required here.')
        ]
    version = parse_version(raw["version"])
    if version is None:
        return [
            make_issue(
                "unknown_version", "/version", 'version is three numbers, like "1.0.0".'
            )
        ]
    if version[0] < 1:
        return [
            make_issue(
                "unknown_version", "/version", "GOAT Style versions start at 1.0.0."
            )
        ]
    spec = known_version(versions.SPEC_VERSION)
    if version <= spec:
        return []
    text = format_version(version)
    if version[:2] > spec[:2]:
        message = (
            f"This document needs GOAT Style {text} "
            f"({versions.RELEASES.get(text, 'a newer GOAT')}); "
            f"this server reads up to {versions.SPEC_VERSION}."
        )
        return [make_issue("newer_version", "/version", message)]
    message = (
        f"This document is written for GOAT Style {text}; this server reads up to "
        f"{versions.SPEC_VERSION} and may draw small differences."
    )
    return [make_issue("newer_patch", "/version", message)]


def blocking(issues: list[Issue]) -> bool:
    """Whether `check_version`'s issues stop the rest of a document from being read."""
    return any(i.level == "error" for i in issues)


def as_read(raw: Any) -> Any:
    """`raw` with the integer version 1 of documents written before three
    numbers as the "1.0.0" it means; anything else as it is. `raw` is not changed."""
    if (
        isinstance(raw, dict)
        and type(raw.get("version")) is int
        and raw["version"] == 1
    ):
        return {**raw, "version": versions.BASE_VERSION}
    return raw


def parse_for_write(raw: Any) -> tuple[Any, list[Issue]]:
    """A layer style as it is written: strict, versions this server reads only.
    `raw` is not changed."""
    from goatlib.style.models.layer import LayerStyle

    issues = check_version(raw)
    if blocking(issues):
        return None, issues
    style, more = parse(LayerStyle, as_read(raw))
    return style, issues + more


def parse_map_document(raw: Any) -> tuple[Any, list[Issue]]:
    from goatlib.style.models.map_document import MapDocument

    issues = check_version(raw)
    if blocking(issues):
        return None, issues
    document, more = parse(MapDocument, as_read(raw))
    return document, issues + more
