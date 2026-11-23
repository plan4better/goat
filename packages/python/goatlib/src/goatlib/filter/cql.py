"""CQL2-JSON tables and walks shared by layer filters and style rules.

Style rules take the subset in `OPS` (`goatlib.style.cql` re-exports it).
Layer filters take more: `between`, spatial operators, the legacy `!=` and the
other forms the services evaluate. The walks never recurse, so a hostile
nesting depth cannot exhaust the stack.
"""

from typing import Any

LOGICAL = ("and", "or", "not")
COMPARE = ("=", "<>", "<", ">", "<=", ">=")
#: The condition subset style rules use.
OPS = LOGICAL + COMPARE + ("in", "like", "isNull")

#: Spellings older filters were saved with; `normalize` rewrites them.
LEGACY_COMPARE = ("!=",)
#: Comparisons that need values with an order (numbers, dates).
ORDERING = ("<", ">", "<=", ">=", "between")
SPATIAL = (
    "s_intersects",
    "s_within",
    "s_contains",
    "s_disjoint",
    "s_touches",
    "s_crosses",
    "s_overlaps",
    "s_equals",
)
#: The temporal operators the evaluator turns into the comparison they name;
#: the others it reads as equality, so a filter cannot use them.
TEMPORAL = ("t_before", "t_after", "t_equals")
ARITHMETIC = ("+", "-", "*", "/")
#: Wrappers a filter may use that change nothing: `like` is case-insensitive already.
NO_OP_WRAPPERS = ("casei",)
#: The functions a filter may call, matched regardless of case. A call reaches
#: DuckDB by name, so only pure, side-effect-free scalar functions are listed:
#: the evaluator emits the entry from this list, never the caller's token, and
#: refuses every other name (crucially the file and network readers such as
#: read_text, read_csv and read_parquet). Add a function only after confirming
#: it is a pure scalar with no filesystem or network reach. The parser reads a
#: call as `{"function": {"name": ..., "arguments": [...]}}`.
FUNCTIONS = (
    "abs",
    "ceil",
    "ceiling",
    "floor",
    "round",
    "sign",
    "sqrt",
    "power",
    "mod",
    "length",
    "lower",
    "upper",
    "trim",
    "ltrim",
    "rtrim",
    "substr",
    "substring",
    "concat",
    "coalesce",
)
#: Every operator a layer filter may use.
FILTER_OPS = (
    OPS
    + LEGACY_COMPARE
    + ("between",)
    + SPATIAL
    + TEMPORAL
    + ARITHMETIC
    + NO_OP_WRAPPERS
)

#: Property names the evaluator reads as the layer's geometry.
GEOMETRY_PROPERTIES = ("geom", "geometry", "the_geom", "wkb_geometry")
#: Properties the evaluator answers without a column: the feature id.
VIRTUAL_PROPERTIES = ("_rowid", "id")


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


def is_geometry(value: Any) -> bool:
    """A GeoJSON geometry with coordinates (what the parser takes as one) or a
    `{"bbox": [...]}` envelope."""
    return isinstance(value, dict) and (
        ("type" in value and "coordinates" in value)
        or (len(value) == 1 and isinstance(value.get("bbox"), list))
    )
