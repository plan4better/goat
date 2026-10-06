from datetime import datetime, timedelta
from typing import Any, List, Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, load_only
from sqlalchemy.orm.attributes import flag_modified

from core.core.config import settings
from core.crud.base import CRUDBase
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_invitation import invitation as crud_invitations
from core.crud.crud_role import role as crud_role
from core.crud.crud_space import space as crud_space
from core.db.models import Organization, UserRoleLink
from core.db.models._link_model import ResourceGrant
from core.db.models.bundle import Bundle
from core.db.models.folder import Folder
from core.db.models.invitation import Invitation, InvitationStatusEnum
from core.db.models.layer import Layer
from core.db.models.organization import OrganizationRolesEnum
from core.db.models.project import Project
from core.db.models.role import Role
from core.db.models.space import Space, SpaceKind
from core.db.models.template import Template
from core.db.models.user import User
from core.deps.keycloak import get_keycloak_user
from core.schemas import OrganizationUpdate
from core.schemas.email import EmailTemplateContent
from core.schemas.organization import (
    OrganizationCreate,
    OrganizationMemberRoleUpdateEnum,
    OrganizationUser,
)
from core.services.s3 import s3_service
from core.utils.email import send_email
from core.utils.i18n import trans as _
from core.utils.other import decode_base64_file, get_image_extension_from_base64

from .crud_user import user as crud_user

# Quotas applied when no billing is configured (self-hosted deployments).
SELF_HOSTED_QUOTAS = {
    "credits": 1000000,
    "storage": settings.DEFAULT_QUOTA_STORAGE_MB,
    "projects": settings.DEFAULT_QUOTA_PROJECTS,
    "editors": settings.DEFAULT_QUOTA_EDITORS,
    "viewers": settings.DEFAULT_QUOTA_VIEWERS,
}

# GOAT-managed trial for SaaS signups (Odoo billing mode): no billing record
# exists until sales converts the org; expiry is enforced by the trial_expiry
# Windmill task. See docs/odoo-entitlement-contract.md.
TRIAL_QUOTAS = {
    "credits": None,
    "storage": settings.TRIAL_QUOTA_STORAGE_MB,
    "projects": settings.TRIAL_QUOTA_PROJECTS,
    "editors": settings.TRIAL_QUOTA_EDITORS,
    "viewers": settings.TRIAL_QUOTA_VIEWERS,
}


class CRUDOrganization(CRUDBase[Organization, OrganizationCreate, OrganizationUpdate]):
    async def create_organization(
        self,
        *,
        organization_obj: OrganizationCreate,
        user_id: str,
        db: AsyncSession,
        is_superuser: bool = False,
    ) -> Organization:
        # Create user
        user = await crud_user.create_if_not_exists(user_id=user_id, db_session=db)
        # SaaS (ODOO_WEBHOOK_SECRET set): GOAT-managed trial; the entitlement
        # webhook takes over on conversion. Otherwise self-hosted: no trial.
        saas_mode = bool(settings.ODOO_WEBHOOK_SECRET)
        quotas = TRIAL_QUOTAS if saas_mode else SELF_HOSTED_QUOTAS

        # Create organization
        organization = Organization(
            name=organization_obj.name,
            avatar=organization_obj.avatar or settings.ORGANIZATION_DEFAULT_AVATAR,
            on_trial=saas_mode,
            total_credits=quotas.get("credits"),
            total_storage=quotas.get("storage"),
            total_projects=quotas.get("projects"),
            total_editors=quotas.get("editors"),
            total_viewers=quotas.get("viewers"),
            extras=[] if saas_mode else None,
            plan_renewal_date=datetime.now() + timedelta(days=settings.TRIAL_DAYS)
            if saas_mode
            else None,
            type=organization_obj.type,
            region=organization_obj.region,
            contact_user_id=user_id,
            suspended=False,
            users=[user],
            newsletter_subscribe=organization_obj.newsletter_subscribe,
        )
        # Subscribe to newsletter if user has opted in during registration
        if not is_superuser and organization_obj.newsletter_subscribe:
            user.newsletter_subscribe = True

        user.organization = organization
        db.add(organization)
        db.add(user)
        # Add Roles to the user as organization owner
        role = await crud_role.get_by_key(
            db=db, key="name", value=OrganizationRolesEnum.owner
        )
        role = role[0]
        user_role = UserRoleLink(role=role, user=user)
        db.add(user_role)
        await db.commit()
        assert organization.id is not None
        await crud_space.ensure_organization(db, organization.id)

        # Send email
        email_content = EmailTemplateContent(
            artwork_url=f"{settings.email_artwork_url}/img/email/account_trial_started.png",
            title=_("Thank you for signing up for the free demo!"),
            message=_(
                "We are delighted that you are becoming part of the GOAT community! During your trial period, you will have full access to the GOAT platform"
            ),
        )
        send_email(
            email_to=user.email,
            subject=_("Welcome to GOAT!"),
            environment=email_content.model_dump(),
        )
        await db.refresh(organization)
        return organization

    async def delete_organization(
        self,
        *,
        organization_obj: Organization,
        db: AsyncSession,
    ) -> Any:
        # send email that organization has been deleted.
        # todo: send email also to all members
        keycloak_user = await get_keycloak_user(organization_obj.contact_user_id)
        organization_obj.suspended = True
        db.add(organization_obj)
        await db.commit()

        if keycloak_user.get("email"):
            email_content = EmailTemplateContent(
                artwork_url=f"{settings.email_artwork_url}/img/email/organization_suspended.png",
                title=_("Organization has been deleted"),
                message=_("Your organization has been deleted."),
            )
            send_email(
                email_to=keycloak_user.get("email"),
                subject="GOAT - Organization deleted",
                environment=email_content.model_dump(),
            )

        return organization_obj

    async def update_organization_profile(
        self,
        *,
        db_obj: Organization,
        organization_obj: OrganizationUpdate,
        db: AsyncSession,
    ) -> Any:
        if organization_obj.avatar and organization_obj.avatar.startswith("data:image"):
            extension = get_image_extension_from_base64(organization_obj.avatar)
            now = datetime.now()
            timestamp_str = now.strftime("%Y%m%d%H%M%S")
            file_name = f"avatar_org_{db_obj.id}_T{timestamp_str}.{extension}"
            file = decode_base64_file(organization_obj.avatar)
            s3_service.upload_asset(
                file,
                f"img/users/{settings.ENVIRONMENT}/{file_name}",
                f"image/{extension}",
            )
            organization_obj.avatar = (
                f"{settings.ASSETS_URL}/img/users/{settings.ENVIRONMENT}/{file_name}"
            )
        updated_organization = await self.update(
            db=db, db_obj=db_obj, obj_in=organization_obj
        )
        return updated_organization

    async def get_users(
        self,
        *,
        db: AsyncSession,
        organization_id: str,
        include_invitations: Optional[bool] = False,
    ) -> List[User]:
        query = (
            select(User)
            .where(User.organization_id == organization_id)
            .options(
                joinedload(User.role_links).options(
                    load_only(UserRoleLink.id),
                    joinedload(UserRoleLink.role).options(
                        load_only(Role.name, Role.resource_type)
                    ),
                )
            )
        )

        result = await db.execute(query)
        users: List[User] = result.unique().scalars().all()
        members: List[OrganizationUser] = []
        for user in users:
            role_links = user.role_links
            roles = []
            user_dict = user.model_dump()
            for role_link in role_links:
                role = role_link.role.name
                roles.append(role)
            user_dict["roles"] = roles
            user_dict["invitation_status"] = InvitationStatusEnum.accepted
            member = OrganizationUser(**user_dict)
            members.append(member)

        if include_invitations:
            invitation_query = select(Invitation).where(
                Invitation.organization_id == organization_id
            )
            invitation_result = await db.execute(invitation_query)
            invitations: List[Invitation] = invitation_result.unique().scalars().all()
            for invitation in invitations:
                # check if invitation is accepted. If it is, we don't need to include it in the list as it is already a user
                if invitation.status == InvitationStatusEnum.pending:
                    member = OrganizationUser(
                        id=invitation.id,
                        firstname="",
                        lastname="",
                        email=invitation.payload["user_email"],
                        roles=[invitation.payload["role"]],
                        invitation_status=invitation.status,
                        avatar="",
                    )
                    members.append(member)

        return members

    async def _personal_space_id(self, db: AsyncSession, user_id: Any) -> UUID | None:
        return (
            await db.execute(
                select(Space.id).where(
                    Space.kind == SpaceKind.personal, Space.user_id == user_id
                )
            )
        ).scalar_one_or_none()

    async def _owned_content_count(self, db: AsyncSession, user_id: str) -> int:
        """Content that blocks removal without `reassign_to`.

        Scoped to the leaver's PERSONAL space only (D5): content in a team or
        organisation space survives the leaver and needs no heir, so it must
        never force `reassign_to`. Folders are excluded: every user is seeded
        a `home` folder, so counting folders would make removal always require
        `reassign_to`. A non-empty folder is still covered here through the
        layers/projects it holds; an empty folder cascade-deletes with its
        owner, which is acceptable.

        Templates count like any other content: `template.space_id` is ON
        DELETE CASCADE, so a leaver whose only content is templates would
        otherwise pass this guard and have them destroyed with their
        personal space.
        """
        personal_space_id = await self._personal_space_id(db, user_id)
        if personal_space_id is None:
            return 0
        total = 0
        for model in (Layer, Project, Bundle, Template):
            total += int(
                (
                    await db.execute(
                        select(func.count())
                        .select_from(model)
                        .where(
                            model.user_id == user_id,
                            model.space_id == personal_space_id,
                        )
                    )
                ).scalar_one()
            )
        return total

    async def _reassign_content(
        self, db: AsyncSession, *, from_user: Any, to_user_id: str
    ) -> None:
        """Hand the leaver's PERSONAL-space folders, layers, projects,
        bundles and templates to `to_user_id`'s personal space (D5:
        team/organisation-space content is untouched — it survives the leaver
        and needs no heir).

        Every folder in the leaver's personal space moves, not only the ones
        they created: a space root carries `user_id IS NULL` by design
        (`crud_space.ensure_root_folder`), and leaving it behind would let the
        personal-space cascade delete a folder the just-reassigned content
        still points at.

        The `home` root is renamed so the receiver keeps exactly one root
        folder called home (four frontend sites identify it by that literal).

        Owner access follows the `user_id` column reassigned below (read
        directly by `effective_role`), so reassigning it is sufficient to hand
        over reachability — there is no separate owner-grant row to move.

        Also moves `space_id` to the heir's personal space: `remove_user`
        deletes the leaver's `User` row right after this call, which cascades
        to their (now-empty) personal `Space`, which in turn cascades to any
        content still pointing at it — leaving `space_id` behind would delete
        the very content just reassigned.
        """
        from_space_id = await self._personal_space_id(db, from_user.id)
        if from_space_id is None:
            return
        to_space_id = (await crud_space.ensure_personal(db, UUID(str(to_user_id)))).id
        await db.execute(
            update(Folder)
            .where(
                Folder.space_id == from_space_id,
                Folder.parent_id.is_(None),
                Folder.name == "home",
            )
            .values(name=f"From {from_user.email}")
        )
        folder_ids = set(
            (
                await db.execute(
                    select(Folder.id).where(Folder.space_id == from_space_id)
                )
            )
            .scalars()
            .all()
        )
        # Every one of the leaver's root folders becomes a root in the
        # heir's personal space — auto-suffix any that would collide with
        # one the heir already has (the "home" root above is already
        # collision-proofed by the rename just above; this also protects
        # against the exotic case of a heir literally owning a folder named
        # "From <leaver email>").
        root_rows = (
            await db.execute(
                select(Folder.id, Folder.name).where(
                    Folder.id.in_(folder_ids), Folder.parent_id.is_(None)
                )
            )
        ).all()
        for root_id, root_name in root_rows:
            deduped = await crud_folder.dedupe_name(
                db,
                space_id=to_space_id,
                parent_id=None,
                name=root_name,
                exclude_id=root_id,
            )
            if deduped != root_name:
                await db.execute(
                    update(Folder).where(Folder.id == root_id).values(name=deduped)
                )
        # Parent-before-child, one UPDATE per depth level: a personal
        # folder tree can be nested (home > work > ...), and
        # `folder_depth_check` fires per row on `UPDATE OF space_id` —a
        # single multi-row UPDATE across the whole tree can process a child
        # before its (also-moving) parent and spuriously fail "parent
        # folder must be in the same space" (see `move_levels`'s docstring).
        for level_ids in await crud_folder.move_levels(db, folder_ids):
            await db.execute(
                update(Folder)
                .where(Folder.id.in_(level_ids))
                .values(user_id=to_user_id, space_id=to_space_id)
            )
        for model in (Layer, Project, Bundle, Template):
            await db.execute(
                update(model)
                .where(model.user_id == from_user.id, model.space_id == from_space_id)
                .values(user_id=to_user_id, space_id=to_space_id)
            )
        await db.execute(
            update(ResourceGrant)
            .where(ResourceGrant.granted_by == from_user.id)
            .values(granted_by=to_user_id)
        )

    async def remove_user(
        self,
        *,
        db: AsyncSession,
        organization_id: str,
        user_id: str,
        reassign_to: str | None = None,
    ) -> Any:
        user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
        if str(user.organization_id) != str(organization_id):
            raise Exception(_("User is not part of the organization"))
        # find organization role of user
        organization_role = None
        for role_link in user.role_links:
            if role_link.role.name in [
                OrganizationRolesEnum.admin,
                OrganizationRolesEnum.editor,
                OrganizationRolesEnum.viewer,
            ]:
                organization_role = role_link.role.name

        if not organization_role:
            raise Exception(_("User is not part of the organization or has no role"))

        owned = await self._owned_content_count(db, user_id)
        if owned:
            if reassign_to is None:
                raise ValueError(
                    _(
                        "User owns content; pass reassign_to (a member of this organization) to hand it over"
                    )
                )
            heir = await crud_user.get(db, id=reassign_to)
            if (
                heir is None
                or str(heir.organization_id) != str(organization_id)
                or str(heir.id) == str(user_id)
            ):
                raise ValueError(
                    _("reassign_to must be another member of the organization")
                )
            await self._reassign_content(db, from_user=user, to_user_id=reassign_to)

        # Grants the leaver RECEIVED have no FK to user (grantee_id is
        # polymorphic — user/team/organization), so they would otherwise
        # survive as orphans pointing at a deleted user. Grants the leaver
        # GAVE (granted_by) are handled separately: the FK there is
        # ON DELETE SET NULL (or re-pointed to the heir above).
        await db.execute(
            sql_delete(ResourceGrant).where(
                ResourceGrant.grantee_type == "user",
                ResourceGrant.grantee_id == UUID(str(user_id)),
            )
        )

        # Team/organisation-space content is untouched by `_reassign_content`
        # above (D5) and so still carries `user_id = <leaver>`. `User.folders`
        # and `User.bundles` are ORM relationships configured
        # cascade="all, delete-orphan" (db/models/user.py) — deleting the
        # `User` object below would make SQLAlchemy load and delete every
        # Folder/Bundle still pointing at it (and, via Folder's own
        # delete-orphan cascade to its layers/bundles, everything inside
        # those folders too), regardless of any DB-level FK. Null `user_id`
        # first, with plain UPDATEs bypassing the ORM relationship, so none
        # of this still-team/org-owned content is in `user.folders` /
        # `user.bundles` by the time the delete cascades.
        for model in (Folder, Layer, Project, Bundle):
            await db.execute(
                update(model).where(model.user_id == user_id).values(user_id=None)
            )

        await crud_user.remove(db=db, id=user_id)

        # delete all invitations for user
        invitations = await crud_invitations.get_multi_by_key(
            db, key="organization_id", value=organization_id
        )
        invitations_ids_to_remove = []
        for invitation in invitations:
            email = invitation.payload.get("user_email")
            if email == user.email or invitation.send_to == user.id:
                invitations_ids_to_remove.append(invitation.id)
        if len(invitations_ids_to_remove) > 0:
            await crud_invitations.remove_multi(db, ids=invitations_ids_to_remove)

        email_content = EmailTemplateContent(
            artwork_url=f"{settings.email_artwork_url}/img/email/user_removed_from_organization.png",
            title=_("You have been removed from the organization"),
            message=_("You have been removed from the organization."),
        )
        send_email(
            email_to=user.email,
            subject=_("GOAT - Removed from organization"),
            environment=email_content.model_dump(),
        )

        return user

    async def update_user_role(
        self,
        *,
        db: AsyncSession,
        organization_id: str,
        user_id: str,
        role: OrganizationMemberRoleUpdateEnum,
    ) -> Any:
        user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
        allowed_org_roles = [
            OrganizationMemberRoleUpdateEnum.admin.value,
            OrganizationMemberRoleUpdateEnum.editor.value,
            OrganizationMemberRoleUpdateEnum.viewer.value,
        ]
        if str(user.organization_id) != organization_id:
            raise Exception(_("User is not part of the organization"))
        organization_obj = await self.get(db, id=organization_id)
        # find organization role of user
        organization_role = None
        for role_link in user.role_links:
            if role_link.role.name in allowed_org_roles:
                organization_role = role_link.role.name

        if not organization_role:
            raise Exception(_("User is not part of the organization or has no role"))

        # check if user has the role
        if role not in allowed_org_roles:
            raise Exception(_("Invalid role"))
        if role == organization_role:
            return user

        # check if organization has enough seats
        self.check_seats_quota(role=role, organization=organization_obj)
        for role_link in user.role_links:
            if role_link.role.name in allowed_org_roles:
                await db.delete(role_link)

        # add user to new role
        role_obj = await crud_role.get_by_key(db=db, key="name", value=role)
        role_obj = role_obj[0]
        user_role = UserRoleLink(role=role_obj, user=user)

        db.add(user_role)

        await db.commit()
        organization_user = OrganizationUser(
            **user.model_dump(),
            roles=[role],
            invitation_status=InvitationStatusEnum.accepted,
        )
        return organization_user

    async def update_invitation_role(
        self,
        *,
        db: AsyncSession,
        invitation_id: str,
        role: OrganizationMemberRoleUpdateEnum,
    ) -> Invitation:
        invitation = await crud_invitations.get(db=db, id=invitation_id)
        allowed_org_roles = [
            OrganizationMemberRoleUpdateEnum.admin.value,
            OrganizationMemberRoleUpdateEnum.editor.value,
            OrganizationMemberRoleUpdateEnum.viewer.value,
        ]
        organization_role = invitation.payload.get("role")
        organization_id = invitation.organization_id
        if organization_role not in allowed_org_roles:
            raise Exception(_("Invalid role"))
        if role == organization_role:
            return invitation

        organization_obj = await self.get(db, id=organization_id)
        # check if organization has enough seats
        self.check_seats_quota(role=role, organization=organization_obj)
        invitation.payload["role"] = role.value
        flag_modified(invitation, "payload")
        await db.commit()
        return invitation

    def check_seats_quota(
        self, *, role: OrganizationRolesEnum, organization: Organization
    ) -> None:
        role_limits = {
            OrganizationRolesEnum.viewer: (
                "total_viewers",
                "used_viewers",
                "viewers",
            ),
            OrganizationRolesEnum.editor: (
                "total_editors",
                "used_editors",
                "editors",
            ),
            OrganizationRolesEnum.admin: (
                "total_editors",
                "used_editors",
                "editors",
            ),
        }

        if role in role_limits:
            total_attr, used_attr, role_name = role_limits[role]
            total = getattr(organization, total_attr)
            if total is not None and total <= getattr(organization, used_attr):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=_(f"Organization has reached the limit of {role_name}"),
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_("Invalid role"),
            )

    _ENTITLEMENT_CAPS = (
        "total_credits",
        "total_storage",
        "total_projects",
        "total_editors",
        "total_viewers",
    )

    def apply_entitlement(
        self,
        *,
        organization: Organization,
        entitlement: dict,
        reset_usage: bool = True,
    ) -> None:
        """Apply a billing entitlement (caps + renewal). Zeroes used_credits on renewal.

        Provider-agnostic: `entitlement` is a plain dict; absent keys are left as-is.
        """
        for cap in self._ENTITLEMENT_CAPS:
            if cap in entitlement:
                setattr(organization, cap, entitlement[cap])
        if "extras" in entitlement:
            extras = entitlement["extras"]
            organization.extras = (
                [str(e) for e in extras] if extras is not None else None
            )
        if "suspended" in entitlement:
            organization.suspended = bool(entitlement["suspended"])
        if "on_trial" in entitlement:
            organization.on_trial = bool(entitlement["on_trial"])
        renewal = entitlement.get("plan_renewal_date")
        if renewal:
            organization.plan_renewal_date = (
                renewal
                if isinstance(renewal, datetime)
                else datetime.fromisoformat(renewal)
            )
        if reset_usage:
            organization.used_credits = 0


organization = CRUDOrganization(Organization)
