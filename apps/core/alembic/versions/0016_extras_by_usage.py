"""Billing on: existing organizations get only the premium features they use.

0012 left every existing organization with extras NULL, which grants every
premium feature. With billing on, an organization that never set up a custom
domain or tracking (the white_label routes) gets none; the ones that did keep
NULL until the billing system pushes their extras. With billing off
(self-hosted) nothing changes: NULL is the self-hosted default.

Revision ID: 0016_extras_by_usage
Revises: 0015_suspend_ended_trials
"""

from alembic import op
from core.core.config import settings

revision = "0016_extras_by_usage"
down_revision = "0015_suspend_ended_trials"
branch_labels = None
depends_on = None

SCHEMA = settings.SCHEMA


def upgrade() -> None:
    if not settings.billing_enabled:
        return
    op.execute(
        f"UPDATE {SCHEMA}.organization o SET extras = '{{}}' "
        "WHERE o.extras IS NULL "
        f"AND NOT EXISTS (SELECT 1 FROM {SCHEMA}.organization_domain d "
        "WHERE d.organization_id = o.id) "
        f"AND NOT EXISTS (SELECT 1 FROM {SCHEMA}.organization_analytics a "
        "WHERE a.organization_id = o.id)"
    )


def downgrade() -> None:
    # NULL grants everything again, as before this revision.
    op.execute(f"UPDATE {SCHEMA}.organization SET extras = NULL WHERE extras = '{{}}'")
