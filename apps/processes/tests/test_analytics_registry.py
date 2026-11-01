"""Tests for analytics registry."""

from goatlib.analysis.statistics import AreaOperation

from processes.models.processes import (
    InputDescription,
    JobControlOptions,
    OutputDescription,
    ProcessDescription,
    ProcessSummary,
)
from processes.services.analytics_registry import (
    ANALYTICS_DEFINITIONS,
    AnalyticsRegistry,
    AreaStatisticsProcessInput,
    ClassBreaksProcessInput,
    FeatureCountProcessInput,
    UniqueValuesProcessInput,
    analytics_registry,
)


class TestAnalyticsProcessInputModels:
    """Tests for extended input models with collection field."""

    def test_feature_count_input(self):
        """Test FeatureCountProcessInput has collection field."""
        inp = FeatureCountProcessInput(
            collection="layer-123",
        )
        assert inp.collection == "layer-123"

    def test_unique_values_input(self):
        """Test UniqueValuesProcessInput has required fields."""
        inp = UniqueValuesProcessInput(
            collection="layer-123",
            attribute="category",
        )
        assert inp.collection == "layer-123"
        assert inp.attribute == "category"

    def test_class_breaks_input(self):
        """Test ClassBreaksProcessInput with required fields."""
        inp = ClassBreaksProcessInput(
            collection="layer-123",
            attribute="population",
        )
        assert inp.collection == "layer-123"
        assert inp.attribute == "population"

    def test_area_statistics_input(self):
        """Test AreaStatisticsProcessInput with required operation."""
        inp = AreaStatisticsProcessInput(
            collection="layer-123",
            operation=AreaOperation.sum,
        )
        assert inp.collection == "layer-123"
        assert inp.operation == AreaOperation.sum


class TestAnalyticsDefinitions:
    """Tests for ANALYTICS_DEFINITIONS dict."""

    def test_all_processes_defined(self):
        """Test all expected processes are defined."""
        expected = [
            "feature-count",
            "unique-values",
            "class-breaks",
            "area-statistics",
            "extent",
            "aggregation-stats",
            "histogram",
        ]
        for process_id in expected:
            assert process_id in ANALYTICS_DEFINITIONS

    def test_definition_structure(self):
        """Test each definition has required keys."""
        for process_id, definition in ANALYTICS_DEFINITIONS.items():
            assert "title" in definition, f"{process_id} missing title"
            assert "description" in definition, f"{process_id} missing description"
            assert "input_model" in definition, f"{process_id} missing input_model"
            assert "output_model" in definition, f"{process_id} missing output_model"
            assert "keywords" in definition, f"{process_id} missing keywords"

    def test_input_models_are_pydantic(self):
        """Test input models are Pydantic BaseModel subclasses."""
        from pydantic import BaseModel

        for process_id, definition in ANALYTICS_DEFINITIONS.items():
            assert issubclass(
                definition["input_model"], BaseModel
            ), f"{process_id} input_model not a Pydantic model"

    def test_output_models_are_pydantic(self):
        """Test output models are Pydantic BaseModel subclasses."""
        from pydantic import BaseModel

        for process_id, definition in ANALYTICS_DEFINITIONS.items():
            assert issubclass(
                definition["output_model"], BaseModel
            ), f"{process_id} output_model not a Pydantic model"


class TestAnalyticsRegistry:
    """Tests for AnalyticsRegistry class."""

    def test_singleton_instance(self):
        """Test analytics_registry is available as singleton."""
        assert analytics_registry is not None
        assert isinstance(analytics_registry, AnalyticsRegistry)

    def test_get_all_summaries(self):
        """Test getting all process summaries."""
        summaries = analytics_registry.get_all_summaries("http://localhost:8000")
        assert len(summaries) == 9
        process_ids = [s.id for s in summaries]
        assert "feature-count" in process_ids
        assert "unique-values" in process_ids
        assert "class-breaks" in process_ids
        assert "area-statistics" in process_ids
        assert "extent" in process_ids
        assert "aggregation-stats" in process_ids
        assert "histogram" in process_ids
        assert "layer-search" in process_ids
        assert "mirror-values" in process_ids

    def test_get_process_summary(self):
        """Test getting process summary."""
        base_url = "http://localhost:8000"
        summary = analytics_registry.get_process_summary("feature-count", base_url)

        assert summary is not None
        assert isinstance(summary, ProcessSummary)
        assert summary.id == "feature-count"
        assert summary.version == "1.0.0"
        assert summary.title == "Feature Count"
        assert JobControlOptions.sync_execute in summary.jobControlOptions

    def test_get_process_summary_not_found(self):
        """Test getting summary for nonexistent process."""
        summary = analytics_registry.get_process_summary(
            "nonexistent", "http://localhost"
        )
        assert summary is None

    def test_get_process_description(self):
        """Test getting full process description."""
        base_url = "http://localhost:8000"
        desc = analytics_registry.get_process_description("feature-count", base_url)

        assert desc is not None
        assert isinstance(desc, ProcessDescription)
        assert desc.id == "feature-count"

        # Check inputs
        assert "collection" in desc.inputs
        assert isinstance(desc.inputs["collection"], InputDescription)
        assert desc.inputs["collection"].minOccurs == 1  # Required

        # Check outputs
        assert "result" in desc.outputs
        assert isinstance(desc.outputs["result"], OutputDescription)

    def test_get_process_description_unique_values(self):
        """Test unique-values process has attribute input."""
        base_url = "http://localhost:8000"
        desc = analytics_registry.get_process_description("unique-values", base_url)

        assert desc is not None
        assert "attribute" in desc.inputs
        assert desc.inputs["attribute"].minOccurs == 1  # Required

    def test_get_process_description_class_breaks(self):
        """Test class-breaks process has attribute input."""
        base_url = "http://localhost:8000"
        desc = analytics_registry.get_process_description("class-breaks", base_url)

        assert desc is not None
        assert "attribute" in desc.inputs

    def test_get_process_description_not_found(self):
        """Test getting description for nonexistent process."""
        desc = analytics_registry.get_process_description(
            "nonexistent", "http://localhost"
        )
        assert desc is None

    def test_process_links(self):
        """Test process summary includes proper links."""
        base_url = "http://localhost:8000"
        summary = analytics_registry.get_process_summary("feature-count", base_url)

        assert summary.links is not None
        assert len(summary.links) > 0

        # Check self link
        self_link = next((link for link in summary.links if link.rel == "self"), None)
        assert self_link is not None
        assert "feature-count" in self_link.href

    def test_sync_only_job_control(self):
        """Test analytics processes support sync-execute."""
        base_url = "http://localhost:8000"
        summary = analytics_registry.get_process_summary("feature-count", base_url)

        # Analytics should support sync execution
        assert JobControlOptions.sync_execute in summary.jobControlOptions
