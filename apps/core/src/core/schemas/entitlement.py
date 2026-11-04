from datetime import datetime, timezone
from typing import Annotated, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

# Strict: "10" or true is not a number, and infinity or NaN is no cap.
_Cap = Annotated[float, Field(ge=0, strict=True, allow_inf_nan=False)]


def naive_utc(value: datetime) -> datetime:
    """The columns hold naive UTC: an aware time is converted, a naive one is UTC already."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class EntitlementPush(BaseModel):
    """What the billing system pushes for an organization (docs/billing-interface.md).

    Absent fields leave the organization as is; a cap of null means unlimited.
    """

    model_config = ConfigDict(extra="forbid")

    organization_id: UUID
    suspended: StrictBool | None = None
    on_trial: StrictBool | None = None
    total_credits: _Cap | None = None
    # The organization's AI credits per period, set by the billing system
    # itself (a special deal); absent, a push with total_editors sets them to
    # the seats times the amount per editor (CRUDOrganization.apply_entitlement).
    total_ai_credits: _Cap | None = None
    total_storage: _Cap | None = None
    total_projects: _Cap | None = None
    total_editors: _Cap | None = None
    total_viewers: _Cap | None = None
    extras: list[str] | None = None
    plan_renewal_date: datetime | None = None
    # The billing system's time of this data: an older push than the applied one is stale.
    as_of: datetime | None = None
    reset_usage: StrictBool = False

    @field_validator("suspended", "on_trial")
    @classmethod
    def _flag_is_not_null(cls, value: bool | None) -> bool | None:
        if value is None:
            raise ValueError("must be true or false")
        return value

    @field_validator("total_projects", "total_editors", "total_viewers")
    @classmethod
    def _count_is_whole(cls, value: float | None) -> int | None:
        if value is None:
            return None
        if value != int(value):
            raise ValueError("must be a whole number")
        return int(value)

    @field_validator("extras", mode="before")
    @classmethod
    def _extras_are_strings(cls, value: object) -> object:
        if isinstance(value, list) and not all(isinstance(e, str) for e in value):
            raise ValueError("must be a list of strings")
        return value

    @field_validator("plan_renewal_date", "as_of", mode="before")
    @classmethod
    def _iso_string(cls, value: object) -> object:
        # No unix timestamps: pydantic would read a number as one.
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError("must be an ISO 8601 datetime string")
        return value

    @field_validator("plan_renewal_date", "as_of")
    @classmethod
    def _utc(cls, value: datetime | None) -> datetime | None:
        return naive_utc(value) if value is not None else None

    def entitlement(self) -> dict:
        """The fields the push carried, for CRUDOrganization.apply_entitlement."""
        return self.model_dump(
            exclude_unset=True, exclude={"organization_id", "reset_usage"}
        )


class TrialStage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    organization_id: UUID
    stage: Literal["expiring", "expired"]


def _whole(value: float) -> int:
    if value != int(value):
        raise ValueError("must be a whole number")
    return int(value)


# Upper bounds: a typo must be refused (422), not break every sign-up later
# (a date past year 9999, a count past the integer column).
_MAX_COUNT = 2_147_483_647
_MAX_AMOUNT = 1e15


_Amount = Annotated[
    float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
]


_T = TypeVar("_T")


def _not_null(value: _T | None) -> _T:
    """An optional term may be left out, not sent as null."""
    if value is None:
        raise ValueError("leave it out instead of sending null")
    return value


class TrialTerms(BaseModel):
    """The trial a new organization starts with: its length and its quotas."""

    model_config = ConfigDict(extra="forbid")

    days: Annotated[float, Field(ge=0, le=3650, strict=True, allow_inf_nan=False)]
    credits: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]
    storage_mb: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]
    projects: Annotated[
        float, Field(ge=0, le=_MAX_COUNT, strict=True, allow_inf_nan=False)
    ]
    editors: Annotated[
        float, Field(ge=0, le=_MAX_COUNT, strict=True, allow_inf_nan=False)
    ]
    viewers: Annotated[
        float, Field(ge=0, le=_MAX_COUNT, strict=True, allow_inf_nan=False)
    ]
    # AI credits for the whole trial; left out, the stored or default amount.
    ai_credits: _Amount | None = None

    @field_validator("ai_credits")
    @classmethod
    def _ai_credits_not_null(cls, value: float | None) -> float:
        return _not_null(value)

    @field_validator("days", "projects", "editors", "viewers")
    @classmethod
    def _count_is_whole(cls, value: float) -> int:
        return _whole(value)

    @field_validator("days", "editors")
    @classmethod
    def _at_least_one(cls, value: int) -> int:
        if value < 1:
            raise ValueError("must be at least 1")
        return value


class CreditRates(BaseModel):
    """Credits per unit: compute per minute, egress per GB. AI answers are
    priced in AI credits by their steps (BillingTermsPush.ai_credit_tiers)."""

    model_config = ConfigDict(extra="forbid")

    compute: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]
    egress: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]


class AiCreditTier(BaseModel):
    """An answer with at most max_steps steps costs credits AI credits; null
    max_steps: any number of steps (the last tier)."""

    model_config = ConfigDict(extra="forbid")

    max_steps: (
        Annotated[float, Field(ge=0, le=_MAX_COUNT, strict=True, allow_inf_nan=False)]
        | None
    )
    credits: _Amount

    @field_validator("max_steps")
    @classmethod
    def _steps_are_whole(cls, value: float | None) -> int | None:
        return None if value is None else _whole(value)


class BillingTermsPush(BaseModel):
    """The billing system's terms (docs/billing-interface.md), all of them at
    once; the AI terms may be left out (core keeps the stored or default ones)."""

    model_config = ConfigDict(extra="forbid")

    trial: TrialTerms
    credit_rates: CreditRates
    # A subscription's monthly AI credits per editor seat.
    ai_credits_per_editor: _Amount | None = None
    # The price of an answer by its steps, cheapest first, the last one open.
    ai_credit_tiers: list[AiCreditTier] | None = None
    as_of: datetime | None = None

    @field_validator("ai_credits_per_editor", "ai_credit_tiers")
    @classmethod
    def _ai_terms_not_null(cls, value: object) -> object:
        return _not_null(value)

    @field_validator("ai_credit_tiers")
    @classmethod
    def _tiers_ascend_to_an_open_one(
        cls, tiers: list[AiCreditTier] | None
    ) -> list[AiCreditTier] | None:
        if tiers is None:
            return None
        if not tiers:
            raise ValueError("needs at least one tier")
        *bounded, last = tiers
        if last.max_steps is not None:
            raise ValueError("the last tier needs max_steps null")
        limits = [tier.max_steps for tier in bounded if tier.max_steps is not None]
        if len(limits) != len(bounded):
            raise ValueError("only the last tier may have max_steps null")
        if any(a >= b for a, b in zip(limits, limits[1:])):
            raise ValueError("max_steps must increase from tier to tier")
        return tiers

    @field_validator("as_of", mode="before")
    @classmethod
    def _iso_string(cls, value: object) -> object:
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError("must be an ISO 8601 datetime string")
        return value
