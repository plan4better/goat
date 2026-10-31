"""The billing terms: the trial a new organization starts with and the credit
rates (billing only). The billing system owns them and pushes them
(POST /webhooks/billing/terms); core keeps the last push in
customer.billing_terms and customer.credit_rate.

Until the first push core uses the defaults below, so sign-up never waits for
the billing system. They are a cautious starting point, not anyone's price
list: the billing system's terms replace them as soon as they arrive.
"""

import logging
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.db.models.billing_terms import BillingTerms
from core.schemas.entitlement import BillingTermsPush, naive_utc

DEFAULT_TRIAL: dict[str, Any] = {
    "days": 30,
    "credits": 10000,
    "storage_mb": 5120,
    "projects": 50,
    "editors": 5,
    "viewers": 2,
}
DEFAULT_CREDIT_RATES: dict[str, float] = {"compute": 10, "egress": 20, "ai": 1}
# The unit each category's rate is per; charge_credits.sql converts the native
# unit (seconds, bytes, tokens) by it.
UNIT_BASIS = {"compute": "minute", "egress": "GB", "ai": "1k_tokens"}

logger = logging.getLogger(__name__)


async def trial_terms(db: AsyncSession) -> dict[str, Any]:
    """The trial a new organization starts with: the pushed terms, else the defaults."""
    row = await db.get(BillingTerms, 1)
    if row is None:
        return dict(DEFAULT_TRIAL)
    return {
        "days": row.trial_days,
        "credits": float(row.trial_credits),
        "storage_mb": float(row.trial_storage_mb),
        "projects": row.trial_projects,
        "editors": row.trial_editors,
        "viewers": row.trial_viewers,
    }


async def _write_rates(
    db: AsyncSession, rates: dict[str, float], *, source: str, overwrite: bool
) -> None:
    conflict = (
        "DO UPDATE SET rate = EXCLUDED.rate, unit_basis = EXCLUDED.unit_basis, "
        "source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP "
        f"WHERE ({settings.SCHEMA}.credit_rate.rate, {settings.SCHEMA}.credit_rate.source) "
        "IS DISTINCT FROM (EXCLUDED.rate, EXCLUDED.source)"
        if overwrite
        else "DO NOTHING"
    )
    for category, rate in rates.items():
        await db.execute(
            text(
                f"INSERT INTO {settings.SCHEMA}.credit_rate "
                "(category, rate, unit_basis, source) "
                f"VALUES (:category, :rate, :unit_basis, :source) "
                f"ON CONFLICT (category) {conflict}"
            ),
            {
                "category": category,
                "rate": rate,
                "unit_basis": UNIT_BASIS[category],
                "source": source,
            },
        )


async def seed_default_credit_rates(db: AsyncSession) -> None:
    """At startup with billing on: the default rate for every category that has
    none yet, so metering charges from the first minute. Pushed rates stay."""
    if not settings.billing_enabled:
        return
    await _write_rates(db, DEFAULT_CREDIT_RATES, source="default", overwrite=False)
    await db.commit()
    if await db.get(BillingTerms, 1) is None:
        logger.warning(
            "billing is on but the billing system has not pushed its terms yet "
            "(POST /webhooks/billing/terms): new trials use core's defaults"
        )


async def apply_terms(db: AsyncSession, push: BillingTermsPush) -> bool:
    """Store pushed terms. False when the push is older than the stored one
    (a delayed retry must not undo a newer change). Running trials keep the
    quotas they started with; past charges keep the rate they were made at."""
    # Pushes take turns, also the very first two (a missing row cannot be locked).
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('billing_terms'))"))
    row = (
        await db.execute(
            select(BillingTerms)
            .where(BillingTerms.id == 1)  # type: ignore[arg-type]
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    as_of = naive_utc(push.as_of) if push.as_of is not None else None
    if (
        row is not None
        and as_of is not None
        and row.as_of is not None
        and as_of < row.as_of
    ):
        return False
    values = {
        "trial_days": push.trial.days,
        "trial_credits": push.trial.credits,
        "trial_storage_mb": push.trial.storage_mb,
        "trial_projects": push.trial.projects,
        "trial_editors": push.trial.editors,
        "trial_viewers": push.trial.viewers,
        # A push without a time keeps the stored one: the stale check stays armed.
        "as_of": as_of if as_of is not None else (row.as_of if row else None),
    }
    if row is None:
        db.add(BillingTerms(id=1, **values))
    else:
        for field, value in values.items():
            setattr(row, field, value)
        await db.execute(
            text(
                f"UPDATE {settings.SCHEMA}.billing_terms "
                "SET updated_at = CURRENT_TIMESTAMP WHERE id = 1"
            )
        )
    await _write_rates(
        db, push.credit_rates.model_dump(), source="billing", overwrite=True
    )
    await db.commit()
    return True
