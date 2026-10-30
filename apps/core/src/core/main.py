import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from goatlib.api import mount_api_docs
from goatobs import setup_observability
from sqlalchemy.exc import IntegrityError
from starlette.middleware.cors import CORSMiddleware

import core._dotenv  # noqa: E402, F401, I001
from core.accounts.sync import retry_loop
from core.core.config import settings
from core.crud.crud_billing_terms import seed_default_credit_rates
from core.db.session import session_manager
from core.endpoints.v2.api import router as api_router_v2
from core.health import build_prober
from core.support.body_limit import SupportBodyLimit
from core.support.deps import close_support_provider


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    print("Starting up...")
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)

    # The metering SQL reads its rates from customer.credit_rate: until the
    # billing system pushes its terms, it charges at the default rates. Written
    # here, where core runs with its whole configuration (the migrate job may not).
    if settings.billing_enabled:
        async with session_manager.session() as session:
            await seed_default_credit_rates(session)

    # Object-storage probing. Reports goat_dependency_up through the OTLP path
    # goatobs already set up; nothing here is wired to a readiness probe, so a
    # failing dependency never pulls pods out of the load balancer.
    prober = build_prober()
    probing = None
    if prober is not None:
        prober.register_gauge()
        probing = asyncio.create_task(prober.run_forever())

    # Account reports that failed are re-sent from here; every replica runs it,
    # which is harmless (the operations are idempotent).
    syncing = (
        asyncio.create_task(retry_loop()) if settings.accounts_sync_enabled else None
    )

    yield

    print("Shutting down...")
    if syncing is not None:
        syncing.cancel()
        await asyncio.gather(syncing, return_exceptions=True)
    if probing is not None:
        probing.cancel()
        await asyncio.gather(probing, return_exceptions=True)
    await close_support_provider()
    await session_manager.close()


app = FastAPI(
    title=settings.PROJECT_NAME,
    # Both docs pages are served by goatlib.api.mount_api_docs below (see the
    # call for why); FastAPI's built-ins cannot carry a favicon.
    docs_url=None,
    redoc_url=None,
    openapi_url=f"{settings.API_V2_STR}/openapi.json",
    lifespan=lifespan,
)

# Docs pages + shared GOAT favicon, one implementation for all services.
mount_api_docs(
    app,
    openapi_url=f"{settings.API_V2_STR}/openapi.json",
    swagger_ui_parameters={"persistAuthorization": True},
)

# Attach OTel auto-instrumentation directly to this app. Module-top
# placement (not inside lifespan) so middleware is installed before the
# first request arrives. Env-var-gated — no-op when OTEL_ENABLED is
# unset/false, so other GOAT operators see no behavior change.
setup_observability(service_name="core", fastapi_app=app)


@app.exception_handler(ValueError)
async def value_error_exception_handler(
    request: Request, exc: ValueError
) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": str(exc)},
    )


# Added before CORS so that CORS wraps it and a 413 still carries the headers.
app.add_middleware(
    SupportBodyLimit,
    max_bytes=55 * 1024 * 1024,
    prefix=f"{settings.API_V2_STR}/support",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from goatlib.auth import JOSEError  # noqa: E402
from goatobs import build_auth_context_middleware  # noqa: E402

from core.deps.auth import decode_token  # noqa: E402

app.middleware("http")(
    build_auth_context_middleware(decode_token, decode_errors=(JOSEError,))
)


@app.get("/api/healthz", description="Health Check", tags=["Health Check"])
def ping() -> dict[str, str]:
    """Health check."""
    return {"ping": "pong!"}


app.include_router(api_router_v2, prefix=settings.API_V2_STR)


@app.exception_handler(IntegrityError)
async def item_already_exists_handler(
    request: Request, exc: IntegrityError
) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "message": "object with a unique field already exists.",
            "detail": str(exc.__dict__.get("orig")),
        },
    )
