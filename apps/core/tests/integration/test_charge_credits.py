import uuid

import pytest
from core.core.config import settings
from core.db.models.credit_rate import CreditRate
from core.db.models.user import User
from core.db.sql.init_triggers import init_triggers
from sqlalchemy import text
from tests.utils import make_organization

_S = settings.SCHEMA


async def _seed_rates(db_session):
    # Production seeds these in the migration; tests build tables via create_all,
    # so insert the two rate rows directly. Idempotent — the session-scoped test
    # DB persists rows across tests and category is the PK.
    from sqlalchemy import select

    existing = {
        c for (c,) in (await db_session.execute(select(CreditRate.category))).all()
    }
    for cat, basis, rate in [("compute", "minute", 10), ("egress", "GB", 20)]:
        if cat not in existing:
            db_session.add(
                CreditRate(category=cat, unit_basis=basis, rate=rate, source="default")
            )
    await db_session.commit()


async def _setup(db_session):
    await init_triggers()  # installs charge_credits (+ existing fns)
    await _seed_rates(db_session)
    org = make_organization(total_credits=5000, used_credits=0)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex}@t.local",
        firstname="T",
        lastname="U",
        organization_id=org.id,
    )
    db_session.add(user)
    await db_session.commit()
    return org, user


@pytest.mark.asyncio
async def test_compute_charge_increments_used_credits(db_session):
    org, user = await _setup(db_session)
    # 90 seconds of compute at 10 cr/min => 15.0 credits
    row_id = (
        await db_session.execute(
            text(f"SELECT {_S}.charge_credits(:o, :u, :a, :c, :unit, :p)"),
            {
                "o": str(org.id),
                "u": str(user.id),
                "a": "catchment_area_pt",
                "c": "compute",
                "unit": 90,
                "p": "{}",
            },
        )
    ).scalar_one()
    await db_session.commit()

    cost = (
        await db_session.execute(
            text(f"SELECT cost, unit_type, rate FROM {_S}.credit_usage WHERE id = :i"),
            {"i": row_id},
        )
    ).one()
    assert float(cost.cost) == pytest.approx(15.0)
    assert cost.unit_type == "seconds"
    assert float(cost.rate) == 10.0

    used = (
        await db_session.execute(
            text(f"SELECT used_credits FROM {_S}.organization WHERE id = :i"),
            {"i": str(org.id)},
        )
    ).scalar_one()
    assert float(used) == pytest.approx(15.0)


@pytest.mark.asyncio
async def test_egress_charge_uses_gb_basis(db_session):
    org, user = await _setup(db_session)
    # 1 GB (decimal) at 20 cr/GB => 20.0 credits; egress has no user (NULL)
    row_id = (
        await db_session.execute(
            text(f"SELECT {_S}.charge_credits(:o, NULL, :a, :c, :unit, :p)"),
            {
                "o": str(org.id),
                "a": "egress",
                "c": "egress",
                "unit": 1000000000,
                "p": "{}",
            },
        )
    ).scalar_one()
    await db_session.commit()
    cost = (
        await db_session.execute(
            text(f"SELECT cost, unit_type FROM {_S}.credit_usage WHERE id = :i"),
            {"i": row_id},
        )
    ).one()
    assert float(cost.cost) == pytest.approx(20.0)
    assert cost.unit_type == "bytes"


@pytest.mark.asyncio
async def test_unlimited_org_still_records(db_session):
    await init_triggers()
    await _seed_rates(db_session)
    org = make_organization(total_credits=None, used_credits=0)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex}@t.local",
        firstname="T",
        lastname="U",
        organization_id=org.id,
    )
    db_session.add(user)
    await db_session.commit()

    await db_session.execute(
        text(f"SELECT {_S}.charge_credits(:o, :u, :a, :c, :unit, :p)"),
        {
            "o": str(org.id),
            "u": str(user.id),
            "a": "buffer",
            "c": "compute",
            "unit": 60,
            "p": "{}",
        },
    )
    await db_session.commit()
    used = (
        await db_session.execute(
            text(f"SELECT used_credits FROM {_S}.organization WHERE id = :i"),
            {"i": str(org.id)},
        )
    ).scalar_one()
    # unlimited (total NULL) still tracks usage for transparency
    assert float(used) == pytest.approx(10.0)
