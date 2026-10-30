"""Read authorization dependencies for tile/feature/metadata endpoints.

Flagged behind ``Settings.ENFORCE_READ_AUTHZ`` (default False = shadow
mode): a denied read is only logged as ``read_authz.would_deny`` — the
counter to watch on dev before flipping the flag — never blocked, until
enforcement is turned on. A service-call error is handled the same way:
logged as ``read_authz.error`` and treated as allowed in shadow mode, but
treated as a denial (403) once enforcement is on — fail closed, never a 500.

``require_layer_read`` takes the route's ``collectionId`` path parameter
directly (not ``LayerInfoDep``) so that routes with a documented
no-DuckLake-lookup fast path — ``get_tile`` in particular — never pay for a
layer_info resolution just to run this check. It NEVER bypasses the check;
it is attached to all layer-serving routes except ``get_features``.

``require_layer_read_unless_temp`` is the one exception, attached ONLY to
``get_features``: it bypasses the check for that route's own ``?temp=true``
branch. Temp layers are per-user scratch parquet files —
``feature_service.get_temp_features`` only ever globs
``user_{user_id}/**/t_{layer_uuid}.parquet`` under the *requesting* user's
own temp directory, never a ``customer.layer``-backed table — so they carry
no grants and there is nothing to check. This bypass must not be attached
to any other route: none of the other six routes' handlers have a temp
branch, so a `?temp=true` there would (before this fix, did) skip the check
while still serving the real, `customer.layer`-backed data.

The one authorization rule lives in Postgres (``customer.can``), so every
check is a round trip. A short in-process TTL cache below bounds that cost:
one map pan (~50 tile requests) costs one ``customer.can`` query per
(layer, user) instead of fifty. The trade-off is that a revoked share can
still read for up to ``READ_AUTHZ_CACHE_TTL_SECONDS`` after being revoked.
"""

import logging
import time
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Path, Query, status

from geoapi.config import settings
from geoapi.dependencies import normalize_layer_id
from geoapi.deps.auth import get_optional_user_id
from geoapi.services.layer_service import layer_service

logger = logging.getLogger("geoapi.read_authz")

# Bounds the extra Postgres round trip per tile; a revoked share takes up to
# TTL to bite.
READ_AUTHZ_CACHE_TTL_SECONDS = 30
_READ_AUTHZ_CACHE_MAX_SIZE = 10_000

# (layer_id, user_id) -> (allowed, expires_at). Insertion order doubles as
# eviction order (dicts preserve it): the oldest entry is dropped when the
# cache is full, which is an approximation of LRU cheap enough not to need
# a real LRU structure for a cache this size.
_read_authz_cache: dict[tuple[str, UUID | None], tuple[bool, float]] = {}


def _now() -> float:
    """Wraps `time.monotonic` so tests can patch the clock directly."""
    return time.monotonic()


def _cache_get(key: tuple[str, UUID | None]) -> bool | None:
    """The cached verdict for `key`, or None if absent/expired."""
    entry = _read_authz_cache.get(key)
    if entry is None:
        return None
    allowed, expires_at = entry
    if _now() >= expires_at:
        _read_authz_cache.pop(key, None)
        return None
    return allowed


def _cache_set(key: tuple[str, UUID | None], allowed: bool) -> None:
    if (
        key not in _read_authz_cache
        and len(_read_authz_cache) >= _READ_AUTHZ_CACHE_MAX_SIZE
    ):
        oldest_key = next(iter(_read_authz_cache))
        _read_authz_cache.pop(oldest_key, None)
    _read_authz_cache[key] = (allowed, _now() + READ_AUTHZ_CACHE_TTL_SECONDS)


async def _check_and_enforce(collection_id: str, user_id: UUID | None) -> None:
    """Shared verdict: cache -> `customer.can` -> raise (enforced) or log (shadow).

    A service-call error (a missing `customer.can`, a Postgres hiccup) is
    never cached and never propagates as a 500 to the caller: in shadow mode
    it is treated as allowed, matching shadow mode's "never blocks" contract;
    when enforcement is on, it is treated as a denial — fail closed, since a
    read the rule engine could not evaluate must not be served.
    """
    layer_id = normalize_layer_id(collection_id)
    key = (layer_id, user_id)
    allowed = _cache_get(key)
    if allowed is None:
        try:
            allowed = await layer_service.user_can_read_layer(layer_id, user_id)
        except Exception as e:  # noqa: BLE001 - any backend failure, never a 500 here
            logger.error(
                "read_authz.error layer=%s user=%s err=%s", layer_id, user_id, e
            )
            if settings.ENFORCE_READ_AUTHZ:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not allowed to read this layer",
                ) from e
            return
        _cache_set(key, allowed)

    if allowed:
        return
    if settings.ENFORCE_READ_AUTHZ:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to read this layer",
        )
    logger.warning("read_authz.would_deny layer=%s user=%s", layer_id, user_id)


async def enforce_layer_read(layer_id: str, user_id: UUID | None) -> None:
    """The verdict of `require_layer_read` for a layer a route resolves itself
    (the Explorer authorizes a bundle through its stops layer)."""
    await _check_and_enforce(layer_id, user_id)


async def require_layer_read(
    collection_id: Annotated[str, Path(alias="collectionId")],
    user_id: UUID | None = Depends(get_optional_user_id),
) -> None:
    """Deny (or, in shadow mode, log) a read the one authorization rule refuses.

    Never bypassed — attach this to any route whose handler has no temp-layer
    branch of its own.
    """
    await _check_and_enforce(collection_id, user_id)


async def require_layer_read_unless_temp(
    collection_id: Annotated[str, Path(alias="collectionId")],
    # Mirrors get_features's own `temp` Query param so pydantic coerces the
    # same query string the same way; hidden from the schema so the route's
    # own `temp` declaration stays the single documented entry.
    temp: Annotated[bool, Query(include_in_schema=False)] = False,
    user_id: UUID | None = Depends(get_optional_user_id),
) -> None:
    """Like `require_layer_read`, bypassed for `get_features`'s `?temp=true` branch.

    Attach this ONLY to `get_features`. Every other route lacks a temp-layer
    branch, so bypassing there would let `?temp=true` serve real,
    `customer.layer`-backed data unchecked.
    """
    if temp:
        return
    await _check_and_enforce(collection_id, user_id)
