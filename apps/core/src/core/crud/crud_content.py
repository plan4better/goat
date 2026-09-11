"""The unified feed — `GET /content`.

One feed over the five content tables (folder, project, layer, bundle,
template) plus a "shared with me" and a "recent" view, so the Content page
can replace the two client-merged Datasets/Projects pages. Each view is
built as ONE raw SQL statement (the tables unioned, `effective_role` — a SQL
function — applied per row) rather than composed in the ORM.

Seam: each view's `items` CTE is the one place new UNION branches are
listed (e.g. `content_shortcut`) — add a branch there, not a second query.
"""

from typing import Any, List, Sequence
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import Row, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core import authz
from core.core.config import settings
from core.core.content import fetch_grants_by_resource, granted_ids
from core.crud.crud_space import space as crud_space
from core.db.models.folder import Folder
from core.db.models.space import Space, SpaceKind
from core.schemas.content import (
    ContentCreator,
    ContentItem,
    ContentPage,
    ContentView,
    ResourceType,
    SharedWith,
)
from core.templates.snapshot import kinds_for

_ORDER_COLUMNS: dict[str, str] = {
    "updated_at": "i.updated_at",
    "created_at": "i.created_at",
    "name": "i.name",
    "last_opened_at": "last_opened_at",
}
_ORDER_DIRECTIONS: dict[str, str] = {
    "ascendent": "ASC",
    "descendent": "DESC",
}
_RESOURCE_TYPES: tuple[ResourceType, ...] = (
    "layer",
    "project",
    "folder",
    "bundle",
    "template",
)

# Common item shape every view's `items` CTE produces, in this column order:
# type, id, name, space_id, folder_id, updated_at, created_at, layer_type,
# feature_layer_geometry_type, thumbnail_url, is_public [, is_shortcut],
# restricted, restricted_inherited, created_by_id — `effective_role` and the window `total` are appended
# by the outer SELECT each view shares. `is_shortcut` is optional: only
# `_space_view_sql`'s items CTE carries it (the `content_shortcut` UNION
# branch); `_to_page` defaults it to False for the other views' rows, which
# never grew that column. The tail also computes `last_opened_at` from the
# caller's own `user_project` link (a scalar subquery, so a stray duplicate
# link can never fan a row out; falls back to `updated_at` for non-project
# rows and never-opened projects) so `order_by=last_opened_at` ranks by what
# *this* caller last opened rather than a row's last edit.
_ITEMS_TAIL = """
SELECT i.*, {S}.effective_role(i.type, i.id, :user_id) AS my_role, count(*) OVER () AS total,
       COALESCE((SELECT max(up.last_opened_at) FROM {S}.user_project up
                  WHERE i.type = 'project' AND up.project_id = i.id AND up.user_id = :user_id),
                i.updated_at) AS last_opened_at
  FROM items i
 WHERE {S}.effective_role(i.type, i.id, :user_id) IS NOT NULL
   AND (CAST(:search AS text) IS NULL OR i.name ILIKE '%' || CAST(:search AS text) || '%')
   AND (CAST(:types AS text[]) IS NULL OR i.type = ANY(CAST(:types AS text[])))
"""


# The artwork a row falls back to when it carries no thumbnail of its own —
# the same defaults `IProjectRead` and `ThumbnailUrlMixin` apply to the
# single-resource reads. A folder has no picture: its card draws its own tile.
_DEFAULT_THUMBNAILS: dict[str, str | None] = {
    "project": settings.DEFAULT_PROJECT_THUMBNAIL,
    "layer": settings.DEFAULT_LAYER_THUMBNAIL,
    "bundle": settings.DEFAULT_LAYER_THUMBNAIL,
    "folder": None,
    "template": settings.DEFAULT_PROJECT_THUMBNAIL,
}


def _thumbnail_url(resource_type: str, stored: str | None) -> str | None:
    """What the feed hands the client for one row's thumbnail: a stored
    `thumbnails/…` S3 key becomes a presigned URL, an absolute URL is passed
    through, and a row without one gets its kind's default artwork."""
    # Imported here, as the read schemas do, so the S3 client is only built
    # when a thumbnail actually has to be resolved.
    from core.services.s3 import s3_service

    default = _DEFAULT_THUMBNAILS.get(resource_type)
    if not stored:
        return default
    return s3_service.get_thumbnail_url(stored, default_url=default)


def _validate_order(order_by: str, order: str) -> tuple[str, str]:
    """400 on anything outside the allow-lists — the only two formatted
    (not bound) values besides the schema name."""
    if order_by not in _ORDER_COLUMNS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid order_by: {order_by!r}",
        )
    if order not in _ORDER_DIRECTIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid order: {order!r}",
        )
    return _ORDER_COLUMNS[order_by], _ORDER_DIRECTIONS[order]


def _validate_types(types: list[str] | None) -> list[str] | None:
    if types is None:
        return None
    invalid = [t for t in types if t not in _RESOURCE_TYPES]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid types: {invalid!r}",
        )
    return types


def _restricted_cols(
    schema: str, resource_type: str, alias: str, folder_col: str
) -> str:
    """The Restricted pair (D9) every feed branch carries: the row's own flag,
    and whether it is closed by something above it — an ancestor folder, or a
    bundle holding it — rather than by itself."""
    return (
        f"{alias}.restricted, "
        f"{schema}.restricted_applies('{resource_type}', {alias}.id, {folder_col}) "
        f"AND NOT {alias}.restricted AS restricted_inherited"
    )


def _public_col(schema: str, alias: str) -> str:
    """Whether this project has a published public snapshot (a
    `project_public` row). Only projects can be published, so every other
    branch selects FALSE in this position."""
    return (
        f"EXISTS (SELECT 1 FROM {schema}.project_public pp "
        f"WHERE pp.project_id = {alias}.id) AS is_public"
    )


def _item_scope(col: str) -> str:
    """Where an item may sit to be listed: while browsing, the folder being
    looked at; while searching, that folder and every folder beneath it (the
    `scope` CTE), so a search from a space's root covers the whole space."""
    return (
        f"AND ((CAST(:search AS text) IS NULL AND {col} IS NOT DISTINCT FROM :content_folder_id)"
        f" OR (CAST(:search AS text) IS NOT NULL AND {col} IN (SELECT id FROM scope)))"
    )


def _folder_scope(parent_col: str, id_col: str) -> str:
    """The same for folders: direct children while browsing, every descendant
    while searching — never the browsed folder itself.

    A folder's children are the folders parented on it, but a space's root
    is two things at once: the `home` folder (`:content_folder_id`, where
    everything filed at the root actually lives) and the parentless level
    `home` itself sits on (`:folder_id`, NULL there). Both are children of
    the root listing, so browsing matches either — inside a named folder the
    two parameters hold the same id and the second half is redundant."""
    return (
        f"AND ((CAST(:search AS text) IS NULL AND ({parent_col} IS NOT DISTINCT FROM :folder_id"
        f" OR {parent_col} IS NOT DISTINCT FROM :content_folder_id))"
        f" OR (CAST(:search AS text) IS NOT NULL AND {id_col} IN (SELECT id FROM scope)"
        f" AND {id_col} IS DISTINCT FROM CAST(:folder_id AS uuid)))"
    )


def _shortcut_folder_scope(col: str) -> str:
    """A folder shortcut is filed where it was left (`cs.folder_id`) — the
    `home` folder, or NULL, at a space's root: that folder while browsing
    (both root spellings, as `_folder_scope`), anywhere in scope while
    searching."""
    return (
        f"AND ((CAST(:search AS text) IS NULL AND ({col} IS NOT DISTINCT FROM :folder_id"
        f" OR {col} IS NOT DISTINCT FROM :content_folder_id))"
        f" OR (CAST(:search AS text) IS NOT NULL AND ({col} IN (SELECT id FROM scope)"
        f" OR (CAST(:folder_id AS uuid) IS NULL AND {col} IS NULL))))"
    )


def _space_view_sql(schema: str, order_col: str, order_dir: str) -> str:
    return f"""
WITH RECURSIVE scope AS (
    -- The folders a search reaches: the browsed folder (or, at a space's
    -- root, every root folder including `home`) and all their descendants.
    SELECT f.id
      FROM {schema}.folder f
     WHERE f.space_id = :space_id AND f.deleted_at IS NULL
       AND ((CAST(:folder_id AS uuid) IS NULL AND f.parent_id IS NULL)
            OR f.id = CAST(:folder_id AS uuid))
    UNION
    SELECT c.id
      FROM {schema}.folder c
      JOIN scope s ON c.parent_id = s.id
     WHERE c.deleted_at IS NULL
), items AS (
    SELECT 'folder' AS type, f.id, f.name, f.space_id, f.parent_id AS folder_id, f.updated_at, f.created_at,
           NULL::text AS layer_type, NULL::text AS feature_layer_geometry_type, NULL::text AS thumbnail_url,
           FALSE AS is_public, FALSE AS is_shortcut,
           {_restricted_cols(schema, "folder", "f", "f.parent_id")},
           f.user_id AS created_by_id
      FROM {schema}.folder f
     WHERE f.space_id = :space_id AND f.deleted_at IS NULL
       {_folder_scope("f.parent_id", "f.id")}
       AND f.id IS DISTINCT FROM :exclude_folder_id
    UNION ALL
    SELECT 'project', p.id, p.name, p.space_id, p.folder_id, p.updated_at, p.created_at, NULL, NULL, p.thumbnail_url,
           {_public_col(schema, "p")}, FALSE,
           {_restricted_cols(schema, "project", "p", "p.folder_id")},
           p.user_id AS created_by_id
      FROM {schema}.project p
     WHERE p.space_id = :space_id AND p.deleted_at IS NULL
       {_item_scope("p.folder_id")}
       AND NOT p.is_template_source
    UNION ALL
    SELECT 'layer', l.id, l.name, l.space_id, l.folder_id, l.updated_at, l.created_at, l.type::text, l.feature_layer_geometry_type::text, l.thumbnail_url,
           FALSE, FALSE,
           {_restricted_cols(schema, "layer", "l", "l.folder_id")},
           l.user_id AS created_by_id
      FROM {schema}.layer l
     WHERE l.space_id = :space_id AND l.deleted_at IS NULL
       {_item_scope("l.folder_id")}
       AND NOT EXISTS (SELECT 1 FROM {schema}.bundle_layer bl WHERE bl.layer_id = l.id)
    UNION ALL
    SELECT 'bundle', b.id, b.name, b.space_id, b.folder_id, b.updated_at, b.created_at, NULL, NULL, NULL,
           FALSE, FALSE,
           {_restricted_cols(schema, "bundle", "b", "b.folder_id")},
           b.user_id AS created_by_id
      FROM {schema}.bundle b
     WHERE b.space_id = :space_id AND b.deleted_at IS NULL
       {_item_scope("b.folder_id")}
    UNION ALL
    SELECT 'template', t.id, t.name, t.space_id, t.folder_id, t.updated_at, t.created_at, NULL, NULL, t.thumbnail_url,
           FALSE, FALSE,
           {_restricted_cols(schema, "template", "t", "t.folder_id")},
           t.user_id AS created_by_id
      FROM {schema}.template t
     WHERE t.space_id = :space_id AND t.deleted_at IS NULL
       {_item_scope("t.folder_id")}
    -- A shortcut left behind in the source folder after a transfer.
    -- Joined to the real target row so the listing shows its actual name,
    -- type and thumbnail; `effective_role` below is evaluated against the
    -- target's real id, so what the caller may do with it (now governed by
    -- the space it moved into) is unaffected by the shortcut being cosmetic.
    -- `space_id` is the target's own space too (where following the shortcut
    -- leads); `cs.space_id = :space_id` in each WHERE is what scopes the row
    -- to the space being listed. `restricted`/`restricted_inherited` read the
    -- target at its real location, so a shortcut carries the target's badge.
    UNION ALL
    SELECT 'folder', f.id, f.name, f.space_id, cs.folder_id, f.updated_at, f.created_at,
           NULL::text, NULL::text, NULL::text, FALSE, TRUE,
           {_restricted_cols(schema, "folder", "f", "f.parent_id")},
           f.user_id AS created_by_id
      FROM {schema}.content_shortcut cs
      JOIN {schema}.folder f ON f.id = cs.target_id AND cs.target_type = 'folder'
     WHERE cs.space_id = :space_id AND f.deleted_at IS NULL
       {_shortcut_folder_scope("cs.folder_id")}
    UNION ALL
    SELECT 'project', p.id, p.name, p.space_id, cs.folder_id, p.updated_at, p.created_at, NULL, NULL, p.thumbnail_url,
           {_public_col(schema, "p")}, TRUE,
           {_restricted_cols(schema, "project", "p", "p.folder_id")},
           p.user_id AS created_by_id
      FROM {schema}.content_shortcut cs
      JOIN {schema}.project p ON p.id = cs.target_id AND cs.target_type = 'project'
     WHERE cs.space_id = :space_id AND p.deleted_at IS NULL
       {_item_scope("cs.folder_id")}
       AND NOT p.is_template_source
    UNION ALL
    SELECT 'layer', l.id, l.name, l.space_id, cs.folder_id, l.updated_at, l.created_at, l.type::text, l.feature_layer_geometry_type::text, l.thumbnail_url,
           FALSE, TRUE,
           {_restricted_cols(schema, "layer", "l", "l.folder_id")},
           l.user_id AS created_by_id
      FROM {schema}.content_shortcut cs
      JOIN {schema}.layer l ON l.id = cs.target_id AND cs.target_type = 'layer'
     WHERE cs.space_id = :space_id AND l.deleted_at IS NULL
       {_item_scope("cs.folder_id")}
    UNION ALL
    SELECT 'bundle', b.id, b.name, b.space_id, cs.folder_id, b.updated_at, b.created_at, NULL, NULL, NULL,
           FALSE, TRUE,
           {_restricted_cols(schema, "bundle", "b", "b.folder_id")},
           b.user_id AS created_by_id
      FROM {schema}.content_shortcut cs
      JOIN {schema}.bundle b ON b.id = cs.target_id AND cs.target_type = 'bundle'
     WHERE cs.space_id = :space_id AND b.deleted_at IS NULL
       {_item_scope("cs.folder_id")}
)
{_ITEMS_TAIL.format(S=schema)}
 ORDER BY (i.type = 'folder') DESC, {order_col} {order_dir}
 LIMIT :size OFFSET :offset
"""


def _granted_items_cte(schema: str) -> str:
    """The four `id = ANY(:<type>_ids)` branches shared by the
    `shared_with_me` and `shared_with_space` views."""
    return f"""
    SELECT 'folder' AS type, f.id, f.name, f.space_id, f.parent_id AS folder_id, f.updated_at, f.created_at,
           NULL::text AS layer_type, NULL::text AS feature_layer_geometry_type, NULL::text AS thumbnail_url,
           FALSE AS is_public,
           {_restricted_cols(schema, "folder", "f", "f.parent_id")},
           f.user_id AS created_by_id
      FROM {schema}.folder f
     WHERE f.deleted_at IS NULL AND f.id = ANY(:folder_ids) AND f.space_id IS NOT NULL
    UNION ALL
    SELECT 'project', p.id, p.name, p.space_id, p.folder_id, p.updated_at, p.created_at, NULL, NULL, p.thumbnail_url,
           {_public_col(schema, "p")},
           {_restricted_cols(schema, "project", "p", "p.folder_id")},
           p.user_id AS created_by_id
      FROM {schema}.project p
     WHERE p.deleted_at IS NULL AND p.id = ANY(:project_ids) AND p.space_id IS NOT NULL
       AND NOT p.is_template_source
    UNION ALL
    SELECT 'layer', l.id, l.name, l.space_id, l.folder_id, l.updated_at, l.created_at, l.type::text, l.feature_layer_geometry_type::text, l.thumbnail_url,
           FALSE,
           {_restricted_cols(schema, "layer", "l", "l.folder_id")},
           l.user_id AS created_by_id
      FROM {schema}.layer l
     WHERE l.deleted_at IS NULL AND l.id = ANY(:layer_ids) AND l.space_id IS NOT NULL
    UNION ALL
    SELECT 'bundle', b.id, b.name, b.space_id, b.folder_id, b.updated_at, b.created_at, NULL, NULL, NULL,
           FALSE,
           {_restricted_cols(schema, "bundle", "b", "b.folder_id")},
           b.user_id AS created_by_id
      FROM {schema}.bundle b
     WHERE b.deleted_at IS NULL AND b.id = ANY(:bundle_ids) AND b.space_id IS NOT NULL
    UNION ALL
    SELECT 'template', t.id, t.name, t.space_id, t.folder_id, t.updated_at, t.created_at, NULL, NULL, t.thumbnail_url,
           FALSE,
           {_restricted_cols(schema, "template", "t", "t.folder_id")},
           t.user_id AS created_by_id
      FROM {schema}.template t
     WHERE t.deleted_at IS NULL AND t.id = ANY(:template_ids) AND t.space_id IS NOT NULL
"""


def _shared_with_me_view_sql(schema: str, order_col: str, order_dir: str) -> str:
    return f"""
WITH items AS ({_granted_items_cte(schema)})
{_ITEMS_TAIL.format(S=schema)}
   AND {schema}.space_rank(i.space_id, :user_id) = 0
 ORDER BY {order_col} {order_dir}
 LIMIT :size OFFSET :offset
"""


def _shared_with_space_view_sql(schema: str, order_col: str, order_dir: str) -> str:
    return f"""
WITH items AS ({_granted_items_cte(schema)})
{_ITEMS_TAIL.format(S=schema)}
   AND i.space_id IS DISTINCT FROM :space_id
 ORDER BY {order_col} {order_dir}
 LIMIT :size OFFSET :offset
"""


def _recent_view_sql(schema: str, order_col: str, order_dir: str) -> str:
    return f"""
WITH items AS (
    SELECT 'folder' AS type, f.id, f.name, f.space_id, f.parent_id AS folder_id, f.updated_at, f.created_at,
           NULL::text AS layer_type, NULL::text AS feature_layer_geometry_type, NULL::text AS thumbnail_url,
           FALSE AS is_public,
           {_restricted_cols(schema, "folder", "f", "f.parent_id")},
           f.user_id AS created_by_id
      FROM {schema}.folder f
     WHERE f.deleted_at IS NULL AND f.space_id IS NOT NULL
       AND (f.space_id = ANY(:my_space_ids) OR f.id = ANY(:folder_ids))
    UNION ALL
    SELECT 'project', p.id, p.name, p.space_id, p.folder_id, p.updated_at, p.created_at, NULL, NULL, p.thumbnail_url,
           {_public_col(schema, "p")},
           {_restricted_cols(schema, "project", "p", "p.folder_id")},
           p.user_id AS created_by_id
      FROM {schema}.project p
     WHERE p.deleted_at IS NULL AND p.space_id IS NOT NULL
       AND (p.space_id = ANY(:my_space_ids) OR p.id = ANY(:project_ids))
       AND NOT p.is_template_source
    UNION ALL
    SELECT 'layer', l.id, l.name, l.space_id, l.folder_id, l.updated_at, l.created_at, l.type::text, l.feature_layer_geometry_type::text, l.thumbnail_url,
           FALSE,
           {_restricted_cols(schema, "layer", "l", "l.folder_id")},
           l.user_id AS created_by_id
      FROM {schema}.layer l
     WHERE l.deleted_at IS NULL AND l.space_id IS NOT NULL
       AND (l.space_id = ANY(:my_space_ids) OR l.id = ANY(:layer_ids))
       AND NOT EXISTS (SELECT 1 FROM {schema}.bundle_layer bl WHERE bl.layer_id = l.id)
    UNION ALL
    SELECT 'bundle', b.id, b.name, b.space_id, b.folder_id, b.updated_at, b.created_at, NULL, NULL, NULL,
           FALSE,
           {_restricted_cols(schema, "bundle", "b", "b.folder_id")},
           b.user_id AS created_by_id
      FROM {schema}.bundle b
     WHERE b.deleted_at IS NULL AND b.space_id IS NOT NULL
       AND (b.space_id = ANY(:my_space_ids) OR b.id = ANY(:bundle_ids))
    -- The shelf rule (T4): a published template is visible to everyone
    -- through this view regardless of the space it lives in, in addition
    -- to the same my-space/granted reach every other row here gets.
    UNION ALL
    SELECT 'template', t.id, t.name, t.space_id, t.folder_id, t.updated_at, t.created_at, NULL, NULL, t.thumbnail_url,
           FALSE,
           {_restricted_cols(schema, "template", "t", "t.folder_id")},
           t.user_id AS created_by_id
      FROM {schema}.template t
     WHERE t.deleted_at IS NULL AND t.space_id IS NOT NULL
       AND (t.space_id = ANY(:my_space_ids) OR t.id = ANY(:template_ids)
            OR t.catalog_status = 'published')
)
{_ITEMS_TAIL.format(S=schema)}
 ORDER BY {order_col} {order_dir}
 LIMIT :size OFFSET :offset
"""


class CRUDContent:
    # Every method below `list` uses `typing.List` rather than the lowercase
    # builtin generic in its signature: once `list` is bound in this class's
    # namespace as a method, it shadows the builtin `list` for any bare
    # `list[...]` annotation written later in the same class body (mirrors
    # CRUDTrash.list's own `List[...]` usage, same reason).
    async def list(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        view: ContentView,
        space_id: UUID | None,
        folder_id: UUID | None,
        search: str | None,
        types: list[str] | None,
        order_by: str,
        order: str,
        page: int,
        size: int,
    ) -> ContentPage:
        types = _validate_types(types)
        order_col, order_dir = _validate_order(order_by, order)
        offset = (page - 1) * size

        if view == "space":
            if space_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="space_id is required for view=space",
                )
            return await self._list_space(
                db,
                user_id=user_id,
                space_id=space_id,
                folder_id=folder_id,
                search=search,
                types=types,
                order_col=order_col,
                order_dir=order_dir,
                page=page,
                size=size,
                offset=offset,
            )
        if view == "shared_with_me":
            return await self._list_shared_with_me(
                db,
                user_id=user_id,
                search=search,
                types=types,
                order_col=order_col,
                order_dir=order_dir,
                page=page,
                size=size,
                offset=offset,
            )
        if view == "shared_with_space":
            if space_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="space_id is required for view=shared_with_space",
                )
            return await self._list_shared_with_space(
                db,
                user_id=user_id,
                space_id=space_id,
                search=search,
                types=types,
                order_col=order_col,
                order_dir=order_dir,
                page=page,
                size=size,
                offset=offset,
            )
        return await self._list_recent(
            db,
            user_id=user_id,
            search=search,
            types=types,
            order_col=order_col,
            order_dir=order_dir,
            page=page,
            size=size,
            offset=offset,
        )

    async def _list_space(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        space_id: UUID,
        folder_id: UUID | None,
        search: str | None,
        types: List[str] | None,
        order_col: str,
        order_dir: str,
        page: int,
        size: int,
        offset: int,
    ) -> ContentPage:
        content_folder_id = folder_id
        exclude_folder_id: UUID | None = None

        if folder_id is not None:
            # Per-target gate: a folder's grantee may open it even in a
            # space they are not a member of — `effective_role` already
            # walks ancestor-folder grants, so `authz.can(...,
            # "read")` covers both "I'm a space member" and "I hold a grant
            # on this folder or an ancestor of it". `space_id` is required
            # by every caller of `view=space` (checked in `list()`), but
            # once a folder is named it — not the query param — is
            # authoritative for which space is being listed.
            folder = await db.get(Folder, folder_id)
            if folder is None or folder.deleted_at is not None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
                )
            if folder.space_id != space_id:
                # A folder shared into a space is opened under that space —
                # the one the caller browsed from — so the page keeps its
                # place in the space list and the trail. That context space
                # has to be one of the caller's own; the folder itself is
                # gated below like any other.
                context = await db.get(Space, space_id)
                if context is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND, detail="Space not found"
                    )
                if await crud_space.my_role(db, space=context, user_id=user_id) is None:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Not a member of this space",
                    )
            if not await authz.can(db, "folder", folder_id, user_id, "read"):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not allowed to read this folder",
                )
            space_id = folder.space_id
        else:
            # No folder_id: listing a space's root requires membership — a
            # grant on some folder inside the space opens that folder (see
            # above), not the space's root.
            space = await db.get(Space, space_id)
            if space is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Space not found"
                )
            if await crud_space.my_role(db, space=space, user_id=user_id) is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not a member of this space",
                )
            # A space's "root" for content is its `home` folder — projects,
            # layers and bundles need a folder to live in, and everything
            # created, moved or transferred to a space root is filed there.
            # Its children are merged into the root listing and the folder
            # itself is hidden, so the root shows what the user put at the
            # root and no `home` card of its own. Every space kind has one.
            home_id = await self._home_folder_id(db, space_id)
            content_folder_id = home_id
            exclude_folder_id = home_id

        schema = settings.SCHEMA
        rows, total = await self._fetch_rows(
            db,
            _space_view_sql(schema, order_col, order_dir),
            {
                "space_id": space_id,
                "folder_id": folder_id,
                "content_folder_id": content_folder_id,
                "exclude_folder_id": exclude_folder_id,
                "user_id": user_id,
                "search": search,
                "types": types,
                "size": size,
                "offset": offset,
            },
        )
        return await self._to_page(db, rows, page=page, size=size, total=total)

    async def _list_shared_with_me(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        search: str | None,
        types: List[str] | None,
        order_col: str,
        order_dir: str,
        page: int,
        size: int,
        offset: int,
    ) -> ContentPage:
        schema = settings.SCHEMA
        folder_ids = await self._granted_ids(db, "folder", user_id)
        project_ids = await self._granted_ids(db, "project", user_id)
        layer_ids = await self._granted_ids(db, "layer", user_id)
        bundle_ids = await self._granted_ids(db, "bundle", user_id)
        template_ids = await self._granted_ids(db, "template", user_id)
        rows, total = await self._fetch_rows(
            db,
            _shared_with_me_view_sql(schema, order_col, order_dir),
            {
                "folder_ids": folder_ids,
                "project_ids": project_ids,
                "layer_ids": layer_ids,
                "bundle_ids": bundle_ids,
                "template_ids": template_ids,
                "user_id": user_id,
                "search": search,
                "types": types,
                "size": size,
                "offset": offset,
            },
        )
        return await self._to_page(db, rows, page=page, size=size, total=total)

    async def _list_shared_with_space(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        space_id: UUID,
        search: str | None,
        types: List[str] | None,
        order_col: str,
        order_dir: str,
        page: int,
        size: int,
        offset: int,
    ) -> ContentPage:
        """Items living elsewhere that this team/organisation space holds a
        direct grant on — the "Shared with {space}" section at the bottom of
        a team or organisation space. Members only."""
        space = await db.get(Space, space_id)
        if space is None or space.kind == SpaceKind.personal:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Space not found"
            )
        rank = (
            await db.execute(
                text(f"SELECT {settings.SCHEMA}.space_rank(:s, :u)"),
                {"s": space_id, "u": user_id},
            )
        ).scalar_one()
        if rank < 1:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Not a member"
            )
        ids = {
            rt: await self._space_grantee_ids(db, rt, space)
            for rt in ("folder", "project", "layer", "bundle", "template")
        }
        rows, total = await self._fetch_rows(
            db,
            _shared_with_space_view_sql(settings.SCHEMA, order_col, order_dir),
            {
                "folder_ids": ids["folder"],
                "project_ids": ids["project"],
                "layer_ids": ids["layer"],
                "bundle_ids": ids["bundle"],
                "template_ids": ids["template"],
                "space_id": space_id,
                "user_id": user_id,
                "search": search,
                "types": types,
                "size": size,
                "offset": offset,
            },
        )
        return await self._to_page(db, rows, page=page, size=size, total=total)

    async def _space_grantee_ids(
        self, db: AsyncSession, resource_type: str, space: Space
    ) -> List[UUID]:
        """Resources with a direct grant to the space's team (or organisation)."""
        return list(
            (
                await db.execute(
                    granted_ids(
                        resource_type, None, space.team_id, space.organization_id
                    )
                )
            ).scalars()
        )

    async def _list_recent(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        search: str | None,
        types: List[str] | None,
        order_col: str,
        order_dir: str,
        page: int,
        size: int,
        offset: int,
    ) -> ContentPage:
        schema = settings.SCHEMA
        my_space_ids = await self.my_space_ids(db, user_id)
        folder_ids = await self._granted_ids(db, "folder", user_id)
        project_ids = await self._granted_ids(db, "project", user_id)
        layer_ids = await self._granted_ids(db, "layer", user_id)
        bundle_ids = await self._granted_ids(db, "bundle", user_id)
        template_ids = await self._granted_ids(db, "template", user_id)
        rows, total = await self._fetch_rows(
            db,
            _recent_view_sql(schema, order_col, order_dir),
            {
                "my_space_ids": my_space_ids,
                "folder_ids": folder_ids,
                "project_ids": project_ids,
                "layer_ids": layer_ids,
                "bundle_ids": bundle_ids,
                "template_ids": template_ids,
                "user_id": user_id,
                "search": search,
                "types": types,
                "size": size,
                "offset": offset,
            },
        )
        return await self._to_page(db, rows, page=page, size=size, total=total)

    async def _fetch_rows(
        self, db: AsyncSession, sql: str, params: dict[str, Any]
    ) -> tuple[Sequence[Row[Any]], int]:
        """One feed query's page of rows, plus how many rows the whole
        (unpaged) query matches.

        The total rides along on every row as a `count(*) OVER ()` window,
        so a page past the last one — which comes back empty — carries no
        count with it. There the total is re-read from the first row of the
        same query at offset 0, so a client that paged off the end still
        gets the count its pager needs instead of 0.
        """
        rows = (await db.execute(text(sql), params)).all()
        if rows:
            return rows, int(rows[0].total)
        if not params.get("offset"):
            return rows, 0
        probe = (
            await db.execute(text(sql), {**params, "size": 1, "offset": 0})
        ).first()
        return rows, int(probe.total) if probe is not None else 0

    async def _home_folder_id(self, db: AsyncSession, space_id: UUID) -> UUID | None:
        return (
            await db.execute(
                select(Folder.id).where(
                    Folder.space_id == space_id,
                    Folder.parent_id.is_(None),
                    Folder.deleted_at.is_(None),
                    Folder.name == "home",
                )
            )
        ).scalar_one_or_none()

    async def _granted_ids(
        self, db: AsyncSession, resource_type: str, user_id: UUID
    ) -> List[UUID]:
        """Resources of `resource_type` the caller has a direct *user* grant
        on — the `shared_with_me`/`recent` candidate set. Team/organisation
        grants are not part of "shared with me": they already show up
        through the grantee's own space membership."""
        return list(
            (
                await db.execute(granted_ids(resource_type, user_id, None, None))
            ).scalars()
        )

    async def my_space_ids(self, db: AsyncSession, user_id: UUID) -> List[UUID]:
        """Every space the caller is a member of: their personal space, each
        team space they belong to, and their organisation's space."""
        schema = settings.SCHEMA
        rows = await db.execute(
            text(
                f"""
                SELECT s.id FROM {schema}.space s
                 WHERE (s.kind = 'personal' AND s.user_id = :u)
                    OR (s.kind = 'team' AND EXISTS (
                            SELECT 1 FROM {schema}.user_team ut
                             WHERE ut.team_id = s.team_id AND ut.user_id = :u))
                    OR (s.kind = 'organization' AND EXISTS (
                            SELECT 1 FROM {schema}."user" usr
                             WHERE usr.id = :u AND usr.organization_id = s.organization_id))
                """
            ),
            {"u": user_id},
        )
        return [r[0] for r in rows.all()]

    async def _creators(
        self, db: AsyncSession, user_ids: set[UUID]
    ) -> dict[UUID, ContentCreator]:
        """One lookup for every distinct creator on the page. A creator whose
        account is gone is simply absent, and the row's `created_by` stays
        None."""
        if not user_ids:
            return {}
        rows = (
            await db.execute(
                text(
                    f'SELECT id, firstname, lastname, avatar FROM {settings.SCHEMA}."user" '
                    "WHERE id = ANY(:ids)"
                ),
                {"ids": list(user_ids)},
            )
        ).all()
        return {
            r.id: ContentCreator(
                id=r.id,
                name=" ".join(part for part in (r.firstname, r.lastname) if part),
                avatar=r.avatar or None,
            )
            for r in rows
        }

    async def _to_page(
        self,
        db: AsyncSession,
        rows: Sequence[Row[Any]],
        *,
        page: int,
        size: int,
        total: int,
    ) -> ContentPage:
        ids_by_type: dict[str, list[UUID]] = {t: [] for t in _RESOURCE_TYPES}
        for row in rows:
            ids_by_type[row.type].append(row.id)

        grants_by_type: dict[str, dict[UUID, dict[str, list[dict[str, Any]]]]] = {
            rtype: await fetch_grants_by_resource(db, rtype, ids)
            for rtype, ids in ids_by_type.items()
            if ids
        }
        creators = await self._creators(
            db, {row.created_by_id for row in rows if row.created_by_id is not None}
        )
        template_details = await self._template_details(db, ids_by_type["template"])

        items = [
            ContentItem(
                type=row.type,
                id=row.id,
                name=row.name,
                space_id=row.space_id,
                folder_id=row.folder_id,
                updated_at=row.updated_at,
                created_at=row.created_at,
                my_role=row.my_role,
                created_by=creators.get(row.created_by_id),
                shared_with=SharedWith(
                    **grants_by_type.get(row.type, {}).get(
                        row.id, {"teams": [], "organizations": [], "users": []}
                    )
                ),
                thumbnail_url=_thumbnail_url(row.type, row.thumbnail_url),
                is_public=bool(row.is_public),
                layer_type=row.layer_type,
                feature_layer_geometry_type=row.feature_layer_geometry_type,
                # Only `_space_view_sql`'s items CTE carries `is_shortcut` —
                # `shared_with_me`/`recent` rows never grew that column, so
                # default to False for them via getattr.
                is_shortcut=bool(getattr(row, "is_shortcut", False)),
                restricted=bool(row.restricted),
                restricted_inherited=bool(row.restricted_inherited),
                **template_details.get(row.id, {}),
            )
            for row in rows
        ]
        return ContentPage(items=items, total=total, page=page, size=size)

    async def _template_details(
        self, db: AsyncSession, template_ids: List[UUID]
    ) -> dict[UUID, dict[str, Any]]:
        """The four `template_*` `ContentItem` fields, for the page's
        template rows only (empty for every other view — plain `.get(id,
        {})` on the page's other rows never matches, so their `ContentItem`
        keeps the field defaults).

        `template_payload_kind`/`template_catalog_status` are read straight
        off the row. `template_kinds` is derived via `snapshot.kinds_for`
        (T1): a workflow/layout payload is its own single kind; a project
        payload reads the frozen source project via `_project_payload_kinds`
        — Dashboard/Workflow/Layout depending on what it actually holds,
        batched in one extra query rather than one per template.
        `template_ships_sample_data` is true once any declared input (T5) is
        a shipped, catalog-origin dataset.
        """
        if not template_ids:
            return {}
        schema = settings.SCHEMA
        rows = (
            await db.execute(
                text(
                    f"SELECT id, payload_kind, catalog_status, source_project_id, inputs "
                    f"FROM {schema}.template WHERE id = ANY(:ids)"
                ),
                {"ids": template_ids},
            )
        ).all()
        project_kinds = await self._project_payload_kinds(
            db, [r.source_project_id for r in rows if r.source_project_id is not None]
        )

        details: dict[UUID, dict[str, Any]] = {}
        for r in rows:
            if r.payload_kind == "project":
                kinds = project_kinds.get(r.source_project_id, ["dashboard"])
            else:
                kinds = kinds_for(
                    r.payload_kind,
                    has_builder=False,
                    has_workflows=False,
                    has_layouts=False,
                )
            ships_sample_data = any(
                isinstance(inp, dict)
                and inp.get("mode") == "ship"
                and inp.get("from_catalog")
                for inp in (r.inputs or [])
            )
            details[r.id] = {
                "template_payload_kind": r.payload_kind,
                "template_kinds": kinds,
                "template_catalog_status": r.catalog_status,
                "template_ships_sample_data": ships_sample_data,
            }
        return details

    async def _project_payload_kinds(
        self, db: AsyncSession, project_ids: List[UUID]
    ) -> dict[UUID, List[str]]:
        """T1's kind derivation for a project-payload template's frozen
        source, via `snapshot.kinds_for`: Dashboard if it has a builder
        config, plus Workflow if it holds any workflow row, plus Layout if
        it holds any report layout — never empty (a project is at minimum a
        map view, so a source with none of the three still reads as
        Dashboard)."""
        if not project_ids:
            return {}
        schema = settings.SCHEMA
        rows = (
            await db.execute(
                text(
                    "SELECT p.id, p.builder_config IS NOT NULL AS has_dashboard, "
                    f"EXISTS (SELECT 1 FROM {schema}.workflow w WHERE w.project_id = p.id) AS has_workflow, "
                    f"EXISTS (SELECT 1 FROM {schema}.report_layout rl WHERE rl.project_id = p.id) AS has_layout "
                    f"FROM {schema}.project p WHERE p.id = ANY(:ids)"
                ),
                {"ids": project_ids},
            )
        ).all()
        return {
            r.id: kinds_for(
                "project",
                has_builder=bool(r.has_dashboard),
                has_workflows=bool(r.has_workflow),
                has_layouts=bool(r.has_layout),
            )
            for r in rows
        }

    async def set_restricted(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        resource_type: ResourceType,
        resource_id: UUID,
        restricted: bool,
    ) -> None:
        """Mark a folder or item Restricted, or lift it (D9).

        Space owner/admin only — the same rank a delete or a share needs, so
        a plain member cannot close content off from the rest of the space.
        A trashed row is not found: restoring it comes first, and a space's
        `home` root is refused — it is folded into the space listing, so it
        has no row of its own to toggle the badge back off.
        """
        # `authz.require` rejects any resource_type outside its own
        # allow-list before the table name below is formatted into SQL.
        await authz.require(db, resource_type, resource_id, user_id, "delete")
        if resource_type == "folder":
            folder = await db.get(Folder, resource_id)
            if folder is not None and folder.space_id is not None:
                # Compared by id, not by name: a folder a user created and
                # called "home" is an ordinary folder and may be restricted.
                root_id = await crud_space.ensure_root_folder(db, folder.space_id)
                if folder.id == root_id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="A space root cannot be restricted",
                    )
        updated = (
            await db.execute(
                text(
                    f"UPDATE {settings.SCHEMA}.{resource_type} "
                    "SET restricted = :restricted, updated_at = now() "
                    "WHERE id = :id AND deleted_at IS NULL "
                    "RETURNING id"
                ),
                {"restricted": restricted, "id": resource_id},
            )
        ).first()
        if updated is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"{resource_type.capitalize()} not found",
            )
        await db.commit()


content = CRUDContent()
