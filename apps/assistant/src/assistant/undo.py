"""The dock's Undo of what an answer changed: its workflow edits, its
style changes (``assistant.undo_styles``) and its changes of the map
(``assistant.undo_map``).

A write tool keeps what takes each landed change back in its audit row
(``tool_call.undo``), by kind. Undo writes that back through core, under the
user's own sign-in, so core decides whether they may still change the
project. The rows of every kind are marked under way together, before the
first write, and each group of them (a workflow, a style, a project's map)
is marked undone once it went back, or freed again when it did not.

``workflow_update`` keeps each landed edit's before-content and revisions.

Per workflow, the answer's records are taken together: the oldest
before-content is saved on the newest record's ``revision_after``. Saving
record by record, newest first, would make the second save a conflict with
the first. When the records do not chain (a save landed between two of the
answer's edits), and when core reports a save after the answer's last edit,
the user is asked first: ``force`` then saves on top of the revision core
holds. A record under way is marked (``undoing_at``), and one whose change
went back too (``undone_at``), so a second Undo of it is refused and one at
the same time is told it is under way.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from pydantic_ai.exceptions import ToolFailed

from assistant.repo import Repository
from assistant.tools.http import ServiceClients, ServiceError, call_service
from assistant.undo_map import (
    ChangedMap,
    MapChanges,
    RestoredMap,
    map_groups,
    restore_map,
)
from assistant.undo_styles import (
    ChangedStyle,
    CreatedStyle,
    RestoredStyle,
    StyleEdits,
    UnrestoredStyle,
    remove_created,
    restore_style,
    style_groups,
)


@dataclass(frozen=True)
class WorkflowEdits:
    """One workflow's edits in an answer, oldest first."""

    workflow_id: str
    project_id: str
    #: The audit rows that hold them.
    rows: list[UUID]
    #: The content before the answer's first edit.
    before: dict[str, Any]
    #: The revision the answer's last edit left.
    revision: int
    #: Each edit was made on the revision the one before it left.
    chained: bool
    undone: bool


def _revision(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def workflow_edits(
    records: Sequence[tuple[UUID, dict[str, Any]]],
) -> list[WorkflowEdits]:
    """The records of a run by workflow, in the order the workflows were
    first edited. Within a workflow they are ordered by revision, which only
    grows; a record without the fields an Undo needs is left out."""
    grouped: dict[str, list[tuple[UUID, dict[str, Any]]]] = {}
    for row, record in records:
        before = record.get("before")
        if (
            record.get("kind") != "workflow"
            or not isinstance(record.get("workflow_id"), str)
            or not isinstance(record.get("project_id"), str)
            or _revision(record.get("revision_before")) is None
            or _revision(record.get("revision_after")) is None
            or not isinstance(before, dict)
            or not isinstance(before.get("config"), dict)
        ):
            continue
        grouped.setdefault(record["workflow_id"], []).append((row, record))
    found: list[WorkflowEdits] = []
    for workflow_id, rows in grouped.items():
        rows.sort(key=lambda item: item[1]["revision_before"])
        records_ = [record for _, record in rows]
        found.append(
            WorkflowEdits(
                workflow_id=workflow_id,
                project_id=records_[0]["project_id"],
                rows=[row for row, _ in rows],
                before=records_[0]["before"]["config"],
                revision=records_[-1]["revision_after"],
                chained=all(
                    later["revision_before"] == earlier["revision_after"]
                    for earlier, later in zip(records_, records_[1:], strict=False)
                ),
                undone=all("undone_at" in record for record in records_),
            )
        )
    return found


@dataclass(frozen=True)
class Restored:
    workflow_id: str
    project_id: str
    #: The revision the Undo's save gave the workflow; None when core named
    #: none, not even on a read after the save.
    revision: int | None


@dataclass(frozen=True)
class Changed:
    """A workflow saved since the answer's edits: the Undo asks first."""

    workflow_id: str
    project_id: str
    #: The revision core holds, when its answer named it.
    revision: int | None
    updated_at: str | None
    updated_by: dict[str, Any] | None
    #: Saved between two of the answer's edits, not after them.
    between: bool = False


@dataclass(frozen=True)
class UndoOutcome:
    """What one Undo did, kind by kind: what went back, and what the user is
    asked about first."""

    #: Workflows.
    restored: list[Restored]
    changed: list[Changed]
    styles: list[RestoredStyle] = field(default_factory=list)
    changed_styles: list[ChangedStyle] = field(default_factory=list)
    #: What did not come back and is not asked about, by a word per kind of
    #: thing: "style" for a style core stored nothing of, "layer_removed" for
    #: a layer the answer removed, "group_in_use" for a group it added that
    #: holds something now, "map_refused" for a change of the map core
    #: refused to take back.
    not_restored: list[str] = field(default_factory=list)
    #: The map, per project.
    maps: list[RestoredMap] = field(default_factory=list)
    changed_map: list[ChangedMap] = field(default_factory=list)


#: What an Undo takes back as one: the records of one workflow, of one style,
#: or of one project's map.
UndoGroup = WorkflowEdits | CreatedStyle | StyleEdits | MapChanges


def _removals_only(group: MapChanges) -> bool:
    """Whether a project's map changes are removed layers alone, which no
    Undo brings back."""
    return all(change["object"] == "layer_removed" for change in group.changes)


def undo_groups(records: Sequence[tuple[UUID, dict[str, Any]]]) -> list[UndoGroup]:
    """The records of a run as the Undo takes them back, in its order:
    workflows, then created styles, then edited styles, then the map. A
    project's map whose newest change is newer than every style change comes
    before the styles instead: its switch of a layer's style goes back to
    the style the answer made active, which the style's Undo then takes back
    to the one the layer drew before the answer (a style the answer created
    still exists while the map goes back to it). A record no kind takes is
    left out, and so are a project's map changes that are removed layers
    alone: nothing of them comes back."""
    edited, created = style_groups(records)
    styles: list[CreatedStyle | StyleEdits] = [*created, *edited]
    maps = [group for group in map_groups(records) if not _removals_only(group)]
    made = {row: index for index, (row, _) in enumerate(records)}

    def newest(group: CreatedStyle | StyleEdits | MapChanges) -> int:
        return max(made.get(row, -1) for row in group.rows)

    last_style = max((newest(group) for group in styles), default=-1)
    first = [group for group in maps if newest(group) > last_style]
    then = [group for group in maps if newest(group) <= last_style]
    return [*workflow_edits(records), *first, *styles, *then]


def _layers_removed(records: Sequence[tuple[UUID, dict[str, Any]]]) -> bool:
    return any(
        change["object"] == "layer_removed"
        for group in map_groups(records)
        for change in group.changes
    )


class UndoRefused(Exception):  # noqa: N818
    """Core refused the save: ``code`` is what the dock names."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class UndoUnderWay(Exception):  # noqa: N818
    """Another request is undoing the same edits right now."""


class NothingToUndo(Exception):  # noqa: N818
    """The run changed nothing an Undo takes back, or all of it was undone
    already. ``removed``: what it changed is removed layers alone."""

    def __init__(self, undone: bool, removed: bool = False) -> None:
        super().__init__("already undone" if undone else "nothing to undo")
        self.undone = undone
        self.removed = removed


NOT_ALLOWED = (
    "You cannot change this project's content, so these changes cannot be undone."
)
SIGNED_OUT = "Your sign-in expired. Sign in again."
UNAVAILABLE = "The changes could not be undone right now. Try again later."


def _changed(edits: WorkflowEdits, error: ServiceError | None) -> Changed:
    """Without core's conflict answer: a save between the answer's edits."""
    body = error.body if error is not None and isinstance(error.body, dict) else {}
    updated_at = body.get("updated_at")
    updated_by = body.get("updated_by")
    return Changed(
        workflow_id=edits.workflow_id,
        project_id=edits.project_id,
        revision=_revision(body.get("revision")),
        updated_at=updated_at if isinstance(updated_at, str) else None,
        updated_by=updated_by if isinstance(updated_by, dict) else None,
        between=error is None,
    )


def _conflict(error: ServiceError) -> bool:
    # Core's database errors answer 409 too: only its revision check names
    # changed_elsewhere.
    return error.status == 409 and error.detail == "changed_elsewhere"


def _path(edits: WorkflowEdits) -> str:
    return f"/api/v2/project/{edits.project_id}/workflow/{edits.workflow_id}"


async def _read(
    clients: ServiceClients, bearer: str | None, edits: WorkflowEdits
) -> dict[str, Any] | None:
    """The workflow as core holds it now, None when it cannot be read."""
    try:
        row = await call_service(clients, "core", "GET", _path(edits), bearer=bearer)
    except ToolFailed:
        return None
    return row if isinstance(row, dict) else None


async def _save(
    clients: ServiceClients,
    bearer: str | None,
    edits: WorkflowEdits,
    revision: int,
) -> int | None:
    """The revision the save gave the workflow: from core's answer, else read
    back; None when neither names it (never guessed)."""
    try:
        row = await call_service(
            clients,
            "core",
            "PUT",
            _path(edits),
            bearer=bearer,
            json_body={"config": edits.before, "base_revision": revision},
        )
    except ServiceError:
        raise
    except ToolFailed:
        # No answer in time: the save may have landed all the same. It did
        # when core holds the content sent on a newer revision.
        stored = await _read(clients, bearer, edits)
        landed = _revision(stored.get("revision")) if stored else None
        if stored and landed is not None and landed > revision:
            if stored.get("config") == edits.before:
                return landed
        raise
    saved = _revision(row.get("revision")) if isinstance(row, dict) else None
    if saved is not None:
        return saved
    stored = await _read(clients, bearer, edits)
    return _revision(stored.get("revision")) if stored else None


async def _restore(
    clients: ServiceClients, bearer: str | None, edits: WorkflowEdits, force: bool
) -> Restored | Changed | None:
    """One workflow's content back, what the user is asked about, or None
    for a workflow that no longer exists: nothing is left to take back."""
    if not edits.chained and not force:
        return _changed(edits, None)
    try:
        revision = await _save(clients, bearer, edits, edits.revision)
    except ServiceError as error:
        if error.status == 404:
            return None
        if not _conflict(error):
            raise
        current = _changed(edits, error)
        if not force or current.revision is None:
            return current
        try:
            revision = await _save(clients, bearer, edits, current.revision)
        except ServiceError as again:
            if not _conflict(again):
                raise
            # Saved once more in between: asked again.
            return _changed(edits, again)
    return Restored(edits.workflow_id, edits.project_id, revision)


def _refusal(error: ServiceError) -> UndoRefused:
    if error.status == 401 and error.token_expired:
        return UndoRefused(401, "login_failed", SIGNED_OUT)
    if error.status in (401, 403):
        return UndoRefused(403, "undo_not_allowed", NOT_ALLOWED)
    return UndoRefused(503, "undo_unavailable", UNAVAILABLE)


async def _take_back(
    clients: ServiceClients,
    bearer: str | None,
    group: UndoGroup,
    force: bool,
    outcome: UndoOutcome,
) -> bool:
    """Takes one group back and notes in ``outcome`` how it went. Whether
    its rows are done with: a workflow or a style that is gone counts, since
    nothing is left to undo; one the user is asked about, or that did not
    come back, does not. A map's rows are done with once nothing of it is
    left to ask about."""
    if isinstance(group, WorkflowEdits):
        workflow = await _restore(clients, bearer, group, force)
        if isinstance(workflow, Changed):
            outcome.changed.append(workflow)
            return False
        if workflow is not None:
            outcome.restored.append(workflow)
        return True
    if isinstance(group, MapChanges):
        went_back, asked = await restore_map(clients, bearer, group, force)
        outcome.changed_map.extend(asked)
        if went_back is not None:
            outcome.maps.append(went_back)
            outcome.not_restored.extend(
                word
                for word in went_back.not_restored
                if word not in outcome.not_restored
            )
        return not asked
    if isinstance(group, CreatedStyle):
        style = await remove_created(clients, bearer, group, force)
    else:
        style = await restore_style(clients, bearer, group, force)
    if isinstance(style, ChangedStyle):
        outcome.changed_styles.append(style)
        return False
    if isinstance(style, UnrestoredStyle):
        if "style" not in outcome.not_restored:
            outcome.not_restored.append("style")
        return False
    if style is not None:
        outcome.styles.append(style)
    return True


async def undo_run(
    repo: Repository,
    clients: ServiceClients,
    bearer: str | None,
    run_id: UUID,
    *,
    force: bool,
) -> UndoOutcome:
    """Writes back what the run's changes replaced, group by group
    (``undo_groups``). Every row not yet undone is marked under way in one
    step before the first write, so of two requests at once one writes and
    the other is told it is under way. A group's mark becomes "undone" when
    it went back and is taken off when it did not, as are the marks of the
    groups a refusal kept the Undo from reaching."""
    records = await repo.undo_records(run_id)
    groups = undo_groups(records)
    pending = _pending(groups)
    if not pending:
        raise NothingToUndo(undone=bool(groups), removed=_layers_removed(records))
    wanted = [row for group in pending for row in group.rows]
    held = await repo.claim_undo(wanted)
    if len(held) != len(wanted):
        # Another request took them: done by now, or under way.
        if held:
            await repo.release_undo(held)
        now = undo_groups(await repo.undo_records(run_id))
        if all(group.undone for group in now):
            raise NothingToUndo(undone=True)
        raise UndoUnderWay()
    # A removal beside what goes back is named, as nothing brings it back.
    outcome = UndoOutcome(
        restored=[],
        changed=[],
        not_restored=["layer_removed"] if _layers_removed(records) else [],
    )
    try:
        for group in pending:
            kept = False
            try:
                kept = await _take_back(clients, bearer, group, force, outcome)
            except ServiceError as error:
                raise _refusal(error) from error
            except ToolFailed as error:
                # Core did not answer in time, or could not be reached.
                raise UndoRefused(503, "undo_unavailable", UNAVAILABLE) from error
            finally:
                held = [row for row in held if row not in group.rows]
                if kept:
                    await repo.finish_undo(group.rows)
                else:
                    await repo.release_undo(group.rows)
    finally:
        if held:
            await repo.release_undo(held)
    return outcome


def _pending(groups: list[UndoGroup]) -> list[UndoGroup]:
    """The groups an Undo takes back now: those not undone yet."""
    return [group for group in groups if not group.undone]


def undoable(records: Sequence[tuple[UUID, dict[str, Any]]]) -> bool:
    """Whether an answer's Undo has something to take back: ``undo_run``
    answers ``NothingToUndo`` exactly when this is false, so an answer whose
    changes are removed layers alone, or were all undone, is not undoable."""
    return bool(_pending(undo_groups(records)))


def undone(records: Sequence[tuple[UUID, dict[str, Any]]]) -> bool:
    """Whether an answer reads Undone: every change an Undo takes went back.
    The same records as ``undo_run`` reads, by the same rule."""
    groups = undo_groups(records)
    return bool(groups) and all(group.undone for group in groups)
