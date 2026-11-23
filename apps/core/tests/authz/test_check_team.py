import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from uuid import UUID

import pytest
from core.db.models._link_model import (
    ResourcePermissionLink,  # type: ignore[import-untyped]
)
from core.db.models.permission import Permission  # type: ignore[import-untyped]
from core.db.models.resource import Resource  # type: ignore[import-untyped]
from core.db.models.team import Team  # type: ignore[import-untyped]
from core.db.models.user import User  # type: ignore[import-untyped]
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import call_check_team

AUTHZ_DIR = Path(__file__).resolve().parents[2] / "src/core/db/sql/functions/authz"


def test_authorization_sql_passes_three_arguments_to_check_team() -> None:
    body = (AUTHZ_DIR / "authorization.sql").read_text()
    call = re.search(r"check_team\(([^)]*)\)", body)
    assert call is not None
    assert len([a for a in call.group(1).split(",") if a.strip()]) == 3, call.group(0)


@pytest.mark.asyncio
async def test_check_team_accepts_member_and_rejects_stranger(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
) -> None:
    member = await make_user()
    stranger = await make_user()
    team = await make_team(member)
    # a resource whose permission maps to team-member ('read-team')
    resource = Resource(url_pattern="__probe/teams/{team_id}", method=["GET"])
    db_session.add(resource)
    await db_session.flush()
    perm_id = (
        await db_session.execute(
            select(Permission.id).where(Permission.slug == "read-team")
        )
    ).scalar_one()
    db_session.add(
        ResourcePermissionLink(resource_id=resource.id, permission_id=perm_id)
    )
    await db_session.flush()

    assert await call_check_team(
        db_session, user_id=member.id, team_ids=[team.id], resource_id=resource.id
    )
    assert not await call_check_team(
        db_session, user_id=stranger.id, team_ids=[team.id], resource_id=resource.id
    )
