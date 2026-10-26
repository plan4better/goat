"""
Workflow CRUD Operations
"""

from typing import Any, List, Mapping
from uuid import UUID

from sqlalchemy import Table, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from core.core import revision
from core.db.models.workflow import Workflow
from core.schemas.workflow import WorkflowCreate, WorkflowUpdate

from .base import CRUDBase


def _significant(workflow: Mapping[str, Any]) -> Any:
    return (
        workflow["name"],
        workflow["description"],
        workflow["is_default"],
        revision.significant_workflow_config(workflow["config"]),
    )


class CRUDWorkflow(CRUDBase[Workflow, WorkflowCreate, WorkflowUpdate]):
    """CRUD operations for Workflow model."""

    async def get_by_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
    ) -> List[Workflow]:
        """Get all workflows for a project."""
        statement = select(self.model).where(self.model.project_id == project_id)
        result = await async_session.execute(statement)
        return list(result.scalars().all())

    async def get_by_project_and_id(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        workflow_id: UUID,
    ) -> Workflow | None:
        """Get a specific workflow by project and workflow ID."""
        statement = select(self.model).where(
            self.model.project_id == project_id,
            self.model.id == workflow_id,
        )
        result = await async_session.execute(statement)
        return result.scalars().first()

    async def create_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        obj_in: WorkflowCreate,
        user_id: UUID | None = None,
    ) -> Workflow:
        """Create a new workflow for a project."""
        # If this is set as default, unset any existing default
        if obj_in.is_default:
            await self._unset_default_for_project(async_session, project_id=project_id)

        db_obj = Workflow(
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
        workflow_id: UUID,
        obj_in: WorkflowUpdate,
        user_id: UUID,
    ) -> Workflow | None:
        """Update a workflow, checked against `obj_in.base_revision`
        (`core.core.revision`). Raises ChangedElsewhereError."""
        update_data = obj_in.model_dump(exclude_unset=True, exclude={"base_revision"})
        table: Table = getattr(self.model, "__table__")
        row = await revision.save(
            async_session,
            table=table,
            where=[table.c.id == workflow_id, table.c.project_id == project_id],
            values=update_data,
            significant=_significant,
            revision="revision",
            user_id=user_id,
            base_revision=obj_in.base_revision,
            document=f"Workflow {workflow_id}",
        )
        if row is None:
            return None

        # Only after the save landed, so a refused one changes nothing.
        if update_data.get("is_default"):
            await self._unset_default_for_project(
                async_session, project_id=project_id, exclude_id=workflow_id
            )
            await async_session.commit()
        return self.model(**row)

    async def delete_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        workflow_id: UUID,
    ) -> bool:
        """Delete a workflow."""
        db_obj = await self.get_by_project_and_id(
            async_session, project_id=project_id, workflow_id=workflow_id
        )
        if not db_obj:
            return False

        await async_session.delete(db_obj)
        await async_session.commit()
        return True

    async def duplicate(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        workflow_id: UUID,
        new_name: str | None = None,
    ) -> Workflow | None:
        """Duplicate a workflow."""
        db_obj = await self.get_by_project_and_id(
            async_session, project_id=project_id, workflow_id=workflow_id
        )
        if not db_obj:
            return None

        # Deep copy config to avoid reference issues
        import copy

        new_config = copy.deepcopy(db_obj.config)

        new_workflow = Workflow(
            project_id=project_id,
            name=new_name or f"{db_obj.name} (Copy)",
            description=db_obj.description,
            is_default=False,  # Duplicates are never default
            config=new_config,
            thumbnail_url=None,  # Reset thumbnail
        )
        async_session.add(new_workflow)
        await async_session.commit()
        await async_session.refresh(new_workflow)
        return new_workflow

    async def _unset_default_for_project(
        self,
        async_session: AsyncSession,
        *,
        project_id: UUID,
        exclude_id: UUID | None = None,
    ) -> None:
        """Unset the default flag for all workflows in a project.

        Losing the flag is no change of the workflow: its revision and the time
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


workflow = CRUDWorkflow(Workflow)
