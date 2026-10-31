from datetime import datetime
from typing import Optional

from sqlalchemy import Numeric
from sqlmodel import Column, DateTime, Field, SQLModel, Text, text

from core.core.config import settings


class CreditRate(SQLModel, table=True):
    """Global credit conversion rates — one row per category (compute, egress, ai).

    Not per-org / per-subscription. cost = native_unit (normalized to
    unit_basis) * rate. Pushed by the billing system with its terms (source
    'billing', POST /webhooks/billing/terms); until then core's defaults (source
    'default', written at startup). A push overwrites edits in the table.
    """

    __tablename__ = "credit_rate"
    __table_args__ = {"schema": settings.SCHEMA}

    category: str = Field(
        sa_column=Column(Text, primary_key=True)
    )  # 'compute' | 'egress' | 'ai'
    rate: float = Field(sa_column=Column(Numeric, nullable=False))
    unit_basis: str = Field(
        sa_column=Column(Text, nullable=False)
    )  # 'minute' | 'GB' | '1k_tokens'
    updated_at: Optional[datetime] = Field(
        sa_column=Column(DateTime, server_default=text("CURRENT_TIMESTAMP"))
    )
    source: Optional[str] = Field(
        default="default", sa_column=Column(Text, nullable=True)
    )
