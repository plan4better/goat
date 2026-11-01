"""Conditional (If/Else) node — boolean-expression evaluation against an upstream layer.

The Conditional node is a workflow control-flow primitive: it evaluates a
boolean expression against its upstream input layer and emits its result on
either the ``true`` or ``false`` source handle. The executor uses the active
handle to prune the inactive branch's downstream subgraph.

Two modes:
- **simple**: a structured rule (logical filter rows + statistic-aggregate rows)
  combined under a top-level AND/OR. Compiled into a single aggregate SQL
  expression.
- **custom**: a free-text DuckDB SQL boolean expression with ``{{@variable}}``
  references resolved against the workflow variable map.

The evaluated expression is run as ``SELECT (<expr>) FROM <layer>`` against the
upstream DuckLake layer; the scalar result determines the active handle.
"""

import logging
from typing import Any

from goatlib.config.postgres import TOOLS_APPLICATION_NAME
from goatlib.utils.layer import (
    catalog_layer_parquet,
    get_schema_for_layer,
    layer_id_to_table_name,
    layer_table_path,
)

logger = logging.getLogger(__name__)


# Reserved source-handle ids for the Conditional node's two outputs.
# Mirrored in apps/web/lib/validations/workflow.ts.
IF_TRUE_HANDLE = "true"
IF_FALSE_HANDLE = "false"


_STATISTIC_METHOD_TO_SQL = {
    "count": "COUNT(*)",
    "sum": 'COALESCE(SUM("{field}"), 0)',
    "mean": 'AVG("{field}")',
    "median": 'MEDIAN("{field}")',
    "min": 'MIN("{field}")',
    "max": 'MAX("{field}")',
}

_ALLOWED_STAT_OPERATORS = {"=", "!=", ">", ">=", "<", "<="}


def _statistic_row_to_sql_term(row: dict[str, Any]) -> str | None:
    """Convert a single statistic-row dict to a boolean SQL term.

    e.g. ``{method: "count", operator: ">", value: 100}`` →
    ``"(COUNT(*) > 100)"``
    """
    method = row.get("method")
    operator = row.get("operator")
    value = row.get("value")
    field = row.get("field")

    if (
        method not in _STATISTIC_METHOD_TO_SQL
        or operator not in _ALLOWED_STAT_OPERATORS
    ):
        return None
    if method != "count" and not field:
        return None

    template = _STATISTIC_METHOD_TO_SQL[method]
    if method == "count":
        agg_sql = template
    else:
        # Field name comes from a layer schema; quote with double quotes. We
        # additionally strip any embedded quotes defensively.
        safe_field = str(field).replace('"', "")
        agg_sql = template.format(field=safe_field)

    # Threshold: numeric literal preferred; fall back to a quoted string if
    # not numeric (e.g. when comparing a date/varchar field via min/max).
    if value is None:
        return None
    try:
        float(str(value))
        value_sql = str(value)
    except (TypeError, ValueError):
        # Escape single quotes by doubling them — DuckDB SQL literal convention.
        escaped = str(value).replace("'", "''")
        value_sql = f"'{escaped}'"

    return f"({agg_sql} {operator} {value_sql})"


def _logical_rows_to_sql_term(
    logical_rows: list[dict[str, Any]],
    top_op: str,
    column_names: list[str],
) -> str | None:
    """Convert one or more logical filter rows to a single boolean SQL term
    evaluated *over the whole layer* (``MAX(CASE WHEN <where> THEN 1 ELSE 0
    END) = 1`` — true iff any row in the layer satisfies the filter).

    All logical rows are combined under ``top_op`` (``and`` / ``or``); the
    statistic rows (if any) are combined with this term at a higher level.
    """
    if not logical_rows:
        return None

    # Lazy import to avoid a circular dependency with workflow_runner.
    from goatlib.tools.workflow_runner import convert_filter_to_cql

    cql_filter = convert_filter_to_cql({"op": top_op, "expressions": logical_rows})
    if not cql_filter:
        return None

    try:
        from goatlib.storage import cql_to_where_clause

        where = cql_to_where_clause(cql_filter, column_names, "geometry", inline=True)
    except Exception as exc:
        logger.warning("Failed to convert logical rows to SQL WHERE: %s", exc)
        return None
    if not isinstance(where, str):
        return None

    return f"(MAX(CASE WHEN ({where}) THEN 1 ELSE 0 END) = 1)"


def _build_simple_condition_sql(
    condition: dict[str, Any] | None,
    column_names: list[str],
) -> str | None:
    """Build a single boolean SQL expression for the Conditional node's
    Simple-mode condition. Returns ``None`` if the condition is empty.

    The result is meant to be embedded as ``SELECT (<expr>) FROM <input>`` —
    statistic and logical terms aggregate over ``<input>`` directly.
    """
    if not condition:
        return None
    expressions = condition.get("expressions") or []
    if not expressions:
        return None

    top_op = (condition.get("op") or "and").lower()
    if top_op not in ("and", "or"):
        top_op = "and"
    joiner = " AND " if top_op == "and" else " OR "

    logical_rows: list[dict[str, Any]] = []
    statistic_terms: list[str] = []
    for row in expressions:
        if not isinstance(row, dict):
            continue
        kind = row.get("kind")
        if kind == "statistic":
            term = _statistic_row_to_sql_term(row)
            if term:
                statistic_terms.append(term)
        else:
            logical_rows.append(row)

    logical_term = _logical_rows_to_sql_term(logical_rows, top_op, column_names)

    parts: list[str] = []
    if logical_term:
        parts.append(logical_term)
    parts.extend(statistic_terms)

    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return "(" + joiner.join(parts) + ")"


def _resolve_layer_sql_ref(
    layer_id: str, user_id: str, manager: Any | None = None
) -> str:
    """Resolve a layer id to a DuckDB-queryable reference.

    - Project layer (no colons): the table path. With a DuckLake manager the
      schema is looked up in the catalog; without one it falls back to the
      computed path.
    - Temp layer (``workflow_id:node_id[:uuid]``): a ``read_parquet(...)`` call
      against the parquet file written by the upstream tool under
      ``/data/temporary/user_<uid>/w_<wfid>/n_<node>/t_<uuid>.parquet``.
    """
    from goatlib.tools.temp_writer import TEMP_DATA_ROOT

    user_id_clean = user_id.replace("-", "")

    if ":" in layer_id:
        parts = layer_id.split(":")
        workflow_id = parts[0]
        node_id = parts[1]
        temp_uuid = parts[2] if len(parts) > 2 else None
        workflow_id_clean = workflow_id.replace("-", "")
        base = (
            TEMP_DATA_ROOT
            / f"user_{user_id_clean}"
            / f"w_{workflow_id_clean}"
            / f"n_{node_id}"
        )
        if temp_uuid:
            parquet_path = base / f"t_{temp_uuid}.parquet"
        else:
            matches = list(base.glob("t_*.parquet"))
            if not matches:
                raise FileNotFoundError(
                    f"The result of step {node_id} was not found. "
                    f"The upstream tool may not have completed successfully."
                )
            parquet_path = matches[0]
        return f"read_parquet('{parquet_path}')"

    # A promoted catalog layer is one parquet file, not a DuckLake table. Same
    # check the base runner makes, so an if-node and the tool downstream of it
    # agree about what they are reading.
    catalog_path = catalog_layer_parquet(layer_id)
    if catalog_path is not None:
        return f"read_parquet('{catalog_path}')"

    if manager is not None:
        try:
            schema = get_schema_for_layer(layer_id, manager)
            return f"lake.{schema}.{layer_id_to_table_name(layer_id)}"
        except Exception as exc:
            logger.warning(
                "Could not resolve schema for layer %s, using computed path: %s",
                layer_id,
                exc,
            )
    return layer_table_path(layer_id)


def _fetch_layer_columns(layer_id: str, user_id: str) -> list[str]:
    """Return the column names of the upstream layer for CQL field validation.

    The CQL → DuckDB SQL evaluator rejects any field reference that isn't in
    the provided column list (see `cql_evaluator.DuckDBCQLEvaluator`), so we
    must pre-populate this list before building the boolean SQL.
    """
    try:
        from goatlib.storage import BaseDuckLakeManager
        from goatlib.tools.base import ToolSettings

        settings = ToolSettings.from_env()
        manager = BaseDuckLakeManager(
            read_only=True, application_name=TOOLS_APPLICATION_NAME
        )
        manager.init_from_params(
            postgres_uri=settings.ducklake_postgres_uri,
            storage_path=settings.ducklake_data_dir,
            catalog_schema=settings.ducklake_catalog_schema,
        )
        ref = _resolve_layer_sql_ref(layer_id, user_id, manager)
        try:
            with manager.connection() as con:
                rows = con.execute(f"DESCRIBE SELECT * FROM {ref} LIMIT 0").fetchall()
                return [r[0] for r in rows]
        finally:
            try:
                manager.close()
            except Exception:
                pass
    except Exception as exc:
        logger.warning("Failed to fetch columns for layer %s: %s", layer_id, exc)
        return []


def _evaluate_boolean_sql_against_layer(
    boolean_sql: str,
    layer_id: str,
    user_id: str,
    where_clause: str | None = None,
) -> bool:
    """Run ``SELECT (<boolean_sql>) FROM <layer> [WHERE ...]`` against the layer.

    Used for both modes — the boolean SQL is a single aggregate expression that
    collapses the whole layer to one boolean value. When ``where_clause`` is
    given (from the upstream layer's filter), the condition is evaluated only
    over the matching rows.

    Resolves project layers to their catalog table path and temp layers to
    a ``read_parquet(...)`` reference. See `_resolve_layer_sql_ref`.
    """
    try:
        from goatlib.storage import BaseDuckLakeManager
        from goatlib.tools.base import ToolSettings

        settings = ToolSettings.from_env()
        manager = BaseDuckLakeManager(
            read_only=True, application_name=TOOLS_APPLICATION_NAME
        )
        manager.init_from_params(
            postgres_uri=settings.ducklake_postgres_uri,
            storage_path=settings.ducklake_data_dir,
            catalog_schema=settings.ducklake_catalog_schema,
        )
        ref = _resolve_layer_sql_ref(layer_id, user_id, manager)
        try:
            with manager.connection() as con:
                query = f"SELECT ({boolean_sql}) AS r FROM {ref}"
                if where_clause:
                    query += f" WHERE {where_clause}"
                row = con.execute(query).fetchone()
                return bool(row[0]) if row is not None else False
        finally:
            try:
                manager.close()
            except Exception:
                pass
    except Exception as eval_err:
        logger.warning(
            "If-condition layer-bound eval failed for %s: %s",
            layer_id,
            eval_err,
        )
        return False


def execute_if_node(
    node: dict,
    upstream_layer_id: str | None,
    user_id: str,
    var_map: dict[str, Any],
    upstream_filter: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Evaluate a Conditional (binary if/else) node.

    The caller pre-resolves ``upstream_layer_id`` by inspecting the incoming
    edge into the ``input`` target handle — it flows through to whichever
    branch is active. ``upstream_filter`` carries the CQL2-JSON filter set on
    the source layer (e.g. a dataset node), so the condition is evaluated over
    the filtered rows only — the same CQL→WHERE mechanism the tools use.

    Modes:
    - ``simple``: build a single boolean SQL expression from the rule rows
      (logical filters + statistic aggregates), combined under the top-level
      AND/OR. TRUE iff the expression evaluates truthy against the upstream
      layer.
    - ``custom``: take the user's free-text SQL boolean (after substituting
      ``{{@var}}`` references) as the boolean expression directly.

    The result carries:
    - ``status``: "completed"
    - ``active_handle``: ``IF_TRUE_HANDLE`` or ``IF_FALSE_HANDLE``
    - ``temp_layer_id``: passthrough of the upstream layer so downstream tools
      on the active branch consume the same data.
    """
    node_id = node["id"]
    data = node.get("data", {})
    mode = data.get("mode") or "simple"

    # Fetch column names so the CQL evaluator can validate logical-row field
    # references (it rejects unknown fields with ValueError, which would
    # otherwise silently turn the whole rule into False) and so the upstream
    # filter can be compiled to a WHERE clause.
    column_names = (
        _fetch_layer_columns(upstream_layer_id, user_id) if upstream_layer_id else []
    )

    # Build the boolean SQL expression for whichever mode is active.
    boolean_sql: str | None = None
    if mode == "simple":
        # Resolve {{@variable}} references in the condition rows so values
        # the user typed (statistic threshold, logical row value) are
        # substituted with their concrete values — same path tool inputs
        # use in `build_tool_inputs`.
        raw_condition = data.get("condition")
        condition = raw_condition
        if isinstance(raw_condition, dict) and var_map:
            from goatlib.tools.workflow_runner import substitute_variables_in_config

            try:
                condition = substitute_variables_in_config(raw_condition, var_map)
            except ValueError as exc:
                logger.warning(
                    "If-node condition variable substitution failed: %s", exc
                )
                condition = raw_condition
        boolean_sql = _build_simple_condition_sql(
            condition,
            column_names=column_names,
        )
    else:
        custom_expr = data.get("customExpression") or ""
        if custom_expr.strip():
            # Lazy import to avoid a circular dependency with workflow_runner.
            from goatlib.tools.workflow_runner import resolve_variables

            try:
                resolved = resolve_variables(custom_expr, var_map)
                if isinstance(resolved, str):
                    boolean_sql = resolved
            except ValueError as exc:
                logger.warning(
                    "Custom expression variable substitution failed: %s", exc
                )
            if boolean_sql:
                # It runs inside a query on a DuckLake connection: only an
                # expression over the upstream layer's columns is allowed.
                from goatlib.utils.sql_validation import validate_sql_expression

                validate_sql_expression(boolean_sql)

    # Compile the upstream layer's filter to a WHERE clause so the condition is
    # evaluated only over matching rows (same CQL→WHERE helper used above for
    # the logical rows, and that export_layer_to_parquet uses for the tools).
    filter_where: str | None = None
    if upstream_filter and upstream_layer_id:
        from goatlib.storage import cql_to_where_clause

        try:
            filter_where = cql_to_where_clause(
                upstream_filter, column_names, "geometry", inline=True
            )
        except Exception as exc:
            logger.warning("If-node upstream filter compile failed: %s", exc)

    # Decide active handle.
    if not boolean_sql or not upstream_layer_id:
        active_handle = IF_FALSE_HANDLE
    else:
        matched = _evaluate_boolean_sql_against_layer(
            boolean_sql, upstream_layer_id, user_id, where_clause=filter_where
        )
        active_handle = IF_TRUE_HANDLE if matched else IF_FALSE_HANDLE

    print(
        f"[if_node] Conditional {node_id}: mode={mode} "
        f"active_handle={active_handle} upstream_layer={upstream_layer_id}"
    )

    return {
        "node_id": node_id,
        "status": "completed",
        "active_handle": active_handle,
        "temp_layer_id": upstream_layer_id,
    }
