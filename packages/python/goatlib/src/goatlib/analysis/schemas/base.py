"""Base schemas for analysis operations."""

from enum import StrEnum
from typing import Any, List, Optional, Self

from pydantic import BaseModel, Field, model_validator


class GeometryType(StrEnum):
    """Supported geometry types in DuckDB Spatial"""

    point = "POINT"
    multipoint = "MULTIPOINT"
    linestring = "LINESTRING"
    multilinestring = "MULTILINESTRING"
    polygon = "POLYGON"
    multipolygon = "MULTIPOLYGON"


# Common geometry type groups
ALL_GEOMETRY_TYPES: List[GeometryType] = [
    GeometryType.polygon,
    GeometryType.multipolygon,
    GeometryType.linestring,
    GeometryType.multilinestring,
    GeometryType.point,
    GeometryType.multipoint,
]

POLYGON_TYPES: List[GeometryType] = [
    GeometryType.polygon,
    GeometryType.multipolygon,
]


# =============================================================================
# Public Transport (PT) Time Window
# =============================================================================


class PTTimeWindow(BaseModel):
    """Public transport time window for analysis.

    Used by PT-based analysis tools like Trip Count Station and ÖV-Güteklassen.

    Attributes:
        weekday: Type of day - "weekday", "saturday", or "sunday"
        from_time: Start time in seconds from midnight (e.g., 25200 = 7:00)
        to_time: End time in seconds from midnight (e.g., 32400 = 9:00)
    """

    weekday: str = Field(
        ...,
        description="Type of day: 'weekday', 'saturday', or 'sunday'",
    )
    from_time: int = Field(
        ...,
        description="Start time in seconds from midnight",
    )
    to_time: int = Field(
        ...,
        description="End time in seconds from midnight",
    )

    @property
    def weekday_column(self) -> str:
        """Get the boolean column name for the weekday type."""
        mapping = {
            "weekday": "is_weekday",
            "saturday": "is_saturday",
            "sunday": "is_sunday",
        }
        return mapping.get(self.weekday, "is_weekday")

    @property
    def from_time_str(self) -> str:
        """Convert from_time to HH:MM:SS format."""
        hours = self.from_time // 3600
        minutes = (self.from_time % 3600) // 60
        seconds = self.from_time % 60
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"

    @property
    def to_time_str(self) -> str:
        """Convert to_time to HH:MM:SS format."""
        hours = self.to_time // 3600
        minutes = (self.to_time % 3600) // 60
        seconds = self.to_time % 60
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"

    @property
    def time_window_minutes(self) -> float:
        """Get the time window duration in minutes."""
        return (self.to_time - self.from_time) / 60


# =============================================================================
# Statistics
# =============================================================================


class StatisticOperation(StrEnum):
    """Statistical operations for field aggregation."""

    count = "count"
    sum = "sum"
    min = "min"
    max = "max"
    mean = "mean"
    standard_deviation = "standard_deviation"


# Operation labels for i18n (maps enum values to translation keys)
STATISTIC_OPERATION_LABELS: dict[str, str] = {
    "count": "enums.statistics_operation.count",
    "sum": "enums.statistics_operation.sum",
    "min": "enums.statistics_operation.min",
    "max": "enums.statistics_operation.max",
    "mean": "enums.statistics_operation.mean",
    "standard_deviation": "enums.statistics_operation.standard_deviation",
}


class FieldStatistic(BaseModel):
    """Configuration for a statistical operation on a field.

    Used by join and aggregate tools for computing statistics.
    For 'count' operation, field is not required.
    For all other operations, field is required.
    """

    operation: StatisticOperation = Field(
        ...,
        description="The statistical operation to perform.",
        json_schema_extra={"x-ui": {"enum_labels": STATISTIC_OPERATION_LABELS}},
    )
    field: Optional[str] = Field(
        None,
        description="Field name to compute statistics on. Required for all operations except 'count'.",
        json_schema_extra={"x-ui": {"label_key": "statistic_field"}},
    )
    result_name: Optional[str] = Field(
        None,
        description="Custom name for the result column. If not provided, defaults to '{field}_{operation}' or 'count' for count operations.",
        json_schema_extra={"x-ui": {"label_key": "statistic_result_name"}},
    )

    @model_validator(mode="after")
    def validate_field_requirement(self: Self) -> "FieldStatistic":
        """Validate that field is provided for non-count operations."""
        if self.operation == StatisticOperation.count:
            if self.field is not None:
                raise ValueError("Field should not be provided for 'count' operation.")
        else:
            if self.field is None:
                raise ValueError(f"Field is required for '{self.operation}' operation.")
        return self

    def get_result_column_name(self: Self) -> str:
        """Get the result column name, using custom name or generating default."""
        if self.result_name:
            return self.result_name
        if self.operation == StatisticOperation.count:
            return "count"
        return f"{self.field}_{self.operation.value}"

    def get_operation_first_column_name(self: Self) -> str:
        """The result column name dissolve and aggregate polygon write: the
        custom name, else ``count`` or ``{operation}_{field}`` (e.g.
        ``sum_population``)."""
        if self.result_name:
            return self.result_name
        if self.operation == StatisticOperation.count:
            return "count"
        return f"{self.operation.value}_{self.field}"


#: The result name text of a tool that names a statistic
#: ``{operation}_{field}``; en.json holds the same text under
#: ``fields.statistic_result_name_operation_first``.
OPERATION_FIRST_RESULT_NAME = (
    'Custom name for the result column. If empty, "{operation}_{field}" is '
    'used, or "count" for "Count".'
)


def operation_first_result_name() -> Any:
    """The result_name setting of a tool that names a statistic
    ``{operation}_{field}``: its description and the editor's placeholder
    give that order."""
    return Field(
        None,
        description=OPERATION_FIRST_RESULT_NAME,
        json_schema_extra={
            "x-ui": {
                "label_key": "statistic_result_name",
                "description_key": "statistic_result_name_operation_first",
                "widget_options": {"placeholder_template": "{operation}_{field}"},
            }
        },
    )
