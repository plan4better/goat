"""OGC API Processes router.

Implements OGC API - Processes - Part 1: Core (OGC 18-062r2)
https://docs.ogc.org/is/18-062r2/18-062r2.html

Endpoints:
- GET /processes - List available processes
- GET /processes/{processId} - Get process description
- POST /processes/{processId}/execution - Execute a process
- GET /jobs - List jobs
- GET /jobs/{jobId} - Get job status
- GET /jobs/{jobId}/results - Get job results
- DELETE /jobs/{jobId} - Cancel/dismiss a job
"""

import asyncio
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from goatlib.tools.registry import TOOL_REGISTRY
from pydantic import ValidationError

from processes.config import settings
from processes.deps.auth import (
    decode_token,
    get_optional_user_email,
    get_optional_user_id,
    get_user_id,
    oauth2_scheme,
)
from processes.models.processes import (
    OGC_EXCEPTION_INVALID_PARAMETER,
    OGC_EXCEPTION_NO_SUCH_JOB,
    OGC_EXCEPTION_NO_SUCH_PROCESS,
    OGC_EXCEPTION_RESULT_NOT_READY,
    ConformanceDeclaration,
    ExecuteRequest,
    JobList,
    LandingPage,
    Link,
    OGCException,
    ProcessDescription,
    ProcessList,
    StatusCode,
    StatusInfo,
)
from processes.services.access import (
    analytics_references,
    ensure_allowed,
    tool_references,
)
from processes.services.analytics_registry import (
    LayerSearchProcessInput,
    analytics_registry,
)
from processes.services.analytics_service import AnalyticsService
from processes.services.beta_access import get_beta_email_domains, is_beta_user_email
from processes.services.public_search_config import get_public_sql_scope
from processes.services.tool_registry import tool_registry
from processes.services.windmill_client import (
    WindmillClient,
    WindmillError,
    WindmillJobNotFound,
)

logger = logging.getLogger(__name__)

# Pattern to strip usernames from Windmill cancellation messages
_CANCEL_USER_RE = re.compile(r"cancelled by \S+")


def _sanitize_error_msg(msg: str) -> str:
    """Remove usernames from Windmill cancellation error messages."""
    return _CANCEL_USER_RE.sub("cancelled", msg)


router = APIRouter(tags=["Processes"])

# Instantiate services
analytics_service = AnalyticsService()
windmill_client = WindmillClient()

# Thread pool for running blocking DuckDB analytics queries
# This prevents long-running queries from blocking the async event loop
_analytics_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="analytics")

# Dedicated pool for layer-search: kept separate from _analytics_executor so
# unauthenticated search fan-outs can never starve authenticated analytics.
_search_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="layer-search")

# Non-standard exception type URIs (same namespace convention as the OGC-defined
# ones) for guard responses that OGC API - Processes doesn't itself define.
OGC_EXCEPTION_NOT_AUTHORIZED = (
    "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/not-authorized"
)
OGC_EXCEPTION_TOO_MANY_REQUESTS = (
    "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/too-many-requests"
)
OGC_EXCEPTION_JOB_EXECUTION_FAILED = (
    "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-execution-failed"
)

# Processes that can be executed without authentication (read-only analytics)
# These are sync processes that only query data and don't modify anything
PUBLIC_ALLOWED_PROCESSES = frozenset(
    {
        "feature-count",
        "unique-values",
        "class-breaks",
        "area-statistics",
        "extent",
        "aggregation-stats",
        "histogram",
        # A public dashboard viewer is anonymous and its statistics are
        # computed here, gated by a public `project_id`. `layer-search` keeps
        # its own gate (public `project_id`, or auth for an explicit `layers`
        # list). `preview-sql`/`validate-sql` are NOT here: they take arbitrary
        # SQL and a raw `layers` list, and an open seat would be unauthenticated
        # read of any layer plus local-file/SSRF reach through DuckDB. A public
        # dashboard's table widget still needs preview-sql, so it has its own
        # narrow gate (`_authorize_public_preview_sql`): a published project's
        # saved query over that project's own layers, nothing else.
        "layer-search",
    }
)

# Every sync-analytics process handled inline below (the public subset above
# plus the two authenticated-only SQL helpers). Membership here routes a
# request into `_execute_analytics_sync`; `PUBLIC_ALLOWED_PROCESSES` then
# decides whether it may run without a caller.
SYNC_ANALYTICS_PROCESSES = PUBLIC_ALLOWED_PROCESSES | {"preview-sql", "validate-sql"}


# Cheap overload guard for layer-search fan-outs: reject instead of queueing
# unboundedly when the analytics pool is saturated.
_LAYER_SEARCH_MAX_INFLIGHT = 8
_layer_search_inflight = 0


def _authorize_public_preview_sql(inputs: dict[str, Any]) -> None:
    """Let an anonymous preview-sql run only as a published project's own widget.

    The request must name a published project, and both the query and every
    layer it reads must be part of that project's published snapshot: the
    viewer re-runs what the author saved, nothing else. Raises the HTTP error
    to return otherwise.
    """
    project_id = inputs.get("project_id")
    if not project_id:
        raise HTTPException(
            status_code=401,
            detail={
                "type": OGC_EXCEPTION_NOT_AUTHORIZED,
                "title": "Authentication required",
                "status": 401,
                "detail": "Authentication required for this process",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        scope = get_public_sql_scope(str(project_id))
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={
                "type": OGC_EXCEPTION_INVALID_PARAMETER,
                "title": "Invalid parameter",
                "status": 422,
                "detail": "project_id must be a UUID",
            },
        )
    except Exception as e:
        # Infra failures (e.g. Postgres unreachable) carry the connection URI,
        # password included, in their message. This path is unauthenticated.
        logger.error("get_public_sql_scope failed for project %s: %s", project_id, e)
        raise HTTPException(
            status_code=503,
            detail={
                "type": OGC_EXCEPTION_JOB_EXECUTION_FAILED,
                "title": "Service unavailable",
                "status": 503,
                "detail": "preview temporarily unavailable",
            },
        )
    layers = inputs.get("layers") or {}
    layer_ids = set(layers.values()) if isinstance(layers, dict) else set()
    allowed = (
        scope is not None
        and inputs.get("sql_query") in scope["queries"]
        and bool(layer_ids)
        and layer_ids <= scope["layer_ids"]
    )
    if not allowed:
        raise HTTPException(
            status_code=403,
            detail={
                "type": OGC_EXCEPTION_NOT_AUTHORIZED,
                "title": "Forbidden",
                "status": 403,
                "detail": "Query is not part of the published project",
            },
        )


def is_public_allowed_process(process_id: str) -> bool:
    """Check if a process can be executed without authentication.

    Only read-only sync analytics processes are allowed for public access.
    These processes only query data and don't create jobs or modify state.

    Args:
        process_id: The process identifier

    Returns:
        True if the process can be executed publicly, False otherwise
    """
    return process_id in PUBLIC_ALLOWED_PROCESSES


def _execute_analytics_sync(
    process_id: str, inputs: dict[str, Any], user_id: UUID | None = None
) -> dict[str, Any]:
    """Execute an analytics process synchronously.

    Args:
        process_id: Analytics process ID
        inputs: Process inputs

    Returns:
        Process result as dict

    Raises:
        HTTPException: If execution fails
    """
    try:
        if process_id == "feature-count":
            return analytics_service.feature_count(
                collection=inputs.get("collection", ""),
                filter_expr=inputs.get("filter"),
            )
        elif process_id == "unique-values":
            return analytics_service.unique_values(
                collection=inputs.get("collection", ""),
                attribute=inputs.get("attribute", ""),
                order=inputs.get("order", "descendent"),
                filter_expr=inputs.get("filter"),
                limit=inputs.get("limit", 100),
                offset=inputs.get("offset", 0),
            )
        elif process_id == "class-breaks":
            return analytics_service.class_breaks(
                collection=inputs.get("collection", ""),
                attribute=inputs.get("attribute", ""),
                method=inputs.get("method", "quantile"),
                breaks=inputs.get("breaks", 5),
                filter_expr=inputs.get("filter"),
                strip_zeros=inputs.get("strip_zeros", False),
            )
        elif process_id == "area-statistics":
            return analytics_service.area_statistics(
                collection=inputs.get("collection", ""),
                operation=inputs.get("operation", "sum"),
                filter_expr=inputs.get("filter"),
            )
        elif process_id == "extent":
            return analytics_service.extent(
                collection=inputs.get("collection", ""),
                filter_expr=inputs.get("filter"),
            )
        elif process_id == "aggregation-stats":
            return analytics_service.aggregation_stats(
                collection=inputs.get("collection", ""),
                operation=inputs.get("operation", "count"),
                operation_column=inputs.get("operation_column"),
                group_by_column=inputs.get("group_by_column"),
                group_by_secondary_column=inputs.get("group_by_secondary_column"),
                filter_expr=inputs.get("filter"),
                order=inputs.get("order", "descendent"),
                limit=inputs.get("limit", 100),
            )
        elif process_id == "histogram":
            return analytics_service.histogram(
                collection=inputs.get("collection", ""),
                column=inputs.get("column", ""),
                num_bins=inputs.get("num_bins", 10),
                method=inputs.get("method", "equal_interval"),
                custom_breaks=inputs.get("custom_breaks"),
                filter_expr=inputs.get("filter"),
                order=inputs.get("order", "ascendent"),
            )
        elif process_id == "validate-sql":
            return analytics_service.validate_sql(
                sql_query=inputs.get("sql_query", ""),
                table_schemas=inputs.get("table_schemas"),
            )
        elif process_id == "preview-sql":
            return analytics_service.preview_sql(
                sql_query=inputs.get("sql_query", ""),
                layers=inputs.get("layers", {}),
                user_id=user_id,
                limit=inputs.get("limit", 10),
                offset=inputs.get("offset", 0),
                filter_expr=inputs.get("filter_expr"),
            )
        elif process_id == "layer-search":
            return analytics_service.layer_search(
                query=inputs.get("query", ""),
                map_center=inputs.get("map_center"),
                project_id=inputs.get("project_id"),
                layers=inputs.get("layers"),
            )
        else:
            raise HTTPException(
                status_code=404, detail=f"Unknown analytics process: {process_id}"
            )
    except HTTPException:
        raise
    except ValueError as e:
        logger.warning(f"Invalid parameter for {process_id}: {e}")
        raise HTTPException(
            status_code=400,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/invalid-parameter",
                "title": "Invalid parameter",
                "status": 400,
                "detail": str(e),
            },
        )
    except Exception as e:
        logger.error(f"Analytics execution failed for {process_id}: {e}")
        # layer-search is unauthenticated: never echo the raw exception message
        # back to the caller (defense in depth — the service layer already
        # sanitizes its own known failure modes, e.g. DB connection errors that
        # can carry credentials). Other analytics processes are authenticated
        # or long-established, so their str(e) behavior is left unchanged.
        detail_message = (
            "search temporarily unavailable" if process_id == "layer-search" else str(e)
        )
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-execution-failed",
                "title": "Execution failed",
                "status": 500,
                "detail": detail_message,
            },
        )


def get_base_url(request: Request) -> str:
    """Build base URL from request."""
    # Check for forwarded headers (reverse proxy)
    proto = request.headers.get("x-forwarded-proto", "http")
    host = request.headers.get("x-forwarded-host") or request.headers.get(
        "host", "localhost"
    )
    # Path prefix when served behind a path-routing gateway (ROOT_PATH).
    root_path = request.scope.get("root_path", "")
    return f"{proto}://{host}{root_path}"


# === Landing Page and Conformance ===


@router.get(
    "/",
    summary="Landing page",
    response_model=LandingPage,
)
async def landing_page(request: Request) -> LandingPage:
    """Get the OGC API landing page with links to available resources."""
    base_url = get_base_url(request)

    return LandingPage(
        title="GOAT Processes API",
        description="OGC API - Processes implementation for GOAT geospatial analysis tools",
        links=[
            Link(
                href=f"{base_url}/",
                rel="self",
                type="application/json",
                title="This document",
            ),
            Link(
                href=f"{base_url}/api/docs",
                rel="service-doc",
                type="text/html",
                title="API documentation",
            ),
            Link(
                href=f"{base_url}/api/openapi.json",
                rel="service-desc",
                type="application/vnd.oai.openapi+json;version=3.0",
                title="OpenAPI definition",
            ),
            Link(
                href=f"{base_url}/conformance",
                rel="http://www.opengis.net/def/rel/ogc/1.0/conformance",
                type="application/json",
                title="Conformance classes",
            ),
            Link(
                href=f"{base_url}/processes",
                rel="http://www.opengis.net/def/rel/ogc/1.0/processes",
                type="application/json",
                title="Process list",
            ),
            Link(
                href=f"{base_url}/jobs",
                rel="http://www.opengis.net/def/rel/ogc/1.0/job-list",
                type="application/json",
                title="Job list",
            ),
        ],
    )


@router.get(
    "/conformance",
    summary="Conformance classes",
    response_model=ConformanceDeclaration,
)
async def conformance() -> ConformanceDeclaration:
    """Get list of conformance classes implemented by this API."""
    return ConformanceDeclaration(
        conformsTo=[
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/ogc-process-description",
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/json",
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/oas30",
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/job-list",
            "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss",
        ]
    )


# === Process List and Description ===


def get_language_from_request(request: Request) -> str:
    """Extract language from Accept-Language header.

    Returns the first supported language or 'en' as default.
    """
    accept_language = request.headers.get("accept-language", "en")
    # Parse first language preference (e.g., "de-DE,de;q=0.9,en;q=0.8" -> "de")
    if accept_language:
        first_lang = accept_language.split(",")[0].split(";")[0].strip()
        # Extract base language (e.g., "de-DE" -> "de")
        lang_code = first_lang.split("-")[0].lower()
        if lang_code in ("en", "de"):  # Supported languages
            return lang_code
    return "en"


@router.get(
    "/processes",
    summary="List available processes",
    response_model=ProcessList,
)
async def list_processes(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    user_email: str | None = Depends(get_optional_user_email),
) -> ProcessList:
    """Get list of all available processes (analytics + async tools).

    Supports i18n via Accept-Language header (en, de).

    Beta tools (x-ui-beta) are only included for users whose email domain is
    in the beta allowlist (a Windmill variable); everyone else gets them
    filtered out so they don't render in the toolbox.
    """
    base_url = get_base_url(request)
    language = get_language_from_request(request)

    # Get analytics processes (sync) - auto-generated from goatlib schemas
    analytics_summaries = analytics_registry.get_all_summaries(base_url, language)

    # Get async tool processes from registry (with translations)
    tool_list = tool_registry.get_process_list(base_url, limit=limit, language=language)

    # Combine both
    all_processes = analytics_summaries + tool_list.processes

    # Hide beta tools unless the user's email domain is allowlisted
    beta_domains = await get_beta_email_domains(windmill_client)
    if not is_beta_user_email(user_email, beta_domains):
        all_processes = [p for p in all_processes if not p.x_ui_beta]

    # Apply limit
    all_processes = all_processes[:limit]

    return ProcessList(
        processes=all_processes,
        links=[
            Link(
                href=f"{base_url}/processes",
                rel="self",
                type="application/json",
                title="Process list",
            ),
        ],
    )


@router.get(
    "/processes/{process_id}",
    summary="Get process description",
    response_model=ProcessDescription,
    responses={
        404: {"model": OGCException, "description": "Process not found"},
    },
)
async def get_process(request: Request, process_id: str) -> ProcessDescription:
    """Get detailed description of a specific process.

    Supports i18n via Accept-Language header (en, de).
    Returns x-ui-sections and x-ui field metadata for dynamic UI rendering.
    """
    base_url = get_base_url(request)
    language = get_language_from_request(request)

    # Check analytics processes first (auto-generated from goatlib schemas)
    if analytics_registry.is_analytics_process(process_id):
        return analytics_registry.get_process_description(
            process_id, base_url, language
        )

    # Check async tool processes (with translations)
    process_desc = tool_registry.get_process_description(
        process_id, base_url, language=language
    )

    if not process_desc:
        raise HTTPException(
            status_code=404,
            detail={
                "type": OGC_EXCEPTION_NO_SUCH_PROCESS,
                "title": "Process not found",
                "status": 404,
                "detail": f"Process '{process_id}' not found",
            },
        )

    return process_desc


# === Process Execution ===


# Numeric analytics inputs -> their cap. Statistics write some of them into
# their SQL, so anything but a whole number is refused before a query is
# built; a larger number is lowered to the cap, so a request cannot size the
# work (bins, classes, rows) without bound.
_WHOLE_NUMBER_INPUTS: dict[str, int | None] = {
    "limit": 10_000,
    "offset": None,
    "breaks": 100,
    "num_bins": 1_000,
}


def _require_whole_numbers(inputs: dict[str, Any]) -> None:
    for name, cap in _WHOLE_NUMBER_INPUTS.items():
        value = inputs.get(name)
        if value is None:
            continue
        if not isinstance(value, bool) and isinstance(value, int) and value >= 0:
            if cap is not None and value > cap:
                inputs[name] = cap
            continue
        raise HTTPException(
            status_code=422,
            detail={
                "type": OGC_EXCEPTION_INVALID_PARAMETER,
                "title": "Invalid parameter",
                "status": 422,
                "detail": f"{name} must be a whole number",
            },
        )


@router.post(
    "/processes/{process_id}/execution",
    summary="Execute a process",
    status_code=status.HTTP_201_CREATED,
    response_model=StatusInfo,
    responses={
        201: {"description": "Job created (async execution)"},
        200: {"description": "Results (sync execution)"},
        404: {"model": OGCException, "description": "Process not found"},
        500: {"model": OGCException, "description": "Execution error"},
    },
)
async def execute_process(
    request: Request,
    process_id: str,
    execute_request: ExecuteRequest,
    user_id: UUID | None = Depends(get_optional_user_id),
    access_token: str | None = Depends(oauth2_scheme),
) -> JSONResponse:
    """Execute a process.

    For analytics processes (feature-count, class-breaks, unique-values, area-statistics):
      Returns results immediately (HTTP 200).
      These can be executed without authentication (public access).

    For async tool processes (buffer, clip, etc.):
      Creates a job and returns status info with job ID (HTTP 201).
      These REQUIRE authentication.
      Results can be retrieved via /jobs/{jobId}/results.
    """
    base_url = get_base_url(request)

    if process_id == "layer-search":
        try:
            search_input = LayerSearchProcessInput.model_validate(
                execute_request.inputs
            )
        except ValidationError as e:
            raise HTTPException(
                status_code=422,
                detail={
                    "type": OGC_EXCEPTION_INVALID_PARAMETER,
                    "title": "Invalid parameter",
                    "status": 422,
                    "detail": str(e),
                },
            )
        if search_input.layers is not None and user_id is None:
            raise HTTPException(
                status_code=401,
                detail={
                    "type": OGC_EXCEPTION_NOT_AUTHORIZED,
                    "title": "Authentication required",
                    "status": 401,
                    "detail": "Authentication required for explicit layer lists",
                },
                headers={"WWW-Authenticate": "Bearer"},
            )
        if search_input.layers is None and not search_input.project_id:
            raise HTTPException(
                status_code=422,
                detail={
                    "type": OGC_EXCEPTION_INVALID_PARAMETER,
                    "title": "Invalid parameter",
                    "status": 422,
                    "detail": "Either project_id (public) or layers (authenticated) "
                    "is required",
                },
            )
        # Downstream dispatch consumes validated/coerced values (e.g. project_id
        # as a canonical UUID string, query stripped) instead of the raw body.
        execute_request.inputs = search_input.model_dump(mode="json")

    # Check if this is a public-allowed analytics process (sync execution)
    # Sync analytics runs here. A process in PUBLIC_ALLOWED_PROCESSES may run
    # anonymously (public dashboards); every other sync-analytics process —
    # preview-sql and validate-sql among them — requires a caller, so an
    # unauthenticated request cannot reach arbitrary SQL over a layer.
    if process_id in SYNC_ANALYTICS_PROCESSES:
        if process_id == "preview-sql":
            if user_id is None:
                _authorize_public_preview_sql(execute_request.inputs)
            # Consumed by the gate above; preview_sql itself takes no project.
            execute_request.inputs.pop("project_id", None)
        elif not is_public_allowed_process(process_id) and user_id is None:
            raise HTTPException(
                status_code=401,
                detail={
                    "type": OGC_EXCEPTION_NOT_AUTHORIZED,
                    "title": "Authentication required",
                    "status": 401,
                    "detail": "Authentication required for this process",
                },
                headers={"WWW-Authenticate": "Bearer"},
            )
        _require_whole_numbers(execute_request.inputs)
        # Every layer the query reads must be readable by the caller (a
        # layer of a published project is readable by anyone).
        await ensure_allowed(
            user_id, analytics_references(process_id, execute_request.inputs)
        )
        global _layer_search_inflight
        is_search = process_id == "layer-search"
        if is_search and _layer_search_inflight >= _LAYER_SEARCH_MAX_INFLIGHT:
            raise HTTPException(
                status_code=429,
                detail={
                    "type": OGC_EXCEPTION_TOO_MANY_REQUESTS,
                    "title": "Search is busy",
                    "status": 429,
                    "detail": "Search is busy, try again",
                },
                headers={"Retry-After": "1"},
            )
        if is_search:
            _layer_search_inflight += 1
        try:
            # Analytics processes are read-only and don't need authentication
            # Run in thread pool to avoid blocking the async event loop
            # Apply timeout to prevent runaway queries
            # layer-search runs on its own pool so it can't starve authenticated
            # analytics (see _search_executor).
            executor = _search_executor if is_search else _analytics_executor
            loop = asyncio.get_event_loop()
            try:
                result = await asyncio.wait_for(
                    loop.run_in_executor(
                        executor,
                        _execute_analytics_sync,
                        process_id,
                        execute_request.inputs,
                        user_id,
                    ),
                    timeout=settings.ANALYTICS_QUERY_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    f"Analytics query {process_id} timed out after "
                    f"{settings.ANALYTICS_QUERY_TIMEOUT}s"
                )
                raise HTTPException(
                    status_code=504,
                    detail={
                        "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-execution-failed",
                        "title": "Query timeout",
                        "status": 504,
                        "detail": f"Query exceeded timeout of {settings.ANALYTICS_QUERY_TIMEOUT} seconds",
                    },
                )
            return JSONResponse(status_code=200, content=result)
        finally:
            if is_search:
                _layer_search_inflight -= 1

    # For all other processes, authentication is required
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required for this process",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # For async processes, verify tool exists
    tool_info = tool_registry.get_tool(process_id)
    if not tool_info:
        raise HTTPException(
            status_code=404,
            detail={
                "type": OGC_EXCEPTION_NO_SUCH_PROCESS,
                "title": "Process not found",
                "status": 404,
                "detail": f"Process '{process_id}' not found",
            },
        )

    # The tool runs with service credentials: check here that the caller may
    # read every layer it names and write where it puts its result.
    await ensure_allowed(
        user_id, tool_references(tool_info.name, execute_request.inputs, user_id)
    )

    # Use the windmill_path from the registry (ensures correct casing)
    script_path = tool_info.windmill_path

    # The server says who runs the job; a caller-supplied identity is dropped.
    job_inputs = {
        **{
            key: value
            for key, value in execute_request.inputs.items()
            if key not in ("_triggered_by_email", "triggered_by_email")
        },
        "user_id": str(user_id),
    }

    # Pass access_token and refresh_token to print_report for Playwright authentication
    # The refresh_token allows the worker to refresh expired access tokens during long atlas jobs
    # NOTE: Keycloak client credentials are read from env vars in the print worker directly,
    # NOT passed through job inputs, to avoid exposing secrets in Windmill's job storage
    if process_id == "print_report":
        if access_token:
            job_inputs["access_token"] = access_token
        # refresh_token is passed from the frontend in the inputs — same exposure as access_token

    # Auto-populate od_matrix_path from routing_mode so the field can stay hidden
    # in the UI while the analysis layer still gets it.
    #
    # Gated on the tool actually declaring the input rather than on it merely
    # having a routing_mode: the v2 heatmaps, Huff v2, catchment v2 and the
    # travel cost matrix all route on the fly and have no od_matrix_path, so
    # injecting one only put a misleading precomputed-matrix path into their
    # Windmill job arguments.
    od_tool = tool_registry.get_tool(process_id)
    if (
        od_tool is not None
        and "od_matrix_path" in od_tool.params_class.model_fields
        and job_inputs.get("od_matrix_path") is None
        and "routing_mode" in job_inputs
    ):
        routing_mode = job_inputs["routing_mode"]
        job_inputs["od_matrix_path"] = (
            f"{settings.TRAVELTIME_MATRICES_DIR}/{routing_mode}/"
        )

    # Add user email to job inputs for tracking who triggered the job
    # This is visible in Windmill's job arguments/input tab
    if access_token:
        try:
            decoded = decode_token(access_token)
            user_email = decoded.get("email")
            if user_email:
                job_inputs["_triggered_by_email"] = user_email
        except Exception:
            pass  # Token decode failed, skip email tracking

    from processes.services.credit_gate import assert_credits_available

    await assert_credits_available(access_token)

    # Submit job to Windmill
    # Note: Worker tag is configured on the script during sync, not per-job
    try:
        job_id = await windmill_client.run_script_async(
            script_path=script_path,
            args=job_inputs,
        )

        logger.info(f"Job {job_id} created for process {process_id} by user {user_id}")

        # Build status info response
        status_info = StatusInfo(
            processID=process_id,
            type="process",
            jobID=job_id,
            status=StatusCode.accepted,
            message="Job submitted to execution queue",
            created=datetime.now(timezone.utc),
            links=[
                Link(
                    href=f"{base_url}/jobs/{job_id}",
                    rel="self",
                    type="application/json",
                    title="Job status",
                ),
                Link(
                    href=f"{base_url}/jobs/{job_id}/results",
                    rel="http://www.opengis.net/def/rel/ogc/1.0/results",
                    type="application/json",
                    title="Job results",
                ),
            ],
        )

        return JSONResponse(
            status_code=201,
            content=status_info.model_dump(mode="json", exclude_none=True),
            headers={"Location": f"{base_url}/jobs/{job_id}"},
        )

    except WindmillError as e:
        logger.error(f"Windmill error executing {process_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-execution-failed",
                "title": "Execution failed",
                "status": 500,
                "detail": str(e),
            },
        )


# === Job Management ===


def _windmill_status_to_ogc(job: dict[str, Any]) -> StatusCode:
    """Convert Windmill job status to OGC status code."""
    if job.get("running"):
        return StatusCode.running
    elif job.get("success") is True:
        # For workflow_runner jobs, check if the result indicates errors
        # Windmill marks the job as success even if the workflow had partial failures
        result = job.get("result")
        if isinstance(result, dict):
            # Check for workflow errors (status="partial" or errors list)
            if result.get("status") == "partial" or result.get("errors"):
                return StatusCode.failed
        return StatusCode.successful
    elif job.get("canceled"):
        # Check canceled BEFORE failed, as canceled jobs may also have success=false
        return StatusCode.dismissed
    elif job.get("success") is False:
        return StatusCode.failed
    else:
        return StatusCode.accepted


#: Tools whose jobs run as a side effect of something else the user did.
_JOB_HIDDEN_PROCESS_IDS = frozenset(
    tool.name for tool in TOOL_REGISTRY if getattr(tool, "job_hidden", False)
)


def _windmill_job_to_status_info(job: dict[str, Any], base_url: str) -> StatusInfo:
    """Convert Windmill job to OGC StatusInfo."""
    job_id = job.get("id", "")
    # Extract process ID from Windmill script path
    # Script paths are: f/goat/tools/buffer, f/goat/layer_import, etc.
    # We need to extract just the tool/process name for translation keys
    script_path = job.get("script_path", "")
    if script_path.startswith("f/goat/tools/"):
        process_id = script_path.replace("f/goat/tools/", "")
    else:
        process_id = script_path.replace("f/goat/", "")

    # Whether this job is worth showing is a property of the tool, so it comes
    # from the registry rather than a list of ids kept in a client.
    hidden = process_id in _JOB_HIDDEN_PROCESS_IDS

    # Parse timestamps
    created = None
    started = None
    finished = None

    if job.get("created_at"):
        try:
            created = datetime.fromisoformat(job["created_at"].replace("Z", "+00:00"))
        except Exception:
            pass

    if job.get("started_at"):
        try:
            started = datetime.fromisoformat(job["started_at"].replace("Z", "+00:00"))
        except Exception:
            pass

    if not job.get("running") and job.get("duration_ms"):
        if started:
            finished = started + timedelta(milliseconds=job["duration_ms"])

    ogc_status = _windmill_status_to_ogc(job)

    # Build links
    links = [
        Link(
            href=f"{base_url}/jobs/{job_id}",
            rel="self",
            type="application/json",
            title="Job status",
        ),
    ]

    if ogc_status == StatusCode.successful:
        links.append(
            Link(
                href=f"{base_url}/jobs/{job_id}/results",
                rel="http://www.opengis.net/def/rel/ogc/1.0/results",
                type="application/json",
                title="Job results",
            )
        )

    # Extract error message for failed jobs
    # Windmill returns: {"error": {"name": "ErrorName", "message": "Error message", "stack": "..."}}
    # Workflow runner returns: {"status": "partial", "errors": [{"node_id": "...", "error": {...}}]}
    message = None
    if ogc_status == StatusCode.failed:
        result = job.get("result")
        if isinstance(result, dict):
            # Check for workflow errors first
            workflow_errors = result.get("errors", [])
            if (
                workflow_errors
                and isinstance(workflow_errors, list)
                and len(workflow_errors) > 0
            ):
                first_error = workflow_errors[0]
                error_info = first_error.get("error", {})
                if isinstance(error_info, dict):
                    error_name = error_info.get("name", "Error")
                    error_message = error_info.get("message", "")
                    node_id = first_error.get("node_id", "unknown")
                    message = (
                        f"Node {node_id}: {error_name}: {error_message}"
                        if error_message
                        else f"Node {node_id}: {error_name}"
                    )
                else:
                    message = f"Workflow error: {error_info}"
            # Fallback to direct error format
            elif "error" in result:
                error_info = result["error"]
                if isinstance(error_info, dict):
                    error_name = error_info.get("name", "Error")
                    error_message = error_info.get("message", "")
                    message = (
                        f"{error_name}: {error_message}"
                        if error_message
                        else error_name
                    )
        # Fallback to generic message if no structured error (avoid exposing raw logs)
        if not message:
            message = "Unknown error"
        else:
            message = _sanitize_error_msg(message)

    return StatusInfo(
        processID=process_id if process_id else None,
        type="process",
        jobID=job_id,
        status=ogc_status,
        message=message,
        created=created,
        started=started,
        finished=finished,
        inputs=job.get("args"),
        hidden=hidden,
        links=links,
        workflow_as_code_status=job.get("flow_status", {}).get(
            "workflow_as_code_status"
        ),
        node_status=job.get("node_status"),
    )


@router.get(
    "/jobs",
    summary="List jobs",
    response_model=JobList,
)
async def list_jobs(
    request: Request,
    user_id: UUID = Depends(get_user_id),
    process_id: Annotated[str | None, Query(alias="processID")] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> JobList:
    """List all jobs for the authenticated user from the last 3 days.

    Jobs are queried directly from Windmill using efficient indexed filters.
    """
    base_url = get_base_url(request)

    try:
        # Map OGC status to Windmill filters
        success_filter: bool | None = None
        running_filter: bool | None = None
        if status_filter == "successful":
            success_filter = True
        elif status_filter == "failed":
            success_filter = False
        elif status_filter == "running":
            running_filter = True

        # Query Windmill directly with efficient filters
        windmill_jobs = await windmill_client.list_jobs_filtered(
            user_id=str(user_id),
            script_path_start="f/goat/",
            created_after_days=3,
            process_id=process_id,
            success=success_filter,
            running=running_filter,
            limit=limit,
        )

        # Convert Windmill jobs to OGC StatusInfo
        jobs = []
        for wm_job in windmill_jobs:
            status_info = _windmill_job_to_status_info(wm_job, base_url)
            # Include result for successful jobs
            if wm_job.get("success") is True and wm_job.get("result"):
                status_info.result = wm_job.get("result")
            jobs.append(status_info)

        return JobList(
            jobs=jobs,
            links=[
                Link(
                    href=f"{base_url}/jobs",
                    rel="self",
                    type="application/json",
                    title="Job list",
                ),
            ],
        )

    except WindmillError as e:
        logger.error(f"Error listing jobs: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/internal-error",
                "title": "Internal error",
                "status": 500,
                "detail": str(e),
            },
        )


def _verify_job_ownership(job: dict[str, Any], user_id: UUID) -> bool:
    """Verify that a job belongs to the specified user.

    Checks the user_id in the job's args against the authenticated user.

    Args:
        job: Windmill job dict
        user_id: Authenticated user's UUID

    Returns:
        True if job belongs to user, False otherwise
    """
    job_args = job.get("args", {})
    job_user_id = job_args.get("user_id")
    return job_user_id == str(user_id)


@router.get(
    "/jobs/{job_id}",
    summary="Get job status",
    response_model=StatusInfo,
    responses={
        404: {"model": OGCException, "description": "Job not found"},
    },
)
async def get_job_status(
    request: Request,
    job_id: str,
    user_id: UUID = Depends(get_user_id),
) -> StatusInfo:
    """Get status information for a specific job."""
    base_url = get_base_url(request)

    try:
        # Get job directly from Windmill
        windmill_job = await windmill_client.get_job_with_result(job_id)

        # Verify user owns this job (check user_id in args)
        if not _verify_job_ownership(windmill_job, user_id):
            raise HTTPException(
                status_code=404,
                detail={
                    "type": OGC_EXCEPTION_NO_SUCH_JOB,
                    "title": "Job not found",
                    "status": 404,
                    "detail": f"Job '{job_id}' not found",
                },
            )

        # Convert to StatusInfo
        status_info = _windmill_job_to_status_info(windmill_job, base_url)

        # Include result for successful jobs
        if windmill_job.get("success") is True and windmill_job.get("result"):
            status_info.result = windmill_job.get("result")

        return status_info

    except HTTPException:
        raise
    except WindmillJobNotFound:
        raise HTTPException(
            status_code=404,
            detail={
                "type": OGC_EXCEPTION_NO_SUCH_JOB,
                "title": "Job not found",
                "status": 404,
                "detail": f"Job '{job_id}' not found",
            },
        )
    except WindmillError as e:
        logger.error(f"Error getting job status: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/internal-error",
                "title": "Internal error",
                "status": 500,
                "detail": str(e),
            },
        )


@router.get(
    "/jobs/{job_id}/results",
    summary="Get job results",
    responses={
        200: {"description": "Job results"},
        404: {
            "model": OGCException,
            "description": "Job not found or results not ready",
        },
    },
)
async def get_job_results(
    request: Request,
    job_id: str,
    user_id: UUID = Depends(get_user_id),
) -> Any:
    """Get results of a completed job."""
    try:
        # Get job directly from Windmill
        job = await windmill_client.get_job_status(job_id)

        # Verify user owns this job
        if not _verify_job_ownership(job, user_id):
            raise HTTPException(
                status_code=404,
                detail={
                    "type": OGC_EXCEPTION_NO_SUCH_JOB,
                    "title": "Job not found",
                    "status": 404,
                    "detail": f"Job '{job_id}' not found",
                },
            )

        # Check job status
        ogc_status = _windmill_status_to_ogc(job)

        if ogc_status == StatusCode.running or ogc_status == StatusCode.accepted:
            raise HTTPException(
                status_code=404,
                detail={
                    "type": OGC_EXCEPTION_RESULT_NOT_READY,
                    "title": "Results not ready",
                    "status": 404,
                    "detail": f"Job '{job_id}' is still {ogc_status.value}",
                },
            )

        if ogc_status == StatusCode.failed:
            error_msg = job.get("result", {})
            raise HTTPException(
                status_code=500,
                detail={
                    "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-failed",
                    "title": "Job failed",
                    "status": 500,
                    "detail": str(error_msg),
                },
            )

        # Get results
        result = await windmill_client.get_job_result(job_id)

        # Return as document format
        return {"result": result}

    except HTTPException:
        raise
    except WindmillJobNotFound:
        raise HTTPException(
            status_code=404,
            detail={
                "type": OGC_EXCEPTION_NO_SUCH_JOB,
                "title": "Job not found",
                "status": 404,
                "detail": f"Job '{job_id}' not found",
            },
        )
    except WindmillError as e:
        logger.error(f"Error getting job results: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/internal-error",
                "title": "Internal error",
                "status": 500,
                "detail": str(e),
            },
        )


@router.delete(
    "/jobs/{job_id}",
    summary="Dismiss/cancel a job",
    response_model=StatusInfo,
    responses={
        200: {"description": "Job dismissed"},
        404: {"model": OGCException, "description": "Job not found"},
    },
)
async def dismiss_job(
    request: Request,
    job_id: str,
    user_id: UUID = Depends(get_user_id),
) -> StatusInfo:
    """Cancel a running job or remove a completed job."""
    base_url = get_base_url(request)

    try:
        # Get job directly from Windmill
        job = await windmill_client.get_job_status(job_id)

        # Verify user owns this job
        if not _verify_job_ownership(job, user_id):
            raise HTTPException(
                status_code=404,
                detail={
                    "type": OGC_EXCEPTION_NO_SUCH_JOB,
                    "title": "Job not found",
                    "status": 404,
                    "detail": f"Job '{job_id}' not found",
                },
            )

        # Cancel if still running
        ogc_status = _windmill_status_to_ogc(job)
        if ogc_status in (StatusCode.accepted, StatusCode.running):
            try:
                await windmill_client.cancel_job(job_id, "User requested dismissal")
            except WindmillError:
                pass  # Job might have just finished

        # Parse timestamps for response
        created = None
        if job.get("created_at"):
            try:
                created = datetime.fromisoformat(
                    job["created_at"].replace("Z", "+00:00")
                )
            except Exception:
                pass

        # Extract process ID from Windmill script path
        script_path = job.get("script_path", "")
        if script_path.startswith("f/goat/tools/"):
            process_id = script_path.replace("f/goat/tools/", "")
        else:
            process_id = script_path.replace("f/goat/", "")

        # Build response
        return StatusInfo(
            processID=process_id if process_id else None,
            type="process",
            jobID=job_id,
            status=StatusCode.dismissed,
            message="Job dismissed",
            created=created,
            links=[
                Link(
                    href=f"{base_url}/jobs/{job_id}",
                    rel="self",
                    type="application/json",
                    title="Job status",
                ),
            ],
        )

    except HTTPException:
        raise
    except WindmillJobNotFound:
        raise HTTPException(
            status_code=404,
            detail={
                "type": OGC_EXCEPTION_NO_SUCH_JOB,
                "title": "Job not found",
                "status": 404,
                "detail": f"Job '{job_id}' not found",
            },
        )
    except WindmillError as e:
        logger.error(f"Error dismissing job: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/internal-error",
                "title": "Internal error",
                "status": 500,
                "detail": str(e),
            },
        )


# Create the router instance for export
processes_router = router
