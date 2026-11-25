"""Edit operations (the specification's section 20): how the AI changes a document.

An edit is one of the section 11 fix operations or `add` and `move` on an id list.
`apply_edits` applies a list of them in order, all or none, and returns a new
document whose ids are complete and unique. Validating the result is the
server's check. A refusal's reason is written for the model that sent the edits:
it names what exists, so the next call can be right.
"""

import copy
import json
import re
from collections import Counter
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Sequence

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    WithJsonSchema,
    model_validator,
)

from goatlib.style.ids import assign_ids, existing_ids
from goatlib.style.issues import Fix
from goatlib.style.merge import _class_skip, _is_id_list
from goatlib.style.ops import apply_fix
from goatlib.style.pointer import find_index, item_key, parse_pointer, to_pointer

Op = Literal["set", "remove", "retarget", "use_field", "round", "add", "move"]

ID_LISTS: tuple[str, ...] = (
    "/classify",
    "/classify/<id>/classes",
    "/rules",
    "/popup/blocks",
    "/render/classify/classes",
)

_ID = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_FIXED = ("version", "kind")
_NOUNS = {"classify": "classification", "rules": "rule", "blocks": "popup block"}

COMPUTED = (
    "The server writes every computed object, and edits never contain computed; "
    "leave it out."
)
CLASSES_COMPUTED = "The server computes the classes of this classification. Write its method and count."
FIXED = "/version and /kind are not edited: the server stamps the version, and a style keeps its kind."
ID_KEPT = "An item keeps its id; edit its other keys, or add a new item."

# What each operation reads besides `op` and `path`; the first is required.
_FIELDS: dict[str, tuple[str, ...]] = {
    "set": ("value",),
    "remove": (),
    "round": (),
    "retarget": ("target",),
    "use_field": ("field",),
    "add": ("item", "after"),
    "move": ("after",),
}
_NEEDS = {
    "set": "give the new value, or use remove to delete the key",
    "retarget": "the part.key the classification fills, for example outline.color",
    "use_field": "the name of the field to use",
    "add": "the new item as an object",
}


def _object_text(value: Any) -> Any:
    """An object the model sent as JSON text, sometimes encoded twice, as the
    object; anything else unchanged."""
    decoded = value
    for _ in range(2):
        if not isinstance(decoded, str):
            break
        try:
            decoded = json.loads(decoded)
        except ValueError:
            return value
    return decoded if isinstance(decoded, dict) else value


class Edit(BaseModel):
    """One change to a style document."""

    model_config = ConfigDict(extra="forbid")

    op: Op = Field(
        description=(
            "set: write a value, creating missing objects on the way. remove: delete a "
            "key or list item. add: put a new item into an id list (classifications, "
            "their classes, rules, popup blocks, raster classes). move: change the "
            "place of an item in its id list. retarget: point a classification at "
            "another property. use_field: replace a field reference. round: round a "
            "zoom to a whole number. Example: set."
        )
    )
    path: str = Field(
        max_length=200,
        description=(
            "JSON pointer to what the operation changes; a list item with an id is "
            "named by its id, for example /classify/density/palette. add takes the "
            "list itself, for example /rules; move takes the item, for example "
            "/rules/r2."
        ),
    )
    value: Annotated[
        Any,
        WithJsonSchema(
            {
                "anyOf": [
                    {"type": "string"},
                    {"type": "number"},
                    {"type": "boolean"},
                    {"type": "object"},
                    {"type": "array"},
                    {"type": "null"},
                ],
                "description": (
                    "set only: the new value, any JSON; null is a value. Example: "
                    '"#d73027".'
                ),
                "default": None,
            }
        ),
    ] = None
    target: str | None = Field(
        default=None,
        description=(
            "retarget only: the property the classification fills, as part.key. "
            "Example: outline.color."
        ),
    )
    field: str | None = Field(
        default=None,
        description=(
            "use_field only: the name of the field that replaces the reference. "
            "Example: land_use."
        ),
    )
    item: dict[str, Any] | None = Field(
        default=None,
        description=(
            "add only: the new item; leave id out and one is given. Example: "
            '{"field": "density", "method": "quantile", "count": 5, '
            '"palette": "colorbrewer:OrRd"}.'
        ),
    )
    after: str | None = Field(
        default=None,
        description=(
            "add and move: the id of the item in the same list that this item "
            "follows. Example: r1. Null puts a moved item first and an added one last."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _decode(cls, data: Any) -> Any:
        """An edit, item or object value sent as JSON text is read as the object."""
        data = _object_text(data)
        if isinstance(data, dict):
            data = dict(data)
            for key in ("item", "value"):
                if key in data:
                    data[key] = _object_text(data[key])
        return data

    @model_validator(mode="after")
    def _fields_of_the_op(self) -> "Edit":
        reads = _FIELDS[self.op]
        if reads and reads[0] != "after":
            needed = reads[0]
            missing = (
                needed not in self.model_fields_set
                if needed == "value"
                else getattr(self, needed) in (None, "")
            )
            if missing:
                raise ValueError(
                    f"Operation {self.op} needs {needed}: {_NEEDS[self.op]}."
                )
        for name in ("value", "target", "field", "item", "after"):
            if name not in reads and getattr(self, name) is not None:
                fields = ", ".join(("path", *reads))
                raise ValueError(
                    f"Operation {self.op} takes no {name}; it reads {fields}."
                )
        return self


class EditError(ValueError):
    """An operation that cannot be applied; `index` counts from 0."""

    def __init__(self, index: int, reason: str) -> None:
        super().__init__(f"Operation {index + 1}: {reason}")
        self.index = index
        self.reason = reason


@dataclass(frozen=True)
class Edited:
    document: dict[str, Any]
    added: dict[int, str]


class _RefusalError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def apply_edits(document: dict[str, Any], edits: Sequence[Edit]) -> Edited:
    """`document` with every edit applied, in order. Raises EditError, and
    applies nothing, when one cannot be applied."""
    doc = assign_ids(document)
    added: dict[int, str] = {}
    for index, edit in enumerate(edits):
        before = _id_counts(doc)
        try:
            doc, new_id = _apply(doc, edit)
            doc = assign_ids(doc)
            _no_new_duplicate(before, _id_counts(doc))
        except _RefusalError as refusal:
            raise EditError(index, refusal.reason) from None
        if new_id is not None:
            added[index] = _id_at(doc, new_id)
    return Edited(document=doc, added=added)


# One operation. Each works on `doc` in place (it is the call's own copy) and
# returns the document; `add` also returns where the new item is.


def _apply(doc: dict[str, Any], edit: Edit) -> tuple[dict[str, Any], Any]:
    segments = _segments(edit.path)
    if edit.op == "set":
        _no_computed_inside(edit.value)
        _set(doc, segments, edit.value)
    elif edit.op == "remove":
        _remove(doc, segments)
    elif edit.op == "add":
        _no_computed_inside(edit.item)
        return doc, _add(doc, segments, edit.item or {}, edit.after)
    elif edit.op == "move":
        _move(doc, segments, edit.after)
    else:
        doc = _fix(doc, segments, edit)
    return doc, None


def _set(doc: dict[str, Any], segments: list[str], value: Any) -> None:
    node, at = _walk(doc, segments, create=True)
    last = segments[-1]
    _check_last(doc, node, at, last)
    value = copy.deepcopy(value)
    if isinstance(node, dict):
        node[last] = value
        return
    index = find_index(node, last)
    if index is None:
        if _is_id_list(tuple(at)):
            raise _RefusalError(
                f"{_missing_item(node, at, last)[:-1]}; add a new item with the add "
                "operation."
            )
        raise _RefusalError(_missing_item(node, at, last))
    old = node[index]
    if _is_id_list(tuple(at)) and isinstance(value, dict) and isinstance(old, dict):
        value.pop("id", None)
        if isinstance(old.get("id"), str):
            value = {"id": old["id"], **value}
    node[index] = value


def _remove(doc: dict[str, Any], segments: list[str]) -> None:
    node, at = _walk(doc, segments, create=False)
    last = segments[-1]
    _check_last(doc, node, at, last)
    del node[_existing(node, at, last)]


def _add(
    doc: dict[str, Any], segments: list[str], item: dict[str, Any], after: str | None
) -> tuple[str, ...]:
    node, at = _walk(doc, segments, create=True)
    last = segments[-1]
    list_path = (*at, last)
    if not isinstance(node, dict) or not _is_id_list(list_path):
        raise _RefusalError(
            f"add takes the path of an id list ({', '.join(ID_LISTS)}), not "
            f"{to_pointer(segments)}."
        )
    if node.get(last) is None:
        node[last] = []
    items = node[last]
    if not isinstance(items, list):
        raise _RefusalError(
            f"{to_pointer(list(list_path))} holds {_shown(items)}, not a list."
        )
    _check_brought_ids(doc, item)
    position = (
        len(items) if after is None else _position_of(items, list_path, after) + 1
    )
    items.insert(position, copy.deepcopy(item))
    return (*list_path, str(position))


def _move(doc: dict[str, Any], segments: list[str], after: str | None) -> None:
    node, at = _walk(doc, segments, create=False)
    if not isinstance(node, list) or not _is_id_list(tuple(at)):
        raise _RefusalError(
            f"move takes the path of an item of an id list ({', '.join(ID_LISTS)}), "
            "for example /rules/r1."
        )
    index = _existing(node, at, segments[-1])
    if after is not None:
        if item_key(node[index], index) == after:
            raise _RefusalError(
                f"An item cannot follow itself; give after the id of another "
                f"{_noun(at)} of {to_pointer(at)}, or null to put it first."
            )
        _position_of(node, tuple(at), after)
    item = node.pop(index)
    position = 0 if after is None else _position_of(node, tuple(at), after) + 1
    node.insert(position, item)


def _fix(doc: dict[str, Any], segments: list[str], edit: Edit) -> dict[str, Any]:
    """retarget, use_field and round, as the issue fixes apply them."""
    node, at = _walk(doc, segments, create=False)
    last = segments[-1]
    _check_last(doc, node, at, last)
    # Each replaces what is there: use_field a field reference, which a key
    # that is not there does not hold.
    index = _existing(node, at, last)
    if edit.op == "round":
        value = node[index]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _RefusalError(
                f"round takes a number, and {edit.path} holds {_shown(value)}."
            )
    fix = Fix(op=edit.op, path=edit.path, target=edit.target, field=edit.field)
    try:
        fixed: dict[str, Any] = apply_fix(doc, fix)
    except ValueError as exc:
        raise _RefusalError(f"{exc}.") from None
    return fixed


# Paths


def _segments(path: str) -> list[str]:
    if not path.startswith("/"):
        raise _RefusalError(
            "A path is a JSON pointer inside the document, for example /opacity."
        )
    segments: list[str] = parse_pointer(path)
    if segments == [""]:
        raise _RefusalError(
            "A path names a key inside the document, for example /opacity."
        )
    if segments[0] in _FIXED:
        raise _RefusalError(FIXED)
    return segments


def _walk(
    doc: dict[str, Any], segments: list[str], *, create: bool
) -> tuple[Any, list[str]]:
    """The container of the path's last segment, and the path to it with ids for
    id-list items. `create` makes missing objects on the way (never a list)."""
    node: Any = doc
    at: list[str] = []
    for segment in segments[:-1]:
        if isinstance(node, dict):
            _check_key(doc, at, segment)
            child = node.get(segment)
            if child is None and _is_id_list((*at, segment)):
                raise _RefusalError(
                    f"{to_pointer([*at, segment])} has no items yet; add one with the "
                    "add operation."
                )
            if child is None and create:
                child = node[segment] = {}
            elif segment not in node:
                raise _RefusalError(_missing_key(node, at, segment))
            key = segment
        else:
            index = find_index(node, segment)
            if index is None:
                raise _RefusalError(_missing_item(node, at, segment))
            child = node[index]
            key = item_key(child, index)
        at.append(key)
        if not isinstance(child, (dict, list)):
            raise _RefusalError(
                f"{to_pointer(at)} holds {_shown(child)}, not an object or a list, so "
                f"nothing lies under it; set {to_pointer(at)} whole instead."
            )
        node = child
    return node, at


def _check_last(doc: dict[str, Any], node: Any, at: list[str], last: str) -> None:
    """Refuses a last segment that names a value the server writes or an id."""
    if isinstance(node, dict):
        _check_key(doc, at, last, last=True)


def _check_key(
    doc: dict[str, Any], at: list[str], key: str, *, last: bool = False
) -> None:
    """Refuses a key of the object at `at` that holds a value the server writes
    or, as the path's last segment, an item's id."""
    if key == "computed":
        raise _RefusalError(COMPUTED)
    if len(at) < 2 or not _is_id_list(tuple(at[:-1])):
        return
    if last and key == "id":
        raise _RefusalError(ID_KEPT)
    if at[-2] == "classes" and key in _class_skip(_get(doc, at[:-2])):
        raise _RefusalError(CLASSES_COMPUTED)


def _existing(node: Any, at: list[str], last: str) -> Any:
    """The key or index of an existing last segment."""
    if isinstance(node, dict):
        if last not in node:
            raise _RefusalError(_missing_key(node, at, last))
        return last
    index = find_index(node, last)
    if index is None:
        raise _RefusalError(_missing_item(node, at, last))
    return index


def _get(doc: Any, segments: list[str]) -> Any:
    node = doc
    for segment in segments:
        if isinstance(node, dict):
            node = node.get(segment)
        elif isinstance(node, list):
            index = find_index(node, segment)
            node = node[index] if index is not None else None
    return node


def _id_at(doc: dict[str, Any], where: tuple[str, ...]) -> str:
    """The id of the item an `add` placed (`where` ends with its index)."""
    items = _get(doc, list(where[:-1]))
    return str(items[int(where[-1])]["id"])


# Ids


def _check_brought_ids(doc: dict[str, Any], item: dict[str, Any]) -> None:
    taken = existing_ids(doc)
    brought = _ids_in(item)
    for value, count in Counter(brought).items():
        if not _ID.match(value):
            raise _RefusalError(
                f"The id {value!r} is not valid (a lowercase letter, then up to 31 "
                "lowercase letters, digits or _); leave id out and one is given."
            )
        if value in taken:
            raise _RefusalError(
                f"The id {value!r} is taken in this document; leave id out and one "
                "is given."
            )
        if count > 1:
            raise _RefusalError(
                f"The id {value!r} is used twice in the item; leave id out and one "
                "is given."
            )


def _ids_in(node: Any) -> list[str]:
    found: list[str] = []
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            if isinstance(n.get("id"), str):
                found.append(n["id"])
            stack.extend(v for v in n.values() if isinstance(v, (dict, list)))
        elif isinstance(n, list):
            stack.extend(n)
    return found


def _id_counts(doc: Any) -> Counter[str]:
    return Counter(_ids_in(doc))


def _no_new_duplicate(before: Counter[str], after: Counter[str]) -> None:
    for value, count in after.items():
        if count > 1 and count > before.get(value, 0):
            raise _RefusalError(
                f"The id {value!r} would be used twice in this document; leave id out "
                "and one is given."
            )


def _no_computed_inside(value: Any) -> None:
    stack = [value]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            if "computed" in n:
                raise _RefusalError(COMPUTED)
            stack.extend(n.values())
        elif isinstance(n, list):
            stack.extend(n)


def _position_of(items: list[Any], list_path: tuple[str, ...], after: str) -> int:
    for index, item in enumerate(items):
        if isinstance(item, dict) and item.get("id") == after:
            return index
    raise _RefusalError(
        f"{to_pointer(list(list_path))} has no {_noun(list(list_path))} {after!r} to "
        f"follow; {_ids_sentence(items)}."
    )


# Messages


def _noun(at: list[str] | tuple[str, ...]) -> str:
    return _NOUNS.get(at[-1], "class") if at else "item"


def _ids_sentence(items: list[Any]) -> str:
    ids = [item_key(item, i) for i, item in enumerate(items)]
    if not ids:
        return "the list is empty"
    return f"its ids are: {', '.join(ids)}"


def _missing_item(items: list[Any], at: list[str], segment: str) -> str:
    where = to_pointer(at)
    if _is_id_list(tuple(at)):
        return f"{where} has no {_noun(at)} {segment!r}; {_ids_sentence(items)}."
    if not items:
        return f"{where} has no item {segment!r}; the list is empty."
    return (
        f"{where} has no item {segment!r}; it has {len(items)} items, numbered 0 to "
        f"{len(items) - 1}."
    )


def _missing_key(node: dict[str, Any], at: list[str], key: str) -> str:
    where = to_pointer(at) or "The document"
    if not node:
        return f"{where} has no key {key!r}; it is empty."
    keys = list(node)
    shown = ", ".join(keys[:30]) + (", ..." if len(keys) > 30 else "")
    return f"{where} has no key {key!r}; its keys are: {shown}."


def _shown(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 40 else text[:37] + "..."
