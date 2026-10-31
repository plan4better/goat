import calendar
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, func, not_, or_, select, update
from sqlalchemy import delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, load_only
from sqlalchemy.orm.attributes import flag_modified

from core.accounts import report_suspension, report_trial
from core.core.config import settings
from core.crud.base import CRUDBase
from core.crud.crud_billing_terms import trial_terms
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_invitation import invitation as crud_invitations
from core.crud.crud_role import role as crud_role
from core.crud.crud_space import space as crud_space
from core.db.models import Organization, UserRoleLink
from core.db.models._link_model import ContentShortcut, ResourceGrant
from core.db.models.assistant import (
    AssistantConnection,
    AssistantOrganizationSettings,
)
from core.db.models.bundle import Bundle
from core.db.models.folder import Folder
from core.db.models.invitation import Invitation, InvitationStatusEnum
from core.db.models.layer import Layer
from core.db.models.organization import OrganizationRolesEnum
from core.db.models.organization_analytics import OrganizationAnalytics
from core.db.models.organization_domain import OrganizationDomain
from core.db.models.project import Project
from core.db.models.role import Role
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.template import Template
from core.db.models.user import User
from core.db.session import session_manager
from core.deps.keycloak import get_keycloak_user
from core.schemas import OrganizationUpdate
from core.schemas.email import EmailTemplateContent
from core.schemas.entitlement import naive_utc
from core.schemas.organization import (
    OrganizationCreate,
    OrganizationMemberRoleUpdateEnum,
    OrganizationPermanentlyDeleted,
    OrganizationUser,
)
from core.services.s3 import s3_service
from core.utils.email import send_email, user_language
from core.utils.i18n import language
from core.utils.i18n import trans as _
from core.utils.other import decode_base64_file, get_image_extension_from_base64

from .crud_user import user as crud_user

# Quotas applied when no billing is configured (self-hosted deployments).
SELF_HOSTED_QUOTAS = {
    "credits": settings.DEFAULT_QUOTA_CREDITS,
    "storage": settings.DEFAULT_QUOTA_STORAGE_MB,
    "projects": settings.DEFAULT_QUOTA_PROJECTS,
    "editors": settings.DEFAULT_QUOTA_EDITORS,
    "viewers": settings.DEFAULT_QUOTA_VIEWERS,
}


async def trial_quotas(db: AsyncSession) -> tuple[dict, int]:
    """GOAT-managed trial for SaaS signups (billing on): its quotas and length
    in days. No entitlement exists until the billing system converts the
    organization; expiry is enforced by the trial_expiry Windmill task. The
    terms are the billing system's (crud_billing_terms), read per call."""
    terms = await trial_terms(db)
    quotas = {
        "credits": terms["credits"],
        "storage": terms["storage_mb"],
        "projects": terms["projects"],
        "editors": terms["editors"],
        "viewers": terms["viewers"],
    }
    return quotas, terms["days"]


class OrganizationNotDeletableError(Exception):
    """What keeps an organization from being deleted permanently, as
    "<what>: <count>" items (see `delete_permanently`)."""

    def __init__(self, found: list[str]) -> None:
        super().__init__(", ".join(found))


def add_month(moment: datetime) -> datetime:
    """The same day and time one month later (the month's last day when shorter)."""
    month = moment.month % 12 + 1
    year = moment.year + (moment.month == 12)
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def sub_month(moment: datetime) -> datetime:
    """The inverse of add_month: the same day and time one month earlier (the
    month's last day when shorter). A reset date that add_month shortened
    (Jan 31 -> Feb 28) comes back as Jan 28, a few days late at worst."""
    month = (moment.month - 2) % 12 + 1
    year = moment.year - (moment.month == 1)
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


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
        # SaaS (billing on): GOAT-managed trial; the entitlement webhook takes
        # over on conversion. Otherwise self-hosted: no trial.
        saas_mode = settings.billing_enabled
        quotas, trial_days = (
            await trial_quotas(db) if saas_mode else (SELF_HOSTED_QUOTAS, 0)
        )

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
            plan_renewal_date=datetime.now() + timedelta(days=trial_days)
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
        # The owner role replaces any organization role the user still holds.
        await crud_role.remove_organization_roles(db, user.id)
        role = await crud_role.get_by_key(
            db=db, key="name", value=OrganizationRolesEnum.owner
        )
        role = role[0]
        user_role = UserRoleLink(role=role, user=user)
        db.add(user_role)
        await db.commit()
        assert organization.id is not None
        await crud_space.ensure_organization(db, organization.id)

        if settings.accounts_sync_enabled:
            # Odoo's trial campaign sends the welcome and everything after it.
            report_trial(organization, user.id)
            await db.refresh(organization)
            return organization
        if not saas_mode:
            # Self-hosted: no trial, no "free demo" email.
            await db.refresh(organization)
            return organization

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
        # Suspension alone can be undone by an entitlement push; this cannot.
        if organization_obj.deleted_at is None:
            organization_obj.deleted_at = datetime.now(timezone.utc).replace(
                tzinfo=None
            )
        db.add(organization_obj)
        await db.commit()
        # The provider ends its trial too: no more trial mails to its people.
        report_suspension(organization_obj)

        if keycloak_user.get("email"):
            lang = await user_language(db, organization_obj.contact_user_id)
            with language(lang):
                names = {"organization": organization_obj.name}
                email_content = EmailTemplateContent(
                    artwork_url=f"{settings.email_artwork_url}/img/email/organization_suspended.png",
                    title=_("%(organization)s has been deleted") % names,
                    message=_(
                        "The organization and all its projects, layers and teams have been deleted for good."
                    ),
                )
                send_email(
                    email_to=keycloak_user.get("email"),
                    subject=_("GOAT - Organization deleted"),
                    environment=email_content.model_dump(),
                )

        return organization_obj

    async def delete_permanently(
        self, *, organization_id: UUID
    ) -> OrganizationPermanentlyDeleted | None:
        """Remove an organization that holds nothing but the user who set it
        up, and leave that user without an organization, so they can be
        invited. An organization whose last member is gone can be removed
        the same way. None for an unknown organization.

        Refused (`OrganizationNotDeletableError`) unless the organization has
        at most one member and nothing in it: no folder, layer, project,
        bundle, template or shortcut in its space or in the member's personal
        space, trash included, and no teams, pending invitations, custom
        domains or analytics settings. The root folders GOAT creates by
        itself (a live `home` folder without parent) do not count. The
        member keeps their account and personal space.

        Everything runs in one transaction (`session_manager.transaction`):
        the checks under row locks, then the writes, so a failure part way
        leaves the organization as it was. The member's `organization_id` is
        cleared before the organization row goes because that foreign key
        cascades: deleting the organization with the member still in it
        would delete the account. The organization's space with its root
        folder, its past invitations and its credit usage go with the row by
        foreign key; grants, which name their resource and grantee without
        one, and the organization's AI settings and model connections (with
        their stored API keys), which name it without one too, are deleted
        here. Billing is not touched.
        """
        async with session_manager.transaction() as connection:
            organization = (
                await connection.execute(
                    select(Organization.id, Organization.odoo_company_id)
                    .where(Organization.id == organization_id)
                    .with_for_update()
                )
            ).one_or_none()
            if organization is None:
                return None
            member_ids = list(
                (
                    await connection.execute(
                        select(User.id)
                        .where(User.organization_id == organization_id)
                        .with_for_update()
                    )
                )
                .scalars()
                .all()
            )
            team_ids = select(Team.id).where(Team.organization_id == organization_id)
            # The spaces that go with the organization: its own and its teams'.
            removed_space_ids = or_(
                Space.organization_id == organization_id,
                Space.team_id.in_(team_ids),
            )
            space_ids = list(
                (
                    await connection.execute(
                        select(Space.id)
                        .where(or_(removed_space_ids, Space.user_id.in_(member_ids)))
                        .with_for_update()
                    )
                )
                .scalars()
                .all()
            )

            async def count(model: Any, *where: Any) -> int:
                return int(
                    (
                        await connection.execute(
                            select(func.count()).select_from(model).where(*where)
                        )
                    ).scalar_one()
                )

            def in_scope(model: Any) -> Any:
                return or_(model.space_id.in_(space_ids), model.user_id.in_(member_ids))

            found = [f"members: {len(member_ids)}"] if len(member_ids) > 1 else []
            counts = {
                "folders": await count(
                    Folder,
                    in_scope(Folder),
                    not_(
                        and_(
                            Folder.parent_id.is_(None),
                            Folder.name == "home",
                            Folder.deleted_at.is_(None),
                        )
                    ),
                ),
                "layers": await count(Layer, in_scope(Layer)),
                "projects": await count(Project, in_scope(Project)),
                "bundles": await count(Bundle, in_scope(Bundle)),
                "templates": await count(Template, in_scope(Template)),
                "shortcuts": await count(
                    ContentShortcut, ContentShortcut.space_id.in_(space_ids)
                ),
                "teams": await count(Team, Team.organization_id == organization_id),
                "pending invitations": await count(
                    Invitation,
                    Invitation.organization_id == organization_id,
                    Invitation.status == InvitationStatusEnum.pending,
                ),
                "custom domains": await count(
                    OrganizationDomain,
                    OrganizationDomain.organization_id == organization_id,
                ),
                "analytics settings": await count(
                    OrganizationAnalytics,
                    OrganizationAnalytics.organization_id == organization_id,
                ),
            }
            found += [f"{what}: {n}" for what, n in counts.items() if n]
            if found:
                raise OrganizationNotDeletableError(found)

            member_id = member_ids[0] if member_ids else None
            if member_id is not None:
                await connection.execute(
                    update(User)
                    .where(User.id == member_id)
                    .values(organization_id=None)
                )
                await crud_role.remove_organization_roles(connection, member_id)
            # Grants to the organization, and grants on the folders that go
            # with its spaces (with no content left, only their root folders).
            await connection.execute(
                sql_delete(ResourceGrant).where(
                    or_(
                        and_(
                            ResourceGrant.grantee_type == "organization",
                            ResourceGrant.grantee_id == organization_id,
                        ),
                        and_(
                            ResourceGrant.resource_type == "folder",
                            ResourceGrant.resource_id.in_(
                                select(Folder.id).where(
                                    Folder.space_id.in_(
                                        select(Space.id).where(removed_space_ids)
                                    )
                                )
                            ),
                        ),
                    )
                )
            )
            # Settings first: they may name a connection as the active one.
            await connection.execute(
                sql_delete(AssistantOrganizationSettings).where(
                    AssistantOrganizationSettings.organization_id == organization_id
                )
            )
            await connection.execute(
                sql_delete(AssistantConnection).where(
                    AssistantConnection.organization_id == organization_id
                )
            )
            await connection.execute(
                sql_delete(Organization).where(Organization.id == organization_id)
            )
        return OrganizationPermanentlyDeleted(
            id=organization_id,
            user_id=member_id,
            odoo_company_id=organization.odoo_company_id,
        )

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
        # Read before the user is removed: their settings go with them.
        lang = await user_language(db, user.id)
        organization = await self.get(db, id=organization_id)
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

        with language(lang):
            names = {"organization": organization.name if organization else ""}
            email_content = EmailTemplateContent(
                artwork_url=f"{settings.email_artwork_url}/img/email/user_removed_from_organization.png",
                title=_("You have been removed from %(organization)s") % names,
                message=_(
                    "You no longer have access to the projects and data of %(organization)s in GOAT. If you think this is a mistake, contact the administrators of the organization."
                )
                % names,
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

    _CAPACITY = {
        "projects": ("total_projects", "used_projects"),
        "storage": ("total_storage", "used_storage"),
    }

    def check_capacity_quota(
        self, *, organization: Organization, quota: str, incoming: float = 0
    ) -> None:
        """Block when a capacity quota would be exceeded. NULL total = unlimited."""
        total_attr, used_attr = self._CAPACITY[quota]
        total = getattr(organization, total_attr)
        if total is None:
            return
        used = getattr(organization, used_attr) or 0
        if used + incoming > total:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_(f"Organization has reached its {quota} limit"),
            )

    async def get_by_user(self, db: AsyncSession, user_id: UUID) -> Organization | None:
        user = await db.get(User, user_id)
        if user is None or user.organization_id is None:
            return None
        return await db.get(Organization, user.organization_id)

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
    ) -> bool:
        """Apply a billing entitlement (caps + renewal). Zeroes used_credits on renewal.

        Returns whether this push converted a trial into a subscription.

        Provider-agnostic: `entitlement` is a plain dict (validated by
        EntitlementPush at the webhook); absent keys are left as-is.
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
        converted = False
        if "on_trial" in entitlement:
            converted = organization.on_trial and not entitlement["on_trial"]
            organization.on_trial = bool(entitlement["on_trial"])

        def moment(value: datetime | str) -> datetime:
            return naive_utc(
                value if isinstance(value, datetime) else datetime.fromisoformat(value)
            )

        # A repeated renewal (same renewal date, whatever its as_of) must not
        # zero the credits used since the first one.
        repeat = False
        if entitlement.get("plan_renewal_date"):
            renewal = moment(entitlement["plan_renewal_date"])
            repeat = renewal == organization.plan_renewal_date
            organization.plan_renewal_date = renewal
        if entitlement.get("as_of"):
            organization.entitlement_as_of = moment(entitlement["as_of"])
        if (reset_usage and not repeat) or converted:
            organization.used_credits = 0
        # A subscription's credits reset monthly, from its first push on
        # (credit_reset moves the date on); a trial's credits last the trial.
        if not organization.on_trial and (
            converted or organization.credits_reset_at is None
        ):
            organization.credits_reset_at = add_month(datetime.now())
        return converted


organization = CRUDOrganization(Organization)
