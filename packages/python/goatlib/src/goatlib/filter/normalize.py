"""CQL2-JSON spellings to the form the services' parser and evaluator take.

pygeofilter follows an older CQL2 draft in places, and filters saved by older
clients use legacy spellings. `normalize` rewrites both to one form:

- `!=` to `<>`;
- `isNull` with `args: prop` to `args: [prop]`;
- the standard `between` (`[prop, low, high]`) to the parser's `[prop, [low, high]]`;
- `{"date": d}` to `{"timestamp": d + "T00:00:00Z"}`;
- `{"bbox": [w, s, e, n]}` (or its six-number form with heights) to the polygon;
- `casei(x)` to `x`: `like` is case-insensitive already and equality stays exact.

Every rewrite keeps a node in its place, so the positions of a filter's
conditions (`/args/0`, `/args/1`, ...) do not change. Anything else, including
input that is not a filter, comes back unchanged. The walk never recurses and
never mutates its input. Standard library only: the services import this on
every request path.
"""

from typing import Any


def _polygon(bbox: list[Any]) -> dict[str, Any] | None:
    if len(bbox) == 6:
        bbox = bbox[0:2] + bbox[3:5]
    if len(bbox) != 4 or not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in bbox
    ):
        return None
    w, s, e, n = bbox
    return {
        "type": "Polygon",
        "coordinates": [[[w, s], [w, n], [e, n], [e, s], [w, s]]],
    }


def _rewrite_once(node: dict[str, Any]) -> Any:
    """One rewrite of the node itself, or the node when none applies."""
    if len(node) == 1:
        if isinstance(node.get("date"), str):
            day = node["date"]
            return {"timestamp": day if "T" in day else day + "T00:00:00Z"}
        if isinstance(node.get("bbox"), list):
            return _polygon(node["bbox"]) or node
    op, args = node.get("op"), node.get("args")
    if op == "!=":
        return {**node, "op": "<>"}
    if op == "isNull" and "args" in node and not isinstance(args, list):
        return {**node, "args": [args]}
    if op == "between" and isinstance(args, list) and len(args) == 3:
        return {**node, "args": [args[0], [args[1], args[2]]]}
    if op == "casei":
        if isinstance(args, list) and len(args) == 1:
            return args[0]
        if isinstance(args, dict):
            return args
    return node


def _rewrite(node: Any) -> Any:
    while isinstance(node, dict):
        new = _rewrite_once(node)
        if new is node:
            break
        node = new
    return node


def normalize(cql: Any) -> Any:
    """A new tree in the evaluator's form; see the module docstring."""
    holder: list[Any] = [None]
    stack: list[tuple[Any, Any, Any]] = [(cql, holder, 0)]
    while stack:
        node, parent, key = stack.pop()
        node = _rewrite(node)
        if isinstance(node, dict):
            copy: dict[str, Any] = dict(node)
            parent[key] = copy
            stack.extend(
                (v, copy, k) for k, v in node.items() if isinstance(v, (dict, list))
            )
        elif isinstance(node, list):
            items = list(node)
            parent[key] = items
            stack.extend(
                (v, items, i) for i, v in enumerate(node) if isinstance(v, (dict, list))
            )
        else:
            parent[key] = node
    return holder[0]
