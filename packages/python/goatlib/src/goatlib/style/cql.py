"""The CQL2-JSON subset rules use (the specification's sections 6 and 18.6).

`and`, `or`, `not`, `=`, `<>`, `<`, `>`, `<=`, `>=`, `in`, `like` (contains, starts
with, ends with) and `isNull`. The helpers walk conditions without recursion, so
a hostile nesting depth cannot exhaust the stack.
"""

from typing import Any

LOGICAL = ("and", "or", "not")
COMPARE = ("=", "<>", "<", ">", "<=", ">=")
OPS = LOGICAL + COMPARE + ("in", "like", "isNull")
MAX_DEPTH = 32


def depth(condition: Any) -> int:
    """Nesting depth: 1 for a comparison, one more per logical level."""
    deepest = 0
    stack = [(condition, 1)]
    while stack:
        node, level = stack.pop()
        deepest = max(deepest, level)
        if (
            isinstance(node, dict)
            and node.get("op") in LOGICAL
            and isinstance(node.get("args"), list)
        ):
            stack.extend((arg, level + 1) for arg in node["args"])
    return deepest


def fields_of(condition: Any) -> set[str]:
    """Every field a condition reads."""
    found: set[str] = set()
    stack = [condition]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("property"), str):
                found.add(node["property"])
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
        elif isinstance(node, list):
            stack.extend(node)
    return found


def like_pattern_supported(pattern: str) -> bool:
    """Contains (`%x%`), starts with (`x%`), ends with (`%x`) or a plain text."""
    inner = pattern[1:] if pattern.startswith("%") else pattern
    inner = inner[:-1] if inner.endswith("%") else inner
    return "%" not in inner and "_" not in inner


def as_text(value: Any) -> str:
    """A value as categories compare it: as text, with booleans as `true` and `false` (section 5.1)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
