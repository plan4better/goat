"""
Workflow Model
"""

from typing import TYPE_CHECKING, Any, Dict
from uuid import UUID

from sqlalchemy import Integer, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlalchemy.sql import text
from sqlmodel import Column, Field, ForeignKey, Relationship

from core.core.config import settings
from core.db.models._base_class import DateTimeBase

if TYPE_CHECKING:
    from core.db.models.project import Project


class Workflow(DateTimeBase, table=True):
    """
    Workflow for chaining multiple tools together in a visual DAG editor.

    A workflow defines a series of connected tool nodes that can be executed
    sequentially. Each project can have multiple workflows.

    Attributes:
        id: Unique identifier for the workflow
        project_id: Parent project this workflow belongs to
        name: Human-readable workflow name
        description: Optional description of the workflow
        is_default: Whether this is the default workflow for the project
        config: JSONB configuration containing nodes, edges, and viewport
        thumbnail_url: Preview image of the workflow
        revision: Counter of the saves that changed it, for the conflict check
        updated_by: Who made the last change
    """

    __tablename__ = "workflow"
    __table_args__ = {"schema": settings.SCHEMA}

    id: UUID | None = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=text("uuid_generate_v4()"),
        ),
        description="Workflow ID",
    )

    project_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.project.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        description="Parent project ID",
    )

    name: str = Field(
        sa_column=Column(Text, nullable=False),
        description="Workflow name (e.g., 'Buffer Analysis')",
        max_length=255,
    )

    description: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Workflow description",
    )

    is_default: bool = Field(
        default=False,
        description="Whether this is the default workflow for the project",
    )

    config: Dict[str, Any] = Field(
        sa_column=Column(
            JSONB,
            nullable=False,
        ),
        description="Workflow configuration (nodes, edges, viewport)",
    )

    thumbnail_url: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Workflow preview thumbnail URL",
    )

    revision: int = Field(
        default=1,
        sa_column=Column(Integer, nullable=False, server_default=text("1")),
        description="Raised by one on every save that changes the workflow "
        "(core.core.revision)",
    )

    updated_by: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        description="Who made the last change",
    )

    # Relationships
    project: "Project" = Relationship(back_populates="workflows")
