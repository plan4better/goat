"""Only owners and admins resend an invitation (B6): the route has its own
seed row with manage-organization-invitation, so the lookup is exact rather
than the `invitations` row's prefix fallback."""

from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import find_resource

S = settings.SCHEMA
PATTERN = "organizations/{organization_id}/invitations/{invitation_id}/resend"


async def _denial(
    db: AsyncSession, user_id: UUID, pattern: str, path: str, method: str
) -> str:
    """Why authorization() refused, or "" when it allowed the request."""
    try:
        await db.execute(
            text(f"SELECT {S}.authorization(:u, :res, :path, :m)"),
            {"u": user_id, "res": pattern, "path": path, "m": method},
        )
    except DBAPIError as error:
        await db.rollback()
        return str(error.orig)
    return ""


@pytest.mark.asyncio
async def test_only_owners_and_admins_may_resend(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    await find_resource(db_session, PATTERN, "POST")  # its own row, not the fallback
    org = await make_org()
    users: dict[str, UUID] = {}
    for name in ("owner", "admin", "editor", "viewer"):
        user = await make_user(org.id)
        await db_session.execute(
            text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
            {"u": user.id, "r": roles[f"organization-{name}"]},
        )
        users[name] = user.id
    await db_session.commit()

    path = f"organizations/{org.id}/invitations/{uuid4()}/resend"
    for name in ("editor", "viewer"):
        reason = await _denial(db_session, users[name], PATTERN, path, "POST")
        assert "User does not have the needed permissions" in reason, name
    for name in ("owner", "admin"):
        assert await _denial(db_session, users[name], PATTERN, path, "POST") == "", name
