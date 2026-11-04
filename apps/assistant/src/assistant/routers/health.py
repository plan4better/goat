"""Liveness (``/healthz``) and readiness (``/readyz``).

Liveness answers as long as the process serves requests, so the platform
restarts only a wedged process. Readiness also checks Postgres and the event
bus: while either is down the pod leaves the load balancer instead of
accepting runs it cannot record or stream.
"""

import asyncio
import logging
from collections.abc import Awaitable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter()

#: Per dependency; a probe that hangs counts as down.
READY_TIMEOUT_SECONDS = 2.0


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _check(name: str, probe: Awaitable[Any]) -> str:
    try:
        await asyncio.wait_for(probe, READY_TIMEOUT_SECONDS)
    except Exception:
        logger.warning("Readiness check %s failed", name, exc_info=True)
        return "unavailable"
    return "ok"


@router.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    services = getattr(request.app.state, "services", None)
    if services is None:
        return JSONResponse({"status": "starting", "checks": {}}, status_code=503)
    # Concurrent, each under its own timeout: the worst case is one timeout.
    database, redis = await asyncio.gather(
        _check("database", services.db.pool.fetchval("SELECT 1")),
        _check("redis", services.bus.ping()),
    )
    checks = {"database": database, "redis": redis}
    ready = all(value == "ok" for value in checks.values())
    return JSONResponse(
        {"status": "ok" if ready else "unavailable", "checks": checks},
        status_code=200 if ready else 503,
    )
