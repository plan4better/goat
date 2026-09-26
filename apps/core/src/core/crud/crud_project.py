import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from goatlib.models.project import DEFAULT_INITIAL_VIEW_STATE
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import and_, not_, or_

from core.core.config import settings
from core.core.content import (
    build_shared_with_object,
    create_query_shared_content,
    fetch_grants_by_resource,
    grant_conditions,
    update_content_by_id,
)
from core.crud.base import CRUDBase
from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_user_project import user_project as crud_user_project
from core.db.models import (
    Project,
    ResourceGrant,
    Role,
)
from core.db.models._link_model import UserProjectLink
from core.db.models.project import ProjectPublic
from core.schemas.common import OrderEnum
from core.schemas.project import (
    InitialViewState,
    IProjectBaseUpdate,
    IProjectRead,
    ProjectPublicConfig,
    ProjectPublicProjectConfig,
    ProjectPublicRead,
)


class CRUDProject(CRUDBase[Project, Any, Any]):
    async def space_labels(
        self, async_session: AsyncSession, space_ids: list[UUID | None]
    ) -> dict[UUID, dict[str, str | None]]:
        """``space_kind`` and ``space_name`` per space, in one round trip.

        The name is the owning team's or organisation's. A personal space has
        none: its owner's display name is not what a project's badge shows, and
        exposing it would leak the owner to anyone who can read the project.
        ``space_id`` itself is already on the project row, so it is not
        returned here.
        """
        wanted = [sid for sid in space_ids if sid is not None]
        if not wanted:
            return {}
        result = await async_session.execute(
            text(
                "SELECT s.id, s.kind, CASE s.kind "
                "WHEN 'team' THEN t.name WHEN 'organization' THEN o.name END AS name "
                f"FROM {settings.SCHEMA}.space s "
                f"LEFT JOIN {settings.SCHEMA}.team t ON t.id = s.team_id "
                f"LEFT JOIN {settings.SCHEMA}.organization o ON o.id = s.organization_id "
                "WHERE s.id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": [str(sid) for sid in dict.fromkeys(wanted)]},
        )
        return {
            row.id: {"space_kind": row.kind, "space_name": row.name} for row in result
        }

    async def space_label(
        self, async_session: AsyncSession, space_id: UUID | None
    ) -> dict[str, str | None]:
        """`space_labels` for a single project's space; empty for no space."""
        if space_id is None:
            return {"space_kind": None, "space_name": None}
        labels = await self.space_labels(async_session, [space_id])
        return labels.get(space_id, {"space_kind": None, "space_name": None})

    async def restricted_inherited(
        self, async_session: AsyncSession, project: Project
    ) -> bool:
        """Whether a restricted ancestor folder closes this project while its
        own flag is off, as the content feed reports it."""
        if project.restricted or project.folder_id is None:
            return False
        result = await async_session.execute(
            text(
                f"SELECT {settings.SCHEMA}.restricted_applies('project', :id, :folder_id)"
            ),
            {"id": project.id, "folder_id": project.folder_id},
        )
        return bool(result.scalar())

    async def personally_owned_layer_counts(
        self, async_session: AsyncSession, project_ids: list[UUID | None]
    ) -> dict[UUID, int | None]:
        """Per project: the count of its linked live layers whose own space
        is a *personal* space — ``None`` for a project that is itself in a
        personal space (D13 health check; Home shows this only on
        team/organisation projects).

        One round trip for the whole batch (a correlated subquery per row),
        never a per-row query — the listing page calls this once, same as
        `space_labels`.
        """
        wanted = [pid for pid in project_ids if pid is not None]
        if not wanted:
            return {}
        result = await async_session.execute(
            text(
                "SELECT p.id AS project_id, "
                "CASE WHEN sp.kind = 'personal' THEN NULL ELSE ("
                "  SELECT COUNT(DISTINCT lp.layer_id) "
                f"    FROM {settings.SCHEMA}.layer_project lp "
                f"    JOIN {settings.SCHEMA}.layer l "
                "         ON l.id = lp.layer_id AND l.deleted_at IS NULL "
                f"    JOIN {settings.SCHEMA}.space ls "
                "         ON ls.id = l.space_id AND ls.kind = 'personal' "
                "   WHERE lp.project_id = p.id"
                ") END AS personally_owned_layer_count "
                f"FROM {settings.SCHEMA}.project p "
                f"LEFT JOIN {settings.SCHEMA}.space sp ON sp.id = p.space_id "
                "WHERE p.id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": [str(pid) for pid in dict.fromkeys(wanted)]},
        )
        return {row.project_id: row.personally_owned_layer_count for row in result}

    async def personally_owned_layer_count(
        self, async_session: AsyncSession, project_id: UUID | None
    ) -> int | None:
        """`personally_owned_layer_counts` for a single project."""
        if project_id is None:
            return None
        counts = await self.personally_owned_layer_counts(async_session, [project_id])
        return counts.get(project_id)

    async def get_my_role(
        self, async_session: AsyncSession, *, project_id: UUID, user_id: UUID
    ) -> str | None:
        """Strongest project role across every path the user reaches the project
        by (ownership, direct/team/organisation grant, folder grant), via
        `effective_role` — prefixed with ``"project-"``. None when there is no
        path.
        """
        result = await async_session.execute(
            text(f"SELECT {settings.SCHEMA}.effective_role('project', :pid, :uid)"),
            {"pid": str(project_id), "uid": str(user_id)},
        )
        role = result.scalar()
        return f"project-{role}" if role else None

    async def create(
        self,
        async_session: AsyncSession,
        project_in: Project,
        initial_view_state: InitialViewState | None = None,
    ) -> IProjectRead:
        """Create project"""

        # Create project
        project = await CRUDBase(Project).create(
            db=async_session,
            obj_in=project_in,
        )
        # Seed the owner's view state from the create payload when one was
        # given; fall back to the default otherwise (e.g. a caller with no
        # view state of its own).
        seeded_view_state: dict[str, Any] = (
            initial_view_state.model_dump()
            if initial_view_state is not None
            else dict(DEFAULT_INITIAL_VIEW_STATE)
        )

        # Create link between user and project for initial view state
        await crud_user_project.create(
            async_session,
            obj_in=UserProjectLink(
                user_id=project.user_id,
                project_id=project.id,
                initial_view_state=seeded_view_state,
            ).model_dump(),
        )
        # Doing unneeded type conversion to make sure the relations of project are not loaded
        return IProjectRead(
            **project.model_dump(),
            **await self.space_label(async_session, project.space_id),
            personally_owned_layer_count=await self.personally_owned_layer_count(
                async_session, project.id
            ),
        )

    async def get_live_or_404(
        self, async_session: AsyncSession, project_id: UUID
    ) -> Project:
        """Fetch a project, 404ing if it doesn't exist or is trashed.

        A trashed project behaves as gone for every normal route that reaches
        it via `project_id` in the path — its sub-resources (layers,
        layer-tree, groups, report layouts, workflows) included, so a soft
        delete can't be worked around by going through a child route. The
        trash listing (`GET /content/trash`) is the only place a trashed
        project is still surfaced.
        """
        project = await self.get(async_session, id=project_id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
            )
        return project

    async def get_projects(
        self,
        async_session: AsyncSession,
        user_id: UUID,
        page_params: PaginationParams,
        folder_id: UUID | None = None,
        search: str | None = None,
        order_by: str | None = None,
        order: OrderEnum | None = None,
        ids: list | None = None,
        team_id: UUID | None = None,
        organization_id: UUID | None = None,
        team_ids: list[UUID] | None = None,
        user_organization_id: UUID | None = None,
    ) -> Page[IProjectRead]:
        """Get projects for a user and folder"""

        # Build query and filters
        use_folder_grant_query = False
        if team_id or organization_id:
            grantee_conditions = grant_conditions(None, team_id, organization_id)
            if folder_id:
                # Check whether this folder is accessible via a ResourceGrant for the
                # given team/org. If so, bypass the direct-grant filter below —
                # projects in folder-shared folders have no such grant of their own.
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
                filters = [Project.folder_id == folder_id]
            else:
                # At team/org root: exclude projects that live inside a folder
                # already shared with this team/org — those surface when navigating
                # into the folder, not at the root level.
                folder_granted_ids = select(ResourceGrant.resource_id).where(
                    ResourceGrant.resource_type == "folder",
                    or_(*grantee_conditions),
                )
                # NULL-safe: folder_id IS NULL means no folder, so always include it.
                # Without this, NULL NOT IN (...) evaluates to UNKNOWN (= excluded).
                filters = [
                    or_(
                        Project.folder_id.is_(None),
                        not_(Project.folder_id.in_(folder_granted_ids)),
                    )
                ]
        elif folder_id:
            # Check if the folder is shared with the user via a grant.
            # If so, show all projects in the folder (not just the user's own).
            has_grant = False
            folder_grant_conditions = []
            if team_ids:
                folder_grant_conditions.append(
                    and_(
                        ResourceGrant.grantee_type == "team",
                        ResourceGrant.grantee_id.in_(team_ids),
                    )
                )
            if user_organization_id:
                folder_grant_conditions.append(
                    and_(
                        ResourceGrant.grantee_type == "organization",
                        ResourceGrant.grantee_id == user_organization_id,
                    )
                )
            if folder_grant_conditions:
                grant_result = await async_session.execute(
                    select(ResourceGrant.id)
                    .where(
                        ResourceGrant.resource_type == "folder",
                        ResourceGrant.resource_id == folder_id,
                        or_(*folder_grant_conditions),
                    )
                    .limit(1)
                )
                has_grant = grant_result.first() is not None

            filters = [Project.folder_id == folder_id]
            if not has_grant:
                filters.append(Project.user_id == user_id)
        else:
            filters = [Project.user_id == user_id]

        # Every listing hides trashed projects; effective_role already hides
        # them from anyone but the space owner/admin restoring them. A
        # frozen template-source copy (T2) is hidden from every listing too
        # — only the template row pointing at it is content a user sees.
        filters.append(Project.deleted_at.is_(None))
        filters.append(Project.is_template_source.is_(False))

        if ids:
            query = select(Project).where(
                Project.id.in_(ids),
                Project.deleted_at.is_(None),
                Project.is_template_source.is_(False),
            )
        elif use_folder_grant_query:
            # Folder is shared via ResourceGrant — bypass the team/org grant join
            # so we see all projects in the folder regardless of their own grants.
            query = create_query_shared_content(
                Project,
                filters,
                team_id=None,
                organization_id=None,
            )
        else:
            query = create_query_shared_content(
                Project,
                filters,
                team_id=team_id,
                organization_id=organization_id,
            )

        # Get roles
        roles = await CRUDBase(Role).get_all(
            async_session,
        )
        role_mapping = {role.id: role.name for role in roles}

        # Get projects
        projects = await self.get_multi(
            async_session,
            query=query,
            page_params=page_params,
            search_text={"name": search} if search else {},
            order_by=order_by,
            order=order,
        )
        effective_team_id = None if use_folder_grant_query else team_id
        effective_org_id = None if use_folder_grant_query else organization_id
        grants_by_resource = None
        if not effective_team_id and not effective_org_id:
            grants_by_resource = await fetch_grants_by_resource(
                async_session, "project", [row[0].id for row in projects.items]
            )
        projects.items = build_shared_with_object(
            items=projects.items,
            role_mapping=role_mapping,
            model_name="project",
            team_id=effective_team_id,
            organization_id=effective_org_id,
            grants_by_resource=grants_by_resource,
        )
        # One lookup for the whole page: Home badges every project with the
        # space it belongs to.
        labels = await self.space_labels(
            async_session, [item.get("space_id") for item in projects.items]
        )
        # One more lookup for the whole page: the "personally owned datasets
        # in this project" health count (D13), never a per-row round trip.
        owned_counts = await self.personally_owned_layer_counts(
            async_session, [item.get("id") for item in projects.items]
        )
        for item in projects.items:
            item.update(
                labels.get(
                    item.get("space_id"), {"space_kind": None, "space_name": None}
                )
            )
            item["personally_owned_layer_count"] = owned_counts.get(item.get("id"))
        return projects

    async def update_base(
        self, async_session: AsyncSession, id: UUID, project: IProjectBaseUpdate
    ) -> IProjectRead:
        """Update project base"""

        # Update project
        updated_project = await update_content_by_id(
            async_session=async_session,
            id=id,
            model=Project,
            crud_content=self,
            content_in=project,
        )

        if updated_project is None:
            raise Exception("Project not found")

        return IProjectRead(
            **updated_project.model_dump(),
            **await self.space_label(async_session, updated_project.space_id),
            personally_owned_layer_count=await self.personally_owned_layer_count(
                async_session, updated_project.id
            ),
        )

    async def get_public_project(
        self, *, async_session: AsyncSession, project_id: UUID
    ) -> ProjectPublicRead | None:
        # Local imports to avoid module-level cycles between crud_project,
        # the analytics model (which imports the organization model), and
        # the project model.
        from core.db.models.organization_analytics import OrganizationAnalytics
        from core.schemas.project import PublicAnalytics

        result = await async_session.execute(
            select(ProjectPublic).where(ProjectPublic.project_id == project_id)
        )
        project_public = result.scalars().first()
        if not project_public:
            return None

        # Resolve the assigned analytics instance (if any) via the direct
        # FK; a dangling reference (instance deleted mid-request) simply
        # yields no analytics block.
        analytics: PublicAnalytics | None = None
        if project_public.analytics_id is not None:
            analytics_row = (
                (
                    await async_session.execute(
                        select(OrganizationAnalytics).where(
                            OrganizationAnalytics.id == project_public.analytics_id
                        )
                    )
                )
                .scalars()
                .first()
            )
            if analytics_row is not None:
                analytics = PublicAnalytics(
                    provider=analytics_row.provider,
                    config=analytics_row.config,
                )

        return ProjectPublicRead(
            **project_public.model_dump(),
            analytics=analytics,
        )

    async def publish_project(
        self, *, async_session: AsyncSession, project_id: UUID
    ) -> ProjectPublic:
        project = (
            (
                await async_session.execute(
                    select(Project).where(Project.id == project_id)
                )
            )
            .scalars()
            .first()
        )
        if not project:
            raise Exception("Project not found")
        project_public: ProjectPublic | None = (
            (
                await async_session.execute(
                    select(ProjectPublic).where(ProjectPublic.project_id == project_id)
                )
            )
            .scalars()
            .first()
        )
        user_project = (
            (
                await async_session.execute(
                    select(UserProjectLink).where(
                        and_(
                            UserProjectLink.project_id == project_id,
                            Project.user_id == UserProjectLink.user_id,
                        )
                    )
                )
            )
            .scalars()
            .first()
        )
        # D7: a non-shareable link never reaches the public config — publishing
        # would hand the layer to everyone, and its adder could not share it at
        # all.
        project_layers = await crud_layer_project.get_layers(
            async_session=async_session, project_id=project_id, only_shareable=True
        )
        published_link_ids = {pl.id for pl in project_layers}
        # `catalog_materialize` is served live precisely because it keeps
        # moving; a snapshot of it would describe a long-ready layer as pending
        # forever. The public viewer needs the item, not the job.
        for pl in project_layers:
            props = getattr(pl, "other_properties", None)
            if isinstance(props, dict) and "catalog_materialize" in props:
                pl.other_properties = {
                    k: v for k, v in props.items() if k != "catalog_materialize"
                }

        # Import here to avoid circular imports
        from core.crud.crud_layer_project_group import layer_project_group
        from core.schemas.project import ILayerProjectGroupRead

        project_layer_groups_db = await layer_project_group.get_groups_by_project(
            async_session=async_session, project_id=project_id
        )

        # Convert to schema objects
        project_layer_groups = [
            ILayerProjectGroupRead(**group.model_dump())
            for group in project_layer_groups_db
        ]

        new_project_public_project_config = ProjectPublicProjectConfig(
            id=project.id,
            name=project.name,
            description=project.description,
            tags=project.tags,
            thumbnail_url=project.thumbnail_url,
            initial_view_state=user_project.initial_view_state,
            basemap=project.basemap,
            custom_basemaps=project.custom_basemaps,
            # Kept in step with the layers above, so the public config never
            # orders a link it does not carry.
            layer_order=[
                link_id
                for link_id in (project.layer_order or [])
                if link_id in published_link_ids
            ],
            max_extent=project.max_extent,
            folder_id=project.folder_id,
            builder_config=project.builder_config,
        )
        new_project_public_config = ProjectPublicConfig(
            layers=project_layers,
            layer_groups=project_layer_groups,
            project=new_project_public_project_config,
        )
        new_config = json.loads(new_project_public_config.model_dump_json())

        # Update in place when a public row already exists so we preserve
        # custom_domain_id, password, subdomain, analytics_id across
        # re-publish. The previous delete+recreate flow silently dropped
        # the custom-domain assignment every time the user clicked "Update".
        if project_public:
            project_public.config = new_config
            await async_session.commit()
            await async_session.refresh(project_public)
            return project_public

        new_project_public = ProjectPublic(
            project_id=project_id,
            config=new_config,
        )
        async_session.add(new_project_public)
        await async_session.commit()
        return new_project_public

    async def unpublish_project(
        self, *, async_session: AsyncSession, project_id: str
    ) -> None:
        public_project = (
            (
                await async_session.execute(
                    select(ProjectPublic).where(ProjectPublic.project_id == project_id)
                )
            )
            .scalars()
            .first()
        )
        if public_project:
            await async_session.delete(public_project)
            await async_session.commit()
        else:
            raise Exception("Project not found")
        return None

    async def unpublish_projects_in(
        self, async_session: AsyncSession, folder_ids: list[UUID]
    ) -> None:
        """Unpublish every project inside these folders that has a public
        page. Used when a folder is soft-deleted so a project's
        public URL 404s immediately instead of continuing to serve the
        last-published config."""
        project_ids = (
            (
                await async_session.execute(
                    select(ProjectPublic.project_id)
                    .join(Project, Project.id == ProjectPublic.project_id)
                    .where(Project.folder_id.in_(folder_ids))
                )
            )
            .scalars()
            .all()
        )
        for project_id in project_ids:
            await self.unpublish_project(
                async_session=async_session, project_id=str(project_id)
            )

    async def delete(self, db: AsyncSession, *, id: UUID) -> None:
        """Soft delete: set `deleted_at` and, if published, unpublish first —
        rows stay so a restore can undo this; DuckLake data for the
        project's layers is untouched (the purge task removes it later)."""
        project = await db.get(Project, id)
        if project is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
            )
        if project.deleted_at is not None:
            return
        public = (
            await db.execute(
                select(ProjectPublic.id).where(ProjectPublic.project_id == id)
            )
        ).scalar_one_or_none()
        if public is not None:
            await self.unpublish_project(async_session=db, project_id=str(id))
        project.deleted_at = datetime.now(timezone.utc)
        db.add(project)
        await db.commit()


project = CRUDProject(Project)
