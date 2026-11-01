"""
Print Template Model
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


class ReportLayout(DateTimeBase, table=True):
    """
    Report layout for generating PDF reports from projects.

    A layout defines the page setup, elements, and styling for a printable report.
    Each project can have multiple layouts (e.g., "Summary Report",
    "Detailed Analysis", "Executive Overview").

    Attributes:
        id: Unique identifier for the layout
        project_id: Parent project this layout belongs to
        name: Human-readable layout name
        description: Optional description of the layout
        is_default: Whether this is the default layout for the project
        is_predefined: System-provided layout (not user-created)
        config: JSONB configuration containing page setup, elements, theme, etc.
        thumbnail_url: Preview image of the layout
        revision: Counter of the saves that changed it, for the conflict check
        updated_by: Who made the last change
    """

    __tablename__ = "report_layout"
    __table_args__ = {"schema": settings.SCHEMA}

    id: UUID | None = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=text("uuid_generate_v4()"),
        ),
        description="Layout ID",
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
        description="Layout name (e.g., 'Summary Report')",
        max_length=255,
    )

    description: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Layout description",
    )

    is_default: bool = Field(
        default=False,
        description="Whether this is the default layout for the project",
    )

    is_predefined: bool = Field(
        default=False,
        description="System-provided predefined layout",
    )

    config: Dict[str, Any] = Field(
        sa_column=Column(
            JSONB,
            nullable=False,
        ),
        description="Layout configuration (page setup, elements, theme, etc.)",
    )

    thumbnail_url: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Layout preview thumbnail URL",
    )

    revision: int = Field(
        default=1,
        sa_column=Column(Integer, nullable=False, server_default=text("1")),
        description="Raised by one on every save that changes the layout "
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
    project: "Project" = Relationship(back_populates="report_layouts")
