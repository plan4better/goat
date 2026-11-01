"""When a tool setting is shown: the editor's `visible_when` / `hidden_when` rules.

A port of the web evaluator (`resolveValuePath`, `evaluateCondition` and
`isInputVisible` in `apps/web/lib/utils/ogc-utils.ts`). A required setting
counts as missing only while the editor shows it, so both sides must agree on
every condition; `visibility_cases.json` next to this module holds the cases
that the Python and the web tests both run.

The conditions are JSON, evaluated with JavaScript's rules: a missing value is
not `null`, `===` never equates `true` with `1`, and `[]` and `{}` are truthy.
Python's `==` and truthiness differ on each point, hence the helpers below.
"""

import operator
from typing import Any

_MISSING = object()


_COMPARISONS = {
    "$gt": operator.gt,
    "$gte": operator.ge,
    "$lt": operator.lt,
    "$lte": operator.le,
}


def _number(value: object) -> int | float | None:
    """`value` if JavaScript's `typeof` calls it a number, else None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return value


def _strict_eq(a: object, b: object) -> bool:
    """JavaScript's `a === b` for values parsed from JSON."""
    if a is _MISSING or b is _MISSING:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _number(a) is not None and _number(b) is not None:
        return a == b
    if isinstance(a, list | dict) or isinstance(b, list | dict):
        # Arrays and objects compare by reference in JavaScript, and a value
        # never is the very object written in the condition.
        return a is b
    return type(a) is type(b) and a == b


def _js_truthy(value: object) -> bool:
    if value is _MISSING or value is None:
        return False
    if isinstance(value, list | dict):
        return True
    return bool(value)


def _is_nullish(value: object) -> bool:
    return value is _MISSING or value is None or value == ""


def _is_array_index(key: str) -> bool:
    return key.isascii() and key.isdigit() and str(int(key)) == key


def resolve_value_path(values: dict[str, Any], path: str) -> object:
    """The value at `path`, a name or a dotted path into an object-valued
    setting (`starting_points.layer_id`); `_MISSING` when there is none."""
    if "." not in path:
        return values.get(path, _MISSING)
    current: object = values
    for key in path.split("."):
        if isinstance(current, dict):
            current = current.get(key, _MISSING)
        elif isinstance(current, list) and _is_array_index(key):
            index = int(key)
            current = current[index] if index < len(current) else _MISSING
        else:
            return _MISSING
    return current


def _operator_holds(op: str, value: object, expected: object) -> bool:
    if op == "$eq":
        return _strict_eq(value, expected)
    if op == "$ne":
        # `{"$ne": null}` means "has a value": missing, null and "" are alike.
        if _is_nullish(expected):
            return not _is_nullish(value)
        return not _strict_eq(value, expected)
    if op in _COMPARISONS:
        a, b = _number(value), _number(expected)
        return a is not None and b is not None and bool(_COMPARISONS[op](a, b))
    if op == "$in":
        return isinstance(expected, list) and any(
            _strict_eq(value, item) for item in expected
        )
    if op == "$nin":
        return isinstance(expected, list) and not any(
            _strict_eq(value, item) for item in expected
        )
    if op == "$exists":
        return _js_truthy(expected) == (not _is_nullish(value))
    # An operator the editor does not know is skipped there too.
    return True


def matches(condition: dict[str, Any], values: dict[str, Any]) -> bool:
    """Whether `values` (a step's settings) meet `condition`.

    Every entry must hold: `{"name": value}` is strict equality, `{"name":
    {"$op": ...}}` applies each operator, `$and` / `$or` take a list of
    conditions. A condition that is not an object has no entries and holds.
    """
    if not isinstance(condition, dict):
        return True
    for key, check in condition.items():
        if key == "$and" and isinstance(check, list):
            if not all(matches(sub, values) for sub in check):
                return False
            continue
        if key == "$or" and isinstance(check, list):
            if not any(matches(sub, values) for sub in check):
                return False
            continue
        value = resolve_value_path(values, key)
        if isinstance(check, dict):
            for op, expected in check.items():
                if not _operator_holds(op, value, expected):
                    return False
        elif not _strict_eq(value, check):
            return False
    return True


def is_shown(x_ui: dict[str, Any] | None, values: dict[str, Any]) -> bool:
    """Whether the editor shows a setting with this `x-ui` metadata.

    Hidden when `hidden` is set, when `visible_when` exists and does not hold,
    or when `hidden_when` exists and holds. "Exists" is JavaScript truthiness,
    so an empty `hidden_when: {}` holds and hides the setting, as in the editor.
    """
    if not x_ui:
        return True
    if _js_truthy(x_ui.get("hidden")):
        return False
    visible_when: Any = x_ui.get("visible_when")
    if _js_truthy(visible_when) and not matches(visible_when, values):
        return False
    hidden_when: Any = x_ui.get("hidden_when")
    if _js_truthy(hidden_when) and matches(hidden_when, values):
        return False
    return True
