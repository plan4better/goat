"""Common schemas for Windmill tool scripts.

These schemas define the standard input/output contracts for all tools,
ensuring consistency across buffer, clip, join, layer-import, etc.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from goatlib.analysis.schemas.ui import ui_field
from goatlib.i18n import get_translator, supported_language

# What the web's network selectors answer for the default network
# (`DEFAULT_NETWORK_BUNDLE` in BundleInput.tsx). It names no bundle.
DEFAULT_NETWORK_BUNDLE = "default"


def get_default_layer_name(layer_key: str, lang: str = "en") -> str:
    """Get default layer name for a tool from i18n translations.

    Args:
        layer_key: Key from default_layer_names in translation files
        lang: Language code ("en" or "de")

    Returns:
        Default layer name in the specified language, or the key if not found
    """
    translator = get_translator(lang)
    name = translator.get_default_layer_name(layer_key)
    return name if name else layer_key


class ToolInputBase(BaseModel):
    """Base inputs that ALL tools receive.

    Every Windmill tool script should accept these parameters.
    GeoAPI injects `user_id` and `triggered_by_email` automatically from the auth token;
    processes injects `language` from the request's Accept-Language.

    folder_id is optional - if not provided, it will be derived from project_id.
    For layer imports outside a project, folder_id must be provided.
    """

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="before")
    @classmethod
    def _default_network_is_no_bundle(cls, data: Any) -> Any:
        """A network selector set to the default network names no bundle.

        The toolbox leaves the selector's "default" out of a request, but a
        workflow saves it in its node's config; every tool reads a missing
        network bundle as the default network.
        """
        if isinstance(data, dict):
            return {
                key: None
                if key.endswith("_network_bundle_id")
                and value == DEFAULT_NETWORK_BUNDLE
                else value
                for key, value in data.items()
            }
        return data

    @field_validator("language", mode="before")
    @classmethod
    def _only_a_supported_language(cls, value: Any) -> str | None:
        """A language the translations hold, without its region; any other
        value is no language, so the titles are English."""
        return supported_language(value)

    user_id: str = Field(
        ...,
        description="User UUID (injected by GeoAPI)",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    triggered_by_email: str | None = Field(
        None,
        alias="_triggered_by_email",
        description="User email (injected by GeoAPI for job tracking/Windmill labels)",
        json_schema_extra=ui_field(section="output", field_order=100, hidden=True),
    )
    language: str | None = Field(
        None,
        description="Language of the legend titles the run writes (injected by "
        "processes from the request; English when not given)",
        json_schema_extra=ui_field(section="output", field_order=101, hidden=True),
    )
    folder_id: str | None = Field(
        None,
        description="Destination folder UUID for output layer. If not provided, derived from project_id.",
        json_schema_extra=ui_field(section="output", field_order=98, hidden=True),
    )
    project_id: str | None = Field(
        None,
        description="If provided, add result layer to this project",
        json_schema_extra=ui_field(section="output", field_order=97, hidden=True),
    )
    result_layer_name: str | None = Field(
        None,
        description="Custom name for result layer. Uses tool default if not specified.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget="layer-name-input",
        ),
    )
    # Keep output_name as alias for backward compatibility
    output_name: str | None = Field(
        None,
        description="Deprecated: Use result_layer_name instead",
        json_schema_extra=ui_field(section="output", field_order=1, hidden=True),
    )

    # Workflow temp mode fields - for writing to /data/temporary/ instead of DuckLake
    temp_mode: bool = Field(
        False,
        description="If True, write to temp storage instead of DuckLake (for workflow preview)",
        json_schema_extra=ui_field(section="output", field_order=90, hidden=True),
    )
    workflow_id: str | None = Field(
        None,
        description="Workflow UUID (required when temp_mode=True)",
        json_schema_extra=ui_field(section="output", field_order=91, hidden=True),
    )
    node_id: str | None = Field(
        None,
        description="Node ID in workflow (required when temp_mode=True)",
        json_schema_extra=ui_field(section="output", field_order=92, hidden=True),
    )


class LayerInputMixin(BaseModel):
    """Mixin for tools that take a single layer as input.

    Use with ToolInputBase:
        class BufferParams(ToolInputBase, LayerInputMixin):
            distance: float

    The filter is a CQL2-JSON object that will be applied when reading the layer.
    """

    input_layer_id: str = Field(
        ...,
        description="Source layer UUID from DuckLake",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    input_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the input layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )


class TwoLayerInputMixin(BaseModel):
    """Mixin for tools that take two layers as input (e.g., clip, join, intersect).

    Use with ToolInputBase:
        class ClipParams(ToolInputBase, TwoLayerInputMixin):
            pass

    Each layer can have its own CQL2-JSON filter.
    """

    input_layer_id: str = Field(
        ...,
        description="Primary input layer UUID",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    input_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the input layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )
    overlay_layer_id: str = Field(
        ...,
        description="Overlay/clip/join layer UUID",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the overlay layer",
        json_schema_extra=ui_field(section="overlay", field_order=2, hidden=True),
    )


class ToolOutputBase(BaseModel):
    """Standard output that all tools return.

    This ensures consistent response format for the frontend/job results.
    Includes wm_labels for Windmill job labeling at runtime.
    """

    # Identity
    layer_id: str = Field(..., description="UUID of the created layer")
    name: str = Field(..., description="Layer display name")

    # Windmill job labels - returned at runtime for job tracking
    # See: https://www.windmill.dev/docs/core_concepts/jobs#labels
    wm_labels: list[str] = Field(
        default_factory=list,
        description="Labels to apply to the Windmill job for filtering/tracking",
    )

    # Location
    folder_id: str = Field(..., description="Folder containing the layer")
    user_id: str = Field(..., description="Owner user UUID")

    # Project association (if requested)
    project_id: str | None = Field(None, description="Project UUID if added to project")
    layer_project_id: int | None = Field(
        None, description="layer_project link ID if added to project"
    )

    # Layer metadata
    type: str = Field("feature", description="Layer type: feature or table")
    feature_layer_type: str | None = Field(
        "tool",
        description="Feature layer type: standard, tool, street_network (None for tables)",
    )
    geometry_type: str | None = Field(
        None, description="Geometry type: point, line, polygon, or None for tables"
    )
    feature_count: int = Field(0, description="Number of features/rows")
    extent: Any | None = Field(None, description="Spatial extent (WKT or dict)")

    # Storage reference
    table_name: str | None = Field(None, description="DuckLake table name")
