"""The billing terms: the trial a new organization starts with, the credit
rates and the AI-credit terms (billing only). The billing system owns them and
pushes them (POST /webhooks/billing/terms); core keeps the last push in
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
    "ai_credits": 100,
}
DEFAULT_CREDIT_RATES: dict[str, float] = {"compute": 10, "egress": 20}
# The unit each category's rate is per; charge_credits.sql converts the native
# unit (seconds, bytes) by it.
UNIT_BASIS = {"compute": "minute", "egress": "GB"}
# A subscription's monthly AI credits per editor seat.
DEFAULT_AI_CREDITS_PER_EDITOR: float = 200
# The AI credits of an answer by its steps: the first tier whose max_steps is
# None or at least the steps. customer.charge_ai_answer holds the same list for
# when no terms were pushed, and the billing_terms column defaults repeat it.
DEFAULT_AI_CREDIT_TIERS: list[dict[str, Any]] = [
    {"max_steps": 10, "credits": 1},
    {"max_steps": 20, "credits": 2},
    {"max_steps": None, "credits": 3},
]

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
        "ai_credits": float(row.trial_ai_credits),
    }


async def ai_terms(db: AsyncSession) -> dict[str, Any]:
    """A subscription's AI credits per editor seat and the price tiers of an
    answer: the pushed terms, else the defaults."""
    row = await db.get(BillingTerms, 1)
    if row is None:
        return {
            "per_editor": DEFAULT_AI_CREDITS_PER_EDITOR,
            "tiers": [dict(tier) for tier in DEFAULT_AI_CREDIT_TIERS],
        }
    return {
        "per_editor": float(row.ai_credits_per_editor),
        "tiers": row.ai_credit_tiers,
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
    none yet, so metering charges from the first minute. Pushed rates stay; a
    rate of a category core does not charge (a pod of an older version may
    write one back) goes."""
    if not settings.billing_enabled:
        return
    await _write_rates(db, DEFAULT_CREDIT_RATES, source="default", overwrite=False)
    await db.execute(
        text(
            f"DELETE FROM {settings.SCHEMA}.credit_rate "
            "WHERE NOT (category = ANY(:known))"
        ),
        {"known": list(UNIT_BASIS)},
    )
    await db.commit()
    if await db.get(BillingTerms, 1) is None:
        logger.warning(
            "billing is on but the billing system has not pushed its terms yet "
            "(POST /webhooks/billing/terms): new trials use core's defaults"
        )


async def apply_terms(db: AsyncSession, push: BillingTermsPush) -> bool:
    """Store pushed terms. False when the push is older than the stored one
    (a delayed retry must not undo a newer change). Running trials keep the
    quotas they started with; past charges keep the rate they were made at.
    An AI term the push leaves out keeps its stored value, else core's default.
    A new amount per editor reaches every subscription whose AI credits follow
    its seats at once; trials and special deals keep theirs."""
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

    def kept(pushed: Any, column: str, default: Any) -> Any:
        if pushed is not None:
            return pushed
        return getattr(row, column) if row is not None else default

    values = {
        "trial_days": push.trial.days,
        "trial_credits": push.trial.credits,
        "trial_storage_mb": push.trial.storage_mb,
        "trial_projects": push.trial.projects,
        "trial_editors": push.trial.editors,
        "trial_viewers": push.trial.viewers,
        "trial_ai_credits": kept(
            push.trial.ai_credits, "trial_ai_credits", DEFAULT_TRIAL["ai_credits"]
        ),
        "ai_credits_per_editor": kept(
            push.ai_credits_per_editor,
            "ai_credits_per_editor",
            DEFAULT_AI_CREDITS_PER_EDITOR,
        ),
        "ai_credit_tiers": kept(
            [tier.model_dump() for tier in push.ai_credit_tiers]
            if push.ai_credit_tiers is not None
            else None,
            "ai_credit_tiers",
            [dict(tier) for tier in DEFAULT_AI_CREDIT_TIERS],
        ),
        # A push without a time keeps the stored one: the stale check stays armed.
        "as_of": as_of if as_of is not None else (row.as_of if row else None),
    }
    per_editor = float(values["ai_credits_per_editor"])
    previous = (
        float(row.ai_credits_per_editor)
        if row is not None
        else DEFAULT_AI_CREDITS_PER_EDITOR
    )
    if per_editor != previous:
        # The seats times the amount per editor, as apply_entitlement computes
        # it; unlimited seats stay unlimited. Before the terms are written: a
        # push that fails in between is sent again and recomputes again.
        await db.execute(
            text(
                f"UPDATE {settings.SCHEMA}.organization "
                "SET total_ai_credits = total_editors * CAST(:per_editor AS numeric) "
                "WHERE NOT on_trial AND NOT ai_credits_override"
            ),
            {"per_editor": per_editor},
        )
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
