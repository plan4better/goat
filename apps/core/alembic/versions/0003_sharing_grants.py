"""Sharing collapses onto resource_grant; restricted content; shareable layers.

What an `init`-era database gains here:

* `resource_grant.granted_by` becomes nullable and its foreign key becomes
  `ON DELETE SET NULL`. Deleting a user used to cascade-delete every grant
  they had created, revoking access to content that still exists;
* the rows of the six legacy share-link tables (`layer_user`, `layer_team`,
  `layer_organization`, `project_user`, `project_team`,
  `project_organization`) as `resource_grant` rows, so that ONE rule
  (`customer.effective_role`) answers access questions for every resource
  kind — and then the six tables and the sharing trigger functions are
  dropped. Owner rows (roles ending in `-owner`, written by triggers) are not
  grants: ownership stays the `user_id` column and is not copied;
* `restricted` on folder, project, layer and bundle, marking content that its
  space's members do not reach through the space default role, and
  `shareable` on `layer_project`, marking whether a layer travels with the
  project when the project is shared. Both default to the pre-existing
  behaviour, so no backfill is needed.

The authz SQL functions that read `resource_grant` instead of these tables
(`effective_role`, `layer_write_allowed`, `check_layer`, `check_project`) are
installed by `0005_home_templates`, the head of the chain: their bodies read
`layer.space_id`, `folder.parent_id`, the `restricted` columns and
`customer.template`, none of which exist yet at this point. `env.py` commits
each revision on its own, so a database that starts below `0005` runs without
these tables, on the old function bodies, between this revision's commit and
`0005`'s: a pod serving it then gets `relation does not exist`. Upgrade such a
database while nothing serves it.

A fresh database is built by `init` from the current models: it has none of
the legacy tables, so the copy, the verification and the drops are all
skipped, and the columns are already there. The revision passes through
unchanged.

Revision ID: 0003_sharing_grants
Revises: 0002_favorites
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

revision = "0003_sharing_grants"
down_revision = "0002_favorites"
branch_labels = None
depends_on = None

S = settings.SCHEMA

# Column-list form (not ON CONSTRAINT) so a re-run stays idempotent AND picks
# up a role changed since the last run: running it again on an unchanged row
# is a no-op, but a changed role_id updates.
CONFLICT = (
    "ON CONFLICT (resource_type, resource_id, grantee_type, grantee_id) "
    "DO UPDATE SET role_id = EXCLUDED.role_id"
)

# (resource kind, legacy table, grantee kind, grantee column)
LEGACY_LINKS = (
    ("layer", "layer_user", "user", "user_id"),
    ("layer", "layer_team", "team", "team_id"),
    ("layer", "layer_organization", "organization", "organization_id"),
    ("project", "project_user", "user", "user_id"),
    ("project", "project_team", "team", "team_id"),
    ("project", "project_organization", "organization", "organization_id"),
)

TRIGGER_FUNCS = [
    "create_layer_trigger",
    "create_project_trigger",
    "share_project_team",
    "share_project_organization",
    "share_project_new_team_member",
    "share_project_new_organization_member",
]

_CONTENT_TABLES = ("folder", "project", "layer", "bundle")


def _copy(kind: str, table: str, grantee_type: str, grantee_col: str) -> str:
    return f"""
        INSERT INTO "{S}".resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by)
        SELECT '{kind}', lk.{kind}_id, '{grantee_type}', lk.{grantee_col}, lk.role_id, c.user_id
        FROM "{S}".{table} lk
        JOIN "{S}".role r ON r.id = lk.role_id
        JOIN "{S}".{kind} c ON c.id = lk.{kind}_id
        WHERE r.name NOT LIKE '%-owner'
        {CONFLICT}
    """


def _legacy_rows(kind: str, table: str, grantee_type: str, grantee_col: str) -> str:
    return (
        f"SELECT '{kind}' k, lk.{kind}_id rid, '{grantee_type}' gt, lk.{grantee_col}::text gid "
        f'FROM "{S}".{table} lk JOIN "{S}".role r ON r.id = lk.role_id '
        "WHERE r.name NOT LIKE '%-owner'"
    )


COPY_SQL = [_copy(*link) for link in LEGACY_LINKS]


def _move_legacy_grants() -> None:
    """Copy the legacy share links into resource_grant, then drop them."""
    present = [link for link in LEGACY_LINKS if h.table_exists(link[1], S)]
    if not present:
        return
    conn = op.get_bind()
    for link in present:
        conn.execute(sa.text(_copy(*link)))

    # Refuse to drop while any non-owner legacy row has no counterpart.
    union = " UNION ALL ".join(_legacy_rows(*link) for link in present)
    missing = conn.execute(
        sa.text(f"""
        SELECT count(*) FROM ({union}) legacy
        WHERE NOT EXISTS (
            SELECT 1 FROM "{S}".resource_grant rg
            WHERE rg.resource_type = legacy.k AND rg.resource_id = legacy.rid AND rg.grantee_type = legacy.gt AND rg.grantee_id::text = legacy.gid
        )
    """)
    ).scalar_one()
    if missing:
        raise RuntimeError(
            f"{missing} legacy grant rows have no resource_grant counterpart — refusing to drop"
        )

    # The trigger functions wrote owner rows into these tables; the authz
    # functions that replace the readers are installed by the head of the
    # chain, once the columns and tables they read exist.
    for fn in TRIGGER_FUNCS:
        op.execute(f'DROP FUNCTION IF EXISTS "{S}".{fn}() CASCADE')
    for _kind, table, _grantee_type, _grantee_col in present:
        op.execute(f'DROP TABLE IF EXISTS "{S}".{table} CASCADE')


def upgrade() -> None:
    # A grant survives the granter.
    h.alter_column_nullable("resource_grant", "granted_by", S, nullable=True)
    h.ensure_fk(
        "resource_grant_granted_by_fkey",
        "resource_grant",
        "user",
        ["granted_by"],
        ["id"],
        S,
        ondelete="SET NULL",
    )

    _move_legacy_grants()

    for table in _CONTENT_TABLES:
        h.add_column_if_missing(
            table,
            sa.Column(
                "restricted",
                sa.Boolean(),
                server_default=sa.text("false"),
                nullable=False,
            ),
            S,
        )
    h.add_column_if_missing(
        "layer_project",
        sa.Column(
            "shareable", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        S,
    )


def downgrade() -> None:
    raise NotImplementedError(
        "downgrade is not supported for the consolidated migrations"
    )
