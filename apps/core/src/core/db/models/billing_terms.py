from datetime import datetime
from typing import Any, Optional

from sqlalchemy import CheckConstraint, Integer, Numeric, SmallInteger
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Column, DateTime, Field, SQLModel, text

from core.core.config import settings

#: Core's default tiers as a column default; equal to
#: core.crud.crud_billing_terms.DEFAULT_AI_CREDIT_TIERS (a test checks).
AI_CREDIT_TIERS_SQL = (
    """'[{"max_steps": 10, "credits": 1}, {"max_steps": 20, "credits": 2}, """
    """{"max_steps": null, "credits": 3}]'::jsonb"""
)


class BillingTerms(SQLModel, table=True):
    """The trial a new organization starts with and the AI-credit terms
    (billing only), as the billing system last pushed them (POST
    /webhooks/billing/terms). One row; until the first push core uses its own
    defaults (core.crud.crud_billing_terms), which the column defaults repeat.
    Running trials keep the quotas they started with."""

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
    # AI credits for the whole trial.
    trial_ai_credits: float = Field(
        sa_column=Column(Numeric, nullable=False, server_default=text("100"))
    )
    # A subscription's monthly AI credits per editor seat.
    ai_credits_per_editor: float = Field(
        sa_column=Column(Numeric, nullable=False, server_default=text("200"))
    )
    # The price of an answer by its steps: the first tier whose max_steps is
    # null or at least the steps (customer.charge_ai_answer).
    ai_credit_tiers: list[dict[str, Any]] = Field(
        sa_column=Column(
            JSONB, nullable=False, server_default=text(AI_CREDIT_TIERS_SQL)
        )
    )
    # The billing system's time of these terms: an older push is ignored.
    as_of: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime, nullable=True)
    )
    updated_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime, server_default=text("CURRENT_TIMESTAMP")),
    )
