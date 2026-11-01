"""ÖV-Güteklassen (Public Transport Quality Classes) schemas.

This module contains parameter schemas for the ÖV-Güteklassen tool based on
the Swiss ARE methodology for calculating public transport quality classes.

Reference:
    Bundesamt für Raumentwicklung ARE, 2022.
    ÖV-Güteklassen Berechnungsmethodik ARE (Grundlagenbericht).
"""

from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field, field_validator, model_validator

# Import PTTimeWindow from base and re-export for backwards compatibility
from goatlib.analysis.schemas.base import PTTimeWindow

__all__ = [
    "CatchmentType",
    "OevGueteklasseStationConfig",
    "PTTimeWindow",
    "STATION_CONFIG_DEFAULT",
    "OevGueteklasseParams",
]


STANDARD_TO_EXTENDED_ROUTE_TYPES: dict[str, list[str]] = {
    "0": ["900", "901", "902", "903", "904", "905", "906"],
    "1": ["401", "402"],
    "2": [
        "100",
        "101",
        "102",
        "103",
        "104",
        "105",
        "106",
        "107",
        "108",
        "109",
        "110",
        "111",
        "112",
        "114",
        "116",
        "117",
        "400",
        "403",
        "405",
    ],
    "3": [
        "200",
        "201",
        "202",
        "204",
        "700",
        "701",
        "702",
        "704",
        "705",
        "712",
        "715",
        "800",
    ],
    "4": ["1000"],
    "5": ["1300"],
    "6": [],
    "7": ["1400"],
}


class CatchmentType(str, Enum):
    """Catchment area type for ÖV-Güteklassen.

    ``buffer`` draws a circle of the class distance around each station;
    ``network`` walks that distance along the street network instead.
    """

    buffer = "buffer"
    network = "network"


class OevGueteklasseStationConfig(BaseModel):
    """Station configuration for ÖV-Güteklassen classification.

    This defines how different transport modes are grouped and how
    service frequency translates to station categories.

    Attributes:
        groups: Mapping of GTFS route_type to transport group (A, B, C).
            Group A: Rail, S-Bahn, Metro (highest priority)
            Group B: Tram, Light Rail
            Group C: Bus (lowest priority)
        time_frequency: Frequency thresholds in minutes [5, 10, 20, 40, 60, 120].
            If average service interval is < 5min -> time_interval=1
            If average service interval is 5-10min -> time_interval=2, etc.
        categories: List of dicts mapping group+time_interval to station category.
            E.g., categories[0] = {"A": 1, "B": 1, "C": 2} means:
            - Group A with time_interval 1 -> Station Category I
            - Group B with time_interval 1 -> Station Category I
            - Group C with time_interval 1 -> Station Category II
        classification: Maps station category to buffer distances and quality classes.
            E.g., classification["1"] = {300: "1", 500: "1", 750: "2", 1000: "3"}
            means Station Category I gets:
            - 300m buffer -> Quality Class 1 (A)
            - 500m buffer -> Quality Class 1 (A)
            - 750m buffer -> Quality Class 2 (B)
            - 1000m buffer -> Quality Class 3 (C)
    """

    groups: dict[str, str] = Field(
        ...,
        description="Mapping of GTFS route_type to transport group (A, B, or C).",
    )
    time_frequency: list[int] = Field(
        ...,
        description="Frequency thresholds in minutes.",
    )
    categories: list[dict[str, int]] = Field(
        ...,
        description="Mapping of group+frequency index to station category.",
    )
    classification: dict[str, dict[int, str]] = Field(
        ...,
        description="Maps station category to buffer distances and quality classes.",
    )

    @field_validator("classification", mode="before")
    @classmethod
    def convert_classification_keys_to_int(cls, v: dict) -> dict[str, dict[int, str]]:
        """Convert string distance keys to integers for API compatibility."""
        return {
            cat: {int(dist): qclass for dist, qclass in distances.items()}
            for cat, distances in v.items()
        }

    @field_validator("time_frequency")
    @classmethod
    def validate_time_frequency(cls, value: list[int]) -> list[int]:
        """Validate frequency thresholds are strictly increasing positive values."""
        if not value:
            raise ValueError("time_frequency must not be empty")

        if any(freq <= 0 for freq in value):
            raise ValueError("time_frequency values must be positive")

        if any(curr <= prev for prev, curr in zip(value, value[1:], strict=False)):
            raise ValueError("time_frequency must be strictly increasing")

        return value

    @model_validator(mode="after")
    def validate_configuration_consistency(self) -> "OevGueteklasseStationConfig":
        """Validate consistency across categories, groups and classification."""
        for (
            standard_route_type,
            extended_route_types,
        ) in STANDARD_TO_EXTENDED_ROUTE_TYPES.items():
            group = self.groups.get(standard_route_type)
            if group is None:
                continue

            for extended_route_type in extended_route_types:
                self.groups.setdefault(extended_route_type, group)

        if len(self.categories) != len(self.time_frequency):
            raise ValueError("categories length must match time_frequency length")

        allowed_groups = {"A", "B", "C"}
        invalid_group_mappings = {
            route_type: group
            for route_type, group in self.groups.items()
            if group not in allowed_groups
        }
        if invalid_group_mappings:
            raise ValueError("groups must map route types only to A, B, or C")

        used_station_categories: set[int] = set()
        for row in self.categories:
            if not row:
                raise ValueError("categories rows must not be empty")

            invalid_row_groups = [group for group in row if group not in allowed_groups]
            if invalid_row_groups:
                raise ValueError(
                    f"categories contains invalid group keys: {invalid_row_groups}"
                )

            for station_category in row.values():
                if station_category <= 0:
                    raise ValueError(
                        "station category values must be positive integers"
                    )
                used_station_categories.add(station_category)

        if not self.classification:
            raise ValueError("classification must not be empty")

        classification_categories: set[int] = set()
        for station_category, distances in self.classification.items():
            try:
                station_category_int = int(station_category)
            except ValueError as exc:
                raise ValueError(
                    f"classification category key must be numeric: {station_category}"
                ) from exc

            if station_category_int <= 0:
                raise ValueError("classification category keys must be positive")

            classification_categories.add(station_category_int)

            if not distances:
                raise ValueError(
                    f"classification for category {station_category} must not be empty"
                )

            distance_keys = list(distances.keys())
            if any(distance <= 0 for distance in distance_keys):
                raise ValueError("classification distances must be positive")
            if distance_keys != sorted(distance_keys):
                raise ValueError(
                    f"classification distances for category {station_category} must be sorted ascending"
                )

            for pt_class in distances.values():
                if not str(pt_class).isdigit() or int(pt_class) <= 0:
                    raise ValueError(
                        "classification PT class values must be positive integer strings"
                    )

        missing_categories = sorted(used_station_categories - classification_categories)
        if missing_categories:
            raise ValueError(
                "classification is missing station categories used in categories: "
                f"{missing_categories}"
            )

        return self


# Default station configuration based on Swiss ARE methodology
# Extended route types: https://developers.google.com/transit/gtfs/reference/extended-route-types
STATION_CONFIG_DEFAULT = OevGueteklasseStationConfig(
    groups={
        # Standard GTFS route types
        "0": "B",  # Tram, Streetcar
        "1": "A",  # Subway, Metro
        "2": "A",  # Rail
        "3": "C",  # Bus
        "6": "C",  # Gondola, Suspended cable car
        "7": "B",  # Funicular
        # Extended route types - Rail
        "100": "A",  # Railway Service
        "101": "A",  # High Speed Rail
        "102": "A",  # Long Distance Trains
        "103": "A",  # Inter Regional Rail
        "104": "A",  # Car Transport Rail
        "105": "A",  # Sleeper Rail
        "106": "A",  # Regional Rail
        "107": "A",  # Tourist Railway
        "108": "A",  # Rail Shuttle
        "109": "A",  # Suburban Railway (S-Bahn)
        "110": "A",  # Replacement Rail
        "111": "A",  # Special Rail
        "112": "A",  # Lorry Transport Rail
        "114": "A",  # All Rails
        "116": "A",  # Cross-Country Rail
        "117": "A",  # Vehicle Transport Rail
        # Extended route types - Coach
        "200": "C",  # Coach Service
        "201": "C",  # International Coach
        "202": "C",  # National Coach
        "204": "C",  # Regional Coach
        # Extended route types - Urban Rail
        "400": "A",  # Urban Railway
        "401": "A",  # Metro
        "402": "A",  # Underground
        "403": "A",  # Urban Rail
        "405": "A",  # Monorail
        # Extended route types - Bus
        "700": "C",  # Bus Service
        "701": "C",  # Regional Bus
        "702": "C",  # Express Bus
        "704": "C",  # Local Bus
        "705": "C",  # Night Bus
        "712": "C",  # School Bus
        "715": "C",  # Demand Responsive Bus
        "800": "C",  # Trolleybus
        # Extended route types - Tram
        "900": "B",  # Tram Service
        "901": "B",  # City Tram
        "902": "B",  # Local Tram
        "903": "B",  # Regional Tram
        "904": "B",  # Sightseeing Tram
        "905": "B",  # Shuttle Tram
        "906": "B",  # All Trams
        # Extended route types - Water/Cable/Other
        "1000": "C",  # Water Transport
        "1300": "C",  # Aerial Lift
        "1400": "B",  # Funicular
    },
    time_frequency=[5, 10, 20, 40, 60, 120],
    categories=[
        {"A": 1, "B": 1, "C": 2},  # Frequency interval 1 (< 5 min)
        {"A": 1, "B": 2, "C": 3},  # Frequency interval 2 (5-10 min)
        {"A": 2, "B": 3, "C": 4},  # Frequency interval 3 (10-20 min)
        {"A": 3, "B": 4, "C": 5},  # Frequency interval 4 (20-40 min)
        {"A": 4, "B": 5, "C": 6},  # Frequency interval 5 (40-60 min)
        {"A": 5, "B": 6, "C": 7},  # Frequency interval 6 (60-120 min)
    ],
    classification={
        "1": {300: "1", 500: "1", 750: "2", 1000: "3"},
        "2": {300: "1", 500: "2", 750: "3", 1000: "4"},
        "3": {300: "2", 500: "3", 750: "4", 1000: "5"},
        "4": {300: "3", 500: "4", 750: "5", 1000: "6"},
        "5": {300: "4", 500: "5", 750: "6"},
        "6": {300: "5", 500: "6"},
        "7": {300: "6"},
    },
)


class OevGueteklasseParams(BaseModel):
    """Parameters for ÖV-Güteklassen analysis.

    Attributes:
        reference_area_path: Path to polygon layer defining the analysis area.
        stops_path: Path to GTFS stops parquet file.
        stop_times_path: Path to GTFS stop_times parquet file.
        time_window: Time window for the analysis.
        output_path: Path for the output quality classes layer.
        station_config: Optional custom station configuration.
        stations_output_path: Optional path to save station categories.
    """

    reference_area_path: str | Path = Field(
        ...,
        description="Path to polygon layer defining the analysis area.",
    )
    stops_path: str | Path = Field(
        ...,
        description="Path to GTFS stops parquet file.",
    )
    stop_times_path: str | Path = Field(
        ...,
        description="Path to GTFS stop_times parquet file.",
    )
    # -- GTFS from an uploaded bundle -------------------------------------
    # Set together or not at all; see the trip-count schema for why.
    bundle_stops_path: str | Path | None = None
    bundle_stop_times_path: str | Path | None = None
    bundle_trips_path: str | Path | None = None
    bundle_routes_path: str | Path | None = None
    bundle_calendar_path: str | Path | None = None
    bundle_calendar_dates_path: str | Path | None = None
    #: ``YYYY-MM-DD``. Required with the bundle paths above.
    service_date: str | None = None

    time_window: PTTimeWindow = Field(
        ...,
        description="Time window for the analysis.",
    )
    output_path: str | Path = Field(
        ...,
        description="Path for the output quality classes layer.",
    )
    station_config: OevGueteklasseStationConfig | None = Field(
        default=None,
        description="Optional custom station configuration. Defaults to Swiss ARE methodology.",
    )
    stations_output_path: str | Path | None = Field(
        default=None,
        description="Optional path to save station categories.",
    )
    catchment_type: CatchmentType = Field(
        default=CatchmentType.buffer,
        description="Circles around the stations, or walking distance along the street network.",
    )
    #: Routing graph for ``catchment_type=network``, from a street network
    #: bundle; empty = the routing settings' default network.
    edge_path: str | None = Field(
        default=None, description="Path to an edges parquet to use for street routing"
    )
    node_path: str | None = Field(
        default=None, description="Path to a nodes parquet to use for street routing"
    )

    @model_validator(mode="after")
    def validate_network_override(self) -> "OevGueteklasseParams":
        # Edges of one network joined to another's nodes route over ids that
        # do not match, which yields a near-empty result instead of an error.
        if bool(self.edge_path) != bool(self.node_path):
            raise ValueError("edge_path and node_path must be set together")
        return self
