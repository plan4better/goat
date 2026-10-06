"""GOAT GeoAPI - OGC Features, Tiles, and Processes API.

A clean FastAPI implementation for serving vector tiles, features,
and analytical processes from DuckLake/DuckDB storage.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from goatlib.api import RootPathMiddleware, mount_api_docs
from goatlib.auth import JOSEError
from goatobs import build_auth_context_middleware, setup_observability
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from geoapi.catalog_events import start_subscriber, stop_subscriber
from geoapi.config import settings
from geoapi.deps.auth import decode_token
from geoapi.ducklake import ducklake_manager
from geoapi.ducklake_pool import ducklake_pool
from geoapi.ducklake_write import ducklake_write_manager
from geoapi.middleware.credit_metering import CreditMeteringMiddleware
from geoapi.models import HealthCheck
from geoapi.routers import (
    bundle_edits_router,
    download_router,
    expressions_router,
    features_router,
    features_write_router,
    metadata_router,
    tiles_router,
)
from geoapi.services.layer_service import layer_service

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class TimeoutMiddleware(BaseHTTPMiddleware):
    """Middleware to enforce request timeouts based on endpoint type."""

    async def dispatch(self, request: Request, call_next):
        """Process request with timeout based on path."""
        # Determine timeout based on endpoint
        path = request.url.path

        if "/tiles/" in path:
            timeout = settings.TILE_TIMEOUT
        elif "/download" in path:
            timeout = settings.DOWNLOAD_TIMEOUT
        elif "/items" in path or "/features" in path:
            timeout = settings.FEATURE_TIMEOUT
        else:
            timeout = settings.REQUEST_TIMEOUT

        try:
            response = await asyncio.wait_for(call_next(request), timeout=timeout)
            return response
        except asyncio.TimeoutError:
            logger.error(f"Request timeout ({timeout}s) exceeded for {path}")
            return JSONResponse(
                status_code=504,
                content={
                    "error": "Gateway Timeout",
                    "message": f"Request exceeded {timeout} second timeout",
                    "path": path,
                },
            )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager.

    Initializes DuckLake connection and layer service on startup,
    cleans up on shutdown.
    """
    logger.info("Starting GeoAPI...")

    # Initialize DuckLake connection pool for tiles (4 concurrent connections)
    ducklake_pool.init()

    # Initialize single DuckLake connection for schema lookups / downloads.
    ducklake_manager.init(settings)

    # The write-capable DuckLake connection is created lazily on first write
    # (see ducklake_write.LazyDuckLakeWriteManager) to avoid paying its catalog
    # memory floor on pods that only serve reads.

    # Initialize layer service (PostgreSQL pool for metadata)
    await layer_service.init()

    # Start the cross-pod catalog-change subscriber (best-effort Redis pub/sub)
    start_subscriber()

    logger.info("GeoAPI started successfully")

    yield

    # Cleanup
    logger.info("Shutting down GeoAPI...")
    await layer_service.close()
    stop_subscriber()
    ducklake_pool.close()
    ducklake_write_manager.close()
    ducklake_manager.close()
    logger.info("GeoAPI shutdown complete")


# Create FastAPI application
app = FastAPI(
    title=settings.APP_NAME,
    version="2.0.0",
    description="OGC Features and Tiles API for GOAT layers, powered by DuckDB/DuckLake",
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
setup_observability(service_name="geoapi", fastapi_app=app)

# Bind user_id/email/realm onto logs, spans, and uvicorn access logs
# for any request carrying a valid Bearer token.
app.middleware("http")(
    build_auth_context_middleware(decode_token, decode_errors=(JOSEError,))
)


# Add timeout middleware (first, so it wraps all other middleware)
app.add_middleware(TimeoutMiddleware)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Add compression middleware. Level 6 over the default 9: on multi-MB items
# responses level 9 costs ~2x the CPU for ~4% smaller output.
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)

# Egress metering for credits: counts response bytes per organization and
# layer in Redis; the traffic_rollup task charges them.
app.add_middleware(CreditMeteringMiddleware)

# Include routers
app.include_router(metadata_router)
app.include_router(features_router)
app.include_router(features_write_router)
app.include_router(bundle_edits_router)
app.include_router(tiles_router)
app.include_router(expressions_router)
app.include_router(download_router)


@app.get(
    "/healthz",
    summary="Health check",
    response_model=HealthCheck,
    tags=["Health"],
)
async def health_check() -> HealthCheck:
    """Health check endpoint."""
    return HealthCheck(status="ok", ping="pong")
