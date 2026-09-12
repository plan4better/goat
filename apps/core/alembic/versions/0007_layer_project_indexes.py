"""Index the project column of a project's layer tree.

Both tables that make up a project's tree -- its layer links and its layer
groups -- are read and rewritten by project: a listing filters on it, and
adding anything to a project pushes every existing row of that project down
by one to make room at the top. Neither column had an index (Postgres does
not index a foreign key on its own), so each of those was a scan of the
whole table across every project.

Idempotent, like the revisions before it.

Revision ID: 0007_layer_project_indexes
Revises: 0006_bundle_provenance
"""

import sys
from pathlib import Path

from core.core.config import settings

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0007_layer_project_indexes"
down_revision = "0006_bundle_provenance"
branch_labels = None
depends_on = None

S = settings.SCHEMA

_INDEXES = (
    (f"ix_{S}_layer_project_project_id", "layer_project"),
    (f"ix_{S}_layer_project_group_project_id", "layer_project_group"),
)


def upgrade() -> None:
    for name, table in _INDEXES:
        h.create_index_if_missing(name, table, ["project_id"], S)


def downgrade() -> None:
    for name, table in _INDEXES:
        h.drop_index_if_present(name, table, S)
