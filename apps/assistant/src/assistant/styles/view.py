"""A stored style as the model reads it: the document in compact form, and the
check's issues.

Compact leaves out every ``computed`` object (the values the server writes
from the data: domains, generated colors, fingerprints) and cuts each class
list longer than ``MAX_CLASSES`` to its first ones, saying so in a
``CutList``. A ``part`` (a JSON pointer in ``goatlib.style.pointer``'s syntax,
where a list item with an id is named by its id) answers that part in full,
still without ``computed`` objects.
"""

from collections.abc import Sequence
from typing import Any, Literal

from goatlib.style.pointer import get, item_key, parse_pointer, to_pointer
from pydantic import BaseModel

from assistant.tools.runtime import InputInvalid

#: Classes a class list shows before it is cut.
MAX_CLASSES = 12
#: Issues a read shows: errors and damage first, then warnings, then info.
MAX_ISSUES = 30
_LEVEL_ORDER = {"error": 0, "damaged": 0, "warning": 1, "info": 2}


class CutList(BaseModel):
    """A class list the compact document shows only the start of."""

    path: str
    shown: int
    total: int


class IssueView(BaseModel):
    level: Literal["error", "warning", "info", "damaged"]
    code: str
    path: str
    message: str
    #: The change that resolves it (``goatlib.style.issues.Fix``).
    fix: dict[str, Any] | None = None
    #: The values the path accepts.
    allowed: list[Any] | None = None
    #: The style had it before the edit (written by the style's write tool).
    existing: bool | None = None


def _without_computed(node: Any) -> Any:
    """A copy without any ``computed`` object, at every depth."""
    if isinstance(node, dict):
        return {
            key: _without_computed(value)
            for key, value in node.items()
            if not (key == "computed" and isinstance(value, dict))
        }
    if isinstance(node, list):
        return [_without_computed(item) for item in node]
    return node


def _cut(holder: Any, segments: list[str], cuts: list[CutList]) -> None:
    """Cuts ``holder["classes"]`` (a copy) to ``MAX_CLASSES``; ``segments``
    name ``holder``."""
    if not isinstance(holder, dict):
        return
    classes = holder.get("classes")
    if isinstance(classes, list) and len(classes) > MAX_CLASSES:
        cuts.append(
            CutList(
                path=to_pointer([*segments, "classes"]),
                shown=MAX_CLASSES,
                total=len(classes),
            )
        )
        holder["classes"] = classes[:MAX_CLASSES]


def compact(
    document: dict[str, Any], part: str | None = None
) -> tuple[dict[str, Any], list[CutList]]:
    """The document as the model reads it, and the class lists cut in it.

    With ``part``, the value at that pointer in full; a value that is not an
    object comes as ``{<the pointer's last segment>: value}``. A part that
    does not exist is ``InputInvalid`` naming the document's top-level keys.
    The input document is never changed.
    """
    if part is not None:
        try:
            segments = parse_pointer(part)
            value = get(document, part)
        except (KeyError, ValueError):
            raise InputInvalid(
                f"The style has no part {part!r}. Its top-level parts are: "
                f"{', '.join(document)}. A list item with an id is named by its "
                "id, e.g. /classify/<id>/classes/<id>."
            ) from None
        if "computed" in segments:
            raise InputInvalid(
                "Computed values are written by the server from the data and are "
                "not shown; read the classes instead."
            )
        shown = _without_computed(value)
        if not isinstance(shown, dict):
            shown = {segments[-1] if segments else "document": shown}
        return shown, []
    out: dict[str, Any] = _without_computed(document)
    cuts: list[CutList] = []
    classify = out.get("classify")
    if isinstance(classify, list):
        for index, classification in enumerate(classify):
            _cut(classification, ["classify", item_key(classification, index)], cuts)
    render = out.get("render")
    if isinstance(render, dict):
        _cut(render.get("classify"), ["render", "classify"], cuts)
    return out, cuts


def issue_views(issues: Sequence[dict[str, Any]]) -> list[IssueView]:
    """Core's issues, at most ``MAX_ISSUES``: errors and damage first, then
    warnings, then info, each in core's order. An issue of a level core does
    not send is left out."""
    known = [
        issue
        for issue in issues
        if isinstance(issue, dict) and issue.get("level") in _LEVEL_ORDER
    ]
    known.sort(key=lambda issue: _LEVEL_ORDER[issue["level"]])
    return [
        IssueView(
            level=issue["level"],
            code=str(issue.get("code") or ""),
            path=str(issue.get("path") or ""),
            message=str(issue.get("message") or ""),
            fix=issue.get("fix") if isinstance(issue.get("fix"), dict) else None,
            allowed=issue.get("allowed")
            if isinstance(issue.get("allowed"), list)
            else None,
        )
        for issue in known[:MAX_ISSUES]
    ]
