"""A member's organization role changes in one statement.

Core's engine commits every statement on its own, so the old delete of the
`user_role` link followed by an insert of the new one let two admins who
changed the same member at once both insert: the member ended with two
organization roles. One UPDATE of the link leaves exactly one, the last
writer's, and a member whose link is gone by then is refused as a member
without a role.
"""

import asyncio
from datetime import datetime
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_organization import organization as crud_org
from core.db.models.organization import Organization
from core.db.models.user import User
from core.endpoints.deps import session_manager
from core.schemas.organization import OrganizationMemberRoleUpdateEnum
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import give_org_role, make_organization, seeded_roles

S = settings.SCHEMA
ADMIN = OrganizationMemberRoleUpdateEnum.admin
VIEWER = OrganizationMemberRoleUpdateEnum.viewer


async def _org_roles(db: AsyncSession, user_id: UUID) -> list[str]:
    rows = await db.execute(
        text(
            f"SELECT r.name FROM {S}.user_role ur JOIN {S}.role r ON r.id = ur.role_id "
            "WHERE ur.user_id = :u AND r.name LIKE 'organization-%' ORDER BY r.name"
        ),
        {"u": user_id},
    )
    return list(rows.scalars())


async def _editor(db_session: AsyncSession) -> tuple[Organization, User]:
    """An organization with one editor and free seats of every kind."""
    roles = await seeded_roles(db_session)
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()
    member = User(
        id=uuid4(),
        email=f"role-{uuid4().hex[:8]}@goat.test",
        firstname="Emil",
        lastname="Editor",
        avatar="",
        organization_id=org.id,
        created_at=datetime(2025, 6, 7, 10, 15),
    )
    db_session.add(member)
    await db_session.commit()
    await give_org_role(db_session, member.id, roles["organization-editor"])
    return org, member


@pytest.mark.asyncio
async def test_two_role_changes_at_the_same_moment_leave_one_organization_role(
    db_session: AsyncSession,
) -> None:
    """A second change that starts while the first is still writing waits for
    it and then writes the same link, so the member keeps exactly one
    organization role (the last writer's), never two."""
    org, member = await _editor(db_session)
    change = {"organization_id": str(org.id), "user_id": str(member.id)}

    async with session_manager.session() as second_db:
        second_pid = (await second_db.execute(text("SELECT pg_backend_pid()"))).scalar()
        async with session_manager.transaction() as connection:
            # The first change, to admin, through the same code, not committed
            # yet: the session joins the open transaction, so neither its
            # commit nor its close ends it.
            async with AsyncSession(
                bind=connection, expire_on_commit=False
            ) as first_db:
                await crud_org.update_user_role(db=first_db, **change, role=ADMIN)
            second = asyncio.create_task(
                crud_org.update_user_role(db=second_db, **change, role=VIEWER)
            )
            for _ in range(200):
                waiting = (
                    await db_session.execute(
                        text(
                            "SELECT wait_event_type FROM pg_stat_activity "
                            "WHERE pid = :pid"
                        ),
                        {"pid": second_pid},
                    )
                ).scalar()
                if waiting == "Lock":
                    break
                await asyncio.sleep(0.05)
            else:
                pytest.fail("the second change never waited for the first")
        # The first change commits as its block ends; the second goes on.
        answer = await asyncio.wait_for(second, timeout=10)

    assert answer.roles == [VIEWER]
    assert await _org_roles(db_session, member.id) == ["organization-viewer"]


@pytest.mark.asyncio
async def test_a_member_whose_role_is_gone_by_the_write_is_refused(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The member loses their link (removed by another admin) after their role
    was read and before the write: the change is refused as for a member
    without a role, and no role comes back."""
    org, member = await _editor(db_session)
    read_organization = crud_org.get

    async def read_then_lose_the_link(*args, **kwargs):
        # Runs after the member and their role were read.
        found = await read_organization(*args, **kwargs)
        await db_session.execute(
            text(f"DELETE FROM {S}.user_role WHERE user_id = :u"), {"u": member.id}
        )
        await db_session.commit()
        return found

    monkeypatch.setattr(crud_org, "get", read_then_lose_the_link)
    async with session_manager.session() as db:
        with pytest.raises(
            Exception, match="User is not part of the organization or has no role"
        ):
            await crud_org.update_user_role(
                db=db,
                organization_id=str(org.id),
                user_id=str(member.id),
                role=VIEWER,
            )

    assert await _org_roles(db_session, member.id) == []


@pytest.mark.asyncio
async def test_a_member_left_with_two_organization_roles_ends_with_one(
    db_session: AsyncSession,
) -> None:
    """The old delete-then-insert could leave two links; the next change keeps
    one and changes it, as the old code did, instead of breaking the unique
    index on user and role."""
    roles = await seeded_roles(db_session)
    org, member = await _editor(db_session)
    await give_org_role(db_session, member.id, roles["organization-viewer"])
    assert await _org_roles(db_session, member.id) == [
        "organization-editor",
        "organization-viewer",
    ]
    async with session_manager.session() as db:
        answer = await crud_org.update_user_role(
            db=db, organization_id=str(org.id), user_id=str(member.id), role=ADMIN
        )
    assert answer.roles == [ADMIN]
    assert await _org_roles(db_session, member.id) == ["organization-admin"]
