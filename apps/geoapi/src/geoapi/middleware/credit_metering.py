"""Per-response egress metering: org × layer × service, with bytes /
request count / anonymous count, attributed to the layer owner.

Hot path: one cached org/owner lookup + a few Redis HINCRBYs. Fail-open
everywhere — metering must never break a response. See spec §5/§7/§12.
"""

import asyncio
import logging
import re
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

if TYPE_CHECKING:
    import redis

logger = logging.getLogger(__name__)

_COLLECTION_RE = re.compile(r"/collections/([^/]+)")


def _collection_id_from_path(path: str) -> str | None:
    m = _COLLECTION_RE.search(path or "")
    return m.group(1) if m else None


def _service_from_path(path: str) -> str:
    if "/tiles/" in path:
        return "tiles"
    if path.endswith("/download"):
        return "downloads"
    return "features"


def _redis() -> "redis.Redis | None":
    from geoapi.tile_cache import get_redis_client

    return get_redis_client()


async def _resolve_layer_org(collection_id: str) -> tuple[str | None, str | None]:
    """Return (organization_id, owner_user_id) for a collection, or (None, None)."""
    try:
        from uuid import UUID

        from geoapi.services.layer_service import layer_service

        meta = await layer_service.get_metadata_by_id(UUID(collection_id))
        if not meta:
            return (None, None)
        return (getattr(meta, "organization_id", None), getattr(meta, "user_id", None))
    except Exception as exc:  # noqa: BLE001 — fail-open
        logger.debug("metering: resolve failed for %s (%s)", collection_id, exc)
        return (None, None)


def _record_sync(
    client: "redis.Redis",
    org: str,
    owner: str | None,
    layer: str,
    service: str,
    size: int,
    anonymous: bool,
) -> None:
    key = f"meter:egress:{org}:{layer}:{service}"
    pipe = client.pipeline()
    pipe.hincrby(key, "bytes", size)
    pipe.hincrby(key, "count", 1)
    if anonymous:
        pipe.hincrby(key, "anon_count", 1)
    if owner:
        pipe.hset(key, "owner", owner)
    pipe.execute()  # type: ignore[no-untyped-call]


async def _record(
    org: str,
    owner: str | None,
    layer: str,
    service: str,
    size: int,
    anonymous: bool,
) -> None:
    client = _redis()
    if not client:
        return
    try:
        await asyncio.to_thread(
            _record_sync, client, org, owner, layer, service, size, anonymous
        )
    except Exception as exc:  # noqa: BLE001 — fail-open
        logger.debug("metering: record failed (%s)", exc)


async def _is_over_budget(org_id: str) -> bool:
    client = _redis()
    if not client:
        return False
    try:
        val = await asyncio.to_thread(client.get, f"meter:over_budget:{org_id}")
    except Exception as exc:  # noqa: BLE001 — fail-open
        logger.debug("metering: over-budget read failed (%s)", exc)
        return False
    return val in (b"1", "1", 1)


class CreditMeteringMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        collection_id = _collection_id_from_path(request.url.path)
        org_id, owner_id = (
            await _resolve_layer_org(collection_id) if collection_id else (None, None)
        )

        if org_id and await _is_over_budget(org_id):
            return Response(
                status_code=402,
                content=b"Organization is out of credits for this period.",
            )

        response = await call_next(request)

        if org_id and collection_id:
            try:
                size = int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                size = 0
            if size > 0:
                service = _service_from_path(request.url.path)
                anonymous = "authorization" not in request.headers
                await _record(org_id, owner_id, collection_id, service, size, anonymous)
        return response
