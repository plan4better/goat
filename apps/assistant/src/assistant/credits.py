"""AI credits: the organization's pool, checked before GOAT AI answers and
charged after (core owns the pool, the allowance and the price tiers).

Core's two SECURITY DEFINER functions do the work: ``ai_credits_left`` (NULL:
no limit, as with billing off) and ``charge_ai_answer`` (prices the answer by
its steps, books it once per run id). The assistant only reports the facts of
an answer and never holds a number of the rules itself. Answers of an own
connection are neither checked nor charged.
"""

import asyncio
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from assistant.db import Database
from assistant.events import RunErrorCode, RunEvent, RunStatus, ToolCalled
from assistant.llm.resolution import Resolution

logger = logging.getLogger(__name__)

#: A slow database lets the answer run after this, as processes' credit gate does.
CHECK_TIMEOUT_SECONDS = 3.0


class AiCreditsUsedUp(Exception):  # noqa: N818
    """The organization's AI credits are used up: GOAT AI does not answer.
    ``resets_on``: when the pool is refilled, a trial's end for a trial
    (``on_trial``); None when core has no date."""

    def __init__(self, resets_on: datetime | None, on_trial: bool) -> None:
        super().__init__("ai_credits_used_up")
        self.resets_on = resets_on
        self.on_trial = on_trial


@dataclass(frozen=True)
class Pool:
    #: The AI credits left; None without a limit (or an unknown organization).
    left: Decimal | None
    on_trial: bool
    resets_on: datetime | None


def answer_steps(events: Iterable[RunEvent]) -> int:
    """An answer's steps: its tool calls, refused and failed ones included."""
    return len({e.tool_call_id for e in events if isinstance(e, ToolCalled)})


def charged(status: RunStatus, code: RunErrorCode | None, steps: int) -> bool:
    """Whether a GOAT AI answer that ended so is charged, by its steps.

    Charged: an answer that succeeded; one that hit the run's limits
    (``run_limit``), which the question asked for; one that ran out of time
    (``run_timeout``) or was stopped by the user after its first step. Free:
    failures on our side (the provider, the assistant), interrupted answers (a
    shutdown, a lost lease), and timeouts and stops before a step, since an
    answer out of time without a step is a provider that hung."""
    if status == "succeeded":
        return True
    if status == "failed":
        return code == "run_limit" or (code == "run_timeout" and steps > 0)
    if status == "cancelled":
        return steps > 0
    return False


class FailureLog:
    """Logs a failure that repeats once: the first at WARNING, the next ones
    at DEBUG until the operation works again, so a lasting cause (a missing
    grant, a database outage) does not write a line per answer."""

    def __init__(self, what: str) -> None:
        self.what = what
        self.failing = False

    def failed(self, message: str, *args: object, exc_info: bool = False) -> None:
        if self.failing:
            logger.debug(message, *args)
            return
        self.failing = True
        logger.warning(message, *args, exc_info=exc_info)

    def worked(self) -> None:
        if self.failing:
            self.failing = False
            logger.info("%s works again", self.what)


class AiCredits:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._check_log = FailureLog("The AI credit check")
        self._charge_log = FailureLog("Charging AI credits")

    async def pool(self, organization_id: UUID) -> Pool:
        row = await self.db.pool.fetchrow(
            f"SELECT {self.db.customer('ai_credits_left')}(o.id) AS left_credits, "
            "o.on_trial, o.plan_renewal_date, o.credits_reset_at "
            f"FROM {self.db.customer('organization')} o WHERE o.id = $1",
            organization_id,
        )
        if row is None:
            return Pool(None, False, None)
        on_trial = bool(row["on_trial"])
        # A trial's credits last the trial; a subscription's are reset monthly.
        resets_on = row["plan_renewal_date"] if on_trial else row["credits_reset_at"]
        return Pool(row["left_credits"], on_trial, resets_on)

    async def check(self, resolution: Resolution) -> Resolution:
        """The resolution an answer may use. GOAT AI without credits left
        raises ``AiCreditsUsedUp``; an own connection keeps answering and loses
        its GOAT AI fallback. A check that fails or takes too long lets the
        answer run as resolved: charging comes after the answer anyway."""
        goat_ai = not resolution.main.own
        if not goat_ai and resolution.fallback is None:
            return resolution
        try:
            async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
                pool = await self.pool(resolution.organization_id)
        except Exception as exc:
            self._check_log.failed(
                "The AI credit check failed; answering without it: %s: %s",
                type(exc).__name__,
                exc,
            )
            return resolution
        self._check_log.worked()
        if pool.left is None or pool.left > 0:
            return resolution
        if goat_ai:
            raise AiCreditsUsedUp(pool.resets_on, pool.on_trial)
        return replace(resolution, fallback=None)

    async def charge(
        self,
        organization_id: UUID,
        user_id: UUID,
        run_id: UUID,
        steps: int,
        payload: Mapping[str, Any],
    ) -> float:
        """Book one answer; the AI credits it cost, 0 when the run was booked
        already."""
        credits = await self.db.pool.fetchval(
            f"SELECT {self.db.customer('charge_ai_answer')}($1, $2, $3, $4, $5)",
            organization_id,
            user_id,
            run_id,
            steps,
            dict(payload),
        )
        return float(credits)

    async def book(
        self,
        organization_id: UUID,
        user_id: UUID,
        run_id: UUID,
        steps: int,
        payload: Mapping[str, Any],
    ) -> float | None:
        """``charge``, never raising: the AI credits charged, or None when the
        charge failed. The answer stands either way; failures are logged
        once (``FailureLog``), the first with its traceback."""
        try:
            ai_credits = await self.charge(
                organization_id, user_id, run_id, steps, payload
            )
        except Exception:
            self._charge_log.failed(
                "Run %s: charging its AI credits failed", run_id, exc_info=True
            )
            return None
        self._charge_log.worked()
        return ai_credits
