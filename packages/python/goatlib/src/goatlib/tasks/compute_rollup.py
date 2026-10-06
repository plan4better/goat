"""compute_rollup: charge compute credits from Windmill's completed-job log.

Post-hoc, idempotent, leaf-jobs-only. See spec §4."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from goatlib.tasks._db import core_dsn, customer_schema

if TYPE_CHECKING:
    import asyncpg

WORKFLOW_RUNNER_PATH = "f/goat/tools/workflow_runner"

logger = logging.getLogger(__name__)


class ComputeRollupParams(BaseModel):
    """Parameters for the compute rollup task."""

    lookback_minutes: int = Field(
        default=15,
        ge=1,
        description="Window of completed jobs to consider (overlaps the schedule; "
        "job_id dedup makes overlap safe).",
    )
    dry_run: bool = Field(default=False, description="Select but do not charge.")


@dataclass
class ChargeItem:
    job_id: str
    user_id: str
    action: str
    duration_seconds: float
    payload: dict


def tool_from_path(path: str | None) -> str:
    """`f/goat/tools/clip` -> `clip`; None -> `(unknown)`."""
    if not path:
        return "(unknown)"
    return path.rsplit("/", 1)[-1]


def select_chargeable(jobs: list[dict], already_charged: set[str]) -> list[ChargeItem]:
    """Pick the leaf tool jobs to charge, excluding all 'waiting' and non-billable jobs.

    Excludes: scheduled/maintenance jobs (trigger_kind set), failures, orchestrators
    (spawned children, or the workflow_runner path), already-charged job_ids, and jobs
    with no user. Duration is the job's execution time (queue wait already excluded by
    using duration_ms).
    """
    items: list[ChargeItem] = []
    for j in jobs:
        if j.get("trigger_kind") is not None:
            continue
        if j.get("status") != "success":
            continue
        if j.get("has_children"):
            continue
        if j.get("runnable_path") == WORKFLOW_RUNNER_PATH:
            continue
        job_id = j["job_id"]
        if job_id in already_charged:
            continue
        user_id = j.get("user_id")
        if not user_id:
            continue
        args = j.get("args") or {}
        payload = {
            "job_id": job_id,
            "path": j.get("runnable_path"),
            "status": j.get("status"),
            "workflow_id": args.get("workflow_id"),
            "workflow_run_id": j.get("parent_job"),  # per-execution id -> "runs" count
            "node_id": args.get("node_id"),
            "project_id": args.get("project_id"),  # compute-by-project
        }
        items.append(
            ChargeItem(
                job_id=job_id,
                user_id=str(user_id),
                action=tool_from_path(j.get("runnable_path")),
                duration_seconds=max(0.0, (j.get("duration_ms") or 0) / 1000.0),
                payload=payload,
            )
        )
    return items


def _windmill_dsn() -> str:
    dsn = os.environ.get("WINDMILL_DATABASE_URL")
    if not dsn:
        raise RuntimeError("WINDMILL_DATABASE_URL not set")
    return dsn.split("?", 1)[0]


async def _fetch_completed_jobs(
    wm_conn: "asyncpg.Connection", lookback_minutes: int
) -> list[dict]:
    rows = await wm_conn.fetch(
        """
        SELECT
            j.id::text                                   AS job_id,
            j.args->>'user_id'                           AS user_id,
            j.args                                       AS args,
            j.runnable_path                              AS runnable_path,
            j.trigger_kind                               AS trigger_kind,
            j.parent_job::text                           AS parent_job,
            c.status::text                               AS status,
            c.duration_ms                                AS duration_ms,
            EXISTS (SELECT 1 FROM v2_job ch WHERE ch.parent_job = j.id) AS has_children
        FROM v2_job_completed c
        JOIN v2_job j ON j.id = c.id
        WHERE c.started_at >= now() - ($1 || ' minutes')::interval
          AND j.runnable_path LIKE 'f/goat/tools/%'
        """,
        str(lookback_minutes),
    )
    out = []
    for r in rows:
        d = dict(r)
        # args arrives as a JSON string from asyncpg; normalize to dict
        import json

        if isinstance(d.get("args"), str):
            try:
                d["args"] = json.loads(d["args"])
            except (ValueError, TypeError):
                d["args"] = {}
        out.append(d)
    return out


async def _already_charged(
    core_conn: "asyncpg.Connection", schema: str, job_ids: list[str]
) -> set[str]:
    if not job_ids:
        return set()
    rows = await core_conn.fetch(
        f"""
        SELECT payload->>'job_id' AS job_id
        FROM {schema}.credit_usage
        WHERE category = 'compute' AND payload->>'job_id' = ANY($1::text[])
        """,
        job_ids,
    )
    return {r["job_id"] for r in rows}


async def _resolve_orgs(
    core_conn: "asyncpg.Connection", schema: str, user_ids: list[str]
) -> dict[str, str]:
    """Map user_id -> organization_id (charge_credits is org-centric)."""
    if not user_ids:
        return {}
    rows = await core_conn.fetch(
        f"""SELECT id::text AS uid, organization_id::text AS oid
            FROM {schema}."user" WHERE id = ANY($1::uuid[])""",
        user_ids,
    )
    return {r["uid"]: r["oid"] for r in rows if r["oid"]}


async def main(params: ComputeRollupParams = ComputeRollupParams()) -> dict:
    """Windmill entry point: charge completed leaf tool jobs."""
    import json

    import asyncpg

    schema = customer_schema()
    wm = await asyncpg.connect(dsn=_windmill_dsn(), timeout=10)
    core = await asyncpg.connect(dsn=core_dsn(), timeout=10)
    try:
        jobs = await _fetch_completed_jobs(wm, params.lookback_minutes)
        already = await _already_charged(core, schema, [j["job_id"] for j in jobs])
        items = select_chargeable(jobs, already)
        orgs = await _resolve_orgs(core, schema, list({it.user_id for it in items}))

        charged = 0
        for item in items:
            org_id = orgs.get(item.user_id)
            if org_id is None:
                continue  # user has no org — skip
            if not params.dry_run:
                await core.execute(
                    f"SELECT {schema}.charge_credits($1, $2, $3, 'compute', $4, $5::jsonb)",
                    org_id,
                    item.user_id,
                    item.action,
                    item.duration_seconds,
                    json.dumps(item.payload),
                )
            charged += 1
        summary = {
            "considered": len(jobs),
            "charged": 0 if params.dry_run else charged,
            "skipped": len(jobs) - (0 if params.dry_run else charged),
        }
        logger.info("compute_rollup: %s", summary)
        return summary
    finally:
        await wm.close()
        await core.close()
