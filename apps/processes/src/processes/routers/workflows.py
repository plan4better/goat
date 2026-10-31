"""Workflow execution router.

Provides endpoints for executing workflows via Windmill,
plus metadata/schema prediction for workflow nodes.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from goatlib.tools.cleanup_temp import cleanup_workflow_temp
from goatlib.workflows.checks import Issue, shape_issues
from pydantic import BaseModel, Field

from processes.deps.auth import get_user_id, oauth2_scheme
from processes.ducklake import ducklake_manager
from processes.routers.processes import get_language_from_request
from processes.services.access import (
    REGISTERED_TOOLS,
    TEMP_LAYER_PART_RE,
    UUID_RE,
    References,
    ensure_allowed,
    ensure_safe_workflow_ids,
    refused_references,
    refused_workflow_nodes,
    workflow_references,
)
from processes.services.windmill_client import WindmillClient, WindmillError
from processes.services.workflow_checks import (
    check_workflow,
    ducklake_layer_fields,
    recorded_feature_count,
    step_name,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/workflows", tags=["Workflows"])

# Windmill client
windmill_client = WindmillClient()

# Path to workflow runner script in Windmill
WORKFLOW_RUNNER_PATH = "f/goat/tools/workflow_runner"

# Temp data root - matches temp_writer.py
TEMP_DATA_ROOT = Path("/app/data/temporary")


class WorkflowExecuteRequest(BaseModel):
    """Request body for workflow execution."""

    project_id: str = Field(..., description="Project UUID")
    folder_id: str = Field(..., description="Folder UUID")
    # Items of any shape: a step or connection that is not an object makes a
    # damaged workflow, answered with its issues like any other.
    nodes: list[Any] = Field(..., description="Workflow nodes")
    edges: list[Any] = Field(..., description="Workflow edges")
    variables: list[dict[str, Any]] = Field(
        default_factory=list, description="Workflow variables"
    )


class WorkflowExecuteResponse(BaseModel):
    """Response from workflow execution."""

    job_id: str = Field(..., description="Windmill job ID")
    workflow_id: str = Field(..., description="Workflow UUID")
    status: str = Field(default="submitted", description="Job status")


class WorkflowCheckRequest(BaseModel):
    """A workflow to check: the steps as the editor holds them, saved or not."""

    project_id: UUID = Field(
        ..., description="Project the workflow belongs to; the caller must read it"
    )
    nodes: list[Any] = Field(..., description="Workflow nodes")
    edges: list[Any] = Field(..., description="Workflow edges")
    variables: list[dict[str, Any]] = Field(
        default_factory=list, description="Workflow variables"
    )


class WorkflowCheckResponse(BaseModel):
    """The workflow's issues (`goatlib.workflows.checks.Issue.to_dict()`)."""

    issues: list[dict[str, Any]] = Field(..., description="Workflow issues")


# Issue levels that refuse a run.
BLOCKING_LEVELS = frozenset({"damaged", "error"})


def _steps_to_check(nodes: list[Any]) -> list[dict[str, Any]]:
    """The steps whose references the access check collects: every step but
    one naming a tool outside the registry. `check_workflow` reports that
    step (`tool_missing`, `tool_removed`), so it is an issue rather than a
    refused request."""
    steps: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = node.get("data")
        if (
            isinstance(data, dict)
            and data.get("type") == "tool"
            and str(data.get("processId") or "") not in REGISTERED_TOOLS
        ):
            continue
        steps.append(node)
    return steps


def _access_issues(
    steps: list[dict[str, Any]],
    edges: list[Any],
    denied: list[dict[str, str]],
    reported: list[Issue],
    language: str,
) -> list[Issue]:
    """What the caller may not use, as issues `check_workflow` has not
    already reported: each step naming data they may not read, and the
    destination when they may not write it."""
    already = {
        node_id
        for issue in reported
        if issue.code == "layer_not_readable"
        for node_id in issue.node_ids
    }
    by_id = {str(step.get("id")): step for step in steps}
    issues: list[Issue] = []
    for node_id in refused_workflow_nodes(steps, denied, edges=edges):
        if node_id in already:
            continue
        name = step_name(by_id[node_id], language=language)
        issues.append(
            Issue(
                code="layer_not_readable",
                level="error",
                message=f"{name}: you cannot read the data this step uses.",
                node_ids=(node_id,),
                params={"step": name},
            )
        )
    if any(
        entry.get("kind") in ("project", "folder") and entry.get("action") == "write"
        for entry in denied
    ):
        issues.append(
            Issue(
                code="destination_not_writable",
                level="error",
                message="You cannot save results in this project or its folder.",
            )
        )
    return issues


async def _workflow_issues(
    user_id: UUID,
    nodes: list[Any],
    edges: list[Any],
    variables: list[dict[str, Any]],
    *,
    project_id: str,
    folder_id: str | None,
    language: str,
    run: bool,
) -> list[Issue]:
    """The issues of a workflow in which `shape_issues` found nothing damaged.

    One access round trip covers the steps' data and either the project (a
    check: the caller must be able to read it, else 404) or the destination
    (a run: `destination_not_writable` when the caller cannot write it). The
    destination is a run's issue only: a viewer checking a workflow would
    otherwise see it on every one.
    """
    steps = _steps_to_check(nodes)
    if run:
        refs = workflow_references(steps, project_id, folder_id, edges=edges)
    else:
        refs = workflow_references(steps, None, None, edges=edges)
        refs.add("project", project_id, "read")
    denied = await refused_references(user_id, refs)
    if denied:
        logger.info("access denied user=%s refs=%s", user_id, denied)
    if any(e.get("kind") == "project" and e.get("action") == "read" for e in denied):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
        )
    # Every refused id a step can name: layers, project entries and networks
    # (bundles). `check_workflow` matches them against dataset layers and
    # tool settings (`access.refused_workflow_nodes`).
    unreadable = frozenset(
        str(e.get("raw_id", e.get("id")))
        for e in denied
        if e.get("kind") in ("layer", "layer_project", "bundle")
    )
    checked = await check_workflow(
        nodes,
        edges,
        variables,
        language=language,
        unreadable_layer_ids=unreadable,
        layer_fields=ducklake_layer_fields,
        layer_feature_count=recorded_feature_count,
    )
    issues = [*checked, *_access_issues(steps, edges, denied, checked, language)]
    if (
        run
        and denied
        and not any(
            issue.code in ("layer_not_readable", "destination_not_writable")
            for issue in issues
        )
    ):
        # A refused reference no step and no destination stands for (the
        # template an empty copy reads): refused like any other request.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
        )
    return issues


@router.post(
    "/check",
    summary="Check a workflow",
    response_model=WorkflowCheckResponse,
    responses={404: {"description": "Project not found"}},
)
async def check_workflow_issues(
    request: WorkflowCheckRequest,
    user_id: UUID = Depends(get_user_id),
    language: str = Depends(get_language_from_request),
) -> WorkflowCheckResponse:
    """List a workflow's issues for the editor and the assistant.

    Checks the steps as sent, which is what a run would submit, and answers
    200 also for a damaged workflow. The caller must be able to read the
    project. Texts and labels follow Accept-Language (en, de).
    """
    project_id = str(request.project_id)
    damaged = shape_issues({"nodes": request.nodes, "edges": request.edges})
    if damaged:
        refs = References()
        refs.add("project", project_id, "read")
        await ensure_allowed(user_id, refs)
        return WorkflowCheckResponse(issues=[issue.to_dict() for issue in damaged])
    issues = await _workflow_issues(
        user_id,
        request.nodes,
        request.edges,
        request.variables,
        project_id=project_id,
        folder_id=None,
        language=language,
        run=False,
    )
    return WorkflowCheckResponse(issues=[issue.to_dict() for issue in issues])


class WorkflowFinalizeRequest(BaseModel):
    """Request to finalize a temp layer from workflow."""

    workflow_id: str = Field(..., description="Workflow UUID")
    node_id: str = Field(..., description="Node ID to finalize")
    project_id: str = Field(..., description="Project UUID to add layer to")
    layer_name: str | None = Field(
        default=None, description="Optional layer name override"
    )


class WorkflowFinalizeResponse(BaseModel):
    """Response from layer finalization."""

    job_id: str = Field(..., description="Windmill job ID for finalize job")


@router.post(
    "/{workflow_id}/execute",
    summary="Execute a workflow",
    status_code=status.HTTP_201_CREATED,
    response_model=WorkflowExecuteResponse,
    responses={422: {"description": "The workflow has issues"}},
)
async def execute_workflow(
    workflow_id: str,
    request: WorkflowExecuteRequest,
    user_id: UUID = Depends(get_user_id),
    language: str = Depends(get_language_from_request),
    access_token: str | None = Depends(oauth2_scheme),
) -> WorkflowExecuteResponse:
    """Execute a workflow via Windmill.

    Submits the workflow to the workflow_runner script which executes
    all tool nodes in topological order with temp_mode enabled. While the
    workflow has a damaged or error issue, the run is refused with 422 and
    every issue, and nothing is submitted.

    Args:
        workflow_id: UUID of the workflow
        request: Workflow configuration (nodes, edges, project info)
        user_id: Authenticated user ID
        language: UI language for the issues' texts (Accept-Language)

    Returns:
        Job ID and status info
    """
    # Ids become folder names of the caller's temporary results. A step
    # without an id is left to the shape check, which reports it as damaged.
    ensure_safe_workflow_ids(
        workflow_id,
        [
            node["id"]
            for node in request.nodes
            if isinstance(node, dict) and node.get("id") not in (None, "")
        ],
    )
    issues = shape_issues({"nodes": request.nodes, "edges": request.edges})
    if not issues:
        # The runner reads with service credentials: what the caller may not
        # read, or the destination they may not write, is one of the issues.
        issues = await _workflow_issues(
            user_id,
            request.nodes,
            request.edges,
            request.variables,
            project_id=request.project_id,
            folder_id=request.folder_id,
            language=language,
            run=True,
        )
    if any(issue.level in BLOCKING_LEVELS for issue in issues):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": "The workflow has issues.",
                "issues": [issue.to_dict() for issue in issues],
            },
        )
    # The runner starts `f/goat/tools/<processId>` for each tool step, so a
    # name outside the registry never reaches it, whatever the check found.
    if len(_steps_to_check(request.nodes)) != len(request.nodes):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Unknown tool in workflow",
        )

    # The previous run's temporary results go once the run is accepted, so a
    # refused run leaves them in place. The runner clears the same directory
    # when it starts; clearing it here removes them at submit time rather
    # than when a worker picks the job up.
    await asyncio.to_thread(
        cleanup_workflow_temp, user_id=str(user_id), workflow_id=workflow_id
    )

    # Out of credits: a workflow runs tools too, so it is refused like one (402).
    from processes.services.credit_gate import assert_credits_available

    await assert_credits_available(access_token)

    # Build job inputs
    job_inputs: dict[str, Any] = {
        "user_id": str(user_id),
        "project_id": request.project_id,
        "workflow_id": workflow_id,
        "folder_id": request.folder_id,
        "nodes": request.nodes,
        "edges": request.edges,
    }
    if request.variables:
        job_inputs["variables"] = request.variables

    try:
        job_id = await windmill_client.run_script_async(
            script_path=WORKFLOW_RUNNER_PATH,
            args=job_inputs,
        )

        logger.info(
            f"Workflow job {job_id} created for workflow {workflow_id} "
            f"by user {user_id}"
        )

        return WorkflowExecuteResponse(
            job_id=job_id,
            workflow_id=workflow_id,
            status="submitted",
        )

    except WindmillError as e:
        logger.error(f"Failed to submit workflow job: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to execute workflow: {str(e)}",
        )


@router.post(
    "/{workflow_id}/finalize",
    summary="Finalize a workflow temp layer",
    status_code=status.HTTP_201_CREATED,
    response_model=WorkflowFinalizeResponse,
)
async def finalize_workflow_layer(
    workflow_id: str,
    request: WorkflowFinalizeRequest,
    user_id: UUID = Depends(get_user_id),
) -> WorkflowFinalizeResponse:
    """Finalize a temporary workflow layer to permanent storage.

    Called when user clicks "Save" on a workflow result.
    Submits a finalize_layer job to Windmill.

    Args:
        workflow_id: UUID of the workflow (must match request)
        request: Finalize parameters
        user_id: Authenticated user ID

    Returns:
        Job ID for the finalize job
    """
    if request.workflow_id != workflow_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="workflow_id in path must match request body",
        )
    ensure_safe_workflow_ids(workflow_id, [request.node_id])

    if request.project_id:
        refs = References()
        refs.add("project", request.project_id, "write")
        await ensure_allowed(user_id, refs)

    # Deliberately not credit-gated: finalize_layer only saves the result of a
    # workflow that already ran (and was gated), so refusing it would throw
    # that work away. Its compute is still charged post-hoc by compute_rollup.

    # Build job inputs for finalize_layer tool
    job_inputs = {
        "user_id": str(user_id),
        "workflow_id": request.workflow_id,
        "node_id": request.node_id,
        "project_id": request.project_id,
        "layer_name": request.layer_name,
        "delete_temp": True,
    }

    try:
        job_id = await windmill_client.run_script_async(
            script_path="f/goat/tools/finalize_layer",
            args=job_inputs,
        )

        logger.info(
            f"Finalize job {job_id} created for workflow {workflow_id} "
            f"node {request.node_id}"
        )

        return WorkflowFinalizeResponse(job_id=job_id)

    except WindmillError as e:
        logger.error(f"Failed to submit finalize job: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to finalize layer: {str(e)}",
        )


# ============================================================================
# Workflow Metadata and Schema Prediction
# ============================================================================


class NodeMetadata(BaseModel):
    """Metadata for a single workflow node."""

    node_type: str = Field(..., description="Node type: dataset, tool, result")
    executed: bool = Field(False, description="Whether the node has been executed")
    layer_id: str | None = Field(
        None, description="Layer ID (for dataset nodes or executed tools)"
    )
    columns: dict[str, str] | None = Field(
        None, description="Column name -> type mapping"
    )
    geometry_type: str | None = Field(
        None, description="Geometry type (Point, Polygon, etc.)"
    )
    process_id: str | None = Field(None, description="Process/tool ID (for tool nodes)")


class WorkflowMetadataResponse(BaseModel):
    """Response with metadata for all nodes in a workflow."""

    workflow_id: str
    nodes: dict[str, NodeMetadata] = Field(
        default_factory=dict,
        description="Node ID -> metadata mapping",
    )


class InputSchemaInfo(BaseModel):
    """Schema information for a single input."""

    layer_id: str | None = Field(None, description="Layer ID (for dataset inputs)")
    source_node_id: str | None = Field(
        None, description="Source node ID (for connected inputs)"
    )
    columns: dict[str, str] | None = Field(
        None, description="Direct column schema if known"
    )


class PredictSchemaRequest(BaseModel):
    """Request to predict output schema for a node."""

    process_id: str = Field(..., description="Tool/process ID (e.g., 'buffer', 'join')")
    input_schemas: dict[str, InputSchemaInfo] = Field(
        ...,
        description="Input name -> schema info mapping. "
        "Input names should match process input keys (e.g., 'input_layer_id', 'target_layer_id').",
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="Tool configuration parameters",
    )


class PredictedSchemaResponse(BaseModel):
    """Predicted output schema for a node."""

    columns: dict[str, str] = Field(
        default_factory=dict,
        description="Predicted column name -> type mapping",
    )
    geometry_type: str | None = Field(
        None, description="Predicted geometry type (Point, Polygon, etc.)"
    )
    geometry_column: str = Field("geometry", description="Name of geometry column")


def _get_temp_node_path(user_id: str, workflow_id: str, node_id: str) -> Path:
    """Get the path to a temp node's data directory."""
    user_id_clean = user_id.replace("-", "")
    workflow_id_clean = workflow_id.replace("-", "")
    return (
        TEMP_DATA_ROOT
        / f"user_{user_id_clean}"
        / f"w_{workflow_id_clean}"
        / f"n_{node_id}"
    )


def _get_workflow_temp_path(user_id: str, workflow_id: str) -> Path:
    """Get the path to a workflow's temp directory."""
    user_id_clean = user_id.replace("-", "")
    workflow_id_clean = workflow_id.replace("-", "")
    return TEMP_DATA_ROOT / f"user_{user_id_clean}" / f"w_{workflow_id_clean}"


def _get_layer_schema_from_ducklake(layer_id: str) -> dict[str, str]:
    """Get column schema for a layer from DuckLake.

    Args:
        layer_id: Layer UUID (with or without hyphens)

    Returns:
        Dict mapping column name -> DuckDB type string
    """
    try:
        from goatlib.utils.layer import (
            LayerNotFoundError,
            get_schema_for_layer,
            layer_id_to_table_name,
            normalize_layer_id,
        )

        layer_id_norm = normalize_layer_id(layer_id)
        table_name = layer_id_to_table_name(layer_id_norm)
        try:
            schema_name = get_schema_for_layer(layer_id_norm, ducklake_manager)
        except LayerNotFoundError:
            logger.warning(f"Layer not found in DuckLake: {layer_id}")
            return {}

        with ducklake_manager.connection() as con:
            # DESCRIBE loads only this table's metadata;
            # information_schema.columns would lazily load every table
            # in the catalog to answer.
            columns_result = con.execute(
                f'DESCRIBE lake."{schema_name}"."{table_name}"'
            ).fetchall()
            return {row[0]: row[1] for row in columns_result}

    except Exception as e:
        logger.warning(f"Failed to get layer schema from DuckLake: {e}")
        return {}


@router.get(
    "/{workflow_id}/metadata",
    response_model=WorkflowMetadataResponse,
    summary="Get metadata for all nodes in a workflow",
)
async def get_workflow_metadata(
    workflow_id: str,
    user_id: UUID = Depends(get_user_id),
) -> WorkflowMetadataResponse:
    """Fetch metadata (columns, geometry types) for all executed nodes in a workflow.

    Returns column information for each node that has been executed.
    This enables field selectors to show available fields from upstream nodes.
    """
    workflow_path = _get_workflow_temp_path(str(user_id), workflow_id)
    nodes: dict[str, NodeMetadata] = {}

    # Check if workflow temp directory exists
    if not workflow_path.exists():
        # No temp data yet - return empty nodes
        return WorkflowMetadataResponse(workflow_id=workflow_id, nodes={})

    # Iterate through all node directories
    for node_dir in workflow_path.iterdir():
        if not node_dir.is_dir() or not node_dir.name.startswith("n_"):
            continue

        node_id = node_dir.name[2:]  # Strip "n_" prefix
        metadata_path = node_dir / "metadata.json"

        if not metadata_path.exists():
            continue

        try:
            with open(metadata_path) as f:
                meta = json.load(f)

            nodes[node_id] = NodeMetadata(
                node_type="tool",
                executed=True,
                layer_id=meta.get("layer_id"),
                columns=meta.get("columns"),
                geometry_type=meta.get("geometry_type"),
                process_id=meta.get("process_id"),
            )
        except Exception as e:
            logger.warning(f"Failed to read metadata for node {node_id}: {e}")
            continue

    return WorkflowMetadataResponse(workflow_id=workflow_id, nodes=nodes)


@router.get(
    "/{workflow_id}/nodes/{node_id}/metadata",
    response_model=NodeMetadata,
    summary="Get metadata for a single node",
)
async def get_node_metadata(
    workflow_id: str,
    node_id: str,
    user_id: UUID = Depends(get_user_id),
) -> NodeMetadata:
    """Fetch metadata for a single workflow node."""
    node_path = _get_temp_node_path(str(user_id), workflow_id, node_id)
    metadata_path = node_path / "metadata.json"

    if not metadata_path.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Node metadata not found: {workflow_id}/{node_id}",
        )

    try:
        with open(metadata_path) as f:
            meta = json.load(f)

        return NodeMetadata(
            node_type="tool",
            executed=True,
            layer_id=meta.get("layer_id"),
            columns=meta.get("columns"),
            geometry_type=meta.get("geometry_type"),
            process_id=meta.get("process_id"),
        )
    except Exception as e:
        logger.error(f"Failed to read node metadata: {e}")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e))


@router.post(
    "/{workflow_id}/predict-schema",
    response_model=PredictedSchemaResponse,
    summary="Predict output schema for a tool node",
)
async def predict_schema(
    workflow_id: str,
    request: PredictSchemaRequest,
    user_id: UUID = Depends(get_user_id),
) -> PredictedSchemaResponse:
    """Predict the output schema for a tool node BEFORE execution.

    This enables field selectors in downstream nodes to show available fields
    from upstream nodes that haven't been executed yet.

    The prediction is based on:
    - Input layer schemas (from dataset nodes or executed tool nodes)
    - Tool configuration parameters

    Example: A join tool configured with statistics=[COUNT] will predict
    output columns including the target layer fields, joined fields, and
    a 'count' column.
    """
    from goatlib.tools.schema_prediction import predict_node_output_schema

    user_id_str = str(user_id)

    # A layer's columns are the shape of its data: every layer the request
    # names must be readable by the caller, as for any other request (404
    # when not). A value that is not a layer id names no layer and is read as
    # nothing below.
    refs = References()
    for schema_info in request.input_schemas.values():
        if schema_info.layer_id and UUID_RE.fullmatch(schema_info.layer_id):
            refs.add_layer(schema_info.layer_id)
    await ensure_allowed(user_id, refs)

    # Resolve input schemas
    resolved_schemas: dict[str, dict[str, str]] = {}

    for input_name, schema_info in request.input_schemas.items():
        if schema_info.columns:
            # Direct schema provided
            resolved_schemas[input_name] = schema_info.columns

        elif schema_info.source_node_id:
            # A step of the caller's own workflow, never a path: `..` would
            # reach another user's temporary results.
            if not TEMP_LAYER_PART_RE.fullmatch(schema_info.source_node_id):
                resolved_schemas[input_name] = {}
                continue
            # Get schema from executed source node
            node_path = _get_temp_node_path(
                user_id_str, workflow_id, schema_info.source_node_id
            )
            metadata_path = node_path / "metadata.json"

            if metadata_path.exists():
                try:
                    with open(metadata_path) as f:
                        meta = json.load(f)
                    resolved_schemas[input_name] = meta.get("columns", {})
                except Exception as e:
                    logger.warning(f"Failed to read node metadata: {e}")
                    resolved_schemas[input_name] = {}
            else:
                resolved_schemas[input_name] = {}

        elif schema_info.layer_id and UUID_RE.fullmatch(schema_info.layer_id):
            # Get schema from DuckLake layer. DuckDB blocks, so the read runs
            # in a worker thread rather than on the event loop.
            resolved_schemas[input_name] = await asyncio.to_thread(
                _get_layer_schema_from_ducklake, schema_info.layer_id
            )

        else:
            resolved_schemas[input_name] = {}

    # Predict schema
    predicted = predict_node_output_schema(
        process_id=request.process_id,
        input_schemas=resolved_schemas,
        params=request.params,
    )

    if predicted is None:
        # No predictor available - return empty schema
        return PredictedSchemaResponse()

    return PredictedSchemaResponse(
        columns=predicted.columns,
        geometry_type=predicted.geometry_type,
        geometry_column=predicted.geometry_column,
    )
