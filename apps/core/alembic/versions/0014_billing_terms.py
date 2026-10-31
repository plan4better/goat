"""Billing terms pushed by the billing system: the trial a new organization
starts with (customer.billing_terms, one row). The credit rates already have
their table (credit_rate); both used to come from TRIAL_* and CREDIT_RATE_*
settings and now come from POST /webhooks/billing/terms.

Revision ID: 0014_billing_terms
Revises: 0013_billing_hardening
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0014_billing_terms"
down_revision = "0013_billing_hardening"
branch_labels = None
depends_on = None

SCHEMA = settings.SCHEMA
TABLE = "billing_terms"


def upgrade() -> None:
    # A fresh database has it from `init`.
    if h.table_exists(TABLE, SCHEMA):
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("trial_days", sa.Integer(), nullable=False),
        sa.Column("trial_credits", sa.Numeric(), nullable=False),
        sa.Column("trial_storage_mb", sa.Numeric(), nullable=False),
        sa.Column("trial_projects", sa.Integer(), nullable=False),
        sa.Column("trial_editors", sa.Integer(), nullable=False),
        sa.Column("trial_viewers", sa.Integer(), nullable=False),
        sa.Column("as_of", sa.DateTime(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")
        ),
        sa.CheckConstraint("id = 1", name="billing_terms_single_row"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    h.drop_table_if_present(TABLE, SCHEMA)
