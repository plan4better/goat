from datetime import datetime, timezone
from typing import Annotated, Literal
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
    """Credits per unit: compute per minute, egress per GB, AI per 1000 tokens."""

    model_config = ConfigDict(extra="forbid")

    compute: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]
    egress: Annotated[
        float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)
    ]
    ai: Annotated[float, Field(ge=0, le=_MAX_AMOUNT, strict=True, allow_inf_nan=False)]


class BillingTermsPush(BaseModel):
    """The billing system's terms (docs/billing-interface.md), all of them at once."""

    model_config = ConfigDict(extra="forbid")

    trial: TrialTerms
    credit_rates: CreditRates
    as_of: datetime | None = None

    @field_validator("as_of", mode="before")
    @classmethod
    def _iso_string(cls, value: object) -> object:
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError("must be an ISO 8601 datetime string")
        return value
