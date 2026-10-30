import pytest
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_unlimited_and_fractional_credits(db_session):
    # total_credits NULL == unlimited; used_credits holds fractions
    org = make_organization(total_credits=None, used_credits=0)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    org.used_credits = 13.67  # fractional credits must persist exactly
    await db_session.commit()
    await db_session.refresh(org)

    assert org.total_credits is None
    assert float(org.used_credits) == pytest.approx(13.67)
