"""customer.credits_exhausted: the one rule for "out of credits", shared by the
balance, processes' credit gate and traffic_rollup's download flag."""

from uuid import uuid4

import pytest
from core.core.config import settings
from sqlalchemy import text
from tests.utils import make_organization


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "used, total, exhausted",
    [
        (100, 100, True),  # used up exactly
        (120, 100, True),  # booked past the budget
        (99, 100, False),
        (10_000, None, False),  # unlimited is never exhausted
    ],
)
async def test_credits_are_exhausted_once_used_reaches_the_total(
    db_session, used, total, exhausted
):
    org = make_organization(used_credits=used, total_credits=total)
    db_session.add(org)
    await db_session.commit()

    result = await db_session.scalar(
        text(f"SELECT {settings.SCHEMA}.credits_exhausted(:org)"), {"org": org.id}
    )
    assert result is exhausted


@pytest.mark.asyncio
async def test_an_unknown_organization_is_null(db_session):
    result = await db_session.scalar(
        text(f"SELECT {settings.SCHEMA}.credits_exhausted(:org)"), {"org": uuid4()}
    )
    assert result is None
