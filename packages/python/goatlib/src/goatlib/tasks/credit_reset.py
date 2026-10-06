"""credit_reset: self-hosted period roll — zero used_credits and advance
plan_renewal_date when the boundary passes. SaaS uses the Odoo webhook instead.
See spec §8."""

from __future__ import annotations

import calendar
import logging
from datetime import datetime

from pydantic import BaseModel, Field

from goatlib.tasks._db import core_dsn, customer_schema

logger = logging.getLogger(__name__)


class CreditResetParams(BaseModel):
    dry_run: bool = Field(default=False)


def should_reset(plan_renewal_date: datetime | None, now: datetime) -> bool:
    return plan_renewal_date is not None and plan_renewal_date <= now


def _add_month(d: datetime) -> datetime:
    month = d.month + 1
    year = d.year + (month - 1) // 12
    month = (month - 1) % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return d.replace(year=year, month=month, day=day)


def advance_renewal(current: datetime, now: datetime) -> datetime:
    d = current
    while d <= now:
        d = _add_month(d)
    return d


async def main(params: CreditResetParams = CreditResetParams()) -> dict:
    """Windmill entry point: roll any org whose renewal boundary has passed."""
    import asyncpg

    schema = customer_schema()
    now = datetime.utcnow()
    core = await asyncpg.connect(dsn=core_dsn(), timeout=10)
    reset = 0
    try:
        rows = await core.fetch(
            f"SELECT id, plan_renewal_date FROM {schema}.organization "
            f"WHERE plan_renewal_date IS NOT NULL AND plan_renewal_date <= $1",
            now,
        )
        for r in rows:
            if params.dry_run:
                reset += 1
                continue
            new_date = advance_renewal(r["plan_renewal_date"], now)
            await core.execute(
                f"UPDATE {schema}.organization "
                f"SET used_credits = 0, plan_renewal_date = $2 WHERE id = $1",
                r["id"],
                new_date,
            )
            reset += 1
    finally:
        await core.close()
    summary = {"reset": reset}
    logger.info("credit_reset: %s", summary)
    return summary
