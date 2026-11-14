"""The CQL2-JSON subset rules use (the specification's sections 6 and 18.6).

`and`, `or`, `not`, `=`, `<>`, `<`, `>`, `<=`, `>=`, `in`, `like` (contains, starts
with, ends with) and `isNull`. The tables and walks are shared with layer
filters and live in `goatlib.filter.cql`; the helpers walk conditions without
recursion, so a hostile nesting depth cannot exhaust the stack.
"""

from goatlib.filter.cql import (
    COMPARE,
    LOGICAL,
    OPS,
    as_text,
    depth,
    fields_of,
    like_pattern_supported,
)
from goatlib.filter.limits import MAX_DEPTH

__all__ = [
    "COMPARE",
    "LOGICAL",
    "MAX_DEPTH",
    "OPS",
    "as_text",
    "depth",
    "fields_of",
    "like_pattern_supported",
]
