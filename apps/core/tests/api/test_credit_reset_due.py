"""Which organizations credit_reset starts a new credit month for."""

from datetime import datetime, timedelta

import pytest
from core.core.config import settings
from goatlib.tasks.credit_reset import DUE_SQL, advance_renewal
from sqlalchemy import text
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_only_subscriptions_past_their_reset_date_are_due(db_session):
    now = datetime.now()
    due = make_organization(on_trial=False, credits_reset_at=now - timedelta(hours=1))
    later = make_organization(on_trial=False, credits_reset_at=now + timedelta(days=3))
    trial = make_organization(on_trial=True, credits_reset_at=now - timedelta(days=1))
    self_hosted = make_organization(on_trial=False, credits_reset_at=None)
    db_session.add_all([due, later, trial, self_hosted])
    await db_session.commit()

    sql = DUE_SQL.format(schema=settings.SCHEMA).replace("$1", ":now")
    rows = (await db_session.execute(text(sql), {"now": now})).all()
    ids = {r.id for r in rows}
    assert due.id in ids
    assert not ids & {later.id, trial.id, self_hosted.id}


def test_the_next_reset_is_the_first_monthly_boundary_after_now():
    now = datetime(2026, 10, 14, 9, 0)
    assert advance_renewal(datetime(2026, 10, 1), now) == datetime(2026, 11, 1)
    assert advance_renewal(datetime(2026, 8, 31), now) == datetime(2026, 10, 30)
