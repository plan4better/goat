from enum import Enum
from typing import List, Optional

from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Column, Field, Index, Text

from core.core.config import settings
from core.db.models._base_class import UUIDServerDefaultBase
from core.db.models.organization import QuotaTypeEnum


class RequestMethodEnum(str, Enum):
    GET = "GET"
    POST = "POST"
    PUT = "PUT"
    DELETE = "DELETE"
    PATCH = "PATCH"


class Resource(UUIDServerDefaultBase, table=True):
    """An API endpoint pattern that the authorization engine gates."""

    __tablename__ = "resource"
    __table_args__ = {"schema": settings.SCHEMA}

    url_pattern: str = Field(sa_column=Column(Text, nullable=False))
    method: List[RequestMethodEnum] = Field(
        sa_column=Column(ARRAY(Text()), nullable=False)
    )
    description: Optional[str] = Field(sa_column=Column(Text, nullable=True))
    quota_types: List[QuotaTypeEnum] | None = Field(
        sa_column=Column(ARRAY(Text()), nullable=True)
    )
    # Premium features (organization.extras entries) required to access this
    # resource. NULL = no feature requirement.
    extras: List[str] | None = Field(
        sa_column=Column(ARRAY(Text()), nullable=True),
    )


Index("idx_resource_url_pattern", Resource.__table__.c.url_pattern)
Index("idx_resource_method", Resource.__table__.c.method, postgresql_using="gin")
Index(
    "idx_resource_url_pattern_method",
    Resource.__table__.c.url_pattern,
    Resource.__table__.c.method,
    unique=True,
)
