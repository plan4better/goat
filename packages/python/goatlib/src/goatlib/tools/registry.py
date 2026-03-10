"""Centralized tool registry for GOAT tools.

This module provides a single source of truth for all tool definitions.
GeoAPI and other services can import from here instead of duplicating
tool registration logic.

Example:
    from goatlib.tools.registry import TOOL_REGISTRY, ToolDefinition

    # Get all tools
    for tool in TOOL_REGISTRY:
        print(f"{tool.name}: {tool.description}")

    # Find a specific tool
    buffer_tool = next(t for t in TOOL_REGISTRY if t.name == "buffer")
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Self

if TYPE_CHECKING:
    from goatlib.tools.schemas import ToolInputBase


@dataclass(frozen=True)
class ToolDefinition:
    """Definition of a GOAT tool for registration.

    Attributes:
        name: Short lowercase name used as process ID (e.g., "buffer")
        display_name: Human-readable name (e.g., "Buffer")
        description: Short description for API docs
        module_path: Python module path (e.g., "goatlib.tools.buffer")
        params_class_name: Name of the Params class in the module
        windmill_path: Windmill script path (e.g., "f/goat/buffer")
        category: Tool category for grouping (e.g., "geoprocessing", "data")
        keywords: Search keywords for discovery
        toolbox_hidden: If True, hide from toolbox UI (still available via API)
        docs_path: Path to documentation (appended to docs base URL)
        worker_tag: Windmill worker tag for job routing (e.g., "tools", "print")
    """

    name: str
    display_name: str
    description: str
    module_path: str
    params_class_name: str
    windmill_path: str
    category: str = "geoprocessing"
    keywords: tuple[str, ...] = ()
    toolbox_hidden: bool = False
    docs_path: str | None = None
    worker_tag: str = "tools"

    def get_params_class(self: Self) -> type["ToolInputBase"]:
        """Dynamically import and return the params class."""
        import importlib

        module = importlib.import_module(self.module_path)
        return getattr(module, self.params_class_name)

    def get_runner_class(self: Self) -> type | None:
        """Dynamically import and return the tool runner class.

        Returns the class ending with 'ToolRunner' from the module.
        """
        import importlib

        module = importlib.import_module(self.module_path)
        # Find the ToolRunner class in the module
        for name in dir(module):
            if name.endswith("ToolRunner") and not name.startswith("Base"):
                cls = getattr(module, name)
                # Verify it's actually a class
                if isinstance(cls, type):
                    return cls
        return None

    def get_output_geometry_type(self: Self) -> str | None:
        """Get the output geometry type from the tool runner.

        Returns:
            Geometry type string (e.g., "polygon", "point", "line") or None
        """
        runner_class = self.get_runner_class()
        if runner_class and hasattr(runner_class, "output_geometry_type"):
            return runner_class.output_geometry_type
        return None


# Central registry of all GOAT tools
TOOL_REGISTRY: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        name="buffer",
        display_name="Buffer",
        description="Creates buffer polygons around input features at a specified distance",
        module_path="goatlib.tools.buffer",
        params_class_name="BufferToolParams",
        windmill_path="f/goat/tools/buffer",
        category="geoprocessing",
        keywords=("geoprocessing", "buffer", "geometry"),
        docs_path="/toolbox/geoprocessing/buffer",
    ),
    ToolDefinition(
        name="clip",
        display_name="Clip",
        description="Extracts input features that fall within the clip geometry",
        module_path="goatlib.tools.clip",
        params_class_name="ClipToolParams",
        windmill_path="f/goat/tools/clip",
        category="geoprocessing",
        keywords=("geoprocessing", "clip", "overlay", "extract"),
        docs_path="/toolbox/geoprocessing/clip",
    ),
    ToolDefinition(
        name="centroid",
        display_name="Centroid",
        description="Creates point features at the geometric center of each input feature",
        module_path="goatlib.tools.centroid",
        params_class_name="CentroidToolParams",
        windmill_path="f/goat/tools/centroid",
        category="geoprocessing",
        keywords=("geoprocessing", "centroid", "point"),
        docs_path="/toolbox/geoprocessing/centroid",
    ),
    ToolDefinition(
        name="intersection",
        display_name="Intersect",
        description="Computes the geometric intersection of features from two layers",
        module_path="goatlib.tools.intersection",
        params_class_name="IntersectionToolParams",
        windmill_path="f/goat/tools/intersection",
        category="geoprocessing",
        docs_path="/toolbox/geoprocessing/intersection",
        keywords=("geoprocessing", "intersect", "intersection", "overlay"),
    ),
    ToolDefinition(
        name="dissolve",
        display_name="Dissolve",
        description="Merges polygon features based on common attribute values with optional statistics",
        module_path="goatlib.tools.dissolve",
        params_class_name="DissolveToolParams",
        windmill_path="f/goat/tools/dissolve",
        category="geoprocessing",
        docs_path="/toolbox/geoprocessing/dissolve",
        keywords=(
            "geoprocessing",
            "dissolve",
            "merge",
            "aggregate",
            "group",
            "union",
            "auflösen",
        ),
    ),
    ToolDefinition(
        name="union",
        display_name="Union",
        description="Computes the geometric union of features from two layers",
        module_path="goatlib.tools.union",
        params_class_name="UnionToolParams",
        windmill_path="f/goat/tools/union",
        docs_path="/toolbox/geoprocessing/union",
        category="geoprocessing",
        keywords=("geoprocessing", "union", "overlay", "merge"),
    ),
    ToolDefinition(
        name="difference",
        display_name="Erase",
        description="Creates features by removing portions that overlap with erase geometry",
        module_path="goatlib.tools.difference",
        params_class_name="DifferenceToolParams",
        docs_path="/toolbox/geoprocessing/difference",
        windmill_path="f/goat/tools/difference",
        category="geoprocessing",
        keywords=("geoprocessing", "erase", "difference", "overlay", "subtract"),
    ),
    ToolDefinition(
        name="join",
        display_name="Join",
        description="Performs spatial and attribute-based joins between datasets",
        module_path="goatlib.tools.join",
        params_class_name="JoinToolParams",
        windmill_path="f/goat/tools/join",
        category="data_management",
        docs_path="/toolbox/data_management/join",
        keywords=(
            "data_management",
            "join",
            "spatial",
            "attribute",
            "merge",
            "combine",
        ),
    ),
    ToolDefinition(
        name="origin_destination",
        display_name="Origin-Destination",
        description="Create origin-destination lines and points from geometry and OD matrix",
        module_path="goatlib.tools.origin_destination",
        params_class_name="OriginDestinationToolParams",
        windmill_path="f/goat/tools/origin_destination",
        category="geoanalysis",
        docs_path="/toolbox/geoanalysis/origin_destination",
        keywords=("geoanalysis", "od", "origin", "destination", "matrix", "flow"),
    ),
    ToolDefinition(
        name="aggregate_points",
        display_name="Aggregate Points",
        description="Aggregate point features onto polygons or H3 hexagonal grids with statistics",
        module_path="goatlib.tools.aggregate_points",
        params_class_name="AggregatePointsToolParams",
        windmill_path="f/goat/tools/aggregate_points",
        category="geoanalysis",
        docs_path="/toolbox/geoanalysis/aggregate_points",
        keywords=(
            "geoanalysis",
            "aggregate",
            "points",
            "statistics",
            "count",
            "sum",
            "mean",
            "h3",
            "hexagon",
        ),
    ),
    ToolDefinition(
        name="aggregate_polygon",
        display_name="Aggregate Polygons",
        description="Aggregate polygon features onto polygons or H3 hexagonal grids with statistics",
        module_path="goatlib.tools.aggregate_polygon",
        params_class_name="AggregatePolygonToolParams",
        windmill_path="f/goat/tools/aggregate_polygon",
        category="geoanalysis",
        docs_path="/toolbox/geoanalysis/aggregate_polygon",
        keywords=(
            "geoanalysis",
            "aggregate",
            "polygons",
            "statistics",
            "count",
            "sum",
            "mean",
            "h3",
            "hexagon",
            "weighted",
            "intersection",
        ),
    ),
    ToolDefinition(
        name="geocoding",
        display_name="Geocoding",
        description="Geocode addresses from a layer using Pelias geocoder service",
        module_path="goatlib.tools.geocoding",
        params_class_name="GeocodingToolParams",
        windmill_path="f/goat/tools/geocoding",
        category="geoanalysis",
        docs_path="/toolbox/geoanalysis/geocoding",
        keywords=(
            "geoanalysis",
            "geocode",
            "geocoding",
            "address",
            "coordinates",
            "location",
            "pelias",
        ),
    ),
    ToolDefinition(
        name="spatial_clustering",
        display_name="Zone Clustering",
        description="Create spatially contiguous clusters with balanced feature counts using genetic algorithm",
        module_path="goatlib.tools.spatial_clustering",
        params_class_name="ClusteringZonesToolParams",
        windmill_path="f/goat/tools/spatial_clustering",
        category="geoanalysis",
        docs_path="/toolbox/geoanalysis/spatial_clustering",
        keywords=(
            "geoanalysis",
            "clustering",
            "balanced",
            "zones",
            "genetic",
            "algorithm",
            "spatial",
            "contiguity",
            "equal",
            "size",
        ),
    ),
    # Accessibility indicators
    ToolDefinition(
        name="catchment_area",
        display_name="Catchment Area",
        description="Compute isochrones/catchment areas for various transport modes",
        module_path="goatlib.tools.catchment_area",
        params_class_name="CatchmentAreaWindmillParams",
        windmill_path="f/goat/tools/catchment_area",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "catchment",
            "isochrone",
            "reachability",
            "travel time",
            "walking",
            "cycling",
            "public transport",
            "car",
        ),
        docs_path="/toolbox/accessibility_indicators/catchments",
    ),
    ToolDefinition(
        name="heatmap_gravity",
        display_name="Heatmap Gravity",
        description="Gravity-based spatial accessibility analysis",
        module_path="goatlib.tools.heatmap_gravity",
        params_class_name="HeatmapGravityToolParams",
        windmill_path="f/goat/tools/heatmap_gravity",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "heatmap",
            "gravity",
            "opportunities",
            "travel time",
        ),
        docs_path="/toolbox/accessibility_indicators/gravity",
    ),
    ToolDefinition(
        name="heatmap_closest_average",
        display_name="Heatmap Closest Average",
        description="Average distance/time to N closest destinations",
        module_path="goatlib.tools.heatmap_closest_average",
        params_class_name="HeatmapClosestAverageToolParams",
        windmill_path="f/goat/tools/heatmap_closest_average",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "heatmap",
            "closest",
            "average",
            "distance",
            "travel time",
        ),
        docs_path="/toolbox/accessibility_indicators/closest_average",
    ),
    ToolDefinition(
        name="heatmap_connectivity",
        display_name="Heatmap Connectivity",
        description="Total area reachable within max travel cost",
        module_path="goatlib.tools.heatmap_connectivity",
        params_class_name="HeatmapConnectivityToolParams",
        windmill_path="f/goat/tools/heatmap_connectivity",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "heatmap",
            "connectivity",
            "reachability",
            "travel time",
        ),
        docs_path="/toolbox/accessibility_indicators/connectivity",
    ),
     ToolDefinition(
         name="heatmap_2sfca",
         display_name="Heatmap 2SFCA",
         description="Two-Step Floating Catchment Area accessibility analysis",
         module_path="goatlib.tools.heatmap_2sfca",
         params_class_name="Heatmap2SFCAToolParams",
         windmill_path="f/goat/tools/heatmap_2sfca",
         category="accessibility_indicators",
         keywords=(
             "accessibility",
             "heatmap",
             "2sfca",
             "floating catchment",
             "supply",
             "demand",
             "capacity",
             "travel time",
         ),
         docs_path="/toolbox/accessibility_indicators/two_step_floating_catchment_area",
     ),
     ToolDefinition(
         name="huff_model",
         display_name="Huff Model",
         description="Huff model accessibility for market area and service probability estimation",
         module_path="goatlib.tools.huff_model",
         params_class_name="HuffModelToolParams",
         windmill_path="f/goat/tools/huff_model",
         category="accessibility_indicators",
         keywords=(
             "accessibility",
             "huff model",
             "market area",
             "probability",
             "gravity model",
             "attractiveness",
             "consumer choice",
             "travel time",
         ),
         docs_path="/toolbox/accessibility_indicators/huff_model",
     ),
    ToolDefinition(
        name="oev_gueteklassen",
        display_name="ÖV-Güteklassen",
        description="Public transport quality classes based on Swiss ARE methodology",
        module_path="goatlib.tools.oev_gueteklassen",
        params_class_name="OevGueteklassenToolParams",
        windmill_path="f/goat/tools/oev_gueteklassen",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "public transport",
            "quality",
            "GTFS",
            "stations",
            "ÖV",
        ),
        docs_path="/toolbox/accessibility_indicators/oev_gueteklassen",
    ),
    ToolDefinition(
        name="trip_count",
        display_name="Trip Count Station",
        description="Public transport trip counts per station within a time window",
        module_path="goatlib.tools.trip_count",
        params_class_name="TripCountToolParams",
        windmill_path="f/goat/tools/trip_count",
        category="accessibility_indicators",
        keywords=(
            "accessibility",
            "public transport",
            "trips",
            "frequency",
            "GTFS",
            "stations",
            "departures",
        ),
        docs_path="/toolbox/accessibility_indicators/trip_count",
    ),
    ToolDefinition(
        name="layer_import",
        display_name="Layer Import",
        description="Import geospatial data from S3 or WFS into DuckLake",
        module_path="goatlib.tools.layer_import",
        params_class_name="LayerImportParams",
        windmill_path="f/goat/tools/layer_import",
        category="data",
        keywords=("import", "upload", "s3", "wfs", "data"),
        toolbox_hidden=True,
    ),
    ToolDefinition(
        name="layer_delete",
        display_name="Layer Delete",
        description="Delete a layer from DuckLake storage and PostgreSQL metadata",
        module_path="goatlib.tools.layer_delete",
        params_class_name="LayerDeleteParams",
        windmill_path="f/goat/tools/layer_delete",
        category="data",
        keywords=("delete", "remove", "layer", "data"),
        toolbox_hidden=True,
    ),
    ToolDefinition(
        name="layer_delete_multi",
        display_name="Layer Delete Multi",
        description="Delete multiple layers from DuckLake storage (bulk operation)",
        module_path="goatlib.tools.layer_delete_multi",
        params_class_name="LayerDeleteMultiParams",
        windmill_path="f/goat/tools/layer_delete_multi",
        category="data",
        keywords=("delete", "remove", "layer", "data", "bulk"),
        toolbox_hidden=True,
    ),
    ToolDefinition(
        name="layer_update",
        display_name="Layer Update",
        description="Update layer data from S3 file or refresh WFS source",
        module_path="goatlib.tools.layer_update",
        params_class_name="LayerUpdateParams",
        windmill_path="f/goat/tools/layer_update",
        category="data",
        keywords=("update", "refresh", "layer", "data", "wfs", "s3"),
        toolbox_hidden=True,
    ),
    ToolDefinition(
        name="layer_export",
        display_name="Layer Export",
        description="Export a layer to file formats (GPKG, GeoJSON, CSV, etc.)",
        module_path="goatlib.tools.layer_export",
        params_class_name="LayerExportParams",
        windmill_path="f/goat/tools/layer_export",
        category="data",
        keywords=("export", "download", "gpkg", "geojson", "data"),
        toolbox_hidden=True,
    ),
    ToolDefinition(
        name="print_report",
        display_name="Print Report",
        description="Generate PDF/PNG reports from map layouts",
        module_path="goatlib.tools.print_report",
        params_class_name="PrintReportParams",
        windmill_path="f/goat/tools/print_report",
        category="data",
        keywords=("print", "report", "pdf", "png", "export"),
        toolbox_hidden=True,
        worker_tag="print",
    ),
    ToolDefinition(
        name="custom_sql",
        display_name="Custom SQL",
        description="Execute custom SQL query against workflow layers",
        module_path="goatlib.tools.custom_sql",
        params_class_name="CustomSqlToolParams",
        windmill_path="f/goat/tools/custom_sql",
        category="data_management",
        keywords=("sql", "query", "custom", "transform"),
        toolbox_hidden=True,
        worker_tag="tools",
    ),
)


def get_tool(name: str) -> ToolDefinition | None:
    """Get tool definition by name (case-insensitive)."""
    name_lower = name.lower()
    for tool in TOOL_REGISTRY:
        if tool.name == name_lower:
            return tool
    return None


def get_tools_by_category(category: str) -> list[ToolDefinition]:
    """Get all tools in a category."""
    return [t for t in TOOL_REGISTRY if t.category == category]
