"""ÖV-Güteklassen (Public Transport Quality Classes) tool for Windmill.

Calculates public transport quality classes based on the Swiss ARE methodology.
"""

import logging
import os
from enum import StrEnum
from pathlib import Path
from typing import Any, Self

from pydantic import Field

from goatlib.analysis.accessibility import (
    STATION_CONFIG_DEFAULT,
    OevGueteklasseParams,
    OevGueteklasseStationConfig,
    OevGueteklasseTool,
    PTTimeWindow,
)
from goatlib.analysis.schemas.catchment_area import WEEKDAY_LABELS, Weekday
from goatlib.analysis.schemas.ui import (
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner, drops_unrecorded_tables
from goatlib.tools.pt_network import ensure_pt_date, fetch_gtfs_tables
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import (
    oev_gueteklassen_stations_style,
    oev_gueteklassen_style,
)

logger = logging.getLogger(__name__)

# Default GTFS data path from environment
GTFS_DATA_PATH = os.environ.get("GTFS_DATA_PATH", "/app/data/gtfs")

# Section definitions for this tool
# Order: calculation_time (1), configuration (2), result (7)
SECTION_PT_NETWORK = UISection(id="pt_network", order=0, icon="route")
SECTION_CALCULATION_TIME = UISection(id="calculation_time", order=1, icon="clock")
SECTION_OEV_CONFIGURATION = UISection(id="configuration", order=2, icon="settings")
SECTION_RESULT_OEV = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"reference_area_layer_id": {"$ne": None}},
)


class CatchmentType(StrEnum):
    """Catchment area type for ÖV-Güteklassen."""

    buffer = "buffer"


CATCHMENT_TYPE_LABELS: dict[str, str] = {
    "buffer": "enums.catchment_type.buffer",
}


class OevGueteklassenToolParams(ToolInputBase):
    """Parameters for ÖV-Güteklassen tool.

    Calculates public transport quality classes based on station accessibility
    and service frequency.
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_PT_NETWORK,
            SECTION_CALCULATION_TIME,
            SECTION_OEV_CONFIGURATION,
            SECTION_RESULT_OEV,
        )
    }

    pt_network_bundle_id: str | None = Field(
        default=None,
        description=(
            "The public transport network classified: the default network, or a "
            "public transport bundle added to this project."
        ),
        json_schema_extra=ui_field(
            section="pt_network",
            field_order=1,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            # No artifact: the classes are computed from the feed's own tables,
            # so a bundle is usable the moment it has been imported.
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
            # day; a bundle is classified on a real date instead.
            visible_when={"_pt_network_bundle_id_is_custom": False},
        ),
    )
    pt_date: str | None = Field(
        default=None,
        description=(
            "Date to classify on (YYYY-MM-DD). A feed states its service per "
            "date, so a holiday timetable is counted as the feed declares it."
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
    catchment_type: CatchmentType = Field(
        default=CatchmentType.buffer,
        description="Method for calculating catchment areas",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="catchment_type",
            enum_labels=CATCHMENT_TYPE_LABELS,
        ),
    )
    reference_area_layer_id: str = Field(
        description="Layer ID for the reference area polygon",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the reference area layer",
        json_schema_extra=ui_field(section="configuration", field_order=3, hidden=True),
    )

    # =========================================================================
    # Result Layer Naming Section
    # =========================================================================
    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("oev_gueteklassen", "en"),
        description="Name for the ÖV-Güteklassen result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("oev_gueteklassen", "en"),
                "default_de": get_default_layer_name("oev_gueteklassen", "de"),
            },
        ),
    )

    stations_layer_name: str | None = Field(
        default=get_default_layer_name("oev_gueteklassen_stations", "en"),
        description="Custom name for the stations layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=2,
            label_key="stations_layer_name",
            widget_options={
                "default_en": get_default_layer_name("oev_gueteklassen_stations", "en"),
                "default_de": get_default_layer_name("oev_gueteklassen_stations", "de"),
            },
        ),
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
        description="Output path for quality classes layer.",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    station_config: OevGueteklasseStationConfig | None = Field(
        default=None,
        description="Optional custom station configuration for ÖV-Güteklassen.",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )


class OevGueteklassenToolRunner(BaseToolRunner[OevGueteklassenToolParams]):
    """ÖV-Güteklassen tool runner for Windmill."""

    tool_class = OevGueteklasseTool
    output_geometry_type = "polygon"
    default_output_name = get_default_layer_name("oev_gueteklassen", "en")
    default_stations_name = get_default_layer_name("oev_gueteklassen_stations", "en")

    # Store stations output path for secondary layer creation
    _stations_parquet: Path | None = None

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict ÖV-Güteklassen output schema.

        ÖV-Güteklassen outputs:
        - gueteklasse: quality class (A-F or None)
        - station_group_id: unique identifier for station catchment group
        - geometry: Polygon representing the catchment area
        """
        return {
            "gueteklasse": "VARCHAR",
            "station_group_id": "INTEGER",
            "geometry": "GEOMETRY",
        }

    def get_layer_style(
        self: Self,
        params: OevGueteklassenToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """One class per PT quality class of the active configuration."""
        station_config = params.station_config or STATION_CONFIG_DEFAULT

        class_values = [
            int(pt_class)
            for distances in station_config.classification.values()
            for pt_class in distances.values()
        ]
        class_count = max(class_values) if class_values else 1

        return oev_gueteklassen_style(class_count=class_count)

    def process(
        self: Self, params: OevGueteklassenToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run ÖV-Güteklassen analysis."""
        output_path = temp_dir / "output.parquet"
        stations_output_path = temp_dir / "stations.parquet"

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

        # An uploaded bundle is classified from its own tables, on the date chosen.
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
        analysis_params = OevGueteklasseParams(
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
            station_config=params.station_config or STATION_CONFIG_DEFAULT,
            stations_output_path=str(stations_output_path),
        )

        tool = self.tool_class()
        stats = tool.run(analysis_params)
        logger.info("OevGueteklassen stats: %s", stats)

        # Store stations path for secondary layer creation
        if stations_output_path.exists():
            self._stations_parquet = stations_output_path
            logger.info("Stations output available at: %s", stations_output_path)

        # Create metadata for the output parquet
        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            geometry_type="Polygon",
            crs="EPSG:4326",
        )
        return output_path, metadata

    @drops_unrecorded_tables
    def run(self: Self, params: OevGueteklassenToolParams) -> dict:
        """Run tool and create both polygon and station layers."""
        import asyncio
        import tempfile
        import uuid as uuid_module

        from goatlib.tools.schemas import ToolOutputBase

        # Check if we're in temp mode (for workflow preview)
        temp_mode = getattr(params, "temp_mode", False)

        # Main polygon layer - use result_layer_name, then output_name, then default
        output_layer_id = str(uuid_module.uuid4())
        output_name = (
            params.result_layer_name or params.output_name or self.default_output_name
        )

        # Stations layer - use custom name or default
        stations_layer_id = str(uuid_module.uuid4())
        stations_output_name = params.stations_layer_name or self.default_stations_name

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

            # Step 1: Run analysis (creates both polygon and stations outputs)
            output_parquet, metadata = self.process(params, temp_path)
            logger.info(
                f"Analysis complete: {metadata.feature_count or 0} features "
                f"at {output_parquet}"
            )

            # Temp mode: write primary (polygon) output only, skip stations and DB records
            if temp_mode:
                result = self._write_temp_result(
                    params=params,
                    output_parquet=output_parquet,
                    output_name=output_name,
                    output_layer_id=output_layer_id,
                    metadata=metadata,
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

            # Step 2c: Ingest stations layer to DuckLake (if available)
            stations_table_info = None
            if self._stations_parquet and self._stations_parquet.exists():
                stations_table_info = self._ingest_to_ducklake(
                    user_id=params.user_id,
                    layer_id=stations_layer_id,
                    parquet_path=self._stations_parquet,
                )
                logger.info(
                    f"DuckLake stations table created: {stations_table_info['table_name']}"
                )

                # Generate PMTiles for stations layer
                if stations_table_info.get("geometry_type"):
                    st_pmtiles_path = self._generate_pmtiles(
                        user_id=params.user_id,
                        layer_id=stations_layer_id,
                        table_name=stations_table_info["table_name"],
                        geometry_column=stations_table_info.get(
                            "geometry_column", "geometry"
                        ),
                    )
                    if st_pmtiles_path:
                        stations_table_info["pmtiles_path"] = str(st_pmtiles_path)

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
                )
            )

            # Step 3b: Create stations layer DB records (if available)
            stations_result_info = None
            if stations_table_info:
                stations_metadata = DatasetMetadata(
                    path=str(self._stations_parquet),
                    source_type="vector",
                    geometry_type="Point",
                    crs="EPSG:4326",
                )
                stations_result_info = asyncio.get_event_loop().run_until_complete(
                    self._create_db_records(
                        output_layer_id=stations_layer_id,
                        params=params,
                        output_name=stations_output_name,
                        metadata=stations_metadata,
                        table_info=stations_table_info,
                        style=oev_gueteklassen_stations_style(),
                    )
                )
                logger.info(f"Stations layer created: {stations_layer_id}")

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

        # Add stations layer info if created
        if stations_table_info and stations_result_info:
            result["stations_layer"] = {
                "layer_id": stations_layer_id,
                "name": stations_output_name,
                "folder_id": stations_result_info["folder_id"],
                "layer_project_id": stations_result_info.get("layer_project_id"),
                "geometry_type": stations_table_info.get("geometry_type"),
                "feature_count": stations_table_info.get("feature_count", 0),
                "table_name": stations_table_info["table_name"],
            }

        logger.info(f"Tool completed: {output_layer_id} ({output_name})")
        return result


def main(params: OevGueteklassenToolParams) -> dict:
    """Windmill entry point for ÖV-Güteklassen tool."""
    runner = OevGueteklassenToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
