"""GOAT Processes API - OGC API Processes for GOAT analysis tools.

A dedicated FastAPI service for OGC API Processes, handling:
- Async tool execution via Windmill (buffer, clip, heatmap, etc.)
- Sync analytics queries (feature-count, class-breaks, etc.)
- Job management (status, results, cancellation)

Separated from GeoAPI to prevent long-running jobs from blocking tile requests.
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from goatlib.api import RootPathMiddleware, mount_api_docs
from goatlib.auth import JOSEError
from goatobs import build_auth_context_middleware, setup_observability
from starlette.middleware.gzip import GZipMiddleware

from processes.config import settings
from processes.deps.auth import decode_token
from processes.ducklake import (
    close_mirror_db,
    ducklake_manager,
    preview_ducklake_manager,
    search_ducklake_manager,
)
from processes.models import HealthCheck
from processes.routers import processes_router, workflows_router
from processes.services.access import close_pool as close_access_pool
from processes.services.windmill_client import windmill_client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager.

    Initializes DuckLake connection for analytics queries on startup,
    cleans up on shutdown.
    """
    logger.info("Starting Processes API...")

    # Initialize DuckLake connections
    ducklake_manager.init(settings)
    preview_ducklake_manager.init(settings)
    search_ducklake_manager.init(settings)

    # Log resource limits for visibility
    logger.info(
        "DuckDB resource limits: memory=%s, threads=%s",
        settings.DUCKDB_MEMORY_LIMIT,
        settings.DUCKDB_THREADS,
    )
    logger.info("Analytics query timeout: %ss", settings.ANALYTICS_QUERY_TIMEOUT)

    logger.info("Processes API started successfully")

    yield

    # Cleanup
    logger.info("Shutting down Processes API...")
    await windmill_client.close()
    await close_access_pool()
    ducklake_manager.close()
    preview_ducklake_manager.close()
    search_ducklake_manager.close()
    close_mirror_db()
    logger.info("Processes API shutdown complete")


# Create FastAPI application
app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="OGC API Processes for GOAT geospatial analysis tools",
    openapi_url="/api/openapi.json",
    root_path=settings.ROOT_PATH,
    # Both docs pages are served by goatlib.api.mount_api_docs below;
    # FastAPI's built-ins cannot carry a favicon.
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

# Docs pages + shared GOAT favicon, one implementation for all services.
mount_api_docs(app)
# Stripped-prefix requests look like unstripped ones (see ROOT_PATH).
app.add_middleware(RootPathMiddleware)

# OTel auto-instrumentation + structlog. Module-top so middleware is
# installed before the first request arrives. Env-var-gated — no-op
# when OTEL_ENABLED is unset/false.
setup_observability(service_name="processes", fastapi_app=app)

# Bind user_id/email/realm onto logs, spans, and uvicorn access logs
# for any request carrying a valid Bearer token.
app.middleware("http")(
    build_auth_context_middleware(decode_token, decode_errors=(JOSEError,))
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Add compression middleware
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Include routers
app.include_router(processes_router)
app.include_router(workflows_router)


@app.get(
    "/healthz",
    summary="Health check",
    response_model=HealthCheck,
    tags=["Health"],
)
async def health_check() -> HealthCheck:
    """Health check endpoint."""
    return HealthCheck(status="ok", ping="pong")
