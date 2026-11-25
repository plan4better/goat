"""What ``style_update`` takes and answers, and its steps one by one.

A call names one of four ways to change a layer's style (``StyleUpdateInput``):
operations on a stored style, a new named style from a starting point (with
operations, or as it is), a new named style from a whole document, or a whole
document written over a style that exists. goatlib applies the operations in
process (``goatlib.style.edit``); core checks the result before anything is
written, and an error refuses it when the change adds it or when it lies at a
path the call's own operations wrote (issues are compared by code and path,
never by level or message: a stored style reports as damaged what a check
reports as an error). ``StyleUpdated`` is what the model reads, without
the document; what takes the change back goes to the call's audit row
(``StyleUpdated.undo``).

The steps that call core let its refusal through as it is (``ServiceError``):
the tool puts it in words.
"""

import json
from collections.abc import Iterable, Sequence
from typing import Any, Literal, cast
from uuid import UUID

from goatlib.style.context import DataContext
from goatlib.style.defaults import default_style
from goatlib.style.edit import Edit, Edited, EditError, apply_edits
from goatlib.style.ids import assign_ids
from goatlib.style.merge import _class_skip, changed_paths, diff
from goatlib.style.pointer import find_index, item_key, parse_pointer, to_pointer
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_ai.exceptions import ToolFailed

from assistant.styles.legend import MAX_COUNTED, LegendNumbers
from assistant.styles.view import IssueView, issue_views
from assistant.tools.filters import _decoded
from assistant.tools.runtime import InputInvalid, ToolEnv

MAX_OPERATIONS = 30
#: Changed paths a result lists.
MAX_CHANGED = 50
#: Issues a refusal lists.
MAX_LISTED_ISSUES = 5

Mode = Literal["edit", "new_from", "new_whole", "replace"]

MODES = (
    "Give one of the four ways to change a style, and only one. "
    "Edit in place: operations alone, with style_id for a style other than the "
    "one the map draws. "
    "New style from a starting point: new_style with start, and the "
    "operations that change it, or none for a plain copy. "
    "New style from a whole document: new_style without start, and document. "
    "Replace a style whole: style_id and document, and name to rename it."
)
NAME_RENAMES = (
    "name renames a style that is replaced whole (style_id and document). A new "
    "style takes its name in new_style.name, and an edit in place renames nothing."
)
NOT_A_STYLE_ID = (
    "style_id is a style's id from project_get_layers (style.id, or an id of "
    "style.others)."
)
NO_SAVE_ANSWER = "Core answered the save without the style's revision."
#: The operations that write a value at their path.
_WRITES = frozenset({"set", "use_field", "retarget", "round"})


class NewStyle(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(
        min_length=1,
        max_length=120,
        description=(
            "The new style's name as the user reads it in the layer's style "
            "list, in the user's language. Example: Density by district."
        ),
    )
    asked: str = Field(
        min_length=1,
        max_length=300,
        description=(
            "The user's words that ask for a new style or for options, word for "
            "word and exactly as typed, typos included, in their language. "
            "Without such words do not create a style: edit the active one in "
            "place."
        ),
    )
    start: Literal["current", "dataset_default", "empty"] | None = Field(
        default=None,
        description=(
            "What the new style starts from, and what the operations are "
            "applied to: current is a copy of the style the map draws, "
            "dataset_default the style the dataset came with, empty a plain "
            "symbol for the layer's geometry. Leave it out when you send a "
            "whole document."
        ),
    )


class StyleUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    layer_project_id: int = Field(
        ge=1,
        description="The layer's ID within the open project (layer_project_id from project_get_layers).",
    )
    style_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "The style to edit or replace: style.id, or an id of style.others, "
            "from project_get_layers. Leave it out to edit the style the map "
            "draws. Never with new_style."
        ),
    )
    new_style: NewStyle | None = Field(
        default=None,
        description=(
            "Creates a new named style and leaves the existing ones as they "
            "are. Only when the user asks for a new style or for options in "
            "words; any other change edits in place. With start, send the "
            "operations that change the starting point, or none for a plain "
            "copy; without start, send document."
        ),
    )
    operations: list[Edit] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_OPERATIONS,
        description=(
            "The changes, applied in order, all or none. Paths are JSON pointers "
            "into the style as style_get shows it; a list item with an id is "
            "named by its id. The result's added gives the id of each added "
            "item by its operation's index, counting from 0; a failure names "
            "an operation by its number, counting from 1."
        ),
    )
    document: dict[str, Any] | None = Field(
        default=None,
        description=(
            "A whole GOAT Style document, for a new style without start or to "
            "replace the style style_id names. Leave out every computed object "
            "and the classes of a computed method. Never together with "
            "operations."
        ),
    )
    name: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
        description="Only when a style is replaced whole (style_id and document): its new name.",
    )
    make_active: bool | None = Field(
        default=None,
        description=(
            "Whether the map draws the style after the call. Leave it out for "
            "the default: a new or replaced style is drawn, an edited style "
            "stays as it is, drawn or not. False creates or replaces a style "
            "without switching the map to it; true on an edit switches the map "
            "to the edited style."
        ),
    )

    @field_validator("style_id", mode="before")
    @classmethod
    def _canonical(cls, value: Any) -> Any:
        if not isinstance(value, str) or not value.strip():
            return None if isinstance(value, str) else value
        try:
            return str(UUID(value.strip()))
        except ValueError:
            raise ValueError(NOT_A_STYLE_ID) from None

    @field_validator("document", mode="before")
    @classmethod
    def _object(cls, value: Any) -> Any:
        """A document sent as JSON text is read as the object."""
        return _decoded(value)

    @model_validator(mode="after")
    def _one_way(self) -> "StyleUpdateInput":
        if self._way() is None:
            raise ValueError(MODES)
        if self.name is not None and self._way() != "replace":
            raise ValueError(NAME_RENAMES)
        return self

    def _way(self) -> Mode | None:
        new, start = self.new_style, False
        if new is not None:
            start = new.start is not None
        operations = self.operations is not None
        document = self.document is not None
        if operations and document:
            return None
        if new is None:
            if operations:
                return "edit"
            return "replace" if document and self.style_id is not None else None
        if self.style_id is not None:
            return None
        if start:
            return None if document else "new_from"
        return "new_whole" if document else None

    def mode(self) -> Mode:
        """Which of the four ways the call is."""
        way = self._way()
        if way is None:
            raise ValueError(MODES)
        return way


class StyleUpdated(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    project_id: UUID
    layer_project_id: int
    style_id: str
    name: str
    #: The call created the style; ``created`` in the result. Under another
    #: name here: the runtime reads a result's ``created`` attribute as the
    #: method of a tool that records what it created.
    was_created: bool = Field(default=False, alias="created")
    #: The style is the one the map draws for the layer after the call.
    active: bool
    #: This call switched the layer to the style.
    made_active: bool = False
    #: This call changed the style's name.
    renamed: bool = False
    #: None for a created style.
    revision_before: int | None = None
    revision_after: int | None = None
    #: Pointers to what differs from the document before, at most
    #: ``MAX_CHANGED``; empty for a created style.
    changed: list[str] = []
    #: The id each ``add`` operation's item got, by the operation's index in
    #: the call, counting from 0.
    added: dict[str, str] = {}
    issues: list[IssueView] = []
    #: Pointers core kept at their stored value: the new value has an error.
    not_saved: list[str] = []
    legend: list[LegendNumbers] = []
    legend_note: str | None = None
    #: What did not happen after the first write landed.
    incomplete: str | None = None
    note: str | None = None
    #: For the audit row only (``undo``), never serialized: the document and
    #: the name core held before the call, and the style the map drew before
    #: this call switched it.
    before: dict[str, Any] | None = Field(default=None, exclude=True)
    name_before: str | None = Field(default=None, exclude=True)
    active_before: str | None = Field(default=None, exclude=True)

    def undo(self) -> dict[str, Any] | None:
        """What the dock's Undo needs. A created style: its id, the revision
        the call left and the style the map drew before, when the call
        switched it. A changed one: the document and name before, the
        revisions around the change, ``renamed_to`` (the new name) when the
        call renamed it, and ``active_before`` when the call switched the map
        to it. None when nothing landed."""
        ids = {
            "project_id": str(self.project_id),
            "layer_project_id": self.layer_project_id,
            "style_id": self.style_id,
        }
        if self.was_created:
            return {
                "kind": "style_created",
                **ids,
                "revision": self.revision_after,
                "active_before": self.active_before,
            }
        moved = self.revision_after != self.revision_before
        renamed = self.name_before is not None and self.name != self.name_before
        if self.before is None or not (moved or renamed or self.made_active):
            return None
        record = {
            "kind": "style",
            **ids,
            "revision_before": self.revision_before,
            "revision_after": self.revision_after,
            "before": {"document": self.before, "name": self.name_before},
        }
        if renamed:
            record["renamed_to"] = self.name
        if self.made_active:
            record["active_before"] = self.active_before
        return record


# ---- the document a call writes --------------------------------------------------


def empty_document(
    layer_type: str | None, geometry: str | None, seed: str | None
) -> dict[str, Any]:
    """goatlib's default style for a layer of this type and geometry, as core
    builds a layer's first style; ``seed`` (the dataset's id) picks its color."""
    if layer_type == "raster":
        context = DataContext(kind="raster")
    else:
        known = geometry if geometry in ("point", "line", "polygon") else None
        context = DataContext(
            kind="vector",
            geometry=cast(Literal["point", "line", "polygon"] | None, known),
        )
    document: dict[str, Any] = default_style(context, seed=seed)
    return document


def edited(document: dict[str, Any], operations: Sequence[Edit]) -> Edited:
    """``document`` with the operations applied, all or none, and the ids the
    added items got. An operation that cannot be applied is ``InputInvalid``
    naming its number and the reason."""
    try:
        return apply_edits(document, operations)
    except EditError as exc:
        raise InputInvalid(str(exc)) from exc


# ---- the check's issues ----------------------------------------------------------


def issue_keys(issues: Iterable[Any]) -> set[tuple[str, str]]:
    """What issues are about, as (code, path)."""
    return {
        (str(issue.get("code")), str(issue.get("path")))
        for issue in issues
        if isinstance(issue, dict)
    }


def written_pointers(
    document: dict[str, Any], operations: Sequence[Edit], added: dict[int, str]
) -> list[str]:
    """The paths the operations wrote a value at, as issues name paths (a list
    item with an id by its id): the path of a set, use_field, retarget and
    round, and the item an add put in. ``document`` is the edited one."""
    found: list[str] = []
    for index, operation in enumerate(operations):
        segments = _by_id(document, operation.path)
        if operation.op in _WRITES and segments:
            found.append(to_pointer(segments))
        elif operation.op == "add" and index in added:
            found.append(to_pointer([*segments, added[index]]))
    return found


def _by_id(document: dict[str, Any], path: str) -> list[str]:
    """The path's segments, a list item named by its id where it has one."""
    try:
        segments: list[str] = parse_pointer(path)
    except ValueError:
        return []
    node: Any = document
    named: list[str] = []
    for position, segment in enumerate(segments):
        if isinstance(node, list):
            index = find_index(node, segment)
            if index is None:
                return named + segments[position:]
            named.append(item_key(node[index], index))
            node = node[index]
        elif isinstance(node, dict) and segment in node:
            named.append(segment)
            node = node[segment]
        else:
            return named + segments[position:]
    return named


def _at_or_under(path: str, written: Sequence[str]) -> bool:
    return any(path == pointer or path.startswith(f"{pointer}/") for pointer in written)


def added_errors(
    issues: Iterable[Any], known: set[tuple[str, str]], written: Sequence[str] = ()
) -> list[dict[str, Any]]:
    """The errors among ``issues`` that are the change's own: ``known`` (the
    style's issues before the change) does not hold them, or they lie at or
    under a path the call wrote (``written``), where the value is the call's
    whatever the style held there before."""
    return [
        issue
        for issue in issues
        if isinstance(issue, dict)
        and issue.get("level") == "error"
        and (
            (str(issue.get("code")), str(issue.get("path"))) not in known
            or _at_or_under(str(issue.get("path")), written)
        )
    ]


def sentence(text: str) -> str:
    """``text`` ending as a sentence ends."""
    text = text.strip()
    return text if text.endswith((".", "!", "?")) else f"{text}."


def _plain(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _fix_text(fix: dict[str, Any]) -> str:
    """A fix as the operation that makes it: op, path and what the op reads."""
    words = [str(fix.get("op")), str(fix.get("path"))]
    if fix.get("op") == "set":
        words.append(json.dumps(fix.get("value"), ensure_ascii=False))
    for key in ("target", "field"):
        if isinstance(fix.get(key), str):
            words.append(fix[key])
    return f"Fix: {' '.join(words)}."


def refusal(
    issues: Sequence[dict[str, Any]], what: Literal["operations", "document"]
) -> str:
    """The failure of a call whose change adds ``issues``: how many, the first
    ``MAX_LISTED_ISSUES`` with their path, message, allowed values and fix,
    and what to send again (``what``)."""
    listed = []
    for issue in issues[:MAX_LISTED_ISSUES]:
        text = f"{issue.get('path')}: {sentence(str(issue.get('message') or ''))}"
        allowed = issue.get("allowed")
        if isinstance(allowed, list) and allowed:
            text += f" Allowed: {', '.join(_plain(value) for value in allowed)}."
        fix = issue.get("fix")
        if isinstance(fix, dict):
            text += f" {_fix_text(fix)}"
        listed.append(text)
    return (
        f"Not saved: {len(issues)} issue(s) this edit adds must be fixed first. "
        f"{' '.join(listed)} Change the {what} and call style_update again."
    )


def kept_paths(
    issues: Iterable[Any], known: set[tuple[str, str]], written: Sequence[str] = ()
) -> list[str]:
    """The paths of a save's errors that are the change's own
    (``added_errors``): core kept its stored value there."""
    own = added_errors(issues, known, written)
    return list(dict.fromkeys(str(issue.get("path")) for issue in own))


def views(
    issues: Sequence[Any], known: set[tuple[str, str]], written: Sequence[str] = ()
) -> list[IssueView]:
    """A save's issues as the model reads them; ``existing`` marks the ones
    the style had before the change, at a path the call did not write."""
    shown = issue_views([issue for issue in issues if isinstance(issue, dict)])
    for view in shown:
        if (view.code, view.path) in known and not _at_or_under(view.path, written):
            view.existing = True
    return shown


# ---- what a save changed ---------------------------------------------------------


def changed_pointers(before: dict[str, Any], stored: dict[str, Any]) -> list[str]:
    """Pointers to what ``stored`` differs in from ``before``, as a save's
    merge sees it: computed values, and the class limits the server computes,
    are no difference."""
    return list(dict.fromkeys(changed_paths(diff(before, stored))))


def shown_changes(pointers: Sequence[str]) -> tuple[list[str], str | None]:
    """The first ``MAX_CHANGED`` pointers, and a note when some are left out."""
    if len(pointers) <= MAX_CHANGED:
        return list(pointers), None
    return (
        list(pointers[:MAX_CHANGED]),
        f"changed lists the first {MAX_CHANGED} of {len(pointers)} changed paths.",
    )


def holds(stored: dict[str, Any], sent: dict[str, Any]) -> bool:
    """Whether ``stored`` is ``sent`` as core stores it: nothing of ``sent``
    differs but what the server writes itself (computed values, and the class
    list of a classification whose classes it computes, which it may write
    anew under other ids)."""
    sent = assign_ids(sent)
    computed = _computed_class_lists(sent)
    return not [
        pointer
        for pointer in changed_paths(diff(assign_ids(stored), sent))
        if not _at_or_under(pointer, computed)
    ]


def holds_changes(
    stored: dict[str, Any], sent: dict[str, Any], base: dict[str, Any]
) -> bool:
    """Whether ``stored`` holds what a save of ``sent`` changed of ``base``:
    every path ``sent`` changed has the sent value (computed values and the
    class lists the server computes aside). Other paths may differ: a save
    merged onto another made in between, or a value core kept."""
    sent = assign_ids(sent)
    computed = _computed_class_lists(sent)
    changed = [
        pointer
        for pointer in changed_paths(diff(assign_ids(base), sent))
        if not _at_or_under(pointer, computed)
    ]
    if not changed:
        return holds(stored, sent)
    return not [
        pointer
        for pointer in changed_paths(diff(assign_ids(stored), sent))
        if not _at_or_under(pointer, computed)
        and (
            _at_or_under(pointer, changed)
            or any(_at_or_under(path, [pointer]) for path in changed)
        )
    ]


def _computed_class_lists(document: dict[str, Any]) -> list[str]:
    """Pointers to the class lists the server computes in ``document``."""
    found: list[str] = []
    classify = document.get("classify")
    for index, classification in enumerate(
        classify if isinstance(classify, list) else []
    ):
        if _class_skip(classification):
            key = item_key(classification, index)
            found.append(to_pointer(["classify", key, "classes"]))
    render = document.get("render")
    if isinstance(render, dict) and _class_skip(render.get("classify")):
        found.append("/render/classify/classes")
    return found


def first_classifications(document: dict[str, Any]) -> tuple[list[str], str | None]:
    """The first ``MAX_COUNTED`` classifications of a vector style, as the
    legend numbers name them, and a note when the style has more."""
    classify = document.get("classify")
    items = classify if isinstance(classify, list) else []
    pointers = [
        to_pointer(["classify", item_key(item, index)])
        for index, item in enumerate(items[:MAX_COUNTED])
    ]
    if len(items) <= MAX_COUNTED:
        return pointers, None
    return pointers, (
        f"Legend numbers are given for the first {MAX_COUNTED} classifications; "
        "read the others with style_get."
    )


def touched_classifications(pointers: Iterable[str]) -> list[str] | None:
    """The classifications the changed paths lie in, as the legend numbers
    name them (``/classify/<id>``, ``/render/classify``); None when the list
    of classifications was written whole, so each of them counts."""
    found: dict[str, None] = {}
    for pointer in pointers:
        segments = parse_pointer(pointer)
        if segments == ["classify"]:
            return None
        if len(segments) >= 2 and segments[0] == "classify":
            found[to_pointer(segments[:2])] = None
        elif segments[:2] == ["render", "classify"]:
            found["/render/classify"] = None
    return list(found)


# ---- core's routes ---------------------------------------------------------------


def styles_path(project_id: UUID | str, layer_project_id: int) -> str:
    """Core's route of a layer's named styles; a style is its id under it."""
    return f"/api/v2/project/{project_id}/layer/{layer_project_id}/style"


def map_state_path(project_id: UUID | str, layer_project_id: int) -> str:
    """Core's route of a layer's map state, the style it draws among it."""
    return f"/api/v2/project/{project_id}/layer/{layer_project_id}/map-state"


async def dataset_default(env: ToolEnv, layer_id: str) -> dict[str, Any]:
    """The document of the style the dataset came with."""
    reply = await env.call("core", "GET", f"/api/v2/layer/{layer_id}/style")
    document = reply.get("document") if isinstance(reply, dict) else None
    if not isinstance(document, dict):
        raise ToolFailed("Core answered the dataset's style without its document.")
    return document


async def check_document(
    env: ToolEnv,
    project_id: UUID,
    layer_project_id: int,
    style_id: str,
    document: dict[str, Any],
) -> list[dict[str, Any]]:
    """The issues core's check finds in ``document`` for the layer; nothing
    is stored. ``style_id`` names a style of the layer the check runs on."""
    reply = await env.call(
        "core",
        "POST",
        f"{styles_path(project_id, layer_project_id)}/{style_id}/check",
        json_body={"document": document},
    )
    issues = reply.get("issues") if isinstance(reply, dict) else None
    return [issue for issue in issues or [] if isinstance(issue, dict)]


async def create_style(
    env: ToolEnv, project_id: UUID, layer_project_id: int, name: str, copy_from: str
) -> dict[str, Any]:
    """A new named style of the layer, a copy of ``copy_from``, at revision 1."""
    reply = await env.call(
        "core",
        "POST",
        styles_path(project_id, layer_project_id),
        json_body={"name": name, "copy_from": copy_from},
    )
    if not isinstance(reply, dict) or not isinstance(reply.get("id"), str):
        raise ToolFailed("Core created the style but did not answer its id.")
    return reply


async def save_document(
    env: ToolEnv,
    project_id: UUID,
    layer_project_id: int,
    style_id: str,
    base_rev: int,
    document: dict[str, Any],
) -> dict[str, Any]:
    """Core's answer to a save of ``document`` on the revision it was built
    from: the stored document, its revision and the issues."""
    reply = await env.call(
        "core",
        "PUT",
        f"{styles_path(project_id, layer_project_id)}/{style_id}",
        json_body={"base_rev": base_rev, "document": document},
    )
    if (
        not isinstance(reply, dict)
        or not isinstance(reply.get("document"), dict)
        or revision_of(reply) is None
    ):
        raise ToolFailed(NO_SAVE_ANSWER)
    return reply


async def rename_style(
    env: ToolEnv, project_id: UUID, layer_project_id: int, style_id: str, name: str
) -> None:
    await env.call(
        "core",
        "PATCH",
        f"{styles_path(project_id, layer_project_id)}/{style_id}",
        json_body={"name": name},
    )


async def make_active(
    env: ToolEnv, project_id: UUID, layer_project_id: int, style_id: str
) -> None:
    """The layer draws the style from now on."""
    await env.call(
        "core",
        "PATCH",
        map_state_path(project_id, layer_project_id),
        json_body={"active_style_id": style_id},
    )


def revision_of(reply: Any) -> int | None:
    value = reply.get("revision") if isinstance(reply, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None
