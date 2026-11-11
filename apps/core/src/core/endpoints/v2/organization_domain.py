"""User-facing endpoints for managing custom domains in an organization.

Phase 4 of the white-label custom domains feature.

Access is enforced by ``auth_z``: the seeded resources require
``update-organization`` (organization admins and owners) to add, recheck or
delete a domain and ``read-organization`` to list them, and the organization
in the path must be the caller's own. The router is mounted under
``/organizations`` with the rest of the path on each route, so
``route_pattern`` keeps ``{organization_id}`` as a placeholder.
``tests/authz/test_organization_domain_route.py`` and
``tests/unit/test_organization_route_resources.py`` pin this.
"""

from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException, Path, status
from pydantic import UUID4
from sqlalchemy.exc import IntegrityError

from core.core.config import settings
from core.crud.crud_organization_domain import organization_domain as crud
from core.db.models.organization_domain import (
    CertStatus,
    DnsStatus,
    OrganizationDomain,
)
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.deps.provisioner import get_provisioner
from core.endpoints.deps import get_db, get_user_id
from core.schemas.organization_domain import (
    OrganizationDomainCreate,
    OrganizationDomainRead,
)
from core.services.domain_reconciliation import (
    provision_domain,
    refresh_dns,
    release_domain,
)
from core.services.provisioner import CustomDomainProvisioner

router = APIRouter()


def _require_custom_domains() -> None:
    """400 while custom domains are off (``CUSTOM_DOMAIN_CNAME_TARGET`` empty).

    Listing, reading and deleting stay available, so domains registered
    while the feature was on can still be removed.
    """
    if not settings.custom_domains_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "custom domains are not enabled on this instance "
                "(CUSTOM_DOMAIN_CNAME_TARGET is not set)"
            ),
        )


@router.get(
    "/{organization_id}/domains/",
    summary="List custom domains for an organization",
    response_model=List[OrganizationDomainRead],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_domains(
    *,
    organization_id: UUID4 = Path(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> List[OrganizationDomainRead]:
    """Return all custom domains owned by the given organization."""
    rows = await crud.list_with_assignment_by_organization(
        async_session, organization_id=organization_id
    )
    return [
        OrganizationDomainRead.model_validate(domain).model_copy(
            update={
                "assigned_project_id": project_id,
                "assigned_project_name": project_name,
            }
        )
        for domain, project_id, project_name in rows
    ]


@router.post(
    "/{organization_id}/domains/",
    summary="Register a new custom domain for an organization",
    response_model=OrganizationDomainRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(auth_z)],
)
async def create_domain(
    *,
    organization_id: UUID4 = Path(...),
    payload: OrganizationDomainCreate = Body(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    provisioner: CustomDomainProvisioner = Depends(get_provisioner),
) -> OrganizationDomain:
    """Register a new custom domain.

    Performs an immediate DNS check; if the CNAME is already pointing at
    the canonical target, also notifies the provisioner so the user
    doesn't need to wait for the next cron tick.
    """
    _require_custom_domains()
    domain = OrganizationDomain(
        organization_id=organization_id,
        base_domain=payload.base_domain,
    )
    async_session.add(domain)
    try:
        await async_session.flush()
    except IntegrityError as exc:
        await async_session.rollback()
        # Distinguish between common integrity-error causes so the caller
        # gets a useful message rather than a misleading "already registered".
        err_detail = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "unique" in err_detail or "duplicate key" in err_detail:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"domain '{payload.base_domain}' is already registered",
            )
        if "foreign key" in err_detail or "violates foreign key" in err_detail:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"organization {organization_id} does not exist "
                    "(seed it before adding domains)"
                ),
            )
        # Surface the actual database error for any other constraint failure.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc.orig) if exc.orig else str(exc),
        )

    dns_status = await refresh_dns(
        domain, canonical_target=settings.CUSTOM_DOMAIN_CNAME_TARGET
    )

    if dns_status == DnsStatus.VERIFIED:
        await provision_domain(domain, provisioner=provisioner)
        # Caddy issues lazily on first inbound request, so there's no
        # "issuing" wait state — flip directly to active.
        domain.cert_status = CertStatus.ACTIVE
        domain.cert_status_message = None

    await async_session.commit()
    await async_session.refresh(domain)
    return domain


@router.get(
    "/{organization_id}/domains/{domain_id}",
    summary="Get a single custom domain by ID",
    response_model=OrganizationDomainRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_domain(
    *,
    organization_id: UUID4 = Path(...),
    domain_id: UUID4 = Path(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> OrganizationDomainRead:
    """Return a single custom domain. 404 if not owned by the given org."""
    row = await crud.get_with_assignment(async_session, id=domain_id)
    if not row or row[0].organization_id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="domain not found"
        )
    domain, project_id, project_name = row
    return OrganizationDomainRead.model_validate(domain).model_copy(
        update={
            "assigned_project_id": project_id,
            "assigned_project_name": project_name,
        }
    )


@router.post(
    "/{organization_id}/domains/{domain_id}/recheck",
    summary="Re-run DNS verification + maybe trigger provisioning",
    response_model=OrganizationDomainRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def recheck_domain(
    *,
    organization_id: UUID4 = Path(...),
    domain_id: UUID4 = Path(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    provisioner: CustomDomainProvisioner = Depends(get_provisioner),
) -> OrganizationDomain:
    """Synchronously re-verify DNS for a domain.

    If DNS now resolves to the canonical target and we haven't kicked off
    cert issuance yet, or the certificate failed, we notify the provisioner
    here as well so the user gets immediate feedback rather than waiting for
    the cron.
    """
    _require_custom_domains()
    domain = await crud.get(async_session, id=domain_id)
    if not domain or domain.organization_id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="domain not found"
        )

    dns_status = await refresh_dns(
        domain, canonical_target=settings.CUSTOM_DOMAIN_CNAME_TARGET
    )

    # A failed certificate gets the same new start as a pending one: Caddy
    # issues on the first request, so there is no "issuing" state to wait in.
    if dns_status == DnsStatus.VERIFIED and domain.cert_status in (
        CertStatus.PENDING,
        CertStatus.FAILED,
    ):
        await provision_domain(domain, provisioner=provisioner)
        domain.cert_status = CertStatus.ACTIVE
        domain.cert_status_message = None

    await async_session.commit()
    await async_session.refresh(domain)
    return domain


@router.delete(
    "/{organization_id}/domains/{domain_id}",
    summary="Remove a custom domain (and release it from the provisioner)",
    response_model=None,
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(auth_z)],
)
async def delete_domain(
    *,
    organization_id: UUID4 = Path(...),
    domain_id: UUID4 = Path(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    provisioner: CustomDomainProvisioner = Depends(get_provisioner),
) -> None:
    """Delete a custom domain. Releases it from the provisioner if active."""
    domain = await crud.get(async_session, id=domain_id)
    if not domain or domain.organization_id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="domain not found"
        )

    if domain.cert_status == CertStatus.ACTIVE:
        await release_domain(domain, provisioner=provisioner)

    await async_session.delete(domain)
    await async_session.commit()
