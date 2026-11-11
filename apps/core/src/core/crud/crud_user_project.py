from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from core.db.models._link_model import UserProjectLink
from core.db.models.project import Project
from core.schemas.project import InitialViewState

from .base import CRUDBase


class CRUDUserProject(CRUDBase[Any, Any, Any]):
    async def update_initial_view_state(
        self,
        async_session: AsyncSession,
        project_id: UUID,
        user_id: UUID,
        initial_view_state: InitialViewState,
    ) -> UserProjectLink:
        """Update the initial view state of a project for a user"""

        existing_user_project = await self.get_by_multi_keys(
            async_session,
            keys={"user_id": user_id, "project_id": project_id},
        )

        if existing_user_project:
            user_project: UserProjectLink = await self.update(
                async_session,
                db_obj=existing_user_project[0],
                obj_in={
                    "initial_view_state": initial_view_state.model_dump(
                        exclude_none=True
                    )
                },
            )
        else:
            # Shared-folder user saving their view state for the first time — create the row.
            user_project = await self.create(
                async_session,
                obj_in=UserProjectLink(
                    user_id=user_id,
                    project_id=project_id,
                    initial_view_state=initial_view_state.model_dump(exclude_none=True),
                ).model_dump(),
            )

        # Get project
        project = await CRUDBase(Project).get(async_session, id=project_id)

        if not project:
            raise ValueError("Unable to fetch project")

        # Update project updated_at
        await CRUDBase(Project).update(
            async_session,
            db_obj=project,
            obj_in={"updated_at": user_project.updated_at},
        )

        return user_project


user_project = CRUDUserProject(UserProjectLink)
