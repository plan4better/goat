from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List
from uuid import UUID

from pydantic import HttpUrl, field_validator
from sqlalchemy import Boolean, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlalchemy.sql import text
from sqlmodel import (
    ARRAY,
    Column,
    DateTime,
    Field,
    Float,
    ForeignKey,
    Integer,
    Relationship,
)

from core.core.config import settings
from core.db.models._base_class import DateTimeBase
from core.db.models.layer import ContentBaseAttributes

if TYPE_CHECKING:
    from core.db.models._link_model import (
        LayerProjectGroup,
        LayerProjectLink,
        UserProjectLink,
    )

    from .report_layout import ReportLayout
    from .workflow import Workflow


class Project(ContentBaseAttributes, DateTimeBase, table=True):
    __tablename__ = "project"
    __table_args__ = {"schema": settings.SCHEMA}

    id: UUID | None = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=text("uuid_generate_v4()"),
        ),
        description="Layer ID",
    )
    user_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        description='Project creator. Nullable: informational "created by", survives the user.',
    )
    folder_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.folder.id", ondelete="CASCADE"),
            nullable=False,
        ),
        description="Project folder ID",
    )
    space_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.space.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        description=(
            "Space this project belongs to. Every create path sets it — "
            "nullable only because the dev DB carries legacy projects whose "
            "owning user row no longer exists, so the backfill has no "
            "personal space to put them in; such rows were already "
            "unreachable before spaces."
        ),
    )
    deleted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
        description="Soft-delete timestamp; NULL while the project is live.",
    )
    restricted: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default=text("false")),
        description="Restricted (D9): members of the project's space do not get the space default role on it; grants still apply.",
    )
    layer_order: List[int] | None = Field(
        sa_column=Column(
            ARRAY(Integer),
            nullable=True,
        ),
        description="Layer order in project",
    )
    basemap: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Project basemap",
    )
    locale: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="The language map labels and formatted numbers use (spec 10); none follows the viewer",
    )
    thumbnail_url: str | None = Field(
        sa_column=Column(Text, nullable=True),
        description="Project thumbnail URL",
        default=settings.DEFAULT_PROJECT_THUMBNAIL,
    )
    custom_basemaps: list[dict] = Field(
        default_factory=list,
        sa_column=Column(
            JSONB,
            nullable=False,
            server_default=text("'[]'::jsonb"),
        ),
        description="Per-project custom basemap library",
    )
    max_extent: list[float] | None = Field(
        sa_column=Column(
            ARRAY(Float),
            nullable=True,
        ),
        description="Max extent of the project",
    )
    builder_config: Dict[str, Any] | None = Field(
        sa_column=Column(
            JSONB,
            nullable=True,
        ),
        description="Builder config",
    )
    tags: List[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(Text), nullable=True),
        description="Layer tags",
    )
    is_template_source: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default=text("false")),
        description=(
            "Marks a hidden frozen copy made for a project template (T2): "
            "excluded from every listing, feed, trash and search."
        ),
    )

    # Relationships
    user_projects: List["UserProjectLink"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    layer_projects: List["LayerProjectLink"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    project_public: "ProjectPublic" = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "uselist": False},
    )
    layer_groups: List["LayerProjectGroup"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    report_layouts: List["ReportLayout"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    workflows: List["Workflow"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    @field_validator("thumbnail_url", mode="before")
    @classmethod
    def convert_httpurl_to_str(
        cls: type["Project"], value: str | HttpUrl | None
    ) -> str | None:
        if value is None:
            return value
        elif isinstance(value, HttpUrl):
            return str(value)
        # A root-relative path names the artwork the web app ships.
        if value.startswith("/"):
            return value
        assert HttpUrl(value)
        return value


class ProjectPublic(DateTimeBase, table=True, extend_existing=True):
    """
    A table representing a public project. A public project is a project that is accessible to the public.

    Attributes:
        password (str): The password required to access the project.
        config (dict): The configuration of the project. This is a JSON object which includes project settings, layers etc.
        project_id (UUID): The unique identifier for the project.
    """

    __tablename__ = "project_public"
    __table_args__ = {"schema": settings.SCHEMA}
    id: UUID | None = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            server_default=text("uuid_generate_v4()"),
            nullable=False,
            index=True,
            primary_key=True,
        )
    )
    password: str | None = Field(sa_column=Column(Text, nullable=True), max_length=255)
    config: Dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    project_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.project.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    custom_domain_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(
                f"{settings.SCHEMA}.organization_domain.id",
                ondelete="SET NULL",
            ),
            unique=True,
            index=True,
            nullable=True,
        ),
        description="Custom domain assigned to this public project (v1: one project per domain).",
    )
    subdomain: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Always NULL for v1; reserved for v2 wildcard domains.",
    )
    analytics_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(
                f"{settings.SCHEMA}.organization_analytics.id",
                ondelete="SET NULL",
            ),
            index=True,
            nullable=True,
        ),
        description=(
            "Analytics instance this published project reports to. Non-null "
            "means tracking is on; null means off. Cleared automatically when "
            "the instance is deleted."
        ),
    )
    tracking_require_consent: bool = Field(
        default=True,
        sa_column=Column(Boolean, nullable=False, server_default=text("true")),
        description=(
            "If true, the analytics tracker injects `requireConsent` so no "
            "events fire until the customer's consent banner calls "
            "`_paq.push(['rememberConsentGiven'])`. Defaults to true for "
            "GDPR/TDDDG safety; can be disabled per-project when the dashboard "
            "runs in a jurisdiction that doesn't require consent."
        ),
    )

    project: Project = Relationship(back_populates="project_public")
