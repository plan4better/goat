"""Ids for the list items edits and issues address (the specification's section 1)."""

import copy
from typing import Any, Iterable


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def assign_ids(doc: dict[str, Any], *, reserved: Iterable[str] = ()) -> dict[str, Any]:
    """A copy of `doc` where every classification, class, rule and popup block has an id.

    A classification takes its field name when that id is free, otherwise `k1`, `k2`;
    classes get `c1`, rules `r1`, blocks `b1`; ids are unique in the document and
    existing ids are kept. `reserved` names ids a new item must not take (the ids
    of the other documents of a merge).
    """
    out = copy.deepcopy(doc)
    if not isinstance(out, dict):
        return out
    taken = existing_ids(out) | set(reserved)
    counters: dict[str, int] = {}

    def fill(items: Any, prefix: str) -> None:
        for item in _list(items):
            if isinstance(item, dict) and not isinstance(item.get("id"), str):
                item["id"] = fresh_id(prefix, taken, counters)

    for c in _list(out.get("classify")):
        if isinstance(c, dict) and not isinstance(c.get("id"), str):
            field = c.get("field")
            if isinstance(field, str) and field and field not in taken:
                c["id"] = field
                taken.add(field)
            else:
                c["id"] = fresh_id("k", taken, counters)
        if isinstance(c, dict):
            fill(c.get("classes"), "c")
    fill(out.get("rules"), "r")
    popup = out.get("popup")
    if isinstance(popup, dict):
        fill(popup.get("blocks"), "b")
    render = out.get("render")
    if isinstance(render, dict) and isinstance(render.get("classify"), dict):
        fill(render["classify"].get("classes"), "c")
    return out


def fresh_id(
    prefix: str, taken: set[str], counters: dict[str, int] | None = None
) -> str:
    """The first of `prefix1`, `prefix2`, ... not in `taken`, which it is added to.

    `counters` holds, per prefix, the number the search starts at, for a caller
    that takes many ids from one `taken` set that only grows: every number below
    it is taken already, so each number is looked at once in all.
    """
    n = counters.get(prefix, 1) if counters is not None else 1
    while f"{prefix}{n}" in taken:
        n += 1
    taken.add(f"{prefix}{n}")
    if counters is not None:
        counters[prefix] = n + 1
    return f"{prefix}{n}"


def existing_ids(node: Any) -> set[str]:
    """Every id in a document."""
    found: set[str] = set()
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            if isinstance(n.get("id"), str):
                found.add(n["id"])
            stack.extend(v for v in n.values() if isinstance(v, (dict, list)))
        elif isinstance(n, list):
            stack.extend(n)
    return found
