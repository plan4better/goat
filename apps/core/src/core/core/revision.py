"""Revisions of the documents people edit and autosave: workflows, report
layouts and a project's dashboard (`builder_config`).

Each document carries a revision counter (`revision`, for the dashboard
`project.builder_revision`). A save sends the revision it read as
`base_revision` and the outcome depends on what it changes:

- nothing: nothing is written;
- only volatile parts (viewport, selection, run state, editor-only toggles,
  see the `significant_*` functions): written in place, with no new revision
  and no check of `base_revision`, so panning or a finished run in one tab
  never turns another tab's next real save into a conflict;
- anything else: one UPDATE raises the revision by one where it still equals
  `base_revision`. No row means another save landed first: 409
  `changed_elsewhere` and nothing is written. Without `base_revision` the save
  lands anyway (last write wins) and a warning is logged.

The engine runs in AUTOCOMMIT, so every write here is a single statement.
"""

import json
import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Table, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from core.db.models.user import User

logger = logging.getLogger(__name__)

#: Workflow config keys the editor rewrites on every pan and zoom.
WORKFLOW_VOLATILE = frozenset({"viewport"})
#: Keys of a workflow step that only React Flow reads (selection and drag
#: state, drawing order, size, style). The editor never saves them.
WORKFLOW_NODE_VOLATILE = frozenset(
    {"selected", "dragging", "zIndex", "width", "height", "style"}
)
#: Keys of a step's `data` that hold the state of its last run.
WORKFLOW_NODE_DATA_VOLATILE = frozenset(
    {"status", "jobId", "error", "outputLayerId", "exportedLayerId", "activeHandle"}
)
#: Keys of a report layout's `page` that only change how the editor shows it.
REPORT_LAYOUT_PAGE_VOLATILE = frozenset({"snapToGuides", "showRulers"})


def _without(value: Any, keys: frozenset[str]) -> Any:
    if not isinstance(value, dict):
        return value
    return {k: v for k, v in value.items() if k not in keys}


def _significant_node(node: Any) -> Any:
    node = _without(node, WORKFLOW_NODE_VOLATILE)
    if isinstance(node, dict) and isinstance(node.get("data"), dict):
        node = {**node, "data": _without(node["data"], WORKFLOW_NODE_DATA_VOLATILE)}
    return node


def _node_order(node: Any) -> tuple[str, str]:
    """Steps by id; the JSON orders steps without one or sharing one."""
    node_id = node.get("id") if isinstance(node, dict) else None
    return str(node_id), json.dumps(node, sort_keys=True, default=str)


def _significant_edge(edge: Any) -> Any:
    """The connection without an empty handle, which the editor leaves out."""
    if not isinstance(edge, dict):
        return edge
    return {
        k: v
        for k, v in edge.items()
        if not (k in ("sourceHandle", "targetHandle") and (v is None or v == ""))
    }


def significant_workflow_config(config: Any) -> Any:
    """The workflow config without its viewport, selection and run state, in
    the form the editor saves any config it loaded: the steps in any order
    (it draws notes first), no React Flow keys, no empty connection handles,
    `variables` as a list.

    A stored config may be damaged (`goatlib.workflows.checks.shape_issues`);
    whatever does not have the expected shape is compared as it is.
    """
    config = _without(config, WORKFLOW_VOLATILE)
    if not isinstance(config, dict):
        return config
    if isinstance(config.get("nodes"), list):
        nodes = [_significant_node(n) for n in config["nodes"]]
        config["nodes"] = sorted(nodes, key=_node_order)
    if isinstance(config.get("edges"), list):
        config["edges"] = [_significant_edge(e) for e in config["edges"]]
    if config.get("variables") is None:
        config["variables"] = []
    return config


def significant_report_layout_config(config: Any) -> Any:
    """The layout config without the editor's view toggles."""
    if isinstance(config, dict) and isinstance(config.get("page"), dict):
        config = {
            **config,
            "page": _without(config["page"], REPORT_LAYOUT_PAGE_VOLATILE),
        }
    return config


def significant_builder_config(config: Any) -> Any:
    """The dashboard config as it is: it holds no view state (the builder
    keeps its selection in the browser)."""
    return config


class ChangedElsewhereError(Exception):
    """A save made on an older revision than the stored one. Answered as 409
    with the stored revision and who made it (`core.main`)."""

    def __init__(
        self,
        revision: int,
        updated_at: datetime | None,
        updated_by: dict[str, Any] | None,
    ) -> None:
        super().__init__("changed_elsewhere")
        self.revision = revision
        self.updated_at = updated_at
        self.updated_by = updated_by

    def content(self) -> dict[str, Any]:
        return {
            "detail": "changed_elsewhere",
            "revision": self.revision,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "updated_by": self.updated_by,
        }


#: The 409 in the OpenAPI document of every route that saves with a revision.
CHANGED_ELSEWHERE_RESPONSE: dict[int | str, dict[str, Any]] = {
    409: {
        "description": (
            "Saved on an older revision: the stored revision, when and by "
            "whom it was made. Nothing was written."
        ),
        "content": {
            "application/json": {
                "example": {
                    "detail": "changed_elsewhere",
                    "revision": 4,
                    "updated_at": "2026-10-25T09:12:03.120000+00:00",
                    "updated_by": {
                        "id": "744e4fd1-685c-495c-8b02-efebce875359",
                        "firstname": "Ada",
                        "lastname": "Lovelace",
                        "avatar": None,
                    },
                }
            }
        },
    }
}


async def _read(
    async_session: AsyncSession, table: Table, where: Sequence[ColumnElement[bool]]
) -> dict[str, Any] | None:
    row = (await async_session.execute(select(table).where(*where))).first()
    return None if row is None else dict(row._mapping)


async def _write(
    async_session: AsyncSession,
    table: Table,
    where: Sequence[ColumnElement[bool]],
    values: Mapping[str, Any],
) -> dict[str, Any] | None:
    result = await async_session.execute(
        update(table).where(*where).values(dict(values)).returning(*table.c)
    )
    row = result.first()
    await async_session.commit()
    return None if row is None else dict(row._mapping)


async def _changed_elsewhere(
    async_session: AsyncSession,
    table: Table,
    where: Sequence[ColumnElement[bool]],
    revision: str,
) -> ChangedElsewhereError | None:
    """The conflict to answer with, from the row as stored now; None when
    the row is gone."""
    # SQLModel adds `__table__` at class creation, which mypy cannot see.
    user: Table = getattr(User, "__table__")
    row = (
        await async_session.execute(
            select(
                table.c[revision],
                table.c.updated_at,
                user.c.id,
                user.c.firstname,
                user.c.lastname,
                user.c.avatar,
            )
            .select_from(table.outerjoin(user, user.c.id == table.c.updated_by))
            .where(*where)
        )
    ).first()
    if row is None:
        return None
    current, updated_at, user_id, firstname, lastname, avatar = row
    updated_by = (
        None
        if user_id is None
        else {
            "id": str(user_id),
            "firstname": firstname,
            "lastname": lastname,
            "avatar": avatar,
        }
    )
    return ChangedElsewhereError(current, updated_at, updated_by)


async def save_change(
    async_session: AsyncSession,
    *,
    table: Table,
    where: Sequence[ColumnElement[bool]],
    values: Mapping[str, Any],
    revision: str,
    user_id: UUID,
    base_revision: int | None,
    document: str,
) -> dict[str, Any] | None:
    """Write `values` as a new revision of the row `where` selects: one
    UPDATE that raises `revision` by one where it still equals
    `base_revision`, and records `user_id` as the one who saved.

    Returns the row as stored now, or None when there is no such row.
    Raises ChangedElsewhereError when the stored revision is another one.
    """
    if base_revision is None:
        logger.warning(
            "%s saved without base_revision: the save is not checked", document
        )
        conditions = list(where)
    else:
        conditions = [*where, table.c[revision] == base_revision]
    row = await _write(
        async_session,
        table,
        conditions,
        {**values, revision: table.c[revision] + 1, "updated_by": user_id},
    )
    if row is not None or base_revision is None:
        return row
    conflict = await _changed_elsewhere(async_session, table, where, revision)
    if conflict is None:
        return None
    raise conflict


#: How often a save that changes only volatile parts is decided again when a
#: real change lands between its read and its write.
_ATTEMPTS = 3


async def save(
    async_session: AsyncSession,
    *,
    table: Table,
    where: Sequence[ColumnElement[bool]],
    values: Mapping[str, Any],
    significant: Callable[[Mapping[str, Any]], Any],
    revision: str,
    user_id: UUID,
    base_revision: int | None,
    document: str,
) -> dict[str, Any] | None:
    """Save `values` into the row `where` selects, as the module docstring
    describes. `significant` reads a whole row (the stored one, or the stored
    one with `values` applied) without its volatile parts.

    Returns the row as stored now, or None when there is no such row.
    Raises ChangedElsewhereError.
    """
    for _ in range(_ATTEMPTS):
        stored = await _read(async_session, table, where)
        if stored is None:
            return None
        saved = {**stored, **values}
        if saved == stored:
            return stored
        if significant(saved) != significant(stored):
            return await save_change(
                async_session,
                table=table,
                where=where,
                values=values,
                revision=revision,
                user_id=user_id,
                base_revision=base_revision,
                document=document,
            )
        # Only volatile parts differ: written in place, keeping the revision,
        # the time and the author of the last change. The write checks the
        # revision just compared with, so a change that raised the revision
        # since is never overwritten; the save is then decided again against
        # it.
        row = await _write(
            async_session,
            table,
            [*where, table.c[revision] == stored[revision]],
            {**values, "updated_at": table.c.updated_at},
        )
        if row is not None:
            return row
    conflict = await _changed_elsewhere(async_session, table, where, revision)
    if conflict is None:
        return None
    raise conflict
