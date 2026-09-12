"""``PATCH /teams/{team_id}/profile`` is gated like the other team writes.

The route is how a team is renamed. The resource table had no entry for it,
so ``check_resource`` found nothing to match and every rename came back 401
whatever the caller's role -- the organisation profile route next to it had
its entry all along.
"""

from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import _call, find_resource

S = settings.SCHEMA
PATTERN = "teams/{team_id}/profile"


async def _authorized(db: AsyncSession, user_id: UUID, path: str) -> bool:
    return await _call(
        db,
        f"SELECT {S}.authorization(:u, :res, :path, 'PATCH')",
        {"u": user_id, "res": PATTERN, "path": path},
    )


async def _user_with_role(
    db: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    org: Organization,
    role_id: UUID,
) -> User:
    user = await make_user(org.id)
    await db.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": user.id, "r": role_id},
    )
    return user


@pytest.mark.asyncio
async def test_team_profile_update_is_reachable_for_a_team_writer(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    await find_resource(db_session, PATTERN, "PATCH")

    org = await make_org()
    editor = await _user_with_role(
        db_session, make_user, org, roles["organization-editor"]
    )
    viewer = await _user_with_role(
        db_session, make_user, org, roles["organization-viewer"]
    )
    await db_session.commit()
    path = f"teams/{uuid4()}/profile"

    assert await _authorized(db_session, editor.id, path) is True
    # A viewer reads teams but does not rename them: read-team only.
    assert await _authorized(db_session, viewer.id, path) is False
