"""Shared catalog bundles (XPlan plans): no owner, space or folder, like a catalog layer.

Revision ID: 0024_catalog_bundles
Revises: 0023_filter_empty_values
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

revision = "0024_catalog_bundles"
down_revision = "0023_filter_empty_values"
branch_labels = None
depends_on = None

S = settings.SCHEMA
INDEX = "uq_bundle_catalog_identity"
EFFECTIVE_ROLE_SQL = (
    Path(__file__).parents[2]
    / "src"
    / "core"
    / "db"
    / "sql"
    / "functions"
    / "authz"
    / "effective_role.sql"
)


def _has_effective_role() -> bool:
    """A fresh database gets its functions from `initial_data`, after the chain."""
    return bool(
        op.get_bind().scalar(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n "
                "ON n.oid = p.pronamespace WHERE n.nspname = :s "
                "AND p.proname = 'effective_role')"
            ),
            {"s": S},
        )
    )


def upgrade() -> None:
    h.alter_column_nullable("bundle", "space_id", S, nullable=True)
    h.alter_column_nullable("bundle", "folder_id", S, nullable=True)
    h.add_column_if_missing("bundle", sa.Column("catalog_external_uid", sa.Text()), S)
    h.add_column_if_missing("bundle", sa.Column("catalog_version", sa.Text()), S)
    h.create_index_if_missing(
        INDEX,
        "bundle",
        ["catalog_external_uid", "catalog_version"],
        S,
        unique=True,
        postgresql_where=sa.text("catalog_external_uid IS NOT NULL"),
    )
    if _has_effective_role():
        sql = EFFECTIVE_ROLE_SQL.read_text().replace("customer.", f"{S}.")
        op.get_bind().execute(sa.text(sql))


def downgrade() -> None:
    # The access rule reads the columns, so it stops reading them first.
    if _has_effective_role():
        op.execute(
            f"""CREATE OR REPLACE FUNCTION {S}.bundle_is_catalog(bundle_id UUID)
            RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT FALSE $$"""
        )
    op.execute(f"DELETE FROM {S}.bundle WHERE catalog_external_uid IS NOT NULL")
    h.drop_index_if_present(INDEX, "bundle", S)
    h.drop_column_if_present("bundle", "catalog_version", S)
    h.drop_column_if_present("bundle", "catalog_external_uid", S)
    h.alter_column_nullable("bundle", "folder_id", S, nullable=False)
    h.alter_column_nullable("bundle", "space_id", S, nullable=False)
