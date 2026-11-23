"""Home settings, last-opened tracking, and templates.

What an `init`-era database gains here:

* three columns on the existing per-user `customer.system_setting` row —
  `onboarding_skipped_at`, `releases_seen_at`, `spotlight_seen text[]` —
  rather than a second per-user table, plus the `user_id` foreign key that
  row never had;
* `customer.user_project.last_opened_at`, tracking when a user last opened a
  project, with a non-unique index on (project_id, user_id) supporting
  per-user project lookups, and that table's own `user_id` foreign key;
* `customer.template`: a saved, reusable starting point for a workflow,
  layout or project, scoped to a space like any other content, plus the
  `page_size`/`page_orientation` a layout template's card is labelled with,
  and `customer.project.is_template_source`, marking the hidden frozen copy
  made for a project template;
* the `user_id` foreign key on `customer.uploaded_asset`.

The three new foreign keys are added NOT VALID: these tables carry rows whose
`user_id` points at a user that no longer exists, from before anything
enforced that column, and a validating ADD CONSTRAINT would fail on them.
They bind every new write from here on.

`last_opened_at` needs no backfill — an unopened project simply has none.

This is the head of the chain, so it is also where the authz SQL functions
that read `resource_grant` (`effective_role`, `layer_write_allowed`,
`check_layer`, `check_project`) are installed on a database that is still
running the previous generation of them: their bodies read `layer.space_id`,
`folder.parent_id`, the `restricted` columns and `customer.template`, so they
can only be created once the whole chain has run. `env.py` commits each
revision on its own, so a database that starts below this revision runs
without `0003`'s dropped share-link tables, on the old function bodies, until
this revision commits: upgrade such a database while nothing serves it.

A fresh database is built by `init` from the current models, so every column,
index, constraint and the `template` table already exist and this revision
passes through unchanged.

Revision ID: 0005_home_templates
Revises: 0004_spaces
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from core.core.config import settings

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0005_home_templates"
down_revision = "0004_spaces"
branch_labels = None
depends_on = None

S = settings.SCHEMA

# Installed in this order, matching the dependency order create_functions.py's
# installer would derive: effective_role calls space_rank, and
# layer_write_allowed and check_layer/check_project all call effective_role.
AUTHZ_SQL_FILES = [
    "space_rank.sql",
    "effective_role.sql",
    "layer_write_allowed.sql",
    "check_layer.sql",
    "check_project.sql",
]
AUTHZ_SQL_DIR = (
    Path(__file__).parents[2] / "src" / "core" / "db" / "sql" / "functions" / "authz"
)

_CREATED_AT_DEFAULT = sa.text(
    "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', "
    "'YYYY-MM-DD\"T\"HH24:MI:SSOF')::timestamptz"
)


def _create_template_table() -> None:
    if not h.table_exists("template", S):
        op.create_table(
            "template",
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=_CREATED_AT_DEFAULT,
                nullable=False,
            ),
            sa.Column(
                "id",
                sa.UUID(),
                server_default=sa.text("uuid_generate_v4()"),
                nullable=False,
            ),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column(
                "categories",
                postgresql.ARRAY(sa.Text()),
                server_default=sa.text("'{}'"),
                nullable=False,
            ),
            sa.Column("thumbnail_url", sa.Text(), nullable=True),
            sa.Column("space_id", sa.UUID(), nullable=False),
            sa.Column("folder_id", sa.UUID(), nullable=False),
            sa.Column("user_id", sa.UUID(), nullable=True),
            sa.Column("payload_kind", sa.Text(), nullable=False),
            sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column("source_project_id", sa.UUID(), nullable=True),
            sa.Column(
                "source_ref",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'{}'::jsonb"),
                nullable=False,
            ),
            sa.Column(
                "inputs",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'[]'::jsonb"),
                nullable=False,
            ),
            sa.Column(
                "restricted",
                sa.Boolean(),
                server_default=sa.text("false"),
                nullable=False,
            ),
            sa.Column(
                "catalog_status", sa.Text(), server_default="none", nullable=False
            ),
            sa.Column("catalog_reviewed_by", sa.UUID(), nullable=True),
            sa.Column("catalog_note", sa.Text(), nullable=True),
            sa.Column(
                "catalog_published_at", sa.DateTime(timezone=True), nullable=True
            ),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(
                ["catalog_reviewed_by"], [f"{S}.user.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["folder_id"], [f"{S}.folder.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["source_project_id"], [f"{S}.project.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["space_id"], [f"{S}.space.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], [f"{S}.user.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            schema=S,
        )
    h.create_index_if_missing(
        "ix_template_catalog_status",
        "template",
        ["catalog_status"],
        S,
        postgresql_where=sa.text("catalog_status = 'published'"),
    )
    h.create_index_if_missing(
        "ix_template_space_folder", "template", ["space_id", "folder_id"], S
    )


def _install_authz_functions(conn: sa.engine.Connection) -> None:
    """Install the authz functions, reading resource_grant.

    Mirrors create_functions.py's substitution: the `.sql` files use the
    literal `customer.` prefix as a placeholder, replaced here with the
    configured schema exactly the same way (plain string replace, no
    quoting — create_functions.py does not quote it either).
    """
    for name in AUTHZ_SQL_FILES:
        sql_text = (AUTHZ_SQL_DIR / name).read_text()
        sql_text = sql_text.replace("customer.", f"{S}.")
        conn.execute(sa.text(sql_text))


def _replace_previous_generation_authz() -> None:
    """Install the new authz functions where the old ones are still in place.

    `customer.check_layer` without `customer.effective_role` is the previous
    generation: those bodies read the share-link tables `0003` has just
    dropped, so they are replaced here, before the upgrade commits. A fresh
    database has no functions at all — `scripts/initial_data.py` installs the
    whole set there — and an already-consolidated one has `effective_role`
    already; both skip.
    """
    conn = op.get_bind()
    generation = conn.execute(
        sa.text(f"""
        SELECT count(*) FILTER (WHERE p.proname = 'check_layer'),
               count(*) FILTER (WHERE p.proname = 'effective_role')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '{S}'
        """)
    ).one()
    if generation[0] and not generation[1]:
        _install_authz_functions(conn)


def upgrade() -> None:
    h.add_column_if_missing(
        "system_setting",
        sa.Column("onboarding_skipped_at", sa.DateTime(timezone=True), nullable=True),
        S,
    )
    h.add_column_if_missing(
        "system_setting",
        sa.Column("releases_seen_at", sa.DateTime(timezone=True), nullable=True),
        S,
    )
    h.add_column_if_missing(
        "system_setting",
        sa.Column(
            "spotlight_seen",
            sa.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        S,
    )
    h.ensure_fk(
        "system_setting_user_id_fkey",
        "system_setting",
        "user",
        ["user_id"],
        ["id"],
        S,
        ondelete="CASCADE",
        not_valid=True,
    )

    h.add_column_if_missing(
        "user_project",
        sa.Column("last_opened_at", sa.DateTime(timezone=True), nullable=True),
        S,
    )
    h.create_index_if_missing(
        "ix_user_project_project_id_user_id",
        "user_project",
        ["project_id", "user_id"],
        S,
    )
    h.ensure_fk(
        "user_project_user_id_fkey",
        "user_project",
        "user",
        ["user_id"],
        ["id"],
        S,
        ondelete="CASCADE",
        not_valid=True,
    )

    h.ensure_fk(
        "uploaded_asset_user_id_fkey",
        "uploaded_asset",
        "user",
        ["user_id"],
        ["id"],
        S,
        ondelete="CASCADE",
        not_valid=True,
    )

    h.add_column_if_missing(
        "project",
        sa.Column(
            "is_template_source",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        S,
    )
    _create_template_table()
    # The page a layout template prints on, as the client saved it: the two
    # values a card shows ("A3 · Landscape" and the millimetres) without
    # reading the frozen config, which only an owner/editor may see.
    h.add_column_if_missing(
        "template",
        sa.Column("page_size", sa.Text(), nullable=True),
        S,
    )
    h.add_column_if_missing(
        "template",
        sa.Column("page_orientation", sa.Text(), nullable=True),
        S,
    )

    _replace_previous_generation_authz()


def downgrade() -> None:
    raise NotImplementedError(
        "downgrade is not supported for the consolidated migrations"
    )
