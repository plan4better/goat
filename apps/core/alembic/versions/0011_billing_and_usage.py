"""Billing and usage: Odoo entitlements on the organization and the credit
metering ledger.

Organization: nullable caps (NULL = unlimited), numeric credits, the
`extras` grant list, resource plan gating -> feature gating; plan_name,
stripe_id and the CRM columns the slimmed signup no longer collects are
dropped, so check the production schema and data before it runs. Usage: the
credit_usage ledger columns and indexes, the global credit_rate table, and
the dead cost table dropped.

Every step checks the catalog first (a fresh database gets the end state from
`init`). check_organization() and charge_credits() are installed by
scripts/initial_data.py, which every deploy runs after the migrations. See
docs/odoo-entitlement-contract.md.

Revision ID: 0011_billing_and_usage
Revises: 0010_support_tickets
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import ARRAY

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0011_billing_and_usage"
down_revision = "0010_support_tickets"
branch_labels = None
depends_on = None

SCHEMA = settings.SCHEMA

CAP_COLUMNS = ("total_projects", "total_editors", "total_viewers")
CRM_COLUMNS = ("industry", "department", "use_case", "location", "phone_number", "size")
LEDGER = "credit_usage"
OLD_INDEXES = ("idx_user_id", "idx_organization_id", "idx_user_id_organization_id")


def _columns(table: str) -> set[str]:
    """Existing column names — the init baseline builds fresh DBs from the
    CURRENT models (already the end state), so every step here must be a
    no-op when its column is already gone / already present."""
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns(table, schema=SCHEMA)}


def upgrade() -> None:
    _upgrade_organization()
    _upgrade_ledger()


def downgrade() -> None:
    _downgrade_ledger()
    _downgrade_organization()


def _upgrade_organization() -> None:
    org_columns = _columns("organization")

    # --- organization: credits numeric, total_credits nullable (NULL = unlimited)
    op.alter_column(
        "organization",
        "total_credits",
        schema=SCHEMA,
        existing_type=sa.Integer(),
        type_=sa.Numeric(),
        nullable=True,
        postgresql_using="total_credits::numeric",
    )
    op.alter_column(
        "organization",
        "used_credits",
        schema=SCHEMA,
        existing_type=sa.Integer(),
        type_=sa.Numeric(),
        existing_nullable=False,
        existing_server_default=sa.text("0"),
        postgresql_using="used_credits::numeric",
    )

    # --- organization: capacity caps nullable (NULL = unlimited)
    op.alter_column(
        "organization",
        "total_storage",
        schema=SCHEMA,
        existing_type=sa.Float(),
        nullable=True,
    )
    for column in CAP_COLUMNS:
        op.alter_column(
            "organization",
            column,
            schema=SCHEMA,
            existing_type=sa.Integer(),
            nullable=True,
        )

    # --- organization: premium-feature grant-list
    # NULL = all features enabled (self-hosted), [] = none granted (SaaS
    # default until billing pushes an entitlement).
    if "extras" not in org_columns:
        op.add_column(
            "organization",
            sa.Column("extras", ARRAY(sa.Text()), nullable=True),
            schema=SCHEMA,
        )

    # --- plan names + Stripe are gone (single-product model, Odoo billing).
    # Entitlement state is purely numeric quotas + extras; there is no plan
    # label and no Stripe customer to reference anymore.
    for column in ("plan_name", "stripe_id"):
        if column in org_columns:
            op.drop_column("organization", column, schema=SCHEMA)

    # --- CRM firmographics dropped: no longer collected at signup, and the
    # canonical copy lives in the CRM (HubSpot today, Odoo CRM after the
    # migration). Fresh installs never get them (models no longer define them).
    for column in CRM_COLUMNS:
        if column in org_columns:
            op.drop_column("organization", column, schema=SCHEMA)

    # --- resource: plan gating -> feature gating
    if "plan_names" in _columns("resource"):
        op.alter_column(
            "resource", "plan_names", new_column_name="extras", schema=SCHEMA
        )
        # Rows that were plan-gated (custom domain + tracking opt-in) become
        # white_label-gated. seed_roles re-seeds the same values on the next
        # initial_data run.
        op.execute(
            f"UPDATE {SCHEMA}.resource SET extras = '{{white_label}}' "
            "WHERE extras IS NOT NULL"
        )


def _upgrade_ledger() -> None:
    if h.table_exists(LEDGER, SCHEMA):
        # The ledger was dormant (empty) before metering: the new NOT NULL
        # columns get a default only for the ALTER itself.
        for column, default in (
            ("category", "compute"),
            ("unit_type", "seconds"),
            ("rate", "0"),
        ):
            if not h.column_exists(LEDGER, column, SCHEMA):
                col_type = sa.Numeric() if column == "rate" else sa.Text()
                op.add_column(
                    LEDGER,
                    sa.Column(column, col_type, nullable=False, server_default=default),
                    schema=SCHEMA,
                )
                op.alter_column(LEDGER, column, server_default=None, schema=SCHEMA)
        op.alter_column(
            LEDGER,
            "id",
            schema=SCHEMA,
            existing_type=sa.Integer(),
            type_=sa.BigInteger(),
        )
        h.alter_column_nullable(LEDGER, "user_id", SCHEMA, nullable=True)
        op.alter_column(
            LEDGER,
            "unit",
            schema=SCHEMA,
            type_=sa.Numeric(),
            postgresql_using="unit::numeric",
        )
        op.alter_column(
            LEDGER,
            "cost",
            schema=SCHEMA,
            type_=sa.Numeric(),
            postgresql_using="cost::numeric",
        )
        for index in OLD_INDEXES:
            h.drop_index_if_present(index, LEDGER, SCHEMA)
        h.create_index_if_missing(
            "idx_credit_usage_org_created",
            LEDGER,
            ["organization_id", "created_at"],
            SCHEMA,
        )
        h.create_index_if_missing(
            "idx_credit_usage_org_category_created",
            LEDGER,
            ["organization_id", "category", "created_at"],
            SCHEMA,
        )

    # Global rate config (replaces the cost table): billing data, editable by
    # the operator (later from Odoo), not an app setting.
    if not h.table_exists("credit_rate", SCHEMA):
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
            schema=SCHEMA,
        )
    op.execute(
        f"INSERT INTO {SCHEMA}.credit_rate (category, rate, unit_basis, source) VALUES "
        "('compute', 10, 'minute', 'default'), ('egress', 20, 'GB', 'default') "
        "ON CONFLICT (category) DO NOTHING"
    )

    h.drop_table_if_present("cost", SCHEMA)


def _downgrade_ledger() -> None:
    if not h.table_exists("cost", SCHEMA):
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
            schema=SCHEMA,
        )
    h.drop_table_if_present("credit_rate", SCHEMA)
    if h.table_exists(LEDGER, SCHEMA):
        h.drop_index_if_present("idx_credit_usage_org_category_created", LEDGER, SCHEMA)
        h.drop_index_if_present("idx_credit_usage_org_created", LEDGER, SCHEMA)
        h.create_index_if_missing("idx_user_id", LEDGER, ["user_id"], SCHEMA)
        h.create_index_if_missing(
            "idx_organization_id", LEDGER, ["organization_id"], SCHEMA
        )
        h.create_index_if_missing(
            "idx_user_id_organization_id",
            LEDGER,
            ["user_id", "organization_id"],
            SCHEMA,
        )
        # Ledger rows written while metering ran do not fit the old shape:
        # the downgrade drops them.
        op.execute(f"DELETE FROM {SCHEMA}.{LEDGER}")
        op.alter_column(LEDGER, "cost", schema=SCHEMA, type_=sa.Float())
        op.alter_column(
            LEDGER,
            "unit",
            schema=SCHEMA,
            type_=sa.Integer(),
            postgresql_using="unit::integer",
        )
        h.alter_column_nullable(LEDGER, "user_id", SCHEMA, nullable=False)
        op.alter_column(
            LEDGER,
            "id",
            schema=SCHEMA,
            existing_type=sa.BigInteger(),
            type_=sa.Integer(),
        )
        for column in ("rate", "unit_type", "category"):
            h.drop_column_if_present(LEDGER, column, SCHEMA)


def _downgrade_organization() -> None:
    if "extras" in _columns("resource"):
        op.execute(
            f"UPDATE {SCHEMA}.resource "
            "SET extras = '{goat_professional,goat_enterprise}' "
            "WHERE extras IS NOT NULL"
        )
        op.alter_column(
            "resource", "extras", new_column_name="plan_names", schema=SCHEMA
        )

    org_columns = _columns("organization")
    if "extras" in org_columns:
        op.drop_column("organization", "extras", schema=SCHEMA)

    # Recreate the CRM columns with their original constraints. The dropped
    # data is unrecoverable — NOT NULL columns come back as neutral
    # placeholders (the CRM keeps the real values).
    crm_restore_defaults = {
        "industry": "other",
        "department": "general",
        "use_case": "other",
        "location": "",
        "phone_number": "",
        "size": None,
    }
    for column, default in crm_restore_defaults.items():
        if column in org_columns:
            continue
        if default is None:
            op.add_column(
                "organization",
                sa.Column(column, sa.Text(), nullable=True),
                schema=SCHEMA,
            )
        else:
            op.add_column(
                "organization",
                sa.Column(column, sa.Text(), nullable=False, server_default=default),
                schema=SCHEMA,
            )
            op.alter_column("organization", column, server_default=None, schema=SCHEMA)

    if "stripe_id" not in org_columns:
        op.add_column(
            "organization",
            sa.Column("stripe_id", sa.Text(), nullable=True),
            schema=SCHEMA,
        )
    if "plan_name" not in org_columns:
        op.add_column(
            "organization",
            sa.Column(
                "plan_name",
                sa.Text(),
                nullable=False,
                server_default="goat_enterprise",
            ),
            schema=SCHEMA,
        )
        op.alter_column("organization", "plan_name", server_default=None, schema=SCHEMA)

    # NULL caps mean unlimited; materialize them as large finite values so the
    # NOT NULL constraints can be restored.
    op.execute(
        f"UPDATE {SCHEMA}.organization SET "
        "total_storage = COALESCE(total_storage, 1048576), "
        "total_credits = COALESCE(total_credits, 1000000), "
        "total_projects = COALESCE(total_projects, 10000), "
        "total_editors = COALESCE(total_editors, 1000), "
        "total_viewers = COALESCE(total_viewers, 1000)"
    )
    for column in CAP_COLUMNS:
        op.alter_column(
            "organization",
            column,
            schema=SCHEMA,
            existing_type=sa.Integer(),
            nullable=False,
        )
    op.alter_column(
        "organization",
        "total_storage",
        schema=SCHEMA,
        existing_type=sa.Float(),
        nullable=False,
    )
    op.alter_column(
        "organization",
        "used_credits",
        schema=SCHEMA,
        existing_type=sa.Numeric(),
        type_=sa.Integer(),
        existing_nullable=False,
        existing_server_default=sa.text("0"),
        postgresql_using="round(used_credits)::integer",
    )
    op.alter_column(
        "organization",
        "total_credits",
        schema=SCHEMA,
        existing_type=sa.Numeric(),
        type_=sa.Integer(),
        nullable=False,
        postgresql_using="round(total_credits)::integer",
    )
