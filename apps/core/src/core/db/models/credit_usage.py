from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import ForeignKey, Index, Numeric
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import BigInteger, Column, DateTime, Field, SQLModel, Text, text

from core.core.config import settings


class CreditUsage(SQLModel, table=True):
    """A ledger row recording credit consumption (one per charge)."""

    __tablename__ = "credit_usage"
    __table_args__ = {"schema": settings.SCHEMA}

    id: Optional[int] = Field(
        sa_column=Column(BigInteger, primary_key=True, autoincrement=True)
    )
    created_at: Optional[datetime] = Field(
        sa_column=Column(DateTime, server_default=text("CURRENT_TIMESTAMP"))
    )
    organization_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.organization.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    user_id: Optional[UUID] = Field(
        default=None, sa_column=Column(UUID_PG(as_uuid=True), nullable=True)
    )
    category: str = Field(
        sa_column=Column(Text, nullable=False)
    )  # 'compute' | 'egress'
    action: str = Field(sa_column=Column(Text, nullable=False), max_length=255)
    unit: float = Field(
        sa_column=Column(Numeric, nullable=False)
    )  # native: seconds | bytes
    unit_type: str = Field(
        sa_column=Column(Text, nullable=False)
    )  # 'seconds' | 'bytes'
    rate: float = Field(sa_column=Column(Numeric, nullable=False))  # snapshot at charge
    cost: float = Field(
        sa_column=Column(Numeric, nullable=False)
    )  # credits (neg = adjustment)
    payload: dict = Field(
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    )


Index(
    "idx_credit_usage_org_created",
    CreditUsage.__table__.c.organization_id,
    CreditUsage.__table__.c.created_at,
)
Index(
    "idx_credit_usage_org_category_created",
    CreditUsage.__table__.c.organization_id,
    CreditUsage.__table__.c.category,
    CreditUsage.__table__.c.created_at,
)
