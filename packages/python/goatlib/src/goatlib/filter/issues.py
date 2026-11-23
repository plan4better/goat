"""The issue codes of a layer filter.

Issues have the style's shape (`goatlib.style.issues.Issue`): a code, a level, a
JSON pointer into the filter and one message for people and the AI. The codes
the filter shares with style rules keep the style's meaning and level.
"""

from typing import Any

from goatlib.style.issues import Issue, Level
from goatlib.style.issues import make_issue as _make_issue

#: Code to default level. `validate` changes the level of a stored filter: a
#: field a later data change broke is `damaged`, a limit is a `warning`.
CODES: dict[str, Level] = {
    "malformed": "error",
    "operator_unsupported": "error",
    "unknown_field": "error",
    "field_type_mismatch": "error",
    "operator_type_mismatch": "error",
    "too_many_conditions": "error",
    "too_many_values": "error",
    "too_deep": "error",
    "too_many_shapes": "error",
    "area_too_detailed": "error",
    "area_crosses_itself": "error",
    "too_long": "error",
    "negation_drops_empty": "info",
}

#: Codes a later change of the layer's data can cause in a stored filter.
DAMAGE_CODES = ("unknown_field", "field_type_mismatch")
#: Codes of the limits: a stored filter over one still loads.
LIMIT_CODES = (
    "too_many_conditions",
    "too_many_values",
    "too_deep",
    "too_many_shapes",
    "area_too_detailed",
    "area_crosses_itself",
    "too_long",
)


def make_issue(code: str, path: str, message: str, **kw: Any) -> Issue:
    """An issue with one of the filter's codes (KeyError for any other)."""
    return _make_issue(code, path, message, codes=CODES, **kw)
