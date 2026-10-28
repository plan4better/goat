"""Fix operations (the specification's section 11, closed list).

The AI and the issue fixes edit documents with these; each returns a new document.
"""

import copy
import math
from typing import Any

from goatlib.style.issues import Fix
from goatlib.style.pointer import get, resolve

_MAIN_COLORS = ("fill.color", "line.color", "marker.color")


def apply_fix(doc: dict[str, Any], fix: Fix) -> dict[str, Any]:
    """`doc` with the fix applied. Raises ValueError when the path does not exist."""
    out = copy.deepcopy(doc)
    try:
        if fix.op == "retarget":
            _retarget(get(out, fix.path), fix.target or "")
            return out
        parent, key = resolve(out, fix.path)
        if fix.op == "set":
            parent[key] = copy.deepcopy(fix.value)
        elif fix.op == "remove":
            if isinstance(parent, dict) and key not in parent:
                raise KeyError(fix.path)
            del parent[key]
        elif fix.op == "use_field":
            if not fix.field:
                raise ValueError("use_field needs a field")
            parent[key] = fix.field
        elif fix.op == "round":
            parent[key] = round_half_up(parent[key])
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"{fix.op} at {fix.path}: the path does not exist") from exc
    return out


def round_half_up(value: float) -> int:
    """Rounds .5 up, as JavaScript's Math.round does, so browser and server agree."""
    return math.floor(value + 0.5)


def _retarget(classification: Any, target: str) -> None:
    if not isinstance(classification, dict) or target.count(".") < 1:
        raise ValueError(
            "retarget points at a classification and names a part.key target"
        )
    records = [r for r in classification.get("classes") or [] if isinstance(r, dict)]
    records += [
        classification[k]
        for k in ("other", "no_data")
        if isinstance(classification.get(k), dict)
    ]
    old = classification.get("target") or _main_color(records)
    classification["target"] = target
    if not old or old == target:
        return
    old_part, old_key = old.split(".", 1)
    new_part, new_key = target.split(".", 1)
    for record in records:
        part = record.get(old_part)
        if isinstance(part, dict) and old_key in part:
            value = part.pop(old_key)
            if not part:
                del record[old_part]
            moved = (
                record.get(new_part) if isinstance(record.get(new_part), dict) else {}
            )
            moved[new_key] = value
            record[new_part] = moved


def _main_color(records: list[dict[str, Any]]) -> str | None:
    for key in _MAIN_COLORS:
        part, sub = key.split(".")
        if any(isinstance(r.get(part), dict) and sub in r[part] for r in records):
            return key
    return None
