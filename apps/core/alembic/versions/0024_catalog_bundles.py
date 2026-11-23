"""Shared catalog bundles: an XPlan plan added from the catalog, once per version.

A catalog bundle is the bundle counterpart of a catalog layer: no space, no
folder, no owner, identified by `(catalog_external_uid, catalog_version)` with a
partial unique index, readable by everyone and writable by nobody. The rule lives
in `customer.effective_role` (`bundle_is_catalog`, next to `layer_is_catalog`),
reinstalled here from its file the way 0005 installs it.

Revision ID: 0024_catalog_bundles
Revises: 0023_filter_empty_values
"""

from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings

revision = "0024_catalog_bundles"
down_revision = "0023_filter_empty_values"
branch_labels = None
depends_on = None

S = settings.SCHEMA
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


def upgrade() -> None:
    op.alter_column("bundle", "space_id", nullable=True, schema=S)
    op.alter_column("bundle", "folder_id", nullable=True, schema=S)
    op.add_column(
        "bundle", sa.Column("catalog_external_uid", sa.Text(), nullable=True), schema=S
    )
    op.add_column(
        "bundle", sa.Column("catalog_version", sa.Text(), nullable=True), schema=S
    )
    op.create_index(
        "uq_bundle_catalog_identity",
        "bundle",
        ["catalog_external_uid", "catalog_version"],
        unique=True,
        schema=S,
        postgresql_where=sa.text("catalog_external_uid IS NOT NULL"),
    )
    sql = EFFECTIVE_ROLE_SQL.read_text().replace("customer.", f"{S}.")
    op.get_bind().execute(sa.text(sql))


def downgrade() -> None:
    # Catalog bundles cannot exist without these columns, and the access rule
    # reads them: answer "no catalog bundle" before the columns go.
    op.execute(
        f"""CREATE OR REPLACE FUNCTION {S}.bundle_is_catalog(bundle_id UUID)
        RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT FALSE $$"""
    )
    op.execute(f"DELETE FROM {S}.bundle WHERE catalog_external_uid IS NOT NULL")
    op.drop_index("uq_bundle_catalog_identity", table_name="bundle", schema=S)
    op.drop_column("bundle", "catalog_version", schema=S)
    op.drop_column("bundle", "catalog_external_uid", schema=S)
    op.alter_column("bundle", "folder_id", nullable=False, schema=S)
    op.alter_column("bundle", "space_id", nullable=False, schema=S)
