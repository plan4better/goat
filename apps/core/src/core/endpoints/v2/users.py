import logging
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from fastapi.params import Query
from fastapi_pagination import Page
from fastapi_pagination import Params as PaginationParams
from keycloak.exceptions import KeycloakError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.accounts import report_join
from core.core.config import settings
from core.crud.crud_invitation import invitation as crud_invitation
from core.crud.crud_onboarding import onboarding as crud_onboarding
from core.crud.crud_organization import organization as crud_organization
from core.crud.crud_role import role as crud_role
from core.crud.crud_user import user as crud_user
from core.db.models._link_model import UserRoleLink
from core.db.models.invitation import Invitation, InvitationStatusEnum, InvitationType
from core.db.models.organization import Organization
from core.db.models.user import User
from core.deps.auth import (
    auth,
    auth_z,
    can_create_organization,
    token_is_superuser,
    user_token,
)
from core.deps.keycloak import get_keycloak_user, keycloak_admin
from core.endpoints.deps import get_db, get_user_id
from core.schemas.common import OrderEnum
from core.schemas.onboarding import OnboardingFacts
from core.schemas.organization import FeaturesRead, OrganizationCreationRead
from core.schemas.user import UserProfileUpdate, UserRead, UserUpdate, request_examples
from core.services.s3 import s3_service
from core.utils.other import decode_base64_file, get_image_extension_from_base64

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/organization",
    summary="Get user organization",
    response_model=Organization,
)
async def get_organization(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
) -> Any:
    """
    Get an organization
    """
    # Always the caller: these routes act on one's own account only.
    user_id = user_token["sub"]
    user = await crud_user.get(db=db, id=user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    organization_id = user.organization_id
    organization = await crud_organization.get(db=db, id=organization_id)
    if not organization:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User has no organization",
        )
    return organization


@router.patch(
    "/invitations/{invitation_id}",
    summary="Accept invitation",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def accept_invitation(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    token: str = Depends(auth),
    invitation_id: str,
) -> None:
    invitation = await crud_invitation.get(db=db, id=invitation_id)
    if (
        not invitation
        or invitation.status != InvitationStatusEnum.pending
        # Case-insensitive: legacy invitations may store the email as typed,
        # while Keycloak lowercases the token's email claim.
        or invitation.payload["user_email"].lower()
        != (user_token.get("email") or "").lower()
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found",
        )

    if invitation.type == InvitationType.organization:
        user_id = user_token["sub"]
        user = await crud_user.create_if_not_exists(user_id=user_id, db_session=db)
        organization_obj = await crud_organization.get(
            db=db, id=invitation.payload["organization_id"]
        )
        roles = await crud_role.get_by_key(
            db=db, key="name", value=invitation.payload["role"]
        )
        # Everything is checked before the first write: statements commit one
        # by one, so a later failure would leave the user half moved.
        if organization_obj is None or organization_obj.suspended or not roles:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Invitation not found",
            )
        # A user belongs to one organization. Creating the invitation checks
        # this, but the invitee may have set up an organization of their own
        # since. One conditional update claims the user, so of two
        # invitations accepted at once only one can.
        claimed = (
            await db.execute(
                update(User)
                .where(User.id == user.id, User.organization_id.is_(None))
                .values(organization_id=organization_obj.id)
                .returning(User.id)
            )
        ).scalar_one_or_none()
        if claimed is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="User already has an organization",
            )
        # Any organization role the user still holds would count in the one
        # they join: they get only the role they were invited with.
        await crud_role.remove_organization_roles(db, user.id)
        db.add(UserRoleLink(role=roles[0], user=user))
        await db.commit()
        report_join(user.id, organization_obj, invitation.payload["role"])

    await crud_invitation.update(
        db=db,
        db_obj=invitation,
        obj_in={
            "status": InvitationStatusEnum.accepted,
        },
    )


@router.delete(
    "/invitations/{invitation_id}",
    summary="Decline invitation",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def decline_invitation(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    invitation_id: str,
) -> None:
    """
    Decline invitation
    """
    invitation = await crud_invitation.get(db=db, id=invitation_id)
    if (
        not invitation
        or invitation.status != InvitationStatusEnum.pending
        # Case-insensitive: legacy invitations may store the email as typed,
        # while Keycloak lowercases the token's email claim.
        or invitation.payload["user_email"].lower()
        != (user_token.get("email") or "").lower()
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found",
        )
    await crud_invitation.delete(db=db, id=invitation_id)


@router.get(
    "/invitations",
    summary="Get invitations for the user",
    response_model=Page[Invitation],
)
async def get_invitations(
    *,
    db: AsyncSession = Depends(get_db),
    status: InvitationStatusEnum = InvitationStatusEnum.pending,
    type: InvitationType = None,
    invitation_id: str = Query(None, description="Query by invitation by id"),
    user_token: dict = Depends(user_token),
    page_params: PaginationParams = Depends(),
    search: str = None,
    order_by: str = None,
    order: OrderEnum = None,
) -> Any:
    """
    Get invitations
    """

    # Invitations are keyed by email (they can target users without an account
    # yet); the token's email claim is also what accept/decline validate against.
    # Case-insensitive: legacy invitations may store the email as typed.
    email = (user_token.get("email") or "").lower()
    query = select(crud_invitation.model)
    query = query.where(
        func.lower(crud_invitation.model.payload["user_email"].astext) == email,
    )

    if invitation_id:
        query = query.where(crud_invitation.model.id == invitation_id)

    if type:
        query = query.where(crud_invitation.model.type == type)

    if status:
        query = query.where(crud_invitation.model.status == status)

    invitations = await crud_invitation.get_multi(
        db=db,
        page_params=page_params,
        query=query,
        order_by=order_by,
        order=order,
    )
    return invitations


@router.get(
    "/profile",
    summary="Get user profile",
    response_model=UserRead,
    dependencies=[Depends(auth_z)],
)
async def get_profile(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
) -> Any:
    """
    Get user profile
    """
    # Always the caller: these routes act on one's own account only.
    user_id = user_token["sub"]
    db_user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
    if not db_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    keycloak_user = await get_keycloak_user(user_id)

    roles = []
    for role_link in db_user.role_links:
        roles.append(role_link.role.name)

    user = UserRead(
        **db_user.model_dump(),
        enabled=keycloak_user.get("enabled"),
        topt=keycloak_user.get("totp"),
        roles=roles,
        is_superuser=token_is_superuser(user_token),
    )
    return user


@router.get(
    "/me/onboarding",
    response_model=OnboardingFacts,
    dependencies=[Depends(auth_z)],
)
async def get_onboarding(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> OnboardingFacts:
    """Facts Home derives its stage and checklist from, over every space
    the caller is a member of."""
    return await crud_onboarding.facts(async_session, user_id)


@router.get(
    "/me/features",
    summary="Which SaaS features this installation runs",
    response_model=FeaturesRead,
)
async def get_features(
    user_token: dict = Depends(user_token),
) -> FeaturesRead:
    """Support and billing are separate switches: each is on only when its
    own settings are set. No `auth_z`: also asked before the caller has an
    organization (the trial note on the setup form)."""
    return FeaturesRead(
        support=settings.support_enabled, billing=settings.billing_enabled
    )


@router.get(
    "/me/organization-creation",
    summary="Whether the caller may create an organization",
    response_model=OrganizationCreationRead,
)
async def get_organization_creation(
    user_token: dict = Depends(user_token),
) -> OrganizationCreationRead:
    """A user without an organization gets the setup form when this is true,
    and a page that waits for an invitation when it is false. No `auth_z`:
    the caller has no organization yet."""
    return OrganizationCreationRead(allowed=can_create_organization(user_token))


@router.patch(
    "/profile",
    summary="Update user profile",
    response_model=UserProfileUpdate,
    dependencies=[Depends(auth_z)],
)
async def update_profile(
    *,
    db: AsyncSession = Depends(get_db),
    user: UserProfileUpdate = Body(..., examples=[request_examples["user"]["update"]]),
    user_token: dict = Depends(user_token),
) -> Any:
    """
    Update user profile
    """
    # Always the caller: these routes act on one's own account only.
    user_id = user_token["sub"]
    db_user = await crud_user.get(db=db, id=user_id)
    if not db_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    admin = await keycloak_admin()
    if admin:
        # Only the Keycloak-managed fields that changed: the profile form sends
        # every field on each save, so a picture change with the name as it
        # was must not depend on the service account's write access.
        keycloak_payload = {}
        if user.firstname and user.firstname != db_user.firstname:
            keycloak_payload["firstName"] = user.firstname
        if user.lastname and user.lastname != db_user.lastname:
            keycloak_payload["lastName"] = user.lastname
        if user.email and user.email != db_user.email:
            keycloak_payload["email"] = user.email
            keycloak_payload["emailVerified"] = False
        # A failed write (e.g. the service account lacks manage-users) stops
        # the request before the DB is updated, so name and email never
        # disagree with the identity provider.
        if keycloak_payload:
            try:
                admin.update_user(
                    user_id=user_id,
                    payload=keycloak_payload,
                )
            except KeycloakError:
                logger.warning(
                    "keycloak profile write failed for %s", user_id, exc_info=True
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Name and email can't be changed right now, so nothing was saved. Other changes save when the name and email stay as they are.",
                )
    if user.avatar and user.avatar.startswith("data:image"):
        extension = get_image_extension_from_base64(user.avatar)
        now = datetime.now()
        timestamp_str = now.strftime("%Y%m%d%H%M%S")
        file_name = f"avatar_{user_id}_T{timestamp_str}.{extension}"
        file = decode_base64_file(user.avatar)
        s3_service.upload_asset(
            file,
            f"img/users/{settings.ENVIRONMENT}/{file_name}",
            f"image/{extension}",
        )
        user.avatar = (
            f"{settings.ASSETS_URL}/img/users/{settings.ENVIRONMENT}/{file_name}"
        )
    user_update = UserUpdate(
        **user.model_dump(exclude_unset=True, exclude_none=True),
    )
    updated_user = await crud_user.update(db=db, db_obj=db_user, obj_in=user_update)

    return updated_user


@router.delete(
    "",
    summary="Delete user account",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(auth_z)],
)
async def delete_account(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
) -> None:
    # Always the caller: these routes act on one's own account only.
    user_id = user_token["sub"]
    admin = await keycloak_admin()
    if admin:
        admin.delete_user(user_id)
