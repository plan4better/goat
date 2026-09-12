from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from goatlib.models.bundle import member_draw_rank
from sqlalchemy import delete as sql_delete
from sqlalchemy import select

from core.crud.base import CRUDBase
from core.db.models._link_model import (
    BundleLayerLink,
    LayerProjectGroup,
)
from core.db.models.bundle import Bundle
from core.db.models.layer import Layer
from core.db.session import AsyncSession
from core.schemas.project import ILayerProjectGroupCreate, ILayerProjectGroupUpdate


class CRUDLayerProjectGroup(CRUDBase):
    async def get(
        self, async_session: AsyncSession, id: UUID
    ) -> Optional[LayerProjectGroup]:
        return await async_session.get(LayerProjectGroup, id)

    async def get_groups_by_project(
        self, async_session: AsyncSession, project_id: UUID
    ) -> list[LayerProjectGroup]:
        """Get all layer groups for a project"""
        query = select(LayerProjectGroup).where(
            LayerProjectGroup.project_id == project_id
        )
        result = await async_session.execute(query)
        return result.scalars().all()

    async def create(
        self,
        async_session: AsyncSession,
        project_id: UUID,
        obj_in: ILayerProjectGroupCreate,
    ) -> LayerProjectGroup:
        # 1. Depth Validation
        if obj_in.parent_id:
            parent_group = await async_session.get(LayerProjectGroup, obj_in.parent_id)
            if not parent_group:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, detail="Parent group not found"
                )

            # Explain:
            # Level 1: parent_id is None
            # Level 2: parent_id is Level 1.
            # Level 3 (Forbidden): parent_id is Level 2.

            if parent_group.parent_id is not None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail="Maximum nesting level reached (Max 2 levels)",
                )

            if parent_group.project_id != project_id:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail="Parent group belongs to another project",
                )

        # 2. Creation
        db_obj = LayerProjectGroup(**obj_in.model_dump(), project_id=project_id)
        async_session.add(db_obj)
        await async_session.commit()
        await async_session.refresh(db_obj)
        return db_obj

    async def update(
        self,
        async_session: AsyncSession,
        db_obj: LayerProjectGroup,
        obj_in: ILayerProjectGroupUpdate,
    ) -> LayerProjectGroup:
        update_data = obj_in.model_dump(exclude_unset=True)

        # If moving to a new parent, run depth check logic again
        if "parent_id" in update_data and update_data["parent_id"] is not None:
            if update_data["parent_id"] == db_obj.id:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, detail="Cannot set parent to self"
                )

            parent_group = await async_session.get(
                LayerProjectGroup, update_data["parent_id"]
            )
            if parent_group.parent_id is not None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, detail="Maximum nesting level reached"
                )

        for key, value in update_data.items():
            setattr(db_obj, key, value)

        async_session.add(db_obj)
        await async_session.commit()
        await async_session.refresh(db_obj)
        return db_obj

    async def remove(self, async_session: AsyncSession, id: UUID) -> None:
        obj = await async_session.get(LayerProjectGroup, id)
        if obj:
            await async_session.delete(obj)
            await async_session.commit()

    async def add_bundle(
        self,
        async_session: AsyncSession,
        project_id: UUID,
        bundle_id: UUID,
        *,
        user_id: UUID,
    ) -> tuple[LayerProjectGroup, list]:
        """Add a bundle to a project: create a bundle-backed group and place all
        of the bundle's member layers into it. Membership is locked downstream.

        ``user_id`` is the user doing the adding; it decides whether each member
        link is shareable (D7), exactly as for a plain layer add.
        """
        # Reuse crud_layer_project for the member links (name/order handling).
        from core.crud.crud_layer_project import layer_project as crud_layer_project
        from core.crud.crud_layer_project import make_room_at_top

        # Already added?
        existing = await async_session.execute(
            select(LayerProjectGroup.id).where(
                LayerProjectGroup.project_id == project_id,
                LayerProjectGroup.bundle_id == bundle_id,
            )
        )
        if existing.first() is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="Bundle is already added to this project",
            )

        bundle = await async_session.get(Bundle, bundle_id)
        if bundle is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Bundle not found")
        # Legacy-data guard: `failed` is no longer in `BundleStatus` and an
        # import that fails now deletes its own bundle, so only rows written
        # before that can be in this state. Such a row died part-way through
        # its ingest, so whatever member links it has describe an incomplete
        # import and must not be put in front of a user.
        if bundle.status == "failed":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="Bundle import failed; it cannot be added to a project",
            )

        # Points before lines before polygons, so a node is not buried under
        # the edges it joins — the same stacking the import path uses, from the
        # same rule. Within one geometry, link id keeps the order the import
        # created them in (the spec's role order) rather than however the rows
        # come back.
        member_rows = (
            await async_session.execute(
                select(BundleLayerLink.layer_id, Layer.feature_layer_geometry_type)
                .join(Layer, Layer.id == BundleLayerLink.layer_id)
                .where(BundleLayerLink.bundle_id == bundle_id)
                .order_by(BundleLayerLink.id)
            )
        ).all()
        member_ids = [
            layer_id
            for layer_id, _ in sorted(
                member_rows,
                key=lambda row: member_draw_rank(row.feature_layer_geometry_type),
            )
        ]
        if not member_ids:
            # Having members is the actual requirement: the group's membership
            # is locked, so an empty one can never be filled from the project
            # side, and a bundle whose import is still running (its member
            # links are written when the import completes) would collide with
            # the import's own attach. `bundle.status` is not the question —
            # it reports the import alone, so a bundle assembled by hand stays
            # `processing` for ever, and usability is per artifact and derived
            # (see BundleStatus / BundleArtifactState).
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="Bundle has no member layers yet",
            )

        # A bundle goes to the top like anything else added to a project, so
        # the project moves down by the group plus every member that will sit
        # under it, and the group takes the first position.
        await make_room_at_top(async_session, project_id, 1 + len(member_ids))

        group = LayerProjectGroup(
            project_id=project_id,
            name=bundle.name,
            bundle_id=bundle_id,
            order=0,
        )
        async_session.add(group)
        await async_session.commit()
        await async_session.refresh(group)

        layers: list
        try:
            layers = await crud_layer_project.create(
                async_session,
                project_id=project_id,
                layer_ids=list(member_ids),
                user_id=user_id,
                group_id=group.id,
                # Directly below the group header, in role order. Room for
                # them was made above, so the links take it as given rather
                # than pushing the project down a second time.
                start_order=group.order + 1,
            )
        except Exception:
            # The group was already committed; if adding members fails, drop
            # it (cascades any partial links) so no empty bundle group lingers.
            await async_session.rollback()
            await async_session.execute(
                sql_delete(LayerProjectGroup).where(LayerProjectGroup.id == group.id)
            )
            await async_session.commit()
            raise
        return group, layers


layer_project_group = CRUDLayerProjectGroup(LayerProjectGroup)
