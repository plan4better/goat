"""Custom SQL tool for Windmill.

Allows users to execute custom SQL SELECT queries against workflow layers
and project/catalog layers, producing a new output table/layer.

Layers are loaded as named DuckDB views using fixed aliases:
- input_1, input_2, input_3: from connected workflow inputs
- User-defined aliases: from additional project/catalog layers

Security: Only SELECT statements (and WITH/CTEs) are allowed.
DDL/DML statements are rejected.
"""

import logging
import re
from pathlib import Path
from typing import Any, Self

import duckdb
from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_OUTPUT,
    SECTION_RESULT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.utils.sql_validation import validate_sql_query

logger = logging.getLogger(__name__)


class CustomSqlToolParams(ToolInputBase):
    """Parameters for custom SQL tool.

    The 3 input layer fields are optional — users connect 0-3 upstream nodes.
    Additional layers can be added from project/catalog for more complex queries.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            UISection(
                id="input",
                order=1,
                icon="layers",
            ),
            UISection(
                id="sql",
                order=2,
                icon="table",
            ),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    # Connected workflow inputs (0-3 optional layer-selector handles)
    # Custom SQL accepts both vector (spatial) and table (non-spatial) data
    input_layer_1_id: str | None = Field(
        None,
        description="First input layer (connected from workflow)",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            label_key="input_layer_1",
            widget_options={"data_types": ["vector", "table"]},
        ),
    )
    input_layer_1_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter for first input layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )
    input_layer_2_id: str | None = Field(
        None,
        description="Second input layer (connected from workflow)",
        json_schema_extra=ui_field(
            section="input",
            field_order=3,
            widget="layer-selector",
            label_key="input_layer_2",
            widget_options={"data_types": ["vector", "table"]},
        ),
    )
    input_layer_2_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter for second input layer",
        json_schema_extra=ui_field(section="input", field_order=4, hidden=True),
    )
    input_layer_3_id: str | None = Field(
        None,
        description="Third input layer (connected from workflow)",
        json_schema_extra=ui_field(
            section="input",
            field_order=5,
            widget="layer-selector",
            label_key="input_layer_3",
            widget_options={"data_types": ["vector", "table"]},
        ),
    )
    input_layer_3_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter for third input layer",
        json_schema_extra=ui_field(section="input", field_order=6, hidden=True),
    )

    # The SQL query
    sql_query: str = Field(
        "",
        description="SQL SELECT statement to execute against the input layers",
        json_schema_extra=ui_field(
            section="sql",
            field_order=1,
            label_key="sql_query",
        ),
    )

    # Additional layers from project/catalog (not connected via edges)
    additional_layers: list[dict[str, Any]] | None = Field(
        None,
        description="Additional layers from project/catalog: [{layerId, alias, layerName}]",
        json_schema_extra=ui_field(section="sql", field_order=2, hidden=True),
    )

    # Override result_layer_name default
    result_layer_name: str | None = Field(
        "Custom SQL",
        description="Name for the result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
        ),
    )


class CustomSqlToolRunner(BaseToolRunner[CustomSqlToolParams]):
    """Custom SQL tool runner for Windmill.

    Loads input layers as DuckDB views and executes a user-provided
    SELECT statement, writing the result to a new layer.
    """

    tool_class = None  # type: ignore[assignment]
    output_geometry_type = None  # Dynamic — depends on SQL output
    default_output_name = "Custom SQL"

    @classmethod
    def _resolve_input_alias(
        cls: type["CustomSqlToolRunner"], input_key: str, index: int
    ) -> str:
        """Map an input schema key to the table alias used in SQL queries.

        Handles both correct keys (input_layer_1_id) and fallback keys
        (input, input_layer_id) that may occur when edge handles aren't
        fully resolved yet.
        """
        # Exact mapping for known keys
        alias_mapping = {
            "input_layer_1_id": "input_1",
            "input_layer_2_id": "input_2",
            "input_layer_3_id": "input_3",
        }
        if input_key in alias_mapping:
            return alias_mapping[input_key]

        # Fallback: if the key is already a valid alias, use it directly
        if input_key.startswith("input_") and input_key[-1].isdigit():
            return input_key

        # Last resort: derive alias from position (0-based index → input_1, etc.)
        return f"input_{index + 1}"

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict output schema by executing SQL with LIMIT 0.

        Creates in-memory DuckDB tables from input schemas and runs the
        user's SQL with LIMIT 0 to determine output column types.
        """
        sql_query = params.get("sql_query", "")
        if not sql_query or not sql_query.strip():
            # No SQL yet, return empty schema
            return {}

        # Substitute workflow variable templates ({{@var_name}}) with a
        # neutral placeholder so DuckDB can parse the SQL. We only care
        # about column names/types, not actual values, so 1 is safe.
        sql_query = re.sub(r"\{\{@\w+\}\}", "1", sql_query)

        try:
            validate_sql_query(sql_query)
        except ValueError:
            return {}

        con = duckdb.connect()
        try:
            # Spatial extension is optional — needed only for geometry columns
            try:
                con.execute("INSTALL spatial; LOAD spatial;")
            except Exception:
                logger.debug("Spatial extension not available for schema prediction")

            has_spatial = False
            try:
                con.execute("SELECT ST_Point(0, 0)")
                has_spatial = True
            except Exception:
                pass

            # Create mock tables from input schemas
            for idx, (input_key, columns) in enumerate(input_schemas.items()):
                alias = cls._resolve_input_alias(input_key, idx)

                col_defs = []
                if columns:
                    for col_name, col_type in columns.items():
                        # Normalize geometry columns
                        if "GEOMETRY" in col_type.upper():
                            if has_spatial:
                                col_defs.append(f'"{col_name}" GEOMETRY')
                            else:
                                # Fall back to BLOB when spatial is unavailable
                                col_defs.append(f'"{col_name}" BLOB')
                        else:
                            col_defs.append(f'"{col_name}" {col_type}')

                if not col_defs:
                    # Schema not yet available — create table with placeholder
                    col_defs = ['"_placeholder" INTEGER']

                create_sql = f'CREATE TABLE "{alias}" ({", ".join(col_defs)})'
                con.execute(create_sql)

            # Execute the user's SQL with LIMIT 0 to get column types
            limited_sql = f"SELECT * FROM ({sql_query}) _pred LIMIT 0"
            result = con.execute(limited_sql)

            # Extract column names and types from the result description
            columns: dict[str, str] = {}
            if result.description:
                for col_desc in result.description:
                    col_name = col_desc[0]
                    # DuckDB returns Python type objects in description[1]
                    # We need the actual DuckDB type string
                    columns[col_name] = "VARCHAR"  # Default

                # Get actual types via DESCRIBE
                describe_result = con.execute(
                    f"DESCRIBE SELECT * FROM ({sql_query}) _pred LIMIT 0"
                )
                for row in describe_result.fetchall():
                    col_name, col_type = row[0], row[1]
                    columns[col_name] = col_type

            return columns

        except Exception as e:
            logger.warning(f"Schema prediction failed for custom SQL: {e}")
            return {}
        finally:
            con.close()

    def _register_layer_as_view(
        self: Self,
        con: duckdb.DuckDBPyConnection,
        alias: str,
        parquet_path: str,
    ) -> None:
        """Register a parquet file as a named view in DuckDB.

        Args:
            con: DuckDB connection
            alias: Table alias (e.g., "input_1", "buildings")
            parquet_path: Path to the parquet file
        """
        # Sanitize alias to prevent SQL injection (only allow alphanumeric + underscore)
        if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", alias):
            raise ValueError(
                f"Invalid table alias '{alias}': must contain only letters, "
                f"numbers, and underscores, and start with a letter or underscore"
            )

        # DuckDB writes no GeoParquet metadata for an empty table, so an empty
        # input (e.g. an intermediate workflow result without rows) reads back
        # with its geometry as WKB BLOB and spatial functions on it fail to
        # bind. Restore the geometry type.
        columns = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
        ).fetchall()
        select = "*"
        if any(c[0] == "geometry" and str(c[1]).upper() == "BLOB" for c in columns):
            select = '* REPLACE (ST_GeomFromWKB("geometry") AS "geometry")'

        con.execute(
            f'CREATE VIEW "{alias}" AS SELECT {select} '
            f"FROM read_parquet('{parquet_path}')"
        )
        logger.info(f"Registered view '{alias}' from {parquet_path}")

    def process(
        self: Self, params: CustomSqlToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Execute the custom SQL query against input layers.

        1. Validate the SQL query
        2. Export and register each input layer as a DuckDB view
        3. Execute the user's SELECT statement
        4. Write result to parquet
        """
        # Step 1: Validate SQL: it may read only the inputs registered below
        aliases = {"input_1", "input_2", "input_3"} | {
            str(layer.get("alias"))
            for layer in params.additional_layers or []
            if isinstance(layer, dict) and layer.get("alias")
        }
        validate_sql_query(params.sql_query, aliases)

        # Create a fresh in-memory DuckDB for isolated execution
        con = duckdb.connect()
        try:
            con.execute("INSTALL spatial; LOAD spatial;")

            # Step 2: Register connected inputs as views
            layer_inputs = [
                ("input_1", params.input_layer_1_id, params.input_layer_1_filter),
                ("input_2", params.input_layer_2_id, params.input_layer_2_filter),
                ("input_3", params.input_layer_3_id, params.input_layer_3_filter),
            ]

            for alias, layer_id, layer_filter in layer_inputs:
                if not layer_id:
                    continue

                parquet_path = self.export_layer_to_parquet(
                    layer_id=layer_id,
                    user_id=params.user_id,
                    cql_filter=layer_filter,
                )
                self._register_layer_as_view(con, alias, parquet_path)

            # Step 3: Register additional layers
            if params.additional_layers:
                for layer_info in params.additional_layers:
                    layer_id = layer_info.get("layerId")
                    alias = layer_info.get("alias")
                    if not layer_id or not alias:
                        continue

                    parquet_path = self.export_layer_to_parquet(
                        layer_id=layer_id,
                        user_id=params.user_id,
                    )
                    self._register_layer_as_view(con, alias, parquet_path)

            # Step 4: Execute the user's SQL query
            logger.info(f"Executing custom SQL: {params.sql_query[:200]}...")
            output_path = temp_dir / "output.parquet"

            con.execute(
                f"COPY ({params.sql_query}) TO '{output_path}' "
                f"(FORMAT PARQUET, COMPRESSION ZSTD)"
            )

            logger.info(f"Custom SQL result written to {output_path}")

            # Detect geometry to choose source_type
            has_geometry = False
            try:
                col_info = con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{output_path}') LIMIT 0"
                ).fetchall()
                has_geometry = any("GEOMETRY" in row[1].upper() for row in col_info)
            except Exception:
                pass

            metadata = DatasetMetadata(
                path=str(output_path),
                source_type="vector" if has_geometry else "tabular",
            )

            return output_path, metadata

        finally:
            con.close()


def main(params: CustomSqlToolParams) -> dict:
    """Windmill entry point for custom SQL tool.

    Args:
        params: Parameters matching CustomSqlToolParams schema

    Returns:
        Dict with output layer metadata
    """
    runner = CustomSqlToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
