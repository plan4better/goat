"""Pre-submission credit gate. Fail-open: never block on a check failure."""

import logging

import httpx
from fastapi import HTTPException, status

from processes.config import settings

logger = logging.getLogger(__name__)


async def assert_credits_available(
    access_token: str | None, process_id: str | None = None
) -> None:
    """Raise 402 only when core clearly reports the org is over budget.

    Fail-open on timeout / network / unexpected response — charging is post-hoc
    anyway, so a failed gate must never block tool execution. Nothing to
    check with billing off (self-hosted).
    """
    if not settings.BILLING_ENABLED:
        return
    from goatlib.tasks.compute_rollup import FREE_TOOLS

    if process_id in FREE_TOOLS:  # deleting data is always allowed
        return
    headers = {"Authorization": f"Bearer {access_token}"} if access_token else {}
    url = f"{settings.CORE_URL}/api/v2/credits/balance"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as exc:  # noqa: BLE001 — fail-open by design
        logger.warning("credit gate: balance check failed, allowing (%s)", exc)
        return
    if resp.status_code != 200:
        # Allowed for availability, but loud: a 401/500 from core means the
        # gate is blind, and nobody notices unless it is in the logs.
        logger.warning(
            "credit gate: balance returned %s, allowing (process %s)",
            resp.status_code,
            process_id,
        )
        return
    try:
        over_budget = resp.json().get("over_budget") is True
    except Exception as exc:  # noqa: BLE001 — non-JSON / non-object answer
        logger.warning("credit gate: balance answer unreadable, allowing (%s)", exc)
        return
    if over_budget:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Organization is out of credits for this period.",
        )
