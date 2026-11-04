import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from goatlib.api import RootPathMiddleware, mount_api_docs
from goatobs import setup_observability
from starlette.middleware.gzip import GZipMiddleware

from catalog.config import CatalogSettings
from catalog.deps import get_store
from catalog.errors import ApiError, NotModifiedError
from catalog.routers.assets import router as assets_router
from catalog.routers.nuts import router as nuts_router
from catalog.routers.stac import router as stac_router
from catalog.services.assets import AssetReader
from catalog.services.preview import PreviewReader
from catalog.store import CatalogStore

# Re-exported for backwards compatibility (Task 3 originally defined this
# here; it now lives in ``catalog.deps`` so ``catalog.routers.stac`` can
# depend on it without importing ``catalog.app``).
__all__ = ["create_app", "get_store"]

logger = logging.getLogger(__name__)


def create_app(settings: CatalogSettings | None = None) -> FastAPI:
    settings = settings or CatalogSettings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.store = CatalogStore(settings)
        # Its own connection, holding the bucket credentials: the store's is
        # swapped on every mirror reload and only ever reads local files.
        app.state.preview_reader = (
            PreviewReader(settings) if settings.preview_enabled else None
        )
        app.state.asset_reader = (
            AssetReader(settings) if settings.assets_enabled else None
        )
        yield

    app = FastAPI(
        title="GOAT Catalog",
        version="1.0.0",
        description="STAC API for the GOAT data catalog",
        openapi_url="/api/openapi.json",
        root_path=settings.root_path,
        # The docs pages are served by the routes below instead of FastAPI's
        # built-ins, so they can carry the shared GOAT API favicon (as core
        # does). Disabling them here avoids two handlers on one path.
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings

    # Docs pages + shared GOAT favicon, one implementation for all services.
    mount_api_docs(app)
    # Stripped-prefix requests look like unstripped ones (see ROOT_PATH).
    app.add_middleware(RootPathMiddleware)

    # OTel auto-instrumentation + structlog, mirroring geoapi's
    # main.py (I2): a complete no-op unless OTEL_ENABLED=true, so this is
    # always safe to call, including in every test's create_app().
    setup_observability(service_name="catalog", fastapi_app=app)

    # Same CORS/compression stack as geoapi/processes (I2): the catalog API
    # is browser-facing (the public catalog UI queries /stac directly), so
    # it needs the same origin + gzip handling those services already have.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.status_code, "description": exc.detail},
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Malformed request parameters as 400, in the same envelope as every
        other error.

        FastAPI's default is 422 with its own ``{"detail": [...]}`` body, but
        OGC API - Features (which STAC API Core adopts) specifies 400 for an
        invalid parameter value, and stac-api-validator checks for it. Without
        this, a client sees two unrelated error shapes from one API depending
        on which layer rejected the request.

        ``exc.errors()`` is flattened into one line rather than dropped, so the
        response still says *which* parameter was wrong.
        """
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg', '')}"
            for err in exc.errors()
        )
        return JSONResponse(
            status_code=400,
            content={"code": 400, "description": f"invalid request: {problems}"},
        )

    @app.exception_handler(NotModifiedError)
    async def not_modified_handler(request: Request, exc: NotModifiedError) -> Response:
        """Bare 304 for a matching conditional GET (see
        ``catalog.deps.check_not_modified``).

        Anonymous requests reach this legitimately -- the ``/stac`` reads are
        public (design S1/S14). The dependency order (``optional_auth`` first)
        still matters, though: a request presenting an *invalid* token must
        get its 401 from ``optional_auth`` rather than a 304 from here, which
        would tell a client with broken credentials that its cache is current.
        """
        return Response(
            status_code=304,
            headers={"ETag": exc.etag, "Cache-Control": "public, max-age=60"},
        )

    @app.middleware("http")
    async def stac_etag_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        """Stamp ``ETag``/``Cache-Control`` on every successful GET under
        ``/stac``.

        The whole catalog has a single state, so one seed serves every
        response. That seed is a digest of the files actually loaded, NOT the
        upstream VERSION marker: the mirror is derived from the published file
        (``goatlib.tasks.catalog_mirror``), so the same upstream version can
        produce different served bytes whenever the converter changes -- and a
        tag that does not move then tells a client with a stale body that its
        cache is still current, forever. Only 2xx
        responses are stamped -- an error response (400/401/404/...) isn't
        cacheable and shouldn't imply "this body is what If-None-Match
        should compare against". The conditional-GET 304 short-circuit
        itself lives in ``catalog.deps.check_not_modified`` (a dependency
        that runs after the auth dependency), not here, so this middleware
        never needs to
        inspect ``If-None-Match`` at all.

        Stamps whatever seed ``catalog.deps.get_store`` observed for
        THIS request (``request.state.catalog_etag_seed``, set before the
        handler ran) -- it deliberately does NOT call ``store.ensure_current()``
        itself here, after the handler has already returned: a reload landing
        in the gap between the handler building its body and this middleware
        running would otherwise stamp a newer ETag onto an older body (I1),
        which breaks conditional GET (a client trusting that ETag would get a
        304 back later for a body it never actually received). The
        ``getattr(..., None)`` fallback to the store's current version only
        covers a response that somehow reached here without ever resolving
        ``get_store`` (there is no such route today, since every ``/stac``
        handler depends on it via ``check_not_modified``).
        """
        path = request.url.path
        is_stac_get = request.method == "GET" and (
            path == "/stac" or path.startswith("/stac/")
        )
        response = await call_next(request)
        if is_stac_get and 200 <= response.status_code < 300:
            store: CatalogStore = request.app.state.store
            seed = getattr(request.state, "catalog_etag_seed", None)
            if seed is None:
                seed = store.etag_seed
            response.headers["ETag"] = f'W/"{seed}"'
            # A handler that already stated its own freshness keeps it: most
            # responses are metadata a sync can change, but a data preview is
            # fixed for the life of a mirror generation and can be cached far
            # longer. The ETag is stamped either way, so a stale client
            # revalidates into a 304 rather than a re-render.
            response.headers.setdefault("Cache-Control", "public, max-age=60")
        return response

    @app.get("/healthz")
    async def healthz(request: Request) -> dict[str, object]:
        store = get_store(request)
        items = store.query(f"SELECT count(*) FROM {store.ITEMS}")[0][0]
        collections = store.query(f"SELECT count(*) FROM {store.COLLECTIONS}")[0][0]
        return {
            "status": "ok",
            "catalog": store.version or "absent",
            "items": items,
            "collections": collections,
        }

    app.include_router(stac_router)
    app.include_router(nuts_router)
    app.include_router(assets_router)

    return app
