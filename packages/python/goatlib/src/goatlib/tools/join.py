"""Join tool for Windmill.

Performs spatial and attribute-based joins between datasets using DuckDB Spatial.
"""

import logging
from pathlib import Path
from typing import Any, List, Literal, Optional, Self

import duckdb
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from goatlib.analysis.data_management.join import JoinTool
from goatlib.analysis.schemas.base import FieldStatistic
from goatlib.analysis.schemas.data_management import (
    AttributeRelationship,
    JoinOperationType,
    JoinParams,
    JoinType,
    MultipleMatchingRecordsType,
    SpatialRelationshipType,
)
from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)

logger = logging.getLogger(__name__)

# Result section for join tool (depends on target_layer_id)
SECTION_RESULT_JOIN = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"target_layer_id": {"$ne": None}},
)

SPATIAL_RELATIONSHIP_LABELS: dict[str, str] = {
    "intersects": "enums.spatial_relationship_type.intersects",
    "within_distance": "enums.spatial_relationship_type.within_distance",
    "identical_to": "enums.spatial_relationship_type.identical_to",
    "completely_contains": "enums.spatial_relationship_type.completely_contains",
    "completely_within": "enums.spatial_relationship_type.completely_within",
    "touches": "enums.spatial_relationship_type.touches",
    "overlaps": "enums.spatial_relationship_type.overlaps",
    "covers": "enums.spatial_relationship_type.covers",
    "covered_by": "enums.spatial_relationship_type.covered_by",
    "disjoint": "enums.spatial_relationship_type.disjoint",
}

DISTANCE_UNITS_LABELS: dict[str, str] = {
    "meters": "enums.units.meters",
    "kilometers": "enums.units.kilometers",
    "feet": "enums.units.feet",
    "miles": "enums.units.miles",
    "nautical_miles": "enums.units.nautical_miles",
    "yards": "enums.units.yards",
}

JOIN_OPERATION_LABELS: dict[str, str] = {
    "one_to_one": "enums.join_operation_type.one_to_one",
    "one_to_many": "enums.join_operation_type.one_to_many",
}

JOIN_TYPE_LABELS: dict[str, str] = {
    "inner": "enums.join_type.inner",
    "left": "enums.join_type.left",
}


class JoinToolParams(ToolInputBase, BaseModel):
    """Parameters for join tool.

    Matches ArcGIS Join Features tool with toggle-based spatial/attribute selection.
    Does NOT inherit from JoinParams to avoid validator conflicts.
    We build JoinParams in the runner instead.
    """

    model_config = ConfigDict(
        populate_by_name=True,
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="join_layer", order=2, icon="layers"),
            UISection(id="join_settings", order=3, icon="route"),
            UISection(id="spatial_settings", order=4, icon="location"),
            UISection(id="attribute_settings", order=5, icon="list"),
            UISection(
                id="join_options",
                order=6,
                icon="settings",
                collapsible=True,
            ),
            SECTION_RESULT_JOIN,
            SECTION_OUTPUT,
        ),
    )

    # Layer ID inputs
    target_layer_id: str = Field(
        ...,
        description="The layer to which join layer fields will be appended",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            widget_options={"data_types": ["vector", "table"]},
        ),
    )
    target_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the target layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )
    join_layer_id: str = Field(
        ...,
        description="The layer containing fields to append to the target layer",
        json_schema_extra=ui_field(
            section="join_layer",
            field_order=1,
            widget="layer-selector",
            widget_options={"data_types": ["vector", "table"]},
        ),
    )
    join_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the join layer",
        json_schema_extra=ui_field(section="join_layer", field_order=2, hidden=True),
    )

    # ===== Join Method Toggles (ArcGIS pattern) =====
    use_spatial_relationship: bool = Field(
        False,
        description="Match features based on their spatial location. If both options are enabled, features must match both criteria.",
        json_schema_extra=ui_field(
            section="join_settings",
            field_order=1,
            widget="switch",
            # Only show spatial relationship option when both layers have geometry
            # The _all_layers_have_geometry value is computed by the frontend from selected layers
            visible_when={"_all_layers_have_geometry": True},
        ),
    )
    use_attribute_relationship: bool = Field(
        True,  # Default to attribute join
        description="Match features based on attribute values. If both options are enabled, features must match both criteria.",
        json_schema_extra=ui_field(
            section="join_settings",
            field_order=2,
            widget="switch",
        ),
    )

    # ===== Spatial Relationship Settings =====
    spatial_relationship: Optional[SpatialRelationshipType] = Field(
        SpatialRelationshipType.intersects,
        description="How spatial features are joined to each other",
        json_schema_extra=ui_field(
            section="spatial_settings",
            field_order=1,
            enum_labels=SPATIAL_RELATIONSHIP_LABELS,
            visible_when={"use_spatial_relationship": True},
        ),
    )
    distance: Optional[float] = Field(
        None,
        description="How close features in the join layer must be to features in the target layer",
        gt=0,
        json_schema_extra=ui_field(
            section="spatial_settings",
            field_order=2,
            visible_when={
                "$and": [
                    {"use_spatial_relationship": True},
                    {"spatial_relationship": "within_distance"},
                ]
            },
        ),
    )
    distance_units: Literal[
        "meters", "kilometers", "feet", "miles", "nautical_miles", "yards"
    ] = Field(
        "meters",
        description="Distance units",
        json_schema_extra=ui_field(
            section="spatial_settings",
            field_order=3,
            enum_labels=DISTANCE_UNITS_LABELS,
            visible_when={
                "$and": [
                    {"use_spatial_relationship": True},
                    {"spatial_relationship": "within_distance"},
                ]
            },
        ),
    )

    # ===== Attribute Relationship Settings =====
    attribute_relationships: Optional[List[AttributeRelationship]] = Field(
        None,
        description="Attribute relationships. Target field and join field must contain matching values.",
        json_schema_extra=ui_field(
            section="attribute_settings",
            field_order=1,
            visible_when={"use_attribute_relationship": True},
            repeatable=True,
            min_items=1,
        ),
    )

    @field_validator("attribute_relationships", mode="before")
    @classmethod
    def filter_incomplete_attribute_relationships(
        cls, value: List[dict] | None
    ) -> List[dict] | None:
        """Filter out incomplete attribute relationship items (missing target_field or join_field).

        The frontend may send items with only _id when the user adds a new item but
        hasn't filled in the fields yet.
        """
        if value is None:
            return None
        if not isinstance(value, list):
            return value
        # Drop incomplete dicts only; non-dict items (e.g. AttributeRelationship
        # instances) are passed through for regular validation.
        filtered = [
            item
            for item in value
            if not isinstance(item, dict)
            or (item.get("target_field") and item.get("join_field"))
        ]
        return filtered if filtered else None

    # ===== Join Operation Settings =====
    join_type: JoinType = Field(
        JoinType.inner,  # Default to inner join
        description="Determines which features appear in the output. Inner Join keeps only matching features. Left Join keeps all target features even without matches.",
        json_schema_extra=ui_field(
            section="join_options",
            field_order=1,
            enum_labels=JOIN_TYPE_LABELS,
            visible_when={"spatial_relationship": {"$ne": "disjoint"}},
        ),
    )
    join_operation: JoinOperationType = Field(
        JoinOperationType.one_to_one,
        description="How to handle multiple matching features. One-to-One keeps one result per target feature. One-to-Many creates a row for each match.",
        json_schema_extra=ui_field(
            section="join_options",
            field_order=2,
            enum_labels=JOIN_OPERATION_LABELS,
            visible_when={"spatial_relationship": {"$ne": "disjoint"}},
        ),
    )

    # ===== Join Field Selection =====

    add_join_fields: bool = Field(
        False,
        description="Add fields from the join layer to the output. If off, no join fields are added (filter-only mode). Auto-enabled when join type is set to LEFT.",
        json_schema_extra=ui_field(
            section="join_options",
            field_order=3,
            widget="switch",
            widget_options={
                "default_by_field": {
                    "field": "join_type",
                    "values": {"left": True},
                }
            },
            visible_when={
                "$and": [
                    {"calculate_statistics": False},
                    {"spatial_relationship": {"$ne": "disjoint"}},
                    {"join_type": {"$ne": "left"}},
                ]
            },
        ),
    )
    join_fields: List[str] = Field(
        default_factory=list,
        description="Pick which fields from the join layer to include in the output.",
        json_schema_extra={
            **ui_field(
                section="join_options",
                field_order=4,
                widget="field-selector",
                widget_options={
                    "source_layer": "join_layer_id",
                    "multiple": True,
                    "default_all": True,
                },
                visible_when={
                    "$and": [
                        {"add_join_fields": True},
                        {"calculate_statistics": False},
                        {"spatial_relationship": {"$ne": "disjoint"}},
                    ]
                },
                optional=True,
            ),
            "default": [],
        },
    )

    # ===== Statistics Configuration (for one-to-one joins) =====
    calculate_statistics: bool = Field(
        False,
        description="Calculate statistics for numeric fields when multiple records match",
        json_schema_extra=ui_field(
            section="join_options",
            field_order=5,
            widget="switch",
            visible_when={
                "$and": [
                    {"join_operation": "one_to_one"},
                    {"spatial_relationship": {"$ne": "disjoint"}},
                ]
            },
        ),
    )
    field_statistics: Optional[List[FieldStatistic]] = Field(
        None,
        alias="column_statistics",
        validation_alias="column_statistics",
        description="Field statistics to calculate. Supported statistics: sum, min, max, mean, standard deviation.",
        json_schema_extra=ui_field(
            section="join_options",
            field_order=6,
            label_key="field_statistics",
            widget="field-statistics-selector",
            widget_options={"source_layer": "join_layer_id"},
            visible_when={
                "$and": [
                    {"join_operation": "one_to_one"},
                    {"calculate_statistics": True},
                    {"spatial_relationship": {"$ne": "disjoint"}},
                ]
            },
        ),
    )

    @field_validator("field_statistics", mode="before")
    @classmethod
    def wrap_field_statistics_in_list(
        cls, value: dict | List[dict] | None
    ) -> List[dict] | None:
        """Convert a single field_statistics dict to a list for backwards compatibility."""
        if value is None:
            return None
        if isinstance(value, dict):
            return [value]
        return value

    @model_validator(mode="after")
    def validate_join_config(self: Self) -> Self:
        """Validate join configuration."""
        # Must use at least one relationship type
        if not self.use_spatial_relationship and not self.use_attribute_relationship:
            raise ValueError(
                "Either use_spatial_relationship or use_attribute_relationship must be enabled"
            )

        # Spatial relationship validation
        if self.use_spatial_relationship:
            if self.spatial_relationship is None:
                raise ValueError(
                    "spatial_relationship is required when use_spatial_relationship is enabled"
                )
            if self.spatial_relationship == SpatialRelationshipType.within_distance:
                if self.distance is None:
                    raise ValueError(
                        "distance is required for within_distance relationship"
                    )

        # Attribute relationship validation
        if self.use_attribute_relationship:
            if (
                not self.attribute_relationships
                or len(self.attribute_relationships) == 0
            ):
                raise ValueError(
                    "At least one attribute relationship is required when use_attribute_relationship is enabled"
                )

        # The UI hides add_join_fields for left joins
        if self.join_type == JoinType.left:
            self.add_join_fields = True

        # Statistics validation
        if self.calculate_statistics:
            if not self.field_statistics or len(self.field_statistics) == 0:
                raise ValueError(
                    "field_statistics is required when calculate_statistics is enabled"
                )

        return self

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("join", "en"),
        description="Name for the join result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("join", "en"),
                "default_de": get_default_layer_name("join", "de"),
            },
        ),
    )


def _is_geometry(name: str, data_type: str) -> bool:
    return "GEOMETRY" in data_type.upper() or name in ("geometry", "bbox")


def _join_fields(params: JoinToolParams, join_path: Path) -> list[str]:
    """The join layer's fields a run adds. With join fields on and no list
    given, every field but the geometry: the form ticks them all
    (`default_all`), so a join drafted without it adds what the form would
    have. A list given, the empty one included, is what the user ticked."""
    if not params.add_join_fields:
        return []
    if "join_fields" in params.model_fields_set:
        return params.join_fields
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        rows = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{join_path}')"
        ).fetchall()
    finally:
        con.close()
    return [name for name, data_type, *_ in rows if not _is_geometry(name, data_type)]


class JoinToolRunner(BaseToolRunner[JoinToolParams]):
    """Join tool runner for Windmill."""

    tool_class = JoinTool
    output_geometry_type = None  # Same as target layer
    output_geometry_follows_input = True
    default_output_name = get_default_layer_name("join", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict join output schema: the columns ``process`` writes, in order.

        Workflows show this before a run, and SQL written against it must
        still hold afterwards, so it follows the analysis exactly:

        - disjoint: the target columns alone (an anti-semi-join adds nothing);
        - one-to-one with statistics: the target columns, ``match_count``
          unless a count statistic is configured, then one column per
          statistic (join fields are not added);
        - otherwise (one-to-many, or one-to-one keeping the first match): the
          target columns, then each picked join field as ``join_<field>``, in
          the join layer's order. Nothing is added while "add join fields" is
          off, which a left join forces on; with it on and no list given,
          every join field but the geometry is (see ``_join_fields``).
        """
        columns = dict(input_schemas.get("target_layer_id", {}))
        join_layer = input_schemas.get("join_layer_id", {})

        def add(name: str, dtype: str) -> None:
            columns[cls.unique_column_name(columns, name)] = dtype

        if (
            params.get("use_spatial_relationship")
            and params.get("spatial_relationship") == "disjoint"
        ):
            return columns

        statistics = (
            params.get("field_statistics") or params.get("column_statistics") or []
        )
        if isinstance(statistics, dict):
            statistics = [statistics]
        one_to_one = params.get("join_operation", "one_to_one") == "one_to_one"
        if one_to_one and params.get("calculate_statistics") and statistics:
            if not any(s.get("operation", "count") == "count" for s in statistics):
                add("match_count", "BIGINT")
            for stat in statistics:
                operation = stat.get("operation", "count")
                if stat.get("result_name"):
                    name = stat["result_name"]
                elif operation == "count":
                    name = "count"
                elif stat.get("field"):
                    name = f"{stat['field']}_{operation}"
                else:
                    continue
                add(name, "BIGINT" if operation == "count" else "DOUBLE")
            return columns

        add_fields = params.get("add_join_fields") or params.get("join_type") == "left"
        if not add_fields:
            return columns
        if "join_fields" in params:
            picked = set(params.get("join_fields") or [])
        else:
            picked = {c for c, t in join_layer.items() if not _is_geometry(c, t)}
        for col, dtype in join_layer.items():
            if col in picked:
                add(f"join_{col}", dtype)
        return columns

    def process(
        self: Self, params: JoinToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run join analysis."""
        target_path = self.export_layer_to_parquet(
            layer_id=params.target_layer_id,
            user_id=params.user_id,
            cql_filter=params.target_layer_filter,
        )
        join_path = self.export_layer_to_parquet(
            layer_id=params.join_layer_id,
            user_id=params.user_id,
            cql_filter=params.join_layer_filter,
        )
        output_path = temp_dir / "output.parquet"

        tool = self.tool_class()
        try:
            results = tool.run(
                self.analysis_params(params, target_path, join_path, output_path)
            )
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()

    @staticmethod
    def analysis_params(
        params: JoinToolParams,
        target_path: Path,
        join_path: Path,
        output_path: Path,
    ) -> JoinParams:
        """The analysis parameters a run of this tool uses (shared with the
        schema prediction tests, so both read the same configuration)."""
        # Determine multiple_matching_records based on calculate_statistics toggle
        # If calculate_statistics is True, use statistics; otherwise use first_record (sorted by ID)
        multiple_matching_records = (
            MultipleMatchingRecordsType.calculate_statistics
            if params.calculate_statistics
            else MultipleMatchingRecordsType.first_record
        )

        # Sort by ID when using first_record (no sort_configuration needed)
        return JoinParams(
            target_path=str(target_path),
            join_path=str(join_path),
            output_path=str(output_path),
            use_spatial_relationship=params.use_spatial_relationship,
            use_attribute_relationship=params.use_attribute_relationship,
            spatial_relationship=params.spatial_relationship
            if params.use_spatial_relationship
            else None,
            distance=params.distance,
            distance_units=params.distance_units,
            attribute_relationships=params.attribute_relationships,
            join_operation=params.join_operation,
            multiple_matching_records=multiple_matching_records,
            join_type=params.join_type,
            sort_configuration=None,  # Sort by ID in backend
            field_statistics=params.field_statistics
            if params.calculate_statistics
            else None,
            join_fields=_join_fields(params, join_path),
        )


def main(params: JoinToolParams) -> dict:
    """Windmill entry point for join tool."""
    runner = JoinToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
