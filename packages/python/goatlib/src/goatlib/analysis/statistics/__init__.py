"""Statistics analysis tools for vector data.

This module provides functions for calculating various statistics on DuckDB tables:
- Feature count: Count features with optional filtering
- Unique values: Get unique values with occurrence counts
- Class breaks: Calculate classification breaks using various methods
- Area statistics: Calculate area-based statistics for polygon features
- Extent: Calculate bounding box extent with optional filtering
- Aggregation stats: Calculate grouped aggregation statistics (sum, count, mean, etc.)
- Histogram: Calculate histogram bins for numeric columns
"""

from goatlib.analysis.schemas.statistics import (
    AggregationStatsInput,
    AggregationStatsItem,
    AggregationStatsResult,
    AreaOperation,
    AreaStatisticsGroup,
    AreaStatisticsInput,
    AreaStatisticsResult,
    ClassBreakMethod,
    ClassBreaksInput,
    ClassBreaksResult,
    ExtentInput,
    ExtentResult,
    FeatureCountInput,
    FeatureCountResult,
    HistogramBin,
    HistogramBreakMethod,
    HistogramInput,
    HistogramResult,
    LayerSearchGroup,
    LayerSearchItem,
    LayerSearchResult,
    SortOrder,
    StatisticsOperation,
    UniqueValue,
    UniqueValuesInput,
    UniqueValuesResult,
)
from goatlib.analysis.statistics.aggregation_stats import calculate_aggregation_stats
from goatlib.analysis.statistics.area_statistics import calculate_area_statistics
from goatlib.analysis.statistics.class_breaks import calculate_class_breaks
from goatlib.analysis.statistics.extent import calculate_extent
from goatlib.analysis.statistics.feature_count import calculate_feature_count
from goatlib.analysis.statistics.histogram import calculate_histogram
from goatlib.analysis.statistics.layer_search import search_layer_features
from goatlib.analysis.statistics.unique_values import calculate_unique_values

__all__ = [
    # Functions
    "calculate_feature_count",
    "calculate_unique_values",
    "calculate_class_breaks",
    "calculate_area_statistics",
    "calculate_extent",
    "calculate_aggregation_stats",
    "calculate_histogram",
    "search_layer_features",
    # Schemas - Enums
    "ClassBreakMethod",
    "SortOrder",
    "AreaOperation",
    "StatisticsOperation",
    "HistogramBreakMethod",
    # Schemas - Inputs
    "FeatureCountInput",
    "AreaStatisticsInput",
    "UniqueValuesInput",
    "ClassBreaksInput",
    "ExtentInput",
    "AggregationStatsInput",
    "HistogramInput",
    # Schemas - Results
    "FeatureCountResult",
    "UniqueValue",
    "UniqueValuesResult",
    "ClassBreaksResult",
    "AreaStatisticsGroup",
    "AreaStatisticsResult",
    "ExtentResult",
    "AggregationStatsItem",
    "AggregationStatsResult",
    "HistogramBin",
    "HistogramResult",
    "LayerSearchItem",
    "LayerSearchGroup",
    "LayerSearchResult",
]
