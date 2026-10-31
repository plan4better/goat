import asyncio
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.crud.crud_organization import SELF_HOSTED_QUOTAS
from core.crud.crud_space import space as crud_space
from core.db.models import Organization, Role, User, UserRoleLink
from core.db.models.folder import Folder
from core.db.session import session_manager


async def seed_default_user_org(session: AsyncSession) -> None:
    """Provision the default identity for deployments running with AUTH=False.

    Creates the default user, its organization (with self-hosted quotas), the
    organization-owner role assignment and a home folder. Idempotent — every
    object is created only if missing, so re-running on each deploy is safe.
    Requires the roles from ``seed_roles`` to be present.
    """
    user_id = UUID(settings.DEFAULT_USER_ID)

    user = (
        await session.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        user = User(
            id=user_id,
            email=settings.DEFAULT_USER_EMAIL,
            firstname=settings.DEFAULT_USER_FIRSTNAME,
            lastname=settings.DEFAULT_USER_LASTNAME,
            avatar=settings.USER_DEFAULT_AVATAR,
        )
        session.add(user)
        await session.flush()

    if user.organization_id is None:
        organization = Organization(
            name=settings.DEFAULT_ORGANIZATION_NAME,
            avatar=settings.ORGANIZATION_DEFAULT_AVATAR,
            on_trial=False,
            total_credits=SELF_HOSTED_QUOTAS["credits"],
            total_storage=SELF_HOSTED_QUOTAS["storage"],
            total_projects=SELF_HOSTED_QUOTAS["projects"],
            total_editors=SELF_HOSTED_QUOTAS["editors"],
            total_viewers=SELF_HOSTED_QUOTAS["viewers"],
            type="other",
            region="EU",
            contact_user_id=user_id,
            suspended=False,
        )
        session.add(organization)
        await session.flush()
        user.organization_id = organization.id

    owner_role_id = (
        await session.execute(select(Role.id).where(Role.name == "organization-owner"))
    ).scalar_one()
    has_owner_role = (
        await session.execute(
            select(UserRoleLink.id).where(
                UserRoleLink.user_id == user_id,
                UserRoleLink.role_id == owner_role_id,
            )
        )
    ).scalar_one_or_none()
    if has_owner_role is None:
        session.add(UserRoleLink(user_id=user_id, role_id=owner_role_id))

    has_home_folder = (
        await session.execute(
            select(Folder.id).where(Folder.user_id == user_id, Folder.name == "home")
        )
    ).scalar_one_or_none()
    if has_home_folder is None:
        space_id = (await crud_space.ensure_personal(session, user_id)).id
        session.add(Folder(user_id=user_id, name="home", space_id=space_id))

    await session.commit()


async def main() -> None:
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as session:
            await seed_default_user_org(session)
    finally:
        await session_manager.close()


if __name__ == "__main__":
    asyncio.run(main())
