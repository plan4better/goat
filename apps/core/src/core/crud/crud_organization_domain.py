"""
Organization Domain CRUD Operations.

The CreateSchemaType / UpdateSchemaType generic parameters are typed as `Any`
for now; the proper Pydantic schemas (`OrganizationDomainCreate`,
`OrganizationDomainUpdate`) will be introduced in Phase 2 of the white-label
custom domains feature, at which point this module's generics should be
updated accordingly.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, List, Tuple
from uuid import UUID

from sqlalchemy import and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from core.db.models.organization_domain import (
    DnsStatus,
    OrganizationDomain,
)
from core.db.models.project import Project, ProjectPublic

from .base import CRUDBase


class CRUDOrganizationDomain(CRUDBase[OrganizationDomain, Any, Any]):
    """CRUD operations for the OrganizationDomain model."""

    async def list_with_assignment_by_organization(
        self, async_session: AsyncSession, *, organization_id: UUID
    ) -> List[Tuple[OrganizationDomain, UUID | None, str | None]]:
        """List domains with the (optional) project they're currently assigned to.

        LEFT JOIN to project_public on custom_domain_id, then to project on
        project_public.project_id. Domains with no assignment yield (domain, None, None).
        """
        statement = (
            select(self.model, ProjectPublic.project_id, Project.name)
            .outerjoin(
                ProjectPublic,
                ProjectPublic.custom_domain_id == self.model.id,
            )
            .outerjoin(
                Project,
                Project.id == ProjectPublic.project_id,
            )
            .where(self.model.organization_id == organization_id)
            .order_by(self.model.created_at.desc())
        )
        result = await async_session.execute(statement)
        return [(d, pid, name) for d, pid, name in result.all()]

    async def get_with_assignment(
        self, async_session: AsyncSession, *, id: UUID
    ) -> Tuple[OrganizationDomain, UUID | None, str | None] | None:
        """Get a single domain with its (optional) assigned project."""
        statement = (
            select(self.model, ProjectPublic.project_id, Project.name)
            .outerjoin(
                ProjectPublic,
                ProjectPublic.custom_domain_id == self.model.id,
            )
            .outerjoin(
                Project,
                Project.id == ProjectPublic.project_id,
            )
            .where(self.model.id == id)
        )
        result = await async_session.execute(statement)
        row = result.first()
        if row is None:
            return None
        return (row[0], row[1], row[2])

    async def list_pending_dns(
        self, async_session: AsyncSession, *, max_age_days: int = 7
    ) -> List[OrganizationDomain]:
        """List domains awaiting DNS verification that were created within max_age_days.

        A failed check (a record pointing elsewhere) counts: once the customer
        fixes the record, the next pass verifies it.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
        statement = select(self.model).where(
            and_(
                self.model.dns_status.in_([DnsStatus.PENDING, DnsStatus.FAILED]),
                self.model.created_at >= cutoff,
            )
        )
        result = await async_session.execute(statement)
        return list(result.scalars().all())


organization_domain = CRUDOrganizationDomain(OrganizationDomain)
