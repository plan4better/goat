from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, List, Optional
from uuid import UUID

from pydantic import field_serializer, field_validator
from sqlalchemy import Numeric
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import (
    Boolean,
    Column,
    DateTime,
    Field,
    Float,
    Integer,
    Relationship,
    SQLModel,
    Text,
    text,
)

from core.core.config import settings
from core.db.models._base_class import UUIDServerDefaultBase, serialize_str_enum

if TYPE_CHECKING:
    from .team import Team
    from .user import User


class OrganizationTypeEnum(str, Enum):
    government = "government"
    private = "private"
    non_profit = "non_profit"
    education = "education"
    other = "other"


class AvailableRegionsEnum(str, Enum):
    eu = "EU"


class QuotaTypeEnum(str, Enum):
    storage = "storage"
    credits = "credits"
    projects = "projects"
    editors = "editors"
    viewers = "viewers"


class OrganizationRolesEnum(str, Enum):
    owner = "organization-owner"
    admin = "organization-admin"
    editor = "organization-editor"
    viewer = "organization-viewer"


class OrganizationBase(SQLModel):
    name: str = Field(sa_column=Column(Text, nullable=False), max_length=255)
    avatar: str = Field(sa_column=Column(Text, nullable=False))
    total_storage: float | None = Field(
        default=None, sa_column=Column(Float, nullable=True)
    )
    used_storage: Optional[float] = Field(
        default=0, sa_column=Column(Float, nullable=False, server_default=text("0"))
    )
    total_credits: float | None = Field(
        default=None, sa_column=Column(Numeric, nullable=True)
    )
    used_credits: float = Field(
        default=0, sa_column=Column(Numeric, nullable=False, server_default=text("0"))
    )
    total_projects: int | None = Field(
        default=None, sa_column=Column(Integer, nullable=True)
    )
    used_projects: Optional[int] = Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default=text("0"))
    )
    total_editors: int | None = Field(
        default=None, sa_column=Column(Integer, nullable=True)
    )
    used_editors: Optional[int] = Field(
        default=1, sa_column=Column(Integer, nullable=False, server_default=text("1"))
    )
    total_viewers: int | None = Field(
        default=None, sa_column=Column(Integer, nullable=True)
    )
    used_viewers: Optional[int] = Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default=text("0"))
    )
    # Granted premium features (grant-list). NULL = all enabled (self-hosted),
    # [] = none granted (SaaS default until billing pushes an entitlement).
    extras: list[str] | None = Field(
        default=None, sa_column=Column(ARRAY(Text), nullable=True)
    )
    plan_renewal_date: datetime | None = Field(default=None, sa_column=Column(DateTime))
    on_trial: bool = Field(sa_column=Column(Boolean, nullable=False))
    type: OrganizationTypeEnum = Field(sa_column=Column(Text, nullable=False))
    contact_user_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            nullable=False,
        )
    )
    region: AvailableRegionsEnum = Field(sa_column=Column(Text, nullable=False))
    hubspot_id: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    # Odoo company (res.partner, is_company) this org is (see core.odoo).
    # Written by staff or the billing integration, never by the support bridge,
    # which only reads it; optional.
    odoo_company_id: int | None = Field(
        default=None, sa_column=Column(Integer, nullable=True)
    )
    newsletter_subscribe: bool | None = Field(sa_column=Column(Boolean, nullable=True))
    suspended: bool = Field(sa_column=Column(Boolean, nullable=False))

    @field_validator(
        "used_storage", "used_credits", "used_projects", "used_editors", "used_viewers"
    )
    @classmethod
    def validate_min_value(cls, value: float) -> float:
        if value is not None and value < 0:
            raise ValueError("Value must be greater than or equal to 0")
        return value

    @field_serializer("type", "region")
    def _serialize_enum(self, value: Enum | str | None) -> str | None:
        return serialize_str_enum(value)


class Organization(UUIDServerDefaultBase, OrganizationBase, table=True):
    """An organization: container for users, teams, quotas and subscription."""

    __tablename__ = "organization"
    __table_args__ = {"schema": settings.SCHEMA}

    # Relationships
    users: List["User"] = Relationship(back_populates="organization")
    teams: List["Team"] = Relationship(back_populates="organization")
