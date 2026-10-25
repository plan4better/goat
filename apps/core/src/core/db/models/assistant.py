"""Tables of the AI assistant (``apps/assistant``).

Defined here so core's Alembic is the one migration chain per database and
CI's ``alembic check`` guards them against drift. Only the assistant service
reads or writes them, through its own connection; core never queries them.
No foreign keys into ``customer``: the assistant stores ids and checks access
through the authorization functions, like geoapi.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import Field, SQLModel

from core.core.config import settings

A = settings.ASSISTANT_SCHEMA


def _id() -> Any:
    return Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            server_default=text("gen_random_uuid()"),
        ),
    )


def _uuid(nullable: bool) -> Any:
    return Field(
        default=None, sa_column=Column(UUID_PG(as_uuid=True), nullable=nullable)
    )


def _text(nullable: bool) -> Any:
    return Field(default=None, sa_column=Column(Text, nullable=nullable))


def _created_at() -> Any:
    return Field(
        default=None,
        sa_column=Column(
            TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
        ),
    )


def _timestamp() -> Any:
    return Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), nullable=True)
    )


def _jsonb_list() -> Any:
    return Field(
        default=None,
        sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    )


def _count() -> Any:
    return Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default=text("0"))
    )


def _flag(default: bool) -> Any:
    return Field(
        default=default,
        sa_column=Column(
            Boolean, nullable=False, server_default=text("true" if default else "false")
        ),
    )


def _jsonb_object() -> Any:
    return Field(
        default=None,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )


class AssistantConversation(SQLModel, table=True):
    __tablename__ = "conversation"
    __table_args__ = (
        Index("ix_assistant_conversation_user_updated", "user_id", "updated_at"),
        Index("ix_assistant_conversation_user_project", "user_id", "project_id"),
        {"schema": A},
    )

    id: UUID | None = _id()
    user_id: UUID = _uuid(nullable=False)
    organization_id: UUID | None = _uuid(nullable=True)
    #: The project this conversation belongs to; NULL while not bound (spec §10).
    project_id: UUID | None = _uuid(nullable=True)
    title: str | None = _text(nullable=True)
    origin_surface: str = _text(nullable=False)
    created_at: datetime | None = _created_at()
    updated_at: datetime | None = _created_at()


class AssistantMessage(SQLModel, table=True):
    __tablename__ = "message"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id", "seq", name="uq_assistant_message_conversation_seq"
        ),
        {"schema": A},
    )

    id: UUID | None = _id()
    conversation_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.conversation.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    run_id: UUID | None = _uuid(nullable=True)
    seq: int = Field(sa_column=Column(Integer, nullable=False))
    role: str = _text(nullable=False)
    #: GOAT's neutral parts (assistant.events.fold_parts).
    parts: list[dict[str, Any]] | None = _jsonb_list()
    #: Pydantic AI's serialized model messages for this turn.
    model_messages: list[dict[str, Any]] | None = _jsonb_list()
    created_at: datetime | None = _created_at()


class AssistantRun(SQLModel, table=True):
    __tablename__ = "run"
    __table_args__ = (
        Index("ix_assistant_run_conversation_status", "conversation_id", "status"),
        Index("ix_assistant_run_user_status", "user_id", "status"),
        Index("ix_assistant_run_status_lease", "status", "lease_expires_at"),
        {"schema": A},
    )

    id: UUID | None = _id()
    conversation_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.conversation.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    user_id: UUID = _uuid(nullable=False)
    assistant_message_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.message.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    #: queued, running, succeeded, failed, cancelled, interrupted
    status: str = _text(nullable=False)
    provider: str = _text(nullable=False)
    model: str = _text(nullable=False)
    error: str | None = _text(nullable=True)
    lease_owner: str | None = _text(nullable=True)
    lease_expires_at: datetime | None = _timestamp()
    started_at: datetime | None = _timestamp()
    finished_at: datetime | None = _timestamp()
    created_at: datetime | None = _created_at()


class AssistantRunEvent(SQLModel, table=True):
    __tablename__ = "run_event"
    __table_args__ = ({"schema": A},)

    run_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.run.id", ondelete="CASCADE"),
            primary_key=True,
        )
    )
    seq: int = Field(sa_column=Column(Integer, primary_key=True))
    type: str = _text(nullable=False)
    payload: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    created_at: datetime | None = _created_at()


class AssistantUsage(SQLModel, table=True):
    """Raw usage, one row per run and purpose (spec §11): ``main`` sums the
    agent loop's model calls, ``background`` the title calls.
    Kept when a conversation is deleted: it is what credit metering books
    later, hence no foreign key."""

    __tablename__ = "usage"
    __table_args__ = (
        Index(
            "ix_assistant_usage_organization_created", "organization_id", "created_at"
        ),
        Index("uq_assistant_usage_run_purpose", "run_id", "purpose", unique=True),
        {"schema": A},
    )

    id: UUID | None = _id()
    run_id: UUID | None = _uuid(nullable=True)
    organization_id: UUID | None = _uuid(nullable=True)
    user_id: UUID = _uuid(nullable=False)
    #: NULL = the built-in GOAT AI connection (plan 2).
    connection_id: UUID | None = _uuid(nullable=True)
    provider: str = _text(nullable=False)
    model: str = _text(nullable=False)
    #: main or background
    purpose: str = _text(nullable=False)
    input_tokens: int = _count()
    output_tokens: int = _count()
    cache_read_tokens: int = _count()
    cache_write_tokens: int = _count()
    created_at: datetime | None = _created_at()


class AssistantToolCall(SQLModel, table=True):
    """One tool call (spec §5, §7.5): what ran, how big its result was, how it
    ended. Deleted with its run, so with the conversation. Calls over MCP have
    no run and keep the caller's ``user_id``."""

    __tablename__ = "tool_call"
    __table_args__ = (
        Index("ix_assistant_tool_call_run", "run_id"),
        Index("ix_assistant_tool_call_user_created", "user_id", "created_at"),
        {"schema": A},
    )

    id: UUID | None = _id()
    run_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.run.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    user_id: UUID = _uuid(nullable=False)
    #: The tool's wire name (``catalog_search``).
    tool: str = _text(nullable=False)
    #: The model's tool call ID, linking the row to the step view; NULL over MCP.
    tool_call_id: str | None = _text(nullable=True)
    #: The arguments with long values shortened (``assistant.tools.runtime.summarize_args``).
    args_summary: dict[str, Any] | None = _jsonb_object()
    #: Size of the JSON the model received, not the result itself.
    result_bytes: int = _count()
    duration_ms: int = _count()
    #: ok, invalid (arguments rejected) or error
    status: str = _text(nullable=False)
    error: str | None = _text(nullable=True)
    #: What a write tool created (``{"kind": "workflow", "ids": [...],
    #: "project_id": ...}``); NULL for every other call.
    created: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    created_at: datetime | None = _created_at()


class AssistantConnection(SQLModel, table=True):
    """An organization's own model provider connection (spec §4.1, §5).

    ``credentials_encrypted`` is a Fernet token over a JSON object (the API
    key, or the provider's credential fields). Only the assistant service can
    read it, with ``ASSISTANT_SECRETS_KEY``.
    """

    __tablename__ = "connection"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "name", name="uq_assistant_connection_organization_name"
        ),
        {"schema": A},
    )

    id: UUID | None = _id()
    organization_id: UUID = _uuid(nullable=False)
    name: str = _text(nullable=False)
    #: anthropic, bedrock, vertex, azure_openai, openai, mistral, openai_compatible
    provider: str = _text(nullable=False)
    base_url: str | None = _text(nullable=True)
    region: str | None = _text(nullable=True)
    model: str = _text(nullable=False)
    #: OpenRouter only: the providers to send the model to, in order (empty:
    #: OpenRouter chooses), and whether others may answer when those fail.
    provider_order: list[str] | None = _jsonb_list()
    allow_fallbacks: bool = _flag(True)
    credentials_encrypted: str = _text(nullable=False)
    #: The capability profile recorded by the last passed Test connection (§4.3).
    capabilities: dict[str, Any] | None = _jsonb_object()
    last_test_at: datetime | None = _timestamp()
    last_test_ok: bool | None = Field(
        default=None, sa_column=Column(Boolean, nullable=True)
    )
    last_test_error: str | None = _text(nullable=True)
    created_at: datetime | None = _created_at()
    updated_at: datetime | None = _created_at()


class AssistantOrganizationSettings(SQLModel, table=True):
    """Per-organization AI settings (spec §4.1). No row means the defaults:
    enabled, GOAT AI, Restricted data policy, no fallback."""

    __tablename__ = "organization_settings"
    __table_args__ = (
        CheckConstraint(
            "data_policy IN ('standard', 'restricted')",
            name="ck_assistant_organization_settings_data_policy",
        ),
        {"schema": A},
    )

    organization_id: UUID = Field(
        sa_column=Column(UUID_PG(as_uuid=True), primary_key=True)
    )
    enabled: bool = _flag(True)
    #: NULL = GOAT AI. RESTRICT: the active connection cannot be deleted, so an
    #: organization's choice never changes behind its admin's back (spec D4).
    active_connection_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.connection.id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    data_policy: str = Field(
        default="restricted",
        sa_column=Column(Text, nullable=False, server_default=text("'restricted'")),
    )
    allow_default_fallback: bool = _flag(False)
    updated_by: UUID | None = _uuid(nullable=True)
    updated_at: datetime | None = _created_at()


class AssistantFeedback(SQLModel, table=True):
    """A member's rating of one answer: thumbs up or down, and an optional
    comment. One per user and answer, changed in place; deleted with the
    answer, so with the conversation."""

    __tablename__ = "feedback"
    __table_args__ = (
        UniqueConstraint(
            "message_id", "user_id", name="uq_assistant_feedback_message_user"
        ),
        CheckConstraint(
            "rating IN ('up', 'down')", name="ck_assistant_feedback_rating"
        ),
        CheckConstraint(
            "char_length(comment) <= 500", name="ck_assistant_feedback_comment_length"
        ),
        Index(
            "ix_assistant_feedback_organization_created",
            "organization_id",
            "created_at",
        ),
        {"schema": A},
    )

    id: UUID | None = _id()
    message_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{A}.message.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    user_id: UUID = _uuid(nullable=False)
    organization_id: UUID | None = _uuid(nullable=True)
    #: up or down
    rating: str = _text(nullable=False)
    comment: str | None = _text(nullable=True)
    created_at: datetime | None = _created_at()
    updated_at: datetime | None = _created_at()


#: Creation order (foreign keys first). The assistant's test suite builds its
#: schema from these, so the service is always tested against the real definitions.
ASSISTANT_TABLES: list[Table] = [
    # SQLModel adds `__table__` at class creation, which mypy cannot see.
    getattr(model, "__table__")
    for model in (
        AssistantConversation,
        AssistantMessage,
        AssistantRun,
        AssistantRunEvent,
        AssistantUsage,
        AssistantConnection,
        AssistantOrganizationSettings,
        AssistantToolCall,
        AssistantFeedback,
    )
]
