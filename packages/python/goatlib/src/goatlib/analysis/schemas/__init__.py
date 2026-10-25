# Analysis schemas

from . import (
    data_management,
    geocoding,
    geoprocessing,
    heatmap,
    oev_gueteklasse,
    statistics,
    trip_count,
    ui,
)
from .base import (
    ALL_GEOMETRY_TYPES,
    POLYGON_TYPES,
    FieldStatistic,
    GeometryType,
    StatisticOperation,
)
from .catchment_area import (
    AccessEgressMode,
    CatchmentAreaRoutingMode,
    CatchmentAreaToolParams,
    CatchmentAreaType,
    PTMode,
    PTTimeWindow,
)
from .catchment_area_v2 import CatchmentAreaV2Params
from .data_management import (
    AttributeRelationship,
    JoinOperationType,
    JoinParams,
    JoinType,
    MergeParams,
    MultipleMatchingRecordsType,
    SortConfiguration,
    SpatialRelationshipType,
)
from .data_management import (
    SortOrder as JoinSortOrder,
)
from .geocoding import (
    SECTION_GEOCODING,
    FieldSourceType,
    GeocodingInputMode,
    GeocodingParams,
    GeocodingResult,
)
from .geoprocessing import (
    BufferParams,
    CentroidParams,
    ClipParams,
    DifferenceParams,
    IntersectionParams,
    OriginDestinationParams,
    UnionParams,
)
from .heatmap import (
    HeatmapClosestAverageParams,
    HeatmapConnectivityParams,
    HeatmapGravityParams,
    HeatmapRoutingMode,
    ImpedanceFunction,
    OpportunityClosestAverage,
    OpportunityGravity,
    RoutingMode,
)
from .oev_gueteklasse import (
    STATION_CONFIG_DEFAULT,
    OevGueteklasseParams,
    OevGueteklasseStationConfig,
)
from .oev_gueteklasse import (
    CatchmentType as OevCatchmentType,
)
from .oev_gueteklasse import (
    PTTimeWindow as OevPTTimeWindow,
)
from .statistics import (
    AreaOperation,
    AreaStatisticsGroup,
    AreaStatisticsInput,
    AreaStatisticsResult,
    ClassBreakMethod,
    ClassBreaksInput,
    ClassBreaksResult,
    FeatureCountInput,
    FeatureCountResult,
    SortOrder,
    UniqueValue,
    UniqueValuesInput,
    UniqueValuesResult,
)
from .trip_count import TripCountStationParams
from .ui import (
    SECTION_AREA,
    SECTION_CONFIGURATION,
    SECTION_INPUT,
    SECTION_INPUT_AGGREGATE,
    SECTION_OPPORTUNITIES,
    SECTION_OPTIONS,
    SECTION_OUTPUT,
    SECTION_ROUTING,
    SECTION_STATISTICS,
    SECTION_TIME,
    UIFieldConfig,
    UISection,
    layer_selector_field,
    merge_ui_field,
    ui_field,
    ui_sections,
)

__all__ = [
    # Modules
    "geoprocessing",
    "geocoding",
    "data_management",
    "statistics",
    "heatmap",
    "ui",
    # Base schemas
    "GeometryType",
    "ALL_GEOMETRY_TYPES",
    "POLYGON_TYPES",
    # UI schemas
    "UISection",
    "UIFieldConfig",
    "ui_field",
    "ui_sections",
    "merge_ui_field",
    "layer_selector_field",
    "SECTION_ROUTING",
    "SECTION_CONFIGURATION",
    "SECTION_INPUT",
    "SECTION_INPUT_AGGREGATE",
    "SECTION_OUTPUT",
    "SECTION_OPTIONS",
    "SECTION_OPPORTUNITIES",
    "SECTION_STATISTICS",
    "SECTION_TIME",
    "SECTION_AREA",
    # Geocoding schemas
    "GeocodingParams",
    "FieldSourceType",
    "GeocodingInputMode",
    "GeocodingResult",
    "SECTION_GEOCODING",
    # Geoprocessing schemas
    "BufferParams",
    "ClipParams",
    "IntersectionParams",
    "UnionParams",
    "DifferenceParams",
    "CentroidParams",
    "OriginDestinationParams",
    # Data management schemas
    "JoinParams",
    "MergeParams",
    "SpatialRelationshipType",
    "JoinOperationType",
    "MultipleMatchingRecordsType",
    "JoinType",
    "JoinSortOrder",
    "StatisticOperation",
    "AttributeRelationship",
    "SortConfiguration",
    "FieldStatistic",
    # Heatmap/Accessibility schemas
    "HeatmapGravityParams",
    "HeatmapConnectivityParams",
    "HeatmapClosestAverageParams",
    "OpportunityGravity",
    "OpportunityClosestAverage",
    "ImpedanceFunction",
    "RoutingMode",
    # Statistics schemas
    "ClassBreakMethod",
    "SortOrder",
    "AreaOperation",
    "FeatureCountInput",
    "AreaStatisticsInput",
    "UniqueValuesInput",
    "ClassBreaksInput",
    "FeatureCountResult",
    "UniqueValue",
    "UniqueValuesResult",
    "ClassBreaksResult",
    "AreaStatisticsGroup",
    "AreaStatisticsResult",
    # Catchment Area schemas
    "PTMode",
    "AccessEgressMode",
    "CatchmentAreaType",
    "CatchmentAreaRoutingMode",
    "CatchmentAreaToolParams",
    "CatchmentAreaV2Params",
    "PTTimeWindow",
    # ÖV-Güteklassen schemas
    "oev_gueteklasse",
    "OevGueteklasseParams",
    "OevGueteklasseStationConfig",
    "OevPTTimeWindow",
    "OevCatchmentType",
    "STATION_CONFIG_DEFAULT",
    # Trip Count schemas
    "trip_count",
    "TripCountStationParams",
]
