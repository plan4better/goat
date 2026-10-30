from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, Integer, Numeric, SmallInteger
from sqlmodel import Column, DateTime, Field, SQLModel, text

from core.core.config import settings


class BillingTerms(SQLModel, table=True):
    """The trial a new organization starts with (billing only), as the billing
    system last pushed it (POST /webhooks/billing/terms). One row; until the
    first push core uses its own defaults (core.billing_terms). Running trials
    keep the quotas they started with."""

    __tablename__ = "billing_terms"
    __table_args__ = (
        CheckConstraint("id = 1", name="billing_terms_single_row"),
        {"schema": settings.SCHEMA},
    )

    id: int = Field(default=1, sa_column=Column(SmallInteger, primary_key=True))
    trial_days: int = Field(sa_column=Column(Integer, nullable=False))
    # Credits for the whole trial (it gets no monthly reset).
    trial_credits: float = Field(sa_column=Column(Numeric, nullable=False))
    trial_storage_mb: float = Field(sa_column=Column(Numeric, nullable=False))
    trial_projects: int = Field(sa_column=Column(Integer, nullable=False))
    trial_editors: int = Field(sa_column=Column(Integer, nullable=False))
    trial_viewers: int = Field(sa_column=Column(Integer, nullable=False))
    # The billing system's time of these terms: an older push is ignored.
    as_of: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime, nullable=True)
    )
    updated_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime, server_default=text("CURRENT_TIMESTAMP")),
    )
