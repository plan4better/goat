"""Modular environmental walkability impedance parameters for routing.

Provides shared parameters and validation for sun exposure (shade),
urban heat island effect (heat), and uphill walking slope impedance.
"""

from __future__ import annotations

from typing import Any, Self

from pydantic import BaseModel, Field, model_validator


class EnvironmentalWalkabilityParams(BaseModel):
    """Modular multi-criteria walking impedance parameters."""

    shade_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=5.0,
        description=(
            "Penalty weight for sun exposure / lack of canopy (0.0 = disabled; "
            "edge impedance is normalized in [0.0, 1.0] where 0.0 = fully shaded, 1.0 = direct unshaded exposure)"
        ),
    )
    heat_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=5.0,
        description=(
            "Penalty weight for Urban Heat Island / high surface temperature zones "
            "(0.0 = disabled; edge impedance is normalized in [0.0, 1.0])"
        ),
    )
    slope_walk_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=3.0,
        description="Penalty weight for uphill walking exertion (0.0 = disabled)",
    )

    @model_validator(mode="after")
    def validate_environmental_routing_mode_and_cost_type(self: Self) -> Self:
        has_weights = (
            getattr(self, "shade_weight", 0.0) > 0.0
            or getattr(self, "heat_weight", 0.0) > 0.0
            or getattr(self, "slope_walk_weight", 0.0) > 0.0
        )
        if has_weights:
            mode: Any = getattr(self, "routing_mode", None)
            if mode is not None:
                mode_val = mode.value if hasattr(mode, "value") else str(mode)
                if mode_val.lower() != "walking":
                    raise ValueError(
                        f"Environmental walkability weights are only supported for walking routing mode, got '{mode_val}'"
                    )
            cost_type: Any = getattr(self, "cost_type", None)
            if cost_type is not None:
                ct_val = (
                    cost_type.value if hasattr(cost_type, "value") else str(cost_type)
                )
                if ct_val.lower() != "time":
                    raise ValueError(
                        f"Environmental walkability weights are only supported for time cost type, got '{ct_val}'"
                    )
        return self
