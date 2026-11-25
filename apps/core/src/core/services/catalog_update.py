"""Moving a project's catalog layer or catalog bundle to the catalog's newer version, in place."""

import copy
import json
import logging
from typing import Any
from uuid import UUID

from core.core.config import settings
from core.db.session import AsyncSession
from core.services.catalog_promote import (
    bundle_versions_of,
    catalog_connection,
    catalog_mirror,
    promote_catalog_items,
    refuse_unaddable,
)
from core.services.processes import submit_each
from core.services.style import (
    StyleSaveError,
    read_default,
    read_stored,
    write_document,
)
from core.templates.snapshot import _rewrite_tool_configs
from fastapi import HTTPException, status
from goatlib.catalog import promote as catalog
from goatlib.catalog.item import layer_type
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)


def _refuse(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _without_computed(node: Any) -> Any:
    """A style document without its `computed` blocks: the system writes those
    (values, stamps, `no_data`), the user never does."""
    if isinstance(node, dict):
        return {k: _without_computed(v) for k, v in node.items() if k != "computed"}
    if isinstance(node, list):
        return [_without_computed(v) for v in node]
    return node


def _same_kind(layer: Any, item: dict[str, Any]) -> bool:
    """The new version is still the same kind of layer (type and geometry), so the
    entry's style and filter still fit it."""
    kind, geometry = layer_type(item)
    return (str(layer.type), str(layer.geometry or "") or None) == (kind, geometry)


async def _repoint(
    async_session: AsyncSession, *, link_id: int, old_layer_id: UUID, new_layer_id: UUID
) -> bool:
    """Point the entry at the new layer, only from the layer it was read on (an
    update that got there first wins). What the entry copied from its layer when it
    was added follows the new layer; keys the project set itself stay."""
    schema = settings.SCHEMA
    moved = await async_session.execute(
        text(
            f"""
            UPDATE {schema}.layer_project lp SET
                layer_id = :new,
                other_properties = coalesce(n.other_properties, '{{}}'::jsonb)
                    || (coalesce(lp.other_properties, '{{}}'::jsonb) - ARRAY(
                        SELECT jsonb_object_keys(coalesce(o.other_properties, '{{}}'::jsonb))
                    ))
            FROM {schema}.layer n, {schema}.layer o
            WHERE lp.id = :id AND lp.layer_id = :old AND n.id = :new AND o.id = :old
            """
        ),
        {"id": link_id, "old": old_layer_id, "new": new_layer_id},
    )
    return bool(moved.rowcount)


async def _left_behind(
    async_session: AsyncSession,
    *,
    old_layer_ids: list[UUID],
    leaving: list[int],
    old_bundle_id: UUID | None = None,
    group_id: int | None = None,
) -> None:
    """The old version's grace period in the catalog cleanup starts now, when it
    loses its last entries (`leaving`), not at its last promotion. A layer or
    bundle another entry or group still holds keeps its update time, a cache key
    elsewhere. Runs before the entries move, so a cleanup in between never sees
    the old time on a version without entries."""
    schema = settings.SCHEMA
    await async_session.execute(
        text(
            f"""
            UPDATE {schema}.layer l SET updated_at = now()
            WHERE l.id = ANY(:ids) AND NOT EXISTS (
                SELECT 1 FROM {schema}.layer_project lp
                WHERE lp.layer_id = l.id AND lp.id <> ALL(:leaving)
            )
            """
        ),
        {"ids": old_layer_ids, "leaving": leaving},
    )
    if old_bundle_id is not None:
        await async_session.execute(
            text(
                f"""
                UPDATE {schema}.bundle b SET updated_at = now()
                WHERE b.id = :id AND NOT EXISTS (
                    SELECT 1 FROM {schema}.layer_project_group g
                    WHERE g.bundle_id = b.id AND g.id <> :group
                )
                """
            ),
            {"id": old_bundle_id, "group": group_id},
        )


def _dataset_data(config: Any) -> list[dict[str, Any]]:
    """The `data` of each dataset node in a workflow config."""
    nodes = config.get("nodes") if isinstance(config, dict) else None
    if not isinstance(nodes, list):
        return []
    return [
        node["data"]
        for node in nodes
        if isinstance(node, dict)
        and isinstance(node.get("data"), dict)
        and node["data"].get("type") == "dataset"
    ]


def _moved_nodes(
    config: dict[str, Any], new_of: dict[int, str]
) -> tuple[dict[str, Any], dict[str, str]]:
    """A copy of `config` with every dataset node of a moved entry on the entry's
    new layer, as a worker's rewrite after a run moves them (a node left on an
    earlier version moves too), and the layer ids those nodes held, each with the
    new id."""
    config = copy.deepcopy(config)
    held: dict[str, str] = {}
    for data in _dataset_data(config):
        link_id = data.get("projectLayerId")
        if not isinstance(link_id, int) or isinstance(link_id, bool):
            continue
        new = new_of.get(link_id)
        old = data.get("layerId")
        if new is None or old == new:
            continue
        data["layerId"] = new
        if isinstance(old, str):
            held[old] = new
    return config, held


def _rewritten(
    config: Any, new_of: dict[int, str], pairs: dict[str, str]
) -> dict[str, Any] | None:
    """`config` with the moved entries' dataset nodes on their new layers and the
    tool settings holding an old id of `pairs` rewritten (the editor's "Replace
    datasets" rewrite); None if nothing changed. An id a dataset node still reads
    stays in tool settings: it may mean that node's layer."""
    if not isinstance(config, dict):
        return None
    moved, _ = _moved_nodes(config, new_of)
    still_read = {
        data["layerId"]
        for data in _dataset_data(moved)
        if isinstance(data.get("layerId"), str)
    }
    _rewrite_tool_configs(
        moved["nodes"] if isinstance(moved.get("nodes"), list) else [],
        [(old, new) for old, new in pairs.items() if old not in still_read],
    )
    return moved if moved != config else None


async def _follow_in_workflows(
    async_session: AsyncSession,
    *,
    project_id: UUID,
    moves: dict[int, tuple[UUID, UUID]],
    user_id: UUID,
) -> None:
    """The project's workflows read the moved entries' new layers. Runs resolve a
    dataset node through its entry anyway; the saved ids are what the editor, the
    run's access check and tool settings read, and what keeps the old version
    named for the catalog cleanup.

    An old id no entry of the project shows any more is rewritten in the tool
    settings of every workflow of the project, also one without a node of the
    moved entry; one another entry still shows stays, as it may mean that entry.
    Each write raises the revision, so an editor that still shows the old
    workflow gets the "changed elsewhere" notice instead of saving the old ids
    back. The last step of an update: a failure here is logged and leaves the
    old ids, which the cleanup then spares."""
    try:
        await _rewrite_workflows(
            async_session, project_id=project_id, moves=moves, user_id=user_id
        )
    except Exception:  # noqa: BLE001 - the entries moved already
        logger.exception("Catalog update: workflows of %s not rewritten", project_id)
        await async_session.rollback()


async def _rewrite_workflows(
    async_session: AsyncSession,
    *,
    project_id: UUID,
    moves: dict[int, tuple[UUID, UUID]],
    user_id: UUID,
) -> None:
    schema = settings.SCHEMA
    new_of = {link: str(new) for link, (old, new) in moves.items() if old != new}
    if not new_of:
        return
    read = f"SELECT id, config, revision FROM {schema}.workflow"
    rows = (
        await async_session.execute(
            text(f"{read} WHERE project_id = :p"), {"p": project_id}
        )
    ).all()
    pairs: dict[str, str] = {}
    ambiguous: set[str] = set()
    held_ids = [{str(old): str(new) for old, new in moves.values() if old != new}]
    held_ids += [
        _moved_nodes(row.config, new_of)[1]
        for row in rows
        if isinstance(row.config, dict)
    ]
    for held in held_ids:
        for old, new in held.items():
            if pairs.setdefault(old, new) != new:
                ambiguous.add(old)
    shown = set(
        (
            await async_session.scalars(
                text(
                    f"SELECT DISTINCT layer_id::text FROM {schema}.layer_project "
                    "WHERE project_id = :p AND layer_id::text = ANY(:ids)"
                ),
                {"p": project_id, "ids": list(pairs)},
            )
        ).all()
    )
    pairs = {
        old: new
        for old, new in pairs.items()
        if old != new and old not in ambiguous and old not in shown
    }
    for row in rows:
        # Written only over the config read: a save in between, also one that
        # keeps the revision (a pan, a run's state), is read again once.
        for _ in range(2):
            config = _rewritten(row.config, new_of, pairs)
            if config is None or await _write_over(async_session, row, config, user_id):
                break
            row = (
                await async_session.execute(
                    text(f"{read} WHERE id = :id"), {"id": row.id}
                )
            ).first()
            if row is None:
                break


async def _write_over(
    async_session: AsyncSession, row: Any, config: dict[str, Any], user_id: UUID
) -> bool:
    """Save `config` over the workflow `row` was read as, with a new revision;
    False when the workflow changed since."""
    written = await async_session.execute(
        text(
            f"UPDATE {settings.SCHEMA}.workflow SET config = CAST(:config AS jsonb), "
            "revision = revision + 1, updated_at = now(), updated_by = :user "
            "WHERE id = :id AND revision = :revision "
            "AND config = CAST(:read AS jsonb)"
        ),
        {
            "config": json.dumps(config),
            "read": json.dumps(row.config),
            "user": user_id,
            "id": row.id,
            "revision": row.revision,
        },
    )
    return bool(written.rowcount)


async def follow_catalog_style(
    async_session: AsyncSession,
    *,
    link_id: int,
    old_layer_id: UUID,
    new_layer_id: UUID,
    user_id: UUID | None = None,
) -> None:
    """An entry whose active style is still the old version's catalog default takes
    the new version's default; a style the project changed is kept."""
    style_id = await async_session.scalar(
        text(
            f"SELECT active_style_id FROM {settings.SCHEMA}.layer_project WHERE id = :id"
        ),
        {"id": link_id},
    )
    if style_id is None:
        return
    try:
        old_default = await read_default(async_session, old_layer_id)
        new_default = await read_default(async_session, new_layer_id)
    except StyleSaveError:  # a dataset without a default: nothing to follow
        return
    stored = await read_stored(async_session, style_id)
    if _without_computed(stored.document) == _without_computed(old_default.document):
        await write_document(async_session, stored, new_default.document, user_id)


async def update_catalog_layer(
    async_session: AsyncSession,
    *,
    project_id: UUID,
    link_id: int,
    user_id: UUID,
    access_token: str,
) -> list[int]:
    """Point the project entry at the newest version of its catalog item."""
    schema = settings.SCHEMA
    row = (
        await async_session.execute(
            text(
                f"""
                SELECT lp.layer_id, lp.name, l.other_properties->'catalog_item' AS item,
                       l.type::text AS type, l.feature_layer_geometry_type::text AS geometry,
                       l.catalog_external_uid, g.bundle_id, g.name AS group_name
                FROM {schema}.layer_project lp
                JOIN {schema}.layer l ON l.id = lp.layer_id
                LEFT JOIN {schema}.layer_project_group g ON g.id = lp.layer_project_group_id
                WHERE lp.id = :id AND lp.project_id = :project
                """
            ),
            {"id": link_id, "project": project_id},
        )
    ).first()
    if row is None:
        raise _refuse(status.HTTP_404_NOT_FOUND, "Layer not found in this project")
    if row.bundle_id is not None:
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"Update '{row.group_name}' as a whole instead.",
        )
    snapshot: dict[str, Any] = row.item or {}
    item_id = snapshot.get("id")
    # A user's own layer can carry a `catalog_item` too; only the shared copy moves.
    if not item_id or row.catalog_external_uid is None:
        raise _refuse(
            status.HTTP_400_BAD_REQUEST, "This layer is not from the catalog."
        )
    mirror = catalog_mirror()
    items = await run_in_threadpool(catalog.read_items, mirror, [item_id])
    if item_id not in items:
        raise _refuse(
            status.HTTP_404_NOT_FOUND, "This layer is no longer in the catalog."
        )
    if str(items[item_id].get("version") or "") == str(snapshot.get("version") or ""):
        raise _refuse(
            status.HTTP_409_CONFLICT, "This layer is already on the newest version."
        )
    if not _same_kind(row, items[item_id]):
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"'{row.name}' is another kind of layer in the catalog now; add it again instead.",
        )
    refuse_unaddable(items, {}, action="updated")
    # Lost to an update that moved the entry first.
    raced = _refuse(status.HTTP_409_CONFLICT, "Someone else just updated this layer.")

    conn = await catalog_connection()
    try:
        promoted = await promote_catalog_items(
            conn,
            items,
            [item_id],
            mirror=mirror,
            typed={},
            bundle_versions={},
            project_id=project_id,
        )
    finally:
        await conn.close()
    await submit_each(
        process_id="catalog_materialize",
        inputs=promoted.to_materialize,
        access_token=access_token,
    )
    new_layer_id = promoted.layer_ids[item_id]
    if new_layer_id != row.layer_id:
        await _left_behind(
            async_session, old_layer_ids=[row.layer_id], leaving=[link_id]
        )
    if not await _repoint(
        async_session,
        link_id=link_id,
        old_layer_id=row.layer_id,
        new_layer_id=new_layer_id,
    ):
        await async_session.rollback()
        raise raced
    await async_session.commit()
    await follow_catalog_style(
        async_session,
        link_id=link_id,
        old_layer_id=row.layer_id,
        new_layer_id=new_layer_id,
        user_id=user_id,
    )
    await _follow_in_workflows(
        async_session,
        project_id=project_id,
        moves={link_id: (row.layer_id, new_layer_id)},
        user_id=user_id,
    )
    return [link_id]


async def update_catalog_bundle(
    async_session: AsyncSession,
    *,
    project_id: UUID,
    group_id: int,
    user_id: UUID,
    access_token: str,
) -> list[int]:
    """Point the group at its catalog bundle's newest version, entry by entry
    through each member's role: a role new in the bundle gets an entry, an entry
    whose role left the bundle is removed."""
    from core.crud.crud_layer_project import layer_project as crud_layer_project
    from core.endpoints.v2.project_layer import MAX_LAYERS_PER_PROJECT

    schema = settings.SCHEMA
    row = (
        await async_session.execute(
            text(
                f"""
                SELECT g.bundle_id, g.name, b.catalog_external_uid AS dataset,
                       b.catalog_version AS version
                FROM {schema}.layer_project_group g
                JOIN {schema}.bundle b ON b.id = g.bundle_id
                WHERE g.id = :id AND g.project_id = :project
                """
            ),
            {"id": group_id, "project": project_id},
        )
    ).first()
    if row is None:
        raise _refuse(status.HTTP_404_NOT_FOUND, "Bundle not found in this project")
    if row.dataset is None:
        raise _refuse(
            status.HTTP_400_BAD_REQUEST, f"'{row.name}' is not from the catalog."
        )
    gone = _refuse(
        status.HTTP_404_NOT_FOUND, f"'{row.name}' is no longer in the catalog."
    )
    raced = _refuse(
        status.HTTP_409_CONFLICT, f"Someone else just updated '{row.name}'."
    )
    mirror = catalog_mirror()
    try:
        item_ids = await run_in_threadpool(
            catalog.resolve_item_ids, mirror, [row.dataset]
        )
    except catalog.CatalogItemNotFoundError as e:
        raise gone from e
    items = await run_in_threadpool(catalog.read_items, mirror, item_ids)
    typed = await run_in_threadpool(catalog.typed_datasets, mirror, {row.dataset})
    if row.dataset not in typed:
        raise gone
    versions = bundle_versions_of(items, typed)
    if versions[row.dataset] == row.version:
        raise _refuse(
            status.HTTP_409_CONFLICT, f"'{row.name}' is already on the newest version."
        )
    refuse_unaddable(items, typed, roles_required=True, action="updated")

    entries = (
        await async_session.execute(
            text(
                f"""
                SELECT lp.id, lp.layer_id, bl.role, l.type::text AS type,
                       l.feature_layer_geometry_type::text AS geometry
                FROM {schema}.layer_project lp
                JOIN {schema}.layer l ON l.id = lp.layer_id
                LEFT JOIN {schema}.bundle_layer bl
                    ON bl.layer_id = lp.layer_id AND bl.bundle_id = :old
                WHERE lp.layer_project_group_id = :group
                """
            ),
            {"old": row.bundle_id, "group": group_id},
        )
    ).all()
    # Entries move to the new version by role, so every layer needs one.
    if not all(entry.role for entry in entries):
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"'{row.name}' has a layer without a role, so it cannot be updated.",
        )
    by_role = {item.get("goat:role"): item for item in items.values()}
    if any(e.role in by_role and not _same_kind(e, by_role[e.role]) for e in entries):
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"'{row.name}' has a layer of another kind in the catalog now; add it again instead.",
        )
    new_roles = set(by_role)
    old_roles = {entry.role for entry in entries}
    existing = await crud_layer_project.count_by_project(
        async_session=async_session, project_id=project_id
    )
    if (
        existing - len(old_roles - new_roles) + len(new_roles - old_roles)
        >= MAX_LAYERS_PER_PROJECT
    ):
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"A project holds at most {MAX_LAYERS_PER_PROJECT} layers; this update adds more.",
        )

    conn = await catalog_connection()
    try:
        promoted = await promote_catalog_items(
            conn,
            items,
            item_ids,
            mirror=mirror,
            typed=typed,
            bundle_versions=versions,
            project_id=project_id,
        )
    finally:
        await conn.close()
    await submit_each(
        process_id="catalog_materialize",
        inputs=promoted.to_materialize,
        access_token=access_token,
    )
    new_bundle = next(b for b, d in promoted.bundles.items() if d == row.dataset)
    members = dict(
        (
            await async_session.execute(
                text(
                    f"SELECT role, layer_id FROM {schema}.bundle_layer WHERE bundle_id = :b"
                ),
                {"b": new_bundle},
            )
        ).all()
    )

    moved = [(e.id, e.layer_id, members[e.role]) for e in entries if e.role in members]
    dropped = [e.id for e in entries if e.role not in members]
    leaving = [(link, old) for link, old, new in moved if old != new] + [
        (e.id, e.layer_id) for e in entries if e.role not in members
    ]
    await _left_behind(
        async_session,
        old_layer_ids=[old for _, old in leaving],
        leaving=[link for link, _ in leaving],
        old_bundle_id=row.bundle_id,
        group_id=group_id,
    )

    # One transaction, claimed by the group row: an update that moved the group
    # first wins and this one answers 409, so the entries are never moved twice.
    claimed = await async_session.execute(
        text(
            f"UPDATE {schema}.layer_project_group SET bundle_id = :new "
            "WHERE id = :id AND bundle_id = :old"
        ),
        {"new": new_bundle, "id": group_id, "old": row.bundle_id},
    )
    if claimed.rowcount == 0:
        await async_session.rollback()
        raise raced
    for link_id, old_layer, new_layer in moved:
        await _repoint(
            async_session,
            link_id=link_id,
            old_layer_id=old_layer,
            new_layer_id=new_layer,
        )
    if dropped:
        await async_session.execute(
            text(f"DELETE FROM {schema}.layer_project WHERE id = ANY(:ids)"),
            {"ids": dropped},
        )
        await async_session.execute(
            text(
                f"""
                UPDATE {schema}.project SET layer_order = ARRAY(
                    SELECT i FROM unnest(layer_order) AS i WHERE i <> ALL(:ids)
                ) WHERE id = :project AND layer_order IS NOT NULL
                """
            ),
            {"ids": dropped, "project": project_id},
        )
    await async_session.commit()

    added = [layer for role, layer in members.items() if role not in old_roles]
    if added:
        await crud_layer_project.create(
            async_session,
            project_id=project_id,
            layer_ids=added,
            user_id=user_id,
            group_id=group_id,
        )
    for link_id, old_layer, new_layer in moved:
        await follow_catalog_style(
            async_session,
            link_id=link_id,
            old_layer_id=old_layer,
            new_layer_id=new_layer,
            user_id=user_id,
        )
    await _follow_in_workflows(
        async_session,
        project_id=project_id,
        moves={link_id: (old, new) for link_id, old, new in moved},
        user_id=user_id,
    )
    return list(
        (
            await async_session.scalars(
                text(
                    f"SELECT id FROM {schema}.layer_project WHERE layer_project_group_id = :g"
                ),
                {"g": group_id},
            )
        ).all()
    )
