"""compute_rollup: charge compute credits from Windmill's completed-job log.

Post-hoc, idempotent, leaf-jobs-only. See spec §4. The jobs come from
Windmill's API, not its database tables, so a Windmill upgrade that changes
its schema cannot break the charging."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from goatlib.tasks._db import core_dsn, customer_schema

if TYPE_CHECKING:
    import asyncpg
    import httpx

WORKFLOW_RUNNER_PATH = "f/goat/tools/workflow_runner"

# Housekeeping that frees space or cleans up: never charged, and the credit
# check in processes never refuses it (an organization out of credits must
# still be able to delete its data).
FREE_TOOLS = frozenset({"layer_delete", "layer_delete_multi", "bundle_artifact_delete"})

# Exports hand the browser a file straight from object storage, past geoapi's
# traffic metering: their size is charged as data transfer ("downloads") with
# the job, by the size field each export puts in its result.
EXPORT_SIZE_FIELDS = {
    "f/goat/tools/layer_export": "file_size_bytes",
    "f/goat/tools/project_export": "file_size",
}
# Windmill's job list: at most 100 per page; 100 pages are 10,000 tool jobs
# a day, far above what runs.
_PAGE_SIZE = 100
_MAX_PAGES = 100

logger = logging.getLogger(__name__)


class ComputeRollupParams(BaseModel):
    """Parameters for the compute rollup task."""

    lookback_minutes: int = Field(
        default=1440,
        ge=1,
        description="Window of jobs, by completion time, to consider. Wide on "
        "purpose: it overlaps many runs, and job_id dedup makes overlap safe, "
        "so jobs that ran long or fell into an outage are still charged.",
    )
    dry_run: bool = Field(default=False, description="Select but do not charge.")


@dataclass
class ChargeItem:
    job_id: str
    user_id: str
    action: str
    duration_seconds: float
    payload: dict
    export_bytes: int = 0


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
        if tool_from_path(j.get("runnable_path")) in FREE_TOOLS:
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
                export_bytes=_export_bytes(j),
            )
        )
    return items


def _export_bytes(job: dict) -> int:
    if job.get("runnable_path") not in EXPORT_SIZE_FIELDS:
        return 0
    try:
        return max(0, int(job.get("export_size") or 0))
    except (TypeError, ValueError):
        return 0


def _windmill_client() -> "httpx.AsyncClient":
    """Windmill's API, as the job's own user: Windmill sets BASE_INTERNAL_URL,
    WM_TOKEN and WM_WORKSPACE for every job it runs, so there is nothing to
    configure (the schedule runs as the admin that synced it, who sees every
    job of the workspace). Outside Windmill, set the three by hand."""
    import httpx

    url = os.environ.get("BASE_INTERNAL_URL")
    token = os.environ.get("WM_TOKEN")
    workspace = os.environ.get("WM_WORKSPACE")
    if not url or not token or not workspace:
        raise RuntimeError(
            "not running in Windmill (BASE_INTERNAL_URL, WM_TOKEN, WM_WORKSPACE)"
        )
    return httpx.AsyncClient(
        base_url=f"{url.rstrip('/')}/api/w/{workspace}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )


def _job_row(job: dict) -> dict:
    """One job of Windmill's list, in the shape select_chargeable reads. The
    list holds only finished, successful, non-scheduled tool jobs, and only
    workflow_runner starts child jobs (it is excluded by its path). The list
    carries no arguments: _add_details reads them (and the user) per job."""
    return {
        "job_id": job["id"],
        "user_id": None,
        "args": {},
        "runnable_path": job.get("script_path"),
        "trigger_kind": None,
        "parent_job": job.get("parent_job"),
        "status": "success" if job.get("success") else "failure",
        "duration_ms": job.get("duration_ms"),
        "export_size": None,
        "has_children": False,
    }


async def _fetch_completed_jobs(
    wm: "httpx.AsyncClient", lookback_minutes: int
) -> list[dict]:
    """Tool jobs that completed successfully within the window, by completion
    time, so a job that ran long is not missed."""
    after = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
    params = {
        "script_path_start": "f/goat/tools/",
        "success": "true",
        "is_not_schedule": "true",
        "completed_after": after.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "per_page": _PAGE_SIZE,
    }
    jobs: dict[str, dict] = {}
    for page in range(1, _MAX_PAGES + 1):
        resp = await wm.get("/jobs/list", params={**params, "page": page})
        resp.raise_for_status()
        batch = resp.json()
        # Newest first: a job finishing meanwhile shifts the pages, so one
        # can show up twice; keyed by id it is counted once.
        for job in batch:
            jobs[job["id"]] = _job_row(job)
        if len(batch) < _PAGE_SIZE:
            break
    else:
        logger.warning("compute_rollup: more than %d pages of jobs", _MAX_PAGES)
    return list(jobs.values())


def _needs_details(job: dict) -> bool:
    """Whether a job may be charged at all, before its details are read."""
    path = job["runnable_path"]
    return path != WORKFLOW_RUNNER_PATH and tool_from_path(path) not in FREE_TOOLS


async def _add_details(wm: "httpx.AsyncClient", jobs: list[dict]) -> list[dict]:
    """Read each job's arguments (every job runs as the same Windmill user, so
    who ran it is only in its user_id argument) and each export's file size
    from its result. A job whose details cannot be read is left for the next
    run rather than charged without them."""
    kept = []
    for job in jobs:
        if not _needs_details(job):
            continue
        job_id = job["job_id"]
        try:
            resp = await wm.get(f"/jobs_u/get_args/{job_id}")
            resp.raise_for_status()
            args = resp.json()
            field = EXPORT_SIZE_FIELDS.get(job["runnable_path"])
            if field:
                resp = await wm.get(f"/jobs_u/completed/get_result/{job_id}")
                resp.raise_for_status()
                result = resp.json()
                job["export_size"] = (
                    result.get(field) if isinstance(result, dict) else None
                )
        except Exception:  # noqa: BLE001 — retried next run
            logger.warning("compute_rollup: details of job %s not read", job_id)
            continue
        if isinstance(args, dict):
            job["args"] = args
            job["user_id"] = args.get("user_id")
        kept.append(job)
    return kept


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


def main(params: ComputeRollupParams = ComputeRollupParams()) -> dict:
    """Windmill entry point: charge completed leaf tool jobs."""
    # Synchronous: Windmill calls main() without awaiting it.
    return asyncio.run(_run(params))


async def _run(params: ComputeRollupParams) -> dict:
    from goatlib.tasks._db import SKIPPED, billing_enabled

    if not billing_enabled():
        return SKIPPED
    import asyncpg

    schema = customer_schema()
    wm = _windmill_client()
    core = await asyncpg.connect(dsn=core_dsn(), timeout=10)
    try:
        found = await _fetch_completed_jobs(wm, params.lookback_minutes)
        already = await _already_charged(core, schema, [j["job_id"] for j in found])
        # Only the jobs still to charge need their details.
        jobs = await _add_details(wm, [j for j in found if j["job_id"] not in already])
        items = select_chargeable(jobs, already)
        orgs = await _resolve_orgs(core, schema, list({it.user_id for it in items}))

        charged = 0
        failed = 0
        for item in items:
            org_id = orgs.get(item.user_id)
            if org_id is None:
                continue  # user has no org — skip
            if params.dry_run:
                charged += 1
                continue
            try:
                await _charge_item(core, schema, org_id, item)
            except asyncpg.UniqueViolationError:
                # An overlapping run charged this job first (unique index on
                # the job id): it is charged, not failed.
                logger.info("compute_rollup: job %s already charged", item.job_id)
                continue
            except Exception:
                # One bad job must not stop the rest; it is retried next run.
                failed += 1
                logger.exception("compute_rollup: charging job %s failed", item.job_id)
                continue
            charged += 1
        summary = {
            "considered": len(found),
            "charged": 0 if params.dry_run else charged,
            "skipped": len(found) - (0 if params.dry_run else charged) - failed,
            "failed": failed,
        }
        logger.info("compute_rollup: %s", summary)
        return summary
    finally:
        await wm.aclose()
        await core.close()


async def _charge_item(
    core: "asyncpg.Connection", schema: str, org_id: str, item: ChargeItem
) -> None:
    """Charge one job in its own transaction.

    The compute charge marks the job as charged, so its data transfer must be
    booked with it or not at all.
    """
    import json

    async with core.transaction():
        await core.execute(
            f"SELECT {schema}.charge_credits($1, $2, $3, 'compute', $4, $5::jsonb)",
            org_id,
            item.user_id,
            item.action,
            item.duration_seconds,
            json.dumps(item.payload),
        )
        if item.export_bytes:
            await core.execute(
                f"SELECT {schema}.charge_credits($1, $2, 'downloads', 'egress', $3, $4::jsonb)",
                org_id,
                item.user_id,
                item.export_bytes,
                json.dumps({**item.payload, "export": item.action}),
            )
