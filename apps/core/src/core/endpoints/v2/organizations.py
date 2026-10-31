import logging
from typing import Any, List
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from keycloak.exceptions import KeycloakError
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.crud.crud_invitation import invitation as crud_invitation
from core.crud.crud_organization import OrganizationNotDeletableError
from core.crud.crud_organization import organization as crud_organization
from core.crud.crud_user import user as crud_user
from core.db.models import Organization
from core.db.models.invitation import Invitation, InvitationStatusEnum, InvitationType
from core.db.models.organization import OrganizationRolesEnum
from core.db.models.user import User
from core.deps import keycloak as keycloak_deps
from core.deps.auth import (
    auth_z,
    can_create_organization,
    require_superuser,
    token_is_superuser,
    user_token,
)
from core.endpoints.deps import get_db
from core.schemas.email import EmailTemplateContent
from core.schemas.invitations import (
    InvitationOrgCreate,
    InvitationOrgCreateRead,
    InvitationOrgUpdate,
)
from core.schemas.organization import (
    OrganizationCreate,
    OrganizationPermanentlyDeleted,
    OrganizationRead,
    OrganizationUpdate,
    OrganizationUpdateMemberRole,
    OrganizationUser,
    request_examples,
)
from core.utils.email import send_email, user_language
from core.utils.i18n import language
from core.utils.i18n import trans as _

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "",
    summary="Get all organizations",
    response_model=Page[OrganizationRead],
    dependencies=[Depends(require_superuser)],
)
async def get_organizations(
    *,
    db: AsyncSession = Depends(get_db),
    page_params: PaginationParams = Depends(),
) -> Any:
    """
    Get all organizations
    """
    organizations = await crud_organization.get_multi(db=db, page_params=page_params)
    return organizations


@router.get(
    "/{organization_id}",
    summary="Get an organization",
    response_model=OrganizationRead,
    dependencies=[Depends(auth_z)],
)
async def get_organization(
    *,
    db: AsyncSession = Depends(get_db),
    organization_id: str,
) -> Any:
    """
    Get an organization
    """
    organization = await crud_organization.get(db=db, id=organization_id)
    return organization


@router.post(
    "",
    summary="Create a new organization",
    response_model=OrganizationRead,
)
async def create_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    organization: OrganizationCreate = Body(
        ..., examples=[request_examples["organization"]["create"]]
    ),
    request: Request,
) -> Any:
    """
    Create a new organization. With `ALLOW_ORGANIZATION_CREATION` off, only
    superusers may; everyone else joins through an invitation.
    """
    user_id = user_token["sub"]  # always the caller
    if not can_create_organization(user_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organizations are set up by an administrator. Ask to be invited to an existing one.",
        )
    db_user = await crud_user.get(db=db, id=user_id)
    if db_user and db_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User has already an organization",
        )
    _is_superuser = token_is_superuser(user_token)
    organization = await crud_organization.create_organization(
        db=db,
        organization_obj=organization,
        user_id=user_id,
        is_superuser=_is_superuser,
    )

    return organization


@router.patch(
    "/{organization_id}/profile",
    summary="Update organization",
    response_model=Organization,
    dependencies=[Depends(auth_z)],
)
async def update_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    organization_id: str,
    organization: OrganizationUpdate = Body(
        ..., examples=[request_examples["organization"]["update"]]
    ),
) -> Any:
    """
    Update an organization
    """
    db_obj = await crud_organization.get(db=db, id=organization_id)
    if not db_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    updated_organization = await crud_organization.update_organization_profile(
        db=db, db_obj=db_obj, organization_obj=organization
    )
    return updated_organization


@router.delete(
    "/{organization_id}",
    summary="Delete an organization",
    dependencies=[Depends(auth_z)],
)
async def delete_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    organization_id: str,
) -> None:
    """
    Delete an organization
    """
    organization_obj = await crud_organization.get(db=db, id=organization_id)
    if not organization_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    await crud_organization.delete_organization(
        db=db, organization_obj=organization_obj
    )


@router.delete(
    "/{organization_id}/permanent",
    summary="Delete an organization permanently (superusers only)",
    response_model=OrganizationPermanentlyDeleted,
    dependencies=[Depends(require_superuser)],
)
async def delete_organization_permanently(
    *,
    organization_id: UUID,
) -> OrganizationPermanentlyDeleted:
    """Remove an organization that holds nothing but the user who set it up,
    e.g. someone who signed in before their invitation existed. The user
    keeps their account and personal space, has no organization afterwards
    and can be invited. An organization whose last member is gone can be
    removed the same way. `DELETE /organizations/{organization_id}` only
    suspends an organization.

    Answers 409 unless the organization has at most one member and nothing
    in it: no content in its space or in the member's personal space (trash
    included), no teams, pending invitations, custom domains or analytics
    settings. Billing is not touched: a subscription of the Odoo company named
    by `odoo_company_id` stays in Odoo until it is ended there; its
    entitlement pushes find no organization and are refused.
    """
    try:
        deleted = await crud_organization.delete_permanently(
            organization_id=organization_id
        )
    except OrganizationNotDeletableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only an organization with at most one member and nothing in it "
            f"can be deleted permanently. Found {exc}.",
        ) from exc
    if deleted is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    logger.info(
        "organization %s deleted permanently, former member: %s",
        deleted.id,
        deleted.user_id,
    )
    return deleted


#### ORGANIZATION USERS ###
@router.get(
    "/{organization_id}/users",
    summary="Get all users of an organization",
    response_model=List[OrganizationUser],
    dependencies=[Depends(auth_z)],
)
async def get_organization_users(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    organization_id: str,
    include_invitations: bool = False,
) -> Any:
    """
    Get all users in an organization
    """
    user_id = user_token["sub"]
    if include_invitations:
        user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
        if not any(
            role_link.role.name
            in [OrganizationRolesEnum.owner, OrganizationRolesEnum.admin]
            for role_link in user.role_links
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to access the invited users",
            )

    members = await crud_organization.get_users(
        db=db, organization_id=organization_id, include_invitations=include_invitations
    )
    return members


@router.delete(
    "/{organization_id}/users/{user_id}",
    summary="Remove a user from an organization",
    response_model=User,
    dependencies=[Depends(auth_z)],
)
async def remove_user_from_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    user_id: str | None = None,
    organization_id: str,
    reassign_to: UUID | None = Query(
        None,
        description="Member of the same organization who receives the user's folders, layers, projects and bundles. Required when the user owns content.",
    ),
) -> Any:
    """Remove a user from an organization. Content the user owns is handed to `reassign_to`, never deleted."""
    organization_obj = await crud_organization.get(db=db, id=organization_id)
    if organization_obj.contact_user_id == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove organization owner",
        )
    try:
        user = await crud_organization.remove_user(
            db=db,
            organization_id=organization_obj.id,
            user_id=user_id,
            reassign_to=str(reassign_to) if reassign_to is not None else None,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    return user


# update user role in organization
@router.patch(
    "/{organization_id}/users/{user_id}",
    summary="Update user role in organization",
    response_model=OrganizationUser,
    dependencies=[Depends(auth_z)],
)
async def update_user_role_in_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    organization_id: str,
    user_id: str,
    role: OrganizationUpdateMemberRole = Body(
        ..., examples=[request_examples["organization"]["update_user_role"]]
    ),
) -> Any:
    """
    Update user role in organization
    """
    user = await crud_organization.update_user_role(
        db=db, organization_id=organization_id, user_id=user_id, role=role.role
    )
    return user


#### ORGANIZATION INVITATIONS ###


@router.post(
    "/{organization_id}/invitations",
    summary="Invite a user to an organization",
    response_model=InvitationOrgCreateRead,
    dependencies=[Depends(auth_z)],
)
async def invite_user_to_organization(
    *,
    db: AsyncSession = Depends(get_db),
    organization_id: str,
    user_token: dict = Depends(user_token),
    payload: InvitationOrgCreate = Body(
        ..., examples=[request_examples["organization"]["invite"]]
    ),
) -> Any:
    """
    Add a user to an organization
    """
    # - check if email is already registered and has another org
    user_id = user_token["sub"]  # always the caller
    invited_user = await crud_user.get_by_key(
        db=db, key="email", value=payload.user_email
    )
    organization = await crud_organization.get(db=db, id=organization_id)
    if not organization:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_("Organization not found"),
        )
    # check if user has role in organization to invite
    if invited_user and len(invited_user) > 0 and invited_user[0].organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_("Invited user already has an organization"),
        )
    # check if user has already been invited
    existing_invitation = await crud_invitation.query_by_payload_attribute(
        db=db,
        type=InvitationType.organization,
        key="user_email",
        value=payload.user_email,
    )
    if existing_invitation and len(existing_invitation) > 0:
        if (
            existing_invitation[0].status == InvitationStatusEnum.pending
            or existing_invitation[0].status == InvitationStatusEnum.accepted
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_("User has already been invited"),
            )

    # check if organization organization has enough seats
    crud_organization.check_seats_quota(role=payload.role, organization=organization)

    # An invitee who has used GOAT has a Keycloak account. For anyone else,
    # create one before storing the invitation, so a failure leaves nothing
    # half done.
    created_keycloak_user_id = None
    if not invited_user:
        try:
            created_keycloak_user_id = await keycloak_deps.create_invited_user(
                payload.user_email
            )
        except KeycloakError:
            logger.warning(
                "keycloak account creation failed for an invitation to %s",
                organization_id,
                exc_info=True,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The account for the invited email can't be created right now.",
            )

    # create invitation in db
    new_invitation = Invitation(
        send_by=user_id,
        send_to=invited_user[0].id if invited_user else None,
        expires=payload.expires,
        organization_id=organization_id,
        type=InvitationType.organization,
        status=InvitationStatusEnum.pending,
        payload={
            "user_email": payload.user_email,
            "organization_id": organization_id,
            "role": payload.role,
            "name": organization.name,
            "avatar": organization.avatar,
            "region": organization.region,
        },
    )

    invitation = await crud_invitation.create(db=db, obj_in=new_invitation)
    invitation_url = (
        f"{settings.CLIENT_URL}/onboarding/organization/invite/{invitation.id}"
    )
    # The invitee's language when they have an account, else the inviter's.
    lang = await user_language(db, invited_user[0].id if invited_user else user_id)
    with language(lang):
        names = {"organization": organization.name}
        email_content = EmailTemplateContent(
            artwork_url=f"{settings.email_artwork_url}/img/email/organization_invited.png",
            title=_("You have been invited to %(organization)s") % names,
            message=_(
                "You have been invited to work together in %(organization)s on GOAT. Accept the invitation with the button below."
            )
            % names,
            action_url=invitation_url,
            action_label=_("Accept invitation"),
        )
        send_email(
            email_to=payload.user_email,
            subject=_("GOAT - Invitation to %(organization)s") % names,
            environment=email_content.model_dump(),
        )

    account_setup = None
    if created_keycloak_user_id:
        # The invitee lands on the invitation after setting a password.
        sent = await keycloak_deps.send_account_setup_email(
            created_keycloak_user_id, redirect_uri=invitation_url
        )
        account_setup = "email_sent" if sent else "manual"

    return InvitationOrgCreateRead(
        **invitation.model_dump(), account_setup=account_setup
    )


@router.patch(
    "/{organization_id}/invitations/{invitation_id}",
    summary="Update an organization invitation",
    response_model=Invitation,
    dependencies=[Depends(auth_z)],
)
async def update_organization_invitation(
    *,
    db: AsyncSession = Depends(get_db),
    organization_id: str,
    user_token: dict = Depends(user_token),
    invitation_id: str,
    payload: InvitationOrgUpdate = Body(
        ..., examples=[request_examples["organization"]["invite_update"]]
    ),
) -> Any:
    """
    Update an invitation
    """

    invitation = await crud_invitation.get(db=db, id=invitation_id)

    if (
        not invitation
        or invitation.type != InvitationType.organization
        or invitation.status != InvitationStatusEnum.pending
        or invitation.payload["organization_id"] != organization_id
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invitation not found",
        )
    invitation = await crud_invitation.update(db=db, db_obj=invitation, obj_in=payload)
    return invitation


# udpate invitation role
@router.patch(
    "/{organization_id}/invitations/{invitation_id}/role",
    summary="Update an organization invitation role",
    response_model=Invitation,
    dependencies=[Depends(auth_z)],
)
async def update_organization_invitation_role(
    *,
    db: AsyncSession = Depends(get_db),
    organization_id: str,
    user_token: dict = Depends(user_token),
    invitation_id: str,
    role: OrganizationUpdateMemberRole = Body(
        ..., examples=[request_examples["organization"]["update_user_role"]]
    ),
) -> Any:
    """
    Update an invitation role
    """

    invitation = await crud_invitation.get(db=db, id=invitation_id)

    if (
        not invitation
        or invitation.type != InvitationType.organization
        or invitation.status != InvitationStatusEnum.pending
        or invitation.payload["organization_id"] != organization_id
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invitation not found",
        )
    invitation = await crud_organization.update_invitation_role(
        db=db, invitation_id=invitation_id, role=role.role
    )
    return invitation


@router.delete(
    "/{organization_id}/invitations/{invitation_id}",
    summary="Delete an organization invitation",
    dependencies=[Depends(auth_z)],
)
async def delete_organization_invitation(
    *,
    db: AsyncSession = Depends(get_db),
    organization_id: str,
    invitation_id: str,
) -> Any:
    """
    Delete an invitation
    """
    invitation = await crud_invitation.get(db=db, id=invitation_id)

    if (
        not invitation
        or invitation.type != InvitationType.organization
        or invitation.status != InvitationStatusEnum.pending
        or invitation.payload["organization_id"] != organization_id
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invitation not found",
        )
    await crud_invitation.remove(db=db, id=invitation_id)
    return {"message": "Invitation deleted"}
