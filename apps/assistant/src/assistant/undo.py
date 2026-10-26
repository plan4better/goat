"""The dock's Undo of an answer's workflow edits.

``workflow_update`` keeps each landed edit's before-content and revisions in
its audit row (``tool_call.undo``). Undo writes the content back through
core's save, under the user's own sign-in, so core decides whether they may
still change the workflow.

Per workflow, the answer's records are taken together: the oldest
before-content is saved on the newest record's ``revision_after``. Saving
record by record, newest first, would make the second save a conflict with
the first. When the records do not chain (a save landed between two of the
answer's edits), and when core reports a save after the answer's last edit,
the user is asked first: ``force`` then saves on top of the revision core
holds. A workflow under way is marked in its records (``undoing_at``), and
one that went back too (``undone_at``), so a second Undo of it is refused
and one at the same time is told it is under way.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic_ai.exceptions import ToolFailed

from assistant.repo import Repository
from assistant.tools.http import ServiceClients, ServiceError, call_service


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
    restored: list[Restored]
    changed: list[Changed]


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
    """The run has no edits, or all of them were undone already."""

    def __init__(self, undone: bool) -> None:
        super().__init__("already undone" if undone else "nothing to undo")
        self.undone = undone


NOT_ALLOWED = "You cannot change this workflow, so its changes cannot be undone."
SIGNED_OUT = "Your sign-in expired. Sign in again."
UNAVAILABLE = "The workflow could not be saved right now. Try again later."


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


async def undo_run(
    repo: Repository,
    clients: ServiceClients,
    bearer: str | None,
    run_id: UUID,
    *,
    force: bool,
) -> UndoOutcome:
    """Writes back what the run's edits replaced, workflow by workflow. Each
    workflow is marked under way before its save; the mark becomes "undone"
    when the save landed and is taken off when it did not, so of two
    requests at once one saves and the other is told it is under way."""
    edits = workflow_edits(await repo.undo_records(run_id))
    pending = [item for item in edits if not item.undone]
    if not pending:
        raise NothingToUndo(undone=bool(edits))
    restored: list[Restored] = []
    changed: list[Changed] = []
    claimed_any = False
    for item in pending:
        claimed = await repo.claim_undo(item.rows)
        if len(claimed) != len(item.rows):
            # Another request took this workflow.
            await repo.release_undo(claimed)
            continue
        claimed_any = True
        kept = False
        try:
            outcome = await _restore(clients, bearer, item, force)
            # A workflow that is gone counts as undone: nothing is left to undo.
            kept = not isinstance(outcome, Changed)
        except ServiceError as error:
            raise _refusal(error) from error
        except ToolFailed as error:
            # Core did not answer in time, or could not be reached.
            raise UndoRefused(503, "undo_unavailable", UNAVAILABLE) from error
        finally:
            if kept:
                await repo.finish_undo(claimed)
            else:
                await repo.release_undo(claimed)
        if isinstance(outcome, Changed):
            changed.append(outcome)
        elif outcome is not None:
            restored.append(outcome)
    if not claimed_any:
        # Every workflow was taken by another request: done by now, or under way.
        now = workflow_edits(await repo.undo_records(run_id))
        if all(item.undone for item in now):
            raise NothingToUndo(undone=True)
        raise UndoUnderWay()
    return UndoOutcome(restored=restored, changed=changed)


def undone(records: Sequence[tuple[UUID, dict[str, Any]]]) -> bool:
    """Whether an answer reads Undone: every edit an Undo takes went back.
    The same records as ``undo_run`` reads, by the same rule."""
    edits = workflow_edits(records)
    return bool(edits) and all(item.undone for item in edits)
