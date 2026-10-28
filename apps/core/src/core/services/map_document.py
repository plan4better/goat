"""The map request (GOAT Style spec 10 and 13.2): the map document assembled from the
project's tables, the active style of every layer and the names of the others.

The map document is not stored as one JSON: workflows,
dashboards and report layouts refer to `layer_project.id` and groups, so those rows
keep their ids. Before reading, the request moves `layer.data_snapshot` with the
tracker statement, so a style whose data changed comes back `stale` (spec 12). It
never reads DuckLake data and never calls processes.
"""

import json
import logging
from typing import Any
from uuid import UUID

from core.core.config import settings
from core.schemas.style import (
    GroupMapState,
    LayerMapState,
    LayerStyles,
    MapResponse,
    StyleName,
    StyleRead,
    UnpublishedChange,
)
from core.services.style import StyleSaveError, ensure_styles, layer_context
from goatlib.style.compute import same_ignoring_stamps
from goatlib.style.fingerprint import (
    advance_data_snapshots_sql,
    data_snapshots_pending_sql,
    is_stale,
    layer_fingerprint,
)
from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document, map_view
from goatlib.style.merge import diff
from goatlib.style.upgrade import upgrade
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def track_data_snapshots(session: AsyncSession) -> None:
    """Moves `layer.data_snapshot` past every DuckLake change not seen yet: a
    catalog lookup and three index reads when nothing is new, the tracker
    statement only when something is. Without a DuckLake catalog (a fresh
    install before geoapi created it) nothing moves, and nothing is rolled back:
    a rollback would expire every row the caller has loaded in this session."""
    schemas = (settings.SCHEMA, settings.DUCKLAKE_CATALOG_SCHEMA)
    catalog = (
        await session.execute(
            text("SELECT to_regclass(:name) IS NOT NULL"),
            {"name": f"{settings.DUCKLAKE_CATALOG_SCHEMA}.ducklake_snapshot_changes"},
        )
    ).scalar_one()
    if not catalog:
        return
    try:
        pending = (
            await session.execute(text(data_snapshots_pending_sql(*schemas)))
        ).scalar_one()
        if pending:
            await session.execute(text(advance_data_snapshots_sql(*schemas)))
        await session.commit()
    except DBAPIError:
        await session.rollback()
        logger.warning("data snapshot tracker skipped", exc_info=True)


async def map_for_project(
    session: AsyncSession, *, project_id: UUID, user_id: UUID
) -> MapResponse:
    """The map document and the styles of a project, in four queries after the tracker:
    the project with the caller's view, the groups, the layers with their active
    style, the other styles' names."""
    schema = settings.SCHEMA
    await track_data_snapshots(session)
    await ensure_styles(session, project_id)
    params = {"p": project_id, "u": user_id}
    project = (
        await session.execute(
            text(
                f"SELECT p.basemap, p.locale, p.max_extent, up.initial_view_state "
                f"FROM {schema}.project p LEFT JOIN {schema}.user_project up "
                "ON up.project_id = p.id AND up.user_id = :u WHERE p.id = :p"
            ),
            params,
        )
    ).one()
    groups = (
        await session.execute(
            text(
                'SELECT id, name, parent_id, "order", visible, expanded '
                f"FROM {schema}.layer_project_group WHERE project_id = :p"
            ),
            params,
        )
    ).all()
    # The active style, else the first by position (spec 10). A link the caller has
    # no access to of his own (LOCKED, D7) gets no style: there is nothing to draw.
    layers = (
        await session.execute(
            text(
                f"""
                SELECT lp.id, lp.layer_project_group_id AS group_id, lp."order", lp.visible,
                       lp.position, lp.query, lp.time_value, lp.legend_expanded,
                       l.type::text AS layer_type, l.feature_layer_geometry_type::text AS geometry,
                       l.data_snapshot, l.catalog_version, l.data_type::text AS data_type, l.url,
                       NOT lp.shareable
                           AND {schema}.effective_role('layer', lp.layer_id, :u) IS NULL AS locked,
                       s.id AS style_id, s.name AS style_name, s.position AS style_position,
                       s.revision, s.document
                FROM {schema}.layer_project lp
                JOIN {schema}.layer l ON l.id = lp.layer_id
                LEFT JOIN LATERAL (
                    SELECT st.id, st.name, st.position, st.revision, st.document
                    FROM {schema}.layer_style st
                    WHERE st.layer_project_id = lp.id
                    ORDER BY st.id = lp.active_style_id DESC NULLS LAST, st.position, st.created_at
                    LIMIT 1
                ) s ON true
                WHERE lp.project_id = :p
                """
            ),
            params,
        )
    ).all()
    names = (
        await session.execute(
            text(
                f"SELECT s.layer_project_id, s.id, s.name FROM {schema}.layer_style s "
                f"JOIN {schema}.layer_project lp ON lp.id = s.layer_project_id "
                "WHERE lp.project_id = :p ORDER BY s.layer_project_id, s.position, s.created_at"
            ),
            params,
        )
    ).all()

    styles: dict[str, LayerStyles] = {}
    rows: list[LayerRow] = []
    for row in layers:
        style_id = None if row.locked else row.style_id
        if style_id is not None:
            context = layer_context(row.layer_type, row.geometry, row.data_type)
            document = upgrade(row.document, context).document
            data = layer_fingerprint(
                row.layer_type,
                row.data_type,
                data_snapshot=row.data_snapshot,
                catalog_version=row.catalog_version,
                url=row.url,
            )
            styles[str(row.id)] = LayerStyles(
                active=StyleRead(
                    id=style_id,
                    name=row.style_name,
                    position=row.style_position,
                    revision=row.revision,
                    document=document,
                    stale=is_stale(document, data),
                ),
                others=[
                    StyleName(id=n.id, name=n.name)
                    for n in names
                    if n.layer_project_id == row.id and n.id != style_id
                ],
            )
        rows.append(
            LayerRow(
                id=row.id,
                group_id=row.group_id,
                order=row.order,
                visible=row.visible,
                position=row.position,
                query=row.query,
                time_value=row.time_value,
                legend_expanded=row.legend_expanded,
                style_id=style_id,
            )
        )
    document = build_map_document(
        basemap=project.basemap,
        locale=project.locale,
        view_state=project.initial_view_state,
        bounds=project.max_extent,
        groups=[GroupRow(*g) for g in groups],
        layers=rows,
    )
    return MapResponse(map=document, styles=styles)


#: Map state columns that cannot be null: a null sent for them writes nothing.
_NOT_NULL = {"visible", "position", "legend_expanded"}


async def write_layer_map_state(
    session: AsyncSession, *, layer_project_id: int, state: LayerMapState
) -> None:
    """Writes the fields sent, in one statement, last write wins (no 13.1): the
    project layer's `updated_at` stays, since the web keys its tile sources on it.
    422 `style_not_on_layer` for an active style of another project layer."""
    values = {
        key: getattr(state, key)
        for key in state.model_fields_set
        if not (key in _NOT_NULL and getattr(state, key) is None)
    }
    if not values:
        return
    params: dict[str, Any] = {"lp": layer_project_id}
    sets = []
    for key, value in values.items():
        if key == "time_value":
            sets.append("time_value = CAST(:time_value AS jsonb)")
            params[key] = None if value is None else json.dumps(value)
        else:
            sets.append(f"{key} = :{key}")
            params[key] = value
    guard = ""
    if values.get("active_style_id") is not None:
        guard = (
            f" AND EXISTS (SELECT 1 FROM {settings.SCHEMA}.layer_style "
            "WHERE id = :active_style_id AND layer_project_id = :lp)"
        )
    written = (
        await session.execute(
            text(
                f"UPDATE {settings.SCHEMA}.layer_project SET {', '.join(sets)} "
                f"WHERE id = :lp{guard} RETURNING id"
            ),
            params,
        )
    ).scalar_one_or_none()
    await session.commit()
    if written is None:
        raise StyleSaveError(422, "style_not_on_layer")


async def write_group_map_state(
    session: AsyncSession, *, project_id: UUID, group_id: int, state: GroupMapState
) -> None:
    """A layer group's visibility; 404 `not_found` for a group of another project."""
    written = (
        await session.execute(
            text(
                f"UPDATE {settings.SCHEMA}.layer_project_group SET visible = :v "
                "WHERE id = :g AND project_id = :p RETURNING id"
            ),
            {"v": state.visible, "g": group_id, "p": project_id},
        )
    ).scalar_one_or_none()
    await session.commit()
    if written is None:
        raise StyleSaveError(404, "not_found")


def _only(entries: list[dict[str, Any]], link_ids: set[int]) -> list[dict[str, Any]]:
    """The tree with only these project layers (groups stay)."""
    out = []
    for entry in entries:
        if entry["type"] == "group":
            out.append(
                {**entry, "children": _only(entry.get("children") or [], link_ids)}
            )
        elif entry["id"] in link_ids:
            out.append(entry)
    return out


async def map_snapshot(
    session: AsyncSession,
    *,
    project_id: UUID,
    user_id: UUID | None,
    link_ids: set[int],
    view_state: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, list[StyleRead]]]:
    """What publishing stores (spec 13.2): the map document with the published
    layers and the public view, and every named style of those layers, computed
    values included, since a published map never computes."""
    result = await map_for_project(
        session, project_id=project_id, user_id=user_id or UUID(int=0)
    )
    document = dict(result.map)
    document["layers"] = _only(document.get("layers") or [], link_ids)
    view = map_view(view_state, (document.get("view") or {}).get("bounds"))
    if view:
        document["view"] = view
    else:
        document.pop("view", None)
    rows = (
        await session.execute(
            text(
                "SELECT s.id, s.layer_project_id, s.name, s.position, s.revision, s.document, "
                "l.type::text AS layer_type, l.feature_layer_geometry_type::text AS geometry, "
                "l.data_type::text AS data_type "
                f"FROM {settings.SCHEMA}.layer_style s "
                f"JOIN {settings.SCHEMA}.layer_project lp ON lp.id = s.layer_project_id "
                f"JOIN {settings.SCHEMA}.layer l ON l.id = lp.layer_id "
                "WHERE s.layer_project_id = ANY(:ids) "
                "ORDER BY s.layer_project_id, s.position, s.created_at"
            ),
            {"ids": sorted(link_ids)},
        )
    ).all()
    styles: dict[str, list[StyleRead]] = {}
    for row in rows:
        context = layer_context(row.layer_type, row.geometry, row.data_type)
        styles.setdefault(str(row.layer_project_id), []).append(
            StyleRead(
                id=row.id,
                name=row.name,
                position=row.position,
                revision=row.revision,
                document=upgrade(row.document, context).document,
            )
        )
    return document, styles


async def published_styles_differ(
    session: AsyncSession, project_id: UUID
) -> list[UnpublishedChange]:
    """The published layers whose named styles differ from the published snapshot.
    A difference in computed values only (new data recomputed the classes) is
    `recomputed`; anything the author changed, or a style added or removed, is
    `edited`. Stamps alone (`computed.at`, `computed.data`) are no change. A
    published layer the project no longer has is not listed: there is no layer to
    name, and removing it is no style change."""
    config = (
        await session.execute(
            text(
                f"SELECT config FROM {settings.SCHEMA}.project_public WHERE project_id = :p"
            ),
            {"p": project_id},
        )
    ).scalar_one_or_none()
    published = (config or {}).get("styles")
    if not isinstance(published, dict) or not published:
        return []
    rows = (
        await session.execute(
            text(
                f"SELECT lp.id AS layer_project_id, s.id, s.document "
                f"FROM {settings.SCHEMA}.layer_project lp "
                f"LEFT JOIN {settings.SCHEMA}.layer_style s ON s.layer_project_id = lp.id "
                "WHERE lp.project_id = :p AND lp.id = ANY(:ids)"
            ),
            {"p": project_id, "ids": [int(k) for k in published]},
        )
    ).all()
    current: dict[int, dict[str, dict[str, Any]]] = {}
    for row in rows:
        styles = current.setdefault(row.layer_project_id, {})
        if row.id is not None:
            styles[str(row.id)] = row.document
    changes = []
    for key, snapshot in published.items():
        if int(key) not in current:
            continue
        then = {s["id"]: s["document"] for s in snapshot}
        now = current[int(key)]
        if set(then) != set(now):
            reason: str | None = "edited"
        else:
            reasons = set()
            for style_id, document in now.items():
                if same_ignoring_stamps(document, then[style_id]):
                    continue
                reasons.add(
                    "edited" if diff(then[style_id], document) else "recomputed"
                )
            reason = (
                "edited" if "edited" in reasons else ("recomputed" if reasons else None)
            )
        if reason:
            changes.append(UnpublishedChange(layer_project_id=int(key), reason=reason))
    return sorted(changes, key=lambda c: c.layer_project_id)
