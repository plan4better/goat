"""Catchment Area tool for Windmill.

Computes catchment areas (isochrones) for various transport modes via routing services.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import Field, model_validator

from goatlib.analysis.accessibility import CatchmentAreaTool
from goatlib.analysis.schemas.catchment_area import (
    CATCHMENT_AREA_TYPE_LABELS,
    MEASURE_TYPE_ICONS,
    MEASURE_TYPE_LABELS,
    PT_MODE_ICONS,
    PT_MODE_LABELS,
    ROUTING_MODE_ICONS,
    ROUTING_MODE_LABELS,
    SPEED_LABELS,
    TRAVEL_TIME_LABELS,
    AccessEgressMode,
    CatchmentAreaMeasureType,
    CatchmentAreaRoutingMode,
    CatchmentAreaSteps,
    CatchmentAreaToolParams,
    CatchmentAreaType,
    PTMode,
    PTTimeWindow,
    SpeedKmh,
    StartingPoints,
    StartingPointsLayer,
    StartingPointsMap,
    TravelTimeLimitActiveMobility,
    TravelTimeLimitMotorized,
    Weekday,
)
from goatlib.analysis.schemas.ui import (
    SECTION_ROUTING,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase, get_default_layer_name

logger = logging.getLogger(__name__)

# Custom sections for catchment area UI
# Order: routing (1), configuration (2), starting_points (3), result (7)
SECTION_CONFIGURATION = UISection(
    id="configuration",
    order=2,
    icon="settings",
    label_key="configuration",
    depends_on={"routing_mode": {"$ne": None}},
)

SECTION_STARTING = UISection(
    id="starting",
    order=3,
    icon="location",
    label_key="starting_points",
    depends_on={"routing_mode": {"$ne": None}},
)

SECTION_RESULT_CATCHMENT = UISection(
    id="result",
    order=7,
    icon="save",
    label="Result Layer",
    label_de="Ergebnisebene",
    depends_on={"routing_mode": {"$ne": None}},
)


class CatchmentAreaWindmillParams(ToolInputBase):
    """Parameters for catchment area tool via Windmill/GeoAPI.

    This schema extends ToolInputBase with catchment area specific parameters.
    The frontend renders this dynamically based on x-ui metadata.
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_ROUTING,
            SECTION_CONFIGURATION,
            SECTION_STARTING,
            SECTION_RESULT_CATCHMENT,
        )
    }

    # =========================================================================
    # Routing Section
    # =========================================================================
    routing_mode: CatchmentAreaRoutingMode = Field(
        ...,
        description="Transport mode for the catchment area calculation.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=1,
            enum_icons=ROUTING_MODE_ICONS,
            enum_labels=ROUTING_MODE_LABELS,
        ),
    )

    pt_modes: list[PTMode] | None = Field(
        default=list(PTMode),
        description="Public transport modes to include.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=2,
            label_key="routing_pt_mode",
            description_key="choose_pt_mode",
            enum_icons=PT_MODE_ICONS,
            enum_labels=PT_MODE_LABELS,
            visible_when={"routing_mode": "pt"},
        ),
    )

    # =========================================================================
    # Starting Points Section
    # =========================================================================
    starting_points: StartingPoints = Field(
        ...,
        description="Starting point(s) for the catchment area - either map coordinates or a layer.",
        json_schema_extra=ui_field(
            section="starting",
            field_order=1,
            widget="starting-points",
            widget_options={"geometry_types": ["Point", "MultiPoint"]},
        ),
    )

    # =========================================================================
    # Configuration Section
    # =========================================================================
    measure_type: CatchmentAreaMeasureType = Field(
        default=CatchmentAreaMeasureType.time,
        description="Measure catchment area by travel time or distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="measure_type",
            enum_labels=MEASURE_TYPE_LABELS,
            enum_icons=MEASURE_TYPE_ICONS,
            visible_when={
                "routing_mode": {"$in": ["walking", "bicycle", "pedelec", "car"]}
            },
        ),
    )

    # Travel time for active mobility modes (walking, bicycle, pedelec): 3-45 min
    max_traveltime_active: TravelTimeLimitActiveMobility = Field(
        default=15,
        description="Maximum travel time in minutes.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="max_traveltime",
            enum_labels=TRAVEL_TIME_LABELS,
            visible_when={
                "$and": [
                    {"routing_mode": {"$in": ["walking", "bicycle", "pedelec"]}},
                    {"measure_type": "time"},
                ]
            },
        ),
    )

    # Travel time for car mode: 3-90 min (only when measure_type is time)
    max_traveltime_car: TravelTimeLimitMotorized = Field(
        default=30,
        description="Maximum travel time in minutes.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="max_traveltime",
            enum_labels=TRAVEL_TIME_LABELS,
            visible_when={
                "$and": [
                    {"routing_mode": "car"},
                    {"measure_type": "time"},
                ]
            },
        ),
    )

    # Travel time for PT mode: 3-90 min (always time-based, no distance option)
    max_traveltime_pt: TravelTimeLimitMotorized = Field(
        default=30,
        description="Maximum travel time in minutes.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="max_traveltime",
            enum_labels=TRAVEL_TIME_LABELS,
            visible_when={"routing_mode": "pt"},
        ),
    )

    # Distance (for non-PT modes when measure_type is distance)
    max_distance: int = Field(
        default=500,
        ge=50,
        le=100000,
        description="Maximum distance in meters.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="max_distance",
            widget="slider",
            widget_options={"min": 50, "max": 100000, "step": 50},
            visible_when={
                "$and": [
                    {"routing_mode": {"$in": ["walking", "bicycle", "pedelec", "car"]}},
                    {"measure_type": "distance"},
                ]
            },
        ),
    )

    @model_validator(mode="after")
    def validate_distance_limit_by_mode(self: Self) -> Self:
        if self.measure_type != CatchmentAreaMeasureType.distance:
            return self

        if self.routing_mode == CatchmentAreaRoutingMode.car:
            if self.max_distance > 100000:
                raise ValueError(
                    "Car catchment distance must be less than or equal to 100000 meters."
                )
            return self

        if (
            self.routing_mode
            in {
                CatchmentAreaRoutingMode.walking,
                CatchmentAreaRoutingMode.bicycle,
                CatchmentAreaRoutingMode.pedelec,
            }
            and self.max_distance > 20000
        ):
            raise ValueError(
                "Active mobility catchment distance must be less than or equal to 20000 meters."
            )

        return self

    steps: CatchmentAreaSteps = Field(
        default=5,
        description="Number of isochrone steps/intervals.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
            label_key="steps",
        ),
    )

    speed: SpeedKmh = Field(
        default=5,
        description="Travel speed in km/h (for active mobility modes).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="speed",
            enum_labels=SPEED_LABELS,
            visible_when={
                "routing_mode": {"$in": ["walking", "bicycle", "pedelec"]},
                "measure_type": CatchmentAreaMeasureType.time,
            },
            widget_options={
                "default_by_field": {
                    "field": "routing_mode",
                    "values": {
                        "walking": 5,
                        "bicycle": 15,
                        "pedelec": 23,
                    },
                }
            },
        ),
    )

    # =========================================================================
    # PT-specific fields (visible only when routing_mode == "pt")
    # Uses same types and translation keys as ÖV-Güteklassen for consistency
    # =========================================================================
    pt_day: Weekday = Field(
        default=Weekday.weekday,
        description="Day type for PT schedule (weekday, saturday, sunday).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=5,
            label_key="weekday",
            visible_when={"routing_mode": "pt"},
        ),
    )

    pt_start_time: int = Field(
        default=25200,  # 7:00 AM in seconds
        ge=0,
        le=86400,
        description="Start time for PT analysis (seconds from midnight).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=6,
            label_key="from_time",
            widget="time-picker",
            visible_when={"routing_mode": "pt"},
        ),
    )

    pt_end_time: int = Field(
        default=32400,  # 9:00 AM in seconds
        ge=0,
        le=86400,
        description="End time for PT analysis (seconds from midnight).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=7,
            label_key="to_time",
            widget="time-picker",
            visible_when={"routing_mode": "pt"},
        ),
    )

    pt_access_mode: AccessEgressMode | None = Field(
        default=AccessEgressMode.walk,
        description="Mode of transport to access PT stations.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=8,
            label_key="access_mode",
            visible_when={"routing_mode": "pt"},
            advanced=True,
        ),
    )

    pt_egress_mode: AccessEgressMode | None = Field(
        default=AccessEgressMode.walk,
        description="Mode of transport after leaving PT stations.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=9,
            label_key="pt_egress_mode",
            visible_when={"routing_mode": "pt"},
            advanced=True,
        ),
    )

    # =========================================================================
    # Advanced Configuration
    # =========================================================================
    catchment_area_type: CatchmentAreaType = Field(
        default=CatchmentAreaType.polygon,
        description="Output geometry type for the catchment area.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=10,
            label_key="catchment_area_type",
            enum_labels=CATCHMENT_AREA_TYPE_LABELS,
            advanced=True,
        ),
    )

    polygon_difference: bool = Field(
        default=True,
        description="If true, polygons show the difference between consecutive isochrone steps.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=11,
            label_key="polygon_difference",
            advanced=True,
            visible_when={"catchment_area_type": "polygon"},
        ),
    )

    # =========================================================================
    # Result Layer Naming Section
    # =========================================================================
    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("catchment_area", "en"),
        description="Name for the catchment area result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("catchment_area", "en"),
                "default_de": get_default_layer_name("catchment_area", "de"),
            },
        ),
    )

    starting_points_layer_name: str | None = Field(
        default=get_default_layer_name("catchment_area_starting_points", "en"),
        description="Name for the starting points layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=2,
            label_key="starting_points_layer_name",
            widget_options={
                "default_en": get_default_layer_name(
                    "catchment_area_starting_points", "en"
                ),
                "default_de": get_default_layer_name(
                    "catchment_area_starting_points", "de"
                ),
            },
        ),
    )


class CatchmentAreaToolRunner(BaseToolRunner[CatchmentAreaWindmillParams]):
    """Catchment Area tool runner for Windmill."""

    tool_class = CatchmentAreaTool
    output_geometry_type = "polygon"  # Default, may vary based on catchment_area_type
    default_output_name = get_default_layer_name("catchment_area", "en")
    default_starting_points_name = get_default_layer_name(
        "catchment_area_starting_points", "en"
    )

    # Store starting points output path for secondary layer creation
    _starting_points_parquet: Path | None = None
    # Track if starting points came from an existing layer (skip creating duplicate)
    _starting_points_from_layer: bool = False

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict catchment area output schema.

        Catchment area outputs:
        - id: unique identifier for each isochrone
        - minute: travel time in minutes for this isochrone step
        - geometry: Polygon/MultiPolygon representing the catchment area
        """
        return {
            "id": "INTEGER",
            "cost_step": "INTEGER",
            "geometry": "GEOMETRY",
        }

    def get_layer_properties(
        self: Self,
        params: CatchmentAreaWindmillParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        """Return style for catchment area with ordinal scale based on minute values.

        Queries unique minute values from the table or parquet and builds a color_map.
        Uses polygon style for polygon/grid output and line style for network output.
        """
        from goatlib.analysis.schemas.statistics import SortOrder
        from goatlib.analysis.statistics import calculate_unique_values
        from goatlib.tools.style import (
            get_ordinal_line_style,
            get_ordinal_polygon_style,
        )

        color_field = "cost_step"

        # Determine table expression: DuckLake table or read_parquet()
        table_expr = None
        if table_info and table_info.get("table_name"):
            table_expr = table_info["table_name"]
        elif parquet_path:
            table_expr = f"read_parquet('{parquet_path}')"

        # Query actual unique minute values
        unique_values: list[int | float] = []
        if table_expr:
            try:
                result = calculate_unique_values(
                    con=self.duckdb_con,
                    table_name=table_expr,
                    attribute=color_field,
                    order=SortOrder.ascendent,
                    limit=20,  # Allow more values with interpolation
                )
                unique_values = sorted(int(v.value) for v in result.values)
                logger.info("Found unique %s values: %s", color_field, unique_values)
            except Exception as e:
                logger.warning("Failed to query unique values: %s", e)

        if not unique_values:
            # Fallback: expected values from params. Two param shapes reach
            # here -- v2 carries one `max_cost` for the selected measure (and
            # often the cutoffs outright), v1 a limit per routing mode -- so
            # neither set of field names may be assumed present.
            step_sizes = getattr(params, "step_sizes", None)
            if step_sizes:
                unique_values = sorted(int(round(v)) for v in step_sizes)
            else:
                max_value = getattr(params, "max_cost", None)
                if max_value is None:
                    if params.routing_mode in [
                        CatchmentAreaRoutingMode.walking,
                        CatchmentAreaRoutingMode.bicycle,
                        CatchmentAreaRoutingMode.pedelec,
                    ]:
                        max_value = params.max_traveltime_active
                    elif params.routing_mode == CatchmentAreaRoutingMode.car:
                        max_value = params.max_traveltime_car
                    else:
                        max_value = params.max_traveltime_pt

                step_size = max_value / params.steps
                unique_values = [
                    int(round(step_size * (i + 1))) for i in range(params.steps)
                ]

        # Use line style for network output, polygon style for polygon/grid output
        is_network = params.catchment_area_type == CatchmentAreaType.network
        if is_network:
            return get_ordinal_line_style(
                color_field=color_field,
                values=unique_values,
                palette="YlGn",
                opacity=1.0,
                stroke_width=3,
            )
        return get_ordinal_polygon_style(
            color_field=color_field,
            values=unique_values,
            palette="YlGn",
            opacity=0.8,
        )

    def _extract_coordinates_from_layer(
        self: Self,
        layer_id: str,
        user_id: str,
        cql_filter: dict[str, Any] | None = None,
    ) -> tuple[list[float], list[float]]:
        """Extract lat/lon coordinates from a layer.

        Args:
            layer_id: Layer UUID string
            user_id: User UUID string (fallback if layer info unavailable)
            cql_filter: Optional CQL2-JSON filter to apply to the layer

        Returns:
            Tuple of (latitudes, longitudes) lists
        """
        is_temp_layer = ":" in layer_id
        if is_temp_layer:
            # export_layer_to_parquet resolves temp layers
            temp_parquet = self.export_layer_to_parquet(
                layer_id=layer_id,
                user_id=user_id,
                cql_filter=cql_filter,
            )
            # Detect geometry column name from the parquet
            parquet_info = self._get_table_info(self.duckdb_con, f"'{temp_parquet}'")
            geom_col = parquet_info.get("geometry_column", "geometry")

            # Read coordinates from the merged parquet
            result = self.duckdb_con.execute(f"""
                SELECT
                    ST_Y(ST_Centroid("{geom_col}")) as lat,
                    ST_X(ST_Centroid("{geom_col}")) as lon
                FROM '{temp_parquet}'
                WHERE "{geom_col}" IS NOT NULL
            """).fetchall()
        else:
            import json

            from goatlib.storage.query_builder import build_cql_filter

            # Look up the layer's actual owner to correctly access shared/catalog layers
            layer_owner_id = self.get_layer_owner_id_sync(layer_id)
            if layer_owner_id is None:
                layer_owner_id = user_id  # Fallback to passed user_id
                logger.warning(
                    f"Could not find owner for layer {layer_id}, using current user {user_id}"
                )
            elif layer_owner_id != user_id:
                logger.info(
                    f"Layer {layer_id} owned by {layer_owner_id}, accessed by {user_id}"
                )

            table_name = self.resolve_layer_table_path(layer_id)

            # Detect geometry column name from table schema
            cols_result = self._execute_with_retry(
                "describe table",
                f"DESCRIBE {table_name}",
            )
            geom_col = "geometry"  # default
            column_names: list[str] = []
            for col_name, col_type, *_ in cols_result.fetchall():
                column_names.append(col_name)
                if "GEOMETRY" in col_type.upper():
                    geom_col = col_name

            # Build WHERE clause from CQL filter
            where_clause = f"WHERE {geom_col} IS NOT NULL"
            params: list[Any] = []

            if cql_filter:
                filter_dict = {"filter": json.dumps(cql_filter), "lang": "cql2-json"}
                cql_filters = build_cql_filter(filter_dict, column_names, geom_col)
                if cql_filters.clauses:
                    where_clause += " AND " + " AND ".join(cql_filters.clauses)
                    params = cql_filters.params
                    logger.info(f"Applied CQL filter to layer {layer_id}")

            # Query centroids of all geometries
            query = f"""
                SELECT
                    ST_Y(ST_Centroid({geom_col})) as lat,
                    ST_X(ST_Centroid({geom_col})) as lon
                FROM {table_name}
                {where_clause}
            """
            result = self.duckdb_con.execute(query, params).fetchall()

        if not result:
            raise ValueError(f"No valid geometries found in layer {layer_id}")

        latitudes = [
            row[0] for row in result if row[0] is not None and row[1] is not None
        ]
        longitudes = [
            row[1] for row in result if row[0] is not None and row[1] is not None
        ]

        logger.info(
            "Extracted %d starting points from layer %s",
            len(latitudes),
            layer_id,
        )

        return latitudes, longitudes

    def _get_starting_coordinates(
        self: Self,
        starting_points: StartingPoints,
        user_id: str,
    ) -> tuple[list[float], list[float]]:
        """Get latitude/longitude coordinates from starting points.

        Args:
            starting_points: Either direct coordinates or layer reference
            user_id: User UUID string (needed for layer lookup)

        Returns:
            Tuple of (latitudes, longitudes) lists
        """
        if isinstance(starting_points, StartingPointsMap):
            # Direct coordinates from map clicks - need to create starting points layer
            self._starting_points_from_layer = False
            return starting_points.latitude, starting_points.longitude
        elif isinstance(starting_points, StartingPointsLayer):
            # Extract from existing layer - don't create duplicate starting points layer
            self._starting_points_from_layer = True
            return self._extract_coordinates_from_layer(
                starting_points.layer_id,
                user_id,
                cql_filter=starting_points.layer_filter,
            )
        else:
            raise ValueError(f"Invalid starting_points type: {type(starting_points)}")

    def process(
        self: Self,
        params: CatchmentAreaWindmillParams,
        temp_dir: Path,
    ) -> tuple[Path, DatasetMetadata]:
        """Run catchment area analysis."""
        output_path = temp_dir / "output.parquet"

        # Get coordinates from starting points (either map clicks or layer)
        latitudes, longitudes = self._get_starting_coordinates(
            params.starting_points,
            params.user_id,
        )

        # Validate starting point limits based on routing mode
        # These limits match the frontend validation in apps/web/lib/validations/tools.ts
        num_starting_points = len(latitudes)

        if params.routing_mode == CatchmentAreaRoutingMode.pt:
            max_points = 5
            if num_starting_points > max_points:
                raise ValueError(
                    f"Public transport catchment areas support a maximum of {max_points} "
                    f"starting points. Got {num_starting_points} starting points."
                )
        elif params.routing_mode == CatchmentAreaRoutingMode.car:
            max_points = 50
            if num_starting_points > max_points:
                raise ValueError(
                    f"Car catchment areas support a maximum of {max_points} "
                    f"starting points. Got {num_starting_points} starting points."
                )
        elif params.routing_mode in [
            CatchmentAreaRoutingMode.walking,
            CatchmentAreaRoutingMode.bicycle,
            CatchmentAreaRoutingMode.pedelec,
        ]:
            max_points = 1000
            if num_starting_points > max_points:
                raise ValueError(
                    f"Active mobility catchment areas support a maximum of {max_points} "
                    f"starting points. Got {num_starting_points} starting points."
                )

        # Build time window for PT routing
        time_window = None
        if params.routing_mode == CatchmentAreaRoutingMode.pt:
            # pt_day is a Weekday enum, get its string value
            weekday_value = (
                params.pt_day.value
                if hasattr(params.pt_day, "value")
                else params.pt_day
            )
            time_window = PTTimeWindow(
                weekday=weekday_value,
                from_time=params.pt_start_time,
                to_time=params.pt_end_time,
            )

        # Get routing URL and auth from settings
        routing_url = None
        authorization = None
        r5_region_mapping_path = None

        if self.settings:
            # Use R5 URL for PT mode, GOAT routing URL for other modes
            if params.routing_mode == CatchmentAreaRoutingMode.pt:
                routing_url = getattr(self.settings, "r5_url", None)
            else:
                routing_url = getattr(self.settings, "goat_routing_url", None)
            authorization = getattr(self.settings, "goat_routing_authorization", None)
            r5_region_mapping_path = getattr(
                self.settings, "r5_region_mapping_path", None
            )

        # Determine travel_time based on routing mode and measure type
        # For distance-based catchment areas, we don't use travel_time
        distance: int | None = None
        # Determine travel_time/travel_distance based on routing mode and measure type
        travel_time: int | None = None

        if params.routing_mode in [
            CatchmentAreaRoutingMode.walking,
            CatchmentAreaRoutingMode.bicycle,
            CatchmentAreaRoutingMode.pedelec,
        ]:
            # Active mobility modes support both time and distance
            if params.measure_type == CatchmentAreaMeasureType.distance:
                distance = params.max_distance
            else:
                travel_time = params.max_traveltime_active
        elif params.routing_mode == CatchmentAreaRoutingMode.car:
            # Car mode supports both time and distance
            if params.measure_type == CatchmentAreaMeasureType.distance:
                distance = params.max_distance
            else:
                travel_time = params.max_traveltime_car
        else:
            # PT mode - always time-based
            travel_time = params.max_traveltime_pt

        # Build analysis params
        analysis_params = CatchmentAreaToolParams(
            latitude=latitudes,
            longitude=longitudes,
            routing_mode=params.routing_mode,
            measure_type=params.measure_type,
            travel_time=travel_time or 15,  # Fallback
            distance=distance or 500,
            steps=params.steps,
            speed=params.speed,
            transit_modes=params.pt_modes,
            time_window=time_window,
            access_mode=params.pt_access_mode or AccessEgressMode.walk,
            egress_mode=params.pt_egress_mode or AccessEgressMode.walk,
            catchment_area_type=params.catchment_area_type,
            polygon_difference=params.polygon_difference,
            output_path=str(output_path),
            routing_url=routing_url,
            authorization=authorization,
            r5_region_mapping_path=r5_region_mapping_path,
        )

        # Run the analysis tool - pass routing config to avoid using stale global settings
        tool = self.tool_class(
            routing_url=routing_url,
            authorization=authorization,
            r5_region_mapping_path=r5_region_mapping_path,
        )
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]

            # Create starting points parquet file only if starting points
            # came from map clicks (not from an existing layer)
            if not self._starting_points_from_layer:
                starting_points_path = temp_dir / "starting_points.parquet"
                self._create_starting_points_parquet(
                    latitudes=latitudes,
                    longitudes=longitudes,
                    output_path=starting_points_path,
                )
                if starting_points_path.exists():
                    self._starting_points_parquet = starting_points_path
                    logger.info(
                        "Starting points output available at: %s", starting_points_path
                    )
            else:
                logger.info(
                    "Skipping starting points layer creation - using existing layer"
                )

            return Path(result_path), metadata
        finally:
            tool.cleanup()

    def _create_starting_points_parquet(
        self: Self,
        latitudes: list[float],
        longitudes: list[float],
        output_path: Path,
    ) -> None:
        """Create a GeoParquet file with starting point geometries.

        Uses DuckDB to create proper GeoParquet format with WKB geometry
        that will be recognized as a feature layer.

        Args:
            latitudes: List of latitude values
            longitudes: List of longitude values
            output_path: Path to write the parquet file
        """
        import duckdb

        # Create a temporary DuckDB connection for geometry operations
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        # Build a VALUES clause with all points
        values = ", ".join(
            f"({i + 1}, ST_Point({lon}, {lat}))"
            for i, (lat, lon) in enumerate(zip(latitudes, longitudes))
        )

        # Create and export the points as GeoParquet
        con.execute(f"""
            COPY (
                SELECT
                    id,
                    geom
                FROM (VALUES {values}) AS t(id, geom)
            ) TO '{output_path}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """)

        con.close()
        logger.info("Created starting points GeoParquet with %d points", len(latitudes))

    def run(self: Self, params: CatchmentAreaWindmillParams) -> dict:
        """Run tool and create both polygon and starting points layers."""
        import asyncio
        import tempfile
        import uuid as uuid_module

        from goatlib.tools.schemas import ToolOutputBase
        from goatlib.tools.style import get_starting_points_style

        # Check if we're in temp mode (for workflow preview)
        temp_mode = getattr(params, "temp_mode", False)

        # Main polygon layer - use result_layer_name, then output_name, then default
        output_layer_id = str(uuid_module.uuid4())
        output_name = (
            params.result_layer_name or params.output_name or self.default_output_name
        )

        # Starting points layer - use custom name or default
        starting_points_layer_id = str(uuid_module.uuid4())
        starting_points_output_name = (
            params.starting_points_layer_name or self.default_starting_points_name
        )

        logger.info(
            f"Starting tool: {self.__class__.__name__} "
            f"(user={params.user_id}, output={output_layer_id}, "
            f"temp_mode={temp_mode})"
        )

        # Initialize db_service
        asyncio.get_event_loop().run_until_complete(self._init_db_service())

        with tempfile.TemporaryDirectory(
            prefix=f"{self.__class__.__name__.lower()}_"
        ) as temp_dir:
            temp_path = Path(temp_dir)

            # Step 1: Run analysis (creates both polygon and starting points outputs)
            output_parquet, metadata = self.process(params, temp_path)
            logger.info(
                f"Analysis complete: {metadata.feature_count or 0} features "
                f"at {output_parquet}"
            )

            # Compute style from parquet (works for both temp and permanent)
            custom_properties = self.get_layer_properties(
                params, metadata, parquet_path=output_parquet
            )

            # Temp mode: write primary output only, skip starting points and DB records
            if temp_mode:
                result = self._write_temp_result(
                    params=params,
                    output_parquet=output_parquet,
                    output_name=output_name,
                    output_layer_id=output_layer_id,
                    properties=custom_properties,
                )
                asyncio.get_event_loop().run_until_complete(self._close_db_service())
                return result

            # Step 2: Ingest polygon layer to DuckLake
            table_info = self._ingest_to_ducklake(
                user_id=params.user_id,
                layer_id=output_layer_id,
                parquet_path=output_parquet,
            )
            logger.info(f"DuckLake polygon table created: {table_info['table_name']}")

            # Step 2b: Generate PMTiles for polygon layer
            if table_info.get("geometry_type"):
                pmtiles_path = self._generate_pmtiles(
                    user_id=params.user_id,
                    layer_id=output_layer_id,
                    table_name=table_info["table_name"],
                    geometry_column=table_info.get("geometry_column", "geometry"),
                )
                if pmtiles_path:
                    table_info["pmtiles_path"] = str(pmtiles_path)

            # Step 2c: Ingest starting points layer to DuckLake (if available)
            starting_points_table_info = None
            if self._starting_points_parquet and self._starting_points_parquet.exists():
                starting_points_table_info = self._ingest_to_ducklake(
                    user_id=params.user_id,
                    layer_id=starting_points_layer_id,
                    parquet_path=self._starting_points_parquet,
                )
                logger.info(
                    f"DuckLake starting points table created: "
                    f"{starting_points_table_info['table_name']}"
                )

                # Generate PMTiles for starting points layer
                if starting_points_table_info.get("geometry_type"):
                    sp_pmtiles_path = self._generate_pmtiles(
                        user_id=params.user_id,
                        layer_id=starting_points_layer_id,
                        table_name=starting_points_table_info["table_name"],
                        geometry_column=starting_points_table_info.get(
                            "geometry_column", "geometry"
                        ),
                    )
                    if sp_pmtiles_path:
                        starting_points_table_info["pmtiles_path"] = str(
                            sp_pmtiles_path
                        )

            # Refresh database pool
            asyncio.get_event_loop().run_until_complete(self._close_db_service())

            # Step 3: Create polygon layer DB records
            result_info = asyncio.get_event_loop().run_until_complete(
                self._create_db_records(
                    output_layer_id=output_layer_id,
                    params=params,
                    output_name=output_name,
                    metadata=metadata,
                    table_info=table_info,
                    custom_properties=custom_properties,
                )
            )

            # Step 3b: Create starting points layer DB records (if available)
            starting_points_result_info = None
            if starting_points_table_info:
                starting_points_metadata = DatasetMetadata(
                    path=str(self._starting_points_parquet),
                    source_type="vector",
                    geometry_type="Point",
                    crs="EPSG:4326",
                )
                starting_points_result_info = (
                    asyncio.get_event_loop().run_until_complete(
                        self._create_db_records(
                            output_layer_id=starting_points_layer_id,
                            params=params,
                            output_name=starting_points_output_name,
                            metadata=starting_points_metadata,
                            table_info=starting_points_table_info,
                            custom_properties=get_starting_points_style(),
                        )
                    )
                )
                logger.info(
                    f"Starting points layer created: {starting_points_layer_id}"
                )

        # Close database pool
        asyncio.get_event_loop().run_until_complete(self._close_db_service())

        # Build main output
        detected_geom_type = table_info.get("geometry_type")
        is_feature = bool(detected_geom_type)

        # Build wm_labels for Windmill job tracking
        wm_labels: list[str] = []
        if params.triggered_by_email:
            wm_labels.append(params.triggered_by_email)

        output = ToolOutputBase(
            layer_id=output_layer_id,
            name=output_name,
            folder_id=result_info["folder_id"],
            user_id=params.user_id,
            project_id=params.project_id,
            layer_project_id=result_info.get("layer_project_id"),
            type="feature" if is_feature else "table",
            feature_layer_type=self.get_feature_layer_type(params)
            if is_feature
            else None,
            geometry_type=detected_geom_type,
            feature_count=table_info.get("feature_count", 0),
            extent=table_info.get("extent"),
            table_name=table_info["table_name"],
            wm_labels=wm_labels,
        )

        result = output.model_dump()

        # Add starting points layer info if created
        if starting_points_table_info and starting_points_result_info:
            result["starting_points_layer"] = {
                "layer_id": starting_points_layer_id,
                "name": starting_points_output_name,
                "folder_id": starting_points_result_info["folder_id"],
                "layer_project_id": starting_points_result_info.get("layer_project_id"),
                "geometry_type": starting_points_table_info.get("geometry_type"),
                "feature_count": starting_points_table_info.get("feature_count", 0),
                "table_name": starting_points_table_info["table_name"],
            }

        logger.info(f"Tool completed: {output_layer_id} ({output_name})")
        return result


def main(params: CatchmentAreaWindmillParams) -> dict:
    """Windmill entry point for catchment area tool."""
    runner = CatchmentAreaToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
