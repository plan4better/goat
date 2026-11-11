"""Only the organization's owner deletes the organization (decision 3, F1).

`DELETE organizations/{organization_id}` needs `delete-organization`, which
only organization-owner has. Core refuses admins already; this pins it, since
the settings page stops offering the delete to them on the strength of it.
"""

from collections.abc import Awaitable, Callable
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA
NO_PERMISSION = "User does not have the needed permissions"


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
async def test_only_the_owner_may_delete_the_organization(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
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

    pattern, path = "organizations/{organization_id}", f"organizations/{org.id}"
    for name in ("admin", "editor", "viewer"):
        reason = await _denial(db_session, users[name], pattern, path, "DELETE")
        assert NO_PERMISSION in reason, name
    assert await _denial(db_session, users["owner"], pattern, path, "DELETE") == ""
