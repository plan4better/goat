# Standard library imports
from typing import Any
from uuid import UUID

# Third party imports
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from fastapi_pagination.ext.sqlalchemy import paginate
from pydantic import BaseModel
from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

# Local application imports
from core.core.content import (
    build_shared_with_object,
    create_query_shared_content,
    fetch_grants_by_resource,
    grant_conditions,
    granted_ids,
)
from core.crud.base import CRUDBase
from core.crud.crud_bundle import member_thumbnails
from core.crud.crud_layer import layer as crud_layer
from core.db.models._link_model import ResourceGrant
from core.db.models.bundle import Bundle
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.role import Role
from core.db.models.user import User
from core.schemas.bundle import DatasetContentTile
from core.schemas.layer import ILayerGet


class CRUDDatasets:
    """Listing across the two dataset content types — layers and dataset
    bundles — unified into a single paginated, sorted ``DatasetContentTile``
    result.

    Layer filtering/hydration is delegated to ``CRUDLayer`` (``get_base_filter``
    and the shared-content query helpers); this class owns the union, pagination,
    the bundle side, and the tile projection.
    """

    # Filters only a layer can satisfy — when any is set, bundles are
    # excluded from the mixed listing (a bundle is not a feature layer, has no
    # geometry, etc.), so the result stays consistent with the filter.
    _BUNDLE_INCOMPATIBLE_FILTERS = (
        "type",
        "feature_layer_type",
        "spatial_search",
        "in_catalog",
    )

    @staticmethod
    def _grant_match(team_id: UUID | None, organization_id: UUID | None) -> list[Any]:
        """ResourceGrant grantee conditions for the active team/org."""
        return grant_conditions(None, team_id, organization_id)

    def _layer_access_filters(
        self,
        folder_id: UUID | None,
        team_id: UUID | None,
        organization_id: UUID | None,
        granted_folder_ids: Any,
        folder_granted: bool,
    ) -> list[Any]:
        """Layer access conditions (WHERE) in a team/org context — mirrors
        ``get_layers_with_filter``. Empty in personal context, where
        ``get_base_filter`` already scopes to the owner."""
        if not team_id and not organization_id:
            return []
        direct_link = Layer.id.in_(granted_ids("layer", None, team_id, organization_id))
        if folder_id is not None:
            # Granted folder → all its layers (folder_id already filtered by
            # get_base_filter); otherwise only directly-linked layers in it.
            return [] if folder_granted else [direct_link]
        # Root: directly-linked layers, excluding those inside a granted folder
        # (those surface only when navigating into that folder).
        return [
            and_(
                direct_link,
                or_(
                    Layer.folder_id.is_(None),
                    Layer.folder_id.notin_(granted_folder_ids),
                ),
            )
        ]

    def _bundle_access_filters(
        self,
        user_id: UUID,
        folder_id: UUID | None,
        team_id: UUID | None,
        organization_id: UUID | None,
        granted_folder_ids: Any,
        folder_granted: bool,
    ) -> list[Any]:
        """Dataset-bundle access conditions (WHERE). Personal: owned + folder
        scope. Team/org: bundles shared directly via a grant OR living in a
        folder shared with the team/org — so bundles inherit folder grants the
        same way layers do, keeping the folder hierarchy intact."""
        if not team_id and not organization_id:
            filters: list[Any] = [
                Bundle.user_id == user_id,
                Bundle.deleted_at.is_(None),
            ]
            if folder_id is not None:
                filters.append(Bundle.folder_id == folder_id)
            else:
                filters.append(
                    or_(
                        Bundle.folder_id.is_(None),
                        Bundle.folder_id.in_(
                            select(Folder.id).where(Folder.user_id == user_id)
                        ),
                    )
                )
            return filters
        grant_conds = self._grant_match(team_id, organization_id)
        granted_bundle_ids = select(ResourceGrant.resource_id).where(
            ResourceGrant.resource_type == "bundle", or_(*grant_conds)
        )
        direct_bundle = Bundle.id.in_(granted_bundle_ids)
        if folder_id is not None:
            # Granted folder → every bundle in it; otherwise only directly-
            # granted bundles in the folder.
            return (
                [Bundle.folder_id == folder_id, Bundle.deleted_at.is_(None)]
                if folder_granted
                else [
                    Bundle.folder_id == folder_id,
                    direct_bundle,
                    Bundle.deleted_at.is_(None),
                ]
            )
        # Root: directly-granted bundles not inside a granted folder (those
        # surface when navigating into that folder, mirroring layers).
        return [
            and_(
                direct_bundle,
                or_(
                    Bundle.folder_id.is_(None),
                    Bundle.folder_id.notin_(granted_folder_ids),
                ),
            ),
            Bundle.deleted_at.is_(None),
        ]

    async def list_content(
        self,
        async_session: AsyncSession,
        user_id: UUID,
        order_by: str,
        order: str,
        page_params: PaginationParams,
        params: ILayerGet | None,
        team_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> Page[BaseModel]:
        """List layers and bundles together as one paginated, sorted
        result.

        A ``UNION ALL`` of lightweight ``(id, kind, name, created_at,
        updated_at)`` rows from both sources is ordered and paginated by the
        database, then each page item is hydrated to its full tile shape — so
        bundles are integrated by the sort key rather than bolted on. Works in
        personal, folder, and team/organization contexts (access is expressed
        entirely as WHERE conditions for both sources).
        """
        if params is None:
            params = ILayerGet()
        folder_id = getattr(params, "folder_id", None)

        # Team/org shared-access context, computed once and shared by the layer
        # and bundle access filters (folders granted to the caller's team/org,
        # and whether the folder being browsed is one of them).
        grant_conds = (
            self._grant_match(team_id, organization_id)
            if (team_id or organization_id)
            else []
        )
        granted_folder_ids = (
            select(ResourceGrant.resource_id).where(
                ResourceGrant.resource_type == "folder", or_(*grant_conds)
            )
            if grant_conds
            else None
        )
        folder_granted = False
        if folder_id is not None and grant_conds:
            folder_granted = (
                await async_session.execute(
                    select(ResourceGrant.id)
                    .where(
                        ResourceGrant.resource_type == "folder",
                        ResourceGrant.resource_id == folder_id,
                        or_(*grant_conds),
                    )
                    .limit(1)
                )
            ).first() is not None

        # Layer access filters (WHERE-based). get_base_filter covers "My Content";
        # in a team/org context it only adds non-access filters, so add the
        # shared-access conditions here (mirrors get_layers_with_filter).
        layer_filters = await crud_layer.get_base_filter(
            user_id=user_id,
            params=params,
            team_id=team_id,
            organization_id=organization_id,
        )
        layer_filters += self._layer_access_filters(
            folder_id=folder_id,
            team_id=team_id,
            organization_id=organization_id,
            granted_folder_ids=granted_folder_ids,
            folder_granted=folder_granted,
        )
        layer_rows = select(
            Layer.id.label("id"),
            literal("layer").label("kind"),
            Layer.name.label("name"),
            Layer.created_at.label("created_at"),
            Layer.updated_at.label("updated_at"),
        ).where(and_(*layer_filters))

        include_bundles = not any(
            getattr(params, f, None) is not None
            for f in self._BUNDLE_INCOMPATIBLE_FILTERS
        )
        if include_bundles:
            bundle_filters = self._bundle_access_filters(
                user_id=user_id,
                folder_id=folder_id,
                team_id=team_id,
                organization_id=organization_id,
                granted_folder_ids=granted_folder_ids,
                folder_granted=folder_granted,
            )
            if params.search is not None:
                bundle_filters.append(
                    func.lower(Bundle.name).contains(params.search.lower())
                )
            bundle_rows = select(
                Bundle.id.label("id"),
                literal("bundle").label("kind"),
                Bundle.name.label("name"),
                Bundle.created_at.label("created_at"),
                Bundle.updated_at.label("updated_at"),
            ).where(and_(*bundle_filters))
            union_sq = layer_rows.union_all(bundle_rows).subquery()
        else:
            union_sq = layer_rows.subquery()

        sort_key = (
            order_by
            if order_by in ("name", "created_at", "updated_at")
            else "updated_at"
        )
        sort_col = union_sq.c[sort_key]
        # ``order`` may arrive as an OrderEnum; compare on its value.
        is_ascending = str(getattr(order, "value", order)) == "ascendent"
        # Tiebreakers make the page boundary deterministic: a bundle import
        # gives its members one updated_at to the microsecond, and an unstable
        # sort across two LIMIT/OFFSET executions shows an item twice and skips
        # another.
        ordered = select(union_sq).order_by(
            sort_col.asc() if is_ascending else sort_col.desc(),
            union_sq.c.kind,
            union_sq.c.id,
        )

        page = await paginate(async_session, ordered, page_params)
        assert isinstance(page, Page)
        rows = page.items
        layer_ids = [r.id for r in rows if r.kind == "layer"]
        bundle_ids = [r.id for r in rows if r.kind == "bundle"]

        def enum_value(value: Any) -> Any:
            return getattr(value, "value", value)

        def scope_shared_with(shared_with: Any) -> Any:
            """In a team/org view, keep only the active grantee so the tile's
            role chip resolves to the current team/org (layers are hydrated with
            all their links)."""
            if not shared_with or (not team_id and not organization_id):
                return shared_with
            if team_id:
                return {
                    "teams": [
                        t
                        for t in shared_with.get("teams", [])
                        if str(t.get("id")) == str(team_id)
                    ],
                    "organizations": [],
                    "users": [],
                }
            return {
                "teams": [],
                "organizations": [
                    o
                    for o in shared_with.get("organizations", [])
                    if str(o.get("id")) == str(organization_id)
                ],
                "users": [],
            }

        # Hydrate layers as content tiles (reusing the standard owned_by/
        # shared_with machinery), so a layer and a bundle share one shape.
        tile_by_id: dict[str, DatasetContentTile] = {}
        if layer_ids:
            roles = await CRUDBase(Role).get_all(async_session)
            role_mapping = {role.id: role.name for role in roles}
            query = create_query_shared_content(
                Layer,
                [Layer.id.in_(layer_ids)],
            )
            result = await async_session.execute(query)
            grants_by_resource = await fetch_grants_by_resource(
                async_session, "layer", layer_ids
            )
            for d in build_shared_with_object(
                items=result.all(),
                role_mapping=role_mapping,
                model_name="layer",
                grants_by_resource=grants_by_resource,
            ):
                tile_by_id[str(d["id"])] = DatasetContentTile(
                    content_type="layer",
                    id=d["id"],
                    name=d.get("name"),
                    folder_id=d.get("folder_id"),
                    type=enum_value(d.get("type")),
                    feature_layer_geometry_type=enum_value(
                        d.get("feature_layer_geometry_type")
                    ),
                    data_type=enum_value(d.get("data_type")),
                    thumbnail_url=d.get("thumbnail_url"),
                    owned_by=d.get("owned_by"),
                    shared_with=scope_shared_with(d.get("shared_with")),
                    tags=d.get("tags"),
                    created_at=d.get("created_at"),
                    updated_at=d.get("updated_at"),
                )

        # Hydrate bundles into the same content-tile shape.
        if bundle_ids:
            prows = (
                await async_session.execute(
                    select(
                        Bundle,
                        User.id,
                        User.firstname,
                        User.lastname,
                        User.avatar,
                    )
                    .join(User, User.id == Bundle.user_id)
                    .where(Bundle.id.in_(bundle_ids))
                )
            ).all()
            # A bundle's own thumbnail is only ever the generic placeholder, so
            # the tile borrows one member's — the same one the bundle's page
            # shows.
            bundle_thumbnails = await member_thumbnails(
                async_session, [bundle.id for bundle, *_ in prows]
            )
            for bundle, uid, firstname, lastname, avatar in prows:
                bundle_type = enum_value(bundle.bundle_type)
                tile_by_id[str(bundle.id)] = DatasetContentTile(
                    content_type="bundle",
                    id=bundle.id,
                    name=bundle.name,
                    folder_id=bundle.folder_id,
                    type=bundle_type,
                    bundle_type=bundle_type,
                    status=enum_value(bundle.status),
                    description=bundle.description,
                    thumbnail_url=bundle_thumbnails.get(bundle.id)
                    or bundle.thumbnail_url,
                    owned_by={
                        "id": uid,
                        "firstname": firstname,
                        "lastname": lastname,
                        "avatar": avatar,
                    },
                    created_at=bundle.created_at,
                    updated_at=bundle.updated_at,
                )

        # Reassemble in the DB's paginated order.
        page.items = [tile_by_id[str(r.id)] for r in rows if str(r.id) in tile_by_id]
        return page


datasets = CRUDDatasets()
