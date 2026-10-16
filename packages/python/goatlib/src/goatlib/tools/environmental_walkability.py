"""Windmill UI parameter mixin for environmental walkability."""

from __future__ import annotations

from pydantic import Field

from goatlib.analysis.schemas.environmental_walkability import (
    EnvironmentalWalkabilityParams,
)
from goatlib.analysis.schemas.ui import ui_field


class EnvironmentalWalkabilityWindmillParams(EnvironmentalWalkabilityParams):
    """Environmental walkability parameters with Windmill UI metadata."""

    shade_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=5.0,
        description=(
            "Penalty weight for sun exposure / lack of canopy (0.0 = disabled; "
            "edge impedance is normalized in [0.0, 1.0] where 0.0 = fully shaded, 1.0 = direct unshaded exposure)."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=20,
            visible_when={"routing_mode": "walking"},
        ),
    )
    heat_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=5.0,
        description=(
            "Penalty weight for Urban Heat Island / high surface temperature zones "
            "(0.0 = disabled; edge impedance is normalized in [0.0, 1.0])."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=21,
            visible_when={"routing_mode": "walking"},
        ),
    )
    slope_walk_weight: float = Field(
        default=0.0,
        ge=0.0,
        le=3.0,
        description="Penalty weight for uphill walking exertion (0.0 = disabled).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=22,
            visible_when={"routing_mode": "walking"},
        ),
    )
