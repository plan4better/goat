"""Document revisions: a revision counter and the last saver on workflows,
report layouts and a project's dashboard, and the assistant's undo record.

`revision` (workflow, report_layout) and `builder_revision` (project) start at
1 for every existing row; a save that changes the document raises them and is
checked against the revision it was made on (`core.core.revision`).
`updated_by` names who saved last. `assistant.tool_call.undo` keeps what a
write tool changed in an existing document, so the assistant can undo it.

A fresh database gets these columns from the models (``init``), so every step
checks the catalog first, like every revision since the squashed baseline.

Revision ID: 0013_document_revision
Revises: 0012_assistant
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0013_document_revision"
down_revision = "0012_assistant"
branch_labels = None
depends_on = None

S = settings.SCHEMA
A = settings.ASSISTANT_SCHEMA

#: (table, revision column) of every document saved with a revision.
DOCUMENTS = (
    ("workflow", "revision"),
    ("report_layout", "revision"),
    ("project", "builder_revision"),
)


def upgrade() -> None:
    for table, counter in DOCUMENTS:
        h.add_column_if_missing(
            table,
            sa.Column(
                counter, sa.Integer(), server_default=sa.text("1"), nullable=False
            ),
            S,
        )
        h.add_column_if_missing(
            table, sa.Column("updated_by", UUID_PG(as_uuid=True), nullable=True), S
        )
        h.ensure_fk(
            f"{table}_updated_by_fkey",
            table,
            "user",
            ["updated_by"],
            ["id"],
            S,
            ondelete="SET NULL",
        )
    h.add_column_if_missing("tool_call", sa.Column("undo", JSONB(), nullable=True), A)


def downgrade() -> None:
    h.drop_column_if_present("tool_call", "undo", A)
    for table, counter in DOCUMENTS:
        h.drop_column_if_present(table, "updated_by", S)
        h.drop_column_if_present(table, counter, S)
