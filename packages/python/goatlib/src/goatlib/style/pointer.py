"""JSON pointers (RFC 6901) as GOAT Style uses them.

Issue paths and fix operations point into a document. A list item that has an
`id` is addressed by its id (`/classify/density/classes/c2`), any other list item
by its index.
"""

from typing import Any


def to_pointer(segments: list[str]) -> str:
    return "".join("/" + s.replace("~", "~0").replace("/", "~1") for s in segments)


def parse_pointer(pointer: str) -> list[str]:
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"A JSON pointer starts with '/': {pointer!r}")
    return [s.replace("~1", "/").replace("~0", "~") for s in pointer[1:].split("/")]


def item_key(item: Any, index: int) -> str:
    """How a list item is addressed: its id when it has one, otherwise its index."""
    if isinstance(item, dict) and isinstance(item.get("id"), str):
        return item["id"]
    return str(index)


def find_index(items: list[Any], segment: str) -> int | None:
    """The index of the list item a segment addresses (an id first, then an index)."""
    for i, item in enumerate(items):
        if isinstance(item, dict) and item.get("id") == segment:
            return i
    if segment.isdigit() and int(segment) < len(items):
        return int(segment)
    return None


def resolve(doc: Any, pointer: str) -> tuple[Any, str | int]:
    """The container holding the pointer's target and the key or index in it.

    Raises KeyError when a segment on the way does not exist.
    """
    segments = parse_pointer(pointer)
    if not segments:
        raise KeyError("The empty pointer has no parent")
    node = doc
    for s in segments[:-1]:
        node = _child(node, s)
    last = segments[-1]
    if isinstance(node, list):
        index = find_index(node, last)
        if index is None:
            raise KeyError(pointer)
        return node, index
    if isinstance(node, dict):
        return node, last
    raise KeyError(pointer)


def get(doc: Any, pointer: str) -> Any:
    node = doc
    for s in parse_pointer(pointer):
        node = _child(node, s)
    return node


def _child(node: Any, segment: str) -> Any:
    if isinstance(node, dict):
        if segment not in node:
            raise KeyError(segment)
        return node[segment]
    if isinstance(node, list):
        index = find_index(node, segment)
        if index is None:
            raise KeyError(segment)
        return node[index]
    raise KeyError(segment)
