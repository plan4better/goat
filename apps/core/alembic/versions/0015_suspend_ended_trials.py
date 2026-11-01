"""Suspend the trials that ended before this release, quietly.

Stripe used to suspend a trial at its end. Trials it never knew about (the
2024 migration's flags, trials extended by hand) were left on_trial with a
past end date. trial_expiry now suspends ended trials, but it emails each
contact, so these are suspended here instead, with no email. They stay
on_trial, as trial_expiry leaves them; an entitlement push still converts or
reactivates them. Self-hosted organizations are never on_trial.

Revision ID: 0015_suspend_ended_trials
Revises: 0014_billing_terms
"""

from alembic import op
from core.core.config import settings

revision = "0015_suspend_ended_trials"
down_revision = "0014_billing_terms"
branch_labels = None
depends_on = None

SCHEMA = settings.SCHEMA


def upgrade() -> None:
    # plan_renewal_date is naive UTC.
    op.execute(
        f"UPDATE {SCHEMA}.organization SET suspended = TRUE "
        "WHERE on_trial IS TRUE AND suspended IS FALSE "
        "AND plan_renewal_date < (now() AT TIME ZONE 'UTC')"
    )


def downgrade() -> None:
    # Which organizations this suspended is not recorded; reactivating is
    # Odoo's (an entitlement push with suspended: false).
    pass
