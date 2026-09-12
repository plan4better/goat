"""What a bundle's artifacts were built from, and the type vocabulary in code.

Three changes, all about where a fact about a bundle belongs.

`bundle_dependency.built_revision` — the revision of the *dependency* that this
bundle's artifacts were built from. A PT bundle's stop-to-street linkage is
built against a street network bundle, and editing that network leaves the
linkage describing a road layout that no longer exists. Comparing this against
the dependency's current `layers_revision` is what makes that staleness
visible; NULL means "never built from", so re-pointing a link invalidates the
artifacts structurally rather than by a flag someone has to remember to clear.

`bundle_artifact.properties` — what the build knows about its own output and
nobody else can derive. A PT timetable is built for a window of dates taken
from the feed's calendar, the feed itself is not kept, and outside that window
the timetable answers every journey with "no service" — so if the build does
not write the window down, nothing can ask again. One JSONB column rather than
a typed one per fact: these are per-kind and per-builder, and a column each
would be a migration each. Nothing checks the shape, so readers treat a value
they do not recognise as absent.

`bundle_type` (the table) goes. It held the type identifier, a name, and a
`structure` projection of the type's spec — but the projection was written by a
seeder and read by nothing, because every consumer resolves the live spec
through `goatlib.models.bundle.get_spec`. A copy that nothing reads only
drifts. The `bundle.bundle_type` column stays as text, validated on the way in
by the enum, so adding a type is now a code change alone. `bundle.records` goes
with it: same story, never read.

Idempotent throughout, like the revisions before it: a fresh database is built
by `init` from the current models, and one that has already been through an
earlier form of these changes passes through unchanged.

Revision ID: 0006_bundle_provenance
Revises: 0005_home_templates
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

revision = "0006_bundle_provenance"
down_revision = "0005_home_templates"
branch_labels = None
depends_on = None

S = settings.SCHEMA


def upgrade() -> None:
    h.add_column_if_missing(
        "bundle_dependency",
        sa.Column("built_revision", sa.Integer(), nullable=True),
        S,
    )
    # none_as_null on the model: without it SQLAlchemy stores a Python None as
    # the JSON value `null`, which is not an object, and every consumer then has
    # to guard a shape that should simply have been absent.
    h.add_column_if_missing(
        "bundle_artifact",
        sa.Column("properties", postgresql.JSONB(), nullable=True),
        S,
    )

    # The FK is created unnamed inside `create_table`, so its name is whatever
    # Postgres derived — looked up by the column it constrains rather than
    # assumed.
    fk = h.foreign_key_on("bundle", "bundle_type", S)
    if fk and fk.get("name"):
        op.drop_constraint(fk["name"], "bundle", schema=S, type_="foreignkey")
    h.drop_table_if_present("bundle_type", S)
    h.drop_column_if_present("bundle", "records", S)


def downgrade() -> None:
    h.add_column_if_missing(
        "bundle", sa.Column("records", postgresql.JSONB(), nullable=True), S
    )
    if not h.table_exists("bundle_type", S):
        op.create_table(
            "bundle_type",
            sa.Column("type", sa.Text(), primary_key=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("structure", postgresql.JSONB(), nullable=False),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            schema=S,
        )
        # Enough rows for the foreign key to be satisfiable, from the types the
        # bundles actually use. The content is a projection of the specs in
        # code: the release that owned this table refills it on boot from its
        # own seeder, and inventing a `structure` here would recreate exactly
        # the drift the upgrade removed.
        op.execute(
            f"INSERT INTO {S}.bundle_type (type, name, structure) "
            f"SELECT DISTINCT bundle_type, bundle_type, '{{}}'::jsonb "
            f"FROM {S}.bundle"
        )
    h.create_fk_if_missing(
        "bundle_bundle_type_fkey",
        "bundle",
        "bundle_type",
        ["bundle_type"],
        ["type"],
        S,
        ondelete="RESTRICT",
    )
    h.drop_column_if_present("bundle_artifact", "properties", S)
    h.drop_column_if_present("bundle_dependency", "built_revision", S)
