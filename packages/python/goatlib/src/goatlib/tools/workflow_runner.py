"""Workflow Runner - Executes workflow graphs in Windmill.

This script receives a workflow definition (nodes + edges) and executes
all tool nodes in topological order using temp_mode for preview results.

Uses Windmill's workflow-as-code feature (@wmill.task decorator) to get
proper progress tracking with running/completed status for each node.

Usage:
    Called from frontend via Windmill API when user clicks "Run Workflow"
"""

import asyncio
import logging
import re
from typing import Any

import asyncpg
import wmill
from pydantic import BaseModel, Field

from goatlib.tools.if_node import IF_FALSE_HANDLE, execute_if_node
from goatlib.tools.workflow_dataset_nodes import (
    current_layer_ids,
    project_layer_ids,
    with_current_layer_ids,
)
from goatlib.utils.credentials import redact_credentials

logger = logging.getLogger(__name__)

# Pattern to strip usernames from Windmill cancellation messages
# e.g. "cancelled by majkshkurti (reason: User requested dismissal)" -> "cancelled (reason: User requested dismissal)"
_CANCEL_USER_RE = re.compile(r"cancelled by \S+")

# Numbered opportunity-layer canvas handles, e.g. "opportunity_layer_2_id"
_NUMBERED_OPPORTUNITY = re.compile(r"opportunity_layer_(\d+)_id")


def _sanitize_error_msg(msg: str) -> str:
    """A step's error text without the username of a Windmill cancellation
    and without credentials."""
    return redact_credentials(_CANCEL_USER_RE.sub("cancelled", msg))


class WorkflowNode(BaseModel):
    """A node in the workflow graph."""

    id: str
    type: str  # "dataset", "tool", "export", "textAnnotation", "if"
    data: dict[str, Any]


class WorkflowEdge(BaseModel):
    """An edge connecting two nodes."""

    id: str
    source: str
    target: str
    sourceHandle: str | None = None  # noqa: N815 - matches React Flow structure
    targetHandle: str | None = None  # noqa: N815 - matches React Flow structure


class WorkflowRunnerParams(BaseModel):
    """Parameters for workflow runner."""

    user_id: str = Field(..., description="User UUID")
    project_id: str = Field(..., description="Project UUID")
    workflow_id: str = Field(..., description="Workflow UUID for temp storage")
    folder_id: str = Field(..., description="Folder UUID for project")
    nodes: list[dict[str, Any]] = Field(..., description="Workflow nodes")
    edges: list[dict[str, Any]] = Field(..., description="Workflow edges")
    variables: list[dict[str, Any]] = Field(
        default_factory=list, description="Workflow variables"
    )


class WorkflowResult(BaseModel):
    """Result from workflow execution."""

    status: str = "success"
    node_results: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Results keyed by node_id",
    )
    errors: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Any errors encountered",
    )


def variable_map(variables: list[dict[str, Any]]) -> dict[str, Any]:
    """Each workflow variable's value, keyed by the name references use.

    A variable is resolved by ``name`` alone: the editor's optional ``label``
    and ``description`` are display-only and ride along in the payload
    without affecting a run. Entries without a name are skipped.
    """
    return {v["name"]: v.get("defaultValue") for v in variables if v.get("name")}


# Regex to match {{@variable_name}} references
VARIABLE_PATTERN = re.compile(r"\{\{@([a-zA-Z_][a-zA-Z0-9_]*)\}\}")


def resolve_variables(
    value: Any,  # noqa: ANN401
    var_map: dict[str, Any],
) -> Any:  # noqa: ANN401
    """Resolve {{@variable_name}} references in a value.

    If the entire value is a single variable reference, the resolved value
    preserves its original type (e.g., number stays number).
    If a variable is embedded in a larger string, the result is always a string.
    """
    if not isinstance(value, str):
        return value

    # Full match: entire value is one variable reference — preserve type
    match = VARIABLE_PATTERN.fullmatch(value)
    if match:
        var_name = match.group(1)
        if var_name not in var_map:
            raise ValueError(f"Unknown workflow variable: {var_name}")
        return var_map[var_name]

    # Embedded references: substitute within the string
    def _replace(m: re.Match) -> str:  # type: ignore[type-arg]
        var_name = m.group(1)
        if var_name not in var_map:
            raise ValueError(f"Unknown workflow variable: {var_name}")
        return str(var_map[var_name])

    if VARIABLE_PATTERN.search(value):
        return VARIABLE_PATTERN.sub(_replace, value)

    return value


def substitute_variables_in_config(
    config: dict[str, Any],
    var_map: dict[str, Any],
) -> dict[str, Any]:
    """Recursively substitute variable references in a node config dict."""
    resolved: dict[str, Any] = {}
    for key, value in config.items():
        if isinstance(value, dict):
            resolved[key] = substitute_variables_in_config(value, var_map)
        elif isinstance(value, list):
            resolved[key] = [
                substitute_variables_in_config(item, var_map)
                if isinstance(item, dict)
                else resolve_variables(item, var_map)
                for item in value
            ]
        else:
            resolved[key] = resolve_variables(value, var_map)
    return resolved


def coerce_inputs_from_schema(
    process_id: str,
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Coerce input values to match the tool's Pydantic schema types.

    When workflow variables resolve a single value for a field that expects
    a list (e.g. ``distances: List[float]`` receives ``100`` instead of
    ``[100]``), wrap the scalar in a list.
    """
    from goatlib.tools.registry import get_tool

    tool_def = get_tool(process_id)
    if not tool_def:
        return inputs

    try:
        params_class = tool_def.get_params_class()
        schema = params_class.model_json_schema()
    except Exception:
        return inputs

    properties = schema.get("properties", {})
    defs = schema.get("$defs", {})

    for key, value in inputs.items():
        if key not in properties or isinstance(value, (list, type(None))):
            continue

        prop = properties[key]
        if _schema_expects_array(prop, defs):
            inputs[key] = [value]

    return inputs


def _schema_expects_array(
    prop: dict[str, Any],
    defs: dict[str, Any],
) -> bool:
    """Check if a JSON schema property expects an array type."""
    # Direct {"type": "array"}
    if prop.get("type") == "array":
        return True

    # anyOf / oneOf (e.g. Optional[List[float]] → [{"type": "array", ...}, {"type": "null"}])
    for variant_key in ("anyOf", "oneOf"):
        variants = prop.get(variant_key)
        if variants:
            for variant in variants:
                if variant.get("type") == "array":
                    return True
                # Follow $ref
                ref = variant.get("$ref")
                if ref and ref.startswith("#/$defs/"):
                    ref_name = ref.split("/")[-1]
                    ref_schema = defs.get(ref_name, {})
                    if ref_schema.get("type") == "array":
                        return True

    return False


def _field_expects_layer_object(
    process_id: str | None,
    field_name: str,
) -> bool:
    """Check if a tool field expects an object with a ``layer_id`` property.

    Some tools (e.g. catchment_area) have complex input types like
    ``StartingPointsLayer`` that expect ``{"layer_id": "..."}`` rather than
    a plain layer_id string. When building workflow inputs from edges we need
    to wrap the layer_id accordingly.
    """
    if not process_id:
        return False
    # Simple heuristic: fields ending with _id are plain string layer refs
    if field_name.endswith("_id"):
        return False

    from goatlib.tools.registry import get_tool

    tool_def = get_tool(process_id)
    if not tool_def:
        return False

    try:
        params_class = tool_def.get_params_class()
        schema = params_class.model_json_schema()
    except Exception:
        return False

    properties = schema.get("properties", {})
    defs = schema.get("$defs", {})
    prop = properties.get(field_name)
    if not prop:
        return False

    # Check if any variant is an object type with a "layer_id" required field
    def _has_layer_id(obj_schema: dict) -> bool:  # noqa: ANN401
        if obj_schema.get("type") != "object":
            return False
        return "layer_id" in obj_schema.get("properties", {})

    # Direct object
    if _has_layer_id(prop):
        return True

    # anyOf / oneOf with $ref to object defs
    for variant_key in ("anyOf", "oneOf"):
        variants = prop.get(variant_key)
        if not variants:
            continue
        for variant in variants:
            if _has_layer_id(variant):
                return True
            ref = variant.get("$ref")
            if ref and ref.startswith("#/$defs/"):
                ref_name = ref.split("/")[-1]
                ref_schema = defs.get(ref_name, {})
                if _has_layer_id(ref_schema):
                    return True

    return False


def topological_sort(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Sort nodes in execution order (dependencies first).

    Uses Kahn's algorithm for topological sorting.
    """
    # Build in-degree map
    in_degree: dict[str, int] = {n["id"]: 0 for n in nodes}
    graph: dict[str, list[str]] = {n["id"]: [] for n in nodes}

    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source in graph and target in in_degree:
            graph[source].append(target)
            in_degree[target] += 1

    # Start with nodes that have no dependencies
    queue = [nid for nid, deg in in_degree.items() if deg == 0]
    result: list[dict] = []

    while queue:
        node_id = queue.pop(0)
        node = next((n for n in nodes if n["id"] == node_id), None)
        if node:
            result.append(node)

            for neighbor in graph.get(node_id, []):
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

    return result


def get_input_layer_id(
    source_node: dict,
    results: dict[str, dict],
) -> str | None:
    """Get the layer_id from a source node.

    For dataset nodes: use the configured layerId
    For tool nodes: use the temp_layer_id from previous result
    For if nodes: pass through the temp_layer_id stored when the If executed
    """
    node_type = source_node.get("data", {}).get("type")
    node_id = source_node["id"]

    if node_type == "dataset":
        # Dataset nodes have a configured layer_id
        return source_node.get("data", {}).get("layerId")

    elif node_type in ("tool", "if"):
        # Tool/If nodes - get result from previous execution
        prev_result = results.get(node_id)
        if prev_result:
            # Temp mode returns temp_layer_id
            return prev_result.get("temp_layer_id") or prev_result.get("layer_id")

    return None


def _bfs_downstream(start_node_ids: set[str], edges: list[dict[str, Any]]) -> set[str]:
    """Collect all node ids reachable downstream from any of ``start_node_ids``.

    Does NOT include the starting ids themselves — only what they fan out into.
    """
    if not start_node_ids:
        return set()
    # Build adjacency map: source -> list of targets
    adj: dict[str, list[str]] = {}
    for e in edges:
        adj.setdefault(e["source"], []).append(e["target"])

    visited: set[str] = set()
    frontier: list[str] = []
    for nid in start_node_ids:
        for nxt in adj.get(nid, []):
            if nxt not in visited:
                visited.add(nxt)
                frontier.append(nxt)
    while frontier:
        nid = frontier.pop()
        for nxt in adj.get(nid, []):
            if nxt not in visited:
                visited.add(nxt)
                frontier.append(nxt)
    return visited


def mark_skipped_descendants(
    if_node_id: str,
    edges: list[dict[str, Any]],
    active_handle: str,
    results: dict[str, dict[str, Any]],
) -> set[str]:
    """Reachability pass: mark every descendant reached *only* via non-active
    handles of the given If node as skipped.

    A node reached through any active path (e.g. branches re-converging on the
    same downstream tool) is NOT skipped — that's why we compute the difference
    ``inactive_reached - active_reached`` rather than just collecting the
    inactive subtree.

    Returns the set of node ids newly marked skipped.
    """
    # Find the immediate downstream node ids reached via active vs. inactive handles.
    active_starts: set[str] = set()
    inactive_starts: set[str] = set()
    for e in edges:
        if e["source"] != if_node_id:
            continue
        handle = e.get("sourceHandle")
        target = e["target"]
        if handle == active_handle:
            active_starts.add(target)
        else:
            inactive_starts.add(target)

    # An immediate child on the active handle is itself active-reached.
    active_reached = set(active_starts) | _bfs_downstream(active_starts, edges)
    inactive_reached = set(inactive_starts) | _bfs_downstream(inactive_starts, edges)

    newly_skipped: set[str] = set()
    for node_id in inactive_reached - active_reached:
        # Don't overwrite a node that already produced a real result.
        existing = results.get(node_id)
        if existing and existing.get("status") == "completed":
            continue
        results[node_id] = {"status": "skipped", "skipped_by": if_node_id}
        newly_skipped.add(node_id)
    return newly_skipped


# Mapping from frontend expression names to CQL2 operators
_EXPRESSION_TO_CQL_OP = {
    "is": "=",
    "is_not": "!=",
    "is_at_least": ">=",
    "is_at_most": "<=",
    "is_less_than": "<",
    "is_greater_than": ">",
    "is_empty_string": "=",
    "is_not_empty_string": "!=",
}


def _convert_expression_to_cql(expression: dict) -> dict | None:
    """Convert a single frontend Expression object to a CQL2-JSON node."""
    expr_type = expression.get("expression")
    attribute = expression.get("attribute")
    value = expression.get("value")

    if not expr_type or not attribute:
        return None

    prop = {"property": attribute}

    if expr_type == "is_blank":
        return {"op": "isNull", "args": prop}
    if expr_type == "is_not_blank":
        return {"op": "not", "args": [{"op": "isNull", "args": prop}]}
    if expr_type == "starts_with":
        return {"op": "like", "args": [prop, f"{value}%"]}
    if expr_type == "ends_with":
        return {"op": "like", "args": [prop, f"%{value}"]}
    if expr_type == "contains_the_text":
        return {"op": "like", "args": [prop, f"%{value}%"]}
    if expr_type == "does_not_contains_the_text":
        return {
            "op": "not",
            "args": [{"op": "like", "args": [prop, f"%{value}%"]}],
        }
    if expr_type == "is_between":
        parts = str(value).split("-")
        v1, v2 = float(parts[0]), float(parts[1])
        return {
            "op": "and",
            "args": [
                {"op": ">=", "args": [prop, v1]},
                {"op": "<=", "args": [prop, v2]},
            ],
        }
    if expr_type == "s_intersects":
        import json as _json

        geom = _json.loads(value) if isinstance(value, str) else value
        return {"op": "s_intersects", "args": [prop, geom]}
    if expr_type == "includes":
        values = value if isinstance(value, list) else [value]
        args = [{"op": "=", "args": [prop, v]} for v in values]
        return {"op": "or", "args": args}
    if expr_type == "excludes":
        values = value if isinstance(value, list) else [value]
        args = [{"op": "!=", "args": [prop, v]} for v in values]
        return {"op": "and", "args": args}
    if expr_type in ("is_empty_string", "is_not_empty_string"):
        op = "=" if expr_type == "is_empty_string" else "!="
        return {"op": op, "args": [prop, ""]}

    # Simple comparison operators (is, is_not, is_at_least, etc.)
    cql_op = _EXPRESSION_TO_CQL_OP.get(expr_type)
    if cql_op:
        return {"op": cql_op, "args": [prop, value]}

    return None


def convert_filter_to_cql(filter_config: dict) -> dict | None:
    """Convert frontend Expression-format filter to CQL2-JSON format.

    Frontend stores filters as:
        {op: "and", expressions: [{attribute, expression, value, ...}, ...]}
    Backend expects CQL2-JSON:
        {op: "and", args: [{op: "=", args: [{property: "field"}, value]}, ...]}

    If already in CQL2-JSON format (has 'args' key), returns as-is.
    """
    if not filter_config:
        return None

    # Already in CQL2-JSON format
    if "args" in filter_config and "expressions" not in filter_config:
        return filter_config

    expressions = filter_config.get("expressions", [])
    if not expressions:
        return None

    logical_op = filter_config.get("op", "and")
    cql_args = []
    for expr in expressions:
        cql_node = _convert_expression_to_cql(expr)
        if cql_node:
            cql_args.append(cql_node)

    if not cql_args:
        return None
    if len(cql_args) == 1:
        return cql_args[0]
    return {"op": logical_op, "args": cql_args}


def export_style(
    export_data: dict[str, Any], source_result: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The style an export's result gets when it becomes a new layer.

    A template remembers how its author styled each export's result
    (``outputStyle``, see core's ``with_output_styles``); that look wins
    over the source tool's default. An export that overwrites an earlier
    result keeps that layer's own style either way (finalize_layer).
    """
    remembered = export_data.get("outputStyle")
    if isinstance(remembered, dict) and remembered:
        return remembered
    source_properties = (source_result or {}).get("properties")
    return source_properties if isinstance(source_properties, dict) else None


def build_tool_inputs(
    node: dict,
    edges: list[dict],
    all_nodes: list[dict],
    results: dict[str, dict],
    params: WorkflowRunnerParams,
) -> dict[str, Any]:
    """Build the input parameters for a tool node.

    Combines:
    - Node's configured parameters
    - Input layer IDs from connected nodes
    - Workflow context (user_id, project_id, temp_mode, etc.)
    """
    # Start with node's configured parameters
    node_data = node.get("data", {})
    inputs: dict[str, Any] = dict(node_data.get("config", {}))

    # Substitute workflow variables in config values
    var_map = variable_map(params.variables)
    if var_map:
        inputs = substitute_variables_in_config(inputs, var_map)

    # Coerce scalar values to lists where the tool schema expects arrays
    process_id = node_data.get("processId")
    if process_id:
        inputs = coerce_inputs_from_schema(process_id, inputs)

    # Process incoming edges to get layer inputs
    for edge in edges:
        if edge["target"] != node["id"]:
            continue

        source_node = next(
            (n for n in all_nodes if n["id"] == edge["source"]),
            None,
        )
        if not source_node:
            continue

        # Determine target handle (input parameter name)
        target_handle = edge.get("targetHandle", "input_layer_id")

        # Get layer_id from source
        layer_id = get_input_layer_id(source_node, results)
        if layer_id:
            # Get optional filter from dataset nodes
            source_type = source_node.get("data", {}).get("type")
            filter_config = None
            if source_type == "dataset":
                raw_filter = source_node.get("data", {}).get("filter") or None
                filter_config = (
                    convert_filter_to_cql(raw_filter) if raw_filter else None
                )

            # Check if the target field expects an object with a layer_id
            # property (e.g. StartingPointsLayer) rather than a plain string
            if _field_expects_layer_object(process_id, target_handle):
                layer_obj: dict[str, Any] = {"layer_id": layer_id}
                if filter_config:
                    layer_obj["layer_filter"] = filter_config
                inputs[target_handle] = layer_obj
            else:
                inputs[target_handle] = layer_id
                if filter_config:
                    base = (
                        target_handle[:-3]
                        if target_handle.endswith("_id")
                        else target_handle
                    )
                    filter_key = f"{base}_filter"
                    inputs[filter_key] = filter_config

    # For custom_sql: compact sparse numbered inputs so they start at 1.
    # E.g. if only input_layer_2_id is connected, remap it to input_layer_1_id
    # so the SQL alias "input_1" always refers to the first connected layer.
    process_id = node_data.get("processId")
    if process_id == "custom_sql":
        numbered_keys = sorted(
            k
            for k in list(inputs)
            if k.startswith("input_layer_") and k.endswith("_id")
        )
        for new_idx, key in enumerate(numbered_keys, start=1):
            new_key = f"input_layer_{new_idx}_id"
            if key != new_key:
                inputs[new_key] = inputs.pop(key)
                # Also remap the corresponding filter key
                old_filter = key.replace("_id", "_filter")
                new_filter = new_key.replace("_id", "_filter")
                if old_filter in inputs:
                    inputs[new_filter] = inputs.pop(old_filter)

    # For merge: build input_paths list from numbered input_path_N inputs.
    if process_id == "merge":
        path_keys = sorted(
            k
            for k in list(inputs)
            if k.startswith("input_path_")
            and not k.endswith("_filter")
            and k != "input_paths"
        )
        if path_keys:
            input_paths: list[dict[str, Any]] = []
            for key in path_keys:
                layer_id = inputs.pop(key)
                if not layer_id:
                    continue
                filter_key = f"{key}_filter"
                layer_filter = inputs.pop(filter_key, None)
                item: dict[str, Any] = {"input_path": layer_id}
                if layer_filter:
                    item["input_layer_filter"] = layer_filter
                input_paths.append(item)
            if input_paths:
                inputs["input_paths"] = input_paths

    # Heatmaps expose numbered opportunity_layer_N_id handles on the canvas
    # instead of the repeatable opportunities list. Keyed on the input shape,
    # not the tool name, so legacy and v2 heatmaps are handled alike — the
    # per-opportunity field names are the same in both (v2's opportunity model
    # inherits v1's). The number is required: Huff takes a single
    # `opportunity_layer_id` that must stay a plain layer id.
    # Ordered by the handle number, not the key text, so a tenth handle can't
    # sort ahead of the second.
    numbered = sorted(
        (
            (int(match.group(1)), key)
            for key in list(inputs)
            if (match := _NUMBERED_OPPORTUNITY.fullmatch(key))
        )
    )
    if numbered:
        opportunities: list[dict[str, Any]] = []
        for opp_num, key in numbered:
            layer_id = inputs.pop(key)
            if not layer_id:
                continue
            # Pop the corresponding filter
            filter_key = key.replace("_id", "_filter")
            layer_filter = inputs.pop(filter_key, None)

            # Collect per-opportunity config (opportunity_1_max_cost, etc.)
            prefix = f"opportunity_{opp_num}_"
            opp_config: dict[str, Any] = {}
            for cfg_key in list(inputs):
                if cfg_key.startswith(prefix):
                    param_name = cfg_key[len(prefix) :]
                    opp_config[param_name] = inputs.pop(cfg_key)

            opportunity: dict[str, Any] = {
                "input_path": layer_id,
                **opp_config,
            }
            if layer_filter:
                opportunity["input_layer_filter"] = layer_filter
            opportunities.append(opportunity)

        if opportunities:
            inputs["opportunities"] = opportunities

    # Add workflow context
    inputs["user_id"] = params.user_id
    inputs["project_id"] = params.project_id
    inputs["folder_id"] = params.folder_id

    # Enable temp mode for workflow preview
    inputs["temp_mode"] = True
    inputs["workflow_id"] = params.workflow_id
    inputs["node_id"] = node["id"]

    # Set layer name from node label
    inputs["result_layer_name"] = node_data.get("label", "Workflow Result")

    return inputs


def run_tool_node(
    node_id: str,
    process_id: str,
    inputs: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Execute a single tool node and return job info.

    Args:
        node_id: The workflow node ID
        process_id: The tool/process ID (e.g., "buffer")
        inputs: Tool parameters including temp_mode context

    Returns:
        Tuple of (job_id, result_dict)
    """
    import time

    script_path = f"f/goat/tools/{process_id}"

    print(f"[{node_id}] Running {script_path}")
    print(f"[{node_id}] Input keys: {list(inputs.keys())}")

    # Record start time
    start_time = time.time()

    # Create async job - this sets parent_job automatically
    job_id = wmill.run_script_async(script_path, args=inputs)
    print(f"[{node_id}] Created job: {job_id}")

    try:
        # Poll for job completion.
        # Note: we do NOT call wmill.cancel_running() here — that method cancels
        # *other* running instances of this script (it's an action, not a check),
        # which mutually-murders concurrent workflow runs. If the parent workflow
        # is cancelled by the user, Windmill will SIGTERM this process; the
        # child tool job runs to completion and its result is simply discarded.
        while True:
            status = wmill.get_job_status(job_id)

            if status == "COMPLETED":
                result = wmill.get_result(job_id)
                elapsed = time.time() - start_time
                duration_ms = int(elapsed * 1000)

                # Check if the result contains an error (job failed)
                if isinstance(result, dict) and "error" in result:
                    error_info = result["error"]
                    error_msg = (
                        error_info.get("message", str(error_info))
                        if isinstance(error_info, dict)
                        else str(error_info)
                    )
                    print(f"[{node_id}] Failed in {elapsed:.1f}s: {error_msg}")
                    # Return error result with timing and job_id
                    return job_id, {
                        "node_id": node_id,
                        "process_id": process_id,
                        "job_id": job_id,
                        "error": error_info,
                        "duration_ms": duration_ms,
                    }

                print(f"[{node_id}] Completed in {elapsed:.1f}s")
                # Store duration and job_id in result
                result["duration_ms"] = duration_ms
                result["job_id"] = job_id
                break
            elif status in ("CANCELED", "CANCELLED_BY_TIMEOUT"):
                raise RuntimeError(f"Job {job_id} was cancelled")

            time.sleep(1)  # Poll every second

    except Exception as e:
        print(f"[{node_id}] Error: {e}")
        raise

    return job_id, {
        "node_id": node_id,
        "process_id": process_id,
        "job_id": job_id,
        **result,
    }


async def _connect() -> tuple[asyncpg.Connection, str]:
    """A connection to the GOAT database, and its customer schema."""
    from goatlib.tools.base import ToolSettings

    settings = ToolSettings.from_env()
    conn = await asyncpg.connect(
        **settings.postgres_connect_args(),
    )
    return conn, settings.customer_schema


def resolve_dataset_layers(params: WorkflowRunnerParams) -> list[dict[str, Any]]:
    """The workflow's nodes with each dataset node reading the layer its
    project entry shows now (see ``workflow_dataset_nodes``)."""
    link_ids = project_layer_ids(params.nodes)
    if not link_ids:
        return params.nodes

    async def lookup() -> dict[int, str]:
        conn, schema = await _connect()
        try:
            current: dict[int, str] = await current_layer_ids(
                conn,
                schema,
                user_id=params.user_id,
                project_id=params.project_id,
                link_ids=link_ids,
            )
            return current
        finally:
            await conn.close()

    try:
        current = asyncio.run(lookup())
    except Exception as e:
        # The layer ids as saved are right unless a re-run moved an entry to
        # a new layer since (finalize also rewrites the saved ids then), so a
        # lookup failure must not take the whole run down with it. Only the
        # error type is logged: job output is shown to the user, and a
        # connection error can carry the database address and credentials.
        message = (
            "Could not look up dataset nodes' project layers "
            f"({type(e).__name__}); using the layer ids as saved"
        )
        logger.warning(message)
        print(f"[workflow_runner] {message}")
        return params.nodes
    nodes: list[dict[str, Any]] = with_current_layer_ids(params.nodes, current)
    return nodes


def cleanup_previous_results(params: WorkflowRunnerParams) -> None:
    """Clean up temp files from previous workflow run."""
    from goatlib.tools.cleanup_temp import cleanup_workflow_temp

    cleanup_workflow_temp(
        user_id=params.user_id,
        workflow_id=params.workflow_id,
    )


def _produced_source(
    node_id: str, edges: list[dict], results: dict[str, dict]
) -> tuple[str, dict] | None:
    """The upstream node whose temp result a final node (export, append)
    writes: the first non-empty produced source, else any produced source."""
    produced = [
        (e["source"], results.get(e["source"]) or {})
        for e in edges
        if e["target"] == node_id
        and (results.get(e["source"]) or {}).get("temp_layer_id")
    ]
    if not produced:
        return None
    return next(
        ((sid, r) for sid, r in produced if (r.get("feature_count") or 0) > 0),
        produced[0],
    )


def _appends_to_existing(node: dict) -> bool:
    """A "Save as dataset" node set to "Add to existing"."""
    data = node.get("data", {})
    return data.get("type") == "export" and data.get("destination") == "existing"


def run_append_nodes(
    params: "WorkflowRunnerParams",
    sorted_nodes: list[dict],
    edges: list[dict],
    results: dict[str, dict],
    node_jobs: dict[str, str],
    errors: list[dict],
) -> None:
    """Run the "Save as dataset" nodes set to "Add to existing" through
    ``finalize_layer`` with a ``target_layer_id``.

    Called once every tool and export node succeeded. Each node commits on
    its own; a failure is recorded in ``errors`` like an export's.
    """
    append_nodes = [n for n in sorted_nodes if _appends_to_existing(n)]
    if append_nodes:
        print(f"[workflow_runner] Processing {len(append_nodes)} append node(s)...")
    for node in append_nodes:
        node_id = node["id"]
        data = node.get("data", {})
        if results.get(node_id, {}).get("status") == "skipped":
            print(
                f"[workflow_runner] Append node {node_id} on rejected branch, skipping"
            )
            continue
        target = data.get("targetLayerId")
        if not target:
            errors.append({"node_id": node_id, "error": "Choose a target layer."})
            continue
        produced = _produced_source(node_id, edges, results)
        if produced is None:
            errors.append(
                {
                    "node_id": node_id,
                    "error": "Connect the result of a tool to this node; a dataset "
                    "cannot be appended directly.",
                }
            )
            continue
        source_node_id, source_result = produced
        # If-nodes pass an upstream temp_layer_id through without writing a
        # temp dir: append from the node that actually wrote it.
        temp_parts = (source_result.get("temp_layer_id") or "").split(":")
        temp_node_id = temp_parts[1] if len(temp_parts) >= 2 else source_node_id
        inputs = {
            "user_id": params.user_id,
            "workflow_id": params.workflow_id,
            "node_id": temp_node_id,
            "export_node_id": node_id,
            "project_id": params.project_id,
            "folder_id": params.folder_id,
            "target_layer_id": target,
            "add_to_project": bool(data.get("addToProject", True)),
            "delete_temp": False,
        }
        try:
            job_id, result = run_tool_node(node_id, "finalize_layer", inputs)
            node_jobs[node_id] = job_id
            results[node_id] = result
            if "error" in result:
                print(
                    f"[workflow_runner] Append node {node_id} failed: {result.get('error')}"
                )
                errors.append({"node_id": node_id, "error": result.get("error")})
            else:
                print(
                    f"[workflow_runner] Append node {node_id} completed: "
                    f"{result.get('rows_appended')} row(s) into {target}"
                )
        except Exception as e:
            print(f"[workflow_runner] Append node {node_id} failed: {e}")
            logger.error(f"Append node {node_id} failed: {e}")
            errors.append({"node_id": node_id, "error": str(e)})


def main(
    user_id: str,
    project_id: str,
    workflow_id: str,
    folder_id: str,
    nodes: list[dict],
    edges: list[dict],
    variables: list[dict] | None = None,
) -> dict:
    """Execute workflow: run all tool nodes in topological order.

    This is the Windmill entry point.

    Args:
        user_id: User UUID
        project_id: Project UUID
        workflow_id: Workflow UUID (used for temp storage path)
        folder_id: Folder UUID
        nodes: List of workflow nodes
        edges: List of workflow edges

    Returns:
        Execution results for each node
    """
    print(f"[workflow_runner] Starting workflow {workflow_id}")
    print(f"[workflow_runner] user_id={user_id}, project_id={project_id}")
    print(f"[workflow_runner] nodes={len(nodes)}, edges={len(edges)}")

    params = WorkflowRunnerParams(
        user_id=user_id,
        project_id=project_id,
        workflow_id=workflow_id,
        folder_id=folder_id,
        nodes=nodes,
        edges=edges,
        variables=variables or [],
    )

    # Dataset nodes read what their project entry shows now: a re-run may
    # have put a new layer behind an entry the node still names by old id.
    nodes = resolve_dataset_layers(params)
    params.nodes = nodes

    # Clean up previous temp results for this workflow
    print("[workflow_runner] Cleaning up previous results...")
    cleanup_previous_results(params)
    print("[workflow_runner] Cleanup complete")

    # Sort nodes by dependency order
    print("[workflow_runner] Sorting nodes...")
    sorted_nodes = topological_sort(nodes, edges)
    print(f"[workflow_runner] Sorted {len(sorted_nodes)} nodes")

    # Track results per node and node→job mapping
    results: dict[str, dict] = {}
    node_jobs: dict[str, str] = {}  # node_id → child job_id
    errors: list[dict] = []

    # Variable map for If-node condition evaluation
    if_var_map = variable_map(params.variables)

    # Execute each tool node
    # Child jobs have parent_job set automatically, so backend can query
    # Windmill for jobs with parent_job={this_job_id} to track progress
    for node in sorted_nodes:
        node_type = node.get("data", {}).get("type")
        node_id = node["id"]

        # Honor pre-marked skipped status (set by an upstream If node's
        # reachability pass).
        if results.get(node_id, {}).get("status") == "skipped":
            print(f"[workflow_runner] Skipping node {node_id} (rejected branch)")
            continue

        # If/Switch branching node: evaluate cases in order, mark the chosen
        # active handle, and prune unreachable descendants.
        if node_type == "if":
            print(f"[workflow_runner] Evaluating If node {node_id}...")
            try:
                # Single input edge — the upstream layer flows through to the
                # active True/False branch.
                incoming_input = next(
                    (e for e in edges if e["target"] == node_id),
                    None,
                )
                upstream_layer_id: str | None = None
                upstream_filter: dict | None = None
                if incoming_input:
                    source_node = next(
                        (n for n in nodes if n["id"] == incoming_input["source"]),
                        None,
                    )
                    if source_node is not None:
                        upstream_layer_id = get_input_layer_id(source_node, results)
                        # Carry the source layer's filter (dataset nodes) so the
                        # condition is evaluated over the filtered rows.
                        if source_node.get("data", {}).get("type") == "dataset":
                            raw_filter = (
                                source_node.get("data", {}).get("filter") or None
                            )
                            upstream_filter = (
                                convert_filter_to_cql(raw_filter)
                                if raw_filter
                                else None
                            )
                if_result = execute_if_node(
                    node,
                    upstream_layer_id,
                    params.user_id,
                    if_var_map,
                    upstream_filter=upstream_filter,
                )
                results[node_id] = if_result
                skipped = mark_skipped_descendants(
                    node_id,
                    edges,
                    if_result.get("active_handle", IF_FALSE_HANDLE),
                    results,
                )
                if skipped:
                    print(
                        f"[workflow_runner] If {node_id} pruned {len(skipped)} "
                        f"downstream node(s): {sorted(skipped)}"
                    )
            except Exception as e:
                print(f"[workflow_runner] If node {node_id} failed: {e}")
                logger.error(f"If node {node_id} failed: {e}")
                errors.append({"node_id": node_id, "error": str(e)})
                break
            continue

        # Skip remaining non-tool nodes (datasets, results, exports)
        if node_type != "tool":
            continue

        process_id = node.get("data", {}).get("processId")

        if not process_id:
            errors.append({"node_id": node_id, "error": "No processId"})
            continue

        print(f"[workflow_runner] Executing node {node_id} ({process_id})...")

        try:
            # Build inputs for this tool
            inputs = build_tool_inputs(node, edges, nodes, results, params)
            print(f"[workflow_runner] Inputs built for {node_id}")

            # Execute the tool - returns (job_id, result)
            job_id, result = run_tool_node(node_id, process_id, inputs)

            # Track the node→job mapping
            node_jobs[node_id] = job_id
            results[node_id] = result

            # Check if node failed (result contains error)
            if "error" in result:
                print(f"[workflow_runner] Node {node_id} failed: {result.get('error')}")
                errors.append(
                    {
                        "node_id": node_id,
                        "error": result.get("error"),
                    }
                )
                # Stop execution on error - downstream nodes depend on this
                break

            print(
                f"[workflow_runner] Node {node_id} completed: {result.get('temp_layer_id')}"
            )

        except Exception as e:
            print(f"[workflow_runner] Node {node_id} failed: {e}")
            logger.error(f"Node {node_id} failed: {e}")
            errors.append(
                {
                    "node_id": node_id,
                    "error": str(e),
                }
            )
            # Stop execution on error - downstream nodes depend on this
            break

    print(
        f"[workflow_runner] Tool nodes complete: {len(results)} results, {len(errors)} errors"
    )

    # Finalize export nodes (only if no errors from tool execution)
    if not errors:
        # "Save as dataset" set to "Add to existing" appends instead; those run
        # in the append phase below.
        export_nodes = [
            n
            for n in sorted_nodes
            if n.get("data", {}).get("type") == "export" and not _appends_to_existing(n)
        ]
        if export_nodes:
            print(f"[workflow_runner] Processing {len(export_nodes)} export node(s)...")

        for export_node in export_nodes:
            export_node_id = export_node["id"]
            export_data = export_node.get("data", {})
            dataset_name = export_data.get("datasetName", "").strip()

            # Honor skipped status from the reachability pass — don't finalize
            # exports on a rejected branch.
            if results.get(export_node_id, {}).get("status") == "skipped":
                print(
                    f"[workflow_runner] Export node {export_node_id} on rejected "
                    f"branch, skipping"
                )
                continue

            if not dataset_name:
                print(
                    f"[workflow_runner] Export node {export_node_id}: no dataset name, skipping"
                )
                continue

            produced = _produced_source(export_node_id, edges, results)
            if produced is None:
                print(
                    f"[workflow_runner] Export node {export_node_id}: "
                    f"no produced source, skipping"
                )
                continue
            source_node_id, source_result = produced

            print(
                f"[workflow_runner] Finalizing export node {export_node_id} "
                f"(source={source_node_id}, name={dataset_name})"
            )

            try:
                overwrite_previous = bool(export_data.get("overwritePrevious"))

                # If-nodes pass an upstream temp_layer_id through without writing a temp dir.
                temp_parts = (source_result.get("temp_layer_id") or "").split(":")
                temp_node_id = temp_parts[1] if len(temp_parts) >= 2 else source_node_id

                finalize_inputs = {
                    "user_id": params.user_id,
                    "workflow_id": params.workflow_id,
                    "node_id": temp_node_id,  # Node that actually wrote the temp dir
                    "export_node_id": export_node_id,  # Identity key for overwrite + status tracking
                    "project_id": params.project_id,
                    "folder_id": params.folder_id,
                    "layer_name": dataset_name,
                    "delete_temp": False,  # Keep temp files for frontend preview
                    "overwrite_previous": overwrite_previous,
                }

                properties = export_style(export_data, source_result)
                if properties:
                    finalize_inputs["properties"] = properties

                job_id, result = run_tool_node(
                    export_node_id, "finalize_layer", finalize_inputs
                )

                node_jobs[export_node_id] = job_id
                results[export_node_id] = result

                if "error" in result:
                    print(
                        f"[workflow_runner] Export node {export_node_id} failed: "
                        f"{result.get('error')}"
                    )
                    errors.append(
                        {
                            "node_id": export_node_id,
                            "error": result.get("error"),
                        }
                    )
                else:
                    print(
                        f"[workflow_runner] Export node {export_node_id} completed: "
                        f"layer_id={result.get('layer_id')}"
                    )

            except Exception as e:
                print(f"[workflow_runner] Export node {export_node_id} failed: {e}")
                logger.error(f"Export node {export_node_id} failed: {e}")
                errors.append(
                    {
                        "node_id": export_node_id,
                        "error": str(e),
                    }
                )

    # Append nodes, after the exports and only if every step so far succeeded.
    if not errors:
        run_append_nodes(params, sorted_nodes, edges, results, node_jobs, errors)

    print(
        f"[workflow_runner] Workflow complete: {len(results)} results, {len(errors)} errors"
    )

    result = WorkflowResult(
        status="success" if not errors else "partial",
        node_results=results,
        errors=errors,
    ).model_dump()

    # Add node_jobs mapping to result for final reference
    result["node_jobs"] = node_jobs

    # If there were errors, raise to mark job as failed in Windmill
    if errors:
        # Build error message from first error
        first_error = errors[0]
        error_info = first_error.get("error", {})
        if isinstance(error_info, dict):
            error_msg = error_info.get("message", str(error_info))
        else:
            error_msg = str(error_info)
        node_id = first_error.get("node_id", "unknown")
        raise RuntimeError(f"Node {node_id} failed: {_sanitize_error_msg(error_msg)}")

    return result
