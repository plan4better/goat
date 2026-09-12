# Standard library imports
from typing import Any, List, Tuple, Union
from uuid import UUID

# Third party imports
from fastapi import HTTPException, status
from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import func, select, text
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup, LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.schemas.project import (
    IFeatureStandardProjectRead,
    IFeatureStreetNetworkProjectRead,
    IFeatureToolProjectRead,
    IRasterProjectRead,
    ITableProjectRead,
    layer_type_mapping_read,
    layer_type_mapping_update,
)

# Local application imports
from .base import CRUDBase


async def make_room_at_top(
    async_session: AsyncSession, project_id: UUID, count: int
) -> None:
    """Push everything already in a project down by ``count`` positions.

    Groups and layers share one tree-wide order sequence, so both have to move
    or the new rows land in among the old ones instead of above them.
    """
    if count <= 0:
        return
    for model in (LayerProjectLink, LayerProjectGroup):
        await async_session.execute(
            sql_update(model)
            .where(model.project_id == project_id)
            .values(order=model.order + count)
        )
    await async_session.commit()


def initial_link_properties(
    existing_link: Any | None, layer: Any
) -> dict[str, Any] | None:
    """What a new project-layer link starts out looking like.

    When the layer is already in this project the style comes off the link
    already there, so a duplicate matches what the user made rather than
    snapping back to the dataset's default.

    `visibility` rides in that same blob and is deliberately NOT copied: it is
    view state, not style. Adding a dataset you had hidden would otherwise give
    you a second copy you also cannot see, which reads as the add having failed
    — and the one thing you certainly meant by adding a layer is to look at it.
    """
    if existing_link is None:
        return layer.properties
    properties = existing_link.properties
    if not isinstance(properties, dict):
        return properties
    # Copied, not mutated: the link already in the project keeps its own state.
    return {**properties, "visibility": True}


#: Everything a LOCKED project-layer row may disclose (D7): enough to draw a
#: placeholder in the layer tree, and nothing else. `type` and
#: `feature_layer_type` are in because the read models require them (and the
#: model class is already chosen by them); `locked`, `properties`, `created_at`
#: and `updated_at` are set explicitly next to the filter. Everything the layer
#: or the link otherwise carries — thumbnail_url, extent, description, size,
#: tags, url, data_type, user_id, folder_id, attribute_mapping, query, charts,
#: other_properties, … — is dropped.
LOCKED_ROW_KEYS = frozenset(
    {
        "id",
        "layer_id",
        "name",
        "type",
        "feature_layer_type",
        "feature_layer_geometry_type",
        "order",
        "layer_project_group_id",
    }
)


class CRUDLayerProject(CRUDBase):
    async def shareable_by_layer_id(
        self,
        async_session: AsyncSession,
        layer_ids: List[UUID],
        user_id: UUID,
    ) -> dict[UUID, bool]:
        """Whether each layer may travel with a project this user adds it to (D7).

        A catalog layer always may — it is readable by everyone regardless. Any
        other layer only if the adder himself holds `share` on it, so adding a
        dataset he may only view cannot hand the project's other members access
        to it. One round trip for the whole batch.
        """
        if not layer_ids:
            return {}
        result = await async_session.execute(
            text(
                "SELECT l AS layer_id, "
                f"{settings.SCHEMA}.layer_is_catalog(l) "
                f"OR {settings.SCHEMA}.can('layer', l, :u, 'share') AS shareable "
                "FROM unnest(CAST(:ids AS uuid[])) AS l"
            ),
            {"ids": [str(layer_id) for layer_id in layer_ids], "u": str(user_id)},
        )
        return {row.layer_id: bool(row.shareable) for row in result}

    async def locked_by_layer_id(
        self,
        async_session: AsyncSession,
        user_id: UUID,
        *,
        project_id: UUID | None = None,
        link_ids: List[int] | None = None,
    ) -> dict[UUID, bool]:
        """Which layers of a project (or of a set of links) this user has no
        access to of his own.

        Only a NON-SHAREABLE link can be locked, and that is what the query
        filters on: a shareable link grants read through rule 6 to anyone who
        reaches the project at all, and reaching the project is the precondition
        for calling this (the routes run `auth_z` on the project first). So a
        key missing from the result means "not locked", and the project-open
        path evaluates `effective_role` only for the few links that could be.
        One round trip either way.
        """
        clause = (
            "lp.project_id = :p"
            if project_id is not None
            else "lp.id = ANY(CAST(:ids AS int[]))"
        )
        result = await async_session.execute(
            text(
                "SELECT lp.layer_id, "
                f"{settings.SCHEMA}.effective_role('layer', lp.layer_id, :u) IS NULL AS locked "
                f"FROM {settings.SCHEMA}.layer_project lp "
                f"WHERE {clause} AND NOT lp.shareable"
            ),
            {
                "p": str(project_id) if project_id is not None else None,
                "ids": list(link_ids or []),
                "u": str(user_id),
            },
        )
        return {row.layer_id: bool(row.locked) for row in result}

    async def layer_projects_to_schemas(
        self,
        async_session: AsyncSession,
        layers_project: List[Tuple[Layer, LayerProjectLink]],
        locked_by_layer_id: dict[UUID, bool] | None = None,
    ) -> List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ]:
        """Convert layer projects to schemas.

        ``locked_by_layer_id`` marks the rows the caller has no access to of his
        own; such a row is rebuilt from ``LOCKED_ROW_KEYS`` alone, so it carries
        only what the layer tree needs to show that something is there.
        """
        layer_projects_schemas = []

        # Loop through layer and layer projects
        for layer_project_tuple in layers_project:
            layer = layer_project_tuple[0]
            layer_project_model = layer_project_tuple[1]

            # Get layer type
            if layer.feature_layer_type is not None:
                layer_type = layer.type + "_" + layer.feature_layer_type
            else:
                layer_type = layer.type

            layer_dict = layer.model_dump()
            # Delete id from layer
            del layer_dict["id"]
            # Update layer with layer project
            layer_dict.update(layer_project_model.model_dump())
            # Kept apart from the tile-busting value below: this one answers
            # "how current is the data", which restyling must not change.
            layer_dict["dataset_updated_at"] = layer.updated_at
            # The link's fields win above, including updated_at — but the map
            # keys its tile source on that value, and materialize finishing
            # bumps only the LAYER's. Take the later of the two so either
            # side changing refetches the tiles.
            if layer.updated_at and layer_dict.get("updated_at"):
                layer_dict["updated_at"] = max(
                    layer.updated_at, layer_dict["updated_at"]
                )
            # The link froze a copy of other_properties at add time (that is
            # what makes style per-project), but a catalog layer's materialize
            # lifecycle is layer-global and moves on afterwards — serve those
            # keys live from the layer or pending would never clear.
            if layer.catalog_external_uid is not None and layer.other_properties:
                merged = dict(layer_dict.get("other_properties") or {})
                for key in ("catalog_item", "catalog_materialize"):
                    if key in layer.other_properties:
                        merged[key] = layer.other_properties[key]
                layer_dict["other_properties"] = merged
            if locked_by_layer_id and locked_by_layer_id.get(layer.id):
                # A locked row is rebuilt from LOCKED_ROW_KEYS only, so a field
                # added to the layer or the link later cannot leak through it.
                # `properties` and the timestamps are set explicitly because the
                # read models would otherwise fill them from their own defaults
                # (`updated_at` would report "now").
                layer_dict = {
                    key: value
                    for key, value in layer_dict.items()
                    if key in LOCKED_ROW_KEYS
                }
                layer_dict["locked"] = True
                layer_dict["properties"] = {}
                layer_dict["updated_at"] = None
                layer_dict["created_at"] = None
            layer_project: Union[
                IFeatureStandardProjectRead
                | IFeatureToolProjectRead
                | IFeatureStreetNetworkProjectRead
                | ITableProjectRead
                | IRasterProjectRead
            ] = layer_type_mapping_read[layer_type](**layer_dict)

            # Write into correct schema
            # Note: total_count and filtered_count are fetched on-demand via geoapi
            layer_projects_schemas.append(layer_project)

        return layer_projects_schemas

    async def get_layers(
        self,
        async_session: AsyncSession,
        project_id: UUID,
        *,
        user_id: UUID | None = None,
        only_shareable: bool = False,
    ) -> List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ]:
        """Get all layers from a project, sorted by layer_order.

        Layers are returned in the order defined by the project's layer_order
        array. Layers at the beginning of layer_order appear first (on top in UI).

        With ``user_id`` given, a layer that user has no access to of his own is
        marked ``locked`` and reduced to ``LOCKED_ROW_KEYS`` (D7).

        ``only_shareable`` leaves non-shareable links out altogether. The public
        snapshot uses it: publishing is the widest audience there is, and whoever
        added such a layer could not share it with one person, let alone
        everyone.
        """
        # Get project to retrieve layer_order
        project = await CRUDBase(Project).get(async_session, id=project_id)
        layer_order = project.layer_order or []

        # Get all layers from project. Excludes a layer soft-deleted on its
        # own — the project's layer list must not keep listing it.
        query = select(Layer, LayerProjectLink).where(
            LayerProjectLink.project_id == project_id,
            Layer.id == LayerProjectLink.layer_id,
            Layer.deleted_at.is_(None),
        )
        if only_shareable:
            query = query.where(LayerProjectLink.shareable.is_(True))

        locked = (
            await self.locked_by_layer_id(async_session, user_id, project_id=project_id)
            if user_id is not None
            else None
        )

        # Get all layers from project
        layer_projects_to_schemas = await self.layer_projects_to_schemas(
            async_session,
            await self.get_multi(
                async_session,
                query=query,
            ),
            locked_by_layer_id=locked,
        )

        # Sort layers by layer_order array (first in array = first in result = on top)
        if layer_order:
            order_map = {
                layer_project_id: idx
                for idx, layer_project_id in enumerate(layer_order)
            }
            layer_projects_to_schemas.sort(
                key=lambda layer: order_map.get(layer.id, len(layer_order))
            )

        return layer_projects_to_schemas

    async def get_in_project(
        self,
        async_session: AsyncSession,
        *,
        id: int,
        project_id: UUID,
    ) -> LayerProjectLink | None:
        """One project-layer link, identified by BOTH ids.

        `layer_project` ids are a single global sequence, so a link id alone
        says nothing about which project it belongs to — and the routes are
        authorized against the project in their path. Every lookup that starts
        from a caller-supplied link id goes through here so a link of another
        project is simply not found.
        """
        result = await async_session.execute(
            select(LayerProjectLink).where(
                LayerProjectLink.id == id,
                LayerProjectLink.project_id == project_id,
            )
        )
        return result.scalars().first()

    async def get_by_ids(
        self,
        async_session: AsyncSession,
        ids: list[int],
        *,
        project_id: UUID,
        user_id: UUID | None = None,
    ) -> List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ]:
        """Get all layer projects links by the ids, within one project.

        ``project_id`` is required, not optional: the routes that reach here
        are authorized against the project in their path, so a link id naming
        another project's link must return nothing rather than that link.

        With ``user_id`` given, a layer that user has no access to of his own is
        marked ``locked`` and reduced to the fields in ``LOCKED_ROW_KEYS`` (D7).
        """

        # Get all layers from project by id. Excludes a layer soft-deleted
        # on its own.
        query = (
            select(Layer, LayerProjectLink)
            .where(
                LayerProjectLink.id.in_(ids),
            )
            .where(
                LayerProjectLink.project_id == project_id,
            )
            .where(
                Layer.id == LayerProjectLink.layer_id,
            )
            .where(Layer.deleted_at.is_(None))
        )

        locked = (
            await self.locked_by_layer_id(async_session, user_id, link_ids=list(ids))
            if user_id is not None
            else None
        )

        # Get all layers from project
        layer_projects = await self.layer_projects_to_schemas(
            async_session,
            await self.get_multi(
                async_session,
                query=query,
            ),
            locked_by_layer_id=locked,
        )
        return layer_projects

    async def count_by_project(
        self, async_session: AsyncSession, project_id: UUID
    ) -> int:
        """How many layers this project already holds."""
        result = await async_session.execute(
            select(func.count())
            .select_from(LayerProjectLink)
            .where(LayerProjectLink.project_id == project_id)
        )
        return int(result.scalar_one())

    async def create(
        self,
        async_session: AsyncSession,
        project_id: UUID,
        layer_ids: List[UUID],
        *,
        user_id: UUID,
        group_id: int | None = None,
        start_order: int | None = None,
    ) -> List[BaseModel]:
        """Create a link between a project and a layer.

        ``user_id`` is the user doing the adding. Each new link records whether
        it is ``shareable`` — whether that user held `share` on the layer, or the
        layer is a catalog layer everyone may read anyway (D7). A non-shareable
        link does not extend read or write access to the project's other members.

        When ``group_id`` is given, the new links are placed into that layer
        group (used when adding a bundle's member layers into its group).

        ``order`` is a position in the project's single tree-wide sequence — the
        layer panel writes it by flattening the whole tree. New links go to the
        top of that sequence, whatever they are: the project is pushed down to
        make room for them. ``start_order`` overrides this for a caller that has
        already made its own room and needs the links at a known position, which
        is how a bundle's members end up directly under their group header.
        """

        # Drop duplicates but keep the caller's order: it fixes the order the
        # links are created in, and so their order in the project.
        layer_ids = list(dict.fromkeys(layer_ids))

        # Get number of layers in project
        layer_projects = await self.get_multi(
            async_session,
            query=select(LayerProjectLink).where(
                LayerProjectLink.project_id == project_id
            ),
        )

        # Check if maximum number of layers in project is reached. In case layer_project is empty just go on.
        if layer_projects != []:
            if len(layer_projects) + len(layer_ids) >= 300:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Maximum number of layers in project reached",
                )

        layers = await CRUDBase(Layer).get_multi(
            async_session,
            query=select(Layer).where(Layer.id.in_(layer_ids)),
        )

        if len(layers) != len(layer_ids):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="One or several Layers were not found",
            )

        # Everything new goes on top, so the project moves down first. Skipped
        # ids leave a gap in the sequence, which the panel closes the next time
        # the tree is reordered.
        if start_order is None:
            await make_room_at_top(async_session, project_id, len(layer_ids))
            start_order = 0

        # Define array for layer project ids
        layer_project_ids = []

        # Iterate layer_ids rather than the query result: the SELECT ... IN
        # returns rows in whatever order the database chose.
        layers_by_id = {row[0].id: row[0] for row in layers}

        shareable_by_layer_id = await self.shareable_by_layer_id(
            async_session, layer_ids, user_id
        )

        # Create link between project and layer
        for position, layer_id in enumerate(layer_ids):
            # An id with no accessible layer row is skipped, not a 500: the
            # SELECT ... IN above simply won't have returned it.
            layer = layers_by_id.get(layer_id)
            if layer is None:
                continue

            # Check if layer with same name and ID already exists in project. Then the layer should be duplicated with a new name.
            layer_name = layer.name
            # Find existing project-layer link to copy style from (if duplicating within same project)
            existing_link = None
            if layer_projects != []:
                for lp in layer_projects:
                    if lp[0].layer_id == layer.id:
                        existing_link = lp[0]
                        break
                if layer.name in [
                    layer_project[0].name for layer_project in layer_projects
                ]:
                    layer_name = "Copy from " + layer.name

            properties = initial_link_properties(existing_link, layer)
            other_properties = (
                existing_link.other_properties
                if existing_link
                else layer.other_properties
            )

            # Create layer project link
            layer_project = LayerProjectLink(
                project_id=project_id,
                layer_id=layer.id,
                name=layer_name,
                properties=properties,
                other_properties=other_properties,
                layer_project_group_id=group_id,
                order=start_order + position,
                shareable=shareable_by_layer_id.get(layer.id, False),
            )

            # Add to database
            layer_project = await CRUDBase(LayerProjectLink).create(
                async_session,
                obj_in=layer_project.model_dump(),
            )
            layer_project_ids.append(layer_project.id)

        # Get project to update layer order
        project = await CRUDBase(Project).get(async_session, id=project_id)
        # Legacy sequence, kept in step with the order column: it only decides
        # the API response's order, which the layer panel re-sorts anyway.
        layer_order = layer_project_ids + list(project.layer_order or [])

        # Update project layer order
        project = await CRUDBase(Project).update(
            async_session,
            db_obj=project,
            obj_in={"layer_order": layer_order},
        )
        layers = await self.get_by_ids(
            async_session,
            ids=layer_project_ids,
            project_id=project_id,
            user_id=user_id,
        )
        return layers

    async def update(
        self,
        async_session: AsyncSession,
        id: int,
        layer_in: dict,
        *,
        project_id: UUID,
        user_id: UUID,
    ) -> (
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ):
        """Update a link between a project and a layer.

        ``project_id`` is the project the route was authorized against, and the
        link is looked up by both ids: a link id belonging to another project
        is not found, so project write cannot be spent on someone else's link.

        ``user_id`` is the caller. A link he has no access to of his own is
        LOCKED (D7): there is nothing about it for him to restyle, so the write
        is refused rather than answered with a row the read routes would have
        stripped to ``LOCKED_ROW_KEYS``. The response is built by
        ``get_by_ids`` for that same reason — one code path decides what a
        caller may see of a link.
        """

        # Get layer project
        layer_project_old = await self.get_in_project(
            async_session,
            id=id,
            project_id=project_id,
        )
        if layer_project_old is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Layer project not found"
            )
        layer_id = layer_project_old.layer_id

        locked = await self.locked_by_layer_id(async_session, user_id, link_ids=[id])
        if locked.get(layer_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No access to this layer",
            )

        # Get base layer object
        layer = await CRUDBase(Layer).get(async_session, id=layer_id)

        # Get right schema for respective layer type
        if layer.feature_layer_type is not None:
            model_type_update = layer_type_mapping_update.get(
                layer.type + "_" + layer.feature_layer_type
            )
        else:
            model_type_update = layer_type_mapping_update.get(layer.type)

        # Parse and validate the data against the model
        try:
            layer_in = TypeAdapter(model_type_update).validate_python(layer_in)
        except ValidationError as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(e),
            )

        # Update layer project
        await CRUDBase(LayerProjectLink).update(
            async_session,
            db_obj=layer_project_old,
            obj_in=layer_in,
        )
        # Read the row back through the same path the GET routes use, so the
        # response can never carry more of the layer than a read of it would.
        # Note: total_count and filtered_count are fetched on-demand via geoapi
        rows = await self.get_by_ids(
            async_session, ids=[id], project_id=project_id, user_id=user_id
        )
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Layer project not found"
            )
        return rows[0]


layer_project = CRUDLayerProject(LayerProjectLink)
