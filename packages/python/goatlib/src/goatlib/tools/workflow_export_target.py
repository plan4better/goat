"""Which layer a workflow export node writes into on "Overwrite on re-run".

The result of export node N of workflow W is a slot in W's project: the
``layer_project`` row that shows it. Two stamps identify it, both
``{"workflow_export": {"workflow_id": W, "export_node_id": N}}``:

* ``layer.other_properties`` — the workflow that produced the layer's data.
* ``layer_project.other_properties`` — the workflow whose result this
  project entry shows. Copying a project remaps it to the copied workflow,
  while the copy's entry keeps pointing at the same layer row.

Export node ids are ``export-<uuid4>``, so two workflows share one only when
one was copied from the other.

A layer produced by W is overwritten in place, whoever runs W: the workflow
is the unit, and the caller has already checked the runner may write the
project. A layer W merely inherited (through a project duplicate, a project
template, or an import from before 2026-05-08) is taken over in place only
when no other project shows it and the runner may write it; otherwise the run
writes a new layer and points W's project entry at it, leaving the source
project and the template untouched.

The same holds the other way round. A copy's entry keeps showing the source's
layer until the copy re-runs, so while any copy (or a project template's
frozen copy) still shows W's layer, W's own re-run also writes a new layer
rather than change the copy's. A copy's entry is one stamped for another
workflow, or, for copies made before entries were stamped, one in a project
holding a workflow with the same export node. A project that shows the layer
because someone added it there by hand is no copy: it follows the re-runs.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal

ExportMode = Literal["in_place", "adopt", "copy_on_write"]


@dataclass(frozen=True)
class ExportTarget:
    """Where a re-run writes.

    ``link_id`` is the ``layer_project`` row showing the result in the
    running project, or None when the layer is not in the project (the run
    attaches it again).
    """

    layer_id: str
    link_id: int | None
    mode: ExportMode


@dataclass(frozen=True)
class ExportCandidate:
    """A project entry whose layer or own stamp names the export node."""

    link_id: int
    layer_id: str
    link_workflow_id: str | None
    link_node_id: str | None
    layer_workflow_id: str | None
    linked_elsewhere: bool
    shown_by_copies: bool
    runner_can_write: bool


def choose_export_target(
    candidates: list[ExportCandidate],
    *,
    workflow_id: str,
    export_node_id: str,
    project_workflows: dict[str, bool],
) -> ExportTarget | None:
    """Pick the entry that belongs to ``workflow_id`` and how to write it.

    ``candidates`` come newest first. ``project_workflows`` maps every
    workflow of the project to whether its saved config holds the node.
    """
    holders = [wid for wid, holds in project_workflows.items() if holds]

    def owner(c: ExportCandidate) -> str | None:
        if c.link_workflow_id is not None:
            return c.link_workflow_id if c.link_node_id == export_node_id else None
        # Entries written before they carried a stamp: the layer's own stamp
        # names this project's workflow, or — for a copy made before then —
        # the one workflow here holding the node inherits it. With two holders
        # (a copied workflow and its duplicate) nothing says which, so neither.
        if c.layer_workflow_id in project_workflows:
            return c.layer_workflow_id
        return holders[0] if len(holders) == 1 else None

    mine = next((c for c in candidates if owner(c) == workflow_id), None)
    if mine is None:
        return None
    if mine.layer_workflow_id == workflow_id and not mine.shown_by_copies:
        mode: ExportMode = "in_place"
    elif (
        mine.layer_workflow_id != workflow_id
        and not mine.linked_elsewhere
        and mine.runner_can_write
    ):
        mode = "adopt"
    else:
        mode = "copy_on_write"
    return ExportTarget(layer_id=mine.layer_id, link_id=mine.link_id, mode=mode)


def _shown_by_copies(schema: str, layer: str, project: str) -> str:
    """SQL: a project other than ``project`` shows ``layer`` in a copy's
    entry — one stamped for another workflow than $4, or an unstamped one in
    a project holding a workflow with export node $2."""
    return f"""EXISTS (
        SELECT 1 FROM {schema}.layer_project copied
        WHERE copied.layer_id = {layer}
          AND copied.project_id <> {project}
          AND (
              copied.other_properties -> 'workflow_export' ->> 'workflow_id' <> $4
              OR (
                  copied.other_properties -> 'workflow_export' IS NULL
                  AND EXISTS (
                      SELECT 1 FROM {schema}.workflow w
                      WHERE w.project_id = copied.project_id
                        AND jsonb_path_exists(
                            w.config,
                            '$.nodes[*] ? (@.id == $node)',
                            jsonb_build_object('node', $2::text)
                        )
                  )
              )
          )
    )"""


async def resolve_export_target(
    conn: Any,
    schema: str,
    *,
    user_id: str,
    project_id: str,
    workflow_id: str,
    export_node_id: str,
) -> ExportTarget | None:
    """The layer a re-run of ``export_node_id`` overwrites, or None to
    create a new one. Trashed layers are never targets."""
    rows = await conn.fetch(
        f"""
        SELECT lp.id AS link_id,
               l.id::text AS layer_id,
               lp.other_properties -> 'workflow_export' ->> 'workflow_id'
                   AS link_workflow_id,
               lp.other_properties -> 'workflow_export' ->> 'export_node_id'
                   AS link_node_id,
               l.other_properties -> 'workflow_export' ->> 'workflow_id'
                   AS layer_workflow_id,
               EXISTS (
                   SELECT 1 FROM {schema}.layer_project other
                   WHERE other.layer_id = l.id AND other.project_id <> lp.project_id
               ) AS linked_elsewhere,
               {_shown_by_copies(schema, "l.id", "lp.project_id")} AS shown_by_copies,
               {schema}.layer_write_allowed(l.id, $3) AS runner_can_write
        FROM {schema}.layer_project lp
        JOIN {schema}.layer l ON l.id = lp.layer_id
        WHERE lp.project_id = $1
          AND l.deleted_at IS NULL
          AND (lp.other_properties -> 'workflow_export' ->> 'export_node_id' = $2
               OR l.other_properties -> 'workflow_export' ->> 'export_node_id' = $2)
        ORDER BY l.created_at DESC, lp.id DESC
        """,
        uuid.UUID(project_id),
        export_node_id,
        uuid.UUID(user_id),
        workflow_id,
    )
    if rows:
        workflows = await conn.fetch(
            f"""
            SELECT id::text AS id,
                   jsonb_path_exists(
                       config,
                       '$.nodes[*] ? (@.id == $node)',
                       jsonb_build_object('node', $2::text)
                   ) AS holds_node
            FROM {schema}.workflow
            WHERE project_id = $1
            """,
            uuid.UUID(project_id),
            export_node_id,
        )
        target = choose_export_target(
            [ExportCandidate(**dict(row)) for row in rows],
            workflow_id=workflow_id,
            export_node_id=export_node_id,
            project_workflows={row["id"]: row["holds_node"] for row in workflows},
        )
        if target is not None:
            return target

    # Not in the project any more (the runner removed it): attach the
    # runner's own last result again. Limited to the runner's layers — a
    # layer anyone could stamp must not be pulled into this project — and
    # not while a copy still shows it.
    row = await conn.fetchrow(
        f"""
        SELECT l.id::text AS id FROM {schema}.layer l
        WHERE l.user_id = $1
          AND l.deleted_at IS NULL
          AND l.other_properties -> 'workflow_export' ->> 'workflow_id' = $4
          AND l.other_properties -> 'workflow_export' ->> 'export_node_id' = $2
          AND NOT {_shown_by_copies(schema, "l.id", "$3")}
        ORDER BY l.created_at DESC
        LIMIT 1
        """,
        uuid.UUID(user_id),
        export_node_id,
        uuid.UUID(project_id),
        workflow_id,
    )
    if row is None:
        return None
    return ExportTarget(layer_id=row["id"], link_id=None, mode="in_place")


def _with_stamp(column: str) -> str:
    """SQL for ``column`` with the ``workflow_export`` stamp set from $2/$3.

    An empty ``other_properties`` can be stored as JSON null, a scalar that
    ``||`` refuses to merge into, so anything but an object starts over.
    """
    return (
        f"(CASE WHEN jsonb_typeof({column}) = 'object' THEN {column} "
        "ELSE '{}'::jsonb END) || jsonb_build_object('workflow_export', "
        "jsonb_build_object('workflow_id', $2::text, 'export_node_id', $3::text))"
    )


async def claim_link(
    conn: Any,
    schema: str,
    *,
    project_id: str,
    link_id: int,
    layer_id: str,
    workflow_id: str,
    export_node_id: str,
) -> None:
    """Point the project entry at ``layer_id`` and stamp it as this export
    node's result. The entry keeps its id, name, style, position and filters,
    so dashboards, layouts and dataset nodes referring to it follow along.

    ``layer_id`` takes over the description, tags and column settings of the
    layer the entry showed, as an overwrite in place keeps them: a project
    copy or template documents its outputs, and the first run there must not
    drop that.

    Only an entry of ``project_id`` (the project the run was authorized for)
    is touched; any other raises, so a surrounding transaction rolls back.
    """
    await conn.execute(
        f"""
        UPDATE {schema}.layer AS fresh
        SET description = shown.description,
            tags = shown.tags,
            field_config = shown.field_config
        FROM {schema}.layer_project AS link
        JOIN {schema}.layer AS shown ON shown.id = link.layer_id
        WHERE link.id = $1 AND link.project_id = $3 AND fresh.id = $2
        """,
        link_id,
        uuid.UUID(layer_id),
        uuid.UUID(project_id),
    )
    status = await conn.execute(
        f"""
        UPDATE {schema}.layer_project
        SET layer_id = $4,
            other_properties = {_with_stamp("other_properties")},
            updated_at = NOW()
        WHERE id = $1 AND project_id = $5
        """,
        link_id,
        workflow_id,
        export_node_id,
        uuid.UUID(layer_id),
        uuid.UUID(project_id),
    )
    if status != "UPDATE 1":
        raise ValueError(f"Project entry {link_id} is not in project {project_id}")


async def restamp_layer(
    conn: Any, schema: str, *, layer_id: str, workflow_id: str, export_node_id: str
) -> None:
    """Record ``workflow_id`` as the producer of a layer it took over."""
    await conn.execute(
        f"""
        UPDATE {schema}.layer
        SET other_properties = {_with_stamp("other_properties")}
        WHERE id = $1
        """,
        uuid.UUID(layer_id),
        workflow_id,
        export_node_id,
    )


@asynccontextmanager
async def export_lock(
    conn: Any, *, workflow_id: str, export_node_id: str
) -> AsyncIterator[None]:
    """Hold off other runs of the same export node until this one is done.

    A transaction-level advisory lock, so it works through a transaction
    pooler; it pins one connection for as long as the block runs.
    """
    async with conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            f"workflow_export:{workflow_id}:{export_node_id}",
        )
        yield
