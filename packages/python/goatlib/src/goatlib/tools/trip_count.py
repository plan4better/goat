"""Trip Count Station tool for Windmill.

Calculates public transport trip counts per station within a time window.
"""

import logging
import os
from pathlib import Path
from typing import Any, Self

from pydantic import Field

from goatlib.analysis.accessibility import (
    PTTimeWindow,
    TripCountStationTool,
)
from goatlib.analysis.accessibility import (
    TripCountStationParams as AnalysisTripCountParams,
)
from goatlib.analysis.schemas.catchment_area import WEEKDAY_LABELS, Weekday
from goatlib.analysis.schemas.ui import (
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.pt_network import ensure_pt_date, fetch_gtfs_tables
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import classified

logger = logging.getLogger(__name__)

# Default GTFS data path from environment
GTFS_DATA_PATH = os.environ.get("GTFS_DATA_PATH", "/app/data/gtfs")

# Section definitions for this tool
SECTION_PT_NETWORK = UISection(id="pt_network", order=0, icon="route")
SECTION_CALCULATION_TIME = UISection(id="calculation_time", order=1, icon="clock")
SECTION_CONFIGURATION = UISection(id="configuration", order=2, icon="settings")
SECTION_RESULT_TRIP = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"reference_area_layer_id": {"$ne": None}},
)


class TripCountToolParams(ToolInputBase):
    """Parameters for Trip Count Station tool.

    Calculates public transport trip counts per station within a time window,
    grouped by transport mode (bus, tram, metro, rail, other).
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_PT_NETWORK,
            SECTION_CALCULATION_TIME,
            SECTION_CONFIGURATION,
            SECTION_RESULT_TRIP,
        )
    }

    pt_network_bundle_id: str | None = Field(
        default=None,
        description=(
            "The public transport network counted from: the default network, or "
            "a public transport bundle added to this project."
        ),
        json_schema_extra=ui_field(
            section="pt_network",
            field_order=1,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            # No artifact: the count is computed from the feed's own tables, so
            # a bundle is usable the moment it has been imported.
            widget_options={"bundle_type": "pt_network_gtfs"},
            visible_when={"_project_has_pt_network_bundle": True},
        ),
    )

    # Time window section
    weekday: Weekday = Field(
        default=Weekday.weekday,
        description="Type of day for public transport schedule",
        json_schema_extra=ui_field(
            section="calculation_time",
            field_order=1,
            label_key="weekday",
            enum_labels=WEEKDAY_LABELS,
            # The default network's schedule is an average of three kinds of
            # day; a bundle is counted on a real date instead.
            visible_when={"_pt_network_bundle_id_is_custom": False},
        ),
    )
    pt_date: str | None = Field(
        default=None,
        description=(
            "Date to count on (YYYY-MM-DD). A feed states its service per date, "
            "so a holiday timetable is counted as the feed declares it."
        ),
        json_schema_extra=ui_field(
            section="calculation_time",
            field_order=1,
            label_key="pt_date",
            widget="date-picker",
            visible_when={"_pt_network_bundle_id_is_custom": True},
            widget_options={
                "bounds_from": "pt_network_bundle_id",
                "bounds_artifact": "pt_network_graph",
            },
        ),
    )
    from_time: int = Field(
        default=25200,  # 7:00 AM
        description="Start time of the analysis window",
        json_schema_extra=ui_field(
            section="calculation_time",
            field_order=2,
            label_key="from_time",
            widget="time-picker",
        ),
    )
    to_time: int = Field(
        default=32400,  # 9:00 AM
        description="End time of the analysis window",
        json_schema_extra=ui_field(
            section="calculation_time",
            field_order=3,
            label_key="to_time",
            widget="time-picker",
        ),
    )

    # Configuration section
    reference_area_layer_id: str = Field(
        description="Layer ID for the reference area polygon",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the reference area layer",
        json_schema_extra=ui_field(section="configuration", field_order=2, hidden=True),
    )

    # Hidden internal fields
    reference_area_path: str | None = None  # type: ignore[assignment]
    stops_path: str | None = Field(
        default=None,
        description="Path to GTFS stops parquet file.",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    stop_times_path: str | None = Field(
        default=None,
        description="Path to GTFS stop_times parquet file.",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    output_path: str | None = Field(
        default=None,
        description="Output path for trip count layer.",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("trip_count", "en"),
        description="Name for the trip count result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("trip_count", "en"),
                "default_de": get_default_layer_name("trip_count", "de"),
            },
        ),
    )


class TripCountToolRunner(BaseToolRunner[TripCountToolParams]):
    """Trip Count Station tool runner for Windmill."""

    tool_class = TripCountStationTool
    output_geometry_type = "point"
    default_output_name = get_default_layer_name("trip_count", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict trip count output schema.

        Trip count outputs:
        - stop_id: GTFS stop identifier
        - stop_name: station name
        - bus: bus trip count
        - tram: tram trip count
        - metro: metro/subway trip count
        - rail: rail/train trip count
        - other: other transport mode trip count
        - total: total trip count (all modes)
        - geometry: Point location of the station
        """
        return {
            "stop_id": "VARCHAR",
            "stop_name": "VARCHAR",
            "bus": "INTEGER",
            "tram": "INTEGER",
            "metro": "INTEGER",
            "rail": "INTEGER",
            "other": "INTEGER",
            "total": "INTEGER",
            "geometry": "GEOMETRY",
        }

    def get_layer_style(
        self: Self,
        params: TripCountToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """Stations classified by their total trips."""
        return classified("total", "colorbrewer:BuPu", geometry)

    def process(
        self: Self, params: TripCountToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run Trip Count Station analysis."""
        output_path = temp_dir / "output.parquet"

        # Export reference area layer
        reference_area_path = str(
            self.export_layer_to_parquet(
                layer_id=params.reference_area_layer_id,
                user_id=params.user_id,
                cql_filter=params.reference_area_layer_filter,
            )
        )

        # Use GTFS paths from params or derive from GTFS_DATA_PATH environment variable
        stops_path = params.stops_path or f"{GTFS_DATA_PATH}/stops.parquet"
        stop_times_path = (
            params.stop_times_path or f"{GTFS_DATA_PATH}/stop_times_optimized.parquet"
        )

        # An uploaded bundle is counted from its own tables, on the date chosen.
        bundle_tables: dict[str, str] = {}
        if params.pt_network_bundle_id:
            ensure_pt_date(params.pt_network_bundle_id, params.pt_date)
            bundle_tables = fetch_gtfs_tables(
                self, params.pt_network_bundle_id, params.user_id
            )

        # Build time window (weekday is StrEnum, use .value)
        time_window = PTTimeWindow(
            weekday=params.weekday.value
            if hasattr(params.weekday, "value")
            else params.weekday,
            from_time=params.from_time,
            to_time=params.to_time,
        )

        # Build params for the analysis tool
        analysis_params = AnalysisTripCountParams(
            reference_area_path=reference_area_path,
            stops_path=stops_path,
            stop_times_path=stop_times_path,
            time_window=time_window,
            output_path=str(output_path),
            bundle_stops_path=bundle_tables.get("stops"),
            bundle_stop_times_path=bundle_tables.get("stop_times"),
            bundle_trips_path=bundle_tables.get("trips"),
            bundle_routes_path=bundle_tables.get("routes"),
            bundle_calendar_path=bundle_tables.get("calendar"),
            bundle_calendar_dates_path=bundle_tables.get("calendar_dates"),
            service_date=params.pt_date if bundle_tables else None,
        )

        tool = self.tool_class()
        stats = tool.run(analysis_params)
        logger.info("TripCount stats: %s", stats)

        # Create metadata for the output parquet
        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            geometry_type="Point",
            crs="EPSG:4326",
        )
        return output_path, metadata


def main(params: TripCountToolParams) -> dict:
    """Windmill entry point for Trip Count Station tool."""
    runner = TripCountToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
