"""
Report Layout CRUD Operations
"""

from typing import Any, List, Mapping
from uuid import UUID

from sqlalchemy import Table, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from core.core import revision
from core.db.models.report_layout import ReportLayout
from core.schemas.report_layout import ReportLayoutCreate, ReportLayoutUpdate

from .base import CRUDBase


def _significant(layout: Mapping[str, Any]) -> Any:
    return (
        layout["name"],
        layout["description"],
        layout["is_default"],
        revision.significant_report_layout_config(layout["config"]),
    )


class CRUDReportLayout(CRUDBase[ReportLayout, ReportLayoutCreate, ReportLayoutUpdate]):
    """CRUD operations for ReportLayout model."""

    async def get_by_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
    ) -> List[ReportLayout]:
        """Get all report layouts for a project."""
        statement = select(self.model).where(self.model.project_id == project_id)
        result = await async_session.execute(statement)
        return list(result.scalars().all())

    async def get_by_project_and_id(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        layout_id: UUID,
    ) -> ReportLayout | None:
        """Get a specific report layout by project and layout ID."""
        statement = select(self.model).where(
            self.model.project_id == project_id,
            self.model.id == layout_id,
        )
        result = await async_session.execute(statement)
        return result.scalars().first()

    async def create_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        obj_in: ReportLayoutCreate,
        user_id: UUID | None = None,
    ) -> ReportLayout:
        """Create a new report layout for a project."""
        # If this is set as default, unset any existing default
        if obj_in.is_default:
            await self._unset_default_for_project(async_session, project_id=project_id)

        db_obj = ReportLayout(
            project_id=project_id,
            updated_by=user_id,
            **obj_in.model_dump(),
        )
        async_session.add(db_obj)
        await async_session.commit()
        await async_session.refresh(db_obj)
        return db_obj

    async def update_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        layout_id: UUID,
        obj_in: ReportLayoutUpdate,
        user_id: UUID,
    ) -> ReportLayout | None:
        """Update a report layout, checked against `obj_in.base_revision`
        (`core.core.revision`). Raises ChangedElsewhereError."""
        update_data = obj_in.model_dump(exclude_unset=True, exclude={"base_revision"})
        table: Table = getattr(self.model, "__table__")
        row = await revision.save(
            async_session,
            table=table,
            where=[table.c.id == layout_id, table.c.project_id == project_id],
            values=update_data,
            significant=_significant,
            revision="revision",
            user_id=user_id,
            base_revision=obj_in.base_revision,
            document=f"Report layout {layout_id}",
        )
        if row is None:
            return None

        # Only after the save landed, so a refused one changes nothing.
        if update_data.get("is_default"):
            await self._unset_default_for_project(
                async_session, project_id=project_id, exclude_id=layout_id
            )
            await async_session.commit()
        return self.model(**row)

    async def delete_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        layout_id: UUID,
    ) -> bool:
        """Delete a report layout."""
        db_obj = await self.get_by_project_and_id(
            async_session, project_id=project_id, layout_id=layout_id
        )
        if not db_obj:
            return False

        # Don't allow deletion of predefined layouts
        if db_obj.is_predefined:
            return False

        await async_session.delete(db_obj)
        await async_session.commit()
        return True

    async def duplicate(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        layout_id: UUID,
        new_name: str | None = None,
    ) -> ReportLayout | None:
        """Duplicate a report layout."""
        db_obj = await self.get_by_project_and_id(
            async_session, project_id=project_id, layout_id=layout_id
        )
        if not db_obj:
            return None

        new_layout = ReportLayout(
            project_id=project_id,
            name=new_name or f"{db_obj.name} (Copy)",
            description=db_obj.description,
            is_default=False,  # Duplicates are never default
            is_predefined=False,  # Duplicates are never predefined
            config=db_obj.config,
            thumbnail_url=None,  # Reset thumbnail
        )
        async_session.add(new_layout)
        await async_session.commit()
        await async_session.refresh(new_layout)
        return new_layout

    async def _unset_default_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        exclude_id: UUID | None = None,
    ) -> None:
        """Unset the default flag for all layouts in a project.

        Losing the flag is no change of the layout: its revision and the time
        of its last change stay.
        """
        statement = (
            update(self.model)
            .where(self.model.project_id == project_id)
            .where(self.model.is_default == True)  # noqa: E712
            .values(is_default=False, updated_at=self.model.updated_at)
        )
        if exclude_id:
            statement = statement.where(self.model.id != exclude_id)
        await async_session.execute(statement)


report_layout = CRUDReportLayout(ReportLayout)
