"""Credit metering: the credit_usage ledger, the global credit_rate table, and
the dead cost table dropped.

The organization side (numeric credits, nullable quotas) is in 0011. Every
step checks the catalog first: a fresh database gets the end state from
`init`, so this does nothing there. The charge_credits() function is
installed by scripts/initial_data.py, which every deploy runs after the
migrations.

Revision ID: 0012_credit_metering
Revises: 0011_odoo_billing
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

revision = "0012_credit_metering"
down_revision = "0011_odoo_billing"
branch_labels = None
depends_on = None

S = settings.SCHEMA
LEDGER = "credit_usage"
OLD_INDEXES = ("idx_user_id", "idx_organization_id", "idx_user_id_organization_id")


def upgrade() -> None:
    if h.table_exists(LEDGER, S):
        # The ledger was dormant (empty) before metering: the new NOT NULL
        # columns get a default only for the ALTER itself.
        for column, default in (
            ("category", "compute"),
            ("unit_type", "seconds"),
            ("rate", "0"),
        ):
            if not h.column_exists(LEDGER, column, S):
                col_type = sa.Numeric() if column == "rate" else sa.Text()
                op.add_column(
                    LEDGER,
                    sa.Column(column, col_type, nullable=False, server_default=default),
                    schema=S,
                )
                op.alter_column(LEDGER, column, server_default=None, schema=S)
        op.alter_column(
            LEDGER, "id", schema=S, existing_type=sa.Integer(), type_=sa.BigInteger()
        )
        h.alter_column_nullable(LEDGER, "user_id", S, nullable=True)
        op.alter_column(
            LEDGER,
            "unit",
            schema=S,
            type_=sa.Numeric(),
            postgresql_using="unit::numeric",
        )
        op.alter_column(
            LEDGER,
            "cost",
            schema=S,
            type_=sa.Numeric(),
            postgresql_using="cost::numeric",
        )
        for index in OLD_INDEXES:
            h.drop_index_if_present(index, LEDGER, S)
        h.create_index_if_missing(
            "idx_credit_usage_org_created", LEDGER, ["organization_id", "created_at"], S
        )
        h.create_index_if_missing(
            "idx_credit_usage_org_category_created",
            LEDGER,
            ["organization_id", "category", "created_at"],
            S,
        )

    # Global rate config (replaces the cost table): billing data, editable by
    # the operator (later from Odoo), not an app setting.
    if not h.table_exists("credit_rate", S):
        op.create_table(
            "credit_rate",
            sa.Column("category", sa.Text(), primary_key=True),
            sa.Column("rate", sa.Numeric(), nullable=False),
            sa.Column("unit_basis", sa.Text(), nullable=False),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.Column("source", sa.Text(), nullable=True),
            schema=S,
        )
    op.execute(
        f"INSERT INTO {S}.credit_rate (category, rate, unit_basis, source) VALUES "
        "('compute', 10, 'minute', 'default'), ('egress', 20, 'GB', 'default') "
        "ON CONFLICT (category) DO NOTHING"
    )

    h.drop_table_if_present("cost", S)


def downgrade() -> None:
    if not h.table_exists("cost", S):
        op.create_table(
            "cost",
            sa.Column(
                "id",
                sa.UUID(),
                server_default=sa.text("uuid_generate_v4()"),
                primary_key=True,
            ),
            sa.Column(
                "created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.Column(
                "updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.Column("action", sa.Text(), nullable=False),
            sa.Column("credit", sa.Float(), nullable=False),
            schema=S,
        )
    h.drop_table_if_present("credit_rate", S)
    if h.table_exists(LEDGER, S):
        h.drop_index_if_present("idx_credit_usage_org_category_created", LEDGER, S)
        h.drop_index_if_present("idx_credit_usage_org_created", LEDGER, S)
        h.create_index_if_missing("idx_user_id", LEDGER, ["user_id"], S)
        h.create_index_if_missing("idx_organization_id", LEDGER, ["organization_id"], S)
        h.create_index_if_missing(
            "idx_user_id_organization_id", LEDGER, ["user_id", "organization_id"], S
        )
        # Ledger rows written while metering ran do not fit the old shape:
        # the downgrade drops them.
        op.execute(f"DELETE FROM {S}.{LEDGER}")
        op.alter_column(LEDGER, "cost", schema=S, type_=sa.Float())
        op.alter_column(
            LEDGER,
            "unit",
            schema=S,
            type_=sa.Integer(),
            postgresql_using="unit::integer",
        )
        h.alter_column_nullable(LEDGER, "user_id", S, nullable=False)
        op.alter_column(
            LEDGER, "id", schema=S, existing_type=sa.BigInteger(), type_=sa.Integer()
        )
        for column in ("rate", "unit_type", "category"):
            h.drop_column_if_present(LEDGER, column, S)
