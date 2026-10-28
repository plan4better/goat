"""GOAT Style storage: named and default layer styles, their recent revisions,
map state on project layers, groups and projects, and the data fingerprint.

`layer_style` holds GOAT Style documents (spec 10): up to ten named styles per
project layer and one default per dataset. `layer_style_revision` keeps the last
twenty documents of each named style, only to merge saves based on an older
revision (spec 13.1). `layer.data_snapshot` and the one-row
`data_snapshot_cursor` keep the data fingerprint the computed values are compared
with (spec 12).

A fresh database gets the tables from the models (``init``), so every step checks
the catalog first, like every revision since the squashed baseline.

Revision ID: 0012_layer_styles
Revises: 0011_layer_serial_counter
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as UUID_PG

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0012_layer_styles"
down_revision = "0011_layer_serial_counter"
branch_labels = None
depends_on = None

S = settings.SCHEMA


def _now() -> sa.Column:
    return sa.Column(
        "created_at",
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=sa.text("now()"),
    )


def upgrade() -> None:
    if not h.table_exists("layer_style", S):
        op.create_table(
            "layer_style",
            sa.Column(
                "id",
                UUID_PG(as_uuid=True),
                primary_key=True,
                nullable=False,
                server_default=sa.text("uuid_generate_v4()"),
            ),
            sa.Column(
                "layer_project_id",
                sa.Integer(),
                sa.ForeignKey(f"{S}.layer_project.id", ondelete="CASCADE"),
                nullable=True,
            ),
            sa.Column(
                "layer_id",
                UUID_PG(as_uuid=True),
                sa.ForeignKey(f"{S}.layer.id", ondelete="CASCADE"),
                nullable=True,
            ),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column(
                "position",
                sa.SmallInteger(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("document", JSONB(), nullable=False),
            sa.Column(
                "revision", sa.Integer(), nullable=False, server_default=sa.text("1")
            ),
            _now(),
            sa.Column(
                "updated_at",
                TIMESTAMP(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
            sa.Column("updated_by", UUID_PG(as_uuid=True), nullable=True),
            sa.CheckConstraint(
                "(layer_project_id IS NULL) <> (layer_id IS NULL)",
                name="layer_style_owner_check",
            ),
            schema=S,
        )
    h.create_index_if_missing(
        "layer_style_layer_id_key",
        "layer_style",
        ["layer_id"],
        S,
        unique=True,
        postgresql_where=sa.text("layer_id IS NOT NULL"),
    )
    h.create_index_if_missing(
        "layer_style_layer_project_position_idx",
        "layer_style",
        ["layer_project_id", "position"],
        S,
    )

    if not h.table_exists("layer_style_revision", S):
        op.create_table(
            "layer_style_revision",
            sa.Column(
                "style_id",
                UUID_PG(as_uuid=True),
                sa.ForeignKey(f"{S}.layer_style.id", ondelete="CASCADE"),
                primary_key=True,
                nullable=False,
            ),
            sa.Column("revision", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("document", JSONB(), nullable=False),
            _now(),
            schema=S,
        )

    if not h.table_exists("data_snapshot_cursor", S):
        op.create_table(
            "data_snapshot_cursor",
            sa.Column("id", sa.SmallInteger(), primary_key=True),
            sa.Column(
                "snapshot_id",
                sa.BigInteger(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.CheckConstraint("id = 1", name="data_snapshot_cursor_one_row"),
            schema=S,
        )
    op.execute(
        f"INSERT INTO {S}.data_snapshot_cursor (id, snapshot_id) VALUES (1, 0) ON CONFLICT DO NOTHING"
    )

    h.add_column_if_missing(
        "layer_project",
        sa.Column("active_style_id", UUID_PG(as_uuid=True), nullable=True),
        S,
    )
    h.create_fk_if_missing(
        "layer_project_active_style_id_fkey",
        "layer_project",
        "layer_style",
        ["active_style_id"],
        ["id"],
        S,
        ondelete="SET NULL",
    )
    # Deleting a style looks up the links that name it active.
    h.create_index_if_missing(
        "ix_customer_layer_project_active_style_id",
        "layer_project",
        ["active_style_id"],
        S,
    )
    h.add_column_if_missing(
        "layer_project",
        sa.Column(
            "visible", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        S,
    )
    h.add_column_if_missing(
        "layer_project",
        sa.Column(
            "position",
            sa.Text(),
            sa.CheckConstraint(
                "position IN ('top', 'below_labels', 'below_roads')",
                name="layer_project_position_check",
            ),
            nullable=False,
            server_default=sa.text("'top'"),
        ),
        S,
    )
    h.add_column_if_missing(
        "layer_project", sa.Column("time_value", JSONB(), nullable=True), S
    )
    h.add_column_if_missing(
        "layer_project",
        sa.Column(
            "legend_expanded",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        S,
    )
    h.add_column_if_missing(
        "layer_project_group",
        sa.Column(
            "visible", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        S,
    )
    h.add_column_if_missing("project", sa.Column("locale", sa.Text(), nullable=True), S)
    h.add_column_if_missing(
        "layer", sa.Column("data_snapshot", sa.BigInteger(), nullable=True), S
    )


def downgrade() -> None:
    h.drop_column_if_present("layer", "data_snapshot", S)
    h.drop_column_if_present("project", "locale", S)
    h.drop_column_if_present("layer_project_group", "visible", S)
    for column in ("legend_expanded", "time_value", "position", "visible"):
        h.drop_column_if_present("layer_project", column, S)
    h.drop_index_if_present(
        "ix_customer_layer_project_active_style_id", "layer_project", S
    )
    h.drop_constraint_if_present(
        "layer_project_active_style_id_fkey", "layer_project", S, type_="foreignkey"
    )
    h.drop_column_if_present("layer_project", "active_style_id", S)
    h.drop_table_if_present("data_snapshot_cursor", S)
    h.drop_table_if_present("layer_style_revision", S)
    h.drop_table_if_present("layer_style", S)
