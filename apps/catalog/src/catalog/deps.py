"""Shared FastAPI dependency accessors for the catalog service.

Kept in its own module (rather than ``catalog.app``, where it originated in
Task 3) so both ``catalog.app`` and ``catalog.routers.stac`` can depend on it
without an import cycle.
"""

import hashlib

from fastapi import Depends, Request

from catalog.errors import ApiError, NotModifiedError
from catalog.routers.params import reader_languages
from catalog.services.assets import AssetReader
from catalog.services.preview import PreviewReader
from catalog.services.search import boost_languages
from catalog.store import CatalogStore

#: The routes whose order follows the reader's languages, which they read
#: from ``Accept-Language`` when no ``language_boost`` is given.
RANKED_PATHS = frozenset({"/stac/search", "/stac/collections"})


def is_ranked(request: Request) -> bool:
    """Whether the request asks a route of ``RANKED_PATHS``. Read below the
    root path, so the outermost middleware (before ``RootPathMiddleware``
    restores a stripped prefix) and a dependency (after) agree."""
    path = request.url.path
    root = request.scope.get("root_path", "")
    if root and path.startswith(root + "/"):
        path = path[len(root) :]
    return path in RANKED_PATHS


def etag_for(request: Request, seed: str) -> str:
    """The ETag of this request's answer: the catalog's ``seed``, and on a
    ranked route the languages its order uses, resolved as the handler does
    (so ``language_boost=de`` and a header resolving to ``de`` share a tag,
    and one language's tag never revalidates another language's order)."""
    if is_ranked(request):
        languages = boost_languages(
            reader_languages(
                request.query_params.getlist("language_boost"),
                request.headers.get("accept-language", ""),
            )
        )
        if languages:
            key = f"{seed}:{','.join(languages)}"
            seed = hashlib.sha256(key.encode()).hexdigest()[:32]
    return f'W/"{seed}"'


def get_store(request: Request) -> CatalogStore:
    """FastAPI dependency: the current ``CatalogStore``.

    Calls ``ensure_current()`` so every request sees a fresh reload if the
    VERSION marker changed since the last request (cheap no-op otherwise).

    Stashes the ETag seed observed right after that reload onto
    ``request.state.catalog_etag_seed`` -- this is the state every handler
    actually built its response body against (FastAPI caches a dependency's
    result per request, so this runs at most once no matter how many places
    depend on ``get_store``/``check_not_modified``). ``catalog.app``'s
    ETag-stamping middleware reads this back UNCHANGED (never calling
    ``ensure_current()`` itself) instead of re-checking the store's version
    after the handler returns -- a concurrent reload landing in that gap
    would otherwise stamp a newer version onto an older body (see I1).
    """
    store: CatalogStore = request.app.state.store
    store.ensure_current()
    # The ETag seed is the *content* digest, not the upstream VERSION marker:
    # the mirror is derived from that upstream file, so identical upstream
    # versions can serve different bytes (see CatalogStore._content_digest).
    request.state.catalog_etag_seed = store.etag_seed
    request.state.catalog_version = store.version
    return store


async def check_not_modified(
    request: Request, store: CatalogStore = Depends(get_store)
) -> None:
    """Conditional-GET short-circuit for ``/stac`` GETs.

    Raises ``NotModifiedError`` (-> a bare 304, see ``catalog.app``) when
    ``If-None-Match`` matches the store's current content digest (with the
    ranking's languages on a ranked route, see ``etag_for``). This MUST be
    listed after ``catalog.auth.optional_auth`` in the router's
    ``dependencies=`` list: FastAPI resolves a dependency list in order, so
    that ordering guarantees a request presenting a *bad* token gets its 401
    from the auth dependency rather than a 304 from here. (An *anonymous* 304
    is fine and expected -- these reads are public, design S1/S14 -- but
    answering "your cached copy is current" to a caller whose credentials are
    broken would hide the credential failure behind a cache hit.)
    """
    if request.method != "GET":
        return
    etag = etag_for(request, store.etag_seed)
    if request.headers.get("if-none-match") == etag:
        raise NotModifiedError(etag)


def get_asset_reader(request: Request) -> AssetReader:
    """FastAPI dependency: the asset reader, when one is configured.

    404 rather than 501 for the same reason previews do it: an endpoint this
    deployment does not offer is not there. Both need the catalog bucket.
    """
    reader: AssetReader | None = getattr(request.app.state, "asset_reader", None)
    if reader is None:
        raise ApiError(404, "assets are not enabled on this deployment")
    return reader


def get_preview_reader(request: Request) -> PreviewReader:
    """FastAPI dependency: the data-preview reader, when one is configured.

    A 404 rather than a 501 when it is not: previews are off unless the
    service has been given bucket credentials (see
    ``CatalogSettings.preview_enabled``), and from a client's point of view an
    endpoint that this deployment does not offer simply is not there.
    """
    reader: PreviewReader | None = getattr(request.app.state, "preview_reader", None)
    if reader is None:
        raise ApiError(404, "data previews are not enabled on this deployment")
    return reader
