"""AI assistant: conversations, messages, runs, run events, usage, organization
connections and AI settings, the audit of tool calls, and feedback on answers.

A new schema owned by this chain but used only by the assistant service
(apps/assistant). Idempotent like the revisions before it: a fresh database
gets these tables from `init` (built from the current models), so on it this
revision only finds them present.

Revision ID: 0012_assistant
Revises: 0011_layer_serial_counter
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

revision = "0012_assistant"
down_revision = "0011_layer_serial_counter"
branch_labels = None
depends_on = None

A = settings.ASSISTANT_SCHEMA


def _id() -> sa.Column:
    return sa.Column(
        "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
    )


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name,
        postgresql.TIMESTAMP(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )


def _count(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer(), server_default=sa.text("0"), nullable=False)


def upgrade() -> None:
    op.execute(f'CREATE SCHEMA IF NOT EXISTS "{A}"')

    if not h.table_exists("conversation", A):
        op.create_table(
            "conversation",
            _id(),
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("organization_id", sa.UUID(), nullable=True),
            sa.Column("project_id", sa.UUID(), nullable=True),
            sa.Column("title", sa.Text(), nullable=True),
            sa.Column("origin_surface", sa.Text(), nullable=False),
            _timestamp("created_at"),
            _timestamp("updated_at"),
            sa.PrimaryKeyConstraint("id"),
            schema=A,
        )
    h.create_index_if_missing(
        "ix_assistant_conversation_user_updated",
        "conversation",
        ["user_id", "updated_at"],
        A,
    )
    h.create_index_if_missing(
        "ix_assistant_conversation_user_project",
        "conversation",
        ["user_id", "project_id"],
        A,
    )

    if not h.table_exists("message", A):
        op.create_table(
            "message",
            _id(),
            sa.Column("conversation_id", sa.UUID(), nullable=False),
            sa.Column("run_id", sa.UUID(), nullable=True),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("role", sa.Text(), nullable=False),
            sa.Column(
                "parts",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'[]'::jsonb"),
                nullable=False,
            ),
            sa.Column(
                "model_messages",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'[]'::jsonb"),
                nullable=False,
            ),
            _timestamp("created_at"),
            sa.ForeignKeyConstraint(
                ["conversation_id"], [f"{A}.conversation.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "conversation_id", "seq", name="uq_assistant_message_conversation_seq"
            ),
            schema=A,
        )

    if not h.table_exists("run", A):
        op.create_table(
            "run",
            _id(),
            sa.Column("conversation_id", sa.UUID(), nullable=False),
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("assistant_message_id", sa.UUID(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("provider", sa.Text(), nullable=False),
            sa.Column("model", sa.Text(), nullable=False),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("lease_owner", sa.Text(), nullable=True),
            sa.Column(
                "lease_expires_at", postgresql.TIMESTAMP(timezone=True), nullable=True
            ),
            sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
            sa.Column(
                "finished_at", postgresql.TIMESTAMP(timezone=True), nullable=True
            ),
            _timestamp("created_at"),
            sa.ForeignKeyConstraint(
                ["conversation_id"], [f"{A}.conversation.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["assistant_message_id"], [f"{A}.message.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            schema=A,
        )
    h.create_index_if_missing(
        "ix_assistant_run_conversation_status", "run", ["conversation_id", "status"], A
    )
    h.create_index_if_missing(
        "ix_assistant_run_user_status", "run", ["user_id", "status"], A
    )
    h.create_index_if_missing(
        "ix_assistant_run_status_lease", "run", ["status", "lease_expires_at"], A
    )

    if not h.table_exists("run_event", A):
        op.create_table(
            "run_event",
            sa.Column("run_id", sa.UUID(), nullable=False),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("type", sa.Text(), nullable=False),
            sa.Column(
                "payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False
            ),
            _timestamp("created_at"),
            sa.ForeignKeyConstraint(["run_id"], [f"{A}.run.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("run_id", "seq"),
            schema=A,
        )

    if not h.table_exists("usage", A):
        op.create_table(
            "usage",
            _id(),
            sa.Column("run_id", sa.UUID(), nullable=True),
            sa.Column("organization_id", sa.UUID(), nullable=True),
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("connection_id", sa.UUID(), nullable=True),
            sa.Column("provider", sa.Text(), nullable=False),
            sa.Column("model", sa.Text(), nullable=False),
            sa.Column("purpose", sa.Text(), nullable=False),
            _count("input_tokens"),
            _count("output_tokens"),
            _count("cache_read_tokens"),
            _count("cache_write_tokens"),
            _timestamp("created_at"),
            sa.PrimaryKeyConstraint("id"),
            schema=A,
        )
    h.create_index_if_missing(
        "ix_assistant_usage_organization_created",
        "usage",
        ["organization_id", "created_at"],
        A,
    )
    # One usage row per run and purpose.
    h.create_index_if_missing(
        "uq_assistant_usage_run_purpose", "usage", ["run_id", "purpose"], A, unique=True
    )

    if not h.table_exists("connection", A):
        op.create_table(
            "connection",
            _id(),
            sa.Column("organization_id", sa.UUID(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("provider", sa.Text(), nullable=False),
            sa.Column("base_url", sa.Text(), nullable=True),
            sa.Column("region", sa.Text(), nullable=True),
            sa.Column("model", sa.Text(), nullable=False),
            sa.Column(
                "provider_order",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'[]'::jsonb"),
                nullable=False,
            ),
            sa.Column(
                "allow_fallbacks",
                sa.Boolean(),
                server_default=sa.text("true"),
                nullable=False,
            ),
            sa.Column("credentials_encrypted", sa.Text(), nullable=False),
            sa.Column(
                "capabilities",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'{}'::jsonb"),
                nullable=False,
            ),
            sa.Column(
                "last_test_at", postgresql.TIMESTAMP(timezone=True), nullable=True
            ),
            sa.Column("last_test_ok", sa.Boolean(), nullable=True),
            sa.Column("last_test_error", sa.Text(), nullable=True),
            _timestamp("created_at"),
            _timestamp("updated_at"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "organization_id",
                "name",
                name="uq_assistant_connection_organization_name",
            ),
            schema=A,
        )

    if not h.table_exists("organization_settings", A):
        op.create_table(
            "organization_settings",
            sa.Column("organization_id", sa.UUID(), nullable=False),
            sa.Column(
                "enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False
            ),
            sa.Column("active_connection_id", sa.UUID(), nullable=True),
            sa.Column(
                "data_policy",
                sa.Text(),
                server_default=sa.text("'restricted'"),
                nullable=False,
            ),
            sa.Column(
                "allow_default_fallback",
                sa.Boolean(),
                server_default=sa.text("false"),
                nullable=False,
            ),
            sa.Column("updated_by", sa.UUID(), nullable=True),
            _timestamp("updated_at"),
            sa.CheckConstraint(
                "data_policy IN ('standard', 'restricted')",
                name="ck_assistant_organization_settings_data_policy",
            ),
            sa.ForeignKeyConstraint(
                ["active_connection_id"], [f"{A}.connection.id"], ondelete="RESTRICT"
            ),
            sa.PrimaryKeyConstraint("organization_id"),
            schema=A,
        )

    if not h.table_exists("tool_call", A):
        op.create_table(
            "tool_call",
            _id(),
            sa.Column("run_id", sa.UUID(), nullable=True),
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("tool", sa.Text(), nullable=False),
            sa.Column("tool_call_id", sa.Text(), nullable=True),
            sa.Column(
                "args_summary",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'{}'::jsonb"),
                nullable=False,
            ),
            _count("result_bytes"),
            _count("duration_ms"),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column(
                "created", postgresql.JSONB(astext_type=sa.Text()), nullable=True
            ),
            _timestamp("created_at"),
            sa.ForeignKeyConstraint(["run_id"], [f"{A}.run.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            schema=A,
        )
    h.create_index_if_missing("ix_assistant_tool_call_run", "tool_call", ["run_id"], A)
    h.create_index_if_missing(
        "ix_assistant_tool_call_user_created",
        "tool_call",
        ["user_id", "created_at"],
        A,
    )

    if not h.table_exists("feedback", A):
        op.create_table(
            "feedback",
            _id(),
            sa.Column("message_id", sa.UUID(), nullable=False),
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("organization_id", sa.UUID(), nullable=True),
            sa.Column("rating", sa.Text(), nullable=False),
            sa.Column("comment", sa.Text(), nullable=True),
            _timestamp("created_at"),
            _timestamp("updated_at"),
            sa.CheckConstraint(
                "rating IN ('up', 'down')", name="ck_assistant_feedback_rating"
            ),
            sa.CheckConstraint(
                "char_length(comment) <= 500",
                name="ck_assistant_feedback_comment_length",
            ),
            sa.ForeignKeyConstraint(
                ["message_id"], [f"{A}.message.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "message_id", "user_id", name="uq_assistant_feedback_message_user"
            ),
            schema=A,
        )
    h.create_index_if_missing(
        "ix_assistant_feedback_organization_created",
        "feedback",
        ["organization_id", "created_at"],
        A,
    )


def downgrade() -> None:
    for table in (
        "feedback",
        "tool_call",
        "organization_settings",
        "connection",
        "usage",
        "run_event",
        "run",
        "message",
        "conversation",
    ):
        h.drop_table_if_present(table, A)
    op.execute(f'DROP SCHEMA IF EXISTS "{A}"')
