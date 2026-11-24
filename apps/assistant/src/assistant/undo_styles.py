"""The dock's Undo of an answer's style changes.

``style_update`` keeps what takes each landed change back in its audit row
(``tool_call.undo``): for an edited or replaced style the document and the
name before, both revisions and the name the call gave it, when it renamed
it (kind ``style``), for a style it created the style's id and revision
(kind ``style_created``), and for both the style the map drew before, when
the call switched the layer.

Per style, the answer's records are taken together. An edited style gets the
oldest document back in one save on the newest revision the answer left:
core merges that save, so it takes back what the answer changed and keeps
what a person saved afterwards on other paths. Because the same path would
be written over, a style saved since the answer, or between two of its
edits, is asked about first; ``force`` then saves all the same. Once core no
longer keeps the answer's revision (``base_too_old``), the forced save goes
on the current revision, which restores the document whole. A created style
is deleted, after the layer draws the style it drew before again.

What core stored decides whether a style counts as restored, never what was
sent: a save core answers on the revision the style had, with the change
refused, restored nothing.
"""

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from goatlib.style.merge import diff
from pydantic_ai.exceptions import ToolFailed

from assistant.styles.edits import (
    NO_SAVE_ANSWER,
    added_errors,
    holds,
    issue_keys,
    map_state_path,
    revision_of,
    styles_path,
)
from assistant.tools.http import ServiceClients, ServiceError, call_service

logger = logging.getLogger(__name__)

#: The revisions core keeps of a style (its ``KEPT_REVISIONS``). Only read to
#: say, before anything is saved, that core has dropped the answer's revision:
#: what a forced save does follows core's own ``base_too_old``.
KEPT_REVISIONS = 20

NO_STYLE_ANSWER = "Core answered the style without its revision or its document."

_Key = tuple[str, int, str]


@dataclass(frozen=True)
class StyleEdits:
    """One style's edits in an answer, oldest first."""

    project_id: str
    layer_project_id: int
    style_id: str
    #: The audit rows that hold them.
    rows: list[UUID]
    #: The document before the answer's first edit.
    before: dict[str, Any]
    #: The name before the answer's first rename; None when it renamed nothing.
    name_before: str | None
    #: The newest revision the answer left.
    revision: int
    #: Each edit was saved on the revision the one before it left, and no
    #: other save landed within one.
    chained: bool
    undone: bool
    #: An edit moved the revision: the document is restored. Otherwise the
    #: answer only renamed the style or switched the layer to it.
    moved: bool = True
    #: The style the map drew before the answer switched the layer to this one.
    active_before: str | None = None
    #: The name the answer's last rename gave the style. The Undo renames it
    #: back only while it still has this name: a name a person gave it since
    #: stays.
    renamed_to: str | None = None


@dataclass(frozen=True)
class CreatedStyle:
    """A style an answer created, with the answer's later edits of it."""

    project_id: str
    layer_project_id: int
    style_id: str
    #: Its ``style_created`` row and every ``style`` row of the same style.
    rows: list[UUID]
    #: The newest revision the answer left.
    revision: int
    #: The style the map drew before the answer switched the layer to this one.
    active_before: str | None
    undone: bool
    #: The answer's edits of it follow the creation without a save in between.
    chained: bool = True


@dataclass(frozen=True)
class RestoredStyle:
    project_id: str
    layer_project_id: int
    style_id: str
    #: The revision the style has now; None for a removed one.
    revision: int | None
    #: A created style that the Undo deleted.
    removed: bool = False
    #: Core kept its stored value where the old one no longer fits the data.
    partial: bool = False


@dataclass(frozen=True)
class ChangedStyle:
    """A style saved since the answer's changes: the Undo asks first."""

    project_id: str
    layer_project_id: int
    style_id: str
    #: The revision core holds.
    revision: int | None
    #: Saved between two of the answer's edits, not after them.
    between: bool = False
    #: Core no longer keeps the answer's revision: the Undo restores the
    #: document whole, later saves included.
    too_old: bool = False


@dataclass(frozen=True)
class UnrestoredStyle:
    """A style core left as it is, whatever is asked: it stored nothing of the
    restore, or the created style is the layer's last one."""

    project_id: str
    layer_project_id: int
    style_id: str


# ---- the records of an answer, by style ------------------------------------------


def _whole(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _key(record: dict[str, Any]) -> _Key | None:
    project_id, link, style_id = (
        record.get("project_id"),
        _whole(record.get("layer_project_id")),
        record.get("style_id"),
    )
    if not isinstance(project_id, str) or link is None or not isinstance(style_id, str):
        return None
    return project_id, link, style_id


def _is_edit(record: dict[str, Any]) -> bool:
    before = record.get("before")
    return (
        record.get("kind") == "style"
        and _whole(record.get("revision_before")) is not None
        and _whole(record.get("revision_after")) is not None
        and isinstance(before, dict)
        and isinstance(before.get("document"), dict)
    )


def _is_creation(record: dict[str, Any]) -> bool:
    return (
        record.get("kind") == "style_created"
        and _whole(record.get("revision")) is not None
    )


def _chained(start: int | None, records: Sequence[dict[str, Any]]) -> bool:
    """Each record starts on the revision the one before it left (``start``
    for the first) and moves it by one save at most."""
    at = start
    for record in records:
        before, after = record["revision_before"], record["revision_after"]
        if (at is not None and before != at) or after - before not in (0, 1):
            return False
        at = after
    return True


def style_groups(
    records: Sequence[tuple[UUID, dict[str, Any]]],
) -> tuple[list[StyleEdits], list[CreatedStyle]]:
    """The style records of a run by style: the edited styles in the order
    they were first edited, and the created ones in the order they were
    created, each with the answer's later edits of it. Within a style the
    edits are ordered by revision, which only grows; a record without the
    fields an Undo needs is left out."""
    made: dict[_Key, tuple[UUID, dict[str, Any]]] = {}
    edited: dict[_Key, list[tuple[UUID, dict[str, Any]]]] = {}
    #: Per layer, the style it drew before the answer's first switch (the
    #: records come in the order of the calls), and the styles the answer
    #: switched a layer to.
    drawn_first: dict[tuple[str, int], str] = {}
    switched: set[_Key] = set()
    for row, record in records:
        key = _key(record)
        if key is None:
            continue
        if _is_creation(record):
            made.setdefault(key, (row, record))
        elif _is_edit(record):
            edited.setdefault(key, []).append((row, record))
        else:
            continue
        prior = record.get("active_before")
        if isinstance(prior, str):
            drawn_first.setdefault(key[:2], prior)
            switched.add(key)

    def origin(key: _Key) -> str | None:
        """The style the layer goes back to from one the answer switched it
        to: the one it drew before the answer's first switch, whatever the
        answer switched it to on the way."""
        return drawn_first.get(key[:2]) if key in switched else None

    created: list[CreatedStyle] = []
    for key, (row, record) in made.items():
        later = sorted(edited.pop(key, []), key=lambda i: i[1]["revision_before"])
        edits = [item for _, item in later]
        created.append(
            CreatedStyle(
                project_id=key[0],
                layer_project_id=key[1],
                style_id=key[2],
                rows=[row, *(item for item, _ in later)],
                revision=max(
                    [record["revision"], *(item["revision_after"] for item in edits)]
                ),
                active_before=origin(key),
                undone=all("undone_at" in item for item in (record, *edits)),
                chained=_chained(record["revision"], edits),
            )
        )
    found: list[StyleEdits] = []
    for key, rows in edited.items():
        rows.sort(key=lambda item: item[1]["revision_before"])
        edits = [record for _, record in rows]
        renames = [r for r in edits if isinstance(r.get("renamed_to"), str)]
        name = renames[0]["before"].get("name") if renames else None
        found.append(
            StyleEdits(
                project_id=key[0],
                layer_project_id=key[1],
                style_id=key[2],
                rows=[row for row, _ in rows],
                before=edits[0]["before"]["document"],
                name_before=name if isinstance(name, str) else None,
                revision=edits[-1]["revision_after"],
                chained=_chained(None, edits),
                undone=all("undone_at" in record for record in edits),
                moved=any(
                    record["revision_after"] != record["revision_before"]
                    for record in edits
                ),
                active_before=origin(key),
                renamed_to=renames[-1]["renamed_to"] if renames else None,
            )
        )
    return found, created


# ---- core --------------------------------------------------------------------------


def _path(style: StyleEdits | CreatedStyle) -> str:
    return f"{styles_path(style.project_id, style.layer_project_id)}/{style.style_id}"


def _code(error: ServiceError) -> str | None:
    """The code of core's refusal (``{"detail": {"code": ...}}``)."""
    detail = error.body.get("detail") if isinstance(error.body, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


async def _read(
    clients: ServiceClients,
    bearer: str | None,
    style: StyleEdits | CreatedStyle,
    *,
    check: bool,
) -> dict[str, Any] | None:
    """The style as core holds it now, with the check's issues when asked;
    None when the style, or its layer, is no longer in the project."""
    try:
        held = await call_service(
            clients,
            "core",
            "GET",
            _path(style),
            bearer=bearer,
            params={"check": "true"} if check else None,
        )
    except ServiceError as error:
        if error.status == 404:
            return None
        raise
    if not isinstance(held, dict):
        raise ToolFailed(NO_STYLE_ANSWER)
    return held


async def _save(
    clients: ServiceClients,
    bearer: str | None,
    edits: StyleEdits,
    base_rev: int,
    current: int,
) -> dict[str, Any]:
    """Core's answer to a save of the document before on ``base_rev``: the
    stored document, its revision and the issues. A save without an answer
    may have landed all the same: it did when core holds the document on a
    newer revision than ``current``, and that read then stands for the
    answer."""
    try:
        reply = await call_service(
            clients,
            "core",
            "PUT",
            _path(edits),
            bearer=bearer,
            json_body={"base_rev": base_rev, "document": edits.before},
        )
    except ServiceError:
        raise
    except ToolFailed as error:
        failure = error
    else:
        if (
            isinstance(reply, dict)
            and isinstance(reply.get("document"), dict)
            and revision_of(reply) is not None
        ):
            return reply
        failure = ToolFailed(NO_SAVE_ANSWER)
    try:
        held = await _read(clients, bearer, edits, check=True)
    except ToolFailed:
        raise failure from None
    landed = revision_of(held)
    if (
        held is not None
        and landed is not None
        and landed > current
        and isinstance(held.get("document"), dict)
        and await asyncio.to_thread(holds, held["document"], edits.before)
    ):
        return held
    raise failure


async def _switch_back(
    clients: ServiceClients, bearer: str | None, style: StyleEdits | CreatedStyle
) -> None:
    """The layer draws the style it drew before the answer again: only while
    it still draws the answer's style (a user who switched since keeps the
    choice) and the other style still exists. A switch that fails is logged
    and nothing more: the style itself is restored whether it is drawn or not."""
    target = style.active_before
    if target is None or target.lower() == style.style_id.lower():
        return
    try:
        read = await call_service(
            clients,
            "core",
            "GET",
            f"/api/v2/project/{style.project_id}/map",
            bearer=bearer,
        )
        styles = read.get("styles") if isinstance(read, dict) else None
        held = (
            styles.get(str(style.layer_project_id))
            if isinstance(styles, dict)
            else None
        )
        held = held if isinstance(held, dict) else {}
        active, others = held.get("active"), held.get("others")
        drawn = active.get("id") if isinstance(active, dict) else None
        if str(drawn).lower() != style.style_id.lower():
            return
        if target.lower() not in {
            str(other.get("id")).lower()
            for other in (others if isinstance(others, list) else [])
            if isinstance(other, dict)
        }:
            return
        await call_service(
            clients,
            "core",
            "PATCH",
            map_state_path(style.project_id, style.layer_project_id),
            bearer=bearer,
            json_body={"active_style_id": target},
        )
    except ToolFailed as error:
        logger.warning(
            "Undo could not switch layer %s of project %s back to style %s: %s",
            style.layer_project_id,
            style.project_id,
            target,
            error,
        )


def _changed(
    style: StyleEdits | CreatedStyle,
    revision: int | None,
    *,
    between: bool = False,
    too_old: bool = False,
) -> ChangedStyle:
    return ChangedStyle(
        style.project_id,
        style.layer_project_id,
        style.style_id,
        revision,
        between=between,
        too_old=too_old,
    )


def _to_restore(stored: dict[str, Any], before: dict[str, Any]) -> bool:
    """Whether a save of ``before`` would change ``stored``, as core's merge
    sees it: what the server computes is no difference, every value a save
    can write is one."""
    return bool(diff(stored, before))


def _unrestored(style: StyleEdits | CreatedStyle) -> UnrestoredStyle:
    return UnrestoredStyle(style.project_id, style.layer_project_id, style.style_id)


# ---- an edited style ---------------------------------------------------------------


async def _restore_document(
    clients: ServiceClients,
    bearer: str | None,
    edits: StyleEdits,
    held: dict[str, Any],
    current: int,
    force: bool,
) -> tuple[int | None, bool] | ChangedStyle | UnrestoredStyle | None:
    """Saves the document before and judges core's answer: the revision the
    style has now and whether core restored it in part only; else what the
    user is asked about, a style core stored nothing of, or None for a style
    that is gone."""
    known = issue_keys(held.get("issues") or [])
    base = edits.revision
    try:
        try:
            reply = await _save(clients, bearer, edits, base, current)
        except ServiceError as error:
            if not (error.status == 409 and _code(error) == "base_too_old"):
                raise
            if not force:
                return _changed(edits, current, too_old=True)
            # Core no longer keeps the answer's revision: nothing to merge
            # from, so the document goes on the current one, whole.
            base = current
            reply = await _save(clients, bearer, edits, base, current)
    except ServiceError as error:
        if error.status == 404:
            return None
        raise
    saved = revision_of(reply)
    # Errors the style did not have before the save: core kept its stored
    # value where the old one no longer fits the data.
    refused = bool(added_errors(reply.get("issues") or [], known))
    if saved == current:
        # Core stored nothing. Of a save on the revision the style had, that
        # is a restore refused whole; of a merge onto later saves it also is
        # what core answers when nothing of the answer's change is left to
        # take back, so only a refusal it names counts.
        if (base == current or refused) and await asyncio.to_thread(
            _to_restore, reply["document"], edits.before
        ):
            return _unrestored(edits)
        return saved, False
    return saved, refused


async def restore_style(
    clients: ServiceClients, bearer: str | None, edits: StyleEdits, force: bool
) -> RestoredStyle | ChangedStyle | UnrestoredStyle | None:
    """One edited style back as it was before the answer: its document, its
    name and the style the layer draws. Else what the user is asked about, a
    style core stored nothing of, or None for a style that no longer exists:
    nothing is left to take back."""
    held = await _read(clients, bearer, edits, check=edits.moved)
    if held is None:
        return None
    current, document = revision_of(held), held.get("document")
    if current is None or not isinstance(document, dict):
        raise ToolFailed(NO_STYLE_ANSWER)
    revision: int | None = current
    partial = False
    # A document that already is the one before needs no save and no
    # question: an Undo that stopped after its save goes on from here.
    if edits.moved and await asyncio.to_thread(_to_restore, document, edits.before):
        if not (edits.chained and current == edits.revision) and not force:
            return _changed(
                edits,
                current,
                between=not edits.chained,
                too_old=current - edits.revision >= KEPT_REVISIONS,
            )
        outcome = await _restore_document(clients, bearer, edits, held, current, force)
        if not isinstance(outcome, tuple):
            return outcome
        revision, partial = outcome
    if (
        edits.renamed_to is not None
        and edits.name_before is not None
        and edits.name_before != edits.renamed_to
        and held.get("name") == edits.renamed_to
    ):
        try:
            await call_service(
                clients,
                "core",
                "PATCH",
                _path(edits),
                bearer=bearer,
                json_body={"name": edits.name_before},
            )
        except ServiceError as error:
            if error.status == 404:
                return None
            raise
    await _switch_back(clients, bearer, edits)
    return RestoredStyle(
        edits.project_id,
        edits.layer_project_id,
        edits.style_id,
        revision,
        partial=partial,
    )


# ---- a created style ---------------------------------------------------------------


async def remove_created(
    clients: ServiceClients, bearer: str | None, created: CreatedStyle, force: bool
) -> RestoredStyle | ChangedStyle | UnrestoredStyle | None:
    """One created style removed, after the layer draws the style it drew
    before again. Else what the user is asked about (the style was saved
    since the answer), a style core keeps (a layer's last one), or None for
    a style that no longer exists."""
    held = await _read(clients, bearer, created, check=False)
    if held is None:
        return None
    current = revision_of(held)
    if not (created.chained and current == created.revision) and not force:
        return _changed(created, current, between=not created.chained)
    await _switch_back(clients, bearer, created)
    try:
        await call_service(clients, "core", "DELETE", _path(created), bearer=bearer)
    except ServiceError as error:
        if error.status == 404:
            return None
        if error.status == 409 and _code(error) == "last_style":
            # A layer keeps one style. Asked once; asking again changes nothing.
            return _unrestored(created) if force else _changed(created, current)
        raise
    except ToolFailed as failure:
        # No answer: the style may be gone all the same.
        try:
            left = await _read(clients, bearer, created, check=False)
        except ToolFailed:
            raise failure from None
        if left is not None:
            raise
    return RestoredStyle(
        created.project_id,
        created.layer_project_id,
        created.style_id,
        None,
        removed=True,
    )
