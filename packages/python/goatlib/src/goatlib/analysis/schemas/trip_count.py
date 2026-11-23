"""Trip Count Station schemas.

Parameters for calculating public transport trip counts per station.
"""

from pathlib import Path

from pydantic import BaseModel, Field

# Import PTTimeWindow from base (canonical location)
from goatlib.analysis.schemas.base import PTTimeWindow

__all__ = [
    "TripCountStationParams",
    "PTTimeWindow",
]


class TripCountStationParams(BaseModel):
    """Parameters for Trip Count Station analysis.

    This tool calculates the number of public transport departures per station
    within a given time window, grouped by transport mode.

    Attributes:
        reference_area_path: Path to polygon layer defining the analysis area.
        stops_path, stop_times_path, trips_path, routes_path, calendar_path,
            calendar_dates_path: The feed's GTFS tables (see below).
        service_date: The date to count on.
        time_window: Time window for the analysis.
        output_path: Path for the output trip count layer.
    """

    reference_area_path: str | Path = Field(
        ...,
        description="Path to polygon layer defining the analysis area.",
    )
    # -- The feed's GTFS tables --------------------------------------------
    # A bundle's, as published, or the default network's, cut to the area and
    # the date (``tools/pt_network.py``). Read for ``service_date``: a feed
    # states its service per date, so a holiday timetable is counted as the
    # feed declares it.
    stops_path: str | Path = Field(..., description="GTFS stops parquet file.")
    stop_times_path: str | Path = Field(
        ..., description="GTFS stop_times parquet file."
    )
    trips_path: str | Path = Field(..., description="GTFS trips parquet file.")
    routes_path: str | Path = Field(..., description="GTFS routes parquet file.")
    #: GTFS requires one of the two calendar files, not both.
    calendar_path: str | Path | None = None
    calendar_dates_path: str | Path | None = None
    service_date: str = Field(..., description="Date to count on (YYYY-MM-DD).")

    time_window: PTTimeWindow = Field(
        ...,
        description="Time window for the analysis.",
    )
    output_path: str | Path = Field(
        ...,
        description="Path for the output trip count layer (parquet format).",
    )
