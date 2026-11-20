# Standard library imports
import logging
from typing import Any, List
from uuid import UUID

# Third party imports
from fastapi import HTTPException
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from geoalchemy2.elements import WKTElement
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

# Local application imports
from core.core.content import (
    build_shared_with_object,
    create_query_shared_content,
    fetch_grants_by_resource,
    grant_conditions,
    granted_ids,
)
from core.core.layer_address import addresses_for
from core.crud.base import CRUDBase
from core.db.models._link_model import (
    BundleLayerLink,
    ResourceGrant,
)
from core.db.models.folder import Folder
from core.db.models.layer import Layer, LayerType
from core.db.models.role import Role
from core.schemas.error import (
    LayerNotFoundError,
)
from core.schemas.layer import (
    ILayerGet,
    get_layer_schema,
    layer_update_class,
)

logger = logging.getLogger(__name__)


class CRUDLayer(CRUDBase):
    """CRUD class for Layer."""

    async def update(
        self,
        async_session: AsyncSession,
        id: UUID,
        layer_in: dict,
    ) -> Layer:
        # Get layer
        layer = await self.get(async_session, id=id)
        if layer is None:
            raise LayerNotFoundError(f"{Layer.__name__} not found")

        # The folder-move guard (same space + write access) runs at the
        # endpoint (core/endpoints/v2/layer.py: update_layer) — it needs the
        # caller's identity for the write check, which this method does not
        # receive, and it must run outside `HTTPErrorHandler` so a 403/404
        # from `authz.require` is not rewrapped into a 500.

        # Get the right Layer model for update
        schema = get_layer_schema(
            class_mapping=layer_update_class,
            layer_type=layer.type,
            feature_layer_type=layer.feature_layer_type,
        )

        # Populate layer schema
        layer_in = schema(**layer_in)

        layer = await CRUDBase(Layer).update(
            async_session, db_obj=layer, obj_in=layer_in
        )

        return layer

    async def get_base_filter(
        self,
        user_id: UUID,
        params: ILayerGet,
        team_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> List[Any]:
        """Get filter for get layer queries."""
        filters: List[Any] = [Layer.deleted_at.is_(None)]
        for key, value in params.dict().items():
            if (
                key
                not in (
                    "search",
                    "spatial_search",
                    "public_read",
                )
                and value is not None
            ):
                # Convert value to list if not list
                if not isinstance(value, list):
                    value = [value]
                filters.append(getattr(Layer, key).in_(value))

        if params.public_read is not None:
            if not team_id and not organization_id:
                filters.append(
                    and_(
                        Layer.public_read == bool(params.public_read),
                        Layer.user_id == user_id,
                    )
                )
            else:
                filters.append(Layer.public_read == bool(params.public_read))
        elif not team_id and not organization_id:
            filters.append(Layer.user_id == user_id)
            # My Content is folder-scoped navigation: a layer sitting in
            # a folder the user does not own is unreachable there.
            filters.append(
                or_(
                    Layer.folder_id.is_(None),
                    Layer.folder_id.in_(
                        select(Folder.id).where(Folder.user_id == user_id)
                    ),
                )
            )

        # Layers that belong to a bundle are surfaced via the bundle,
        # not as standalone datasets — exclude them from content listings.
        filters.append(Layer.id.notin_(select(BundleLayerLink.layer_id)))

        # Add search filter
        if params.search is not None:
            filters.append(
                or_(
                    func.lower(Layer.name).contains(params.search.lower()),
                    func.lower(Layer.description).contains(params.search.lower()),
                )
            )
        if params.spatial_search is not None:
            filters.append(
                Layer.extent.ST_Intersects(
                    WKTElement(params.spatial_search, srid=4326)
                ),
            )
        return filters

    async def get_layers_with_filter(
        self,
        async_session: AsyncSession,
        user_id: UUID,
        order_by: str,
        order: str,
        page_params: PaginationParams,
        params: ILayerGet,
        team_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> Page[BaseModel]:
        """Get layer with filter."""

        # Additional server side validation for feature_layer_type
        if params is None:
            params = ILayerGet()
        if (
            params.type is not None
            and params.feature_layer_type is not None
            and LayerType.feature not in params.type
        ):
            raise HTTPException(
                status_code=400,
                detail="Feature layer type can only be set when layer type is feature",
            )
        # Get base filter
        filters = await self.get_base_filter(
            user_id=user_id,
            params=params,
            team_id=team_id,
            organization_id=organization_id,
        )

        # When a folder_id is set in a team/org context, check if folder is shared
        # via ResourceGrant. If so, bypass the direct-grant filter below — layers in
        # folder-shared folders have no such grant of their own.
        use_folder_grant_query = False
        folder_id = getattr(params, "folder_id", None)
        grantee_conditions = grant_conditions(None, team_id, organization_id)

        if folder_id and grantee_conditions:
            grant_result = await async_session.execute(
                select(ResourceGrant.id)
                .where(
                    ResourceGrant.resource_type == "folder",
                    ResourceGrant.resource_id == folder_id,
                    or_(*grantee_conditions),
                )
                .limit(1)
            )
            use_folder_grant_query = grant_result.first() is not None
        elif not folder_id and grantee_conditions:
            # At team/org root: show only layers explicitly shared via a direct
            # grant. Layers that live inside a folder shared with the team/org are
            # NOT shown here — they surface only when the user navigates into that
            # shared folder.
            # Sub-select: folders granted to this team/org — layers in these are excluded
            # from the direct-grant list so they don't bleed through here.
            folder_granted_ids = select(ResourceGrant.resource_id).where(
                ResourceGrant.resource_type == "folder",
                or_(*grantee_conditions),
            )

            # NULL-safe: folder_id IS NULL means no folder, always include such layers.
            # Without this, NULL NOT IN (...) evaluates to UNKNOWN (= excluded).
            def not_in_granted(col: Any) -> Any:
                return or_(col.is_(None), col.notin_(folder_granted_ids))

            filters.append(
                and_(
                    Layer.id.in_(granted_ids("layer", None, team_id, organization_id)),
                    not_in_granted(Layer.folder_id),
                )
            )
            use_folder_grant_query = True

        # Get roles
        roles = await CRUDBase(Role).get_all(
            async_session,
        )
        role_mapping = {role.id: role.name for role in roles}

        # Bypass the INNER JOIN when the result set is already constrained by an
        # ID-based filter (folder grant or root-level accessible-layer OR).
        bypass_join = use_folder_grant_query

        # Build query
        query = create_query_shared_content(
            Layer,
            filters,
            team_id=None if bypass_join else team_id,
            organization_id=None if bypass_join else organization_id,
        )

        # Build params and filter out None values
        builder_params = {
            k: v
            for k, v in {
                "order_by": order_by,
                "order": order,
            }.items()
            if v is not None
        }

        layers = await self.get_multi(
            async_session,
            query=query,
            page_params=page_params,
            **builder_params,
        )
        assert isinstance(layers, Page)
        effective_team_id = None if bypass_join else team_id
        effective_org_id = None if bypass_join else organization_id
        grants_by_resource = None
        if not effective_team_id and not effective_org_id:
            grants_by_resource = await fetch_grants_by_resource(
                async_session, "layer", [row[0].id for row in layers.items]
            )
        layers_arr = build_shared_with_object(
            items=layers.items,
            role_mapping=role_mapping,
            model_name="layer",
            team_id=effective_team_id,
            organization_id=effective_org_id,
            grants_by_resource=grants_by_resource,
        )
        # A team's or organization's listing shows layers its members may
        # only view: a remote raster file's address comes without its query
        # string to whoever cannot edit the layer.
        addresses = await addresses_for(
            async_session, user_id, [row[0] for row in layers.items]
        )
        for item in layers_arr:
            if item["id"] in addresses:
                item["url"] = addresses[item["id"]]
        layers.items = layers_arr
        return layers


layer = CRUDLayer(Layer)
