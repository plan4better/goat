"""Analytics process registry.

Auto-generates OGC Process descriptions from goatlib statistics schemas.
Includes support for i18n translation resolution based on Accept-Language header.
"""

import logging
import uuid
from typing import Any

from goatlib.analysis.statistics import (
    AggregationStatsInput,
    AggregationStatsResult,
    AreaStatisticsInput,
    AreaStatisticsResult,
    ClassBreaksInput,
    ClassBreaksResult,
    ExtentInput,
    ExtentResult,
    FeatureCountInput,
    FeatureCountResult,
    HistogramInput,
    HistogramResult,
    LayerSearchResult,
    UniqueValuesInput,
    UniqueValuesResult,
)
from pydantic import BaseModel, Field, field_validator

from processes.models.processes import (
    InputDescription,
    JobControlOptions,
    Link,
    OutputDescription,
    ProcessDescription,
    ProcessSummary,
    TransmissionMode,
)

logger = logging.getLogger(__name__)

# Default language for translations
DEFAULT_LANGUAGE = "en"

# Extended input models that add 'collection' field
# (goatlib inputs work on table names, we need layer IDs)


class FeatureCountProcessInput(FeatureCountInput):
    """Feature count input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class UniqueValuesProcessInput(UniqueValuesInput):
    """Unique values input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class MirrorValuesProcessInput(BaseModel):
    """Which attributes, or which values of one attribute, occur in the mirror for an area."""

    area: dict = Field(description="GeoJSON polygon the question is about")
    source: str = Field(
        "osm", description="Which mirrored source, e.g. osm or overture"
    )
    feature_type: str = Field(
        "points", description="OSM layer, or Overture type when source is overture"
    )
    key: str | None = Field(
        None, description="Attribute whose values to list; omitted lists the attributes"
    )
    limit: int = Field(100, ge=1, le=1000, description="Maximum entries")
    quick: bool = Field(
        False, description="Read a small sample first, without counts, for a fast list"
    )
    size_only: bool = Field(
        False, description="Only the estimate of features in the area, no list"
    )


class MirrorValue(BaseModel):
    value: str
    count: int


class MirrorValuesResult(BaseModel):
    key: str | None = None
    total: int = 0
    sampled: bool = Field(
        False, description="Counts are of a capped sample of the area, not totals"
    )
    complete: bool = Field(
        False, description="A quick read that saw the whole area: no full read needed"
    )
    estimate: int | None = Field(
        None, description="Features in the area, guessed from the mirror's index"
    )
    too_large: bool = Field(
        False, description="More in the area than one fetch reads: a fetch is refused"
    )
    values: list[MirrorValue] = Field(default_factory=list)


class ClassBreaksProcessInput(ClassBreaksInput):
    """Class breaks input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class AreaStatisticsProcessInput(AreaStatisticsInput):
    """Area statistics input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class ExtentProcessInput(ExtentInput):
    """Extent input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class AggregationStatsProcessInput(AggregationStatsInput):
    """Aggregation statistics input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class HistogramProcessInput(HistogramInput):
    """Histogram input with collection (layer ID)."""

    collection: str = Field(description="Layer ID (UUID)")


class LayerSearchLayerSpecInput(BaseModel):
    """One searchable layer in an editor-mode layer-search request."""

    layer_id: str = Field(description="Layer ID (UUID)")
    columns: list[str] = Field(
        min_length=1, max_length=3, description="Columns to match"
    )
    label_column: str | None = Field(
        default=None, description="Column shown as result label"
    )
    limit: int = Field(default=5, ge=1, le=10, description="Max results for this layer")


class LayerSearchProcessInput(BaseModel):
    """Cross-layer feature text search.

    Public mode: pass project_id (searchable layers resolved from the published
    snapshot). Editor mode: pass layers explicitly (requires authentication).
    """

    query: str = Field(min_length=2, max_length=100, description="Search text")
    map_center: list[float] | None = Field(
        default=None,
        min_length=2,
        max_length=2,
        description="[lon, lat] for proximity ranking",
    )
    project_id: uuid.UUID | None = Field(default=None, description="Public project ID")
    layers: list[LayerSearchLayerSpecInput] | None = Field(
        default=None, max_length=20, description="Explicit layers (editor mode)"
    )

    @field_validator("query")
    @classmethod
    def _strip_and_check_length(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 2:
            raise ValueError("query must have at least 2 non-whitespace characters")
        return stripped


# Analytics process definitions
ANALYTICS_DEFINITIONS: dict[str, dict[str, Any]] = {
    "feature-count": {
        "title": "Feature Count",
        "description": "Count features in a collection with optional filtering",
        "input_model": FeatureCountProcessInput,
        "output_model": FeatureCountResult,
        "keywords": ["analytics", "statistics", "count"],
        "tool_key": "feature_count",
        "hidden": True,
    },
    "unique-values": {
        "title": "Unique Values",
        "description": "Get unique values for an attribute with occurrence counts",
        "input_model": UniqueValuesProcessInput,
        "output_model": UniqueValuesResult,
        "keywords": ["analytics", "statistics", "unique", "values"],
        "tool_key": "unique_values",
        "hidden": True,
    },
    "mirror-values": {
        "title": "Mirror Values",
        "description": (
            "Attributes, or the values of one attribute, in the mirror for an area"
        ),
        "input_model": MirrorValuesProcessInput,
        "output_model": MirrorValuesResult,
        "keywords": ["analytics", "osm", "tags", "values"],
        "tool_key": "mirror_values",
        "hidden": True,
    },
    "class-breaks": {
        "title": "Class Breaks",
        "description": "Calculate classification breaks for a numeric attribute",
        "input_model": ClassBreaksProcessInput,
        "output_model": ClassBreaksResult,
        "keywords": ["analytics", "statistics", "classification", "breaks"],
        "tool_key": "class_breaks",
        "hidden": True,
    },
    "area-statistics": {
        "title": "Area Statistics",
        "description": "Calculate area statistics for polygon features",
        "input_model": AreaStatisticsProcessInput,
        "output_model": AreaStatisticsResult,
        "keywords": ["analytics", "statistics", "area", "polygon"],
        "tool_key": "area_statistics",
        "hidden": True,
    },
    "extent": {
        "title": "Layer Extent",
        "description": "Calculate bounding box extent of features with optional filtering",
        "input_model": ExtentProcessInput,
        "output_model": ExtentResult,
        "keywords": ["analytics", "extent", "bbox", "bounds"],
        "tool_key": "extent",
        "hidden": True,
    },
    "aggregation-stats": {
        "title": "Aggregation Statistics",
        "description": "Calculate aggregation statistics (sum, count, mean, min, max) with optional grouping",
        "input_model": AggregationStatsProcessInput,
        "output_model": AggregationStatsResult,
        "keywords": ["analytics", "statistics", "aggregation", "grouping"],
        "tool_key": "aggregation_stats",
        "hidden": True,
    },
    "histogram": {
        "title": "Histogram",
        "description": "Calculate histogram bins for a numeric column",
        "input_model": HistogramProcessInput,
        "output_model": HistogramResult,
        "keywords": ["analytics", "statistics", "histogram", "distribution"],
        "tool_key": "histogram",
        "hidden": True,
    },
    "layer-search": {
        "title": "Layer Search",
        "description": "Search feature attributes across project layers",
        "input_model": LayerSearchProcessInput,
        "output_model": LayerSearchResult,
        "keywords": ["analytics", "search", "features"],
        "tool_key": "layer_search",
        "hidden": True,
    },
}


def _pydantic_to_ogc_inputs(model: type[BaseModel]) -> dict[str, InputDescription]:
    """Convert Pydantic model to OGC input descriptions."""
    schema = model.model_json_schema()
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    defs = schema.get("$defs", {})

    inputs = {}
    for field_name, field_schema in properties.items():
        if "$ref" in field_schema:
            ref_name = field_schema["$ref"].split("/")[-1]
            ref_schema = defs.get(ref_name, {})
            # Merge: referenced schema as base, original field_schema overrides (except $ref)
            original_overrides = {k: v for k, v in field_schema.items() if k != "$ref"}
            field_schema = {**ref_schema, **original_overrides}

        is_required = field_name in required
        has_default = "default" in field_schema

        keywords = []
        if field_name == "collection":
            keywords = ["layer"]
        elif field_name == "attribute":
            keywords = ["field"]

        inputs[field_name] = InputDescription(
            title=field_schema.get("title", field_name.replace("_", " ").title()),
            description=field_schema.get("description"),
            schema=field_schema,
            minOccurs=1 if is_required and not has_default else 0,
            maxOccurs=1,
            keywords=keywords,
        )

    return inputs


def _pydantic_to_ogc_output(model: type[BaseModel]) -> dict[str, OutputDescription]:
    """Convert Pydantic model to OGC output description."""
    schema = model.model_json_schema()

    return {
        "result": OutputDescription(
            title="Result",
            description=model.__doc__ or "Process result",
            schema=schema,
        )
    }


class AnalyticsRegistry:
    """Registry for analytics processes."""

    def __init__(self) -> None:
        self._definitions = ANALYTICS_DEFINITIONS
        self._translator_cache: dict[str, Any] = {}

    def _get_translator(self, language: str) -> Any:
        """Get cached translator for a language."""
        if language not in self._translator_cache:
            try:
                from goatlib.i18n import get_translator

                self._translator_cache[language] = get_translator(language)
            except ImportError:
                logger.warning("goatlib.i18n not available, translations disabled")
                self._translator_cache[language] = None
        return self._translator_cache[language]

    def _translate_tool(
        self, defn: dict[str, Any], language: str | None = None
    ) -> tuple[str, str]:
        """Get translated title and description for a tool."""
        title = defn["title"]
        description = defn["description"]

        if not language or language == DEFAULT_LANGUAGE:
            return title, description

        translator = self._get_translator(language)
        if not translator:
            return title, description

        tool_key = defn.get("tool_key")
        if tool_key:
            translated_title = translator.get_tool_title(tool_key)
            translated_desc = translator.get_tool_description(tool_key)
            if translated_title:
                title = translated_title
            if translated_desc:
                description = translated_desc

        return title, description

    def _translate_inputs(
        self,
        inputs: dict[str, InputDescription],
        language: str | None = None,
    ) -> dict[str, InputDescription]:
        """Translate input descriptions."""
        if not language or language == DEFAULT_LANGUAGE:
            return inputs

        translator = self._get_translator(language)
        if not translator:
            return inputs

        translated = {}
        for name, inp in inputs.items():
            field_key = name.lower().replace("-", "_")
            new_title = translator.get_field_label(field_key) or inp.title
            new_desc = translator.get_field_description(field_key) or inp.description

            translated[name] = InputDescription(
                title=new_title,
                description=new_desc,
                schema=inp.schema_,
                minOccurs=inp.minOccurs,
                maxOccurs=inp.maxOccurs,
                keywords=inp.keywords,
            )

        return translated

    def get_process_ids(self) -> list[str]:
        """Get list of all analytics process IDs."""
        return list(self._definitions.keys())

    def is_analytics_process(self, process_id: str) -> bool:
        """Check if a process ID is an analytics process."""
        return process_id in self._definitions

    def get_process_summary(
        self, process_id: str, base_url: str, language: str | None = None
    ) -> ProcessSummary | None:
        """Get process summary for an analytics process."""
        if process_id not in self._definitions:
            return None

        defn = self._definitions[process_id]
        title, description = self._translate_tool(defn, language)

        return ProcessSummary(
            id=process_id,
            title=title,
            description=description,
            version="1.0.0",
            keywords=defn.get("keywords", ["analytics"]),
            jobControlOptions=[JobControlOptions.sync_execute],
            outputTransmission=[TransmissionMode.value],
            x_ui_toolbox_hidden=defn.get("hidden", False),
            links=[
                Link(
                    href=f"{base_url}/processes/{process_id}",
                    rel="self",
                    type="application/json",
                    title=title,
                ),
            ],
        )

    def get_process_description(
        self, process_id: str, base_url: str, language: str | None = None
    ) -> ProcessDescription | None:
        """Get full process description for an analytics process."""
        if process_id not in self._definitions:
            return None

        defn = self._definitions[process_id]
        input_model = defn["input_model"]
        output_model = defn["output_model"]

        title, description = self._translate_tool(defn, language)
        inputs = _pydantic_to_ogc_inputs(input_model)
        inputs = self._translate_inputs(inputs, language)

        return ProcessDescription(
            id=process_id,
            title=title,
            description=description,
            version="1.0.0",
            keywords=defn.get("keywords", ["analytics"]),
            jobControlOptions=[JobControlOptions.sync_execute],
            outputTransmission=[TransmissionMode.value],
            inputs=inputs,
            outputs=_pydantic_to_ogc_output(output_model),
            links=[
                Link(
                    href=f"{base_url}/processes/{process_id}",
                    rel="self",
                    type="application/json",
                    title=title,
                ),
                Link(
                    href=f"{base_url}/processes/{process_id}/execution",
                    rel="http://www.opengis.net/def/rel/ogc/1.0/execute",
                    type="application/json",
                    title="Execute process",
                ),
            ],
        )

    def get_all_summaries(
        self, base_url: str, language: str | None = None
    ) -> list[ProcessSummary]:
        """Get summaries for all analytics processes."""
        summaries = []
        for process_id in self._definitions:
            summary = self.get_process_summary(process_id, base_url, language)
            if summary:
                summaries.append(summary)
        return summaries


# Singleton instance
analytics_registry = AnalyticsRegistry()
