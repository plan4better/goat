"""Teams are created from Bearbeiter up (decision 5, F2).

`create-team` sits on organization-editor, and through the role inheritance on
admin and owner, never on organization-viewer: a team brings a space for
content, and viewers create no content. Listing teams stays open to everyone.
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
ROLES = ("owner", "admin", "editor", "viewer")


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


async def _one_per_role(
    db: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    org: Organization,
) -> dict[str, UUID]:
    users: dict[str, UUID] = {}
    for name in ROLES:
        user = await make_user(org.id)
        await db.execute(
            text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
            {"u": user.id, "r": roles[f"organization-{name}"]},
        )
        users[name] = user.id
    await db.commit()
    return users


@pytest.mark.asyncio
async def test_viewers_cannot_create_teams_but_everyone_lists_them(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    users = await _one_per_role(db_session, roles, make_user, await make_org())

    assert NO_PERMISSION in await _denial(
        db_session, users["viewer"], "teams", "teams", "POST"
    )
    for name in ("editor", "admin", "owner"):
        assert (
            await _denial(db_session, users[name], "teams", "teams", "POST") == ""
        ), name
    for name in ROLES:
        assert (
            await _denial(db_session, users[name], "teams", "teams", "GET") == ""
        ), name
