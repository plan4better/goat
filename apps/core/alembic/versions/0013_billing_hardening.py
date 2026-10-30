"""Billing hardening: stale entitlement pushes, deleted organizations, lost
Odoo reports, and one compute charge per job.

organization.entitlement_as_of: Odoo-side time of the last applied push; an
older push is ignored. organization.deleted_at: set by DELETE
/organizations/{id}, so an entitlement push cannot revive it.
organization.odoo_sync_pending: a report to Odoo failed and is retried (the
partial index keeps the retry scan cheap). credit_usage: a unique partial
index makes a compute charge idempotent per job_id; it fails, naming the
count, when the ledger already holds duplicates, which have to be resolved by
hand (they are double charges).

Every step checks the catalog first (a fresh database gets the end state from
`init`).

Revision ID: 0013_billing_hardening
Revises: 0012_billing_and_usage
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

revision = "0013_billing_hardening"
down_revision = "0012_billing_and_usage"
branch_labels = None
depends_on = None

SCHEMA = settings.SCHEMA

LEDGER = "credit_usage"
COMPUTE_JOB_INDEX = "uq_credit_usage_compute_job"
PENDING_INDEX = "idx_organization_odoo_sync_pending"


def upgrade() -> None:
    h.add_column_if_missing(
        "organization",
        sa.Column("entitlement_as_of", sa.DateTime(), nullable=True),
        SCHEMA,
    )
    h.add_column_if_missing(
        "organization", sa.Column("deleted_at", sa.DateTime(), nullable=True), SCHEMA
    )
    h.add_column_if_missing(
        "organization",
        sa.Column(
            "odoo_sync_pending",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        SCHEMA,
    )
    if h.table_exists("organization", SCHEMA) and not h.index_exists(
        "organization", PENDING_INDEX, SCHEMA
    ):
        op.execute(
            f"CREATE INDEX {PENDING_INDEX} ON {SCHEMA}.organization (id) "
            "WHERE odoo_sync_pending"
        )

    # Not index_exists(): reflection skips expression indexes, so IF NOT EXISTS
    # (a fresh database already has the model's index) does the check.
    if h.table_exists(LEDGER, SCHEMA):
        duplicates = (
            op.get_bind()
            .execute(
                sa.text(
                    f"SELECT count(*) FROM (SELECT 1 FROM {SCHEMA}.{LEDGER} "
                    "WHERE category = 'compute' AND payload->>'job_id' IS NOT NULL "
                    "GROUP BY payload->>'job_id' HAVING count(*) > 1) d"
                )
            )
            .scalar_one()
        )
        if duplicates:
            raise RuntimeError(
                f"{duplicates} compute job(s) are charged more than once in "
                f"{SCHEMA}.{LEDGER}: remove the double charges, then run again."
            )
        op.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {COMPUTE_JOB_INDEX} ON {SCHEMA}.{LEDGER} "
            "((payload->>'job_id')) WHERE category = 'compute'"
        )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {SCHEMA}.{COMPUTE_JOB_INDEX}")
    h.drop_index_if_present(PENDING_INDEX, "organization", SCHEMA)
    for column in ("odoo_sync_pending", "deleted_at", "entitlement_as_of"):
        h.drop_column_if_present("organization", column, SCHEMA)
