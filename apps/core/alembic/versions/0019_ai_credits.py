"""AI credits: a pool per organization for the answers of GOAT AI, apart from
the credits.

organization: `total_ai_credits` (NULL = unlimited), `used_ai_credits` and
`ai_credits_override` (the billing system set the amount itself rather than
seats times the amount per editor). billing_terms: the trial's AI credits,
the amount per editor seat and the price tiers of an answer, with core's
defaults as column defaults. credit_usage: a unique partial index makes an
answer's charge idempotent per run. The rate per 1000 AI tokens (credit_rate
`ai`) goes: it was never charged. assistant.usage: where GOAT AI's model ran
for an answer (`hosted_in`).

With billing on, organizations that exist before this revision get their
allowance: a trial the trial's AI credits, a subscription its editor seats
times the amount per editor (unlimited seats: unlimited). With billing off
(self-hosted) every organization stays unlimited.

customer.ai_credits_left() and customer.charge_ai_answer() are installed by
scripts/initial_data.py, which every deploy runs after the migrations. A
fresh database gets these columns and the index from the models (``init``),
so every step checks the catalog first.

Revision ID: 0019_ai_credits
Revises: 0018_document_revision
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import JSONB

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0019_ai_credits"
down_revision = "0018_document_revision"
branch_labels = None
depends_on = None

S = settings.SCHEMA
A = settings.ASSISTANT_SCHEMA

AI_RUN_INDEX = "uq_credit_usage_ai_run"
#: Core's defaults when this revision was written (core.crud.crud_billing_terms).
TRIAL_AI_CREDITS = 100
AI_CREDITS_PER_EDITOR = 200
AI_CREDIT_TIERS_SQL = (
    """'[{"max_steps": 10, "credits": 1}, {"max_steps": 20, "credits": 2}, """
    """{"max_steps": null, "credits": 3}]'::jsonb"""
)


def upgrade() -> None:
    new_pool = not h.column_exists("organization", "total_ai_credits", S)
    h.add_column_if_missing(
        "organization", sa.Column("total_ai_credits", sa.Numeric(), nullable=True), S
    )
    h.add_column_if_missing(
        "organization",
        sa.Column(
            "used_ai_credits", sa.Numeric(), nullable=False, server_default=sa.text("0")
        ),
        S,
    )
    h.add_column_if_missing(
        "organization",
        sa.Column(
            "ai_credits_override",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        S,
    )
    h.add_column_if_missing(
        "billing_terms",
        sa.Column(
            "trial_ai_credits",
            sa.Numeric(),
            nullable=False,
            server_default=sa.text(str(TRIAL_AI_CREDITS)),
        ),
        S,
    )
    h.add_column_if_missing(
        "billing_terms",
        sa.Column(
            "ai_credits_per_editor",
            sa.Numeric(),
            nullable=False,
            server_default=sa.text(str(AI_CREDITS_PER_EDITOR)),
        ),
        S,
    )
    h.add_column_if_missing(
        "billing_terms",
        sa.Column(
            "ai_credit_tiers",
            JSONB(),
            nullable=False,
            server_default=sa.text(AI_CREDIT_TIERS_SQL),
        ),
        S,
    )
    h.add_column_if_missing(
        "usage", sa.Column("hosted_in", sa.Text(), nullable=True), A
    )

    # Not index_exists(): reflection skips expression indexes, so IF NOT EXISTS
    # (a fresh database already has the model's index) does the check. No AI
    # answer was ever charged before this revision, so nothing can collide.
    if h.table_exists("credit_usage", S):
        op.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {AI_RUN_INDEX} ON {S}.credit_usage "
            "((payload->>'run_id')) WHERE category = 'ai'"
        )
    if h.table_exists("credit_rate", S):
        op.execute(f"DELETE FROM {S}.credit_rate WHERE category = 'ai'")

    if new_pool and settings.billing_enabled and h.table_exists("organization", S):
        terms = f"(SELECT {{column}} FROM {S}.billing_terms WHERE id = 1)"
        op.execute(
            f"UPDATE {S}.organization SET total_ai_credits = CASE "
            "WHEN on_trial THEN COALESCE("
            f"{terms.format(column='trial_ai_credits')}, {TRIAL_AI_CREDITS}) "
            "ELSE total_editors * COALESCE("
            f"{terms.format(column='ai_credits_per_editor')}, {AI_CREDITS_PER_EDITOR}) "
            "END"
        )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {S}.{AI_RUN_INDEX}")
    h.drop_column_if_present("usage", "hosted_in", A)
    for column in ("ai_credit_tiers", "ai_credits_per_editor", "trial_ai_credits"):
        h.drop_column_if_present("billing_terms", column, S)
    for column in ("ai_credits_override", "used_ai_credits", "total_ai_credits"):
        h.drop_column_if_present("organization", column, S)
    # The rate per 1000 AI tokens is not restored: the older code writes its
    # default again when it starts with billing on. The ledger's AI rows
    # (category 'ai') stay: the older /credits/breakdown counts them into the
    # credit figures of category, member and month, never into used_credits.
