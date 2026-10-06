"""Trial expiry enforcement (GOAT-managed trials).

Trials never touch the billing system: signup starts one (see
core `create_organization`), conversion ends it (the Odoo entitlement push
clears `on_trial`), and THIS task is what makes the end date real — nothing
else in the platform expires a trial.

Daily run, over every organization with ``on_trial AND NOT suspended``:

* renewal date within the warning window  -> ``stage=expiring`` (email)
* renewal date in the past               -> ``stage=expired``  (suspend + email)

Both actions go through core's ``POST /api/v2/webhooks/trial`` so that email
templates, i18n and the suspension write stay in core (single writer).

The warning fires while remaining days are in ``(expiring_days - 1,
expiring_days]`` — exactly one daily run lands in that window, so no
sent-flag is needed for idempotency.

Required environment:
    POSTGRES_* (ToolSettings)  — read-only candidate query
    CORE_URL                   — GOAT core base URL
    ODOO_WEBHOOK_SECRET        — shared secret for core's webhook endpoints

Windmill path: f/goat/tasks/trial_expiry
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Self

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

__all__ = ["TrialExpiryParams", "TrialExpiryTask", "classify_trial", "main"]


class TrialExpiryParams(BaseModel):
    expiring_days: int = Field(
        default=3,
        description="Send the warning email this many days before expiry.",
    )
    dry_run: bool = Field(
        default=False,
        description="Classify and report only — no calls to core.",
    )


def classify_trial(
    renewal_date: datetime, now: datetime, expiring_days: int
) -> str | None:
    """Classify one trial: 'expired', 'expiring', or None (leave alone).

    Pure function. The expiring window is (expiring_days - 1, expiring_days]
    days of remaining time, so a daily schedule hits it exactly once.
    """
    remaining = renewal_date - now
    if remaining <= timedelta(0):
        return "expired"
    if timedelta(days=expiring_days - 1) < remaining <= timedelta(days=expiring_days):
        return "expiring"
    return None


class TrialExpiryTask:
    def __init__(self: Self) -> None:
        import os

        from goatlib.tools.base import ToolSettings

        self.settings = ToolSettings.from_env()
        self.core_url = (os.environ.get("CORE_URL") or "").rstrip("/")
        self.webhook_secret = os.environ.get("ODOO_WEBHOOK_SECRET") or ""

    async def _candidates(self: Self) -> list[dict[str, Any]]:
        import asyncpg

        conn = await asyncpg.connect(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
        )
        try:
            rows = await conn.fetch(
                """
                SELECT id, name, plan_renewal_date
                FROM customer.organization
                WHERE on_trial IS TRUE
                  AND suspended IS FALSE
                  AND plan_renewal_date IS NOT NULL
                """
            )
            return [dict(row) for row in rows]
        finally:
            await conn.close()

    def _notify(self: Self, organization_id: str, stage: str) -> None:
        if not self.core_url or not self.webhook_secret:
            raise RuntimeError(
                "CORE_URL and ODOO_WEBHOOK_SECRET are required to notify core"
            )
        response = httpx.post(
            f"{self.core_url}/api/v2/webhooks/trial",
            headers={"X-Webhook-Secret": self.webhook_secret},
            json={"organization_id": organization_id, "stage": stage},
            timeout=30.0,
        )
        response.raise_for_status()

    async def run(self: Self, params: TrialExpiryParams) -> dict[str, Any]:
        now = datetime.now()
        results = []
        for org in await self._candidates():
            stage = classify_trial(org["plan_renewal_date"], now, params.expiring_days)
            if stage is None:
                continue
            if not params.dry_run:
                self._notify(str(org["id"]), stage)
            results.append(
                {
                    "organization_id": str(org["id"]),
                    "name": org["name"],
                    "renewal_date": str(org["plan_renewal_date"]),
                    "stage": stage,
                }
            )
            logger.info("trial %s: %s (%s)", stage, org["name"], org["id"])
        return {
            "status": "ok",
            "dry_run": params.dry_run,
            "expired": sum(1 for r in results if r["stage"] == "expired"),
            "expiring": sum(1 for r in results if r["stage"] == "expiring"),
            "results": results,
        }


def main(params: TrialExpiryParams = TrialExpiryParams()) -> dict[str, Any]:
    task = TrialExpiryTask()
    return asyncio.run(task.run(params))
