"""Feature write service for DuckLake mutations.

Handles feature CRUD (create, update, delete) and column management
(add, rename, delete columns) via the write-capable DuckLake manager.

All writes use DuckDB's stable `rowid` as the canonical feature identifier.
rowid is immutable, unique, monotonically increasing, and never recycled.

All writes are serialized by BaseDuckLakeManager's internal threading.Lock.

Generated columns (serial, uuid — ``goatlib.utils.generated_fields``) are
filled here on every create, inside that lock and on the connection that
inserts. A client's value for one is dropped on create and refused on update
when it differs from the stored one. Across pods, the router holds the layer's
advisory lock around a create that hands out serial numbers
(``geoapi.services.layer_write_lock``).
"""

import json
import logging
import re
from typing import Any, Optional

from goatlib.utils.field_config import (
    allowed_value_columns,
    column_defaults,
    locked_column_names,
    parse_computed_columns,
)
from goatlib.utils.generated_fields import (
    MAX_SERIAL_VALUE,
    GeneratedField,
    GeneratedValues,
    SerialCounters,
    generated_fields,
    refuse_generated_changes,
)

from geoapi.config import settings
from geoapi.dependencies import LayerInfo
from geoapi.ducklake_write import ducklake_write_manager
from geoapi.models.write import COLUMN_TYPE_MAP
from geoapi.services.computed_columns import (
    apply_defaults,
    check_allowed_values,
    fill_defaults,
    select_recompute_specs,
    validate_allowed_values,
)

logger = logging.getLogger(__name__)

# Columns that cannot be modified by users
PROTECTED_COLUMNS = {"id", "geometry", "geom", "rowid"}


def bbox_struct_sql(geom_expr: str) -> str:
    """The GeoParquet bbox struct for a geometry expression.

    The one definition of that struct, so bbox upkeep cannot drift between the
    writers that maintain it — the per-feature paths below splice a bound
    GeoJSON parameter in, the bundle editor a column or a projected expression.
    """
    return (
        "struct_pack("
        f"xmin := ST_XMin({geom_expr}), "
        f"ymin := ST_YMin({geom_expr}), "
        f"xmax := ST_XMax({geom_expr}), "
        f"ymax := ST_YMax({geom_expr}))"
    )


# The bbox struct as the per-feature writes spell it: every ? is the same
# GeoJSON string, bound four times.
BBOX_STRUCT_SQL = bbox_struct_sql("ST_MakeValid(ST_GeomFromGeoJSON(?))")


def _feature_id_to_rowid(feature_id: str) -> int:
    """Convert a public feature ID to internal DuckDB rowid.

    Feature IDs are rowid + 1 because MVT feature ID 0 is treated
    as "unset" by MapLibre (known limitation).
    """
    return int(feature_id) - 1


def _rowid_to_feature_id(rowid: int) -> str:
    """Convert internal DuckDB rowid to public feature ID."""
    return str(rowid + 1)


def _validate_column_name(name: str, existing_columns: list[str]) -> None:
    """Validate that a column name is safe and exists."""
    if name in PROTECTED_COLUMNS:
        raise ValueError(f"Column '{name}' is protected and cannot be modified")
    if name in settings.HIDDEN_FIELDS:
        raise ValueError(f"Column '{name}' is a system field")
    if name not in existing_columns:
        raise ValueError(f"Column '{name}' does not exist")


def _validate_new_column_name(name: str, existing_columns: list[str]) -> None:
    """Validate that a new column name is safe and doesn't conflict."""
    # The API models enforce the same pattern; repeated here because column
    # names end up inside quoted SQL identifiers, so this function must hold
    # the line even for a caller that skips the API layer.
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name):
        raise ValueError(
            "Column names may contain only letters, digits and underscores, "
            "and must not start with a digit"
        )
    if name in PROTECTED_COLUMNS:
        raise ValueError(f"Column name '{name}' is reserved")
    if name in settings.HIDDEN_FIELDS:
        raise ValueError(f"Column name '{name}' conflicts with system fields")
    if name in existing_columns:
        raise ValueError(f"Column '{name}' already exists")


def _resolve_duckdb_type(type_name: str) -> str:
    """Resolve a user-friendly type name to a DuckDB type."""
    type_lower = type_name.lower().strip()
    if type_lower not in COLUMN_TYPE_MAP:
        raise ValueError(
            f"Invalid column type: '{type_name}'. "
            f"Valid types: {', '.join(COLUMN_TYPE_MAP.keys())}"
        )
    return COLUMN_TYPE_MAP[type_lower]


#: DuckDB types a number column can have, and so can be turned into a serial.
_INTEGER_TYPES = frozenset(
    {
        "TINYINT",
        "SMALLINT",
        "INTEGER",
        "INT",
        "BIGINT",
        "HUGEINT",
        "UTINYINT",
        "USMALLINT",
        "UINTEGER",
        "UBIGINT",
    }
)
_NUMERIC_TYPES = _INTEGER_TYPES | {"DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC"}
_CONVERT_TEMP_COLUMN = "__goat_serial_convert"


def _plain_number(value: Any) -> str:
    """A whole number without a trailing ".0", anything else as it is."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _generated_in(
    field_config: dict[str, Any] | None, column_names: list[str]
) -> list[GeneratedField]:
    """The layer's generated columns that the table actually has.

    An entry for a column that is gone (dropped outside the column endpoints)
    would otherwise make every insert name a column that does not exist.
    """
    return [f for f in generated_fields(field_config) if f.name in column_names]


class FeatureWriteService:
    """Service for writing features and managing columns in DuckLake."""

    # --- Feature CRUD ---

    def create_feature(
        self,
        layer_info: LayerInfo,
        geometry: Optional[dict[str, Any]],
        properties: dict[str, Any],
        column_names: list[str],
        geometry_column: Optional[str] = None,
        field_config: dict[str, Any] | None = None,
        serial_counters: SerialCounters | None = None,
    ) -> str:
        """Create a new feature. Returns the new rowid as string.

        ``serial_counters`` carries the layer's serial high-water marks in, and
        the numbers handed out back to the caller holding the layer's lock.
        """
        table = layer_info.full_table_name

        specs = parse_computed_columns(
            field_config or {},
            geom_column=geometry_column or "geometry",
        )
        # All three are maintained by something other than the caller, so a
        # value sent for any of them is dropped rather than written. Clients
        # round-trip whole features, so this is ordinary, not a malformed
        # request.
        generated = _generated_in(field_config, column_names)
        uneditable = (
            {s.name for s in specs}
            | locked_column_names(field_config)
            | {f.name for f in generated}
        )
        # A new feature gets the column's default for anything it left blank.
        properties = apply_defaults(field_config, properties)
        validate_allowed_values(field_config, properties)

        columns: list[str] = []
        placeholders: list[str] = []
        values: list[Any] = []

        # Add geometry if present
        geom_json = None
        if geometry and geometry_column:
            geom_json = json.dumps(geometry)
            columns.append(f'"{geometry_column}"')
            placeholders.append("ST_MakeValid(ST_GeomFromGeoJSON(?))")
            values.append(geom_json)

            if "bbox" in column_names:
                columns.append('"bbox"')
                placeholders.append(BBOX_STRUCT_SQL)
                values.extend([geom_json, geom_json, geom_json, geom_json])

        # Add user-supplied properties, skipping protected AND computed names
        for col_name, col_value in properties.items():
            if (
                col_name in column_names
                and col_name not in PROTECTED_COLUMNS
                and col_name not in uneditable
            ):
                columns.append(f'"{col_name}"')
                placeholders.append("?")
                values.append(col_value)

        # Determine which computed columns need recomputing after the INSERT.
        # The compute_sql expressions reference the geometry column by name,
        # which is only valid in an UPDATE (with a FROM clause), not in VALUES.
        # So we INSERT first, then UPDATE the new row for computed columns.
        # A generated value is new on every row, so a formula reading one is
        # recomputed too.
        changed: set[str] = set()
        if geometry and geometry_column:
            changed.add("geometry")
        changed.update(properties.keys())
        changed.update(f.name for f in generated)
        recompute_specs = select_recompute_specs(specs, changed)

        with ducklake_write_manager.connection() as con:
            # Read inside the lock, so the serial numbers it continues from
            # are the ones actually in the table.
            for col_name, col_value in (
                GeneratedValues(con, table, generated, serial_counters)
                .next_row()
                .items()
            ):
                columns.append(f'"{col_name}"')
                placeholders.append("?")
                values.append(col_value)

            if columns:
                columns_str = ", ".join(columns)
                placeholders_str = ", ".join(placeholders)
                query = (
                    f"INSERT INTO {table} ({columns_str}) VALUES ({placeholders_str})"
                )
            else:
                query = f"INSERT INTO {table} DEFAULT VALUES"
            logger.debug("Create feature: %s", query)

            con.execute(query, values if columns else [])
            result = con.execute(f"SELECT max(rowid) FROM {table}").fetchone()
            rowid = result[0] if result and result[0] is not None else 0

            if recompute_specs:
                set_clauses = [f'"{s.name}" = {s.compute_sql}' for s in recompute_specs]
                update_q = (
                    f"UPDATE {table} SET {', '.join(set_clauses)} WHERE rowid = ?"
                )
                con.execute(update_q, [rowid])

            return _rowid_to_feature_id(rowid)

    def create_features_bulk(
        self,
        layer_info: LayerInfo,
        features: list[dict[str, Any]],
        column_names: list[str],
        geometry_column: Optional[str] = None,
        field_config: dict[str, Any] | None = None,
        serial_counters: SerialCounters | None = None,
    ) -> list[str]:
        """Create multiple features. Returns list of new rowids as strings.

        ``serial_counters``: as for ``create_feature``; the batch advances the
        marks by the number of features it creates.
        """
        table = layer_info.full_table_name
        feature_ids: list[str] = []

        specs = parse_computed_columns(
            field_config or {},
            geom_column=geometry_column or "geometry",
        )
        # All three are maintained by something other than the caller, so a
        # value sent for any of them is dropped rather than written. Clients
        # round-trip whole features, so this is ordinary, not a malformed
        # request.
        generated = _generated_in(field_config, column_names)
        uneditable = (
            {s.name for s in specs}
            | locked_column_names(field_config)
            | {f.name for f in generated}
        )
        # Derived once for the request: both are a projection of the same
        # field_config, and the loop below can run to thousands of features.
        defaults = column_defaults(field_config)
        constrained = allowed_value_columns(field_config)

        with ducklake_write_manager.connection() as con:
            # Once for the batch: the features get consecutive numbers.
            generator = GeneratedValues(con, table, generated, serial_counters)
            for feature_data in features:
                geometry = feature_data.get("geometry")
                properties = fill_defaults(defaults, feature_data.get("properties", {}))
                check_allowed_values(constrained, properties)

                columns: list[str] = []
                placeholders: list[str] = []
                values: list[Any] = []

                geom_json = None
                if geometry and geometry_column:
                    geom_json = json.dumps(geometry)
                    columns.append(f'"{geometry_column}"')
                    placeholders.append("ST_MakeValid(ST_GeomFromGeoJSON(?))")
                    values.append(geom_json)

                    if "bbox" in column_names:
                        columns.append('"bbox"')
                        placeholders.append(BBOX_STRUCT_SQL)
                        values.extend([geom_json, geom_json, geom_json, geom_json])

                for col_name, col_value in properties.items():
                    if (
                        col_name in column_names
                        and col_name not in PROTECTED_COLUMNS
                        and col_name not in uneditable
                    ):
                        columns.append(f'"{col_name}"')
                        placeholders.append("?")
                        values.append(col_value)
                for col_name, col_value in generator.next_row().items():
                    columns.append(f'"{col_name}"')
                    placeholders.append("?")
                    values.append(col_value)

                if columns:
                    columns_str = ", ".join(columns)
                    placeholders_str = ", ".join(placeholders)
                    query = f"INSERT INTO {table} ({columns_str}) VALUES ({placeholders_str})"
                else:
                    query = f"INSERT INTO {table} DEFAULT VALUES"
                con.execute(query, values if columns else [])

                result = con.execute(f"SELECT max(rowid) FROM {table}").fetchone()
                rowid = result[0] if result and result[0] is not None else 0

                # Recompute computed columns via UPDATE (can reference column by name).
                changed: set[str] = set()
                if geometry and geometry_column:
                    changed.add("geometry")
                changed.update(properties.keys())
                changed.update(generator.names)
                recompute_specs = select_recompute_specs(specs, changed)
                if recompute_specs:
                    set_clauses = [
                        f'"{s.name}" = {s.compute_sql}' for s in recompute_specs
                    ]
                    update_q = (
                        f"UPDATE {table} SET {', '.join(set_clauses)} WHERE rowid = ?"
                    )
                    con.execute(update_q, [rowid])

                feature_ids.append(_rowid_to_feature_id(rowid))

        return feature_ids

    def update_feature_properties(
        self,
        layer_info: LayerInfo,
        feature_id: str,
        properties: dict[str, Any],
        column_names: list[str],
        field_config: dict[str, Any] | None = None,
    ) -> bool:
        """Update feature properties by rowid (partial update)."""
        table = layer_info.full_table_name

        specs = parse_computed_columns(field_config or {})
        # Both are maintained by something other than the caller, so a value
        # sent for either is dropped rather than written. Clients round-trip
        # whole features, so this is ordinary, not a malformed request.
        uneditable = {s.name for s in specs} | locked_column_names(field_config)
        validate_allowed_values(field_config, properties)
        # A generated value sent back unchanged is dropped like the above; a
        # changed one is refused.
        generated = _generated_in(field_config, column_names)
        self._refuse_generated_changes(layer_info, feature_id, generated, properties)
        uneditable |= {f.name for f in generated}

        safe_props = {
            k: v
            for k, v in properties.items()
            if k in column_names and k not in PROTECTED_COLUMNS and k not in uneditable
        }

        set_clauses: list[str] = []
        values: list[Any] = []
        for col_name, col_value in safe_props.items():
            set_clauses.append(f'"{col_name}" = ?')
            values.append(col_value)

        if not set_clauses:
            raise ValueError("No valid properties to update")

        rid = _feature_id_to_rowid(feature_id)
        values.append(rid)
        set_str = ", ".join(set_clauses)
        query = f"UPDATE {table} SET {set_str} WHERE rowid = ?"
        logger.debug("Update feature: %s", query)

        # In a single UPDATE, all SET right-hand sides see the OLD row.
        # Run the user-supplied changes first, then a second UPDATE for any
        # computed columns whose dependencies were touched — the second
        # statement reads the post-update state.
        recompute_specs = select_recompute_specs(specs, set(properties.keys()))

        with ducklake_write_manager.connection() as con:
            con.execute(query, values)
            count_result = con.execute(
                f"SELECT COUNT(*) FROM {table} WHERE rowid = ?", [rid]
            ).fetchone()
            ok = count_result is not None and count_result[0] > 0

            if ok and recompute_specs:
                recompute_clauses = [
                    f'"{s.name}" = {s.compute_sql}' for s in recompute_specs
                ]
                con.execute(
                    f"UPDATE {table} SET {', '.join(recompute_clauses)} "
                    f"WHERE rowid = ?",
                    [rid],
                )
            return ok

    def replace_feature(
        self,
        layer_info: LayerInfo,
        feature_id: str,
        geometry: Optional[dict[str, Any]],
        properties: dict[str, Any],
        column_names: list[str],
        geometry_column: Optional[str] = None,
        field_config: dict[str, Any] | None = None,
    ) -> bool:
        """Replace a feature entirely by rowid (geometry + properties)."""
        table = layer_info.full_table_name

        specs = parse_computed_columns(
            field_config or {},
            geom_column=geometry_column or "geometry",
        )
        # Both are maintained by something other than the caller, so a value
        # sent for either is dropped rather than written. Clients round-trip
        # whole features, so this is ordinary, not a malformed request.
        uneditable = {s.name for s in specs} | locked_column_names(field_config)
        validate_allowed_values(field_config, properties)
        # A replace keeps the feature's generated values: one sent back
        # unchanged is dropped, a changed one refused.
        generated = _generated_in(field_config, column_names)
        self._refuse_generated_changes(layer_info, feature_id, generated, properties)
        uneditable |= {f.name for f in generated}

        set_clauses: list[str] = []
        values: list[Any] = []

        if geometry and geometry_column:
            set_clauses.append(
                f'"{geometry_column}" = ST_MakeValid(ST_GeomFromGeoJSON(?))'
            )
            values.append(json.dumps(geometry))

        for col_name, col_value in properties.items():
            if (
                col_name in column_names
                and col_name not in PROTECTED_COLUMNS
                and col_name not in uneditable
            ):
                set_clauses.append(f'"{col_name}" = ?')
                values.append(col_value)

        if not set_clauses:
            raise ValueError("No valid fields to update")

        if geometry and geometry_column and "bbox" in column_names:
            geom_json = json.dumps(geometry)
            set_clauses.append(f'"bbox" = {BBOX_STRUCT_SQL}')
            values.extend([geom_json, geom_json, geom_json, geom_json])

        rid = _feature_id_to_rowid(feature_id)
        values.append(rid)
        set_str = ", ".join(set_clauses)
        query = f"UPDATE {table} SET {set_str} WHERE rowid = ?"
        logger.debug("Replace feature: %s", query)

        # In a single UPDATE, every SET right-hand side is evaluated against
        # the OLD row state — so a recompute clause like
        # `"area" = ST_Area_Spheroid("geometry")` would compute on the OLD
        # geometry. Run user-supplied changes first, then a second UPDATE
        # for any computed column whose dependencies overlap what changed.
        changed: set[str] = set(properties.keys())
        if geometry and geometry_column:
            changed.add("geometry")
        recompute_specs = select_recompute_specs(specs, changed)

        with ducklake_write_manager.connection() as con:
            con.execute(query, values)
            count_result = con.execute(
                f"SELECT COUNT(*) FROM {table} WHERE rowid = ?", [rid]
            ).fetchone()
            ok = count_result is not None and count_result[0] > 0

            if ok and recompute_specs:
                recompute_clauses = [
                    f'"{s.name}" = {s.compute_sql}' for s in recompute_specs
                ]
                con.execute(
                    f"UPDATE {table} SET {', '.join(recompute_clauses)} "
                    f"WHERE rowid = ?",
                    [rid],
                )
            return ok

    def _refuse_generated_changes(
        self,
        layer_info: LayerInfo,
        feature_id: str,
        generated: list[GeneratedField],
        properties: dict[str, Any],
    ) -> None:
        """Refuse an update that would change one of the feature's generated
        values. Reads the stored values only when the update names one."""
        named = [f for f in generated if f.name in properties]
        if not named:
            return
        columns = ", ".join(f'"{f.name}"' for f in named)
        with ducklake_write_manager.connection() as con:
            row = con.execute(
                f"SELECT {columns} FROM {layer_info.full_table_name} WHERE rowid = ?",
                [_feature_id_to_rowid(feature_id)],
            ).fetchone()
        if row is None:
            # No such feature: the update itself answers 404.
            return
        current = {f.name: value for f, value in zip(named, row)}
        refuse_generated_changes(named, current, properties)

    def delete_feature(
        self,
        layer_info: LayerInfo,
        feature_id: str,
    ) -> bool:
        """Delete a single feature by feature ID."""
        table = layer_info.full_table_name
        rid = _feature_id_to_rowid(feature_id)

        with ducklake_write_manager.connection() as con:
            count = con.execute(
                f"SELECT COUNT(*) FROM {table} WHERE rowid = ?", [rid]
            ).fetchone()
            if not count or count[0] == 0:
                return False
            con.execute(f"DELETE FROM {table} WHERE rowid = ?", [rid])
            return True

    def delete_features_bulk(
        self,
        layer_info: LayerInfo,
        feature_ids: list[str],
    ) -> int:
        """Delete multiple features by feature ID."""
        table = layer_info.full_table_name
        if not feature_ids:
            return 0

        id_vals = [_feature_id_to_rowid(fid) for fid in feature_ids]
        placeholders = ", ".join(["?"] * len(id_vals))
        query = f"DELETE FROM {table} WHERE rowid IN ({placeholders})"
        logger.debug("Bulk delete: %s ids", len(id_vals))

        with ducklake_write_manager.connection() as con:
            count_before = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            con.execute(query, id_vals)
            count_after = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            return count_before - count_after

    # --- Column Management ---

    def get_column_names(self, layer_info: LayerInfo) -> list[str]:
        """Get current column names for a layer.

        DESCRIBE loads only this table's metadata; information_schema.columns
        would lazily load every table in the catalog to answer.
        """
        with ducklake_write_manager.connection() as con:
            result = con.execute(f"DESCRIBE {layer_info.sql_relation}").fetchall()
            return [row[0] for row in result]

    def get_column_types(self, layer_info: LayerInfo) -> dict[str, str]:
        """Get column name -> data_type mapping for a layer.

        DESCRIBE loads only this table's metadata; information_schema.columns
        would lazily load every table in the catalog to answer.
        """
        with ducklake_write_manager.connection() as con:
            result = con.execute(f"DESCRIBE {layer_info.sql_relation}").fetchall()
            return {row[0]: row[1] for row in result}

    def add_column(
        self,
        layer_info: LayerInfo,
        name: str,
        type_name: str,
        default_value: Any = None,
    ) -> None:
        """Add a new column to a layer.

        Args:
            layer_info: Layer info with table name
            name: Column name
            type_name: Column type (user-friendly name)
            default_value: Optional default value
        """
        table = layer_info.full_table_name
        existing_columns = self.get_column_names(layer_info)
        _validate_new_column_name(name, existing_columns)
        duckdb_type = _resolve_duckdb_type(type_name)

        query = f'ALTER TABLE {table} ADD COLUMN "{name}" {duckdb_type}'
        if default_value is not None:
            query += " DEFAULT ?"
            logger.debug("Add column: %s", query)
            with ducklake_write_manager.connection() as con:
                con.execute(query, [default_value])
        else:
            logger.debug("Add column: %s", query)
            with ducklake_write_manager.connection() as con:
                con.execute(query)

    def add_column_with_sql(
        self,
        layer_info: LayerInfo,
        name: str,
        duckdb_type: str,
        compute_sql: str | None = None,
        default_value: Any = None,
    ) -> None:
        """Add a column with an explicit DuckDB type, then optionally backfill.

        Used by core's column-add flow. `compute_sql`, if provided, must be
        a single SQL expression like `ST_Area_Spheroid("geometry")`. It is
        NOT user-supplied; it is generated from the ComputedKindRegistry on
        the core side, then sent over the internal HTTP API.
        """
        table = layer_info.full_table_name
        existing_columns = self.get_column_names(layer_info)
        _validate_new_column_name(name, existing_columns)

        alter = f'ALTER TABLE {table} ADD COLUMN "{name}" {duckdb_type}'
        with ducklake_write_manager.connection() as con:
            if default_value is not None:
                con.execute(alter + " DEFAULT ?", [default_value])
            else:
                con.execute(alter)

            if compute_sql is not None:
                backfill = f'UPDATE {table} SET "{name}" = {compute_sql}'
                con.execute(backfill)

    def backfill_generated_column(
        self,
        layer_info: LayerInfo,
        field: GeneratedField,
        serial_counters: SerialCounters | None = None,
    ) -> None:
        """Give every row of a generated column that has no value one.

        Run after the column is added, so the rows already in the layer are
        numbered (in feature order, from the column's start) or get a UUID
        each. Rows that already hold a value keep it. For a serial column the
        last number assigned is recorded in ``serial_counters``, so the
        caller's lock stores it as the column's high-water mark.
        """
        existing_columns = self.get_column_names(layer_info)
        _validate_column_name(field.name, existing_columns)
        table = layer_info.full_table_name
        marks = serial_counters.high_water if serial_counters else {}
        with ducklake_write_manager.connection() as con:
            con.execute(field.backfill_sql(table, marks.get(field.name)))
            if field.kind == "serial" and serial_counters is not None:
                row = con.execute(f'SELECT max("{field.name}") FROM {table}').fetchone()
                if row and row[0] is not None:
                    serial_counters.record(field.name, int(row[0]))

    def convert_to_serial(
        self,
        layer_info: LayerInfo,
        field: GeneratedField,
        serial_counters: SerialCounters | None = None,
    ) -> dict[str, Any]:
        """Turn an existing number column into a serial, keeping its values.

        Checked first, and refused with a ``ValueError`` saying why, unless
        every value is a whole number that appears once: a serial is an
        identifier, so a duplicate or a fraction cannot be made into one
        without changing data someone relies on. Blank rows are numbered, in
        feature order, after the highest value — refusing them instead would
        leave the user to type numbers into a column that is about to stop
        accepting typed numbers. Gaps stay gaps.

        Stored as BIGINT afterwards. Any other type (a GOAT "Number" column is
        DOUBLE) has its values moved into a new BIGINT column that takes over
        the name — one DuckLake transaction, rowids and feature ids unchanged,
        the column moving to the end of the physical column order. The highest value is
        recorded in ``serial_counters`` as the column's high-water mark.

        Returns what was done: ``{"filled": <blank rows numbered>,
        "rebuilt": <whether the column was replaced>, "max": <highest value>}``.
        """
        table = layer_info.full_table_name
        name = field.name
        column = f'"{name}"'
        types = self.get_column_types(layer_info)
        _validate_column_name(name, list(types))
        duckdb_type = types[name].upper()
        base_type = duckdb_type.split("(")[0].strip()
        if base_type not in _NUMERIC_TYPES:
            raise ValueError(
                f"'{name}' holds {duckdb_type.lower()} values; only a number "
                "column can become a serial number."
            )
        exact = base_type in _INTEGER_TYPES
        with ducklake_write_manager.connection() as con:
            checks = [
                f"count(*) FILTER (WHERE {column} > {MAX_SERIAL_VALUE} "
                f"OR {column} < -{MAX_SERIAL_VALUE})",
                f"count(*) FILTER (WHERE {column} IS NULL)",
            ]
            if not exact:
                checks.append(
                    f"count(*) FILTER (WHERE {column} IS NOT NULL AND "
                    f"(isnan({column}::DOUBLE) OR isinf({column}::DOUBLE) "
                    f"OR {column} <> floor({column})))"
                    if base_type in ("DOUBLE", "FLOAT", "REAL")
                    else f"count(*) FILTER (WHERE {column} IS NOT NULL "
                    f"AND {column} <> floor({column}))"
                )
            row = con.execute(f"SELECT {', '.join(checks)} FROM {table}").fetchone()
            too_large, blanks = int(row[0]), int(row[1])
            fractions = int(row[2]) if not exact else 0
            if fractions:
                examples = con.execute(
                    f"SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL "
                    f"AND {column} <> floor({column}) ORDER BY 1 LIMIT 5"
                ).fetchall()
                shown = ", ".join(str(r[0]) for r in examples)
                raise ValueError(
                    f"'{name}' cannot become a serial number: {fractions} "
                    f"feature(s) hold a value that is not a whole number "
                    f"(for example {shown})."
                )
            if too_large:
                raise ValueError(
                    f"'{name}' cannot become a serial number: {too_large} "
                    f"feature(s) hold a value above {MAX_SERIAL_VALUE}."
                )
            duplicates = con.execute(
                f"SELECT {column}, count(*) FROM {table} WHERE {column} IS NOT NULL "
                f"GROUP BY {column} HAVING count(*) > 1 ORDER BY {column} LIMIT 6"
            ).fetchall()
            if duplicates:
                shown = ", ".join(
                    f"{_plain_number(value)} ({count}×)"
                    for value, count in duplicates[:5]
                )
                more = " and more" if len(duplicates) > 5 else ""
                raise ValueError(
                    f"'{name}' cannot become a serial number: some values appear "
                    f"more than once: {shown}{more}. Make them unique first."
                )

            # Never ALTER ... SET DATA TYPE, although DuckLake allows widening
            # INTEGER to BIGINT: afterwards max() on the column fails on any
            # connection that read its statistics before ("Failed to bind
            # column reference ... BIGINT != INTEGER", DuckDB 1.5.4 / DuckLake),
            # and max() is what every later create runs. A fresh BIGINT column
            # writes new files with BIGINT statistics.
            rebuilt = base_type != "BIGINT"
            con.execute("BEGIN")
            try:
                if rebuilt:
                    temp = f'"{_CONVERT_TEMP_COLUMN}"'
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {temp} BIGINT")
                    con.execute(f"UPDATE {table} SET {temp} = CAST({column} AS BIGINT)")
                    con.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
                    con.execute(f"ALTER TABLE {table} RENAME COLUMN {temp} TO {column}")
                if blanks:
                    marks = serial_counters.high_water if serial_counters else {}
                    con.execute(field.backfill_sql(table, marks.get(name)))
                con.execute("COMMIT")
            except Exception:
                con.execute("ROLLBACK")
                raise
            highest = con.execute(f"SELECT max({column}) FROM {table}").fetchone()[0]
        if highest is not None and serial_counters is not None:
            serial_counters.record(name, int(highest))
        return {
            "filled": blanks,
            "rebuilt": rebuilt,
            "max": int(highest) if highest is not None else None,
        }

    def backfill_column(
        self,
        layer_info: LayerInfo,
        name: str,
        compute_sql: str,
    ) -> None:
        """Recompute every row of an existing column from a SQL expression.

        Used when a formula column's expression changes without changing its
        result type. `compute_sql` must already be validated and
        parenthesized by the caller.
        """
        table = layer_info.full_table_name
        existing_columns = self.get_column_names(layer_info)
        _validate_column_name(name, existing_columns)

        with ducklake_write_manager.connection() as con:
            con.execute(f'UPDATE {table} SET "{name}" = {compute_sql}')

    def rename_column(
        self,
        layer_info: LayerInfo,
        old_name: str,
        new_name: str,
    ) -> None:
        """Rename a column.

        Args:
            layer_info: Layer info with table name
            old_name: Current column name
            new_name: New column name
        """
        table = layer_info.full_table_name
        existing_columns = self.get_column_names(layer_info)
        _validate_column_name(old_name, existing_columns)
        _validate_new_column_name(new_name, existing_columns)

        query = f'ALTER TABLE {table} RENAME COLUMN "{old_name}" TO "{new_name}"'
        logger.debug("Rename column: %s", query)

        with ducklake_write_manager.connection() as con:
            con.execute(query)

    def delete_column(
        self,
        layer_info: LayerInfo,
        name: str,
    ) -> None:
        """Delete a column from a layer.

        Args:
            layer_info: Layer info with table name
            name: Column name to delete
        """
        table = layer_info.full_table_name
        existing_columns = self.get_column_names(layer_info)
        _validate_column_name(name, existing_columns)

        query = f'ALTER TABLE {table} DROP COLUMN "{name}"'
        logger.debug("Delete column: %s", query)

        with ducklake_write_manager.connection() as con:
            con.execute(query)


# Singleton instance
feature_write_service = FeatureWriteService()
