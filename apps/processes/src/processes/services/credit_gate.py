"""Pre-submission credit gate. Fail-open: never block on a check failure.

Reads core's database directly, on the connection the access check already
uses, through `customer.credits_exhausted` (core's one rule for "out of
credits"). processes does not call the core service.
"""

import logging
from uuid import UUID

from fastapi import HTTPException, status

from processes.config import settings

logger = logging.getLogger(__name__)

# A slow database fails open after this, not after the pool's command_timeout.
CHECK_TIMEOUT_SECONDS = 3.0


async def assert_credits_available(
    user_id: UUID | str | None, process_id: str | None = None
) -> None:
    """Raise 402 only when the user's organization has clearly used up its
    credits.

    Fail-open on any database error: charging is post-hoc anyway, so a failed
    gate must never block tool execution. Nothing to check with billing off
    (self-hosted).
    """
    if not settings.BILLING_ENABLED or user_id is None:
        return
    from goatlib.tasks.compute_rollup import FREE_TOOLS

    if process_id in FREE_TOOLS:  # deleting data is always allowed
        return
    from processes.services.access import get_pool

    schema = settings.CUSTOMER_SCHEMA
    try:
        pool = await get_pool()
        exhausted = await pool.fetchval(
            f"SELECT {schema}.credits_exhausted(u.organization_id) "
            f'FROM {schema}."user" u WHERE u.id = $1::uuid',
            str(user_id),
            timeout=CHECK_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 — fail-open by design
        logger.warning("credit gate: balance check failed, allowing (%s)", exc)
        return
    if exhausted:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Organization is out of credits for this period.",
        )
