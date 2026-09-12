"""Geocoding tool for Windmill.

Geocodes addresses from an input layer using Pelias geocoder service.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import Field

from goatlib.analysis.geoanalysis.geocoding import GeocodingTool
from goatlib.analysis.schemas.geocoding import (
    FieldSourceType,
    GeocodingInputMode,
    GeocodingParams,
)
from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    SECTION_RESULT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    LayerInputMixin,
    ToolInputBase,
    get_default_layer_name,
)

logger = logging.getLogger(__name__)


# =============================================================================
# UI Section
# =============================================================================

SECTION_GEOCODING = UISection(
    id="geocoding",
    order=2,
    icon="location-marker",
)

# Input mode labels for i18n (maps enum values to translation keys)
INPUT_MODE_LABELS: dict[str, str] = {
    "full_address": "enums.input_mode.full_address",
    "structured": "enums.input_mode.structured",
}


# =============================================================================
# Tool Parameters
# =============================================================================


class GeocodingToolParams(ToolInputBase, LayerInputMixin):
    """Parameters for geocoding tool.

    Inherits geocoding options from GeocodingParams, adds layer context from ToolInputBase.
    input_path/output_path are not used (we use layer IDs instead).

    Geocoder credentials come from environment variables:
    - GEOCODING_URL: Pelias geocoder service URL
    - GEOCODING_AUTHORIZATION: Basic auth header
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_INPUT,
            SECTION_GEOCODING,
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    }

    # Override input_layer_id to restrict to non-spatial layers (tables)
    input_layer_id: str = Field(
        ...,
        description="Source table layer with address data",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            widget_options={"data_types": ["table"], "geometry_types": ["no_geometry"]},
        ),
    )

    # === Input Mode Selection ===
    input_mode: GeocodingInputMode = Field(
        default=GeocodingInputMode.full_address,
        description="How address input is provided",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=1,
            widget="radio",
            enum_labels=INPUT_MODE_LABELS,
            enum_icons={
                "full_address": "text",
                "structured": "table",
            },
        ),
    )

    # === Full Address Mode ===
    full_address_field: str | None = Field(
        default=None,
        description="Column containing complete address (e.g., 'Marienplatz 1, Munich, Germany')",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "types": ["string"]},
            visible_when={"input_mode": "full_address"},
        ),
    )

    # === Structured Mode Fields (order: Street, Postal, City, Region, Country) ===

    # Street address (required)
    address_field: str | None = Field(
        default=None,
        description="Column for street address (e.g., 'Marienplatz 1')",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=10,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "types": ["string"]},
            visible_when={"input_mode": "structured"},
        ),
    )

    # Postal code (optional)
    postalcode_field: str | None = Field(
        default=None,
        description="Column for postal/ZIP code (optional)",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=15,
            widget="field-selector",
            widget_options={
                "source_layer": "input_layer_id",
                "types": ["string", "number"],
            },
            visible_when={"input_mode": "structured"},
        ),
    )

    # City/locality (optional)
    locality_field: str | None = Field(
        default=None,
        description="Column for city/town (optional)",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=20,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "types": ["string"]},
            visible_when={"input_mode": "structured"},
        ),
    )

    # Region/state (optional, advanced)
    region_field: str | None = Field(
        default=None,
        description="Column for state/province/region (optional)",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=25,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "types": ["string"]},
            visible_when={"input_mode": "structured"},
            advanced=True,
            optional=True,
        ),
    )

    # Country (optional)
    country_field: str | None = Field(
        default=None,
        description="Column for country name or ISO code (optional)",
        json_schema_extra=ui_field(
            section="geocoding",
            field_order=30,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "types": ["string"]},
            visible_when={"input_mode": "structured"},
            optional=True,
        ),
    )

    # === Result Layer Naming ===
    result_layer_name: str | None = Field(
        default=get_default_layer_name("geocoding", "en"),
        description="Name for the geocoded result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("geocoding", "en"),
                "default_de": get_default_layer_name("geocoding", "de"),
            },
        ),
    )


# =============================================================================
# Tool Runner
# =============================================================================


class GeocodingToolRunner(BaseToolRunner[GeocodingToolParams]):
    """Geocoding tool runner for Windmill."""

    tool_class = GeocodingTool
    output_geometry_type = "Point"
    default_output_name = get_default_layer_name("geocoding", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict geocoding output schema.

        Geocoding outputs:
        - All input columns (preserves original data)
        - geocode_status: SUCCESS, PARTIAL, NO_MATCH, etc.
        - geocode_confidence: confidence score 0-1
        - geocode_label: formatted address from geocoder
        - geometry: Point geometry from geocoding result
        """
        input_layer = input_schemas.get("input_layer_id", {})
        columns = dict(input_layer)

        # Add geocoding result columns
        columns["geocode_input_text"] = "VARCHAR"
        columns["geocode_latitude"] = "DOUBLE"
        columns["geocode_longitude"] = "DOUBLE"
        columns["geocode_confidence"] = "DOUBLE"
        columns["geocode_match_type"] = "VARCHAR"
        columns["geocode_label"] = "VARCHAR"
        columns["geocode_postalcode"] = "VARCHAR"
        columns["geometry"] = "GEOMETRY"

        return columns

    def get_layer_properties(
        self: Self,
        params: GeocodingToolParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        """Return style for geocoded output - simple point markers."""
        # Import here to avoid circular imports
        from goatlib.tools.style import DEFAULT_POINT_STYLE, hex_to_rgb

        # Blue color for geocoded points
        color = hex_to_rgb("#3B82F6")

        return {
            "color": color,
            **DEFAULT_POINT_STYLE,
            "radius": 6,
            "stroked": True,
            "stroke_color": [255, 255, 255],
            "stroke_width": 2,
        }

    def process(
        self: Self, params: GeocodingToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run geocoding analysis."""
        # Export source layer to parquet
        input_path = str(
            self.export_layer_to_parquet(
                layer_id=params.input_layer_id,
                user_id=params.user_id,
                cql_filter=params.input_layer_filter,
            )
        )
        output_path = temp_dir / "output.parquet"

        # Get geocoder credentials from settings
        geocoder_url = self.settings.geocoding_url
        geocoder_authorization = self.settings.geocoding_authorization

        if not all([geocoder_url, geocoder_authorization]):
            raise ValueError(
                "Geocoder credentials not configured. "
                "Set GEOCODING_URL and GEOCODING_AUTHORIZATION environment variables."
            )

        # Build analysis params from tool params
        # Determine source types based on whether fields are set
        # If field is set, use field; otherwise use constant (which may be None)
        locality_source_type = (
            FieldSourceType.field if params.locality_field else FieldSourceType.constant
        )
        region_source_type = (
            FieldSourceType.field if params.region_field else FieldSourceType.constant
        )
        country_source_type = (
            FieldSourceType.field if params.country_field else FieldSourceType.constant
        )

        analysis_params = GeocodingParams(
            input_path=input_path,
            output_path=str(output_path),
            input_mode=params.input_mode,
            full_address_field=params.full_address_field,
            address_field=params.address_field,
            locality_source_type=locality_source_type,
            locality_field=params.locality_field,
            locality_constant=None,  # Not used in simplified UI
            region_source_type=region_source_type,
            region_field=params.region_field,
            region_constant=None,  # Not used in simplified UI
            postalcode_field=params.postalcode_field,
            country_source_type=country_source_type,
            country_field=params.country_field,
            country_constant=None,  # Removed from simplified UI
            geocoder_url=geocoder_url,
            geocoder_authorization=geocoder_authorization,
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: GeocodingToolParams) -> dict:
    """Windmill entry point for geocoding tool."""
    runner = GeocodingToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
