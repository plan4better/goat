"""Unit tests for aggregate tool params validators.

Tests custom validation logic in AggregatePointsToolParams and AggregatePolygonToolParams.
"""

import pytest
from goatlib.analysis.schemas.aggregate import (
    AggregateFieldStatistic,
    AggregatePolygonFieldStatistic,
    AggregationAreaType,
)
from goatlib.tools.aggregate_points import AggregatePointsToolParams
from goatlib.tools.aggregate_polygon import AggregatePolygonToolParams


class TestAggregatePointsParamsValidation:
    """Test custom validators in AggregatePointsToolParams."""

    # Required test IDs for ToolInputBase
    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "folder_id": "00000000-0000-0000-0000-000000000002",
        "source_layer_id": "00000000-0000-0000-0000-000000000003",
        "column_statistics": [AggregateFieldStatistic(field="value", operation="sum")],
    }

    def test_polygon_requires_area_layer(self):
        """area_type='polygon' requires area_layer_id."""
        with pytest.raises(ValueError, match="area_layer_id is required"):
            AggregatePointsToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.polygon,
                area_layer_id=None,
            )

    def test_polygon_rejects_h3_resolution(self):
        """area_type='polygon' should not have h3_resolution."""
        with pytest.raises(ValueError, match="h3_resolution should not be provided"):
            AggregatePointsToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.polygon,
                area_layer_id="00000000-0000-0000-0000-000000000004",
                h3_resolution=8,
            )

    def test_h3_grid_requires_resolution(self):
        """area_type='h3_grid' requires h3_resolution."""
        with pytest.raises(ValueError, match="h3_resolution is required"):
            AggregatePointsToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=None,
            )

    def test_h3_grid_rejects_area_layer(self):
        """area_type='h3_grid' should not have area_layer_id."""
        with pytest.raises(ValueError, match="area_layer_id should not be provided"):
            AggregatePointsToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=8,
                area_layer_id="00000000-0000-0000-0000-000000000004",
            )

    # Valid cases
    def test_valid_polygon_params(self):
        """Valid polygon area params should pass."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            area_type=AggregationAreaType.polygon,
            area_layer_id="00000000-0000-0000-0000-000000000004",
        )
        assert params.area_type == AggregationAreaType.polygon

    def test_valid_h3_params(self):
        """Valid H3 grid params should pass."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=8,
        )
        assert params.h3_resolution == 8


class TestAggregatePolygonParamsValidation:
    """Test custom validators in AggregatePolygonToolParams."""

    # Required test IDs for ToolInputBase
    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "folder_id": "00000000-0000-0000-0000-000000000002",
        "source_layer_id": "00000000-0000-0000-0000-000000000003",
        "column_statistics": [
            AggregatePolygonFieldStatistic(field="area", operation="sum")
        ],
    }

    def test_polygon_requires_area_layer(self):
        """area_type='polygon' requires area_layer_id."""
        with pytest.raises(ValueError, match="area_layer_id is required"):
            AggregatePolygonToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.polygon,
                area_layer_id=None,
            )

    def test_h3_grid_requires_resolution(self):
        """area_type='h3_grid' requires h3_resolution."""
        with pytest.raises(ValueError, match="h3_resolution is required"):
            AggregatePolygonToolParams(
                **self.BASE_PARAMS,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=None,
            )

    # Valid cases
    def test_valid_polygon_params(self):
        """Valid polygon area params should pass."""
        params = AggregatePolygonToolParams(
            **self.BASE_PARAMS,
            area_type=AggregationAreaType.polygon,
            area_layer_id="00000000-0000-0000-0000-000000000004",
        )
        assert params.area_type == AggregationAreaType.polygon

    def test_valid_h3_params(self):
        """Valid H3 grid params should pass."""
        params = AggregatePolygonToolParams(
            **self.BASE_PARAMS,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=6,
        )
        assert params.h3_resolution == 6


class TestColumnStatisticsConversion:
    """Test column_statistics single-dict-to-list conversion and custom result_name."""

    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "folder_id": "00000000-0000-0000-0000-000000000002",
        "source_layer_id": "00000000-0000-0000-0000-000000000003",
        "area_type": AggregationAreaType.h3_grid,
        "h3_resolution": 8,
    }

    def test_single_dict_converted_to_list(self):
        """A single dict for column_statistics should be converted to a list."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            column_statistics={"operation": "sum", "field": "value"},
        )
        assert isinstance(params.column_statistics, list)
        assert len(params.column_statistics) == 1
        assert params.column_statistics[0].operation.value == "sum"
        assert params.column_statistics[0].field == "value"

    def test_list_remains_list(self):
        """A list for column_statistics should remain a list."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            column_statistics=[{"operation": "sum", "field": "value"}],
        )
        assert isinstance(params.column_statistics, list)
        assert len(params.column_statistics) == 1

    def test_custom_result_name_preserved(self):
        """Custom result_name should be preserved."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            column_statistics={
                "operation": "sum",
                "field": "value",
                "result_name": "my_custom_sum",
            },
        )
        assert params.column_statistics[0].result_name == "my_custom_sum"

    def test_count_operation_with_custom_name(self):
        """Count operation with custom result_name should work."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            column_statistics={"operation": "count", "result_name": "total_count"},
        )
        assert params.column_statistics[0].operation.value == "count"
        assert params.column_statistics[0].result_name == "total_count"
        assert params.column_statistics[0].field is None

    def test_count_operation_default_name(self):
        """Count operation without custom name should use default."""
        params = AggregatePointsToolParams(
            **self.BASE_PARAMS,
            column_statistics={"operation": "count"},
        )
        assert params.column_statistics[0].operation.value == "count"
        assert params.column_statistics[0].result_name is None
        # get_result_column_name() should return "count"
        assert params.column_statistics[0].get_result_column_name() == "count"

    def test_polygon_tool_single_dict_conversion(self):
        """AggregatePolygonToolParams also converts single dict to list."""
        params = AggregatePolygonToolParams(
            user_id="00000000-0000-0000-0000-000000000001",
            folder_id="00000000-0000-0000-0000-000000000002",
            source_layer_id="00000000-0000-0000-0000-000000000003",
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=6,
            column_statistics={
                "operation": "mean",
                "field": "area",
                "result_name": "avg_area",
            },
        )
        assert isinstance(params.column_statistics, list)
        assert len(params.column_statistics) == 1
        assert params.column_statistics[0].result_name == "avg_area"
