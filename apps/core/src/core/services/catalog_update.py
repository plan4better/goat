"""Moving a project's catalog layer or catalog bundle to the catalog's newer version, in place."""

from typing import Any
from uuid import UUID

from core.core.config import settings
from core.db.session import AsyncSession
from core.services.catalog_promote import (
    bundle_versions_of,
    catalog_connection,
    catalog_mirror,
    promote_catalog_items,
)
from core.services.processes import submit_each
from core.services.style import (
    StyleSaveError,
    read_default,
    read_stored,
    write_document,
)
from fastapi import HTTPException, status
from goatlib.catalog import promote as catalog
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool


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
                SELECT lp.layer_id, l.other_properties->'catalog_item' AS item,
                       g.bundle_id, g.name AS group_name
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
    if not item_id:
        raise _refuse(
            status.HTTP_400_BAD_REQUEST, "This layer is not from the catalog."
        )
    mirror = catalog_mirror()
    items = await run_in_threadpool(catalog.read_items, mirror, [item_id])
    if item_id not in items:
        raise _refuse(
            status.HTTP_404_NOT_FOUND, "This layer is no longer in the catalog."
        )
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

    entries = (
        await async_session.execute(
            text(
                f"""
                SELECT lp.id, lp.layer_id, bl.role
                FROM {schema}.layer_project lp
                LEFT JOIN {schema}.bundle_layer bl
                    ON bl.layer_id = lp.layer_id AND bl.bundle_id = :old
                WHERE lp.layer_project_group_id = :group
                """
            ),
            {"old": row.bundle_id, "group": group_id},
        )
    ).all()
    # Entries move to the new version by role, so every layer needs one.
    if not all(entry.role for entry in entries) or not all(
        item.get("goat:role") for item in items.values()
    ):
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            f"'{row.name}' has a layer without a role, so it cannot be updated.",
        )
    new_roles = {item.get("goat:role") for item in items.values()}
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
    moved = [(e.id, e.layer_id, members[e.role]) for e in entries if e.role in members]
    dropped = [e.id for e in entries if e.role not in members]
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
