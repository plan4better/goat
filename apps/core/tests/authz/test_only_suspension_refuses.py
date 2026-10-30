"""check_organization refuses a suspended organization only. An ended trial
works until trial_expiry suspends it, and with billing off nothing does, so
the on_trial flag alone never locks an organization out."""

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import find_resource

S = settings.SCHEMA
DOMAINS = "organizations/{organization_id}/domains"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _denial(db: AsyncSession, user_id: UUID, org_id: UUID) -> str:
    """The reason authorization() refuses a read of the organization, "" when it
    lets the caller through."""
    try:
        allowed = (
            await db.execute(
                text(f"SELECT {S}.authorization(:u, :res, :path, 'GET')"),
                {
                    "u": user_id,
                    "res": DOMAINS,
                    "path": f"organizations/{org_id}/domains",
                },
            )
        ).scalar_one()
    except DBAPIError as error:
        await db.rollback()
        return str(error.orig)
    return "" if allowed else "denied"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values, refused",
    [
        ({"on_trial": True, "plan_renewal_date": "past"}, False),
        ({"on_trial": True, "plan_renewal_date": "future"}, False),
        ({"on_trial": True, "plan_renewal_date": None}, False),
        ({"on_trial": False, "plan_renewal_date": "past"}, False),
        ({"on_trial": False, "suspended": True}, True),
        ({"on_trial": True, "plan_renewal_date": "past", "suspended": True}, True),
    ],
)
async def test_only_a_suspended_organization_is_refused(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    values: dict,
    refused: bool,
) -> None:
    await find_resource(db_session, DOMAINS, "GET")
    org = await make_org()
    user = await make_user(org.id)
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": user.id, "r": roles["organization-admin"]},
    )
    renewal = {
        "past": _utc_now() - timedelta(minutes=1),
        "future": _utc_now() + timedelta(days=2),
        None: None,
    }[values.get("plan_renewal_date")]
    org.on_trial = values["on_trial"]
    org.suspended = values.get("suspended", False)
    org.plan_renewal_date = renewal
    await db_session.commit()
    org_id, user_id = org.id, user.id

    denial = await _denial(db_session, user_id, org_id)

    if refused:
        assert "Organization is suspended" in denial
    else:
        assert denial == ""
