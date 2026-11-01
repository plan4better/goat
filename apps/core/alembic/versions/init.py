"""Squashed baseline — full current schema (tables + schemas only).

A single starting point that builds the entire schema from zero, straight
from the SQLModel metadata.

Functions, triggers, pg_cron jobs and seed data are NOT created here — they
are installed separately by ``scripts/initial_data.py`` (``init_functions`` /
``init_triggers`` / the ``seed_*`` helpers).

Revision ID: init
Revises:
"""

from alembic import op
from sqlmodel import SQLModel

import core.db.models  # noqa: F401  (imports all models -> populates metadata)
from core.core.config import settings

revision = "init"
down_revision = None
branch_labels = None
depends_on = None

# `settings.SCHEMA` is the configurable data schema (default "customer"); the
# models, SQL functions and triggers all resolve to it, so the baseline must
# create the same one.
SCHEMAS = ("basic", settings.SCHEMA, "temporal", settings.ASSISTANT_SCHEMA)


def upgrade() -> None:
    conn = op.get_bind()
    for schema in SCHEMAS:
        op.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    # Extensions required by the table DDL: PostGIS for geometry columns,
    # uuid-ossp for uuid_generate_v4() server defaults. (gen_random_uuid() is a
    # built-in in PG13+.) Platform extensions (citus, h3, …) are infra-managed.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    SQLModel.metadata.create_all(conn)


def downgrade() -> None:
    SQLModel.metadata.drop_all(op.get_bind())
