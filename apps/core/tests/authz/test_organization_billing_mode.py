"""What an organization starts with: a trial with billing on, the self-hosted
defaults (no trial, unlimited credits) without it."""

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

import pytest
from core.core.config import settings
from core.crud.crud_billing_terms import DEFAULT_TRIAL
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.route_world import API, sweep_client
from tests.billing import enable_billing

S = settings.SCHEMA


async def _create(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
) -> Any:
    user_id = (await make_user(None)).id
    await db_session.commit()
    created = await sweep_client().post(
        f"{API}/organizations",
        headers=auth_on(user_id),
        json={"name": f"Org {user_id}", "type": "government", "region": "EU"},
    )
    assert created.status_code == 200, created.text
    db_session.expire_all()
    return (
        await db_session.execute(
            text(
                f"SELECT on_trial, total_credits, plan_renewal_date "
                f"FROM {S}.organization WHERE id = :id"
            ),
            {"id": created.json()["id"]},
        )
    ).one()


@pytest.mark.asyncio
async def test_self_hosted_organization_has_no_trial_and_no_credit_limit(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    org = await _create(db_session, auth_on, make_user)
    assert org.on_trial is False
    assert org.total_credits is None


@pytest.mark.asyncio
async def test_with_billing_an_organization_starts_a_one_month_trial(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enable_billing(monkeypatch)
    org = await _create(db_session, auth_on, make_user)
    assert org.on_trial is True
    # No terms pushed yet: core's defaults.
    assert float(org.total_credits) == DEFAULT_TRIAL["credits"]
    expected = datetime.now() + timedelta(days=DEFAULT_TRIAL["days"])
    assert abs(org.plan_renewal_date - expected) < timedelta(minutes=5)
