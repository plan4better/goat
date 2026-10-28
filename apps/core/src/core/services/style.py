"""GOAT Style storage (spec 10, 12, 13.1): saving, reading and checking layer styles.

Every writer goes through here: the style routes now, the AI and the import paths
later. A save merges the incoming document onto the stored one (spec 13.1), has it
checked (processes' `style-check` when the style reads the layer's data, goatlib's
`validate` otherwise), and stores it with ONE conditional statement: core runs every
statement on its own, so that statement is what makes a save atomic.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from core.core.config import settings
from core.schemas.style import StyleRead
from core.services.processes import (
    StyleCheckRefused,
    StyleCheckUnavailable,
    style_check,
)
from goatlib.style.compute import needed_stats, same_ignoring_stamps
from goatlib.style.context import DataContext
from goatlib.style.data_check import referenced_fields
from goatlib.style.defaults import default_style
from goatlib.style.fingerprint import fingerprint, is_stale, layer_fingerprint
from goatlib.style.ids import assign_ids, existing_ids
from goatlib.style.issues import Issue
from goatlib.style.map_rows import MAX_STYLES
from goatlib.style.merge import apply, diff, keep_current_where_errors
from goatlib.style.migrate import context_for, migrate_style
from goatlib.style.upgrade import upgrade
from goatlib.style.validate import validate
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

#: Revisions kept per named style, only to merge saves based on an older one (13.1).
KEPT_REVISIONS = 20
#: Tries of the read, merge, check and write cycle before a save gives up (13.1).
SAVE_TRIES = 3


class StyleSaveError(Exception):
    """A style operation that stored nothing: `status` and `code` are what the route answers."""

    def __init__(self, status: int, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class StoredStyle:
    id: UUID
    name: str
    position: int
    revision: int
    document: dict[str, Any]
    layer_project_id: int | None
    dataset_id: UUID
    layer_type: str | None
    geometry: str | None
    data_snapshot: int | None
    catalog_version: str | None
    data_type: str | None = None
    url: str | None = None

    @property
    def named(self) -> bool:
        return self.layer_project_id is not None

    @property
    def fingerprint(self) -> str | None:
        """The data the style's computed values belong to; none for a map service."""
        return layer_fingerprint(
            self.layer_type,
            self.data_type,
            data_snapshot=self.data_snapshot,
            catalog_version=self.catalog_version,
            url=self.url,
        )

    def context(self, document: dict[str, Any]) -> DataContext:
        kind = "raster" if document.get("kind") == "raster" else self.layer_type
        return layer_context(kind, self.geometry, self.data_type)

    def read(
        self,
        document: dict[str, Any] | None = None,
        issues: list[Issue] | None = None,
        *,
        stale: bool = False,
    ) -> StyleRead:
        return StyleRead(
            id=self.id,
            name=self.name,
            position=self.position,
            revision=self.revision,
            document=self.document if document is None else document,
            issues=issues_json(issues or []),
            stale=stale,
        )


def layer_context(
    layer_type: str | None, geometry: str | None, data_type: str | None = None
) -> DataContext:
    """What goatlib knows of a layer without reading its data: the kind, the
    geometry, and for rasters whether it is a map service."""
    return context_for(layer_type, geometry, data_type)


def _check_error(error: StyleCheckUnavailable) -> StyleSaveError:
    """What a save answers when processes could not check it: 503 to retry, 401
    when the caller's session ran out on the way, 422 `check_failed` when a retry
    would get the same refusal."""
    if isinstance(error, StyleCheckRefused):
        if error.status == 401:
            return StyleSaveError(401, "unauthorized", str(error))
        return StyleSaveError(422, "check_failed", str(error))
    return StyleSaveError(503, "check_unavailable", str(error))


def issues_json(issues: list[Issue]) -> list[dict[str, Any]]:
    return [i.model_dump(mode="json", exclude_none=True) for i in issues]


async def read_stored(session: AsyncSession, style_id: UUID) -> StoredStyle:
    """The style with what its checks need of its layer; 404 `not_found` when gone."""
    schema = settings.SCHEMA
    row = (
        await session.execute(
            text(
                f"""
                SELECT s.id, s.name, s.position, s.revision, s.document, s.layer_project_id,
                       l.id AS dataset_id, l.type AS layer_type,
                       l.feature_layer_geometry_type AS geometry, l.data_snapshot, l.catalog_version,
                       l.data_type::text AS data_type, l.url
                FROM {schema}.layer_style s
                LEFT JOIN {schema}.layer_project lp ON lp.id = s.layer_project_id
                JOIN {schema}.layer l ON l.id = coalesce(s.layer_id, lp.layer_id)
                WHERE s.id = :id
                """
            ),
            {"id": style_id},
        )
    ).first()
    if row is None:
        raise StyleSaveError(404, "not_found")
    return StoredStyle(
        id=row.id,
        name=row.name,
        position=row.position,
        revision=row.revision,
        document=row.document,
        layer_project_id=row.layer_project_id,
        dataset_id=row.dataset_id,
        layer_type=str(row.layer_type) if row.layer_type is not None else None,
        geometry=str(row.geometry) if row.geometry is not None else None,
        data_snapshot=row.data_snapshot,
        catalog_version=row.catalog_version,
        data_type=row.data_type,
        url=row.url,
    )


async def check_document(
    stored: StoredStyle,
    document: dict[str, Any],
    access_token: str,
    *,
    compute: bool = True,
) -> tuple[dict[str, Any], list[Issue]]:
    """A document checked (spec 11) and its computed values filled (spec 12): by
    processes when the style reads the layer's data, else by goatlib alone.
    Raises StyleCheckUnavailable when processes cannot answer."""
    if referenced_fields(document) or needed_stats(document):
        result = await style_check(
            layer_id=stored.dataset_id,
            document=document,
            geometry=stored.geometry,
            fingerprint=stored.fingerprint,
            access_token=access_token,
            compute=compute,
            stored=False,
        )
        return result["document"], [
            Issue.model_validate(i) for i in result.get("issues", [])
        ]
    return document, validate(document, stored.context(document))


async def _base_document(
    session: AsyncSession, stored: StoredStyle, base_rev: int
) -> dict[str, Any]:
    """The document of the revision a save is based on; 409 `base_too_old` when it is no longer kept."""
    if base_rev == stored.revision:
        return stored.document
    document = (
        await session.execute(
            text(
                f"SELECT document FROM {settings.SCHEMA}.layer_style_revision "
                "WHERE style_id = :id AND revision = :revision"
            ),
            {"id": stored.id, "revision": base_rev},
        )
    ).scalar_one_or_none()
    if document is None:
        raise StyleSaveError(409, "base_too_old")
    return upgrade(document, stored.context(document)).document


async def read_style(
    session: AsyncSession,
    stored: StoredStyle,
    *,
    access_token: str,
    check: bool = False,
) -> StyleRead:
    """A style as a reader gets it (spec 12, 13.2): a style whose data changed is
    recomputed by processes and stored once, and the answer carries its issues;
    with `check` (the panel opening), a current style is checked too, its issues
    (`damaged` ones included) answered and nothing stored. When processes cannot
    answer, or could not compute it, the style comes back marked `stale`."""
    document = upgrade(stored.document, stored.context(stored.document)).document
    stale = is_stale(document, stored.fingerprint)
    if not stale and not check:
        return stored.read(document)
    try:
        result = await style_check(
            layer_id=stored.dataset_id,
            document=document,
            geometry=stored.geometry,
            fingerprint=stored.fingerprint,
            access_token=access_token,
            compute=stale,
            stored=True,
        )
    except StyleCheckUnavailable:
        return stored.read(document, stale=stale)
    issues = [Issue.model_validate(i) for i in result.get("issues", [])]
    if not stale:
        return stored.read(document, issues)
    recomputed = result["document"]
    still_stale = is_stale(recomputed, stored.fingerprint)
    if recomputed == stored.document:
        return stored.read(recomputed, issues, stale=still_stale)
    if same_ignoring_stamps(recomputed, stored.document):
        # Only the stamps move: the revision stays, so no save in flight is told to merge.
        row = (
            await session.execute(
                text(
                    f"UPDATE {settings.SCHEMA}.layer_style SET document = CAST(:doc AS jsonb) "
                    "WHERE id = :id AND revision = :read RETURNING revision"
                ),
                {
                    "id": stored.id,
                    "read": stored.revision,
                    "doc": json.dumps(recomputed),
                },
            )
        ).scalar_one_or_none()
        await session.commit()
        if row is not None:
            return stored.read(recomputed, issues, stale=still_stale)
    elif (
        revision := await write_document(session, stored, recomputed, None)
    ) is not None:
        return StyleRead(
            id=stored.id,
            name=stored.name,
            position=stored.position,
            revision=revision,
            document=recomputed,
            issues=issues_json(issues),
            stale=still_stale,
        )
    # Another writer got in first: what it stored is the answer.
    fresh = await read_stored(session, stored.id)
    current = upgrade(fresh.document, fresh.context(fresh.document)).document
    return fresh.read(current, stale=is_stale(current, fresh.fingerprint))


async def write_document(
    session: AsyncSession,
    stored: StoredStyle,
    document: dict[str, Any],
    actor_id: UUID | None,
) -> int | None:
    """Stores the document if the style is still at the revision it was read at, in
    ONE statement: the update, the revision row and the pruning of old revisions.
    Returns the new revision, or None when another write got in first."""
    schema = settings.SCHEMA
    params = {
        "id": stored.id,
        "read": stored.revision,
        "doc": json.dumps(document),
        "actor": actor_id,
    }
    if stored.named:
        sql = f"""
            WITH u AS (
                UPDATE {schema}.layer_style
                SET document = CAST(:doc AS jsonb), revision = revision + 1, updated_at = now(), updated_by = :actor
                WHERE id = :id AND revision = :read
                RETURNING id, revision, document
            ),
            i AS (
                INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
                SELECT id, revision, document FROM u
            ),
            d AS (
                DELETE FROM {schema}.layer_style_revision
                WHERE style_id = :id AND revision <= (SELECT revision FROM u) - {KEPT_REVISIONS}
            )
            SELECT revision FROM u
        """
    else:
        sql = f"""
            UPDATE {schema}.layer_style
            SET document = CAST(:doc AS jsonb), revision = revision + 1, updated_at = now(), updated_by = :actor
            WHERE id = :id AND revision = :read
            RETURNING revision
        """
    revision = (await session.execute(text(sql), params)).scalar_one_or_none()
    await session.commit()
    return revision


async def save_style(
    session: AsyncSession,
    *,
    style_id: UUID,
    base_rev: int,
    document: dict[str, Any],
    actor_id: UUID | None,
    access_token: str,
) -> StyleRead:
    """Saves a whole document (spec 13.1). A named style merges what the author
    changed since `base_rev` onto the stored document; a dataset default is replaced
    whole. A changed path with an error keeps the stored value. Raises StyleSaveError:
    409 `base_too_old`, 503 `check_unavailable`, 503 `save_conflict` after three lost races."""
    for _ in range(SAVE_TRIES):
        stored = await read_stored(session, style_id)
        incoming = upgrade(document, stored.context(document), strict=True).document
        if stored.named:
            base = await _base_document(session, stored, base_rev)
            # goatlib's merge() without dropping the changes: they say which paths
            # an error may take back.
            reserved = existing_ids(base) | existing_ids(stored.document)
            changes = diff(base, assign_ids(incoming, reserved=reserved))
            candidate, refused = apply(stored.document, changes)
            changes = [c for c in changes if c not in refused]
        else:
            # A dataset default is replaced whole; what differs from the stored
            # document is what an error may take back, as for a named style.
            candidate = assign_ids(incoming, reserved=existing_ids(stored.document))
            changes = diff(stored.document, candidate)
        candidate = assign_ids(candidate)
        if same_ignoring_stamps(candidate, stored.document):
            return stored.read(
                issues=validate(stored.document, stored.context(stored.document))
            )
        try:
            checked, issues = await check_document(stored, candidate, access_token)
            if changes:
                current_issues = validate(
                    stored.document, stored.context(stored.document)
                )
                kept = keep_current_where_errors(
                    stored.document,
                    checked,
                    issues,
                    changes,
                    current_issues=current_issues,
                )
                if kept != checked:
                    # The reply still carries the errors that were not saved (13.1).
                    refused_errors = [i for i in issues if i.level == "error"]
                    checked, issues = await check_document(stored, kept, access_token)
                    known = {(i.code, i.path) for i in issues}
                    issues += [
                        i for i in refused_errors if (i.code, i.path) not in known
                    ]
        except StyleCheckUnavailable as error:
            raise _check_error(error) from error
        revision = await write_document(session, stored, checked, actor_id)
        if revision is None:
            continue
        return StyleRead(
            id=stored.id,
            name=stored.name,
            position=stored.position,
            revision=revision,
            document=checked,
            issues=issues_json(issues),
        )
    raise StyleSaveError(503, "save_conflict")


async def read_named(
    session: AsyncSession, style_id: UUID, layer_project_id: int
) -> StoredStyle:
    """A named style of this project layer; 404 `not_found` for any other style."""
    stored = await read_stored(session, style_id)
    if stored.layer_project_id != layer_project_id:
        raise StyleSaveError(404, "not_found")
    return stored


async def _layer_facts(session: AsyncSession, layer_id: UUID) -> Any:
    row = (
        await session.execute(
            text(
                "SELECT type::text AS layer_type, feature_layer_geometry_type::text AS geometry, "
                "data_type::text AS data_type, catalog_external_uid "
                f"FROM {settings.SCHEMA}.layer WHERE id = :id"
            ),
            {"id": layer_id},
        )
    ).first()
    if row is None:
        raise StyleSaveError(404, "not_found")
    return row


async def _default_id(session: AsyncSession, layer_id: UUID) -> UUID | None:
    return (
        await session.execute(
            text(f"SELECT id FROM {settings.SCHEMA}.layer_style WHERE layer_id = :id"),
            {"id": layer_id},
        )
    ).scalar_one_or_none()


async def create_style(
    session: AsyncSession,
    *,
    layer_project_id: int,
    layer_id: UUID,
    name: str,
    copy_from: UUID | None,
    actor_id: UUID | None,
) -> StyleRead:
    """A new named style, a copy (computed values included) of `copy_from`, else of
    the style the map shows (the active one, else the first by position), else of
    the dataset default, else goatlib's default style. The first style of a project
    layer becomes its active style; a later one leaves the shown style as it is. 409
    `too_many_styles` past MAX_STYLES."""
    schema = settings.SCHEMA
    facts = await _layer_facts(session, layer_id)
    context = layer_context(facts.layer_type, facts.geometry, facts.data_type)
    if copy_from is not None:
        document = (await read_named(session, copy_from, layer_project_id)).document
    else:
        document = (
            await session.execute(
                text(
                    # The style the map shows (the active one, else the first by
                    # position, spec 10), else the dataset default.
                    f"SELECT coalesce(a.document, d.document) FROM {schema}.layer_project lp "
                    "LEFT JOIN LATERAL ("
                    f"  SELECT st.document FROM {schema}.layer_style st "
                    "  WHERE st.layer_project_id = lp.id "
                    "  ORDER BY st.id = lp.active_style_id DESC NULLS LAST, st.position, st.created_at "
                    "  LIMIT 1"
                    ") a ON true "
                    f"LEFT JOIN {schema}.layer_style d ON d.layer_id = lp.layer_id "
                    "WHERE lp.id = :lp"
                ),
                {"lp": layer_project_id},
            )
        ).scalar_one_or_none()
        if document is None:
            document = default_style(context, seed=str(layer_id))
    document = upgrade(document, context).document
    row = (
        await session.execute(
            text(
                f"""
                WITH s AS (
                    INSERT INTO {schema}.layer_style
                        (layer_project_id, name, position, document, revision, updated_by)
                    SELECT :lp, :name, coalesce(max(position) + 1, 0), CAST(:doc AS jsonb), 1, :actor
                    FROM {schema}.layer_style WHERE layer_project_id = :lp
                    HAVING count(*) < {MAX_STYLES}
                    RETURNING id, position
                ),
                r AS (
                    INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
                    SELECT id, 1, CAST(:doc AS jsonb) FROM s
                ),
                a AS (
                    UPDATE {schema}.layer_project SET active_style_id = (SELECT id FROM s)
                    WHERE id = :lp AND active_style_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM {schema}.layer_style WHERE layer_project_id = :lp
                      )
                )
                SELECT id, position FROM s
                """
            ),
            {
                "lp": layer_project_id,
                "name": name,
                "doc": json.dumps(document),
                "actor": actor_id,
            },
        )
    ).first()
    await session.commit()
    if row is None:
        raise StyleSaveError(409, "too_many_styles")
    return StyleRead(
        id=row.id, name=name, position=row.position, revision=1, document=document
    )


async def update_style(
    session: AsyncSession,
    stored: StoredStyle,
    *,
    name: str | None,
    position: int | None,
) -> StyleRead:
    """Renames a named style and moves it to `position` among its project layer's styles."""
    schema = settings.SCHEMA
    if name is not None:
        await session.execute(
            text(
                f"UPDATE {schema}.layer_style SET name = :name, updated_at = now() WHERE id = :id"
            ),
            {"name": name, "id": stored.id},
        )
    new_position = stored.position
    if position is not None:
        ids = list(
            (
                await session.execute(
                    text(
                        f"SELECT id FROM {schema}.layer_style WHERE layer_project_id = :lp "
                        "ORDER BY position, created_at"
                    ),
                    {"lp": stored.layer_project_id},
                )
            ).scalars()
        )
        ids.remove(stored.id)
        new_position = min(position, len(ids))
        ids.insert(new_position, stored.id)
        await session.execute(
            text(
                f"UPDATE {schema}.layer_style s SET position = v.position "
                "FROM unnest(CAST(:ids AS uuid[]), CAST(:positions AS int[])) AS v(id, position) "
                "WHERE s.id = v.id"
            ),
            {"ids": ids, "positions": list(range(len(ids)))},
        )
    await session.commit()
    return StyleRead(
        id=stored.id,
        name=name if name is not None else stored.name,
        position=new_position,
        revision=stored.revision,
        document=stored.document,
    )


async def delete_style(session: AsyncSession, stored: StoredStyle) -> None:
    """Deletes a named style; the active one hands over to the first remaining.
    409 `last_style`: a project layer keeps at least one."""
    schema = settings.SCHEMA
    deleted = (
        await session.execute(
            text(
                f"""
                WITH d AS (
                    DELETE FROM {schema}.layer_style
                    WHERE id = :id
                      AND (SELECT count(*) FROM {schema}.layer_style WHERE layer_project_id = :lp) > 1
                    RETURNING id
                ),
                a AS (
                    UPDATE {schema}.layer_project SET active_style_id = (
                        SELECT id FROM {schema}.layer_style
                        WHERE layer_project_id = :lp AND id <> :id
                        ORDER BY position, created_at LIMIT 1
                    )
                    WHERE id = :lp AND active_style_id = :id AND EXISTS (SELECT 1 FROM d)
                )
                SELECT count(*) FROM d
                """
            ),
            {"id": stored.id, "lp": stored.layer_project_id},
        )
    ).scalar_one()
    await session.commit()
    if not deleted:
        raise StyleSaveError(409, "last_style")


async def check_style(
    stored: StoredStyle, document: dict[str, Any] | None, access_token: str
) -> tuple[dict[str, Any], list[Issue]]:
    """The save's checks without storing (spec 13.1): the stored
    document, or the one given, with its issues and computed values."""
    candidate = stored.document if document is None else document
    # A given document is checked as it would be written, not brought inside the bounds.
    upgraded = upgrade(
        candidate, stored.context(candidate), strict=document is not None
    )
    candidate = assign_ids(upgraded.document)
    try:
        return await check_document(stored, candidate, access_token)
    except StyleCheckUnavailable as error:
        raise _check_error(error) from error


async def read_default(session: AsyncSession, layer_id: UUID) -> StoredStyle:
    """The dataset's default style; 404 `not_found` when it has none."""
    style_id = await _default_id(session, layer_id)
    if style_id is None:
        raise StyleSaveError(404, "not_found")
    return await read_stored(session, style_id)


async def write_default(
    session: AsyncSession,
    *,
    layer_id: UUID,
    document: dict[str, Any],
    actor_id: UUID | None,
    access_token: str,
) -> StyleRead:
    """Replaces the dataset's default style whole (no base revision, no merge).
    403 `read_only` for a catalog layer: the catalog owns its style."""
    facts = await _layer_facts(session, layer_id)
    if facts.catalog_external_uid is not None:
        raise StyleSaveError(403, "read_only")
    style_id = await _default_id(session, layer_id)
    if style_id is None:
        # The row starts as goatlib's default, then the save below replaces it.
        seed = default_style(
            layer_context(facts.layer_type, facts.geometry, facts.data_type),
            seed=str(layer_id),
        )
        await session.execute(
            text(
                f"INSERT INTO {settings.SCHEMA}.layer_style (layer_id, name, document, updated_by) "
                "VALUES (:layer_id, 'Default', CAST(:doc AS jsonb), :actor) "
                "ON CONFLICT (layer_id) WHERE layer_id IS NOT NULL DO NOTHING"
            ),
            {"layer_id": layer_id, "doc": json.dumps(seed), "actor": actor_id},
        )
        await session.commit()
        style_id = await _default_id(session, layer_id)
        assert style_id is not None
    return await save_style(
        session,
        style_id=style_id,
        base_rev=1,
        document=document,
        actor_id=actor_id,
        access_token=access_token,
    )


async def _write_dataset_defaults(
    session: AsyncSession, items: list[dict[str, Any]]
) -> None:
    """Default style rows (`{"layer_id", "document"}`) of datasets that have none, in
    one statement."""
    if not items:
        return
    await session.execute(
        text(
            f"INSERT INTO {settings.SCHEMA}.layer_style (layer_id, name, document) "
            "SELECT (x->>'layer_id')::uuid, 'Default', x->'document' "
            "FROM jsonb_array_elements(CAST(:rows AS jsonb)) x "
            "ON CONFLICT (layer_id) WHERE layer_id IS NOT NULL DO NOTHING"
        ),
        {"rows": json.dumps(items)},
    )


async def insert_dataset_default(
    session: AsyncSession, layer_id: UUID, document: dict[str, Any] | None = None
) -> None:
    """The dataset's default style row, unless it has one: `document`, else goatlib's
    default style for the layer."""
    if document is None:
        facts = await _layer_facts(session, layer_id)
        document = default_style(
            layer_context(facts.layer_type, facts.geometry, facts.data_type),
            seed=str(layer_id),
        )
    await _write_dataset_defaults(
        session, [{"layer_id": str(layer_id), "document": document}]
    )
    await session.commit()


async def _defaults_for_links(session: AsyncSession, link_ids: list[int]) -> None:
    """goatlib's default style for the datasets of these links that have none, in
    one statement."""
    schema = settings.SCHEMA
    rows = (
        await session.execute(
            text(
                "SELECT DISTINCT l.id, l.type::text AS layer_type, "
                "l.feature_layer_geometry_type::text AS geometry, l.data_type::text AS data_type "
                f"FROM {schema}.layer_project lp JOIN {schema}.layer l ON l.id = lp.layer_id "
                "WHERE lp.id = ANY(CAST(:ids AS int[])) AND l.type IN ('feature', 'raster') "
                f"AND NOT EXISTS (SELECT 1 FROM {schema}.layer_style d WHERE d.layer_id = l.id)"
            ),
            {"ids": link_ids},
        )
    ).all()
    if not rows:
        return
    items = [
        {
            "layer_id": str(r.id),
            "document": default_style(
                layer_context(r.layer_type, r.geometry, r.data_type), seed=str(r.id)
            ),
        }
        for r in rows
    ]
    await _write_dataset_defaults(session, items)
    await session.commit()


async def add_first_styles(session: AsyncSession, link_ids: list[int]) -> None:
    """The first styles of new project layers (spec 10), in one statement: a copy
    of every named style of another project layer of the same dataset in the
    project (today's "a duplicate matches what the user made"), else a "Default"
    copied from the dataset default. Each gets its revision 1 row; the active style
    maps across; the new layers are shown. A project layer is claimed first (its
    `active_style_id` set while still empty), so two writers at once give it one
    set of styles."""
    if not link_ids:
        return
    schema = settings.SCHEMA
    await _defaults_for_links(session, link_ids)
    await session.execute(
        text(
            f"""
            WITH new AS (
                SELECT lp.id, lp.project_id, lp.layer_id FROM {schema}.layer_project lp
                WHERE lp.id = ANY(CAST(:ids AS int[]))
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}.layer_style s WHERE s.layer_project_id = lp.id
                  )
            ),
            sibling AS (
                SELECT DISTINCT ON (n.id) n.id AS new_id, o.id AS old_id, o.active_style_id
                FROM new n
                JOIN {schema}.layer_project o
                  ON o.project_id = n.project_id AND o.layer_id = n.layer_id
                 AND NOT (o.id = ANY(CAST(:ids AS int[])))
                WHERE EXISTS (
                    SELECT 1 FROM {schema}.layer_style s WHERE s.layer_project_id = o.id
                )
                ORDER BY n.id, o.id
            ),
            plan AS MATERIALIZED (
                SELECT gen_random_uuid() AS id, sb.new_id AS lp, s.name, s.position,
                       s.document, s.id = sb.active_style_id AS was_active
                FROM sibling sb JOIN {schema}.layer_style s ON s.layer_project_id = sb.old_id
                UNION ALL
                SELECT gen_random_uuid(), n.id, 'Default', 0, d.document, true
                FROM new n JOIN {schema}.layer_style d ON d.layer_id = n.layer_id
                WHERE NOT EXISTS (SELECT 1 FROM sibling sb WHERE sb.new_id = n.id)
            ),
            claimed AS (
                UPDATE {schema}.layer_project lp
                SET active_style_id = coalesce(
                        (SELECT p.id FROM plan p WHERE p.lp = lp.id AND p.was_active LIMIT 1),
                        (SELECT p.id FROM plan p WHERE p.lp = lp.id ORDER BY p.position LIMIT 1)
                    ),
                    visible = true
                WHERE lp.id IN (SELECT lp FROM plan) AND lp.active_style_id IS NULL
                RETURNING lp.id
            ),
            ins AS (
                INSERT INTO {schema}.layer_style
                    (id, layer_project_id, name, position, document, revision)
                SELECT id, lp, name, position, document, 1 FROM plan
                WHERE lp IN (SELECT id FROM claimed)
                RETURNING id, document
            )
            INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
            SELECT id, 1, document FROM ins
            """
        ),
        {"ids": link_ids},
    )
    await session.commit()


async def copy_styles(session: AsyncSession, link_map: list[tuple[int, int]]) -> None:
    """Every named style of each old project layer to its new one (project copy,
    templates), in one statement: names, positions and documents with new ids and
    revision 1 rows, the active style mapped, and the map state columns copied."""
    if not link_map:
        return
    schema = settings.SCHEMA
    await session.execute(
        text(
            f"""
            WITH m AS (
                SELECT * FROM unnest(CAST(:old AS int[]), CAST(:new AS int[])) AS m(old, new)
            ),
            plan AS (
                SELECT gen_random_uuid() AS id, m.new AS lp, s.id AS source, s.name,
                       s.position, s.document
                FROM m JOIN {schema}.layer_style s ON s.layer_project_id = m.old
            ),
            ins AS (
                INSERT INTO {schema}.layer_style
                    (id, layer_project_id, name, position, document, revision)
                SELECT id, lp, name, position, document, 1 FROM plan
                RETURNING id, document
            ),
            rev AS (
                INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
                SELECT id, 1, document FROM ins
            )
            UPDATE {schema}.layer_project n
            SET active_style_id = (
                    SELECT p.id FROM plan p WHERE p.lp = n.id AND p.source = o.active_style_id
                ),
                visible = o.visible,
                position = o.position,
                time_value = o.time_value,
                legend_expanded = o.legend_expanded
            FROM m JOIN {schema}.layer_project o ON o.id = m.old
            WHERE n.id = m.new
            """
        ),
        {"old": [a for a, _ in link_map], "new": [b for _, b in link_map]},
    )
    await session.commit()


async def ensure_styles(session: AsyncSession, project_id: UUID) -> int:
    """Style rows for a project's layers and their datasets that have none, from
    today's `properties`: what a writer of the previous release created during the
    rollout. One anti-join when nothing is missing. Removed with the `properties`
    columns. Returns how many styles it wrote."""
    schema = settings.SCHEMA
    missing = (
        await session.execute(
            text(
                f"""
                SELECT 'dataset' AS kind, l.id::text AS ref, l.id AS layer_id, l.properties,
                       l.type::text AS layer_type, l.feature_layer_geometry_type::text AS geometry,
                       l.data_type::text AS data_type, l.data_snapshot, l.catalog_version
                FROM {schema}.layer l
                WHERE l.id IN (SELECT layer_id FROM {schema}.layer_project WHERE project_id = :p)
                  AND l.type IN ('feature', 'raster')
                  AND NOT EXISTS (SELECT 1 FROM {schema}.layer_style d WHERE d.layer_id = l.id)
                UNION ALL
                SELECT 'link', lp.id::text, l.id, lp.properties, l.type::text,
                       l.feature_layer_geometry_type::text, l.data_type::text, l.data_snapshot,
                       l.catalog_version
                FROM {schema}.layer_project lp JOIN {schema}.layer l ON l.id = lp.layer_id
                WHERE lp.project_id = :p AND l.type IN ('feature', 'raster')
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}.layer_style s WHERE s.layer_project_id = lp.id
                  )
                """
            ),
            {"p": project_id},
        )
    ).all()
    if not missing:
        return 0
    at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    defaults, links, fresh = [], [], []
    for r in missing:
        ctx = layer_context(r.layer_type, r.geometry, r.data_type)
        if r.properties is None:
            # No `properties`: a dataset or link the new release wrote. It starts as
            # when it was created: the default style, a copy of the dataset default.
            if r.kind == "dataset":
                defaults.append(
                    {
                        "layer_id": r.ref,
                        "document": default_style(ctx, seed=str(r.layer_id)),
                    }
                )
            else:
                fresh.append(int(r.ref))
            continue
        m = migrate_style(
            r.properties,
            ctx,
            fingerprint=None
            if r.layer_type == "raster"
            else fingerprint(
                data_snapshot=r.data_snapshot, catalog_version=r.catalog_version
            ),
            at=at,
            seed=str(r.layer_id),
        )
        if r.kind == "dataset":
            defaults.append({"layer_id": r.ref, "document": m.document})
        else:
            links.append(
                {
                    "lp": int(r.ref),
                    "document": m.document,
                    "visible": m.map_state.get("visible"),
                    "legend_expanded": m.map_state.get("legend_expanded"),
                }
            )
    await _write_dataset_defaults(session, defaults)
    if links:
        # The project layer is claimed first (its active style set while empty), so
        # two map loads at once write one "Default".
        await session.execute(
            text(
                f"""
                WITH r AS MATERIALIZED (
                    SELECT gen_random_uuid() AS id, (x->>'lp')::int AS lp,
                           x->'document' AS document,
                           CAST(x->>'visible' AS boolean) AS visible,
                           CAST(x->>'legend_expanded' AS boolean) AS legend_expanded
                    FROM jsonb_array_elements(CAST(:rows AS jsonb)) x
                ),
                claimed AS (
                    UPDATE {schema}.layer_project lp
                    SET active_style_id = r.id,
                        visible = coalesce(r.visible, lp.visible),
                        legend_expanded = coalesce(r.legend_expanded, lp.legend_expanded)
                    FROM r
                    WHERE lp.id = r.lp AND lp.active_style_id IS NULL
                    RETURNING r.id
                ),
                s AS (
                    INSERT INTO {schema}.layer_style
                        (id, layer_project_id, name, position, document, revision)
                    SELECT r.id, r.lp, 'Default', 0, r.document, 1
                    FROM r JOIN claimed c ON c.id = r.id
                    RETURNING id, document
                )
                INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
                SELECT id, 1, document FROM s
                """
            ),
            {"rows": json.dumps(links)},
        )
    await session.commit()
    if fresh:
        await add_first_styles(session, fresh)
    return len(missing)
