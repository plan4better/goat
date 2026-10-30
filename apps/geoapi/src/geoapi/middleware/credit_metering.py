"""Per-response egress metering: org × layer × service, with bytes /
request count / anonymous count, attributed to the layer owner.

Hot path: one cached org/owner lookup and an in-memory count. A background
task (run_flusher, started with the app) writes the counts to Redis every few
seconds, so no response waits for Redis. Downloads are not counted here: the
download route charges their export time and file size itself
(charge_download). Fail-open everywhere — metering must never break a
response. See spec §5/§7/§12.
"""

import asyncio
import logging
import re
from typing import TYPE_CHECKING
from uuid import UUID

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

if TYPE_CHECKING:
    import redis

logger = logging.getLogger(__name__)

_COLLECTION_RE = re.compile(r"/collections/([^/]+)")

# Counter hashes expire if the rollup does not drain them, so junk (and a
# stalled rollup) cannot make Redis grow without bound.
_COUNTER_TTL_SECONDS = 7 * 24 * 3600
# Only a delivered body is metered: not HEAD, not redirects, not errors.
_METERED_STATUS = (200, 206)
# How often the in-memory counts are written to Redis.
FLUSH_INTERVAL_SECONDS = 5.0

# Counts not yet in Redis: (org, layer, service) -> [bytes, count, anon_count,
# owner]. One entry per dimension, so it stays small however busy the server.
_pending: dict[tuple[str, str, str], list] = {}


def _collection_id_from_path(path: str) -> str | None:
    m = _COLLECTION_RE.search(path or "")
    return m.group(1) if m else None


def _normalized_layer_id(collection_id: str) -> str | None:
    """Canonical layer id, so case/dash/urn variants of one layer share one
    counter key; None when the path segment is not a layer id at all."""
    from goatlib.utils.layer import normalize_layer_id

    try:
        return normalize_layer_id(str(UUID(collection_id)))
    except ValueError:  # includes InvalidLayerIdError
        return None


def _service_from_path(path: str) -> str:
    if "/tiles/" in path:
        return "tiles"
    if path.endswith("/download"):
        return "downloads"
    return "features"


def _redis() -> "redis.Redis | None":
    from geoapi.tile_cache import get_redis_client

    # The tile cache's Redis, also when the tile cache itself is switched off.
    return get_redis_client(for_tile_cache=False)


async def _resolve_layer_org(collection_id: str) -> tuple[str | None, str | None]:
    """Return (organization_id, owner_user_id) for a collection, or (None, None)."""
    try:
        from geoapi.services.layer_service import layer_service

        meta = await layer_service.get_metadata_by_id(UUID(collection_id))
        if not meta:
            return (None, None)
        return (getattr(meta, "organization_id", None), getattr(meta, "user_id", None))
    except Exception as exc:  # noqa: BLE001 — fail-open
        logger.debug("metering: resolve failed for %s (%s)", collection_id, exc)
        return (None, None)


def _record(
    org: str,
    owner: str | None,
    layer: str,
    service: str,
    size: int,
    anonymous: bool,
) -> None:
    """Count one response in memory; run_flusher writes it to Redis."""
    entry = _pending.setdefault((org, layer, service), [0, 0, 0, None])
    entry[0] += size
    entry[1] += 1
    if anonymous:
        entry[2] += 1
    if owner:
        entry[3] = owner


def _write_sync(client: "redis.Redis", batch: dict) -> None:
    """Write one batch of counts to Redis in one pipeline."""
    pipe = client.pipeline()
    for (org, layer, service), (size, count, anon, owner) in batch.items():
        key = f"meter:egress:{org}:{layer}:{service}"
        pipe.hincrby(key, "bytes", size)
        pipe.hincrby(key, "count", count)
        if anon:
            pipe.hincrby(key, "anon_count", anon)
        if owner:
            pipe.hset(key, "owner", owner)
        pipe.expire(key, _COUNTER_TTL_SECONDS)
    pipe.execute()  # type: ignore[no-untyped-call]


def _merge_back(batch: dict) -> None:
    """Return an unwritten batch to _pending, with what arrived meanwhile."""
    for dims, (size, count, anon, owner) in batch.items():
        entry = _pending.setdefault(dims, [0, 0, 0, None])
        entry[0] += size
        entry[1] += count
        entry[2] += anon
        entry[3] = entry[3] or owner


async def flush() -> None:
    """Write the pending counts to Redis; kept for the next run if it is down.

    _pending is only touched on the event loop (here and in _record); the
    worker thread gets a batch of its own."""
    global _pending
    if not _pending:
        return
    client = _redis()
    if not client:
        return
    batch, _pending = _pending, {}
    try:
        await asyncio.to_thread(_write_sync, client, batch)
    except Exception as exc:  # noqa: BLE001 — fail-open
        _merge_back(batch)
        logger.debug("metering: flush failed (%s)", exc)


async def run_flusher(interval: float = FLUSH_INTERVAL_SECONDS) -> None:
    """Flush every `interval` seconds until cancelled, then once more."""
    try:
        while True:
            await asyncio.sleep(interval)
            await flush()
    finally:
        await flush()


async def charge_download(
    org: str, owner: str | None, layer: str, seconds: float, size: int
) -> None:
    """Charge a download to the layer owner's organization: the export's run
    time as compute and the file as egress, like a layer export job. Runs
    after the response; a failure is logged, the download is not affected."""
    import json

    from geoapi.services.layer_service import layer_service

    payload = json.dumps({"layer_id": layer, "export": "download"})
    try:
        async with layer_service._pool.acquire() as con, con.transaction():
            await con.execute(
                "SELECT customer.charge_credits("
                "$1::uuid, $2::uuid, 'downloads', 'compute', $3, $4::jsonb)",
                org,
                owner,
                seconds,
                payload,
            )
            await con.execute(
                "SELECT customer.charge_credits("
                "$1::uuid, $2::uuid, 'downloads', 'egress', $3, $4::jsonb)",
                org,
                owner,
                size,
                payload,
            )
    except Exception:  # noqa: BLE001 — fail-open
        logger.warning("metering: download of %s not charged", layer, exc_info=True)


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
        raw_id = _collection_id_from_path(request.url.path)
        layer_id = _normalized_layer_id(raw_id) if raw_id else None
        org_id, owner_id = (
            await _resolve_layer_org(layer_id) if layer_id else (None, None)
        )

        # Out of credits: downloads stop, viewing does not. Maps and dashboards
        # (tiles, features) keep working, so a published map never goes dark.
        if (
            org_id
            and _service_from_path(request.url.path) == "downloads"
            and await _is_over_budget(org_id)
        ):
            return Response(
                status_code=402,
                content=b"Organization is out of credits for this period.",
            )

        response = await call_next(request)

        service = _service_from_path(request.url.path)
        if (
            org_id
            and layer_id
            and service != "downloads"  # the download route charges itself
            and request.method == "GET"
            and response.status_code in _METERED_STATUS
        ):
            try:
                size = int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                size = 0
            if size > 0:
                anonymous = "authorization" not in request.headers
                _record(org_id, owner_id, layer_id, service, size, anonymous)
        return response
