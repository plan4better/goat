import pytest
from core.core.config import settings
from core.db.models.user import User
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_balance_reports_over_budget(client, db_session):
    org = make_organization(total_credits=100, used_credits=100)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    # default identity (AUTH=False) — attach it to this org
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="b@t.local",
            firstname="B",
            lastname="T",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
    await db_session.commit()

    resp = await client.get(f"{settings.API_V2_STR}/credits/balance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["used_credits"] == 100.0
    assert body["total_credits"] == 100.0
    assert body["over_budget"] is True


@pytest.mark.asyncio
async def test_balance_unlimited_is_never_over_budget(client, db_session):
    org = make_organization(total_credits=None, used_credits=999999)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="b@t.local",
            firstname="B",
            lastname="T",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
    await db_session.commit()

    resp = await client.get(f"{settings.API_V2_STR}/credits/balance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_credits"] is None
    assert body["over_budget"] is False
