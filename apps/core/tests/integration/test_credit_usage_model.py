import pytest
from core.db.models.credit_usage import CreditUsage
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_credit_usage_row_with_categories(db_session):
    org = make_organization()
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    row = CreditUsage(
        organization_id=org.id,
        user_id=None,  # egress rollups have no user
        category="egress",
        action="egress",
        unit=398458880,  # bytes
        unit_type="bytes",
        rate=20,
        cost=7.42,
        payload={"layer_id": "abc"},
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.id is not None
    assert row.user_id is None
    assert float(row.cost) == pytest.approx(7.42)
