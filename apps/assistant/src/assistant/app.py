import logging
import socket
import uuid
from collections.abc import AsyncIterator, Awaitable
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from goatlib.api import RootPathMiddleware, mount_api_docs
from goatobs import setup_observability
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.routing import Route

from assistant.bus import EventBus, make_bus
from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.dbcheck import missing_privileges
from assistant.mcp_server import MCP_PATH, build_mcp
from assistant.observability import AuthContextMiddleware
from assistant.repo import Repository
from assistant.routers.ai_settings import router as ai_settings_router
from assistant.routers.conversations import router as conversations_router
from assistant.routers.health import router as health_router
from assistant.runs.manager import RunManager
from assistant.services import AppServices
from assistant.tools.http import ServiceClients

logger = logging.getLogger(__name__)

__all__ = ["AppServices", "create_app"]


async def _log_missing_privileges(db: Database, settings: AssistantSettings) -> None:
    """Name the cause of later permission failures; never aborts the start."""
    try:
        async with db.pool.acquire() as conn:
            missing = await missing_privileges(
                conn,
                schema=settings.db_schema,
                customer_schema=settings.customer_schema,
            )
    except Exception:
        logger.exception("Checking the database privileges failed")
        return
    if missing:
        # Not fatal: the service still answers, and every request that needs a
        # missing privilege fails with its own error. The log names the cause.
        logger.error(
            "The database role %s lacks privileges the assistant needs: %s. "
            "See apps/assistant/sql/grants.sql.",
            settings.postgres_user,
            "; ".join(missing),
        )


async def _build_services(settings: AssistantSettings) -> AppServices:
    db = Database(settings)
    await db.connect()
    bus: EventBus | None = None
    runs: RunManager | None = None
    tools: ServiceClients | None = None
    try:
        await _log_missing_privileges(db, settings)
        tools = ServiceClients.from_settings(settings)
        repo = Repository(db)
        bus = make_bus(settings.redis_url)
        # Unique per process: leases name the replica that runs a task.
        owner = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
        runs = RunManager(repo, bus, settings, owner=owner, tool_services=tools)
        await runs.start()
        return AppServices(db=db, repo=repo, bus=bus, runs=runs, tools=tools)
    except BaseException:
        # A start that failed halfway must not leave the pool, the bus connection
        # or the manager's background tasks behind.
        if runs is not None:
            await _close_quietly(runs.stop())
        if bus is not None:
            await _close_quietly(bus.close())
        if tools is not None:
            await _close_quietly(tools.aclose())
        await _close_quietly(db.close())
        raise


async def _close_quietly(closing: Awaitable[None]) -> None:
    try:
        await closing
    except Exception:
        logger.exception("Cleanup after a failed start did not finish")


async def _close_services(services: AppServices) -> None:
    # Runs first: their final bookkeeping needs the bus and the database.
    try:
        await services.runs.stop()
    finally:
        try:
            # After the runs: their final steps may still be calling tools.
            if services.tools is not None:
                await services.tools.aclose()
        finally:
            try:
                await services.bus.close()
            finally:
                await services.db.close()


async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
    """FastAPI's default 422 echoes the submitted value in ``input``, which
    would send a key a client posted back in the response. Report the first
    problem's field and message only."""
    assert isinstance(exc, RequestValidationError)
    first = exc.errors()[0] if exc.errors() else {}
    # Drop the part of the request ("body", "query") and keep the path inside it.
    location = [str(part) for part in first.get("loc", ())[1:]]
    detail: dict[str, str] = {
        "code": "invalid_request",
        "message": str(first.get("msg", "The request is not valid.")),
    }
    if location:
        detail["field"] = ".".join(location)
    return JSONResponse(status_code=422, content={"detail": detail})


def create_app(
    settings: AssistantSettings | None = None, *, services: AppServices | None = None
) -> FastAPI:
    settings = settings or AssistantSettings()
    if (
        settings.auth
        and not settings.token_exchange_enabled
        and not settings.web_client_id
    ):
        # Names the variables only, never a value.
        logger.warning(
            "AUTH is on but ASSISTANT_WEB_CLIENT_ID (KEYCLOAK_CLIENT_ID) is empty: "
            "runs cannot refresh the user's token and fail once it expires."
        )

    #: Set below once the app exists; the lifespan reads it when the app starts.
    mcp_manager: StreamableHTTPSessionManager | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            if services is None:
                built = await _build_services(settings)
                stack.push_async_callback(_close_services, built)
                app.state.services = built
            else:
                app.state.services = services
            # Entered after the services, so it stops first: no MCP request is
            # in flight when the clients and the database close.
            if mcp_manager is not None:
                await stack.enter_async_context(mcp_manager.run())
            yield

    app = FastAPI(
        title="GOAT Assistant",
        version="0.1.0",
        openapi_url="/api/openapi.json",
        root_path=settings.root_path,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.add_exception_handler(RequestValidationError, _validation_error)
    if services is not None:
        # ASGITransport does not run the lifespan; injected services are usable at once.
        app.state.services = services
    mount_api_docs(app)
    app.add_middleware(RootPathMiddleware)
    setup_observability(service_name="assistant", fastapi_app=app)
    # The instrumentation wraps the whole middleware stack, so the server span
    # starts before this middleware runs and does not carry the user; the logs,
    # the access log and every span started below it (child spans, outbound
    # calls) do.
    app.add_middleware(AuthContextMiddleware, settings=settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    app.include_router(conversations_router)
    app.include_router(ai_settings_router)
    if settings.enable_mcp:
        # A route at exactly /mcp, not a mount: a mount answers POST /mcp with a
        # redirect to /mcp/. POST only: stateless with JSON responses, there is
        # no GET stream and no session to DELETE, so both answer 405.
        mcp_app, mcp_manager = build_mcp(settings, lambda: app.state.services)
        app.router.routes.append(
            Route(MCP_PATH, mcp_app, methods=["POST"], include_in_schema=False)
        )
    return app
