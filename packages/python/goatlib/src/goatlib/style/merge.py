"""Diff and merge of GOAT Style documents (the specification's section 13.1).

- Objects merge key by key; on the same path the last write wins.
- Lists whose items carry ids (classifications, classes, rules, popup blocks)
  merge item by item; an item one side removed stays removed. Every other list
  is one value.
- What the server computes is never part of a diff: `computed` objects, `issues`,
  and the class bounds and values of a computed classification.

The same rules run in the browser (TypeScript) on `tests/.../merge_cases.json`.
"""

import copy
from dataclasses import dataclass
from typing import Any, Union

from goatlib.style.ids import assign_ids, existing_ids
from goatlib.style.issues import Issue
from goatlib.style.pointer import parse_pointer, to_pointer

Path = tuple[str, ...]
_MISSING = object()


@dataclass(frozen=True)
class SetChange:
    path: Path
    value: Any


@dataclass(frozen=True)
class RemoveChange:
    path: Path


@dataclass(frozen=True)
class PlaceChange:
    """An item of an id-keyed list placed after the nearest of `after` that still exists.

    `after` lists the ids before the item in the author's list, nearest first;
    none surviving places it first. `item` carries an added item's content (an
    item that already exists keeps its content and only moves: a retried save
    changes nothing); None moves an item that exists.
    """

    list_path: Path
    item_id: str
    after: tuple[str, ...]
    item: Any = None


Change = Union[SetChange, RemoveChange, PlaceChange]


def _is_id_list(path: Path) -> bool:
    return (
        path == ("classify",)
        or path == ("rules",)
        or path == ("popup", "blocks")
        or path == ("render", "classify", "classes")
        or (len(path) == 3 and path[0] == "classify" and path[2] == "classes")
    )


def _all_ids(items: list[Any]) -> bool:
    ids = [i.get("id") for i in items if isinstance(i, dict)]
    return (
        len(ids) == len(items)
        and all(isinstance(i, str) for i in ids)
        and len(set(ids)) == len(ids)
    )


def _class_skip(classification: Any) -> frozenset[str]:
    """Keys of class records the server writes for this classification."""
    if not isinstance(classification, dict):
        return frozenset()
    method = classification.get("method")
    skip: set[str] = set()
    if method is not None and method not in ("manual", "categories"):
        skip |= {"from", "to"}
    if method == "categories" and "count" in classification:
        skip.add("values")
    return frozenset(skip)


def diff(base: dict[str, Any], new: dict[str, Any]) -> list[Change]:
    """What changed from `base` to `new`, without server-owned values."""
    out: list[Change] = []
    _diff_dict(base, new, (), out, frozenset({"issues"}))
    return out


def _diff_dict(
    base: dict[str, Any],
    new: dict[str, Any],
    path: Path,
    out: list[Change],
    skip: frozenset[str],
) -> None:
    for key in base:
        if key not in new and key not in skip and key != "computed":
            out.append(RemoveChange(path + (key,)))
    for key, nv in new.items():
        if key in skip or key == "computed":
            continue
        bv = base.get(key, _MISSING)
        child = path + (key,)
        if bv is _MISSING:
            out.append(SetChange(child, copy.deepcopy(nv)))
        elif nv == bv:
            continue
        elif isinstance(nv, dict) and isinstance(bv, dict):
            _diff_dict(bv, nv, child, out, frozenset())
        elif (
            isinstance(nv, list)
            and isinstance(bv, list)
            and _is_id_list(child)
            and _all_ids(bv)
            and _all_ids(nv)
        ):
            item_skip = _class_skip(new if key == "classes" else None)
            if child == ("render", "classify", "classes"):
                item_skip = _class_skip(new)
            _diff_list(bv, nv, child, out, item_skip)
        else:
            out.append(SetChange(child, copy.deepcopy(nv)))


def _diff_list(
    base: list[Any],
    new: list[Any],
    path: Path,
    out: list[Change],
    item_skip: frozenset[str],
) -> None:
    base_items = {i["id"]: i for i in base}
    new_ids = [i["id"] for i in new]
    for item_id in base_items:
        if item_id not in new_ids:
            out.append(RemoveChange(path + (item_id,)))
    common_base = [i for i in base_items if i in new_ids]
    base_pred = {
        item_id: (common_base[j - 1] if j else None)
        for j, item_id in enumerate(common_base)
    }
    before: list[str] = []
    prev_common: str | None = None
    for item in new:
        item_id = item["id"]
        after = tuple(reversed(before))
        if item_id not in base_items:
            out.append(PlaceChange(path, item_id, after, copy.deepcopy(item)))
        else:
            if base_pred[item_id] != prev_common:
                out.append(PlaceChange(path, item_id, after))
            _diff_dict(base_items[item_id], item, path + (item_id,), out, item_skip)
            prev_common = item_id
        before.append(item_id)


def _find(items: list[Any], item_id: str) -> int | None:
    for i, item in enumerate(items):
        if isinstance(item, dict) and item.get("id") == item_id:
            return i
    return None


def _navigate(doc: Any, segments: Path, create: bool) -> Any:
    """The node at `segments`; with `create`, missing objects on the way are made.

    A missing id-keyed list or list item is never made: what the other side
    removed stays removed.
    """
    node = doc
    for depth, seg in enumerate(segments):
        if isinstance(node, dict):
            if seg not in node:
                if not create or _is_id_list(segments[: depth + 1]):
                    return _MISSING
                node[seg] = {}
            node = node[seg]
        elif isinstance(node, list):
            index = _find(node, seg)
            if index is None:
                return _MISSING
            node = node[index]
        else:
            return _MISSING
    return node


def _apply_one(doc: dict[str, Any], change: Change) -> bool:
    if isinstance(change, SetChange):
        parent = _navigate(doc, change.path[:-1], create=True)
        key = change.path[-1]
        if isinstance(parent, dict):
            parent[key] = copy.deepcopy(change.value)
            return True
        if isinstance(parent, list):
            index = _find(parent, key)
            if index is None:
                return False
            parent[index] = copy.deepcopy(change.value)
            return True
        return False
    if isinstance(change, RemoveChange):
        parent = _navigate(doc, change.path[:-1], create=False)
        key = change.path[-1]
        if isinstance(parent, dict):
            parent.pop(key, None)
        elif isinstance(parent, list):
            index = _find(parent, key)
            if index is not None:
                parent.pop(index)
        return True
    items = _navigate(doc, change.list_path, create=False)
    if items is _MISSING and change.item is not None:
        parent = _navigate(doc, change.list_path[:-1], create=True)
        if not isinstance(parent, dict):
            return False
        items = parent[change.list_path[-1]] = []
    if not isinstance(items, list):
        return False
    index = _find(items, change.item_id)
    if index is None and change.item is None:
        return False
    item = items.pop(index) if index is not None else copy.deepcopy(change.item)
    position = 0
    for pred in change.after:
        found = _find(items, pred)
        if found is not None:
            position = found + 1
            break
    items.insert(position, item)
    return True


def apply(
    doc: dict[str, Any], changes: list[Change]
) -> tuple[dict[str, Any], list[Change]]:
    """`doc` with the changes applied (a copy) and the changes whose target is gone."""
    out = copy.deepcopy(doc)
    refused = [c for c in changes if not _apply_one(out, c)]
    return out, refused


def merge(
    base: dict[str, Any], incoming: dict[str, Any], current: dict[str, Any]
) -> tuple[dict[str, Any], list[Change]]:
    """What the author changed from `base` to `incoming`, applied onto `current`.

    Items the author added without an id get one first (unique against all three
    documents), so they merge item by item like every other item.
    """
    reserved = existing_ids(base) | existing_ids(current)
    return apply(current, diff(base, assign_ids(incoming, reserved=reserved)))


def _pointer(change: Change) -> str:
    if isinstance(change, PlaceChange):
        return to_pointer(list(change.list_path) + [change.item_id])
    return to_pointer(list(change.path))


def changed_paths(changes: list[Change]) -> list[str]:
    return [_pointer(c) for c in changes]


def keep_current_where_errors(
    current: dict[str, Any],
    candidate: dict[str, Any],
    issues: list[Issue],
    changes: list[Change],
    *,
    current_issues: list[Issue] | None = None,
) -> dict[str, Any]:
    """The candidate with the current value restored on every changed path an error is about.

    An error is about a change when it sits at or under the changed path, or on a
    container of it (a classification whose classes the change made invalid).
    Errors the current document already has (`current_issues`) block nothing, so a
    stored style that is already damaged can still be edited. Where the current
    document lacks the path, the shallowest missing part is taken back whole.
    """
    known = {(i.code, i.path) for i in current_issues or []}
    errors = [
        i.path for i in issues if i.level == "error" and (i.code, i.path) not in known
    ]
    out = copy.deepcopy(candidate)
    for change in changes:
        pointer = _pointer(change)
        if not any(
            e == pointer or e.startswith(pointer + "/") or pointer.startswith(e + "/")
            for e in errors
        ):
            continue
        segments = tuple(parse_pointer(pointer))
        for depth in range(1, len(segments) + 1):
            if _navigate(current, segments[:depth], create=False) is _MISSING:
                _apply_one(out, RemoveChange(segments[:depth]))
                break
        else:
            _apply_one(
                out, SetChange(segments, _navigate(current, segments, create=False))
            )
    return out
